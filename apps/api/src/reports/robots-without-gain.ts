// Aba "Robôs sem ganho" (tela Tempo ganho): robôs do Hub sem tempo manual configurado. Funções puras (sem banco).

/** O Hub grava cada AH_METRIC do robô como o log "Metrica registrada: chave=valor" (ver ExecutionRunnerService). */
const METRIC_LOG = /^Metrica registrada: ([a-z0-9_.-]+)=(-?\d+(?:\.\d+)?)$/i;

export type MetricUse = {
  key: string;
  /** Em quantas execuções do período o robô informou esta métrica. */
  executions: number;
  /** Soma da métrica no período. */
  total: number;
};

/** Agrupa os logs de métrica de UM robô: por chave, em quantas execuções apareceu e quanto somou. */
export function summarizeMetricLogs(rows: Array<{ executionId: string; message: string }>): MetricUse[] {
  const byKey = new Map<string, { executions: Set<string>; total: number }>();
  for (const row of rows) {
    const match = METRIC_LOG.exec(row.message.trim());
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = Number(match[2]);
    if (!Number.isFinite(value)) continue;
    const entry = byKey.get(key) ?? { executions: new Set<string>(), total: 0 };
    entry.executions.add(row.executionId);
    entry.total += value;
    byKey.set(key, entry);
  }
  return [...byKey.entries()]
    .map(([key, v]) => ({ key, executions: v.executions.size, total: v.total }))
    .sort((a, b) => b.executions - a.executions || a.key.localeCompare(b.key));
}

export type TimeSavingsInput = {
  manualSecondsPerUnit?: unknown;
  unitLabel?: unknown;
  unitMetricKey?: unknown;
};

export type RobotTimeSavingsConfig = {
  manualSecondsPerUnit: number;
  unitLabel: string;
  unitMetricKey: string;
};

export const MAX_SECONDS_PER_UNIT = 86_400; // 24 h por item já é absurdo: o teto protege de erro de digitação
export const DEFAULT_METRIC_KEY = 'itens_processados';

/** Mesma regra de chave do runner (normalizeMetricKey): minúsculas, só a-z, 0-9 e "_". */
export function normalizeMetricKey(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Valida o que a aba envia. Só estes 3 campos mudam (o POST /api/robots é um upsert total e zeraria os demais).
 * Devolve a configuração limpa ou a mensagem do que está errado.
 */
export function parseTimeSavingsInput(input: TimeSavingsInput): { ok: true; value: RobotTimeSavingsConfig } | { ok: false; message: string } {
  const seconds = typeof input.manualSecondsPerUnit === 'number' ? input.manualSecondsPerUnit : Number(input.manualSecondsPerUnit);
  if (input.manualSecondsPerUnit === undefined || input.manualSecondsPerUnit === null || input.manualSecondsPerUnit === '' || !Number.isFinite(seconds)) {
    return { ok: false, message: 'Informe o tempo manual por item, em segundos.' };
  }
  const rounded = Math.round(seconds);
  if (rounded < 1) return { ok: false, message: 'O tempo manual por item precisa ser de pelo menos 1 segundo.' };
  if (rounded > MAX_SECONDS_PER_UNIT) return { ok: false, message: 'O tempo manual por item não pode passar de 24 horas.' };

  const label = typeof input.unitLabel === 'string' ? input.unitLabel.trim().replace(/\s+/g, ' ') : '';
  if (!label) return { ok: false, message: 'Diga o que é um item (por exemplo: empresa, nota, planilha).' };
  if (label.length > 40) return { ok: false, message: 'O nome do item pode ter no máximo 40 caracteres.' };

  const key = normalizeMetricKey(input.unitMetricKey) || DEFAULT_METRIC_KEY;
  if (key.length > 60) return { ok: false, message: 'O nome da métrica pode ter no máximo 60 caracteres.' };

  return { ok: true, value: { manualSecondsPerUnit: rounded, unitLabel: label, unitMetricKey: key } };
}

/** Soma de cada métrica por execução (a partir dos mesmos logs): execução -> chave -> valor. */
export function metricsByExecution(rows: Array<{ executionId: string; message: string }>): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const match = METRIC_LOG.exec(row.message.trim());
    if (!match) continue;
    const value = Number(match[2]);
    if (!Number.isFinite(value)) continue;
    const perExecution = out.get(row.executionId) ?? new Map<string, number>();
    const key = match[1].toLowerCase();
    perExecution.set(key, (perExecution.get(key) ?? 0) + value);
    out.set(row.executionId, perExecution);
  }
  return out;
}
