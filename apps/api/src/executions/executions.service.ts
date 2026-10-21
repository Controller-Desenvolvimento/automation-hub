import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ExecutionStatus, Prisma, type User } from '@prisma/client';
import AdmZip from 'adm-zip';
import { access, copyFile, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import { buildExecutionScope, canAccessExecution, canAccessRobot, isAdmin } from '../shared/access';
import { parametersForViewer, withoutParameters } from '../shared/execution-parameters';
import { fixMulterFilename, toUserFileName, uniqueStoredFileName } from '../shared/files';
import { validateServerPathParameters } from '../shared/server-path';
import { ensureExecutionDirs, inputDir, storageRoot } from '../shared/storage';

type UploadFile = {
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
  path?: string;
};

const SPREADSHEET_RE = /\.(xlsx|xlsm|xls)$/i;
const SPREADSHEET_MIME: Record<string, string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.xls': 'application/vnd.ms-excel',
};

type ExecutionFileRow = {
  id: string;
  kind: string;
  filename: string;
  originalName: string | null;
  downloadName: string | null;
  storagePath: string;
  mimeType: string | null;
  size: number | null;
};

type OutputSpreadsheet = { name: string; data: Buffer };

// Nome sem o prefixo "<timestamp>-<id>-" que o hub põe nos arquivos enviados e sem a extensão, para comparar.
function comparableBaseName(name: string) {
  return name
    .replace(/^(?:\d{13}-[a-z0-9]{6}-)+/i, '')
    .replace(/\.[^.]+$/, '')
    .trim()
    .toLowerCase();
}

function isSpreadsheetName(name: string | null | undefined) {
  return SPREADSHEET_RE.test(name ?? '');
}

type CreateExecutionInput = {
  userId: string;
  notes?: string;
  priority?: number;
  parameters?: Record<string, unknown>;
  scheduledTaskId?: string;
};

@Injectable()
export class ExecutionsService {
  constructor(private readonly prisma: PrismaService) {}

  async createExecution(
    robotId: string,
    payload: CreateExecutionInput,
    uploadedFiles: UploadFile[],
  ) {
    if (!robotId) {
      throw new BadRequestException('Robot id is required');
    }

    const [robot, user] = await Promise.all([
      this.prisma.robot.findUnique({ where: { id: robotId } }),
      this.prisma.user.findUnique({ where: { id: payload.userId } }),
    ]);

    if (!robot) {
      throw new NotFoundException('Robot not found');
    }
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (!canAccessRobot(user, robot)) {
      throw new NotFoundException('Robot not found');
    }

    validateServerPathParameters(robot.schema, payload.parameters);

    const execution = await this.prisma.execution.create({
      data: {
        robotId,
        userId: user.id,
        requestedByName: user.name,
        requestedByEmail: user.email,
        notes: payload.notes,
        priority: payload.priority ?? 0,
        inputJson: (payload.parameters ?? {}) as Prisma.InputJsonValue,
        scheduledTaskId: payload.scheduledTaskId,
      },
    });

    await ensureExecutionDirs(execution.id);

    if (uploadedFiles.length > 0) {
      const inputFiles = await Promise.all(
        uploadedFiles.map(async (file) => {
          const originalname = fixMulterFilename(file.originalname ?? 'arquivo');
          const storedName = uniqueStoredFileName(originalname);
          const absolutePath = join(inputDir(execution.id), storedName);

          if (file.path) {
            // disk storage — move do temp dir do multer
            try {
              await rename(file.path, absolutePath);
            } catch {
              await copyFile(file.path, absolutePath);
              await unlink(file.path).catch(() => undefined);
            }
          } else if (file.buffer) {
            await writeFile(absolutePath, file.buffer);
          } else {
            throw new InternalServerErrorException('Uploaded file buffer is empty');
          }

          const userFileName = toUserFileName(originalname);
          return {
            executionId: execution.id,
            kind: 'input',
            filename: storedName,
            originalName: userFileName,
            storagePath: relative(storageRoot, absolutePath).replaceAll('\\', '/'),
            downloadName: userFileName,
            mimeType: file.mimetype,
            size: file.size ?? (file.buffer?.length ?? 0),
          };
        }),
      );

      await this.prisma.executionFile.createMany({ data: inputFiles });
    }

    await this.log(execution.id, 'info', 'Execução recebida e colocada na fila.');
    await this.updateProgress(execution.id, 5, 'Aguardando processamento');

    return this.getExecution(execution.id, user);
  }

