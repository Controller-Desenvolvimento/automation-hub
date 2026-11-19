import { Injectable } from '@nestjs/common';
import { ExecutionStatus, Prisma, type User } from '@prisma/client';
import {
  buildExecutionScope,
  canAccessExecution,
  canAccessRobot,
} from '../shared/access';
import { PrismaService } from '../prisma/prisma.service';
import {
  REPORT_TIME_ZONE,
  addDays,
  autoGranularity,
  buildBuckets,
  calendarDaysBetween,
  computeRunRate,
  countBusinessDays,
  dayEnd,
  dayStart,
  deltaBetween,
  isDayString,
  median,
  outlierThreshold,
  previousRangeOf,
  readTimeSavingsConfig,
  toReportDay,
  type DayRange,
  type Granularity,
  type SeriesPoint,
  type TimeSavingsConfig,
} from './time-savings-metrics';
import { metricsByExecution, summarizeMetricLogs } from './robots-without-gain';
import { MAX_SIM_SECONDS, peopleOf, simInsights, simulate, simulateMonthly, type SimBase, type SimExecution, type SimInput, type SimRobot, type SimScope } from './time-savings-simulator';

const EXTERNAL_SOURCE_PREFIX = 'ext:';
const PAGE_SIZE = 1000;
const EXTERNAL_USER_FILTER_PREFIX = 'external:';
const UNKNOWN_DEPARTMENT = 'outros';
const OUTLIER_TOP_LIMIT = 5;
const ROBOTS_WITHOUT_RATE_LIMIT = 10;
const DETAILS_MAX_PAGE_SIZE = 200;

export type ReportOriginFilter = 'hub' | 'external';
// hub = robô rodado pelo hub; external = robô externo que reporta o tempo via
// API (valor informado pelo próprio sistema); external_metric = tabela legada
// ExternalMetric.
export type ReportOrigin = 'hub' | 'external' | 'external_metric';

type QueryInput = {
  from?: string;
  to?: string;
  robotId?: string;
  userIds?: string[];
  department?: string;
  origin?: ReportOriginFilter;
  granularity?: Granularity;
};

export type ExecutionsSortField = 'at' | 'robot' | 'user' | 'department' | 'units' | 'saved';

export type ExecutionsQueryInput = QueryInput & {
  search?: string;
  includeZero?: boolean;
  outliersOnly?: boolean;
  sort?: ExecutionsSortField;
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
};

type CreditTarget = {
  // null = crédito só do departamento (sem pessoa).
  userKey: string | null;
  userName: string;
  department: string;
  share: number;
};

type ReportEntry = {
  id: string;
  at: Date;
  // Dia civil no fuso do relatório — única fonte de verdade para período e
  // tendência.
  day: string;
  robotId: string;
  robotName: string;
  userId: string | null;
  userName: string;
  // Departamento de quem executou (null = desconhecido).
  department: string | null;
  unitsProcessed: number;
  unitsMissing: boolean;
  // Robô do hub com ganho > 0 e sem unidade medida: o ganho foi calculado
  // assumindo 1 unidade.
  unitsAssumed: boolean;
  unitLabel: string;
  savedSeconds: number;
  origin: ReportOrigin;
  // Robô do hub cuja taxa "tempo manual por unidade" está em 0.
  hubRobotWithoutRate: boolean;
  credits: CreditTarget[];
};

type Loaded = {
  config: TimeSavingsConfig;
  today: string;
  range: DayRange | null;
  previousRange: DayRange | null;
  period: ReportEntry[];
  previous: ReportEntry[];
  runRateWindowEntries: ReportEntry[];
  firstDataDay: string | null;
};

// Departamento de uma pessoa para fins de relatório.
//
// LIMITAÇÃO CONHECIDA: o schema não tem "departamento principal". Usuários com
// vários departamentos são sempre atribuídos ao PRIMEIRO item de
// User.departments, e a ordem desse array não é garantida. Toda atribuição de
// departamento do relatório passa por aqui; quando existir um
// User.primaryDepartment, a troca é só nesta função.
export function resolveDepartment(sources: {
  user?: { departments?: string[] | null } | null;
  externalIdentity?: { department?: string | null } | null;
  fallback?: string | null;
}): string | null {
  return (
    sources.user?.departments?.[0] ??
    sources.externalIdentity?.department ??
    sources.fallback ??
    null
  );
}

