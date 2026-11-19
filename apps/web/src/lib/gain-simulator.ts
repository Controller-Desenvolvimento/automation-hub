// Simulador de ganhos (aba "Robôs sem ganho"): tipos da resposta da API, leitura de números digitados e formatação (as mesmas
// regras do protótipo aprovado).

export type SimSource = 'atual' | 'novo' | 'informado' | 'nenhum';

export type SimRow = {
  robotId: string;
  name: string;
  hasTime: boolean;
  /** Robô externo: o ganho vem do próprio sistema dele ("usar estes tempos" não grava nele). */
  external: boolean;
  executions: number;
  scheduled: number;
  currentMonth: number;
  simulatedMonth: number;
  source: SimSource;
  perExecution: number | null;
  avgItems: number | null;
  /** Só de robô externo: segundos que ele ganha hoje por item (ou por execução, se não informa a quantidade). */
  currentPerUnit: number | null;
  estimated: number;
  days: number;
  monthsCovered: number;
  executionsMonth: number;
  metricKey: string | null;
  metricAvg: number | null;
};

/** Só as linhas por robô (para montar a tabela do formulário antes de simular). */
export type SimPreview = { rows: SimRow[]; days: number; months: number };

export type SimInsightItem = { kind: 'warn' | 'info'; icon: string; text: string };

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
  insights: SimInsightItem[];
  monthly: { months: MonthlyPoint[]; cut: boolean };
};

/** Um mês da evolução mensal (últimos 12 meses, independente do período escolhido). */
export type MonthlyPoint = {
  /** AAAA-MM. */
  key: string;
  /** O mês corrente: ainda não terminou. */
  partial: boolean;
  /** Ganho do relatório no mês (todos os robôs e fontes), em segundos. */
  current: number;
  /** Ganho do relatório no mês só dos robôs da simulação. */
  currentSim: number;
  /** Extra simulado no mês. */
  extra: number;
};

export const MINUS = '−';
export const BUSINESS_DAYS = 21;
export const nf = (v: number, d = 0) => v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
export const nfx = (v: number) => Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
export const pl = (n: number, one: string, many: string) => `${nf(n)} ${n === 1 ? one : many}`;

/** "0 h", "45 min", "7,5 h", "120 h": o mesmo jeito de falar do relatório. */
export function dur(seconds: number): string {
  const s = Math.round(seconds || 0);
  if (s <= 0) return '0 h';
  if (s < 3600) return `${nf(Math.max(1, Math.round(s / 60)))} min`;
  const h = s / 3600;
  return `${nf(h, h < 10 ? 1 : 0)} h`;
}

/** Sinal só quando o número que aparece não é zero ("+0 h" e "−0%" não existem). */
export function signed(value: number, fmt: (v: number) => string): string {
  const text = fmt(Math.abs(value));
  if (/^0([,.]0+)?(\s|%|$)/.test(text) || !value) return text;
  return `${value > 0 ? '+' : MINUS}${text}`;
}
export const signedDur = (seconds: number) => signed(seconds, dur);
export const hrs = (seconds: number) => nf(seconds / 3600, Math.abs(seconds) < 36000 ? 1 : 0);

// pessoas = horas por mês ÷ (jornada × 21 dias úteis); aceita negativo (simulação que reduz o ganho)
export const peopleOf = (secondsPerMonth: number, workdayHours: number) => secondsPerMonth / 3600 / (workdayHours * BUSINESS_DAYS);
export function peopleNum(secondsPerMonth: number, workdayHours: number): string {
  const p = peopleOf(secondsPerMonth, workdayHours);
  const a = Math.abs(p);
  const t = nf(a, a < 10 ? 1 : 0);
  return `${p < 0 && Number(t.replace(',', '.')) !== 0 ? MINUS : ''}${t}`;
}
export function peopleWord(secondsPerMonth: number, workdayHours: number): string {
  const a = Math.abs(peopleOf(secondsPerMonth, workdayHours));
  const r = a < 10 ? Math.round(a * 10) / 10 : Math.round(a);
  return r === 0 || r >= 2 ? 'pessoas' : 'pessoa';
}
export const peopleTxt = (secondsPerMonth: number, workdayHours: number) => `${peopleNum(secondsPerMonth, workdayHours)} ${peopleWord(secondsPerMonth, workdayHours)}`;
export const jornadaTxt = (jh: number) => `jornada de ${nfx(jh)} h por dia, ${BUSINESS_DAYS} dias úteis`;

