import { CheckCircle2, History, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import {
  URGENCY_LABELS,
  isClosedStatus,
  statusLabel,
  type StatusEvent,
  type TicketStatus,
  type TicketUrgency,
} from '../lib/support';
import { cn, formatDate } from '../lib/utils';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { Textarea } from './ui/textarea';

const IN_PROGRESS: TicketStatus[] = ['review', 'waiting', 'resolved', 'not_issue'];
const REOPEN_OPTIONS: TicketStatus[] = ['open', 'review', 'waiting'];

/** Quem abriu, quem mudou o status, quem resolveu e quem reabriu: o histórico fica à vista, com nome e hora. */
export function StatusHistory({ events, viewer }: { events: StatusEvent[]; viewer: 'author' | 'admin' }) {
  if (events.length < 2) return null;
  return (
    <details className="group text-sm">
      <summary className="inline-flex w-fit cursor-pointer items-center gap-2 text-xs font-medium text-slate-500 transition hover:text-slate-800 dark:text-zinc-400 dark:hover:text-white">
        <History className="h-3.5 w-3.5" />
        Histórico da situação ({events.length})
      </summary>
      <ol className="mt-3 space-y-2 border-l border-slate-200 pl-4 dark:border-[#2b2b31]">
        {events.map((event) => (
          <li key={event.id} className="text-xs text-slate-600 dark:text-zinc-300">
            <span className="font-medium text-slate-800 dark:text-zinc-100">
              {event.opening ? 'Aberto' : event.reopened ? `Reaberto (${statusLabel(event.status, viewer)})` : statusLabel(event.status, viewer)}
            </span>{' '}
            por {event.by} · {formatDate(event.at)}
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Resumo de um chamado encerrado: "Resolvido por Davi em 19/11 09:10 · Urgência Alta". */
export function closedSummary(closing: StatusEvent | null, status: TicketStatus, urgency: TicketUrgency, viewer: 'author' | 'admin') {
  const what = statusLabel(status, viewer);
  const who = closing ? ` por ${closing.by} em ${formatDate(closing.at)}` : '';
  return `${what}${who} · Urgência ${URGENCY_LABELS[urgency]}`;
}

/**
 * Cartão "Situação" da Inovação. Em andamento: as opções de status (encerrar pede confirmação). Encerrado: as opções somem e fica o
 * resumo (quem resolveu, quando, urgência) com o botão "Reabrir chamado", que abre o painel de reabertura com confirmação.
 */
export function SituationCard({
  status,
  urgency,
  authorConfirmed,
  events,
  closing,
  busy,
  onApply,
}: {
  status: TicketStatus;
  urgency: TicketUrgency;
  authorConfirmed: boolean;
  events: StatusEvent[];
  closing: StatusEvent | null;
  busy: boolean;
  /** Aplica o status (com uma mensagem opcional para quem abriu). Devolve true se deu certo. */
  onApply: (status: TicketStatus, message?: string) => Promise<boolean>;
}) {
  const closed = isClosedStatus(status);
  const [pendingClose, setPendingClose] = useState<TicketStatus | null>(null);
  const [reopening, setReopening] = useState(false);
  const [reopenTo, setReopenTo] = useState<TicketStatus>('review');
  const [message, setMessage] = useState('');

  async function confirmClose() {
    if (!pendingClose) return;
    if (await onApply(pendingClose)) setPendingClose(null);
  }

  async function confirmReopen() {
    if (await onApply(reopenTo, message.trim() || undefined)) {
      setReopening(false);
      setMessage('');
      setReopenTo('review');
    }
  }

  return (
    <Card className="rounded-3xl">
      <CardContent className="grid gap-3">
        <div className="text-sm font-semibold text-slate-900 dark:text-white">Situação</div>

        {closed ? (
          <>
            <div className="flex flex-wrap items-center gap-3 text-sm text-slate-700 dark:text-zinc-200">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
              <span className="font-medium">{closedSummary(closing, status, urgency, 'admin')}</span>
              {authorConfirmed ? <span className="text-xs text-emerald-700 dark:text-emerald-300">Quem abriu confirmou.</span> : null}
              {!reopening ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setReopening(true)}>
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                  Reabrir chamado
                </Button>
              ) : null}
            </div>
            {reopening ? (
              <div className="grid gap-3 rounded-xl border border-slate-200 p-4 dark:border-[#2b2b31]">
                <fieldset className="grid gap-2">
                  <legend className="text-xs font-medium text-slate-500">Reabrir como</legend>
                  <div className="flex flex-wrap gap-2">
                    {REOPEN_OPTIONS.map((option) => (
                      <label
                        key={option}
                        className={cn(
                          'cursor-pointer rounded-lg border px-3 py-1.5 text-sm transition',
                          reopenTo === option ? 'border-sky-500 bg-sky-50 dark:bg-sky-950/30' : 'border-slate-300 hover:bg-slate-50 dark:border-[#2b2b31] dark:hover:bg-[#18181b]',
                        )}
                      >
                        <input type="radio" name="reopen-to" className="sr-only" checked={reopenTo === option} onChange={() => setReopenTo(option)} />
                        {statusLabel(option, 'admin')}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <label className="grid gap-1.5 text-xs font-medium text-slate-500">
                  Mensagem para quem abriu (opcional)
                  <Textarea value={message} maxLength={5000} className="min-h-20 text-sm font-normal" onChange={(e) => setMessage(e.target.value)} placeholder="Ex.: Reabri para ajustar um detalhe que ficou faltando." />
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={busy} onClick={() => void confirmReopen()}>
                    {busy ? 'Reabrindo...' : 'Confirmar reabertura'}
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => { setReopening(false); setMessage(''); }}>
                    Cancelar
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <div role="group" aria-label="Mudar a situação" className="flex flex-wrap gap-2">
              {IN_PROGRESS.map((option) => {
                const current = option === status;
                return (
                  <Button
                    key={option}
                    size="sm"
                    variant={current ? 'default' : 'outline'}
                    aria-pressed={current}
                    disabled={busy || current || pendingClose !== null}
                    onClick={() => (isClosedStatus(option) ? setPendingClose(option) : void onApply(option))}
                  >
                    {statusLabel(option, 'admin')}
                  </Button>
                );
              })}
            </div>
            {pendingClose ? (
              <div className="flex flex-wrap items-center gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
                <span>
                  Marcar como <strong>{statusLabel(pendingClose, 'admin')}</strong>? O chamado fica encerrado e quem abriu é avisado (pode confirmar ou reabrir).
                </span>
                <Button size="sm" disabled={busy} onClick={() => void confirmClose()}>{busy ? 'Salvando...' : 'Confirmar'}</Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setPendingClose(null)}>Cancelar</Button>
              </div>
            ) : null}
          </>
        )}

        <StatusHistory events={events} viewer="admin" />
      </CardContent>
    </Card>
  );
}