@Injectable()
export class ReportsService {
  // Relógio injetável (os testes fixam a data).
  clock: () => Date = () => new Date();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Aba "Robôs sem ganho": robôs ativos do Hub com tempo manual 0 (toda execução deles soma 0 h no relatório), com o uso no período
   * (`from`/`to` em AAAA-MM-DD; sem datas = todo o histórico) e as métricas que o robô já informa (lidas dos logs, que a retenção
   * apaga depois de EXECUTION_RETENTION_DAYS). Só administradores (a rota confere). Robôs externos ficam de fora: o sistema deles
   * informa o tempo de cada execução.
   */
  async listRobotsWithoutGain(query: { from?: string; to?: string; all?: boolean }) {
    const from = query.from && isDayString(query.from) ? query.from : null;
    const to = query.to && isDayString(query.to) ? query.to : null;
    const finishedAt: Prisma.DateTimeFilter = {};
    if (from) finishedAt.gte = dayStart(from);
    if (to) finishedAt.lte = dayEnd(to);
    const inPeriod: Prisma.ExecutionWhereInput = Object.keys(finishedAt).length ? { finishedAt } : { finishedAt: { not: null } };

    const robots = await this.prisma.robot.findMany({
      where: { isActive: true, isExternal: false, ...(query.all ? {} : { manualSecondsPerUnit: 0 }) },
      select: { id: true, name: true, slug: true, category: true, allowedDepartments: true, unitLabel: true, unitMetricKey: true, manualSecondsPerUnit: true },
      orderBy: { name: 'asc' },
    });
    const ids = robots.map((r) => r.id);
    if (ids.length === 0) return { range: from || to ? { from, to } : null, robots: [], others: [] };

    const success: Prisma.ExecutionWhereInput = { robotId: { in: ids }, status: ExecutionStatus.success, ...inPeriod };
    const [counts, scheduledCounts, withUnits, lastRuns, logs] = await Promise.all([
      this.prisma.execution.groupBy({ by: ['robotId'], where: success, _count: { _all: true } }),
      this.prisma.execution.groupBy({ by: ['robotId'], where: { ...success, scheduledTaskId: { not: null } }, _count: { _all: true } }),
      this.prisma.execution.groupBy({ by: ['robotId'], where: { ...success, unitsProcessed: { not: null } }, _count: { _all: true }, _sum: { unitsProcessed: true } }),
      this.prisma.execution.groupBy({ by: ['robotId'], where: { robotId: { in: ids } }, _max: { createdAt: true } }),
      this.prisma.executionLog.findMany({
        where: { message: { startsWith: 'Metrica registrada: ' }, execution: success },
        select: { executionId: true, message: true, execution: { select: { robotId: true } } },
        take: 200_000,
      }),
    ]);
    const countBy = new Map(counts.map((c) => [c.robotId, c._count._all]));
    const scheduledBy = new Map(scheduledCounts.map((c) => [c.robotId, c._count._all]));
    const unitsBy = new Map(withUnits.map((c) => [c.robotId, { executions: c._count._all, total: c._sum.unitsProcessed ?? 0 }]));
    const lastBy = new Map(lastRuns.map((c) => [c.robotId, c._max.createdAt]));
    const logsBy = new Map<string, Array<{ executionId: string; message: string }>>();
    for (const row of logs) {
      const list = logsBy.get(row.execution.robotId) ?? [];
      list.push({ executionId: row.executionId, message: row.message });
      logsBy.set(row.execution.robotId, list);
    }

    // Execuções do período com ganho 0 de robôs que JÁ têm tempo manual: ou o robô informou 0 itens (esperado) ou a execução foi
    // gravada antes de o robô ter tempo.
    const withTimeIds = (await this.prisma.robot.findMany({ where: { isActive: true, isExternal: false, manualSecondsPerUnit: { gt: 0 } }, select: { id: true, name: true } }));
    const zeroGain: Prisma.ExecutionWhereInput = { robotId: { in: withTimeIds.map((r) => r.id) }, status: ExecutionStatus.success, ...inPeriod, manualEstimatedSeconds: 0 };
    const [zeroAll, zeroItems] = withTimeIds.length
      ? await Promise.all([
          this.prisma.execution.groupBy({ by: ['robotId'], where: zeroGain, _count: { _all: true } }),
          this.prisma.execution.groupBy({ by: ['robotId'], where: { ...zeroGain, unitsProcessed: 0 }, _count: { _all: true } }),
        ])
      : [[], []];
    const zeroItemsBy = new Map(zeroItems.map((c) => [c.robotId, c._count._all]));
    const others = zeroAll
      .map((c) => {
        const zero = zeroItemsBy.get(c.robotId) ?? 0;
        return { robotId: c.robotId, name: withTimeIds.find((r) => r.id === c.robotId)?.name ?? 'Robô', zeroItems: zero, beforeTime: c._count._all - zero };
      })
      .sort((a, b) => b.zeroItems + b.beforeTime - (a.zeroItems + a.beforeTime));

    return {
      range: from || to ? { from, to } : null,
      others,
      robots: robots
        .map((robot) => ({
          robotId: robot.id,
          name: robot.name,
          slug: robot.slug,
          category: robot.category,
          departments: robot.allowedDepartments,
          unitLabel: robot.unitLabel || 'item',
          unitMetricKey: robot.unitMetricKey || 'itens_processados',
          /** Execuções com sucesso no período (todas entram no relatório com 0 h). */
          executions: countBy.get(robot.id) ?? 0,
          /** Dessas, quantas foram agendadas (o robô rodou sozinho). */
          scheduledExecutions: scheduledBy.get(robot.id) ?? 0,
          manualSecondsPerUnit: robot.manualSecondsPerUnit,
          lastExecutionAt: lastBy.get(robot.id) ?? null,
          /** Itens gravados nas execuções do período, quando o robô informou a métrica da chave atual. */
          recordedUnits: unitsBy.get(robot.id) ?? { executions: 0, total: 0 },
          metrics: summarizeMetricLogs(logsBy.get(robot.id) ?? []),
        }))
        .sort((a, b) => b.executions - a.executions || a.name.localeCompare(b.name, 'pt-BR')),
    };
  }

  /**
   * Simulador de ganhos: projeta as execuções REAIS do período para 1 mês com os tempos que a pessoa escolheu. Nada é gravado.
   * `times` = segundos por item (ou por execução) de cada robô; robô sem tempo informado não soma (ou mantém o atual, se já tem).
   * Robôs externos ficam de fora, a não ser que `includeExternal` esteja ligado (só no escopo "todos"): o sistema deles informa o
   * tempo de cada execução, então entram como robôs que já têm ganho (tempo atual; dá para simular outro tempo por execução ou item).
   * Só administradores (a rota confere).
   */
  async simulateGains(
    user: User,
    input: {
      from?: string;
      to?: string;
      scope?: string;
      base?: string;
      times?: Record<string, unknown>;
      excluded?: unknown;
      workdayHours?: unknown;
      /** Só as linhas por robô (para montar a tabela do formulário), sem relatório, evolução mensal nem frases. */
      light?: boolean;
      unit?: string;
      defaultIds?: unknown;
      includeExternal?: boolean;
    },
  ) {
    const from = input.from && isDayString(input.from) ? input.from : null;
    const to = input.to && isDayString(input.to) ? input.to : null;
    const scope: SimScope = input.scope === 'todos' ? 'todos' : 'sem';
    const base: SimBase = input.base === 'item' ? 'item' : 'exec';
    const hours = Number(input.workdayHours);
    const workdayHours = Number.isFinite(hours) && hours >= 1 && hours <= 24 ? hours : 7;
    const times: Record<string, number> = {};
    for (const [id, value] of Object.entries(input.times ?? {})) {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 0) times[id] = Math.min(MAX_SIM_SECONDS, Math.round(seconds));
    }
    const excluded = new Set(Array.isArray(input.excluded) ? input.excluded.filter((x): x is string => typeof x === 'string') : []);

    // Robôs externos só entram se a pessoa pediu e no escopo "todos" (eles nunca estão "sem ganho": informam o próprio tempo).
    const withExternal = scope === 'todos' && input.includeExternal === true;
    const robotRows = await this.prisma.robot.findMany({
      where: withExternal ? { isActive: true } : { isActive: true, isExternal: false, ...(scope === 'sem' ? { manualSecondsPerUnit: 0 } : {}) },
      select: { id: true, name: true, manualSecondsPerUnit: true, isExternal: true },
      orderBy: { name: 'asc' },
    });
    const robots = robotRows.filter((r) => !excluded.has(r.id));
    const ids = robots.map((r) => r.id);

