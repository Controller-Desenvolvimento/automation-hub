export const DEFAULT_STALL_TIMEOUT_MINUTES = 45;

// 0 desliga o watchdog; valor ausente/inválido cai no padrão.
export function getStallTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.EXECUTION_STALL_TIMEOUT_MINUTES;
  if (raw === undefined || raw.trim() === '') return DEFAULT_STALL_TIMEOUT_MINUTES * 60_000;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) return DEFAULT_STALL_TIMEOUT_MINUTES * 60_000;
  return Math.floor(minutes) * 60_000;
}

export function findStalledExecutions(
  running: Iterable<{ executionId: string; lastActivityAt: number }>,
  now: number,
  timeoutMs: number,
): Array<{ executionId: string; idleMinutes: number }> {
  if (timeoutMs <= 0) return [];
  const stalled: Array<{ executionId: string; idleMinutes: number }> = [];
  for (const { executionId, lastActivityAt } of running) {
    const idleMs = now - lastActivityAt;
    if (idleMs >= timeoutMs) stalled.push({ executionId, idleMinutes: Math.floor(idleMs / 60_000) });
  }
  return stalled;
}

export function stallMessage(idleMinutes: number): string {
  return `Execução cancelada automaticamente: o robô ficou ${idleMinutes} minutos sem nenhuma atividade (nenhuma saída nem log) e foi considerado travado. Confira o robô e rode novamente.`;
}