  /** Rodar de novo com as mesmas entradas (quem executou ou um administrador). */
  async retry(id: string, requestedBy: User) {
    return this.cloneExecution(id, requestedBy, null);
  }

  /**
   * Rodar de novo usando a PLANILHA FINAL da execução como entrada (no lugar da planilha enviada). Serve para
   * continuar de onde parou quando o robô foi interrompido (hub reiniciado, cancelamento, erro): a planilha de
   * saída já traz marcado o que foi feito, e o robô pula essas linhas.
   */
  async retryWithOutputSpreadsheet(id: string, requestedBy: User, fileName?: string) {
    return this.cloneExecution(id, requestedBy, { fileName });
  }

  private async cloneExecution(
    id: string,
    requestedBy: User,
    withOutput: { fileName?: string } | null,
  ) {
    const original = await this.prisma.execution.findUnique({
      where: { id },
      include: { files: true, robot: true },
    });

    if (!original) {
      throw new NotFoundException('Execution not found');
    }

    // Quem executou ou um administrador. Repetir reaproveita os parâmetros da execução original (inclusive CPF/senha
    // digitados nela), por isso um colega não pode repetir a execução de outro.
    if (!isAdmin(requestedBy) && original.userId !== requestedBy.id) {
      throw new ForbiddenException('Só quem executou a automação (ou um administrador) pode rodá-la novamente.');
    }
    if (!canAccessRobot(requestedBy, original.robot)) {
      throw new NotFoundException('Execution not found');
    }

    if (original.status !== ExecutionStatus.error && original.status !== ExecutionStatus.canceled) {
      throw new BadRequestException('Só é possível reiniciar execuções com falha ou canceladas.');
    }

    if (original.cleanedAt) {
      throw new BadRequestException(
        'Os arquivos de entrada dessa execução já foram removidos pela retenção. Não é possível reiniciar automaticamente.',
      );
    }

    const inputFiles = original.files.filter((file) => file.kind === 'input');

    // Modo "planilha final como entrada": descobre a planilha de saída e qual entrada ela substitui — tudo antes de criar
    // a execução nova, para um erro aqui não deixar uma execução pela metade.
    let replacement: { target: ExecutionFileRow; output: OutputSpreadsheet } | null = null;
    if (withOutput) {
      const output = await this.findOutputSpreadsheet(original.files, inputFiles, withOutput.fileName);
      replacement = { target: this.pickInputToReplace(inputFiles, output.name), output };
    }

    const execution = await this.prisma.execution.create({
      data: {
        robotId: original.robotId,
        userId: original.userId,
        requestedByName: original.requestedByName,
        requestedByEmail: original.requestedByEmail,
        notes: original.notes,
        priority: original.priority,
        inputJson: (original.inputJson ?? {}) as Prisma.InputJsonValue,
      },
    });

    await ensureExecutionDirs(execution.id);

    const copiedFiles = await Promise.all(
      inputFiles.map(async (file) => {
        if (replacement && file.id === replacement.target.id) {
          // Mantém o nome da planilha original (o robô monta o nome da saída a partir dele) com a extensão da planilha final.
          const baseName = (file.originalName ?? file.filename).replace(/\.[^.]+$/, '');
          const extension = extname(replacement.output.name).toLowerCase();
          const newName = `${baseName}${extension}`;
          const storedName = uniqueStoredFileName(newName);
          const absolutePath = join(inputDir(execution.id), storedName);
          await writeFile(absolutePath, replacement.output.data);
          return {
            executionId: execution.id,
            kind: 'input',
            filename: storedName,
            originalName: newName,
            storagePath: relative(storageRoot, absolutePath).replaceAll('\\', '/'),
            downloadName: newName,
            mimeType: SPREADSHEET_MIME[extension] ?? file.mimeType,
            size: replacement.output.data.length,
          };
        }

        const storedName = uniqueStoredFileName(file.originalName ?? file.filename);
        const absolutePath = join(inputDir(execution.id), storedName);
        await copyFile(join(storageRoot, file.storagePath), absolutePath);
        return {
          executionId: execution.id,
          kind: 'input',
          filename: storedName,
          originalName: file.originalName,
          storagePath: relative(storageRoot, absolutePath).replaceAll('\\', '/'),
          downloadName: file.downloadName,
          mimeType: file.mimeType,
          size: file.size,
        };
      }),
    );

    if (copiedFiles.length > 0) {
      await this.prisma.executionFile.createMany({ data: copiedFiles });
    }

    await this.log(
      execution.id,
      'info',
      replacement
        ? `Execução reiniciada usando a planilha de saída "${replacement.output.name}" da execução ${original.id} como entrada, por ${requestedBy.name}.`
        : `Execução reiniciada com as mesmas entradas da execução ${original.id} por ${requestedBy.name}.`,
    );
    await this.updateProgress(execution.id, 5, 'Aguardando processamento');

    return this.getExecution(execution.id, requestedBy);
  }