    const now = this.clock();
    const nowDay = toReportDay(now);
    // 12 meses contando o corrente: começa no dia 1 do mês de 11 meses atrás (conta em UTC para não depender do fuso do servidor)
    const first = new Date(Date.UTC(Number(nowDay.slice(0, 4)), Number(nowDay.slice(5, 7)) - 1 - 11, 1));
    const windowStartDay = `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, '0')}-01`;
    const windowStart = dayStart(windowStartDay).getTime();
    const periodFrom = from ? dayStart(from).getTime() : null;
    const periodTo = to ? dayEnd(to).getTime() : Infinity;
    // Carrega do mais antigo entre o período e a janela dos 12 meses; o resto é separado em memória.
    const loadFrom = periodFrom === null ? null : input.light === true ? periodFrom : Math.min(periodFrom, windowStart);
    const success: Prisma.ExecutionWhereInput = {
      robotId: { in: ids },
      status: ExecutionStatus.success,
      finishedAt: loadFrom === null ? { not: null } : { gte: new Date(loadFrom) },
    };
    const withoutTimeIds = robots.filter((r) => !r.isExternal && r.manualSecondsPerUnit === 0).map((r) => r.id);
    const executions = ids.length
      ? await this.prisma.execution.findMany({
          where: success,
          select: { id: true, robotId: true, finishedAt: true, unitsProcessed: true, manualEstimatedSeconds: true, scheduledTaskId: true },
          take: 300_000,
        })
      : [];
    const firsts = ids.length
      ? await this.prisma.execution.groupBy({ by: ['robotId'], where: { robotId: { in: ids }, status: ExecutionStatus.success, finishedAt: { not: null } }, _min: { finishedAt: true } })
      : [];
    const logs =
      base === 'item' && withoutTimeIds.length
        ? await this.prisma.executionLog.findMany({
            where: { message: { startsWith: 'Metrica registrada: ' }, execution: { ...success, robotId: { in: withoutTimeIds } } },
            select: { executionId: true, message: true, execution: { select: { robotId: true } } },
            take: 300_000,
          })
        : [];
    const light = input.light === true;
    const report = light ? null : await this.getTimeSavingsReport(user, { from: from ?? undefined, to: to ?? undefined });
    const monthlyReport = light ? null : await this.getTimeSavingsReport(user, { from: windowStartDay, granularity: 'month' });

    const firstBy = new Map(firsts.map((f) => [f.robotId, f._min.finishedAt?.getTime() ?? null]));
    const logsBy = new Map<string, Array<{ executionId: string; message: string }>>();
    for (const row of logs) {
      const list = logsBy.get(row.execution.robotId) ?? [];
      list.push({ executionId: row.executionId, message: row.message });
      logsBy.set(row.execution.robotId, list);
    }
    const execBy = new Map<string, typeof executions>();
    for (const e of executions) execBy.set(e.robotId, [...(execBy.get(e.robotId) ?? []), e]);

    const buildRobots = (keep: (finishedAt: number) => boolean): SimRobot[] =>
      robots.map((robot) => {
        // Externo: o ganho vem gravado em cada execução, pelo sistema dele; conta como "já tem ganho" mesmo com tempo manual 0.
        const hasTime = robot.isExternal || robot.manualSecondsPerUnit > 0;
        const rows = logsBy.get(robot.id) ?? [];
        // Sem tempo configurado, "item" = a métrica que o robô mais informa (a mesma que a janela Configurar sugere).
        const key = hasTime ? null : summarizeMetricLogs(rows)[0]?.key ?? null;
        const perExecution = hasTime || !key ? null : metricsByExecution(rows);
        // média por execução da métrica nas execuções do período que a informaram (para a tela)
        const inPeriod = (execBy.get(robot.id) ?? []).filter((e) => keep(e.finishedAt!.getTime()));
        const known = key && perExecution ? inPeriod.map((e) => perExecution.get(e.id)?.get(key)).filter((v): v is number => typeof v === 'number') : [];
        return {
          robotId: robot.id,
          name: robot.name,
          hasTime,
          external: robot.isExternal,
          firstAt: firstBy.get(robot.id) ?? null,
          fallbackAvgItems: null,
          metricKey: key,
          metricAvg: known.length ? known.reduce((a, v) => a + v, 0) / known.length : null,
          executions: (execBy.get(robot.id) ?? [])
            .filter((e) => keep(e.finishedAt!.getTime()))
            .map(
              (e): SimExecution => ({
                finishedAt: e.finishedAt!.getTime(),
                scheduled: e.scheduledTaskId !== null,
                storedGain: e.manualEstimatedSeconds ?? robot.manualSecondsPerUnit * Math.max(0, e.unitsProcessed ?? 1),
                // externo que não informou a quantidade (ou informou 0) conta 1 por execução: o ganho dele já veio gravado
                units: robot.isExternal ? (e.unitsProcessed && e.unitsProcessed > 0 ? e.unitsProcessed : null) : hasTime ? e.unitsProcessed : key ? perExecution?.get(e.id)?.get(key) ?? null : null,
              }),
            ),
        };
      });
    const simRobots = buildRobots((t) => (periodFrom === null || t >= periodFrom) && t <= periodTo);
    const windowRobots = light ? [] : buildRobots((t) => t >= windowStart);

    const simInput: SimInput = {
      robots: simRobots,
      base,
      times,
      workdayHours,
      from: from ? dayStart(from).getTime() : null,
      to: to ? dayStart(to).getTime() : null,
      now: now.getTime(),
      reportSavedSeconds: report?.totals.savedSeconds ?? 0,
    };
    const main = simulate(simInput, 1);
    if (light) return { rows: main.rows, days: main.days, months: main.months };
    const low = simulate(simInput, 0.5);
    const high = simulate(simInput, 1.5);
    const people = (seconds: number) => peopleOf(seconds, workdayHours);

