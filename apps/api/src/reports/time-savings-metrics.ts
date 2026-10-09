// Funções puras do relatório de "Tempo ganho". Ficam separadas do service para
// que as regras (fuso, outliers, ritmo anual, buckets) sejam testáveis sem
// banco e para que o frontend nunca precise reimplementar nenhuma fórmula.

export const REPORT_TIME_ZONE = 'America/Fortaleza';
// Equivalente fixo de REPORT_TIME_ZONE (UTC-3, sem horário de verão) usado para
// montar os limites de início/fim de dia nas consultas ao banco.
export const REPORT_TIME_ZONE_OFFSET = '-03:00';

const DAY_MS = 24 * 60 * 60 * 1000;

export type Granularity = 'day' | 'week' | 'month';

export type TimeSavingsConfig = {
  workdayHours: number;
  outlierPercentile: number;
  outlierMinSample: number;
  outlierMinMultipleOfMedian: number;
  runRateWindowDays: number;
  runRateMinSampleDays: number;
  runRateMinActiveDays: number;
};

function envNumber(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

// Lido a cada relatório (barato) para permitir ajuste via .env sem recompilar.
export function readTimeSavingsConfig(): TimeSavingsConfig {
  return {
    workdayHours: envNumber('TIME_SAVINGS_WORKDAY_HOURS', 7, 1, 24),
    // Percentil (0–100) acima do qual uma execução é candidata a outlier.
    outlierPercentile: envNumber('TIME_SAVINGS_OUTLIER_PERCENTILE', 99, 50, 100),
    // Amostras menores que isso não geram outliers: P99 de 10 itens sempre
    // aponta o maior, o que seria ruído e não anomalia.
    outlierMinSample: envNumber('TIME_SAVINGS_OUTLIER_MIN_SAMPLE', 20, 2, 10_000),
    // Além de passar do percentil, o valor precisa ser N vezes a mediana.
    outlierMinMultipleOfMedian: envNumber('TIME_SAVINGS_OUTLIER_MIN_MULTIPLE', 5, 1, 1_000),
    runRateWindowDays: envNumber('TIME_SAVINGS_RUN_RATE_WINDOW_DAYS', 90, 14, 365),
    runRateMinSampleDays: envNumber('TIME_SAVINGS_RUN_RATE_MIN_DAYS', 28, 7, 365),
    runRateMinActiveDays: envNumber('TIME_SAVINGS_RUN_RATE_MIN_ACTIVE_DAYS', 10, 1, 365),
  };
}

// ── Datas (strings YYYY-MM-DD no fuso do relatório) ─────────────────────────

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: REPORT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// Dia civil (YYYY-MM-DD) de um instante no fuso do relatório. Nunca usar
// toISOString().slice(0, 10): isso devolve o dia em UTC, e uma execução às 22h
// de Fortaleza cairia no dia seguinte.
export function toReportDay(date: Date): string {
  return dayFormatter.format(date);
}

export function isDayString(value: string | undefined | null): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseDay(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function formatDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  return formatDay(parseDay(day) + days * DAY_MS);
}

export function calendarDaysBetween(from: string, to: string): number {
  return Math.round((parseDay(to) - parseDay(from)) / DAY_MS) + 1;
}

// Segunda a sexta, sem descontar feriados.
export function countBusinessDays(from: string, to: string): number {
  if (from > to) return 0;
  let count = 0;
  for (let t = parseDay(from), end = parseDay(to); t <= end; t += DAY_MS) {
    const weekday = new Date(t).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}

export function isWeekend(day: string): boolean {
  const weekday = new Date(parseDay(day)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

export function dayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000${REPORT_TIME_ZONE_OFFSET}`);
}

export function dayEnd(day: string): Date {
  return new Date(`${day}T23:59:59.999${REPORT_TIME_ZONE_OFFSET}`);
}

export type DayRange = { from: string; to: string };

// Período imediatamente anterior, com o mesmo número de dias corridos.
export function previousRangeOf(range: DayRange): DayRange {
  const length = calendarDaysBetween(range.from, range.to);
  return { from: addDays(range.from, -length), to: addDays(range.from, -1) };
}

export function autoGranularity(range: DayRange): Granularity {
  const days = calendarDaysBetween(range.from, range.to);
  if (days <= 45) return 'day';
  if (days <= 200) return 'week';
  return 'month';
}

// ── Estatística ─────────────────────────────────────────────────────────────

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Percentil com interpolação linear; `p` em 0–100.
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}

// Limite acima do qual uma execução com ganho é considerada outlier, ou null
// quando não há amostra suficiente. O outlier continua somando nos totais — a
// regra só serve para sinalizar.
export function outlierThreshold(
  savedSecondsWithSavings: number[],
  config: Pick<TimeSavingsConfig, 'outlierPercentile' | 'outlierMinSample' | 'outlierMinMultipleOfMedian'>,
): number | null {
  if (savedSecondsWithSavings.length < config.outlierMinSample) return null;
  const p = percentile(savedSecondsWithSavings, config.outlierPercentile);
  const med = median(savedSecondsWithSavings);
  if (p === null || med === null) return null;
  return Math.max(p, med * config.outlierMinMultipleOfMedian);
}

export type Delta = { previous: number; pct: number | null; direction: 'up' | 'down' | 'flat' | 'new' };

export function deltaBetween(current: number, previous: number | null): Delta | null {
  if (previous === null) return null;
  if (previous === 0) return current > 0 ? { previous, pct: null, direction: 'new' } : null;
  const pct = ((current - previous) / previous) * 100;
  if (Math.abs(pct) < 0.5) return { previous, pct: 0, direction: 'flat' };
  return { previous, pct, direction: pct > 0 ? 'up' : 'down' };
}

// Arredonda para `digits` algarismos significativos: evita a falsa precisão de
// uma estimativa anual como "6.243 h".
export function roundSignificant(value: number, digits = 2): number {
  if (!Number.isFinite(value) || value === 0) return 0;
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const factor = 10 ** (magnitude - digits + 1);
  return Math.round(value / factor) * factor;
}

// Arredonda um valor em segundos a 2 algarismos significativos *em horas*.
export function roundSecondsAsHours(seconds: number, digits = 2): number {
  return roundSignificant(seconds / 3600, digits) * 3600;
}

// ── Série temporal ──────────────────────────────────────────────────────────

export type SeriesPoint = { day: string; savedSeconds: number; executions: number };

export type Bucket = {
  key: string;
  label: string;
  from: string;
  to: string;
  savedSeconds: number;
  executions: number;
  previousSavedSeconds: number | null;
  previousExecutions: number | null;
  weekend: boolean;
};

function mondayOf(day: string): string {
  const weekday = new Date(parseDay(day)).getUTCDay();
  return addDays(day, -((weekday + 6) % 7));
}

function bucketKey(day: string, granularity: Granularity): string {
  if (granularity === 'day') return day;
  if (granularity === 'week') return mondayOf(day);
  return day.slice(0, 7);
}

function bucketLabel(key: string, granularity: Granularity): string {
  if (granularity === 'month') return `${key.slice(5, 7)}/${key.slice(2, 4)}`;
  return `${key.slice(8, 10)}/${key.slice(5, 7)}`;
}

// Agrupa o período atual (preenchendo dias sem execução com zero) e alinha a
// série do período anterior pelo deslocamento em dias: o dia i do período
// anterior cai no mesmo bucket do dia i do período atual.
export function buildBuckets(
  range: DayRange,
  granularity: Granularity,
  current: SeriesPoint[],
  previous: { range: DayRange; points: SeriesPoint[] } | null,
): Bucket[] {
  const buckets = new Map<string, Bucket>();
  const totalDays = calendarDaysBetween(range.from, range.to);

  for (let i = 0; i < totalDays; i += 1) {
    const day = addDays(range.from, i);
    const key = bucketKey(day, granularity);
    const existing = buckets.get(key);
    if (existing) {
      existing.to = day;
    } else {
      buckets.set(key, {
        key,
        label: bucketLabel(key, granularity),
        from: day,
        to: day,
        savedSeconds: 0,
        executions: 0,
        previousSavedSeconds: previous ? 0 : null,
        previousExecutions: previous ? 0 : null,
        weekend: granularity === 'day' && isWeekend(day),
      });
    }
  }

  for (const point of current) {
    const bucket = buckets.get(bucketKey(point.day, granularity));
    if (!bucket) continue;
    bucket.savedSeconds += point.savedSeconds;
    bucket.executions += point.executions;
  }

  if (previous) {
    const offset = calendarDaysBetween(previous.range.from, range.from) - 1;
    for (const point of previous.points) {
      const mapped = addDays(point.day, offset);
      const bucket = buckets.get(bucketKey(mapped, granularity));
      if (!bucket) continue;
      bucket.previousSavedSeconds = (bucket.previousSavedSeconds ?? 0) + point.savedSeconds;
      bucket.previousExecutions = (bucket.previousExecutions ?? 0) + point.executions;
    }
  }

  return Array.from(buckets.values());
}

// ── Ritmo anual estimado ────────────────────────────────────────────────────

export type RunRate = {
  estimate: number;
  lowerBound: number;
  upperBound: number;
  sampleDays: number;
  activeDays: number;
  windowFrom: string;
  windowTo: string;
  blockDays: number;
  method: string;
};

export type RunRateResult =
  | { runRate: RunRate; reason: null }
  | { runRate: null; reason: 'no_data' | 'insufficient_sample' };

export const RUN_RATE_METHOD = 'trailing-window-daily-mean-x365';

// Ritmo anual estimado, independente do período filtrado na tela:
//  - janela: últimos N dias corridos *completos* (até ontem), ou desde o
//    primeiro dado existente se a base tiver menos de N dias de vida;
//  - estimativa: média diária da janela (todos os dias corridos, inclusive fins
//    de semana e dias zerados) × 365, com cada execução limitada ao limite de
//    outlier para que um evento isolado não seja extrapolado para o ano;
//  - faixa: menor e maior ritmo entre blocos consecutivos da janela (30 dias
//    ou 14, quando a amostra é curta) — mostra a oscilação real, não um
//    intervalo de confiança estatístico;
//  - retorna null abaixo da cobertura mínima (dias de amostra e dias com
//    atividade), em vez de uma estimativa sem sustentação.
export function computeRunRate(params: {
  today: string;
  firstDataDay: string | null;
  // Execuções com ganho > 0 dentro da janela (qualquer ordem).
  entries: Array<{ day: string; savedSeconds: number }>;
  outlierCap: number | null;
  config: Pick<TimeSavingsConfig, 'runRateWindowDays' | 'runRateMinSampleDays' | 'runRateMinActiveDays'>;
}): RunRateResult {
  const { today, firstDataDay, entries, outlierCap, config } = params;
  if (!firstDataDay) return { runRate: null, reason: 'no_data' };

  const windowTo = addDays(today, -1);
  const naturalFrom = addDays(windowTo, -(config.runRateWindowDays - 1));
  const windowFrom = firstDataDay > naturalFrom ? firstDataDay : naturalFrom;
  if (windowFrom > windowTo) return { runRate: null, reason: 'insufficient_sample' };

  const sampleDays = calendarDaysBetween(windowFrom, windowTo);
  const perDay = new Map<string, number>();
  for (const entry of entries) {
    if (entry.day < windowFrom || entry.day > windowTo) continue;
    const value = outlierCap !== null ? Math.min(entry.savedSeconds, outlierCap) : entry.savedSeconds;
    perDay.set(entry.day, (perDay.get(entry.day) ?? 0) + value);
  }
  const activeDays = perDay.size;

  if (sampleDays < config.runRateMinSampleDays || activeDays < config.runRateMinActiveDays) {
    return { runRate: null, reason: 'insufficient_sample' };
  }

  const total = Array.from(perDay.values()).reduce((sum, value) => sum + value, 0);
  const blockDays = sampleDays >= 60 ? 30 : 14;
  const blockCount = Math.max(1, Math.floor(sampleDays / blockDays));
  const blocks: number[] = [];
  for (let b = 0; b < blockCount; b += 1) {
    // O último bloco absorve os dias que sobram da divisão.
    const startOffset = b * blockDays;
    const endOffset = b === blockCount - 1 ? sampleDays - 1 : startOffset + blockDays - 1;
    const from = addDays(windowFrom, startOffset);
    const to = addDays(windowFrom, endOffset);
    let sum = 0;
    for (const [day, value] of perDay) {
      if (day >= from && day <= to) sum += value;
    }
    blocks.push((sum / (endOffset - startOffset + 1)) * 365);
  }

  const estimate = (total / sampleDays) * 365;
  return {
    runRate: {
      estimate: roundSecondsAsHours(estimate),
      lowerBound: roundSecondsAsHours(Math.min(...blocks, estimate)),
      upperBound: roundSecondsAsHours(Math.max(...blocks, estimate)),
      sampleDays,
      activeDays,
      windowFrom,
      windowTo,
      blockDays,
      method: RUN_RATE_METHOD,
    },
    reason: null,
  };
}
