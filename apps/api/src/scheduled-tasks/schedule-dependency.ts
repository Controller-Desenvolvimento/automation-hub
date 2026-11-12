// Dependência entre agendamentos (ex.: "Atualizar Planilhas Excel" depende de "Gestta"). Regras puras.
//
// A execução do agendamento dependente (Excel) entra na fila no horário dela, mas fica RETIDA até o "ciclo" do
// agendamento de que depende (Gestta) terminar:
//   - ciclo = a 1ª execução agendada do Gestta (tentativa 1) + o reinício dela, se houver;
//   - terminou com sucesso → o Excel é liberado;
//   - terminou de qualquer outro jeito (erro, travamento cancelado de vez, teto, cancelado à mão) → o Excel daquele
//     ciclo é pulado (dados antigos não adiantam); no ciclo seguinte tudo recomeça;
//   - ainda rodando, na fila, ou entre "cancelada em T2" e "reinício criado" → pendente (o Excel espera).

import { INTERRUPTED_PREFIX } from '../executions/interrupted';
import { T2_REASON_PREFIX } from './schedule-checks';

export type ExecStatus = 'queued' | 'running' | 'success' | 'error' | 'canceled';

export interface ExecSnap {
  id: string;
  status: ExecStatus;
  attempt: number;
  finishedAt: Date | null;
  errorMessage: string | null;
}

export type CycleState =
  | { state: 'pending' }
  | { state: 'success' }
  // detail = como o ciclo terminou, em uma frase (vem da execução que o encerrou)
  | { state: 'failed'; detail: string };

// Entre cancelar (T2 ou reinício do Hub) e o reinício ser criado passam alguns segundos: nesse intervalo o ciclo
// ainda NÃO falhou. Passando dessa carência sem reinício, falhou de vez.
export const RESTART_GAP_MS = 3 * 60_000;



function describe(e: ExecSnap): string {
  const msg = (e.errorMessage ?? '').replace(/\s+/g, ' ').trim();
  const base = e.status === 'canceled' ? 'foi cancelado' : 'terminou com erro';
  return msg ? `${base}: ${msg.length > 300 ? `${msg.slice(0, 299)}…` : msg}` : base;
}

// Um reinício está a caminho? (a 1ª tentativa foi cancelada em T2 ou interrompida pelo Hub, o agendamento tem
// verificação por tempo, e o reinício ainda não apareceu).
function restartComing(first: ExecSnap, now: Date, restartExpected: boolean): boolean {
  if (!restartExpected || first.attempt !== 1 || !first.finishedAt) return false;
  const msg = first.errorMessage ?? '';
  const byT2 = first.status === 'canceled' && msg.startsWith(T2_REASON_PREFIX);
  const byHubRestart = first.status === 'error' && msg.startsWith(INTERRUPTED_PREFIX);
  if (!byT2 && !byHubRestart) return false;
  return now.getTime() - first.finishedAt.getTime() < RESTART_GAP_MS;
}

export function resolveCycle(input: {
  first: ExecSnap;
  restart: ExecSnap | null;
  now: Date;
  // O agendamento de que se depende tem T0/T1/T2? Só então um reinício é esperado.
  restartExpected: boolean;
}): CycleState {
  const { first, restart, now, restartExpected } = input;
  const last = restart ?? first;

  if (last.status === 'queued' || last.status === 'running') return { state: 'pending' };
  if (last.status === 'success') return { state: 'success' };

  // terminou mal (erro ou cancelada)
  if (!restart && restartComing(first, now, restartExpected)) return { state: 'pending' };
  return { state: 'failed', detail: describe(last) };
}

// Frase usada no histórico, no último erro do agendamento e no e-mail quando um agendamento é pulado.
export function dependencyFailureText(dependencyName: string, detail: string): string {
  return `O agendamento "${dependencyName}" ${detail.replace(/\.$/, '')}.`;
}
