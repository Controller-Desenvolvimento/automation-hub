// Tipos, textos e formatadores da tela "Saúde dos robôs" (só administradores). Espelha apps/api/src/robot-health.
// Cores, ordem das categorias e formatos seguem o protótipo HTML aprovado.

export type ErrorCategory = 'entrada' | 'externo' | 'hub' | 'config' | 'robo' | 'sem';
export type Situation = 'healthy' | 'attention' | 'critical' | 'few';
export type Scope = 'all' | 'manual' | 'scheduled';
export type Granularity = 'day' | 'week' | 'month';

/** Ordem do protótipo (legenda, gráficos e tabelas): Entrada, Sistema externo, Hub, Configuração, Robô, Sem causa. */
export const CATEGORY_ORDER: ErrorCategory[] = ['entrada', 'externo', 'hub', 'config', 'robo', 'sem'];

/** Cor de cada categoria (as fichas do protótipo: laranja, verde-água, amarelo, violeta, magenta e ardósia). */
export const CATEGORY_COLOR: Record<ErrorCategory, string> = {
  entrada: 'var(--s2)',
  externo: 'var(--s3)',
  hub: 'var(--s4)',
  config: 'var(--s6)',
  robo: 'var(--s5)',
  sem: 'var(--nocause)',
};

export type Totals = {
  executions: number;
  success: number;
  errors: number;
  hubErrors: number;
  canceled: number;
  concluded: number;
  successRate: number | null;
  errorRate: number | null;
  avgDurationSeconds: number | null;
  medianDurationSeconds: number | null;
  p95DurationSeconds: number | null;
  durationSamples: number;
  errorsAll: number;
  semErrors: number;
};

export type RobotRow = Totals & {
  robotId: string;
  name: string;
  slug: string;
  active: boolean;
  situation: Situation;
  lastRunAt: string;
  lastSuccessAt: string | null;
  trend: Array<number | null>;
  mainCause: { cause: string; category: ErrorCategory; count: number } | null;
  previousErrorRate: number | null;
};

export type CategoryBucket = { start: string; counts: Record<ErrorCategory, number>; total: number };

export type CauseRow = {
  cause: string;
  category: ErrorCategory;
  description: string;
  count: number;
  robots: number;
  robotList: Array<{ robotId: string; name: string; count: number; lastAt: string }>;
  lastAt: string;
};

export type CategoryInfo = { key: ErrorCategory; label: string; summary: string; example: string; who: string; countsAgainstRobot: boolean };

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

export type DurationSeries = {
  robotId: string;
  name: string;
  executions: number;
  t2Minutes: number | null;
  points: Array<{ start: string; n: number; med: number | null; p95: number | null }>;
};

export type MiniBucket = {
  start: string;
  executionsPerDay: number;
  successRate: number | null;
  medianDurationSeconds: number | null;
  errors: number;
  semShare: number | null;
};

/** Uma célula do mapa: [sucessos, erros do robô, erros do Hub, canceladas]. */
export type HeatCell = [number, number, number, number];

export type Heatmap = {
  granularity: Granularity;
  buckets: string[];
  rows: Array<{ robotId: string; name: string; cells: HeatCell[] }>;
};

export type HealthOverview = {
  scope: Scope;
  allHistory: boolean;
  period: { from: string; to: string; days: number };
  previousPeriod: { from: string; to: string } | null;
  summary: { current: Totals; previous: Totals | null };
  robots: RobotRow[];
  categories: { granularity: Granularity; buckets: CategoryBucket[] };
  causes: CauseRow[];
  categoryInfo: CategoryInfo[];
  evolution: EvolutionBucket[];
  daily: EvolutionBucket[];
  mini: { granularity: Granularity; buckets: MiniBucket[] };
  durations: DurationSeries[];
  heatmap: Heatmap;
  capacity: Capacity;
  cycles: CycleRow[];
  insights: Insight[];
  durationSlots: DurationSlot[];
  durationCustom: boolean;
  durationOptions: Array<{ robotId: string; name: string; executions: number }>;
};

/** Um dos 4 quadros da duração: um robô, vazio (espera escolha) ou indisponível (o robô escolhido não tem dados neste período/filtro). */
export type DurationSlot = { robotId: string | null; state: 'ok' | 'empty' | 'unavailable'; name: string | null };

// ---------- etapa 3: capacidade do servidor, ciclos agendados e insights ----------

export type HourStat = {
  ms: number;
  busyMs: number;
  sumMs: number;
  peak: number;
  peakAt: string | null;
  daysLimit: number;
  days: number;
  busyShare: number;
  minutesPerDay: number;
};

export type Capacity = {
  limit: number;
  hours: HourStat[];
  any: boolean;
  busiest: number;
  atLimit: number[];
  mostBusy: number;
  quiet: { best: number; hours: number[]; ranges: Array<[number, number]> };
};

export type CycleRow = {
  taskId: string;
  name: string;
  robotName: string;
  ok: number;
  recovered: number;
  failed: number;
  canceled: number;
  attempting: number;
  hasRestart: boolean;
};

