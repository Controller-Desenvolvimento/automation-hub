import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ExecutionRunnerService } from '../executions/execution-runner.service';
import { ExecutionsService } from '../executions/executions.service';
import { MailService } from '../mail/mail.service';
import { restartFailedInputFrom } from '../mail/schedule-check-alert';
import { resolveHubBaseUrl } from '../mail/scheduled-execution-alert';
import { PrismaService } from '../prisma/prisma.service';
import {
  checkConfigFromTask,
  checkMarks,
  decideCheck,
  markTimes,
  MAX_ATTEMPTS,
  type CheckConfig,
} from './schedule-checks';
import { ScheduledTasksService } from './scheduled-tasks.service';

const TICK_INTERVAL_MS = 30 * 1000;
const FIRST_TICK_DELAY_MS = 15 * 1000;
// Execução agendada interrompida pelo reinício do Hub só é refeita se isso aconteceu há pouco: depois disso o
// próximo horário do agendamento já cuida de rodar de novo.
const INTERRUPTED_RESTART_WINDOW_MS = 30 * 60 * 1000;

type RunningScheduled = Awaited<ReturnType<ExecutionsService['listRunningScheduledExecutions']>>[number];

// Verificação por tempo (T0, T1, T2) das execuções AGENDADAS. Só atua em agendamentos com os três tempos preenchidos;
// "sem verificação" continua só com o e-mail de erro comum. Execuções manuais nunca entram (não têm agendamento).
@Injectable()
export class ScheduleChecksService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScheduleChecksService.name);
  private timer?: NodeJS.Timeout;
  private firstTick?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly executionsService: ExecutionsService,
    private readonly runner: ExecutionRunnerService,
    private readonly scheduledTasks: ScheduledTasksService,
    @Optional() private readonly mailService?: MailService,
  ) {}

  onModuleInit() {
    // A primeira verificação espera um pouco: o runner precisa antes marcar como "interrompidas" as execuções
    // que estavam rodando quando o Hub reiniciou.
    this.firstTick = setTimeout(() => void this.tick(), FIRST_TICK_DELAY_MS);
    this.firstTick.unref?.();
    this.timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.firstTick) clearTimeout(this.firstTick);
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now: Date = new Date()) {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.checkRunning(now);
      await this.restartInterrupted(now);
    } catch (err) {
      this.logger.error(`Verificação por tempo falhou: ${String(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  private async loadTasks(ids: string[]) {
    const tasks = await this.prisma.scheduledTask.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, isActive: true, verifyT0Minutes: true, verifyT1Minutes: true, verifyT2Minutes: true },
    });
    return new Map(tasks.map((t) => [t.id, t]));
  }

  private async checkRunning(now: Date) {
    const running = await this.executionsService.listRunningScheduledExecutions();
    if (running.length === 0) return;
    const tasks = await this.loadTasks([...new Set(running.map((e) => e.scheduledTaskId!))]);

    for (const execution of running) {
      try {
        const task = tasks.get(execution.scheduledTaskId!);
        const cfg = task ? checkConfigFromTask(task) : null;
        if (!task || !cfg || !execution.startedAt) continue;

        const decision = decideCheck({
          startedAt: execution.startedAt,
          now,
          attempt: execution.attempt,
          checkStage: execution.checkStage,
          cfg,
        });
        if (decision.action === 'notify') await this.notifySlow(execution, task.name, cfg, decision.stage, now);
        else if (decision.action === 'cancel') await this.cancelAndHandle(execution, task.name, cfg);
      } catch (err) {
        this.logger.error(`Verificação por tempo da execução ${execution.id} falhou: ${String(err)}`);
      }
    }
  }

  // T0 / T1: avisa que ainda está rodando. O aviso é marcado ANTES de enviar, para nunca sair duas vezes.
  private async notifySlow(execution: RunningScheduled, scheduleName: string, cfg: CheckConfig, stage: 1 | 2, now: Date) {
    if (!(await this.executionsService.advanceCheckStage(execution.id, stage))) return;
    const times = markTimes(execution.startedAt!, cfg);
    void this.mailService
      ?.sendScheduleSlowAlert({
        stage,
        robotName: execution.robot.name,
        scheduleName,
        executionId: execution.id,
        startedAt: execution.startedAt!,
        now,
        t1At: times.t1,
        t2At: times.t2,
        baseUrl: resolveHubBaseUrl(),
      })
      .catch((err: unknown) => this.logger.warn(`Aviso de demora da execução ${execution.id} falhou: ${String(err)}`));
  }

  // T2: cancela a execução. 1ª tentativa → reinicia do começo (uma vez). 2ª tentativa → cancelada de vez + e-mail final.
  private async cancelAndHandle(execution: RunningScheduled, scheduleName: string, cfg: CheckConfig) {
    const reason = `Cancelada automaticamente: passou do limite de verificação (T2 = ${checkMarks(cfg).t2} min desde o início).`;
    // Primeiro grava "cancelada" no banco (só se ainda estiver rodando): o runner, ao ver o processo morrer, então
    // não a trata como erro nem manda o e-mail de erro comum.
    if (!(await this.executionsService.cancelBySystem(execution.id, reason))) return;
    await this.runner.stopExecution(execution.id);
    await this.executionsService.log(execution.id, 'warn', reason);
    this.logger.warn(`Execução agendada ${execution.id} (${scheduleName}, tentativa ${execution.attempt}) cancelada: ${reason}`);

    if (execution.attempt < MAX_ATTEMPTS) {
      await this.restart(execution.id, execution.scheduledTaskId!, scheduleName, execution.robot.name);
      return;
    }
    await this.sendFinalAlert(execution.id);
  }

  private async restart(failedExecutionId: string, taskId: string, scheduleName: string, robotName: string) {
    try {
      const restarted = await this.scheduledTasks.restartScheduledRun(taskId, failedExecutionId);
      if (!restarted) {
        await this.executionsService.log(failedExecutionId, 'warn', 'Não foi reiniciada: o agendamento foi desativado ou removido.');
        return;
      }
      await this.executionsService.log(failedExecutionId, 'warn', `Reiniciada automaticamente (nova execução ${restarted.id}).`);
      await this.executionsService.log(restarted.id, 'warn', `Reinício automático da execução ${failedExecutionId} (2ª e última tentativa).`);
    } catch (err) {
      // Sem o reinício não haverá e-mail final (ele só sai quando a 2ª tentativa termina): avisa aqui, em e-mail comum.
      this.logger.error(`Não foi possível reiniciar a execução ${failedExecutionId}: ${String(err)}`);
      const data = await this.executionsService.getScheduledExecutionForAlert(failedExecutionId);
      if (!data) return;
      void this.mailService
        ?.sendScheduledExecutionAlert({
          kind: 'error',
          executionId: failedExecutionId,
          baseUrl: resolveHubBaseUrl(),
          robotName,
          scheduleName,
          startedAt: data.startedAt,
          finishedAt: data.finishedAt,
          errorMessage: `${data.errorMessage ?? ''} Não foi possível reiniciar automaticamente: ${String(err)}`.trim(),
        })
        .catch(() => undefined);
    }
  }

  private async sendFinalAlert(executionId: string) {
    const data = await this.executionsService.getScheduledExecutionForAlert(executionId);
    const input = data ? restartFailedInputFrom(data, executionId, resolveHubBaseUrl()) : null;
    if (!input) return;
    void this.mailService
      ?.sendRestartFailedAlert(input)
      .catch((err: unknown) => this.logger.warn(`E-mail final do reinício (${executionId}) falhou: ${String(err)}`));
  }

  // Execução agendada (1ª tentativa) interrompida pelo reinício do Hub: conta como a tentativa que deu errado e é
  // refeita uma vez, se o agendamento tem verificação por tempo. Sem verificação: só o e-mail de interrupção.
  private async restartInterrupted(now: Date) {
    const candidates = await this.executionsService.listInterruptedToRestart(INTERRUPTED_RESTART_WINDOW_MS, now);
    if (candidates.length === 0) return;
    const tasks = await this.loadTasks([...new Set(candidates.map((c) => c.scheduledTaskId!))]);

    for (const candidate of candidates) {
      try {
        const task = tasks.get(candidate.scheduledTaskId!);
        if (!task || !checkConfigFromTask(task)) continue;
        const robotName = (await this.prisma.execution.findUnique({ where: { id: candidate.id }, select: { robot: { select: { name: true } } } }))?.robot.name ?? task.name;
        this.logger.warn(`Execução agendada ${candidate.id} (${task.name}) foi interrompida pelo reinício do Hub: refazendo uma vez.`);
        await this.restart(candidate.id, task.id, task.name, robotName);
      } catch (err) {
        this.logger.error(`Reinício da execução interrompida ${candidate.id} falhou: ${String(err)}`);
      }
    }
  }
}