    // Evolução mensal: ganho do relatório (todos os robôs e fontes) + extra simulado, nos últimos 12 meses.
    const currentByMonth: Record<string, number> = {};
    let firstReportMonthAt: number | null = null;
    for (const bucket of monthlyReport?.series ?? []) {
      currentByMonth[bucket.key] = bucket.savedSeconds;
      if (bucket.savedSeconds > 0 && firstReportMonthAt === null) firstReportMonthAt = dayStart(bucket.from).getTime();
    }
    const firsts2 = [...firstBy.values(), firstReportMonthAt].filter((v): v is number => typeof v === 'number');
    const monthly = simulateMonthly({
      robots: windowRobots,
      base,
      times,
      workdayHours,
      now: now.getTime(),
      windowMonths: 12,
      currentByMonth,
      firstDataAt: firsts2.length ? Math.min(...firsts2) : null,
    });
    return {
      monthly,
      scope,
      base,
      workdayHours,
      range: from || to ? { from, to } : null,
      days: main.days,
      months: main.months,
      currentMonth: main.currentMonth,
      simulatedMonth: main.simulatedMonth,
      extraMonth: main.extra,
      extraYear: main.extra * 12,
      fromWithout: main.fromWithout,
      fromNewTimes: main.fromNewTimes,
      reportMonth: main.reportMonth,
      people: { extra: people(main.extra), total: people(main.reportMonth + main.extra), current: people(main.reportMonth) },
      band: {
        low: { extraMonth: low.extra, people: people(low.extra) },
        likely: { extraMonth: main.extra, people: people(main.extra) },
        high: { extraMonth: high.extra, people: people(high.extra) },
      },
      rows: main.rows.sort((a, b) => b.simulatedMonth - b.currentMonth - (a.simulatedMonth - a.currentMonth) || a.name.localeCompare(b.name, 'pt-BR')),
      insights: simInsights(main, {
        base,
        workdayHours,
        scope,
        unit: input.unit === 'seconds' || input.unit === 'hours' ? input.unit : 'minutes',
        defaultIds: Array.isArray(input.defaultIds) ? input.defaultIds.filter((x): x is string => typeof x === 'string') : [],
      }),
    };
  }

  async getTimeSavingsReport(user: User, query: QueryInput) {
    const loaded = await this.load(user, query);
    const { config, range, previousRange, period, previous } = loaded;

    const businessDays = range ? countBusinessDays(range.from, range.to) : null;
    const previousBusinessDays = previousRange
      ? countBusinessDays(previousRange.from, previousRange.to)
      : null;

    // O período anterior só serve de comparação se a base já existia durante
    // todo ele; senão o delta compara um período cheio com um parcial (ex.: +213.584%).
    const previousComparable =
      previousRange !== null &&
      loaded.firstDataDay !== null &&
      previousRange.from >= loaded.firstDataDay;

    const current = aggregate(period, businessDays, config);
    const previousAggregate = previousRange
      ? aggregate(previous, previousBusinessDays, config)
      : null;

    const withSavings = period.filter((entry) => entry.savedSeconds > 0);
    const threshold = outlierThreshold(
      withSavings.map((entry) => entry.savedSeconds),
      config,
    );
    const outlierEntries =
      threshold === null ? [] : withSavings.filter((entry) => entry.savedSeconds > threshold);

    const granularity =
      query.granularity ?? (range ? autoGranularity(range) : ('day' as Granularity));
    const series = range
      ? buildBuckets(
          range,
          granularity,
          toSeriesPoints(withSavings),
          previousRange
            ? {
                range: previousRange,
                points: toSeriesPoints(previous.filter((entry) => entry.savedSeconds > 0)),
              }
            : null,
        )
      : [];

    const windowEntries = loaded.runRateWindowEntries.filter((entry) => entry.savedSeconds > 0);
    const runRateCap = outlierThreshold(
      windowEntries.map((entry) => entry.savedSeconds),
      config,
    );
    const runRateResult = computeRunRate({
      today: loaded.today,
      firstDataDay: loaded.firstDataDay,
      entries: windowEntries,
      outlierCap: runRateCap,
      config,
    });

    const totalSaved = current.totals.savedSeconds;
    const share = (value: number) => (totalSaved > 0 ? (value / totalSaved) * 100 : 0);

    return {
      timezone: REPORT_TIME_ZONE,
      generatedAt: this.clock().toISOString(),
      config: {
        workdayHours: config.workdayHours,
        outlierPercentile: config.outlierPercentile,
        runRateWindowDays: config.runRateWindowDays,
        runRateMinSampleDays: config.runRateMinSampleDays,
      },
      range: range
        ? {
            ...range,
            days: calendarDaysBetween(range.from, range.to),
            businessDays: businessDays ?? 0,
          }
        : null,
      previousRange: previousRange
        ? {
            ...previousRange,
            days: calendarDaysBetween(previousRange.from, previousRange.to),
            businessDays: previousBusinessDays ?? 0,
            comparable: previousComparable,
          }
        : null,
      totals: current.totals,
      previousTotals: previousAggregate?.totals ?? null,
      deltas: previousAggregate && previousComparable
        ? {
            savedSeconds: deltaBetween(
              current.totals.savedSeconds,
              previousAggregate.totals.savedSeconds,
            ),
            executionsWithSavings: deltaBetween(
              current.totals.executionsWithSavings,
              previousAggregate.totals.executionsWithSavings,
            ),
            capacityFte:
              current.totals.capacityFte !== null
                ? deltaBetween(current.totals.capacityFte, previousAggregate.totals.capacityFte)
                : null,
            beneficiaries: deltaBetween(
              current.totals.beneficiaries,
              previousAggregate.totals.beneficiaries,
            ),
          }
        : null,
      concentration: {
        byRobot: concentrationOf(current.byRobot.map((row) => [row.robotName, row.savedSeconds]), totalSaved),
        byDepartment: concentrationOf(
          current.byDepartment.map((row) => [row.department, row.savedSeconds]),
          totalSaved,
        ),
      },
      byRobot: current.byRobot.map((row) => ({ ...row, sharePct: share(row.savedSeconds) })),
      byUser: current.byUser.map((row) => ({ ...row, sharePct: share(row.savedSeconds) })),
      byDepartment: current.byDepartment.map((row) => ({ ...row, sharePct: share(row.savedSeconds) })),
      granularity,
      autoGranularity: range ? autoGranularity(range) : ('day' as Granularity),
      series,
      runRate: runRateResult.runRate,
      runRateUnavailableReason: runRateResult.reason,
      outliers: {
        percentile: config.outlierPercentile,
        minSample: config.outlierMinSample,
        sampleSize: withSavings.length,
        threshold,
        count: outlierEntries.length,
        savedSeconds: outlierEntries.reduce((sum, entry) => sum + entry.savedSeconds, 0),
        sharePct: share(outlierEntries.reduce((sum, entry) => sum + entry.savedSeconds, 0)),
        top: [...outlierEntries]
          .sort((a, b) => b.savedSeconds - a.savedSeconds)
          .slice(0, OUTLIER_TOP_LIMIT)
          .map((entry) => ({
            id: entry.id,
            robotName: entry.robotName,
            userName: entry.userName,
            savedSeconds: entry.savedSeconds,
            sharePct: share(entry.savedSeconds),
            at: entry.at.toISOString(),
            origin: entry.origin,
          })),
      },
      quality: buildQuality(period, share),
    };
  }

  async getTimeSavingsExecutions(user: User, query: ExecutionsQueryInput) {
    const loaded = await this.load(user, query);
    const rows = this.filterAndSortExecutions(loaded, query);

    const pageSize = Math.min(DETAILS_MAX_PAGE_SIZE, Math.max(1, Math.floor(query.pageSize ?? 25)));
    const total = rows.items.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(totalPages, Math.max(1, Math.floor(query.page ?? 1)));
    const start = (page - 1) * pageSize;

    return {
      page,
      pageSize,
      total,
      totalPages,
      savedSeconds: rows.items.reduce((sum, item) => sum + item.savedSeconds, 0),
      outlierThreshold: rows.threshold,
      items: rows.items.slice(start, start + pageSize),
    };
  }

  // CSV com TODAS as linhas que casam com os filtros (sem paginação).
  async exportTimeSavingsExecutionsCsv(user: User, query: ExecutionsQueryInput) {
    const loaded = await this.load(user, query);
    const rows = this.filterAndSortExecutions(loaded, query);
    const departments = await this.prisma.departmentConfig.findMany({
      select: { slug: true, name: true },
    });
    const names = new Map(departments.map((department) => [department.slug, department.name]));

    return {
      range: loaded.range,
      csv: buildExecutionsCsv(rows.items, (slug) => names.get(slug) ?? slug),
    };
  }

  private filterAndSortExecutions(loaded: Loaded, query: ExecutionsQueryInput) {
    const withSavings = loaded.period.filter((entry) => entry.savedSeconds > 0);
    const threshold = outlierThreshold(
      withSavings.map((entry) => entry.savedSeconds),
      loaded.config,
    );

    let items = loaded.period.map((entry) => ({
      id: entry.id,
      at: entry.at.toISOString(),
      day: entry.day,
      robotId: entry.robotId,
      robotName: entry.robotName,
      userId: entry.userId,
      userName: entry.userName,
      department: entry.department ?? UNKNOWN_DEPARTMENT,
      unitsProcessed: entry.unitsProcessed,
      unitsMissing: entry.unitsMissing,
      unitsAssumed: entry.unitsAssumed,
      unitLabel: entry.unitLabel,
      savedSeconds: entry.savedSeconds,
      origin: entry.origin,
      isOutlier: threshold !== null && entry.savedSeconds > threshold,
    }));

    // Contexto "execuções com ganho": linhas zeradas só aparecem se o usuário
    // pedir explicitamente.
    if (!query.includeZero) {
      items = items.filter((item) => item.savedSeconds > 0);
    }
    if (query.outliersOnly) {
      items = items.filter((item) => item.isOutlier);
    }

    const search = normalizeSearch(query.search ?? '');
    if (search) {
      items = items.filter((item) =>
        normalizeSearch(
          `${item.robotName} ${item.userName} ${item.department} ${item.unitLabel}`,
        ).includes(search),
      );
    }

    const direction = query.dir === 'asc' ? 1 : -1;
    const sort = query.sort ?? 'at';
    const compare = (a: (typeof items)[number], b: (typeof items)[number]) => {
      switch (sort) {
        case 'robot':
          return a.robotName.localeCompare(b.robotName, 'pt-BR');
        case 'user':
          return a.userName.localeCompare(b.userName, 'pt-BR');
        case 'department':
          return a.department.localeCompare(b.department, 'pt-BR');
        case 'units':
          return a.unitsProcessed - b.unitsProcessed;
        case 'saved':
          return a.savedSeconds - b.savedSeconds;
        default:
          return a.at.localeCompare(b.at);
      }
    };
    items.sort((a, b) => compare(a, b) * direction || b.at.localeCompare(a.at) || a.id.localeCompare(b.id));

    return { items, threshold };
  }

  // Carrega UMA vez tudo que o relatório precisa — período atual, período
  // anterior e janela do ritmo anual — e separa em memória pelo dia civil no
  // fuso do relatório. As consultas ao banco usam a união das três faixas.
  private async load(user: User, query: QueryInput): Promise<Loaded> {
    const config = readTimeSavingsConfig();
    const today = toReportDay(this.clock());
    const fromDay = normalizeDay(query.from);
    const toDay = normalizeDay(query.to);

    // Dias futuros não entram no período (diluiriam médias e o período anterior).
    const effectiveTo = fromDay ? (toDay && toDay < today ? toDay : today) : null;
    const filteredRange: DayRange | null =
      fromDay && effectiveTo && fromDay <= effectiveTo ? { from: fromDay, to: effectiveTo } : null;
    const previousRange = filteredRange ? previousRangeOf(filteredRange) : null;

    const [creditTasks, allUsers, externalIdentities] = await Promise.all([
      this.prisma.scheduledTask.findMany({
        where: { creditMode: { not: 'creator' } },
        select: { id: true, creditMode: true, creditUserIds: true, creditDepartment: true },
      }),
      this.prisma.user.findMany({
        select: {
          id: true,
          name: true,
          email: true,
          athenasLogin: true,
          departments: true,
        },
      }),
      this.prisma.externalIdentity.findMany(),
    ]);
    const creditMap = new Map(creditTasks.map((task) => [task.id, task]));
    const userNameMap = new Map(allUsers.map((reportUser) => [reportUser.id, reportUser]));
    const externalLoginMap = new Map<string, (typeof allUsers)[number]>();
    const externalIdentityMap = new Map(
      externalIdentities.map((identity) => [identity.login, identity]),
    );
    for (const reportUser of allUsers) {
      if (reportUser.athenasLogin) {
        externalLoginMap.set(normalizeExternalIdentity(reportUser.athenasLogin), reportUser);
      }
      externalLoginMap.set(normalizeExternalIdentity(reportUser.email), reportUser);
    }

    const scope = buildExecutionScope(user);
    const baseFilters = (period?: Prisma.ExecutionWhereInput) => {
      // Cada filtro vira uma entrada independente dentro de um único AND, em
      // vez de espalhar objetos que podem repetir a chave OR (periodFilter, o
      // filtro de usuários e buildExecutionScope podem todos contribuir sua
      // própria OR) — um spread ingênuo faria a última sobrescrever as
      // anteriores em vez de combinar as condições.
      const conditions: Prisma.ExecutionWhereInput[] = [{ status: ExecutionStatus.success }];
      if (period) conditions.push(period);
      if (query.robotId) conditions.push({ robotId: query.robotId });
      if (query.userIds && query.userIds.length > 0) {
        conditions.push({
          OR: query.userIds.map((id) => buildUserFilter(id, userNameMap.get(id))),
        });
      }
      if (scope) conditions.push(scope);
      return { AND: conditions } satisfies Prisma.ExecutionWhereInput;
    };

    // Primeiro dia com dado visível para este escopo/filtros: define se a
    // janela do ritmo anual cobre menos de 90 dias de vida da base.
    const firstDataDay = await this.findFirstDataDay(user, query, baseFilters());

    const windowTo = addDays(today, -1);
    const windowFrom = firstDataDay
      ? maxDay(firstDataDay, addDays(windowTo, -(config.runRateWindowDays - 1)))
      : null;

    // Faixa carregada = união do período filtrado, do anterior e da janela do
    // ritmo anual. Sem `from`, não há limite inferior (histórico inteiro).
    const loadFrom = fromDay
      ? minDay([fromDay, previousRange?.from ?? null, windowFrom])
      : null;
    const loadTo = toDay ? (windowFrom ? maxDay(toDay, windowTo) : toDay) : null;

    const dateFilter: Prisma.DateTimeFilter = {};
    if (loadFrom) dateFilter.gte = dayStart(loadFrom);
    if (loadTo) dateFilter.lte = dayEnd(loadTo);
    const periodFilter: Prisma.ExecutionWhereInput | undefined =
      Object.keys(dateFilter).length > 0
        ? {
            OR: [
              { finishedAt: dateFilter },
              { AND: [{ finishedAt: null }, { createdAt: dateFilter }] },
            ],
          }
        : undefined;
    const where = baseFilters(periodFilter);

    const entries: ReportEntry[] = [];

    let cursor: string | undefined;
    while (true) {
      const batch = await this.prisma.execution.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: PAGE_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: {
          id: true,
          createdAt: true,
          finishedAt: true,
          robotId: true,
          userId: true,
          scheduledTaskId: true,
          unitsProcessed: true,
          manualEstimatedSeconds: true,
          requestedByName: true,
          requestedByEmail: true,
          robot: {
            select: {
              name: true,
              unitLabel: true,
              manualSecondsPerUnit: true,
              allowedDepartments: true,
              allowedUserIds: true,
              isExternal: true,
            },
          },
          user: {
            select: {
              id: true,
              name: true,
              departments: true,
            },
          },
        },
      });

      if (batch.length === 0) {
        break;
      }

      for (const execution of batch) {
        if (!canAccessExecution(user, execution) || !canAccessRobot(user, execution.robot)) {
          continue;
        }

        const externalLogin = normalizeExternalIdentity(
          execution.requestedByEmail ?? execution.requestedByName ?? '',
        );
        const attributedUser = execution.user ?? externalLoginMap.get(externalLogin);
        const externalIdentity = externalIdentityMap.get(externalLogin);

        // Identidades "de teste" marcadas como ignoradas (ex: nomes usados só
        // pra testar integrações) não contam no relatório — só se aplica a
        // execuções sem usuário real vinculado, pra nunca esconder alguém de
        // verdade por coincidência de nome/login.
        if (!execution.userId && externalIdentity?.ignored) {
          continue;
        }

        const origin: ReportOrigin = execution.robot.isExternal ? 'external' : 'hub';
        if (query.origin === 'hub' && origin !== 'hub') continue;
        if (query.origin === 'external' && origin === 'hub') continue;

        // Filtro por setor usa o departamento de quem de fato rodou a automação
        // (mesma lógica do buildExecutionScope pra gestores) — não o crédito
        // atribuído, que pode ter sido redirecionado por um agendamento.
        const executingDepartment = resolveDepartment({ user: attributedUser, externalIdentity });
        if (query.department && executingDepartment !== query.department) {
          continue;
        }

        const unitsMissing = execution.unitsProcessed === null || execution.unitsProcessed === undefined;
        const units = resolveUnitsProcessed(execution.unitsProcessed);
        const savedSeconds =
          execution.manualEstimatedSeconds ?? calculateManualEstimatedSeconds(execution.robot, units);
        const at = execution.finishedAt ?? execution.createdAt;
        const userName =
          attributedUser?.name ||
          externalIdentity?.name ||
          execution.requestedByName ||
          execution.requestedByEmail ||
          'Usuário';
        const userId = execution.userId ?? attributedUser?.id ?? null;
        const reportUserId = userId ?? externalUserFilterId(externalLogin || userName);

        const credit = execution.scheduledTaskId ? creditMap.get(execution.scheduledTaskId) : null;
        let credits: CreditTarget[];
        if (credit?.creditMode === 'users' && credit.creditUserIds.length > 0) {
          const share = 1 / credit.creditUserIds.length;
          credits = [];
          for (const uid of credit.creditUserIds) {
            // Filtrar o relatório por um usuário não deve "vazar" outras
            // pessoas que dividem crédito com ele num agendamento — a query já
            // restringiu `where` a execuções desse usuário; aqui só evita que
            // o passo de atribuição de crédito adicione gente de fora disso.
            if (query.userIds && query.userIds.length > 0 && !query.userIds.includes(uid)) continue;
            const creditedUser = userNameMap.get(uid);
            credits.push({
              userKey: uid,
              userName: creditedUser?.name ?? 'Usuário',
              department: resolveDepartment({ user: creditedUser }) ?? UNKNOWN_DEPARTMENT,
              share,
            });
          }
        } else if (credit?.creditMode === 'department' && credit.creditDepartment) {
          credits = [{ userKey: null, userName: '', department: credit.creditDepartment, share: 1 }];
        } else {
          credits = [
            {
              userKey: reportUserId,
              userName,
              department: executingDepartment ?? UNKNOWN_DEPARTMENT,
              share: 1,
            },
          ];
        }

        entries.push({
          id: execution.id,
          at,
          day: toReportDay(at),
          robotId: execution.robotId,
          robotName: execution.robot.name,
          userId,
          userName,
          department: executingDepartment,
          unitsProcessed: units,
          unitsMissing,
          unitsAssumed: origin === 'hub' && unitsMissing && savedSeconds > 0,
          unitLabel: execution.robot.unitLabel || 'item',
          savedSeconds,
          origin,
          hubRobotWithoutRate: origin === 'hub' && (execution.robot.manualSecondsPerUnit ?? 0) === 0,
          credits,
        });
      }

      if (batch.length < PAGE_SIZE) {
        break;
      }
      cursor = batch[batch.length - 1].id;
    }

    // ── Métricas externas (ex: bi_dre_contabil) ────────────────────────────
    if (query.origin !== 'hub') {
      const externalMetrics = await this.prisma.externalMetric.findMany({
        where: buildExternalMetricWhere(
          user,
          loadFrom ? dayStart(loadFrom) : null,
          loadTo ? dayEnd(loadTo) : null,
        ),
        orderBy: { createdAt: 'desc' },
      });

      for (const em of externalMetrics) {
        const externalLogin = normalizeExternalIdentity(em.userEmail ?? em.userName ?? '');
        const attributedUser = externalLoginMap.get(externalLogin);
        const savedSeconds = em.manualEstimatedSeconds;
        const userName = attributedUser?.name || em.userName || em.userEmail || 'Usuário';
        const userId = attributedUser?.id ?? null;
        const robotId = EXTERNAL_SOURCE_PREFIX + em.source;

        // Ao contrário das execuções normais (filtradas via `where` na
        // consulta), métricas externas vêm de uma tabela separada sem filtro de
        // robotId/userId embutido — sem este corte manual, filtrar o relatório
        // por uma pessoa trazia TODAS as métricas externas de todo mundo junto.
        const reportUserId = userId ?? externalUserFilterId(externalLogin || userName);
        if (query.robotId && query.robotId !== robotId) continue;
        if (query.userIds && query.userIds.length > 0 && !query.userIds.includes(reportUserId)) continue;
        if (!attributedUser && externalIdentityMap.get(externalLogin)?.ignored) continue;

        const department = resolveDepartment({ user: attributedUser, fallback: em.department });
        if (query.department && (department ?? UNKNOWN_DEPARTMENT) !== query.department) continue;

        entries.push({
          id: em.id,
          at: em.createdAt,
          day: toReportDay(em.createdAt),
          robotId,
          robotName: em.sourceName || em.source,
          userId,
          userName,
          department,
          unitsProcessed: em.unitsProcessed,
          unitsMissing: false,
          unitsAssumed: false,
          unitLabel: em.unitLabel,
          savedSeconds,
          origin: 'external_metric',
          hubRobotWithoutRate: false,
          credits: [
            {
              userKey: reportUserId,
              userName,
              department: department ?? UNKNOWN_DEPARTMENT,
              share: 1,
            },
          ],
        });
      }
    }

    // ── Separação em memória pelo dia civil do relatório ───────────────────
    const inRange = (entry: ReportEntry, range: DayRange) =>
      entry.day >= range.from && entry.day <= range.to;

    let range = filteredRange;
    let period: ReportEntry[];
    if (fromDay) {
      period = range ? entries.filter((entry) => inRange(entry, range!)) : [];
    } else {
      // Sem data inicial: o período efetivo é o intervalo coberto pelos dados
      // (limitado a hoje), e não existe período anterior comparável.
      const upTo = toDay && toDay < today ? toDay : today;
      period = entries.filter((entry) => entry.day <= upTo);
      if (period.length > 0) {
        const days = period.map((entry) => entry.day).sort();
        range = { from: days[0], to: toDay ? upTo : days[days.length - 1] };
      }
    }

    const previous = previousRange
      ? entries.filter((entry) => inRange(entry, previousRange))
      : [];
    const runRateWindowEntries =
      windowFrom && windowFrom <= windowTo
        ? entries.filter((entry) => entry.day >= windowFrom && entry.day <= windowTo)
        : [];

    return {
      config,
      today,
      range,
      previousRange,
      period,
      previous,
      runRateWindowEntries,
      firstDataDay,
    };
  }

  private async findFirstDataDay(
    user: User,
    query: QueryInput,
    where: Prisma.ExecutionWhereInput,
  ): Promise<string | null> {
    const days: string[] = [];

    const first = await this.prisma.execution.findFirst({
      where,
      orderBy: [{ finishedAt: 'asc' }, { createdAt: 'asc' }],
      select: { finishedAt: true, createdAt: true },
    });
    if (first) days.push(toReportDay(first.finishedAt ?? first.createdAt));

    if (query.origin !== 'hub' && !query.robotId && !(query.userIds && query.userIds.length > 0)) {
      const firstMetric = await this.prisma.externalMetric.findFirst({
        where: buildExternalMetricWhere(user, null, null),
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      });
      if (firstMetric) days.push(toReportDay(firstMetric.createdAt));
    }

    return days.length > 0 ? days.sort()[0] : null;
  }
}