export type InsightSeverity = 'crit' | 'warn' | 'info' | 'good';
export type InsightTarget = 'visao' | 'robos' | 'erros' | 'duracao' | 'servidor' | 'agend';

export type Insight = {
  id: string;
  sev: InsightSeverity;
  pri: number;
  kind?: 'robo';
  title: string;
  text: string;
  why: string;
  facts?: Array<{ sev: 'crit' | 'warn' | 'info'; t: string }>;
  chipsLabel?: string;
  chips?: Array<{ t: string; n: string }>;
  acts?: Array<{ l: string; go: InsightTarget }>;
};

export const SEVERITY_META: Record<InsightSeverity, { icon: string; label: string }> = {
  crit: { icon: '▲', label: 'Crítico' },
  warn: { icon: '◆', label: 'Atenção' },
  info: { icon: 'i', label: 'Para saber' },
  good: { icon: '✓', label: 'Boa notícia' },
};

export const hourLabel = (h: number) => `${h}h–${(h + 1) % 24}h`;
export const pctTxt = (v: number) => (v > 0 && v < 0.01 ? '<1%' : `${Math.round(v * 100)}%`);

/** Rampa azul do protótipo (tempo ocupado por hora), clara e escura. */
const BLUE = { light: ['#cde2fb', '#9ec5f4', '#5598e7', '#256abf', '#104281'], dark: ['#0d366b', '#184f95', '#2a78d6', '#5598e7', '#9ec5f4'] };
export function blueRamp(t: number, dark: boolean) {
  const st = BLUE[dark ? 'dark' : 'light'];
  const clamped = Math.max(0, Math.min(1, t));
  const x = clamped * (st.length - 1);
  const i = Math.min(st.length - 2, Math.floor(x));
  const f = x - i;
  const rgb = (h: string) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
  const a = rgb(st[i]);
  const b = rgb(st[i + 1]);
  return `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * f)).join(',')})`;
}

// ---------- situação ----------

export const SITUATION_LABELS: Record<Situation, string> = { critical: 'Crítico', attention: 'Atenção', healthy: 'Saudável', few: 'Poucos dados' };
export const SITUATION_BADGE: Record<Situation, 'crit' | 'atencao' | 'ok' | 'poucos'> = { critical: 'crit', attention: 'atencao', healthy: 'ok', few: 'poucos' };
export const SITUATION_ICON: Record<Situation, string> = { critical: '▲', attention: '◆', healthy: '●', few: '○' };
export const SITUATION_HINTS: Record<Situation, string> = {
  critical: '40% ou mais das execuções concluídas deram erro',
  attention: 'de 15% a menos de 40% de erro',
  healthy: 'menos de 15% de erro',
  few: 'menos de 5 execuções concluídas no período: pouco para julgar',
};
export const SITUATION_ORDER: Record<Situation, number> = { critical: 4, attention: 3, healthy: 2, few: 1 };

// ---------- formatadores (como no protótipo) ----------

