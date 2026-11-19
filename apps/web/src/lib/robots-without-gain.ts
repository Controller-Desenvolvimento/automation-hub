// Aba "Robôs sem ganho" (tela Tempo ganho): tipos da API e a conta da prévia do que o tempo configurado passaria a somar.

export type MetricUse = { key: string; executions: number; total: number };

export type RobotWithoutGain = {
  robotId: string;
  name: string;
  slug: string;
  category: string | null;
  departments: string[];
  unitLabel: string;
  unitMetricKey: string;
  /** Execuções com sucesso no período: todas entram no relatório com 0 h. */
  executions: number;
  /** Dessas, quantas foram agendadas (o robô rodou sozinho). */
  scheduledExecutions: number;
  /** Tempo manual atual em segundos (0 = sem tempo). */
  manualSecondsPerUnit: number;
  lastExecutionAt: string | null;
  /** Itens gravados nas execuções do período (métrica da chave atual). */
  recordedUnits: { executions: number; total: number };
  metrics: MetricUse[];
};

export type RobotsWithoutGainResponse = {
  range: { from: string | null; to: string | null } | null;
  robots: RobotWithoutGain[];
  /** Execuções com ganho 0 de robôs que JÁ têm tempo manual (0 itens, ou gravadas antes de o robô ter tempo). */
  others: Array<{ robotId: string; name: string; zeroItems: number; beforeTime: number }>;
};

export const DEFAULT_METRIC_KEY = 'itens_processados';
/** Chave que nenhum robô informa: "cada execução conta como 1 item" (o Hub conta 1 item quando a chave não aparece). */
export const PER_EXECUTION_KEY = 'por_execucao';

/**
 * Chave a gravar quando "cada execução conta como 1 item". Normalmente a padrão; mas se o robô JÁ informa a métrica padrão
 * (`itens_processados`), ela contaria os itens dele e não 1 por execução: nesse caso usa uma chave que ele não informa.
 */
export function executionModeKey(robot: Pick<RobotWithoutGain, 'metrics'>): string {
  return robot.metrics.some((m) => m.key === DEFAULT_METRIC_KEY) ? PER_EXECUTION_KEY : DEFAULT_METRIC_KEY;
}

export type TimeUnit = 'seconds' | 'minutes' | 'hours';
export const TIME_UNITS: Array<{ value: TimeUnit; label: string; factor: number }> = [
  { value: 'seconds', label: 'segundos', factor: 1 },
  { value: 'minutes', label: 'minutos', factor: 60 },
  { value: 'hours', label: 'horas', factor: 3600 },
];

/** Converte o que a pessoa digitou (aceita vírgula) em segundos inteiros; null se não for um número positivo. */
export function toSeconds(raw: string, unit: TimeUnit): number | null {
  const value = Number(raw.trim().replace(',', '.'));
  if (!raw.trim() || !Number.isFinite(value) || value <= 0) return null;
  const factor = TIME_UNITS.find((u) => u.value === unit)?.factor ?? 1;
  const seconds = Math.round(value * factor);
  // menos de 1 segundo arredonda para 0: não é um tempo válido (o servidor também exige pelo menos 1 s)
  return seconds >= 1 ? seconds : null;
}

/** Mesma regra de chave do servidor: minúsculas, só a-z, 0-9 e "_". */
export function normalizeMetricKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
}

export type Preview = {
  /** Itens que o relatório contaria no período com esta forma de contar. */
  items: number;
  seconds: number;
  /** De quantas execuções os itens vieram da métrica; as outras contam 1 item (regra do Hub). */
  fromMetric: number;
  assumed: number;
  /** A métrica escolhida não apareceu no período (ou os logs já foram apagados): conta 1 item por execução. */
  metricMissing: boolean;
};

/**
 * Quanto o tempo configurado somaria no período, com a mesma regra do Hub: itens = o que o robô informou pela métrica;
 * execução sem a métrica conta 1 item. `metricKey` vazio/padrão sem dados = cada execução conta como 1 item.
 */
export function previewGain(robot: RobotWithoutGain, secondsPerItem: number, mode: 'execution' | 'metric', metricKey: string): Preview {
  const runs = robot.executions;
  if (mode === 'execution') return { items: runs, seconds: secondsPerItem * runs, fromMetric: 0, assumed: runs, metricMissing: false };
  const key = normalizeMetricKey(metricKey) || DEFAULT_METRIC_KEY;
  // Itens já gravados nas execuções valem mais que os logs (que a retenção apaga depois de 30 dias).
  let known = key === robot.unitMetricKey && robot.recordedUnits.executions > 0 ? robot.recordedUnits : null;
  if (!known) {
    const m = robot.metrics.find((x) => x.key === key);
    if (m) known = { executions: m.executions, total: m.total };
  }
  if (!known) return { items: runs, seconds: secondsPerItem * runs, fromMetric: 0, assumed: runs, metricMissing: true };
  const covered = Math.min(runs, known.executions);
  const assumed = runs - covered;
  const items = known.total + assumed;
  return { items, seconds: secondsPerItem * items, fromMetric: covered, assumed, metricMissing: false };
}