  /** Planilhas (.xlsx/.xlsm/.xls) que a execução deixou na saída — soltas ou dentro do output.zip. */
  private async findOutputSpreadsheet(
    files: ExecutionFileRow[],
    inputFiles: ExecutionFileRow[],
    preferredName?: string,
  ): Promise<OutputSpreadsheet> {
    const candidates: Array<{ name: string; read: () => Promise<Buffer> }> = [];

    for (const file of files.filter((f) => f.kind === 'output')) {
      const fullPath = join(storageRoot, file.storagePath);
      const name = file.downloadName ?? file.filename;
      if (isSpreadsheetName(name)) {
        candidates.push({ name, read: () => readFile(fullPath) });
      } else if (/\.zip$/i.test(name) || /\.zip$/i.test(file.filename)) {
        try {
          await access(fullPath);
          const zip = new AdmZip(fullPath);
          for (const entry of zip.getEntries()) {
            const entryName = entry.entryName.split('/').pop() ?? entry.entryName;
            if (!entry.isDirectory && isSpreadsheetName(entryName) && !entryName.startsWith('~$')) {
              candidates.push({ name: entryName, read: async () => entry.getData() });
            }
          }
        } catch {
          // zip ausente ou ilegível: segue com o que achou
        }
      }
    }

    if (candidates.length === 0) {
      throw new BadRequestException(
        'Essa execução não deixou nenhuma planilha (.xlsx) na saída para usar como entrada.',
      );
    }

    let chosen = candidates.length === 1 ? candidates[0] : undefined;
    if (!chosen && preferredName) {
      chosen = candidates.find((c) => c.name.toLowerCase() === preferredName.toLowerCase());
    }
    if (!chosen) {
      // Várias planilhas na saída: vale a que tem o mesmo nome (sem extensão) de uma planilha enviada.
      const inputBases = new Set(
        inputFiles
          .filter((f) => isSpreadsheetName(f.originalName ?? f.filename))
          .map((f) => comparableBaseName(f.originalName ?? f.filename)),
      );
      const matches = candidates.filter((c) => inputBases.has(comparableBaseName(c.name)));
      if (matches.length === 1) chosen = matches[0];
    }
    if (!chosen) {
      throw new BadRequestException(
        `Há mais de uma planilha na saída (${candidates.map((c) => c.name).join(', ')}) e não sei qual usar como entrada.`,
      );
    }

    return { name: chosen.name, data: await chosen.read() };
  }

  /** Qual planilha ENVIADA a planilha de saída vai substituir. */
  private pickInputToReplace(inputFiles: ExecutionFileRow[], outputName: string): ExecutionFileRow {
    const spreadsheets = inputFiles.filter((f) => isSpreadsheetName(f.originalName ?? f.filename));
    if (spreadsheets.length === 0) {
      throw new BadRequestException(
        'Essa execução não recebeu planilha como entrada, então não há o que trocar pela planilha de saída.',
      );
    }
    if (spreadsheets.length === 1) return spreadsheets[0];

    const wanted = comparableBaseName(outputName);
    const same = spreadsheets.filter((f) => comparableBaseName(f.originalName ?? f.filename) === wanted);
    if (same.length === 1) return same[0];
    throw new BadRequestException(
      'Essa execução recebeu mais de uma planilha e não sei qual delas trocar pela planilha de saída.',
    );
  }