// ── Agregação ────────────────────────────────────────────────────────────────

type RowBase = { executions: number; savedSeconds: number };

function aggregate(entries: ReportEntry[], businessDays: number | null, config: TimeSavingsConfig) {
  const robotMap = new Map<string, RowBase & { robotId: string; robotName: string }>();
  const userMap = new Map<string, RowBase & { userId: string; userName: string }>();
  const departmentMap = new Map<string, RowBase & { department: string }>();

  let executions = 0;
  let unitsProcessed = 0;
  let savedSeconds = 0;
  const withSavings: number[] = [];

  for (const entry of entries) {
    executions += 1;
    unitsProcessed += entry.unitsProcessed;
    savedSeconds += entry.savedSeconds;

    // Uma execução só "gerou ganho" se savedSeconds > 0. Execuções zeradas
    // continuam contadas em `executions` (concluídas), mas não entram nos
    // rankings nem em "execuções/automações com ganho".
    if (entry.savedSeconds <= 0) continue;
    withSavings.push(entry.savedSeconds);

    bump(robotMap, entry.robotId, { robotId: entry.robotId, robotName: entry.robotName }, entry.savedSeconds);

    for (const credit of entry.credits) {
      const value = entry.savedSeconds * credit.share;
      if (credit.userKey !== null) {
        bump(userMap, credit.userKey, { userId: credit.userKey, userName: credit.userName }, value);
      }
      bump(departmentMap, credit.department, { department: credit.department }, value);
    }
  }

  const byDesc = <T extends { savedSeconds: number }>(rows: Map<string, T>) =>
    Array.from(rows.values()).sort((a, b) => b.savedSeconds - a.savedSeconds);

  const medianValue = median(withSavings);
  const workdaySeconds = config.workdayHours * 3600;

  return {
    totals: {
      executions,
      executionsWithSavings: withSavings.length,
      executionsWithoutSavings: executions - withSavings.length,
      automationsWithSavings: robotMap.size,
      beneficiaries: userMap.size,
      savedSeconds,
      unitsProcessed,
      medianSavedSeconds: medianValue === null ? null : Math.round(medianValue),
      averageSavedSeconds:
        withSavings.length > 0 ? Math.round(savedSeconds / withSavings.length) : null,
      // Capacidade liberada = tempo economizado ÷ (dias úteis do período × jornada).
      capacityFte:
        businessDays && businessDays > 0 ? savedSeconds / (businessDays * workdaySeconds) : null,
    },
    byRobot: byDesc(robotMap),
    byUser: byDesc(userMap),
    byDepartment: byDesc(departmentMap),
  };
}

