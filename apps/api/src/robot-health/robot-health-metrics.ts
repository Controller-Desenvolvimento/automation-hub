// Contas da tela "Saúde dos robôs". Só funções puras (sem banco): o serviço lê as execuções e chama estas funções.
//
// Regras (as mesmas do protótipo aprovado):
// - Só robôs que rodam NO Hub: os externos (só avisam que rodaram, sempre como sucesso) não entram em nenhuma conta.
// - "Concluídas" = sucessos + erros. Erros da categoria Hub (reinício do servidor) NÃO contam como erro do robô.
// - Taxa de sucesso = sucessos ÷ concluídas. Cancelada não é sucesso nem erro.
// - Situação: poucos dados (< 5 concluídas) | crítico (>= 40% de erro) | atenção (>= 15%) | saudável.
// - Duração: só de execuções com sucesso.
import { ERROR_CATEGORIES, classifyError, type ErrorCategory } from './error-causes';

export const MIN_CONCLUDED = 5;
export const CRITICAL_ERROR_RATE = 0.4;
export const ATTENTION_ERROR_RATE = 0.15;

export type HealthStatus = 'success' | 'error' | 'canceled';
export type Situation = 'healthy' | 'attention' | 'critical' | 'few';
export type Granularity = 'day' | 'week' | 'month';

export type HealthExecution = {
  id: string;
  robotId: string;
  status: HealthStatus;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  scheduled: boolean;
  errorMessage: string | null;
};

/** Quantil por interpolação linear (a lista precisa estar ordenada). */
export function quantile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export type Totals = {
  executions: number;
  success: number;
  /** Erros que contam contra o robô (sem os do Hub). */
  errors: number;
  hubErrors: number;
  canceled: number;
  concluded: number;
  successRate: number | null;
  errorRate: number | null;
  avgDurationSeconds: number | null;
  /** Duração típica (mediana) e dos 5% mais lentos (p95), só de sucessos. */
  medianDurationSeconds: number | null;
  p95DurationSeconds: number | null;
  /** Quantas execuções com sucesso entraram na duração. */
  durationSamples: number;
};

export function situationOf(concluded: number, errors: number): Situation {
  if (concluded < MIN_CONCLUDED) return 'few';
  const rate = errors / concluded;
  if (rate >= CRITICAL_ERROR_RATE) return 'critical';
  if (rate >= ATTENTION_ERROR_RATE) return 'attention';
  return 'healthy';
}

/** A categoria do erro de uma execução (classificada uma vez por mensagem). */
export function createClassifier() {
  const cache = new Map<string, ReturnType<typeof classifyError>>();
  return (message: string | null) => {
    const key = message ?? '';
    let cause = cache.get(key);
    if (!cause) {
      cause = classifyError(message);
      cache.set(key, cause);
    }
    return cause;
  };
}

export function summarize(list: HealthExecution[], classify = createClassifier()): Totals {
  let success = 0;
  let errors = 0;
  let hubErrors = 0;
  let canceled = 0;
  let durationSum = 0;
  let durationCount = 0;
  const durations: number[] = [];
  for (const e of list) {
    if (e.status === 'success') {
      success += 1;
      if (e.startedAt && e.finishedAt) {
        const seconds = (e.finishedAt.getTime() - e.startedAt.getTime()) / 1000;
        if (seconds > 0) {
          durationSum += seconds;
          durationCount += 1;
          durations.push(seconds);
        }
      }
    } else if (e.status === 'error') {
      if (classify(e.errorMessage).category === 'hub') hubErrors += 1;
      else errors += 1;
    } else {
      canceled += 1;
    }
  }
  const concluded = success + errors;
  return {
    executions: list.length,
    success,
    errors,
    hubErrors,
    canceled,
    concluded,
    successRate: concluded ? success / concluded : null,
    errorRate: concluded ? errors / concluded : null,
    avgDurationSeconds: durationCount ? durationSum / durationCount : null,
    medianDurationSeconds: quantile(durations.sort((a, b) => a - b), 0.5),
    p95DurationSeconds: quantile(durations, 0.95),
    durationSamples: durationCount,
  };
}

export type RobotHealthRow = Totals & {
  robotId: string;
  situation: Situation;
  lastRunAt: string;
  mainCause: { cause: string; category: ErrorCategory; count: number } | null;
  /** Última execução com sucesso (null se nenhuma no período). */
  lastSuccessAt: string | null;
  /** Taxa de sucesso por balde do minigráfico (null = nenhuma concluída no balde). */
  trend: Array<number | null>;
  /** Taxa de erro do período anterior (para ver se piorou ou melhorou); null sem dados suficientes. */
  previousErrorRate: number | null;
};

