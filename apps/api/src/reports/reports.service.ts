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