  async listExecutions(user: User) {
    const where = buildExecutionScope(user);
    const executions = await this.prisma.execution.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        robot: true,
        files: true,
        user: {
          select: {
            id: true,
            departments: true,
          },
        },
      },
      take: 200,
    });

    return executions
      .filter(
        (execution) =>
          canAccessExecution(user, execution) && canAccessRobot(user, execution.robot),
      )
      .map(withoutParameters);
  }

  async listResults(user: User) {
    const adminUser = isAdmin(user);
    const executions = await this.prisma.execution.findMany({
      where: {
        ...(adminUser ? {} : buildExecutionScope(user)),
        status: ExecutionStatus.success,
        files: { some: { kind: 'output' } },
      },
      orderBy: { finishedAt: 'desc' },
      include: {
        robot: { select: { id: true, name: true, slug: true, category: true, icon: true, allowedDepartments: true } },
        files: { where: { kind: 'output' }, orderBy: { createdAt: 'asc' } },
        user: { select: { id: true, departments: true } },
      },
      take: 300,
    });

    // Buscar dados de destinatários das tarefas agendadas (sem relação no schema)
    const taskIds = [...new Set(executions.map((e) => e.scheduledTaskId).filter(Boolean))] as string[];
    const tasks = taskIds.length > 0
      ? await this.prisma.scheduledTask.findMany({
          where: { id: { in: taskIds } },
          select: { id: true, recipientScope: true, recipientDepartments: true, recipientUserIds: true },
        })
      : [];
    const taskMap = new Map(tasks.map((t) => [t.id, t]));

    const visible = executions.filter((e) => {
      if (!canAccessRobot(user, e.robot as Parameters<typeof canAccessRobot>[1])) return false;
      if (adminUser) return true;

      // Execução manual: regra normal de acesso por dono / departamento
      if (!e.scheduledTaskId) {
        return canAccessExecution(user, e);
      }

      // Execução agendada: checar se o usuário é destinatário configurado na tarefa
      const task = taskMap.get(e.scheduledTaskId);
      if (!task) return false;
      if (task.recipientScope === 'all') return true;
      if (task.recipientScope === 'departments') {
        return user.departments.some((d) => task.recipientDepartments.includes(d));
      }
      // 'specific'
      return task.recipientUserIds.includes(user.id);
    });
    return visible.map(withoutParameters);
  }

  async getExecution(id: string, user?: User) {
    const execution = await this.prisma.execution.findUnique({
      where: { id },
      include: {
        robot: true,
        files: { orderBy: { createdAt: 'asc' } },
        logs: { orderBy: { timestamp: 'asc' } },
        user: {
          select: {
            id: true,
            departments: true,
          },
        },
      },
    });

    if (!execution) {
      throw new NotFoundException('Execution not found');
    }
    if (
      user &&
      (!canAccessExecution(user, execution) || !canAccessRobot(user, execution.robot))
    ) {
      throw new NotFoundException('Execution not found');
    }

    // Com `user` (resposta ao navegador): parâmetros completos para quem executou e admins; sem as senhas para os demais.
    // Sem `user` é uso interno do servidor e nada é alterado.
    const parameters = user
      ? parametersForViewer(execution, user)
      : { inputJson: execution.inputJson, hiddenParameters: [] as string[] };

    return {
      ...execution,
      inputJson: parameters.inputJson,
      hiddenParameters: parameters.hiddenParameters,
      files: execution.files.map((file) => ({
        ...file,
        downloadUrl: `/storage/${file.storagePath}`,
      })),
    };
  }

  async getQueuedExecution() {
    return this.prisma.execution.findFirst({
      where: { status: ExecutionStatus.queued },
      orderBy: { createdAt: 'asc' },
      include: {
        robot: true,
        files: true,
      },
    });
  }

  async listQueuedExecutions(limit = 50) {
    return this.prisma.execution.findMany({
      where: { status: ExecutionStatus.queued },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      include: {
        robot: true,
        files: true,
      },
      take: limit,
    });
  }

  async listRunningExecutions() {
    return this.prisma.execution.findMany({
      where: { status: ExecutionStatus.running },
      orderBy: { startedAt: 'asc' },
      include: {
        robot: true,
        files: true,
      },
    });
  }

  async getScheduledTaskId(id: string) {
    return this.prisma.execution.findUnique({
      where: { id },
      select: { scheduledTaskId: true },
    });
  }

  async getStatus(id: string) {
    const execution = await this.prisma.execution.findUnique({
      where: { id },
      select: { status: true },
    });

    if (!execution) {
      throw new NotFoundException('Execution not found');
    }

    return execution.status;
  }

  async markAsRunning(id: string) {
    // Só reivindica execuções ainda na fila: uma execução cancelada entre a
    // listagem da fila e este ponto não pode voltar a "running"
    const claimed = await this.prisma.execution.updateMany({
      where: { id, status: ExecutionStatus.queued },
      data: {
        status: ExecutionStatus.running,
        startedAt: new Date(),
        progress: 15,
        currentStep: 'Inicializando ambiente',
      },
    });

    if (claimed.count === 0) {
      return null;
    }

    return this.prisma.execution.findUnique({
      where: { id },
      include: {
        robot: true,
        files: true,
      },
    });
  }

  async markAsSuccess(
    id: string,
    currentStep: string,
    outputZipPath?: string,
    options?: { unitsProcessed?: number | null },
  ) {
    const execution = await this.prisma.execution.findUnique({
      where: { id },
      include: {
        robot: {
          select: {
            manualSecondsPerUnit: true,
          },
        },
      },
    });

    if (!execution) {
      throw new NotFoundException('Execution not found');
    }

    const finishedAt = new Date();
    const unitsProcessed =
      typeof options?.unitsProcessed === 'number' && Number.isFinite(options.unitsProcessed)
        ? Math.max(0, Math.round(options.unitsProcessed))
        : null;
    const manualEstimatedSeconds = calculateManualEstimatedSeconds(
      execution.robot,
      unitsProcessed,
    );
    return this.prisma.execution.update({
      where: { id },
      data: {
        status: ExecutionStatus.success,
        progress: 100,
        currentStep,
        finishedAt,
        outputZipPath,
        unitsProcessed,
        manualEstimatedSeconds,
      },
    });
  }

  async markAsError(id: string, message: string) {
    return this.prisma.execution.update({
      where: { id },
      data: {
        status: ExecutionStatus.error,
        errorMessage: message,
        currentStep: 'Falha na execução',
        finishedAt: new Date(),
      },
    });
  }

  // Execuções que ficam com status "running" quando o processo do hub é
  // reiniciado (deploy, crash) nunca mais são atualizadas — o Map em memória
  // que rastreia processos filhos começa vazio a cada boot, então nenhum
  // código volta a olhar pra essas linhas. Usado pela reconciliação de
  // ExecutionRunnerService.onModuleInit para encontrá-las.
  async findRunningOrphans() {
    return this.prisma.execution.findMany({
      where: { status: ExecutionStatus.running },
      include: { robot: true },
    });
  }

  async cancel(id: string, user: User) {
    const execution = await this.prisma.execution.findUnique({
      where: { id },
      include: {
        robot: true,
        user: {
          select: {
            id: true,
            departments: true,
          },
        },
      },
    });
    if (
      !execution ||
      !canAccessExecution(user, execution) ||
      !canAccessRobot(user, execution.robot)
    ) {
      throw new NotFoundException('Execution not found');
    }

    // Guarda de status: um cancel atrasado não pode sobrescrever uma execução
    // que já terminou (success/error viraria canceled)
    const result = await this.prisma.execution.updateMany({
      where: {
        id,
        status: { in: [ExecutionStatus.queued, ExecutionStatus.running] },
      },
      data: {
        status: ExecutionStatus.canceled,
        canceledAt: new Date(),
        finishedAt: new Date(),
        currentStep: 'Cancelado pelo usuário',
      },
    });

    if (result.count === 0) {
      throw new BadRequestException('A execução já foi finalizada e não pode ser cancelada.');
    }

    // A resposta do cancelamento não precisa dos parâmetros (e quem cancela pode não ser quem executou).
    return withoutParameters(await this.prisma.execution.findUniqueOrThrow({ where: { id } }));
  }

  async updateProgress(id: string, progress: number, currentStep: string) {
    return this.prisma.execution.update({
      where: { id },
      data: { progress, currentStep },
    });
  }

  async updateQueueReason(id: string, currentStep: string) {
    return this.prisma.execution.update({
      where: { id },
      data: {
        currentStep,
        progress: 5,
      },
    });
  }

  async log(executionId: string, level: string, message: string) {
    return this.prisma.executionLog.create({
      data: {
        executionId,
        level,
        message,
      },
    });
  }

  async registerOutputFile(input: {
    executionId: string;
    kind: string;
    filename: string;
    originalName?: string;
    storagePath: string;
    downloadName?: string;
    mimeType?: string;
    size?: number;
  }) {
    return this.prisma.executionFile.create({
      data: input,
    });
  }
}

function calculateManualEstimatedSeconds(
  robot: {
    manualSecondsPerUnit: number;
  },
  unitsProcessed: number | null,
) {
  const unitSeconds = Math.max(0, robot.manualSecondsPerUnit || 0);
  const units =
    unitsProcessed === null || unitsProcessed === undefined
      ? 1
      : Math.max(0, unitsProcessed);

  return unitSeconds * units;
}