export function byRobot(current: HealthExecution[], previous: HealthExecution[], classify = createClassifier()): RobotHealthRow[] {
  const group = (list: HealthExecution[]) => {
    const map = new Map<string, HealthExecution[]>();
    for (const e of list) map.set(e.robotId, [...(map.get(e.robotId) ?? []), e]);
    return map;
  };
  const prevByRobot = group(previous);
  const rows: RobotHealthRow[] = [];
  for (const [robotId, list] of group(current)) {
    const totals = summarize(list, classify);
    const prev = summarize(prevByRobot.get(robotId) ?? [], classify);
    const causes = new Map<string, { cause: string; category: ErrorCategory; count: number }>();
    for (const e of list) {
      if (e.status !== 'error') continue;
      const c = classify(e.errorMessage);
      if (c.category === 'hub') continue;
      const entry = causes.get(c.cause) ?? { cause: c.cause, category: c.category, count: 0 };
      entry.count += 1;
      causes.set(c.cause, entry);
    }
    const main = [...causes.values()].sort((a, b) => b.count - a.count)[0] ?? null;
    rows.push({
      ...totals,
      robotId,
      situation: situationOf(totals.concluded, totals.errors),
      lastRunAt: new Date(Math.max(...list.map((e) => e.createdAt.getTime()))).toISOString(),
      lastSuccessAt: (() => {
        const wins = list.filter((e) => e.status === 'success').map((e) => e.createdAt.getTime());
        return wins.length ? new Date(Math.max(...wins)).toISOString() : null;
      })(),
      trend: [],
      mainCause: main,
      previousErrorRate: prev.concluded >= MIN_CONCLUDED ? prev.errorRate : null,
    });
  }
  return rows;
}

// ---------- erros por categoria ao longo do tempo ----------

const pad = (n: number) => String(n).padStart(2, '0');
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Início do balde (dia, semana de segunda a domingo, ou mês) em que a data cai, no fuso do servidor. */
export function bucketStart(date: Date, granularity: Granularity): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (granularity === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (granularity === 'month') d.setDate(1);
  return d;
}

function nextBucket(start: Date, granularity: Granularity): Date {
  const d = new Date(start);
  if (granularity === 'day') d.setDate(d.getDate() + 1);
  else if (granularity === 'week') d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1, 1);
  return d;
}

/** Dia, semana ou mês, conforme o tamanho do período (até 31 dias: dia; até 120: semana; mais: mês). */
export function autoGranularity(days: number): Granularity {
  return days <= 31 ? 'day' : days <= 120 ? 'week' : 'month';
}

export type CategoryBucket = { start: string; counts: Record<ErrorCategory, number>; total: number };

export function categorySeries(
  list: HealthExecution[],
  from: Date,
  to: Date,
  granularity: Granularity,
  classify = createClassifier(),
): CategoryBucket[] {
  const empty = () => Object.fromEntries(ERROR_CATEGORIES.map((c) => [c, 0])) as Record<ErrorCategory, number>;
  const buckets = new Map<string, CategoryBucket>();
  for (let cursor = bucketStart(from, granularity); cursor <= to; cursor = nextBucket(cursor, granularity)) {
    buckets.set(dayKey(cursor), { start: dayKey(cursor), counts: empty(), total: 0 });
  }
  for (const e of list) {
    if (e.status !== 'error') continue;
    const bucket = buckets.get(dayKey(bucketStart(e.createdAt, granularity)));
    if (!bucket) continue;
    bucket.counts[classify(e.errorMessage).category] += 1;
    bucket.total += 1;
  }
  return [...buckets.values()];
}

// ---------- evolução ao longo do tempo ----------

/** Chaves (início de cada dia, semana ou mês) de todos os baldes entre `from` e `to`, sem buracos. */
export function bucketKeys(from: Date, to: Date, granularity: Granularity): string[] {
  const keys: string[] = [];
  for (let cursor = bucketStart(from, granularity); cursor <= to; cursor = nextBucket(cursor, granularity)) keys.push(dayKey(cursor));
  return keys;
}

export type EvolutionBucket = {
  start: string;
  success: number;
  errors: number;
  hubErrors: number;
  canceled: number;
  concluded: number;
  successRate: number | null;
  avgDurationSeconds: number | null;
};

