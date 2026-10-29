import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { access, writeFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { join, relative } from 'node:path';
import AdmZip from 'adm-zip';
import { fileURLToPath } from 'node:url';
import { ExecutionStatus } from '@prisma/client';
import { ExecutionsService } from './executions.service';
import { failureReason, isPythonExceptionLine } from './failure-reason';
import { findStalledExecutions, getStallTimeoutMs, stallMessage } from './stall-watchdog';
import { NotificationsService } from '../notifications/notifications.service';
import { listFilesRecursively, sanitizeFileName, toUserFileName } from '../shared/files';
import { WINDOWS_HIDE } from '../shared/process-options';
import { readDeployPendingSync } from '../system/deploy-state';
import {
  ensureExecutionDirs,
  ensureStorageRoot,
  executionRoot,
  inputDir,
  metadataDir,
  outputDir,
  robotPipDir,
  robotsRoot,
  storageRoot,
} from '../shared/storage';

type RunningProcess = {
  child: ReturnType<typeof spawn>;
  metrics: Record<string, number>;
  // Última vez que o robô escreveu algo em stdout/stderr — base do watchdog
  // de travamento (em memória de propósito: não depende de relógio do banco).
  lastActivityAt: number;
  // Última linha de erro que o próprio robô declarou (AH_LOG|error|...) e última linha de exceção do Python na
  // saída de erro: viram o motivo mostrado se o robô terminar com código diferente de 0 (ver failure-reason.ts).
  lastRobotError?: string;
  lastPythonException?: string;
};

@Injectable()
export class ExecutionRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExecutionRunnerService.name);
  private readonly runningProcesses = new Map<string, RunningProcess>();
  private readonly stoppedExecutions = new Set<string>();
  // Execuções que o watchdog encerrou por falta de atividade → mensagem que
  // vira o motivo do erro (em vez do genérico "Comando finalizado com codigo").
  private readonly stalledExecutions = new Map<string, string>();
  private timer?: NodeJS.Timeout;
  private isProcessingQueue = false;

  constructor(
    private readonly executionsService: ExecutionsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async onModuleInit() {
    await ensureStorageRoot();
    await this.reconcileOrphanedExecutions();
    await this.processQueue();
    this.timer = setInterval(() => {
      void this.processQueue();
      void this.cancelStalledExecutions().catch((error) => {
        this.logger.error(`Watchdog de travamento falhou: ${String(error)}`);
      });
    }, 3000);
  }

  // Robôs (ex.: Excel via COM) às vezes travam sem sair nem escrever nada, e a
  // execução ficaria "running" pra sempre ocupando a vaga do robô. Se passar
  // EXECUTION_STALL_TIMEOUT_MINUTES (padrão 45, 0 = desligado) sem NENHUMA
  // saída, encerra a árvore de processos; o fluxo normal de erro do
  // runExecution marca a execução como erro com a mensagem do travamento.
  private async cancelStalledExecutions() {
    const timeoutMs = getStallTimeoutMs();
    const candidates = Array.from(this.runningProcesses.entries())
      .filter(([executionId]) => !this.stalledExecutions.has(executionId) && !this.stoppedExecutions.has(executionId))
      .map(([executionId, running]) => ({ executionId, lastActivityAt: running.lastActivityAt }));

    for (const { executionId, idleMinutes } of findStalledExecutions(candidates, Date.now(), timeoutMs)) {
      const running = this.runningProcesses.get(executionId);
      if (!running) continue;

      this.stalledExecutions.set(executionId, stallMessage(idleMinutes));
      this.logger.warn(`Execucao ${executionId} sem atividade ha ${idleMinutes} min — encerrando por travamento (pid=${running.child.pid}).`);
      await terminateProcessTree(running.child.pid);
      // Garante que o evento 'close' dispare mesmo com netos ainda vivos.
      running.child.stdout?.destroy();
      running.child.stderr?.destroy();
    }
  }

  // Ao reiniciar (deploy, crash), onModuleDestroy mata a árvore de processos
  // de qualquer execução em andamento, mas o Map de processos em memória
  // nasce vazio no boot seguinte — nada nunca mais atualiza essas linhas, que
  // ficam com status "running" pra sempre e bloqueiam a vaga de
  // maxConcurrency do robô indefinidamente. Aqui a gente resolve isso assim
  // que o servidor volta: recupera os arquivos de saída que já tiverem sido
  // gravados em disco (o robô pode ter salvado boa parte do trabalho antes de
  // ser encerrado) e marca a execução como erro, deixando claro o motivo.
  private async reconcileOrphanedExecutions() {
    const orphans = await this.executionsService.findRunningOrphans();
    for (const execution of orphans) {
      this.logger.warn(
        `Execucao orfa apos reinicio: ${execution.id} (${execution.robot.name}) estava "running" — recuperando arquivos e marcando como erro.`,
      );
      try {
        await this.zipOutputDirectory(execution.id);
        const registered = await this.registerOutputFiles(execution.id);
        this.logger.log(`registerOutputFiles (reconciliacao): ${registered.length} arquivo(s) registrado(s) para execucao ${execution.id}`);
      } catch (regError) {
        this.logger.error(`registerOutputFiles (reconciliacao) falhou para execucao ${execution.id}: ${String(regError)}`);
      }

      const message = 'Execução interrompida: o servidor do Hub foi reiniciado enquanto esta automação rodava. Se o robô salva progresso incrementalmente, os arquivos de saída já gerados foram recuperados — confira antes de reiniciar do zero.';
      await this.executionsService.markAsError(execution.id, message);
      await this.executionsService.log(execution.id, 'error', message);
      await this.maybeNotify(execution.id, execution.robot.name, 'error');
    }
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }

    for (const processRef of this.runningProcesses.values()) {
      void terminateProcessTree(processRef.child.pid);
    }
  }

  async stopExecution(executionId: string) {
    const running = this.runningProcesses.get(executionId);
    this.logger.log(`stopExecution: executionId=${executionId} running=${!!running} pid=${running?.child.pid}`);
    this.stoppedExecutions.add(executionId);
    // Auto-expira: execuções canceladas ainda na fila nunca passam pelo
    // finally de runExecution, e o set cresceria para sempre
    setTimeout(() => this.stoppedExecutions.delete(executionId), 10 * 60 * 1000).unref?.();
    if (running) {
      await terminateProcessTree(running.child.pid);
      // Force-close stdio streams so the Node.js 'close' event fires even if
      // child processes (e.g. Python spawned by the shell) are still running.
      running.child.stdout?.destroy();
      running.child.stderr?.destroy();
      this.runningProcesses.delete(executionId);
      this.logger.log(`stopExecution: processo terminado pid=${running.child.pid}`);
      await this.executionsService.log(executionId, 'warn', 'Processo interrompido pelo usuario.');
    } else {
      this.logger.warn(`stopExecution: execucao ${executionId} nao encontrada em runningProcesses`);
    }
  }

  private async processQueue() {
    if (this.isProcessingQueue) {
      return;
    }

    this.isProcessingQueue = true;

    try {
      const runningExecutions = await this.executionsService.listRunningExecutions();
      const queuedExecutions = await this.executionsService.listQueuedExecutions();
      if (queuedExecutions.length === 0) {
        return;
      }

      // Atualização do servidor esperando as execuções terminarem (ver system/deploy-state.ts):
      // não inicia nada novo, pra o servidor esvaziar e reiniciar. A fila segue intacta no banco.
      if (readDeployPendingSync()) {
        await this.updateQueuedReasons(
          queuedExecutions,
          'Atualização do servidor em andamento: esta execução começa assim que as que estão rodando terminarem e o servidor reiniciar.',
        );
        return;
      }

      const globalLimit = getGlobalConcurrencyLimit();
      const memoryUsage = getMemoryUsagePercentage();
      const memoryThreshold = getMemoryThresholdPercentage();
      const projectedExecutions = [...runningExecutions];
      const availableSlots = Math.max(0, globalLimit - runningExecutions.length);

      if (availableSlots <= 0) {
        await this.updateQueuedReasons(queuedExecutions, `Aguardando capacidade do servidor (${runningExecutions.length}/${globalLimit} em execucao).`);
        return;
      }

      if (memoryUsage >= memoryThreshold) {
        await this.updateQueuedReasons(
          queuedExecutions,
          `Fila pausada automaticamente: memoria do servidor em ${memoryUsage}% (limite ${memoryThreshold}%).`,
        );
        return;
      }

      const selectedExecutionIds: string[] = [];
      const blockedReasons = new Map<string, string>();

      for (const execution of queuedExecutions) {
        if (selectedExecutionIds.length >= availableSlots) {
          blockedReasons.set(
            execution.id,
            `Aguardando capacidade do servidor (${projectedExecutions.length}/${globalLimit} em execucao).`,
          );
          continue;
        }

        const blocker = this.getExecutionBlocker(execution, projectedExecutions, globalLimit);
        if (blocker) {
          blockedReasons.set(execution.id, blocker);
          continue;
        }

        selectedExecutionIds.push(execution.id);
        projectedExecutions.push({
          ...execution,
          status: ExecutionStatus.running,
        });
      }

      const blockedExecutions = queuedExecutions.filter((execution) => blockedReasons.has(execution.id));
      await this.updateQueuedReasons(
        blockedExecutions,
        undefined,
        blockedReasons,
      );

      for (const executionId of selectedExecutionIds) {
        void this.runExecution(executionId);
      }
    } catch (error) {
      this.logger.error('Failed to process queue', error);
    } finally {
      this.isProcessingQueue = false;
    }
  }

  private getExecutionBlocker(
    execution: Awaited<ReturnType<ExecutionsService['listQueuedExecutions']>>[number],
    projectedExecutions: Awaited<ReturnType<ExecutionsService['listRunningExecutions']>>,
    globalLimit: number,
  ) {
    if (projectedExecutions.length >= globalLimit) {
      return `Aguardando capacidade do servidor (${projectedExecutions.length}/${globalLimit} em execucao).`;
    }

    const robotRunningCount = projectedExecutions.filter(
      (item) => item.robotId === execution.robotId,
    ).length;
    const robotLimit = Math.max(1, execution.robot.maxConcurrency || 1);
    if (robotRunningCount >= robotLimit) {
      return `Aguardando vaga para o robo "${execution.robot.name}" (${robotRunningCount}/${robotLimit} em execucao).`;
    }

    const executionConflicts = parseConflictKeys(execution.robot.conflictKeys);
    if (executionConflicts.length > 0) {
      const conflictingExecution = projectedExecutions.find((item) =>
        hasConflict(executionConflicts, parseConflictKeys(item.robot.conflictKeys)),
      );
      if (conflictingExecution) {
        return `Aguardando liberacao de recurso compartilhado (${executionConflicts.join(', ')}) usado por "${conflictingExecution.robot.name}".`;
      }
    }

    return null;
  }

  private async updateQueuedReasons(
    queuedExecutions: Array<{ id: string }>,
    fallbackReason?: string,
    explicitReasons?: Map<string, string>,
  ) {
    await Promise.all(
      queuedExecutions.map(async (execution) => {
        const reason = explicitReasons?.get(execution.id) ?? fallbackReason;
        if (!reason) {
          return;
        }

        await this.executionsService.updateQueueReason(execution.id, reason);
      }),
    );
  }

  private async runExecution(executionId: string) {
    const execution = await this.executionsService.markAsRunning(executionId);
    if (!execution) {
      // Cancelada (ou já reivindicada) entre a listagem da fila e agora
      this.stoppedExecutions.delete(executionId);
      return;
    }

    await ensureExecutionDirs(execution.id);
    await this.writeExecutionMetadata(execution.id, execution.inputJson, execution.robot);
    await this.executionsService.log(execution.id, 'info', 'Execucao iniciada.');

    try {
      if (!execution.robot.command) {
        throw new Error(
          'Esta automacao nao possui comando configurado. Defina o comando e a pasta de execucao nas configuracoes.',
        );
      }

      await this.runCommandExecution(
        execution.id,
        execution.robot.command,
        execution.robot.workingDirectory,
        execution.robot.id,
      );
      if (this.stoppedExecutions.has(execution.id)) {
        try {
          const registered = await this.registerOutputFiles(execution.id);
          this.logger.log(`registerOutputFiles (canceled/linux): ${registered.length} arquivo(s) registrado(s) para execucao ${execution.id}`);
        } catch (regError) {
          this.logger.error(`registerOutputFiles falhou para execucao ${execution.id}: ${String(regError)}`);
        }
        return;
      }

      const unitsMetricKey =
        normalizeMetricKey(execution.robot.unitMetricKey) ?? 'itens_processados';
      const unitsProcessedRaw =
        this.runningProcesses.get(execution.id)?.metrics[unitsMetricKey];
      const unitsProcessed =
        typeof unitsProcessedRaw === 'number' && Number.isFinite(unitsProcessedRaw)
          ? Math.max(0, Math.round(unitsProcessedRaw))
          : null;

      await this.zipOutputDirectory(execution.id);
      const outputFiles = await this.registerOutputFiles(execution.id);

      await this.executionsService.markAsSuccess(
        execution.id,
        outputFiles.length > 0 ? 'Arquivos prontos para download' : 'Execucao concluida',
        undefined,
        { unitsProcessed },
      );

      await this.executionsService.log(execution.id, 'info', 'Execucao finalizada com sucesso.');
      await this.maybeNotify(execution.id, execution.robot.name, 'success');
    } catch (error) {
      const message =
        this.stalledExecutions.get(execution.id) ??
        (error instanceof Error ? error.message : 'Falha inesperada durante a execucao');
      const current = await this.executionsService.getExecution(execution.id);

      try {
        await this.zipOutputDirectory(execution.id);
        const registered = await this.registerOutputFiles(execution.id);
        this.logger.log(`registerOutputFiles: ${registered.length} arquivo(s) registrado(s) para execucao ${execution.id}`);
      } catch (regError) {
        this.logger.error(`registerOutputFiles falhou para execucao ${execution.id}: ${String(regError)}`);
      }

      if (current.status !== ExecutionStatus.canceled) {
        await this.executionsService.markAsError(execution.id, message);
        await this.executionsService.log(execution.id, 'error', message);
        await this.maybeNotify(execution.id, execution.robot.name, 'error');
      }
    } finally {
      this.runningProcesses.delete(execution.id);
      this.stoppedExecutions.delete(execution.id);
      this.stalledExecutions.delete(execution.id);
      void this.processQueue();
    }
  }

  private async maybeNotify(executionId: string, robotName: string, status: 'success' | 'error') {
    try {
      const execution = await this.executionsService.getScheduledTaskId(executionId);
      if (execution?.scheduledTaskId) {
        await this.notificationsService.createForScheduledTaskExecution(
          executionId,
          execution.scheduledTaskId,
          status,
          robotName,
        );
      }
    } catch (error) {
      this.logger.warn('Failed to create notifications for execution', error);
    }
  }

  private async runCommandExecution(
    executionId: string,
    command: string,
    workingDirectory?: string | null,
    robotId?: string,
  ) {
    await this.executionsService.log(executionId, 'info', `Iniciando comando: ${command}`);
    await this.executionsService.updateProgress(executionId, 25, 'Executando automacao');

    const cwd = workingDirectory ? resolveWorkingDirectory(workingDirectory) : process.cwd();

    const pipDir = robotId ? robotPipDir(robotId) : null;

    let resolvedCommand = command;
    let pythonPath: string | undefined = process.env.PYTHONPATH;

    if (pipDir) {
      const venvPython = process.platform === 'win32'
        ? join(pipDir, 'Scripts', 'python.exe')
        : join(pipDir, 'bin', 'python3');
      const hasVenv = await access(venvPython).then(() => true).catch(() => false);

      if (hasVenv) {
        resolvedCommand = command.replace(/^python3?\s+/, `"${venvPython}" `);
        pythonPath = undefined;
      } else {
        const hasPip = await access(pipDir).then(() => true).catch(() => false);
        if (hasPip) {
          pythonPath = [pipDir, process.env.PYTHONPATH].filter(Boolean).join(':');
        }
      }
    }

    const child = spawn(resolvedCommand, {
      cwd,
      shell: true,
      windowsHide: WINDOWS_HIDE,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        ...(pythonPath ? { PYTHONPATH: pythonPath } : {}),
        AUTOMATION_EXECUTION_ID: executionId,
        AUTOMATION_INPUT_DIR: inputDir(executionId),
        AUTOMATION_OUTPUT_DIR: outputDir(executionId),
        AUTOMATION_EXECUTION_DIR: executionRoot(executionId),
        AUTOMATION_METADATA_DIR: metadataDir(executionId),
        AUTOMATION_PARAMETERS_FILE: join(metadataDir(executionId), 'parameters.json'),
        AUTOMATION_CONTEXT_FILE: join(metadataDir(executionId), 'context.json'),
      },
    });

    this.runningProcesses.set(executionId, { child, metrics: {}, lastActivityAt: Date.now() });

    const markActivity = () => {
      const running = this.runningProcesses.get(executionId);
      if (running) running.lastActivityAt = Date.now();
    };

    const stdoutReader = createLineReader(async (line) => {
      await this.handleProcessLine(executionId, line, 'info');
    });
    const stderrReader = createLineReader(async (line) => {
      await this.handleProcessLine(executionId, line, 'error');
    });

    child.stdout.on('data', (chunk) => {
      markActivity();
      stdoutReader.push(chunk.toString());
    });

    child.stderr.on('data', (chunk) => {
      markActivity();
      stderrReader.push(chunk.toString());
    });

    await new Promise<void>((resolve, reject) => {
      child.on('close', async (code) => {
        this.logger.log(`child.close: executionId=${executionId} code=${code} stopped=${this.stoppedExecutions.has(executionId)}`);
        // Kill any orphan children (Chrome, chromedriver, etc.) that survived
        if (process.platform !== 'win32' && child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
        }
        try {
          await stdoutReader.flush();
          await stderrReader.flush();

          if (code === 0) {
            resolve();
            return;
          }

          const running = this.runningProcesses.get(executionId);
          reject(new Error(failureReason(code, running?.lastRobotError, running?.lastPythonException)));
        } catch (error) {
          reject(error);
        }
      });

      child.on('error', (error) => {
        reject(error);
      });
    });

    if (!this.stoppedExecutions.has(executionId)) {
      await this.executionsService.updateProgress(executionId, 90, 'Finalizando saidas');
    }
  }

  private async zipOutputDirectory(executionId: string): Promise<void> {
    const outDir = outputDir(executionId);
    const files = await listFilesRecursively(outDir);
    if (files.length < 2) return; // 0 ou 1 arquivo — não precisa zipar

    const zip = new AdmZip();
    for (const file of files) {
      // Preserva a estrutura de subpastas do robo dentro do zip (ex:
      // site/empresa/arquivo.pdf) - sem isso tudo ia pra raiz do zip e
      // arquivos com o mesmo nome de empresas diferentes se sobrescreviam.
      const relativePath = relative(outDir, file).replaceAll('\\', '/');
      const lastSlash = relativePath.lastIndexOf('/');
      const zipFolder = lastSlash === -1 ? '' : relativePath.slice(0, lastSlash);
      const name = lastSlash === -1 ? relativePath : relativePath.slice(lastSlash + 1);
      zip.addLocalFile(file, zipFolder, name);
    }
    zip.writeZip(join(outDir, 'output.zip'));

    for (const file of files) {
      await unlink(file).catch(() => {});
    }
  }

  private async registerOutputFiles(executionId: string) {
    const outputRoot = outputDir(executionId);
    const files = await listFilesRecursively(outputRoot);

    const storedFiles: unknown[] = [];
    for (const fullPath of files) {
      const relativePath = relative(storageRoot, fullPath).replaceAll('\\', '/');
      const name = sanitizeFileName(fullPath.split(/[\\/]/).pop() ?? 'output');
      const userFileName = toUserFileName(name);

      storedFiles.push(
        await this.executionsService.registerOutputFile({
          executionId,
          kind: 'output',
          filename: name,
          storagePath: relativePath,
          downloadName: userFileName,
        }),
      );
    }

    return storedFiles;
  }

  private async writeExecutionMetadata(
    executionId: string,
    parameters: unknown,
    robot: { id: string; slug: string; name: string },
  ) {
    const metadataRoot = metadataDir(executionId);

    await writeFile(
      join(metadataRoot, 'parameters.json'),
      JSON.stringify(parameters ?? {}, null, 2),
      'utf8',
    );

    await writeFile(
      join(metadataRoot, 'context.json'),
      JSON.stringify(
        {
          executionId,
          robot,
          inputDir: inputDir(executionId),
          outputDir: outputDir(executionId),
          metadataDir: metadataRoot,
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  private async handleProcessLine(
    executionId: string,
    rawLine: string,
    fallbackLevel: string,
  ) {
    if (this.stoppedExecutions.has(executionId)) {
      return;
    }

    const line = rawLine.trim();
    if (!line) {
      return;
    }

    const progressMatch = line.match(/^AH_PROGRESS\|(\d{1,3})\|(.*)$/);
    if (progressMatch) {
      const progress = Number(progressMatch[1]);
      const step = progressMatch[2].trim() || 'Executando automacao';
      await this.executionsService.updateProgress(executionId, Math.max(0, Math.min(100, progress)), step);
      await this.executionsService.log(executionId, 'info', step);
      return;
    }

    const logMatch = line.match(/^AH_LOG\|(info|warn|error)\|(.*)$/i);
    if (logMatch) {
      const level = logMatch[1].toLowerCase();
      const message = logMatch[2].trim();
      if (level === 'error' && message) {
        const running = this.runningProcesses.get(executionId);
        if (running) running.lastRobotError = message;
      }
      await this.executionsService.log(executionId, level, message);
      return;
    }

    const metricMatch = line.match(/^AH_METRIC\|([a-z0-9_.-]+)\|(-?\d+(?:[.,]\d+)?)$/i);
    if (metricMatch) {
      const rawKey = metricMatch[1];
      const parsedValue = Number(metricMatch[2].replace(',', '.'));
      const metricKey = normalizeMetricKey(rawKey);
      if (metricKey && Number.isFinite(parsedValue)) {
        const running = this.runningProcesses.get(executionId);
        if (running) {
          running.metrics[metricKey] = (running.metrics[metricKey] ?? 0) + parsedValue;
        }
        await this.executionsService.log(
          executionId,
          'info',
          `Metrica registrada: ${metricKey}=${parsedValue}`,
        );
      }
      return;
    }

    if (fallbackLevel === 'error' && isPythonExceptionLine(line)) {
      const running = this.runningProcesses.get(executionId);
      if (running) running.lastPythonException = line;
    }

    await this.executionsService.log(executionId, fallbackLevel, line);
  }
}

function terminateProcessTree(pid?: number) {
  if (!pid) {
    return Promise.resolve();
  }

  if (process.platform === 'win32') {
    return new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
      });
      killer.on('close', () => resolve());
      killer.on('error', () => resolve());
    });
  }

  return new Promise<void>((resolve) => {
    try {
      // Negative PID kills the entire process group on Unix
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Process already gone
      }
    }
    resolve();
  });
}

