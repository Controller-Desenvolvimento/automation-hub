import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isAdmin } from '../shared/access';
import { CATEGORY_INFO, ERROR_CATEGORIES } from './error-causes';
import {
  autoGranularity,
  byRobot,
  categorySeries,
  createClassifier,
  dayKey,
  durationSeries,
  evolutionSeries,
  heatGranularity,
  heatmapGrid,
  miniGranularity,
  miniSeries,
  robotTrend,
  bucketKeys,
  previousPeriod,
  resolvePeriod,
  summarize,
  topCauses,
  type Granularity,
  type HealthExecution,
} from './robot-health-metrics';

export type HealthScope = 'all' | 'manual' | 'scheduled';

@Injectable()
export class RobotHealthService {
  constructor(private readonly prisma: PrismaService) {}

  /** Só administradores (role admin ou Inovação): para os outros a tela "não existe" (404), como no Suporte. */
  requireAdmin(user: User) {
    if (!isAdmin(user)) throw new NotFoundException('Página não encontrada.');
  }

  async overview(user: User, query: Record<string, unknown>) {
    this.requireAdmin(user);

    const scope: HealthScope = query.scope === 'manual' || query.scope === 'scheduled' ? query.scope : 'all';
    const allHistory = query.all === '1' || query.all === 'true';
    const hubRobots: Prisma.ExecutionWhereInput = { robot: { isExternal: false }, status: { in: ['success', 'error', 'canceled'] } };
    const scopeWhere: Prisma.ExecutionWhereInput =
      scope === 'manual' ? { scheduledTaskId: null } : scope === 'scheduled' ? { scheduledTaskId: { not: null } } : {};

    let period = resolvePeriod(query.from, query.to);
    if (allHistory) {
      const first = await this.prisma.execution.findFirst({ where: hubRobots, orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
      if (first) period = resolvePeriod(dayKey(first.createdAt), undefined);
    }
    const previous = allHistory ? null : previousPeriod(period);

    const rows = await this.prisma.execution.findMany({
      where: { ...hubRobots, ...scopeWhere, createdAt: { gte: previous?.from ?? period.from, lte: period.to } },
      select: {
        id: true, robotId: true, status: true, createdAt: true, startedAt: true, finishedAt: true, scheduledTaskId: true,
        // A mensagem só é lida para erros (é ela que diz a causa).
        errorMessage: true,
      },
    });
    const executions: HealthExecution[] = rows.map((r) => ({
      id: r.id,
      robotId: r.robotId,
      status: r.status as HealthExecution['status'],
      createdAt: r.createdAt,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      scheduled: r.scheduledTaskId !== null,
      errorMessage: r.status === 'error' ? r.errorMessage : null,
    }));
    const current = executions.filter((e) => e.createdAt >= period.from && e.createdAt <= period.to);
    const before = previous ? executions.filter((e) => e.createdAt >= previous.from && e.createdAt <= previous.to) : [];

    const classify = createClassifier();
    const robotRows = byRobot(current, before, classify);
    const robots = robotRows.length
      ? await this.prisma.robot.findMany({ where: { id: { in: robotRows.map((r) => r.robotId) } }, select: { id: true, name: true, slug: true, isActive: true } })
      : [];
    const names = new Map(robots.map((r) => [r.id, r]));

    // Duração: os 4 robôs com mais execuções COM SUCESSO (pelo menos 3), como no protótipo.
    const topRobots = [...robotRows].filter((r) => r.durationSamples >= 3).sort((x, y) => y.durationSamples - x.durationSamples).slice(0, 4);
    const heat = heatmapGrid(current, period.from, period.to, heatGranularity(period.days), classify);
    const miniGran = miniGranularity(period.days);
    const miniKeys = bucketKeys(period.from, period.to, miniGran);
    const byRobotId = new Map<string, HealthExecution[]>();
    for (const e of current) byRobotId.set(e.robotId, [...(byRobotId.get(e.robotId) ?? []), e]);
    for (const row of robotRows) row.trend = robotTrend(byRobotId.get(row.robotId) ?? [], miniKeys, miniGran, classify);

    // Limite de reinício (T2) dos agendamentos desses robôs: T0 + T1 + T2, em minutos desde o início (o menor, se houver vários).
    const tasks = topRobots.length
      ? await this.prisma.scheduledTask.findMany({
          where: { isActive: true, robotId: { in: topRobots.map((r) => r.robotId) }, verifyT0Minutes: { not: null }, verifyT1Minutes: { not: null }, verifyT2Minutes: { not: null } },
          select: { robotId: true, verifyT0Minutes: true, verifyT1Minutes: true, verifyT2Minutes: true },
        })
      : [];
    const t2 = new Map<string, number>();
    for (const t of tasks) {
      const limit = (t.verifyT0Minutes ?? 0) + (t.verifyT1Minutes ?? 0) + (t.verifyT2Minutes ?? 0);
      t2.set(t.robotId, Math.min(t2.get(t.robotId) ?? Infinity, limit));
    }

    const granularity: Granularity = query.granularity === 'day' || query.granularity === 'week' || query.granularity === 'month' ? query.granularity : autoGranularity(period.days);

    return {
      scope,
      allHistory,
      period: { from: dayKey(period.from), to: dayKey(period.to), days: period.days },
      previousPeriod: previous ? { from: dayKey(previous.from), to: dayKey(previous.to) } : null,
      summary: { current: summarize(current, classify), previous: previous ? summarize(before, classify) : null },
      robots: robotRows
        .map((row) => ({ ...row, name: names.get(row.robotId)?.name ?? 'Robô removido', slug: names.get(row.robotId)?.slug ?? '', active: names.get(row.robotId)?.isActive ?? false }))
        .sort((a, b) => b.executions - a.executions || a.name.localeCompare(b.name, 'pt-BR')),
      categories: { granularity, buckets: categorySeries(current, period.from, period.to, granularity, classify) },
      evolution: evolutionSeries(current, period.from, period.to, granularity, classify),
      // "Execuções por dia" é sempre por dia (períodos longos rolam para os lados na tela).
      daily: evolutionSeries(current, period.from, period.to, 'day', classify),
      mini: { granularity: miniGran, buckets: miniSeries(current, period.from, period.to, miniGran, classify) },
      durations: durationSeries(current, topRobots.map((r) => r.robotId), period.from, period.to, granularity).map((d) => ({
        ...d,
        name: names.get(d.robotId)?.name ?? 'Robô removido',
        executions: topRobots.find((r) => r.robotId === d.robotId)?.durationSamples ?? 0,
        t2Minutes: t2.get(d.robotId) ?? null,
      })),
      heatmap: {
        granularity: heat.granularity,
        buckets: heat.buckets,
        rows: heat.rows.map((row) => ({ ...row, name: names.get(row.robotId)?.name ?? 'Robô removido' })),
      },
      causes: topCauses(current, classify).map((c) => ({ ...c, robotList: c.robotList.map((r) => ({ ...r, name: names.get(r.robotId)?.name ?? 'Robô removido' })) })),
      categoryInfo: ERROR_CATEGORIES.map((key) => ({ key, ...CATEGORY_INFO[key] })),
    };
  }
}