function bump<T extends Record<string, unknown>>(
  map: Map<string, RowBase & T>,
  key: string,
  identity: T,
  savedSeconds: number,
) {
  const current = map.get(key) ?? ({ ...identity, executions: 0, savedSeconds: 0 } as RowBase & T);
  current.executions += 1;
  current.savedSeconds += savedSeconds;
  map.set(key, current);
}

function concentrationOf(rows: Array<[string, number]>, total: number) {
  const pct = (value: number) => (total > 0 ? (value / total) * 100 : 0);
  return {
    count: rows.length,
    top1Name: rows[0]?.[0] ?? null,
    top1Pct: rows[0] ? pct(rows[0][1]) : 0,
    top3Pct: pct(rows.slice(0, 3).reduce((sum, [, value]) => sum + value, 0)),
  };
}

function toSeriesPoints(entries: ReportEntry[]): SeriesPoint[] {
  const byDay = new Map<string, SeriesPoint>();
  for (const entry of entries) {
    const point = byDay.get(entry.day) ?? { day: entry.day, savedSeconds: 0, executions: 0 };
    point.savedSeconds += entry.savedSeconds;
    point.executions += 1;
    byDay.set(entry.day, point);
  }
  return Array.from(byDay.values());
}

function buildQuality(entries: ReportEntry[], share: (value: number) => number) {
  const completed = entries.length;
  const withSavings = entries.filter((entry) => entry.savedSeconds > 0);

  const withoutRate = new Map<string, { robotId: string; robotName: string; executions: number }>();
  for (const entry of entries) {
    if (!entry.hubRobotWithoutRate) continue;
    const row = withoutRate.get(entry.robotId) ?? {
      robotId: entry.robotId,
      robotName: entry.robotName,
      executions: 0,
    };
    row.executions += 1;
    withoutRate.set(entry.robotId, row);
  }

  const missingUnits = entries.filter((entry) => entry.unitsMissing).length;
  const assumed = entries.filter((entry) => entry.unitsAssumed);

  const origins = new Map<
    ReportOrigin,
    { origin: ReportOrigin; executions: number; executionsWithSavings: number; savedSeconds: number }
  >();
  for (const entry of entries) {
    const row = origins.get(entry.origin) ?? {
      origin: entry.origin,
      executions: 0,
      executionsWithSavings: 0,
      savedSeconds: 0,
    };
    row.executions += 1;
    if (entry.savedSeconds > 0) row.executionsWithSavings += 1;
    row.savedSeconds += entry.savedSeconds;
    origins.set(entry.origin, row);
  }

  return {
    completedExecutions: completed,
    executionsWithSavings: withSavings.length,
    executionsWithoutSavings: completed - withSavings.length,
    automationsWithoutRate: {
      count: withoutRate.size,
      items: Array.from(withoutRate.values())
        .sort((a, b) => b.executions - a.executions)
        .slice(0, ROBOTS_WITHOUT_RATE_LIMIT),
    },
    missingUnits: {
      count: missingUnits,
      pct: completed > 0 ? (missingUnits / completed) * 100 : 0,
    },
    // Regra documentada: robô do hub, ganho > 0 e unitsProcessed ausente — o
    // ganho foi calculado assumindo 1 unidade.
    assumedUnits: {
      count: assumed.length,
      savedSeconds: assumed.reduce((sum, entry) => sum + entry.savedSeconds, 0),
      sharePct: share(assumed.reduce((sum, entry) => sum + entry.savedSeconds, 0)),
    },
    byOrigin: Array.from(origins.values())
      .sort((a, b) => b.savedSeconds - a.savedSeconds)
      .map((row) => ({ ...row, sharePct: share(row.savedSeconds) })),
  };
}