function getGlobalConcurrencyLimit() {
  const raw = Number(process.env.RUNNER_MAX_CONCURRENCY ?? 2);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2;
}

function getMemoryThresholdPercentage() {
  const raw = Number(process.env.RUNNER_MEMORY_THRESHOLD_PERCENT ?? 90);
  if (!Number.isFinite(raw)) {
    return 90;
  }

  return Math.min(99, Math.max(1, Math.floor(raw)));
}

function getMemoryUsagePercentage() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return Math.round((used / total) * 100);
}

function parseConflictKeys(value?: string | null) {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function hasConflict(left: string[], right: string[]) {
  if (left.length === 0 || right.length === 0) {
    return false;
  }

  const rightSet = new Set(right);
  return left.some((item) => rightSet.has(item));
}

function resolveWorkingDirectory(value: string) {
  if (/^[A-Za-z]:\\/.test(value)) {
    return value;
  }

  if (value.startsWith('file://')) {
    return fileURLToPath(value);
  }

  if (value.startsWith('/')) {
    return value;
  }

  return join(process.cwd(), value);
}

function normalizeMetricKey(value?: string | null) {
  if (!value) {
    return null;
  }

  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function createLineReader(onLine: (line: string) => Promise<void>) {
  let buffer = '';
  let queue = Promise.resolve();

  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        queue = queue.then(() => onLine(line));
      }
    },
    async flush() {
      if (buffer.trim()) {
        queue = queue.then(() => onLine(buffer));
      }
      buffer = '';
      await queue;
    },
  };
}
