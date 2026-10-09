import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DashboardService } from './dashboard.service';

const TICK_INTERVAL_MS = 60 * 1000; // 1 minute

@Injectable()
export class DashboardSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DashboardSchedulerService.name);
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

  async tick() {
    // Brazil timezone offset: UTC-3 (no DST). Using local server time is fine
    // since the server is in Brazil.
    const now = new Date();
    const dashboards = await this.prisma.dashboard.findMany({
      where: {
        isActive: true,
        updatePath: { not: null },
        updateFrequency: { not: null },
      },
    });

    for (const d of dashboards) {
      if (d.updateTimesOfDay.length === 0) continue;
      if (this.shouldRunNow(d.updateFrequency!, d.updateTimesOfDay, d.updateDayOfWeek, d.updateDayOfMonth, now)) {
        this.logger.log(`Scheduled update: ${d.slug}`);
        this.dashboardService.triggerUpdate(d.id).catch((err: unknown) => {
          // "TypeError: fetch failed" sozinho não diz nada — a causa real
          // (ECONNREFUSED, socket hang up etc.) fica em err.cause, que
          // String(err) não inclui.
          const cause = err instanceof Error && err.cause ? ` (causa: ${String(err.cause)})` : '';
          this.logger.warn(`Scheduled update failed for ${d.slug}: ${String(err)}${cause}`);
        });
      }
    }
  }

  private shouldRunNow(
    frequency: string,
    timesOfDay: string[],
    dayOfWeek: number | null,
    dayOfMonth: number | null,
    now: Date,
  ): boolean {
    const matchesTime = timesOfDay.some((timeOfDay) => {
      const parts = timeOfDay.split(':');
      const h = Number(parts[0]);
      const m = Number(parts[1]);
      if (isNaN(h) || isNaN(m)) return false;
      return now.getHours() === h && now.getMinutes() === m;
    });
    if (!matchesTime) return false;

    if (frequency === 'daily') return true;
    if (frequency === 'weekly') return now.getDay() === (dayOfWeek ?? 1);
    if (frequency === 'monthly') return now.getDate() === (dayOfMonth ?? 1);
    return false;
  }
}