export const nf = (value: number | null | undefined, digits = 0) =>
  value === null || value === undefined ? '—' : value.toLocaleString('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: digits });
export const pct = (value: number | null | undefined) => (value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`);
export const pl = (n: number, one: string, many: string) => `${nf(n)} ${n === 1 ? one : many}`;
/** Minutos a partir de segundos: "5,3 min", "12 min". */
export const mins = (seconds: number | null | undefined) => {
  if (seconds === null || seconds === undefined) return '—';
  const v = seconds / 60;
  return `${v < 10 ? nf(v, 1) : nf(Math.round(v))} min`;
};

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MONTHS_LONG = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const DOW = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

export const toDayKey = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const fromKey = (key: string) => new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));
/** "2026-11-18" → "18/11". */
export const fmtDay = (key: string) => `${key.slice(8, 10)}/${key.slice(5, 7)}`;
export const fmtDayYear = (key: string) => `${key.slice(8, 10)}/${key.slice(5, 7)}/${key.slice(0, 4)}`;
export const fmtDateTime = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export function relDay(iso: string | null) {
  if (!iso) return 'nunca';
  const d = new Date(iso);
  const days = Math.round((new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
  return days <= 0 ? 'hoje' : days === 1 ? 'ontem' : `há ${days} dias`;
}

export const GRANULARITY_LABELS: Record<Granularity, { one: string; of: string; many: string; col: string }> = {
  day: { one: 'dia', of: 'do dia', many: 'Dias', col: 'Dia' },
  week: { one: 'semana', of: 'da semana', many: 'Semanas', col: 'Semana de' },
  month: { one: 'mês', of: 'do mês', many: 'Meses', col: 'Mês' },
};

export type BucketInfo = { label: string; title: string; part: boolean; note: string | null };

/** Rótulo, título e se o balde é um pedaço incompleto (semana ou mês cortado pelo período). */
export function bucketInfo(start: string, granularity: Granularity, periodFrom: string, periodTo: string): BucketInfo {
  const from = fromKey(start);
  if (granularity === 'day') {
    return { label: fmtDay(start), title: `${DOW[from.getDay()]}, ${fmtDay(start)}`, part: false, note: null };
  }
  const end = granularity === 'week' ? new Date(from.getFullYear(), from.getMonth(), from.getDate() + 6) : new Date(from.getFullYear(), from.getMonth() + 1, 0);
  const a = start < periodFrom ? periodFrom : start;
  const b = toDayKey(end) > periodTo ? periodTo : toDayKey(end);
  const full = granularity === 'week' ? 7 : end.getDate();
  const inside = Math.round((fromKey(b).getTime() - fromKey(a).getTime()) / 86400000) + 1;
  const part = inside < full;
  const range = `${fmtDay(a)}${b > a ? ` a ${fmtDay(b)}` : ''}`;
  return {
    label: granularity === 'month' ? `${MONTHS[from.getMonth()]}/${String(from.getFullYear()).slice(2)}` : fmtDay(start),
    title: granularity === 'week' ? `Semana de ${range}` : `${MONTHS_LONG[from.getMonth()][0].toUpperCase()}${MONTHS_LONG[from.getMonth()].slice(1)} de ${from.getFullYear()}`,
    part,
    note: part ? `Pedaço incompleto: só ${pl(inside, 'dia', 'dias')} (${range}) entram no período.` : null,
  };
}

export type PeriodPreset = '7' | '30' | '60' | '90' | 'month' | 'lastMonth' | 'all' | 'custom';

export const PERIOD_PRESETS: Array<{ value: PeriodPreset; label: string }> = [
  { value: '7', label: 'Últimos 7 dias' },
  { value: '30', label: 'Últimos 30 dias' },
  { value: '60', label: 'Últimos 60 dias' },
  { value: '90', label: 'Últimos 90 dias' },
  { value: 'month', label: 'Este mês' },
  { value: 'lastMonth', label: 'Mês passado' },
  { value: 'all', label: 'Todo o histórico' },
  { value: 'custom', label: 'Escolher datas' },
];

/** Datas (AAAA-MM-DD) de um período pré-definido; 'all' e 'custom' não têm datas fixas aqui. */
export function presetRange(preset: PeriodPreset, now = new Date()): { from: string; to: string } | null {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (preset === '7' || preset === '30' || preset === '60' || preset === '90') {
    const days = Number(preset);
    return { from: toDayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1))), to: toDayKey(today) };
  }
  if (preset === 'month') return { from: toDayKey(new Date(today.getFullYear(), today.getMonth(), 1)), to: toDayKey(today) };
  if (preset === 'lastMonth') {
    return { from: toDayKey(new Date(today.getFullYear(), today.getMonth() - 1, 1)), to: toDayKey(new Date(today.getFullYear(), today.getMonth(), 0)) };
  }
  return null;
}

// ---------- variação (como no protótipo: p.p. para taxas, % para contagens; "estável" abaixo de 0,5 p.p. ou 1%) ----------

export type Delta = { text: string; icon: string; cls: 'good' | 'bad' | 'flat'; cur: number | null; prev: number | null; kind: 'pp' | 'rel' };

export function deltaOf(cur: number | null, prev: number | null, kind: 'pp' | 'rel', upGood: boolean): Delta {
  const base = { cur, prev, kind };
  if (cur === null || prev === null || (kind !== 'pp' && !prev)) return { ...base, text: 'sem comparação', icon: '', cls: 'flat' };
  const diff = kind === 'pp' ? (cur - prev) * 100 : ((cur - prev) / prev) * 100;
  const text = kind === 'pp' ? `${nf(Math.abs(diff), 0)} p.p.` : `${nf(Math.abs(diff), 0)}%`;
  if (Math.abs(diff) < (kind === 'pp' ? 0.5 : 1)) return { ...base, text: 'estável', icon: '=', cls: 'flat' };
  const up = diff > 0;
  return { ...base, text, icon: up ? '▲' : '▼', cls: up === upGood ? 'good' : 'bad' };
}

// ---------- rampa do mapa (0% de erro = verde-água; com erro = rampa vermelha) ----------

const RAMPS = {
  light: ['#fff0ef', '#fbc9c5', '#f28f89', '#d8453f', '#a62a26'],
  dark: ['#2a1f23', '#55272b', '#8a2f31', '#c4443f', '#f1736d'],
};
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

export function errorRamp(t: number, dark: boolean) {
  const stops = RAMPS[dark ? 'dark' : 'light'];
  const c = Math.max(0, Math.min(1, t));
  const x = c * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = hex(stops[i]);
  const b = hex(stops[i + 1]);
  return `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * f)).join(',')})`;
}

/** Cor da célula do mapa para um % de erro: 0% = verde-água claro; com erro = rampa vermelha (o mínimo já é bem visível). */
export const heatColor = (rate: number, dark: boolean) => (rate <= 0 ? 'color-mix(in srgb, var(--s3) 30%, var(--hc-surface))' : errorRamp(0.3 + 0.7 * Math.min(1, rate), dark));
export const HEAT_BANDS: Array<[number, number, string]> = [[0, 0, '0% de erro'], [0.01, 0.25, 'até 25%'], [0.25, 0.5, '25% a 50%'], [0.5, 1, '50% ou mais']];