// ── CSV ──────────────────────────────────────────────────────────────────────

const csvDateFormatter = new Intl.DateTimeFormat('pt-BR', {
  timeZone: REPORT_TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const ORIGIN_LABEL: Record<ReportOrigin, string> = {
  hub: 'Robô do hub',
  external: 'Integração externa',
  external_metric: 'Métrica externa (legado)',
};

function csvCell(value: string | number | boolean): string {
  let text =
    typeof value === 'number'
      ? value.toLocaleString('pt-BR', { maximumFractionDigits: 2 })
      : typeof value === 'boolean'
        ? value
          ? 'Sim'
          : 'Não'
        : value;
  // Impede que o Excel interprete o texto como fórmula (CSV injection).
  if (/^[=+\-@\t\r]/.test(text) && typeof value === 'string') text = `'${text}`;
  return /[;"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildExecutionsCsv(
  items: Array<{
    at: string;
    robotName: string;
    userName: string;
    department: string;
    unitsProcessed: number;
    unitsMissing: boolean;
    unitsAssumed: boolean;
    unitLabel: string;
    savedSeconds: number;
    origin: ReportOrigin;
    isOutlier: boolean;
  }>,
  departmentLabel: (slug: string) => string,
) {
  const header = [
    'Data',
    'Automação',
    'Pessoa',
    'Departamento',
    'Unidades',
    'Unidade',
    'Tempo economizado (min)',
    'Origem',
    'Unidades assumidas',
    'Outlier',
  ];
  const lines = [header.map(csvCell).join(';')];
  for (const item of items) {
    lines.push(
      [
        csvDateFormatter.format(new Date(item.at)),
        item.robotName,
        item.userName,
        departmentLabel(item.department),
        item.unitsMissing ? '' : item.unitsProcessed,
        item.unitLabel,
        Math.round((item.savedSeconds / 60) * 100) / 100,
        ORIGIN_LABEL[item.origin],
        item.unitsAssumed,
        item.isOutlier,
      ]
        .map(csvCell)
        .join(';'),
    );
  }
  // BOM + ';' como separador: o Excel pt-BR abre direto com acentos e colunas certas.
  return `﻿${lines.join('\r\n')}\r\n`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeDay(value: string | undefined): string | null {
  if (!value) return null;
  if (isDayString(value)) {
    return Number.isNaN(dayStart(value).getTime()) ? null : value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : toReportDay(parsed);
}

function minDay(values: Array<string | null>): string | null {
  const defined = values.filter((value): value is string => value !== null);
  return defined.length > 0 ? defined.sort()[0] : null;
}

function maxDay(a: string, b: string): string {
  return a > b ? a : b;
}

function normalizeSearch(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('pt-BR')
    .trim();
}

function calculateManualEstimatedSeconds(
  robot: {
    manualSecondsPerUnit: number;
  },
  unitsProcessed: number,
) {
  const unitSeconds = Math.max(0, robot.manualSecondsPerUnit || 0);
  const units = Math.max(0, unitsProcessed || 0);

  return unitSeconds * units;
}

function resolveUnitsProcessed(value: number | null) {
  if (value === null || value === undefined) {
    return 1;
  }

  return Math.max(0, value);
}

function externalUserFilterId(userName: string) {
  return `${EXTERNAL_USER_FILTER_PREFIX}${userName.trim().toLocaleLowerCase('pt-BR')}`;
}

function buildUserFilter(
  userFilterId: string,
  reportUser?: { athenasLogin: string | null; email: string },
): Prisma.ExecutionWhereInput {
  if (!userFilterId.startsWith(EXTERNAL_USER_FILTER_PREFIX)) {
    const externalAliases = [reportUser?.athenasLogin, reportUser?.email].filter(
      (value): value is string => Boolean(value),
    );

    if (externalAliases.length === 0) {
      return { userId: userFilterId };
    }

    return {
      AND: [
        {
          OR: [
            { userId: userFilterId },
            {
              AND: [
                { userId: null },
                {
                  OR: externalAliases.flatMap((alias) => [
                    { requestedByName: { equals: alias, mode: 'insensitive' as const } },
                    { requestedByEmail: { equals: alias, mode: 'insensitive' as const } },
                  ]),
                },
              ],
            },
          ],
        },
      ],
    };
  }

  const externalLogin = userFilterId.slice(EXTERNAL_USER_FILTER_PREFIX.length).trim();

  // Execucoes externas cujo login ainda nao corresponde a um usuario do hub
  // possuem userId nulo. O identificador virtual usado pelo relatorio permite
  // filtra-las pelo login que veio na API, sem consultar um userId inexistente.
  return {
    AND: [
      { userId: null },
      {
        OR: [
          { requestedByName: { equals: externalLogin, mode: 'insensitive' } },
          { requestedByEmail: { equals: externalLogin, mode: 'insensitive' } },
        ],
      },
    ],
  };
}

function normalizeExternalIdentity(value: string) {
  return value.trim().toLocaleLowerCase('pt-BR');
}

function buildExternalMetricWhere(
  user: User,
  fromDate: Date | null,
  toDate: Date | null,
): Prisma.ExternalMetricWhereInput {
  const dateFilter: Prisma.DateTimeFilter = {};
  if (fromDate) dateFilter.gte = fromDate;
  if (toDate) dateFilter.lte = toDate;
  const period = Object.keys(dateFilter).length > 0 ? { createdAt: dateFilter } : {};

  if (user.role === 'admin') {
    return period;
  }

  if (user.role === 'manager') {
    const depts = user.departments ?? [];
    return {
      ...period,
      OR: [
        ...(depts.length > 0 ? [{ department: { in: depts } }] : []),
        { userEmail: user.email },
      ],
    };
  }

  return { ...period, userEmail: user.email };
}
