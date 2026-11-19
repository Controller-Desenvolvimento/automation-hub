// Simulador de ganhos (aba "Robôs sem ganho"): tipos da resposta da API e formatação.

export type SimSource = 'atual' | 'novo' | 'informado' | 'nenhum';

export type SimRow = {
  robotId: string;
  name: string;
  hasTime: boolean;
  executions: number;
  scheduled: number;
  currentMonth: number;
  simulatedMonth: number;
  source: SimSource;
  perExecution: number | null;
  avgItems: number | null;
  estimated: number;
  days: number;
};

export type SimulationResult = {
  scope: 'sem' | 'todos';
  base: 'exec' | 'item';
  workdayHours: number;
  range: { from: string | null; to: string | null } | null;
  days: number;
  months: number;
  currentMonth: number;
  simulatedMonth: number;
  extraMonth: number;
  extraYear: number;
  fromWithout: number;
  fromNewTimes: number;
  reportMonth: number;
  people: { extra: number; total: number; current: number };
  band: {
    low: { extraMonth: number; people: number };
    likely: { extraMonth: number; people: number };
    high: { extraMonth: number; people: number };
  };
  rows: SimRow[];
  insights: Array<{ kind: 'warn' | 'info'; text: string }>;
};

const MINUS = '−';
export const nf = (v: number, d = 0) => v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });

/** "0 h", "45 min", "7,5 h", "120 h": o mesmo jeito de falar do relatório. */
export function dur(seconds: number): string {
  const s = Math.round(Math.abs(seconds) || 0);
  if (s <= 0) return '0 h';
  if (s < 3600) return `${nf(Math.max(1, Math.round(s / 60)))} min`;
  const h = s / 3600;
  return `${nf(h, h < 10 ? 1 : 0)} h`;
}

/** Com sinal só quando o número que aparece não é zero ("+0 h" não existe). */
export function signedDur(seconds: number): string {
  const text = dur(seconds);
  if (text === '0 h' || !seconds) return text;
  return `${seconds > 0 ? '+' : MINUS}${text}`;
}

export function peopleText(value: number): string {
  const a = Math.abs(value);
  const shown = nf(a, a < 10 ? 1 : 0);
  const rounded = a < 10 ? Math.round(a * 10) / 10 : Math.round(a);
  const word = rounded === 0 || rounded >= 2 ? 'pessoas' : 'pessoa';
  return `${value < 0 && Number(shown.replace(',', '.')) !== 0 ? MINUS : ''}${shown} ${word}`;
}

export const SOURCE_LABEL: Record<SimSource, string> = {
  atual: 'tempo atual',
  novo: 'novo tempo',
  informado: 'tempo informado',
  nenhum: 'sem tempo',
};