/** Resultado de cada dia/semana/mês: o mesmo que os indicadores, por balde. */
export function evolutionSeries(list: HealthExecution[], from: Date, to: Date, granularity: Granularity, classify = createClassifier()): EvolutionBucket[] {
  const groups = new Map<string, HealthExecution[]>();
  for (const key of bucketKeys(from, to, granularity)) groups.set(key, []);
  for (const e of list) groups.get(dayKey(bucketStart(e.createdAt, granularity)))?.push(e);
  return [...groups.entries()].map(([start, items]) => {
    const t = summarize(items, classify);
    return {
      start,
      success: t.success,
      errors: t.errors,
      hubErrors: t.hubErrors,
      canceled: t.canceled,
      concluded: t.concluded,
      successRate: t.successRate,
      avgDurationSeconds: t.avgDurationSeconds,
    };
  });
}

export type DurationPoint = { start: string; n: number; med: number | null; p95: number | null };

export const MIN_DURATION_SAMPLE = 3;

/** Duração típica (mediana) e dos 5% mais lentos por balde, para cada robô pedido (só sucessos; menos de 3 = sem ponto). */
export function durationSeries(
  list: HealthExecution[],
  robotIds: string[],
  from: Date,
  to: Date,
  granularity: Granularity,
): Array<{ robotId: string; points: DurationPoint[] }> {
  const keys = bucketKeys(from, to, granularity);
  return robotIds.map((robotId) => {
    const groups = new Map<string, number[]>(keys.map((k) => [k, []]));
    for (const e of list) {
      if (e.robotId !== robotId || e.status !== 'success' || !e.startedAt || !e.finishedAt) continue;
      const seconds = (e.finishedAt.getTime() - e.startedAt.getTime()) / 1000;
      if (seconds <= 0) continue;
      groups.get(dayKey(bucketStart(e.createdAt, granularity)))?.push(seconds);
    }
    return {
      robotId,
      points: keys.map((start) => {
        const values = (groups.get(start) ?? []).sort((x, y) => x - y);
        const enough = values.length >= MIN_DURATION_SAMPLE;
        return { start, n: values.length, med: enough ? quantile(values, 0.5) : null, p95: enough ? quantile(values, 0.95) : null };
      }),
    };
  });
}

// ---------- minigráficos (cartões e tendência por robô) ----------

/** Minigráficos: por dia até 14 dias, por semana até ~3 meses, por mês acima disso (nunca 1 ou 2 pontos, nem centenas). */
export function miniGranularity(days: number): Granularity {
  return days <= 14 ? 'day' : days <= 93 ? 'week' : 'month';
}

export type MiniBucket = {
  start: string;
  /** Execuções terminadas por dia (média do balde, para semana ou mês incompletos não parecerem queda). */
  executionsPerDay: number;
  /** Só com 3 concluídas ou mais. */
  successRate: number | null;
  medianDurationSeconds: number | null;
  errors: number;
};

export function miniSeries(list: HealthExecution[], from: Date, to: Date, granularity: Granularity, classify = createClassifier()): MiniBucket[] {
  const keys = bucketKeys(from, to, granularity);
  const groups = new Map<string, HealthExecution[]>(keys.map((k) => [k, []]));
  for (const e of list) groups.get(dayKey(bucketStart(e.createdAt, granularity)))?.push(e);
  const DAY = 24 * 60 * 60 * 1000;
  return keys.map((start) => {
    const items = groups.get(start) ?? [];
    const t = summarize(items, classify);
    // dias do balde que caem dentro do período
    const bucketFrom = new Date(start + 'T00:00:00');
    const bucketTo = nextBucket(bucketFrom, granularity);
    const a = Math.max(bucketFrom.getTime(), from.getTime());
    const b = Math.min(bucketTo.getTime() - 1, to.getTime());
    const days = Math.max(1, Math.round((b - a + 1) / DAY));
    return {
      start,
      executionsPerDay: t.executions / days,
      successRate: t.concluded >= 3 ? t.successRate : null,
      medianDurationSeconds: t.medianDurationSeconds,
      errors: t.errors,
    };
  });
}

/** Taxa de sucesso de um robô por balde (qualquer quantidade de concluídas; null = nenhuma). */
export function robotTrend(list: HealthExecution[], keys: string[], granularity: Granularity, classify = createClassifier()): Array<number | null> {
  const groups = new Map<string, HealthExecution[]>(keys.map((k) => [k, []]));
  for (const e of list) groups.get(dayKey(bucketStart(e.createdAt, granularity)))?.push(e);
  return keys.map((k) => summarize(groups.get(k) ?? [], classify).successRate);
}

