// Tipos e textos da tela "Saúde dos robôs" (só administradores). Espelha apps/api/src/robot-health.

export type ErrorCategory = 'entrada' | 'externo' | 'hub' | 'robo' | 'config' | 'sem';
export type Situation = 'healthy' | 'attention' | 'critical' | 'few';
export type Scope = 'all' | 'manual' | 'scheduled';
export type Granularity = 'day' | 'week' | 'month';

/** Ordem fixa das categorias (é a ordem das cores validadas do gráfico: nunca trocar). */
export const CATEGORY_ORDER: ErrorCategory[] = ['entrada', 'externo', 'hub', 'robo', 'config', 'sem'];

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
};

export type RobotRow = Totals & {
  robotId: string;
  name: string;
  slug: string;
  active: boolean;
  situation: Situation;
  lastRunAt: string;
  mainCause: { cause: string; category: ErrorCategory; count: number } | null;
  previousErrorRate: number | null;
};

export type CategoryBucket = { start: string; counts: Record<ErrorCategory, number>; total: number };

export type CauseRow = { cause: string; category: ErrorCategory; description: string; count: number; robots: number };

export type CategoryInfo = { key: ErrorCategory; label: string; summary: string; example: string; who: string; countsAgainstRobot: boolean };

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
};

export const SITUATION_LABELS: Record<Situation, string> = {
  critical: 'Crítico',
  attention: 'Atenção',
  healthy: 'Saudável',
  few: 'Poucos dados',
};

export const SITUATION_HINTS: Record<Situation, string> = {
  critical: '40% ou mais das execuções concluídas deram erro',
  attention: 'de 15% a menos de 40% de erro',
  healthy: 'menos de 15% de erro',
  few: 'menos de 5 execuções concluídas no período: pouco para julgar',
};

/** Ordem de gravidade (para ordenar a tabela). */
export const SITUATION_ORDER: Record<Situation, number> = { critical: 3, attention: 2, healthy: 1, few: 0 };

export const GRANULARITY_LABELS: Record<Granularity, { one: string; many: string }> = {
  day: { one: 'dia', many: 'dias' },
  week: { one: 'semana', many: 'semanas' },
  month: { one: 'mês', many: 'meses' },
};

export const pct = (value: number | null, digits = 0) => (value === null ? '—' : `${(value * 100).toFixed(digits).replace('.', ',')}%`);

export const num = (value: number) => value.toLocaleString('pt-BR');

export function duration(seconds: number | null) {
  if (seconds === null) return '—';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** "2026-11-18" → "18/11". */
export const shortDay = (key: string) => `${key.slice(8, 10)}/${key.slice(5, 7)}`;
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

export function bucketLabel(start: string, granularity: Granularity) {
  if (granularity === 'month') return `${MONTHS[Number(start.slice(5, 7)) - 1]}/${start.slice(2, 4)}`;
  return shortDay(start);
}

export function bucketTitle(start: string, granularity: Granularity) {
  if (granularity === 'day') return `${start.slice(8, 10)}/${start.slice(5, 7)}/${start.slice(0, 4)}`;
  if (granularity === 'week') {
    const from = new Date(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1, Number(start.slice(8, 10)));
    const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 6);
    const f = (d: Date) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
    return `Semana de ${f(from)} a ${f(to)}`;
  }
  return `${MONTHS[Number(start.slice(5, 7)) - 1]} de ${start.slice(0, 4)}`;
}

export function toDayKey(date: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
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
