// Regras (puras, sem banco nem rede) da atualização programada dos painéis.

export interface UpdateSchedule {
  frequency: string | null;
  timesOfDay: string[];
  dayOfWeek: number | null;
  dayOfMonth: number | null;
}

export const DEFAULT_CATCHUP_MINUTES = 60;
export const DEFAULT_RETRY_MINUTES = 5;

function positiveMinutes(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Quanto tempo depois do horário marcado ainda vale atualizar (Hub fora do ar, reinício, deploy no minuto exato).
export function getCatchUpMs(env: Record<string, string | undefined> = process.env): number {
  return positiveMinutes(env.PANEL_UPDATE_CATCHUP_MINUTES, DEFAULT_CATCHUP_MINUTES) * 60_000;
}

// Espera entre a 1ª tentativa que falhou e a 2ª.
export function getRetryDelayMs(env: Record<string, string | undefined> = process.env): number {
  return positiveMinutes(env.PANEL_UPDATE_RETRY_MINUTES, DEFAULT_RETRY_MINUTES) * 60_000;
}

function parseTime(value: string): { h: number; m: number } | null {
  const parts = value.split(':');
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (parts.length < 2 || !Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

function dayMatches(schedule: UpdateSchedule, day: Date): boolean {
  if (schedule.frequency === 'daily') return true;
  if (schedule.frequency === 'weekly') return day.getDay() === (schedule.dayOfWeek ?? 1);
  if (schedule.frequency === 'monthly') return day.getDate() === (schedule.dayOfMonth ?? 1);
  return false;
}

// O horário programado mais recente que já passou (hora local do servidor, como o agendador sempre usou).
export function lastScheduledSlot(schedule: UpdateSchedule, now: Date): Date | null {
  if (!schedule.frequency) return null;
  let best: Date | null = null;
  for (let back = 0; back <= 2; back++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    if (!dayMatches(schedule, day)) continue;
    for (const time of schedule.timesOfDay) {
      const t = parseTime(time);
      if (!t) continue;
      const slot = new Date(day.getFullYear(), day.getMonth(), day.getDate(), t.h, t.m, 0, 0);
      if (slot.getTime() <= now.getTime() && (!best || slot.getTime() > best.getTime())) best = slot;
    }
  }
  return best;
}

// Há uma atualização programada pendente? Sim quando o último horário já passou (dentro da janela de recuperação)
// e nenhuma atualização terminou depois dele. Antes o painel só atualizava se o Hub estivesse de pé no MINUTO
// exato; agora um reinício/deploy nesse minuto não perde mais a atualização.
export function isUpdateDue(input: {
  schedule: UpdateSchedule;
  lastUpdateAt: Date | null;
  now: Date;
  catchUpMs: number;
}): boolean {
  const slot = lastScheduledSlot(input.schedule, input.now);
  if (!slot) return false;
  if (input.now.getTime() - slot.getTime() > input.catchUpMs) return false;
  if (input.lastUpdateAt && input.lastUpdateAt.getTime() >= slot.getTime()) return false;
  return true;
}

// Painel parado de propósito (um administrador o parou, ou o processo saiu sem erro) não deve ser atualizado nem gerar
// alerta: não há o que atualizar. Painel que CAIU ('error') ou está no ar ('running') segue a regra normal, e o
// painel que cai e não volta é justamente o que a Inovação precisa saber. Painel sem processo (tipo html) não tem status.
export function isIntentionallyStopped(streamlitStatus: string | null | undefined): boolean {
  return streamlitStatus === 'stopped';
}

const MAX_ERROR_CHARS = 500;

function squash(text: string, max = MAX_ERROR_CHARS): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

// Texto curto e legível para o motivo da falha (o "fetch failed" puro não diz nada: a causa fica em err.cause).
export function describeUpdateError(err: unknown, bodySnippet?: string): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return 'A atualização passou do tempo limite e foi interrompida.';
    }
    const cause = err.cause ? ` (causa: ${squash(String((err.cause as { code?: string }).code ?? err.cause), 120)})` : '';
    const body = bodySnippet ? ` — ${squash(bodySnippet, 300)}` : '';
    return squash(`${err.message}${cause}${body}`);
  }
  return squash(String(err));
}
