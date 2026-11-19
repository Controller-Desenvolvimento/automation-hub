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
import { buildInsights } from './robot-health-insights';
import { capacityByHour, cyclesOf } from './robot-health-server';

export type HealthScope = 'all' | 'manual' | 'scheduled';

/** Quantos robôs o servidor roda ao mesmo tempo (o mesmo cálculo do ExecutionRunnerService). */
function runnerLimit() {
  const raw = Number(process.env.RUNNER_MAX_CONCURRENCY ?? 2);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2;
}

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
        attempt: true, restartOfId: true,
        // A mensagem diz a causa do erro e o motivo do cancelamento (T2, teto de tempo, agendamento pulado).
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
      errorMessage: r.status === 'error' || r.status === 'canceled' ? r.errorMessage : null,
      scheduledTaskId: r.scheduledTaskId,
      attempt: r.attempt,
      restartOfId: r.restartOfId,
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

    // Etapa 3. Capacidade do servidor e ciclos dos agendamentos olham o período inteiro, sem o filtro de origem (manual/agendada).
    const finished = await this.prisma.execution.findMany({
      where: { ...hubRobots, startedAt: { not: null, lte: period.to }, finishedAt: { gte: period.from } },
      select: { id: true, robotId: true, status: true, createdAt: true, startedAt: true, finishedAt: true, errorMessage: true },
    });
    const capacity = capacityByHour(
      finished.map((r) => ({ id: r.id, robotId: r.robotId, status: r.status as HealthExecution['status'], createdAt: r.createdAt, startedAt: r.startedAt, finishedAt: r.finishedAt, scheduled: false, errorMessage: r.status === 'error' ? r.errorMessage : null })),
      period.from, period.to, runnerLimit(), new Date(), classify,
    );
    const taskRows = await this.prisma.scheduledTask.findMany({
      where: { robot: { isExternal: false } },
      select: { id: true, name: true, robotId: true, isActive: true, verifyT0Minutes: true, verifyT1Minutes: true, verifyT2Minutes: true, robot: { select: { name: true } } },
    });
    const taskT2 = new Map<string, number>();
    for (const t of taskRows) {
      if (t.verifyT0Minutes !== null && t.verifyT1Minutes !== null && t.verifyT2Minutes !== null) taskT2.set(t.id, t.verifyT0Minutes + t.verifyT1Minutes + t.verifyT2Minutes);
    }
    const cycleRows = await this.prisma.execution.findMany({
      where: { ...hubRobots, status: { in: ['success', 'error', 'canceled', 'queued', 'running'] }, scheduledTaskId: { not: null }, createdAt: { gte: period.from, lte: new Date(period.to.getTime() + 86_400_000) } },
      select: { id: true, robotId: true, status: true, createdAt: true, scheduledTaskId: true, attempt: true, restartOfId: true },
    });
    const taskNames = new Map(taskRows.map((t) => [t.id, t]));
    const cycles = cyclesOf(
      taskRows.map((t) => ({ id: t.id, hasRestart: taskT2.has(t.id) })),
      cycleRows.map((r) => ({ id: r.id, robotId: r.robotId, createdAt: r.createdAt, status: r.status as 'success', scheduledTaskId: r.scheduledTaskId, attempt: r.attempt, restartOfId: r.restartOfId })),
      period.from, period.to,
    )
      .filter((c) => c.ok + c.recovered + c.failed + c.canceled + c.attempting > 0)
      .map((c) => ({ ...c, name: taskNames.get(c.taskId)?.name ?? 'Agendamento removido', robotName: taskNames.get(c.taskId)?.robot.name ?? '' }))
      .sort((a, b) => b.failed - a.failed || b.recovered - a.recovered || a.name.localeCompare(b.name, 'pt-BR'));

    const insights = buildInsights({
      current, previous: previous ? before : null, days: period.days, from: dayKey(period.from), to: dayKey(period.to),
      previousRange: previous ? { from: dayKey(previous.from), to: dayKey(previous.to) } : null,
      robotNames: new Map([...names].map(([id, r]) => [id, r.name])), capacity, cycles, taskT2,
    });

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
      capacity,
      cycles,
      insights,
    };
  }
}
