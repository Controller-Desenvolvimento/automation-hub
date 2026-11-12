import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ExecutionRunnerService } from '../executions/execution-runner.service';
import { ExecutionsService } from '../executions/executions.service';
import { MailService } from '../mail/mail.service';
import { restartFailedInputFrom } from '../mail/schedule-check-alert';
import { resolveHubBaseUrl } from '../mail/scheduled-execution-alert';
import { PrismaService } from '../prisma/prisma.service';
import {
  checkConfigFromTask,
  decideCheck,
  effectiveMaxRuntime,
  isOverLimit,
  limitReason,
  markTimes,
  MAX_ATTEMPTS,
  t2Reason,
  type CheckConfig,
} from './schedule-checks';
import { dependencyFailureText, resolveCycle } from './schedule-dependency';
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
      // Por último: assim um reinício criado neste mesmo ciclo já conta como "pendente" para quem espera.
      await this.resolveHeld(now);
    } catch (err) {
      this.logger.error(`Verificação por tempo falhou: ${String(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  private async loadTasks(ids: string[]) {
    const tasks = await this.prisma.scheduledTask.findMany({
      where: { id: { in: ids } },
      select: {
        id: true, name: true, isActive: true,
        verifyT0Minutes: true, verifyT1Minutes: true, verifyT2Minutes: true, maxRuntimeMinutes: true,
      },
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
        if (!task || !execution.startedAt) continue;
        const cfg = checkConfigFromTask(task);

        // "Sem verificação" com teto de tempo: passou do teto rodando, cancela e avisa (sem reiniciar).
        if (!cfg) {
          const max = effectiveMaxRuntime(task);
          if (max !== null && isOverLimit(execution.startedAt, now, max)) await this.cancelByLimit(execution, task.name, max);
          continue;
        }

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
    const reason = t2Reason(cfg);
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
      // Sem reinício, este é o fim do ciclo: quem esperava por ele não vai rodar e entra no e-mail.
      const skipped = await this.executionsService.collectSkippedDependents(data.cycleFirstId);
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
          skipped,
        })
        .catch(() => undefined);
    }
  }

  private async sendFinalAlert(executionId: string) {
    const data = await this.executionsService.getScheduledExecutionForAlert(executionId);
    if (!data) return;
    const skipped = await this.executionsService.collectSkippedDependents(data.cycleFirstId);
    const input = restartFailedInputFrom(data, executionId, resolveHubBaseUrl(), skipped);
    if (!input) return;
    void this.mailService
      ?.sendRestartFailedAlert(input)
      .catch((err: unknown) => this.logger.warn(`E-mail final do reinício (${executionId}) falhou: ${String(err)}`));
  }

  // Teto de tempo (agendamento "sem verificação"): cancela e avisa, SEM reiniciar. É o fim do ciclo.
  private async cancelByLimit(execution: RunningScheduled, scheduleName: string, maxMinutes: number) {
    const reason = limitReason(maxMinutes);
    if (!(await this.executionsService.cancelBySystem(execution.id, reason))) return;
    await this.runner.stopExecution(execution.id);
    await this.executionsService.log(execution.id, 'warn', reason);
    this.logger.warn(`Execução agendada ${execution.id} (${scheduleName}) cancelada pelo teto de tempo: ${reason}`);

    const data = await this.executionsService.getScheduledExecutionForAlert(execution.id);
    if (!data) return;
    const skipped = await this.executionsService.collectSkippedDependents(data.cycleFirstId);
    void this.mailService
      ?.sendScheduledExecutionAlert({
        kind: 'limit',
        executionId: execution.id,
        baseUrl: resolveHubBaseUrl(),
        robotName: data.robotName,
        scheduleName: data.scheduleName,
        startedAt: data.startedAt,
        finishedAt: data.finishedAt,
        errorMessage: data.errorMessage,
        skipped,
      })
      .catch((err: unknown) => this.logger.warn(`E-mail do teto de tempo (${execution.id}) falhou: ${String(err)}`));
  }

  // Execuções retidas por dependência: libera quando o ciclo de que dependem termina com sucesso; cancela (pula) quando
  // termina de outro jeito. Enquanto o ciclo ainda está rodando, na fila ou à espera do reinício, continuam retidas.
  private async resolveHeld(now: Date) {
    const held = await this.executionsService.listHeldExecutions();
    if (held.length === 0) return;

    const byCycle = new Map<string, typeof held>();
    for (const h of held) {
      const key = h.waitingOnExecutionId!;
      byCycle.set(key, [...(byCycle.get(key) ?? []), h]);
    }

    for (const [cycleFirstId, waiting] of byCycle) {
      try {
        const snaps = await this.executionsService.getCycleSnapshots(cycleFirstId);
        // Ciclo sumiu (não deveria): não vale prender o agendamento por isso.
        if (!snaps) {
          for (const w of waiting) await this.executionsService.releaseHeld(w.id);
          continue;
        }

        const depTasks = await this.loadTasks([snaps.scheduledTaskId, ...waiting.map((w) => w.scheduledTaskId)].filter((v): v is string => Boolean(v)));
        const depTask = snaps.scheduledTaskId ? depTasks.get(snaps.scheduledTaskId) : undefined;
        const state = resolveCycle({
          first: snaps.first,
          restart: snaps.restart,
          now,
          restartExpected: depTask ? checkConfigFromTask(depTask) !== null : false,
        });
        if (state.state === 'pending') continue;

        const depName = depTask?.name ?? snaps.robotName;
        const lastDepExecutionId = snaps.restart?.id ?? snaps.first.id;

        for (const w of waiting) {
          if (state.state === 'success') {
            if (await this.executionsService.releaseHeld(w.id)) {
              await this.executionsService.log(w.id, 'info', `Liberada: o agendamento "${depName}" terminou com sucesso.`);
            }
            continue;
          }

          const what = dependencyFailureText(depName, state.detail);
          if (!(await this.executionsService.cancelHeld(w.id, `Pulada: ${what}`))) continue;
          await this.executionsService.log(w.id, 'warn', `Pulada: ${what}`);
          this.logger.warn(`Execução ${w.id} pulada: ${what}`);
          // Aparece em "Último erro" do agendamento, como acontece quando o pulo é na hora do disparo.
          if (w.scheduledTaskId) {
            await this.prisma.scheduledTask
              .update({ where: { id: w.scheduledTaskId }, data: { lastError: `Pulada neste ciclo: ${what}`.slice(0, 500) } })
              .catch(() => undefined);
          }
          if (w.dependencyNotified) continue; // o e-mail do agendamento que falhou já citou esta execução

          const dependentTask = w.scheduledTaskId ? depTasks.get(w.scheduledTaskId) : undefined;
          void this.mailService
            ?.sendDependencySkippedAlert({
              dependentRobot: w.robot.name,
              dependentSchedule: dependentTask?.name ?? w.robot.name,
              dependencyRobot: snaps.robotName,
              dependencySchedule: depName,
              detail: what,
              dependencyExecutionId: lastDepExecutionId,
              baseUrl: resolveHubBaseUrl(),
            })
            .catch((err: unknown) => this.logger.warn(`E-mail de agendamento pulado (${w.id}) falhou: ${String(err)}`));
        }
      } catch (err) {
        this.logger.error(`Resolução das execuções retidas do ciclo ${cycleFirstId} falhou: ${String(err)}`);
      }
    }
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
