// Verificação por tempo das execuções AGENDADAS (T0, T1, T2). Regras puras: sem banco, sem rede, sem relógio próprio.
//
// Todos os tempos contam a partir do INÍCIO da execução (não da hora marcada nem da entrada na fila):
//   T0 = verifyT0Minutes            → 1º aviso por e-mail (ainda em execução)
//   T1 = T0 + verifyT1Minutes       → 2º aviso
//   T2 = T1 + verifyT2Minutes       → cancela; a 1ª tentativa é reiniciada (uma vez), a 2ª é cancelada de vez
// Sem os três valores = "sem verificação" (só o e-mail de erro comum, que já existe).

export interface CheckConfig {
  t0: number;
  t1: number;
  t2: number;
}

export interface TaskCheckFields {
  verifyT0Minutes: number | null;
  verifyT1Minutes: number | null;
  verifyT2Minutes: number | null;
}

export const MAX_CHECK_MINUTES = 24 * 60;
export const MAX_ATTEMPTS = 2;
// Reinício vai à frente da fila: precisa rodar antes de qualquer outra coisa que esteja esperando.
export const RESTART_PRIORITY = 1000;

export function checkConfigFromTask(task: TaskCheckFields): CheckConfig | null {
  const { verifyT0Minutes: t0, verifyT1Minutes: t1, verifyT2Minutes: t2 } = task;
  if (t0 == null || t1 == null || t2 == null) return null;
  if (![t0, t1, t2].every((n) => Number.isInteger(n) && n >= 1)) return null;
  return { t0, t1, t2 };
}

// Minutos desde o início em que cada marco acontece.
export function checkMarks(cfg: CheckConfig): { t0: number; t1: number; t2: number } {
  return { t0: cfg.t0, t1: cfg.t0 + cfg.t1, t2: cfg.t0 + cfg.t1 + cfg.t2 };
}

export type CheckDecision =
  | { action: 'none' }
  | { action: 'notify'; stage: 1 | 2 }
  | { action: 'cancel' };

// O que fazer com uma execução agendada que está rodando.
//  - 1ª tentativa: avisa em T0 e em T1 (uma vez cada); em T2 cancela (e o chamador reinicia).
//  - 2ª tentativa (o reinício): sem avisos intermediários; em T2 cancela de vez (e o chamador manda o e-mail final).
// Se o relógio andou mais de um marco entre duas verificações (Hub ocupado), vale só o mais avançado.
export function decideCheck(input: {
  startedAt: Date;
  now: Date;
  attempt: number;
  checkStage: number;
  cfg: CheckConfig;
}): CheckDecision {
  const elapsedMin = (input.now.getTime() - input.startedAt.getTime()) / 60_000;
  const marks = checkMarks(input.cfg);
  if (elapsedMin >= marks.t2) return { action: 'cancel' };
  if (input.attempt >= MAX_ATTEMPTS) return { action: 'none' };
  if (elapsedMin >= marks.t1 && input.checkStage < 2) return { action: 'notify', stage: 2 };
  if (elapsedMin >= marks.t0 && input.checkStage < 1) return { action: 'notify', stage: 1 };
  return { action: 'none' };
}

// Horário em que cada marco acontece para uma execução que começou em `startedAt`.
export function markTimes(startedAt: Date, cfg: CheckConfig): { t0: Date; t1: Date; t2: Date } {
  const marks = checkMarks(cfg);
  const at = (min: number) => new Date(startedAt.getTime() + min * 60_000);
  return { t0: at(marks.t0), t1: at(marks.t1), t2: at(marks.t2) };
}

export type CheckFieldsParse =
  | { ok: true; value: TaskCheckFields }
  | { ok: false; message: string };

// Interpreta T0/T1/T2 vindos do formulário. undefined = "não enviado" (quem chama preserva o que já existe);
// vazio/null nos três = "sem verificação"; senão os três precisam ser inteiros positivos (até 24 h cada).
export function parseCheckFields(input: {
  verifyT0Minutes?: unknown;
  verifyT1Minutes?: unknown;
  verifyT2Minutes?: unknown;
}): { present: false } | ({ present: true } & CheckFieldsParse) {
  const raw = [input.verifyT0Minutes, input.verifyT1Minutes, input.verifyT2Minutes];
  if (raw.every((v) => v === undefined)) return { present: false };

  const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  if (raw.every(isEmpty)) {
    return { present: true, ok: true, value: { verifyT0Minutes: null, verifyT1Minutes: null, verifyT2Minutes: null } };
  }

  const nums = raw.map((v) => (isEmpty(v) ? NaN : Number(v)));
  if (!nums.every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_CHECK_MINUTES)) {
    return {
      present: true,
      ok: false,
      message:
        'Verificação por tempo: informe T0, T1 e T2 como minutos inteiros (1 a 1440), ou deixe os três em branco para "sem verificação".',
    };
  }
  return {
    present: true,
    ok: true,
    value: { verifyT0Minutes: nums[0], verifyT1Minutes: nums[1], verifyT2Minutes: nums[2] },
  };
}