// ---------- mapa robô × dia ----------

/** Dia até 62 dias de período, semana até 180, mês acima: o mapa continua legível. */
export function heatGranularity(days: number): Granularity {
  return days <= 62 ? 'day' : days <= 180 ? 'week' : 'month';
}

/** Uma célula: [sucessos, erros do robô, erros do Hub, canceladas]. */
export type HeatCell = [number, number, number, number];

export type HeatmapGrid = { granularity: Granularity; buckets: string[]; rows: Array<{ robotId: string; cells: HeatCell[] }> };

export function heatmapGrid(list: HealthExecution[], from: Date, to: Date, granularity: Granularity, classify = createClassifier()): HeatmapGrid {
  const buckets = bucketKeys(from, to, granularity);
  const index = new Map(buckets.map((k, i) => [k, i]));
  const rows = new Map<string, HeatCell[]>();
  for (const e of list) {
    const col = index.get(dayKey(bucketStart(e.createdAt, granularity)));
    if (col === undefined) continue;
    let cells = rows.get(e.robotId);
    if (!cells) {
      cells = buckets.map(() => [0, 0, 0, 0] as HeatCell);
      rows.set(e.robotId, cells);
    }
    if (e.status === 'success') cells[col][0] += 1;
    else if (e.status === 'canceled') cells[col][3] += 1;
    else if (classify(e.errorMessage).category === 'hub') cells[col][2] += 1;
    else cells[col][1] += 1;
  }
  return { granularity, buckets, rows: [...rows.entries()].map(([robotId, cells]) => ({ robotId, cells })) };
}

// ---------- principais causas ----------

export type CauseRobot = { robotId: string; count: number; lastAt: string };
export type CauseRow = { cause: string; category: ErrorCategory; description: string; count: number; robots: number; robotList: CauseRobot[]; lastAt: string };

export function topCauses(list: HealthExecution[], classify = createClassifier(), limit = 40): CauseRow[] {
  const map = new Map<string, { cause: string; category: ErrorCategory; description: string; count: number; robots: Map<string, { count: number; last: number }> }>();
  for (const e of list) {
    if (e.status !== 'error') continue;
    const c = classify(e.errorMessage);
    const entry = map.get(c.cause) ?? { cause: c.cause, category: c.category, description: c.description, count: 0, robots: new Map() };
    entry.count += 1;
    const r = entry.robots.get(e.robotId) ?? { count: 0, last: 0 };
    r.count += 1;
    r.last = Math.max(r.last, e.createdAt.getTime());
    entry.robots.set(e.robotId, r);
    map.set(c.cause, entry);
  }
  return [...map.values()]
    .map((entry) => {
      const robotList = [...entry.robots.entries()]
        .map(([robotId, r]) => ({ robotId, count: r.count, lastAt: new Date(r.last).toISOString() }))
        .sort((a, b) => b.count - a.count);
      return {
        cause: entry.cause,
        category: entry.category,
        description: entry.description,
        count: entry.count,
        robots: robotList.length,
        robotList,
        lastAt: robotList.reduce((m, r) => (r.lastAt > m ? r.lastAt : m), ''),
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

// ---------- período ----------

export type Period = { from: Date; to: Date; days: number };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Interpreta "AAAA-MM-DD" como dia local; devolve null se for inválido. */
export function parseDay(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null;
}

/**
 * Período pedido (dias inteiros, do início de `from` ao fim de `to`). Sem datas: os últimos 30 dias até hoje.
 * `to` antes de `from` é trocado; futuro é cortado em hoje; no máximo ~5 anos.
 */
export function resolvePeriod(fromRaw: unknown, toRaw: unknown, now = new Date()): Period {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let to = parseDay(toRaw) ?? today;
  let from = parseDay(fromRaw) ?? new Date(to.getFullYear(), to.getMonth(), to.getDate() - 29);
  if (to > today) to = today;
  if (from > to) [from, to] = [to, from];
  const days = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
  if (days > 1830) from = new Date(to.getFullYear(), to.getMonth(), to.getDate() - 1829);
  return { from, to: new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59, 999), days: Math.min(days, 1830) };
}

/** O período imediatamente anterior, com o mesmo número de dias. */
export function previousPeriod(period: Period): Period {
  const from = new Date(period.from.getFullYear(), period.from.getMonth(), period.from.getDate() - period.days);
  const to = new Date(period.from.getFullYear(), period.from.getMonth(), period.from.getDate() - 1, 23, 59, 59, 999);
  return { from, to, days: period.days };
}
