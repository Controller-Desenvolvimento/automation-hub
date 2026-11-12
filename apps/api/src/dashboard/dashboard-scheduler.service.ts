import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DashboardService } from './dashboard.service';
import { getCatchUpMs, isIntentionallyStopped, isUpdateDue } from './update-policy';

const TICK_INTERVAL_MS = 60 * 1000; // 1 minute
// Logo depois de o Hub subir, os painéis ainda estão iniciando: uma atualização recuperada nessa hora falharia só
// porque o painel não terminou de abrir. Nesse intervalo, painel que ainda não está rodando espera o próximo ciclo.
const BOOT_GRACE_MS = 10 * 60 * 1000;

@Injectable()
export class DashboardSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DashboardSchedulerService.name);
  private readonly bootAt = Date.now();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly dashboardService: DashboardService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now: Date = new Date()) {
    // Horário do servidor (Brasil, sem horário de verão), como sempre foi.
    const dashboards = await this.prisma.dashboard.findMany({
      where: { isActive: true, updatePath: { not: null } },
    });
    const catchUpMs = getCatchUpMs();

    for (const d of dashboards) {
      if (this.dashboardService.isUpdating(d.id)) continue;

      // Painel parado de propósito: nada a atualizar, nem alerta. Uma repetição que estava pendente é cancelada
      // (se alguém o parou entre as duas tentativas, a segunda não deve rodar nem gerar e-mail).
      if (isIntentionallyStopped(d.streamlitStatus)) {
        if (d.updateRetryAt) {
          await this.prisma.dashboard.update({ where: { id: d.id }, data: { updateRetryAt: null } }).catch(() => undefined);
        }
        continue;
      }

      // 2ª tentativa (depois de uma falha): só quando chegar a hora marcada, mesmo que o Hub tenha reiniciado no meio.
      let attempt: 1 | 2 | null = null;
      if (d.updateRetryAt) {
        if (d.updateRetryAt.getTime() > now.getTime()) continue;
        attempt = 2;
      } else if (
        d.updateFrequency &&
        isUpdateDue({
          schedule: {
            frequency: d.updateFrequency,
            timesOfDay: d.updateTimesOfDay,
            dayOfWeek: d.updateDayOfWeek,
            dayOfMonth: d.updateDayOfMonth,
          },
          lastUpdateAt: d.lastUpdateAt,
          now,
          catchUpMs,
        })
      ) {
        attempt = 1;
      }
      if (!attempt) continue;

      if (!this.dashboardService.isRunning(d.id) && Date.now() - this.bootAt < BOOT_GRACE_MS) continue;

      this.logger.log(`Scheduled update: ${d.slug} (tentativa ${attempt})`);
      this.dashboardService.runScheduledUpdate(d.id, attempt).catch((err: unknown) => {
        // "TypeError: fetch failed" sozinho não diz nada — a causa real
        // (ECONNREFUSED, socket hang up etc.) fica em err.cause, que
        // String(err) não inclui.
        const cause = err instanceof Error && err.cause ? ` (causa: ${String(err.cause)})` : '';
        this.logger.warn(`Scheduled update crashed for ${d.slug}: ${String(err)}${cause}`);
      });
    }
  }
}