/** "5 min por empresa", "2 h por execução". */
export function perUnitTxt(seconds: number, unit: string): string {
  if (seconds % 3600 === 0 && seconds >= 3600) return `${nf(seconds / 3600)} h por ${unit}`;
  if (seconds % 60 === 0 && seconds >= 60) return `${nf(seconds / 60)} min por ${unit}`;
  return seconds >= 60 ? `${nf(seconds / 60, 1)} min por ${unit}` : `${nf(seconds)} s por ${unit}`;
}

// ---------- tempos digitados ----------

export type SimUnit = 'seconds' | 'minutes' | 'hours';
export const UNIT_SECONDS: Record<SimUnit, number> = { seconds: 1, minutes: 60, hours: 3600 };
export const UNIT_AB: Record<SimUnit, string> = { seconds: 's', minutes: 'min', hours: 'h' };
export const UNIT_NAME: Record<SimUnit, string> = { seconds: 'segundos', minutes: 'minutos', hours: 'horas' };
export const MAX_SECONDS = 86_400; // o mesmo teto do tempo manual configurado

/**
 * Lê um número digitado. Vazio = sem valor. Aceita vírgula (ou ponto) decimal; recusa milhar ("1.000"), zero, negativo e texto.
 */
export function parseNum(raw: string | undefined, max?: number, min?: number, minMessage?: string): { empty: true; value: 0 } | { error: string } | { value: number; empty?: false } {
  const t = String(raw ?? '').trim();
  if (!t) return { empty: true, value: 0 };
  if (/^\d{1,3}(\.\d{3})+$/.test(t)) return { error: 'Use vírgula para decimais (ex.: 1,5). Ponto de milhar não vale.' };
  if (/^-/.test(t)) return { error: 'Use um número maior que zero.' };
  if (!/^\d+([.,]\d+)?$/.test(t)) return { error: 'Digite só números (ex.: 5 ou 1,5).' };
  const x = Number(t.replace(',', '.'));
  if (!(x > 0)) return { error: 'Use um número maior que zero.' };
  if (max !== undefined && x > max) return { error: `Valor alto demais (no máximo ${nfx(max)}).` };
  if (min !== undefined && x < min) return { error: minMessage ?? `Valor baixo demais (no mínimo ${nfx(min)}).` };
  return { value: x };
}

/** Trocar a unidade converte o que já foi digitado: 5 min vira 0,08 h, não 5 h. */
export function convertUnit(raw: string, from: SimUnit, to: SimUnit): string {
  const p = parseNum(raw);
  if ('error' in p || p.empty) return raw;
  // até 4 casas: com 2, 5 min virava 0,08 h (= 4,8 min) e a simulação passava a usar 288 s em vez de 300 s
  return (Math.round(((p.value * UNIT_SECONDS[from]) / UNIT_SECONDS[to]) * 10000) / 10000).toLocaleString('pt-BR', { maximumFractionDigits: 4 });
}

/** Segundos exatos mostrados na unidade escolhida (até 4 casas): usado para trocar de unidade sem acumular erro de arredondamento. */
export function formatInUnit(seconds: number, unit: SimUnit): string {
  return (Math.round((seconds / UNIT_SECONDS[unit]) * 10000) / 10000).toLocaleString('pt-BR', { maximumFractionDigits: 4 });
}
