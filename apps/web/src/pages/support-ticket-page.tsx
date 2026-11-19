import { ArrowLeft, CheckCircle2, ExternalLink, Link2, Send, Unlink } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AttachmentBar, AttachmentView, useAttachments } from '../components/support-attachments';
import { StatusBadge, UrgencyBadge } from '../components/support-badges';
import { SupportMergeDialog } from '../components/support-merge-dialog';
import { SituationCard, StatusHistory, closedSummary } from '../components/support-situation';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Textarea } from '../components/ui/textarea';
import { useAuth } from '../contexts/auth-context';
import { useHub } from '../contexts/hub-context';
import { api } from '../lib/api';
import {
  TYPE_LABELS,
  URGENCIES,
  URGENCY_LABELS,
  isClosedStatus,
  lastClosing,
  statusHistory,
  subjectText,
  type SupportOptions,
  type TicketDetail,
  type TicketMessage,
  type TicketRow,
  type TicketStatus,
  type TicketUrgency,
} from '../lib/support';
import { cn, departmentLabel, formatDate, timeAgo } from '../lib/utils';

const selectClass =
  'h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15 disabled:opacity-60 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100';

export function SupportTicketPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { notify, departments, refreshSupportUnread } = useHub();
  const isAdmin = user?.role === 'admin' || user?.departments.includes('inovacao') === true;
  const viewer = isAdmin ? 'admin' : 'author';

  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [options, setOptions] = useState<SupportOptions | null>(null);
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [alsoLinked, setAlsoLinked] = useState(true);
  // Quem abriu um chamado encerrado só escreve depois de clicar em "Reabrir chamado" (e explica o motivo).
  const [reopening, setReopening] = useState(false);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mergeIds, setMergeIds] = useState<string[] | null>(null);
  const att = useAttachments(notify);
  const endRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const data = await api<TicketDetail>(`/support/tickets/${id}`);
      setTicket(data);
      setLoadError(null);
      void refreshSupportUnread();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Não foi possível carregar o chamado.');
    }
  }, [id, refreshSupportUnread]);

  useEffect(() => {
    setTicket(null);
    void load();
    const timer = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!isAdmin) return;
    void api<SupportOptions>('/support/options').then(setOptions).catch(() => undefined);
  }, [isAdmin, id]);

  useEffect(() => {
    // Mensagem nova: rola até o fim da conversa (só quando o número de mensagens muda).
    const count = ticket?.messages.length ?? 0;
    if (count > lastCount.current && lastCount.current > 0) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    lastCount.current = count;
  }, [ticket?.messages.length]);

  const similar = ticket?.similar ?? [];

  if (loadError) {
    return (
      <div className="space-y-4">
        <Link to="/support" className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-white">
          <ArrowLeft className="h-4 w-4" /> Voltar para Suporte
        </Link>
        <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-200">{loadError}</p>
      </div>
    );
  }
  if (!ticket) {
    return <div className="h-40 animate-pulse rounded-3xl bg-slate-100 dark:bg-slate-800/60" />;
  }

  const closed = ticket.status === 'resolved' || ticket.status === 'not_issue';
  const linkedCount = ticket.linked?.length ?? 0;
  // Quem abriu e o chamado está encerrado: sem caixa de resposta (evita um "obrigado" reabrir sem querer); só o formulário de reabrir.
  const showReplyBox = isAdmin || !closed || reopening;
  // Quem abriu, quem mudou o status, quem resolveu e quem reabriu (vem das linhas de status da conversa).
  const events = statusHistory(ticket.messages, { at: ticket.createdAt, by: ticket.author?.name ?? user?.name ?? 'Quem abriu' });
  const closing = lastClosing(events, ticket.status);

  async function patch(data: Record<string, unknown>, okMessage?: string) {
    if (!ticket || busy) return;
    setBusy(true);
    try {
      await api(`/support/tickets/${ticket.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      if (okMessage) notify(okMessage);
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Não foi possível salvar.');
    } finally {
      setBusy(false);
    }
  }

  async function applyStatus(status: TicketStatus, message?: string): Promise<boolean> {
    if (!ticket || busy) return false;
    setBusy(true);
    try {
      if (message) {
        const form = new FormData();
        form.set('body', message);
        form.set('status', status);
        await api(`/support/tickets/${ticket.id}/messages`, { method: 'POST', body: form });
      } else {
        await api(`/support/tickets/${ticket.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
      }
      notify(isClosedStatus(status) ? 'Chamado encerrado. Quem abriu foi avisado.' : 'Situação atualizada.');
      await load();
      return true;
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Não foi possível salvar.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function confirmResolved() {
    if (!ticket || busy) return;
    setBusy(true);
    try {
      await api(`/support/tickets/${ticket.id}/confirm`, { method: 'POST' });
      notify('Obrigado! Registramos a sua confirmação.');
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Não foi possível concluir.');
    } finally {
      setBusy(false);
    }
  }

  async function send(status?: TicketStatus) {
    if (!ticket || sending) return;
    if (reopening && !body.trim()) return notify('Explique por que o chamado está sendo reaberto.');
    if (!body.trim() && att.files.length === 0) return notify('Escreva uma mensagem ou anexe um arquivo.');
    const form = new FormData();
    form.set('body', body.trim());
    if (isAdmin) {
      if (internal) form.set('internal', 'true');
      if (!internal && linkedCount > 0) form.set('alsoLinked', alsoLinked ? 'true' : 'false');
      if (!internal && status) form.set('status', status);
    }
    att.files.forEach((file) => form.append('files', file));
    setSending(true);
    try {
      await api(`/support/tickets/${ticket.id}/messages`, { method: 'POST', body: form });
      setBody('');
      setInternal(false);
      setReopening(false);
      att.clear();
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Não foi possível enviar.');
    } finally {
      setSending(false);
    }
  }

  async function unlink() {
    if (!ticket || !window.confirm(`Desligar o #${ticket.number} do grupo? Ele volta a ser atendido sozinho.`)) return;
    setBusy(true);
    try {
      await api(`/support/tickets/${ticket.id}/unlink`, { method: 'POST' });
      notify('Chamado desligado do grupo.');
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Não foi possível desligar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Link to="/support" className="inline-flex items-center gap-2 text-sm text-slate-500 transition hover:text-slate-900 dark:text-zinc-400 dark:hover:text-white">
        <ArrowLeft className="h-4 w-4" /> {isAdmin ? 'Todos os chamados' : 'Meus chamados'}
      </Link>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[1.6rem] font-semibold tracking-tight text-slate-950 dark:text-white">
            <span className="text-slate-400">#{ticket.number}</span> {ticket.title}
          </h1>
          <StatusBadge status={ticket.status} viewer={viewer} />
          <UrgencyBadge urgency={ticket.urgency} />
        </div>
        <p className="text-sm text-slate-500 dark:text-zinc-400">
          {TYPE_LABELS[ticket.type]} · {subjectText(ticket)} · aberto {formatDate(ticket.createdAt)}
          {ticket.author ? ` por ${ticket.author.name}` : ''}
        </p>
      </div>

      {isAdmin && ticket.main ? (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-violet-300 bg-violet-50 px-4 py-3 text-sm text-violet-900 dark:border-violet-500/40 dark:bg-violet-950/30 dark:text-violet-100">
          <Link2 className="h-4 w-4" />
          <span>
            Este chamado está ligado ao{' '}
            <Link to={`/support/${ticket.main.id}`} className="font-semibold underline">#{ticket.main.number} {ticket.main.title}</Link>. Responda por lá.
          </span>
          <Button size="sm" variant="outline" onClick={() => void unlink()} disabled={busy}>
            <Unlink className="mr-1.5 h-3.5 w-3.5" /> Desligar
          </Button>
        </div>
      ) : null}

      {isAdmin ? (
        <SituationCard
          status={ticket.status}
          urgency={ticket.urgency}
          authorConfirmed={ticket.authorConfirmed}
          events={events}
          closing={closing}
          busy={busy}
          onApply={applyStatus}
        />
      ) : null}

      {!isAdmin && closed ? (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-950/30 dark:text-emerald-100">
          <CheckCircle2 className="h-5 w-5 shrink-0" />
          {ticket.authorConfirmed ? (
            <>
              <span>{closedSummary(closing, ticket.status, ticket.urgency, 'author')}. Você confirmou. Se voltar a acontecer, reabra o chamado.</span>
              {!reopening ? <Button size="sm" variant="outline" disabled={busy} onClick={() => setReopening(true)}>Reabrir chamado</Button> : null}
            </>
          ) : (
            <>
              <span className="font-medium">{closedSummary(closing, ticket.status, ticket.urgency, 'author')}. {ticket.status === 'resolved' ? 'Resolveu para você?' : 'Você concorda?'}</span>
              <Button size="sm" disabled={busy} onClick={() => void confirmResolved()}>
                {ticket.status === 'resolved' ? 'Sim, obrigado' : 'Sim, concordo'}
              </Button>
              {!reopening ? <Button size="sm" variant="outline" disabled={busy} onClick={() => setReopening(true)}>Ainda acontece (reabrir)</Button> : null}
            </>
          )}
        </div>
      ) : null}
      {!isAdmin && events.length > 1 ? <StatusHistory events={events} viewer="author" /> : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <Card className="rounded-3xl">
            <CardContent className="space-y-4">
              {ticket.messages.map((m) => (
                <MessageItem key={m.id} message={m} ticketAuthorName={ticket.author?.name} notify={notify} />
              ))}
              <div ref={endRef} />
            </CardContent>
          </Card>

          {showReplyBox ? (
          <Card className="rounded-3xl">
            <CardContent className="grid gap-3">
              <label className="text-sm font-medium text-slate-700 dark:text-zinc-200" htmlFor="reply">
                {reopening ? 'Por que está reabrindo o chamado?' : internal ? 'Nota interna (só a Inovação vê)' : 'Responder'}
              </label>
              <Textarea
                id="reply"
                value={body}
                maxLength={5000}
                className={cn('min-h-28', internal && 'border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-950/20')}
                placeholder={reopening ? 'Conte o que ainda acontece. Dica: cole um print com Ctrl+V.' : ticket.status === 'waiting' && !isAdmin ? 'A Inovação está esperando a sua resposta…' : 'Escreva aqui. Dica: cole um print com Ctrl+V.'}
                onChange={(e) => setBody(e.target.value)}
                onPaste={att.onPaste}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send();
                }}
              />
              <AttachmentBar att={att} compact />
              {isAdmin ? (
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
                  <label className="inline-flex items-center gap-2">
                    <input type="checkbox" className="accent-amber-600" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
                    Nota interna
                  </label>
                  {!internal && linkedCount > 0 ? (
                    <label className="inline-flex items-center gap-2">
                      <input type="checkbox" className="accent-sky-600" checked={alsoLinked} onChange={(e) => setAlsoLinked(e.target.checked)} />
                      Enviar também para os {linkedCount} chamados ligados
                    </label>
                  ) : null}
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => void send()} disabled={sending}>
                  <Send className="mr-2 h-4 w-4" />
                  {sending ? 'Enviando...' : reopening ? 'Confirmar reabertura' : internal ? 'Salvar nota' : 'Enviar'}
                </Button>
                {reopening ? (
                  <Button variant="outline" disabled={sending} onClick={() => { setReopening(false); setBody(''); att.clear(); }}>
                    Cancelar
                  </Button>
                ) : null}
                <span className="text-xs text-slate-500 dark:text-zinc-400">Ctrl+Enter também envia.</span>
              </div>
            </CardContent>
          </Card>
          ) : null}
        </div>

        <aside className="space-y-4">
          {isAdmin ? (
            <Card className="rounded-3xl">
              <CardContent className="grid gap-3 text-sm">
                <div className="font-semibold text-slate-900 dark:text-white">Administrar</div>
                <label className="grid gap-1.5">
                  <span className="text-xs font-medium text-slate-500">Urgência</span>
                  <select className={selectClass} value={ticket.urgency} disabled={busy} onChange={(e) => void patch({ urgency: e.target.value as TicketUrgency })}>
                    {URGENCIES.map((u) => <option key={u} value={u}>{URGENCY_LABELS[u]}</option>)}
                  </select>
                </label>
                <label className="grid gap-1.5">
                  <span className="text-xs font-medium text-slate-500">Responsável</span>
                  <select className={selectClass} value={ticket.assignee?.id ?? ''} disabled={busy || !options} onChange={(e) => void patch({ assigneeId: e.target.value || null })}>
                    <option value="">Ninguém</option>
                    {(options?.admins ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </label>
              </CardContent>
            </Card>
          ) : null}

          {isAdmin && ticket.linked && ticket.linked.length > 0 ? (
            <Card className="rounded-3xl">
              <CardContent className="grid gap-2 text-sm">
                <div className="font-semibold text-slate-900 dark:text-white">Chamados ligados ({ticket.linked.length})</div>
                {ticket.linked.map((l) => (
                  <Link key={l.id} to={`/support/${l.id}`} className="rounded-lg border border-slate-200 px-3 py-2 transition hover:bg-slate-50 dark:border-[#2b2b31] dark:hover:bg-[#18181b]">
                    <div className="font-medium text-slate-800 dark:text-zinc-100">#{l.number} {l.author.name}</div>
                    <div className="text-xs text-slate-500 dark:text-zinc-400">{l.author.departments[0] ? departmentLabel(l.author.departments[0], departments) : ''}</div>
                  </Link>
                ))}
              </CardContent>
            </Card>
          ) : null}

          {isAdmin && similar.length > 0 && !ticket.main ? (
            <Card className="rounded-3xl">
              <CardContent className="grid gap-2 text-sm">
                <div className="font-semibold text-slate-900 dark:text-white">Chamados parecidos</div>
                <p className="text-xs text-slate-500 dark:text-zinc-400">Mesmo tipo e mesmo assunto, abertos e com poucos dias de diferença.</p>
                {similar.map((t) => (
                  <Link key={t.id} to={`/support/${t.id}`} className="text-sky-600 underline dark:text-sky-400">#{t.number} {t.title}</Link>
                ))}
                <Button size="sm" variant="outline" onClick={() => setMergeIds([ticket.id])}>
                  <Link2 className="mr-1.5 h-3.5 w-3.5" /> Revisar e juntar
                </Button>
              </CardContent>
            </Card>
          ) : null}

          <Card className="rounded-3xl">
            <CardContent className="grid gap-2 text-sm">
              <div className="font-semibold text-slate-900 dark:text-white">Detalhes</div>
              <Detail label="Tipo" value={TYPE_LABELS[ticket.type]} />
              <Detail label="Assunto" value={subjectText(ticket)} />
              {ticket.author ? (
                <Detail label="Aberto por" value={`${ticket.author.name}${ticket.author.departments[0] ? ` (${departmentLabel(ticket.author.departments[0], departments)})` : ''}`} />
              ) : null}
              <Detail label="Aberto em" value={formatDate(ticket.createdAt)} />
              <Detail label="Última atualização" value={timeAgo(ticket.updatedAt)} />
              {ticket.attachmentsCleanedAt ? <p className="text-xs text-slate-500 dark:text-zinc-400">Os anexos foram apagados 90 dias depois de o chamado ser encerrado. O texto continua.</p> : null}
            </CardContent>
          </Card>

          {ticket.context ? (
            <Card className="rounded-3xl">
              <CardContent className="grid gap-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-semibold text-slate-900 dark:text-white">Execução anexada</div>
                  {ticket.executionId ? (
                    <Button size="sm" variant="ghost" onClick={() => navigate(`/executions/${ticket.executionId}`)}>
                      <ExternalLink className="mr-1.5 h-3.5 w-3.5" /> Abrir
                    </Button>
                  ) : null}
                </div>
                <Detail label="Robô" value={ticket.context.robotName} />
                <Detail label="Situação" value={ticket.context.status} />
                <Detail label="Criada em" value={formatDate(ticket.context.createdAt)} />
                {ticket.context.errorMessage ? (
                  <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/40 dark:text-rose-200">{ticket.context.errorMessage}</p>
                ) : null}
                {Object.keys(ticket.context.parameters).length > 0 || ticket.context.hiddenParameters.length > 0 ? (
                  <div>
                    <div className="text-xs font-medium text-slate-500">Parâmetros digitados</div>
                    <ul className="mt-1 space-y-0.5 text-xs text-slate-700 dark:text-zinc-300">
                      {Object.entries(ticket.context.parameters).map(([key, value]) => (
                        <li key={key}><span className="text-slate-500">{key}:</span> {typeof value === 'string' ? value : JSON.stringify(value)}</li>
                      ))}
                      {ticket.context.hiddenParameters.map((key) => (
                        <li key={key} className="text-slate-400"><span>{key}:</span> ••••• (senha, não enviada)</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {ticket.context.logTail.length > 0 ? (
                  <details>
                    <summary className="cursor-pointer text-xs font-medium text-slate-500">Fim do log ({ticket.context.logTail.length} linhas)</summary>
                    <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-slate-950 p-3 text-[11px] leading-relaxed text-slate-200">
                      {ticket.context.logTail.map((l) => `${l.message}`).join('\n')}
                    </pre>
                  </details>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
        </aside>
      </div>

      {mergeIds ? (
        <SupportMergeDialog
          tickets={[ticket as TicketRow, ...similar]}
          onClose={() => setMergeIds(null)}
          onMerged={async (mainId, count) => {
            setMergeIds(null);
            notify(`${count} chamado${count === 1 ? '' : 's'} ligado${count === 1 ? '' : 's'}.`);
            if (mainId !== ticket.id) navigate(`/support/${mainId}`);
            else await load();
          }}
        />
      ) : null}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-slate-500 dark:text-zinc-400">{label}</span>
      <span className="text-right text-slate-800 dark:text-zinc-100">{value}</span>
    </div>
  );
}

function MessageItem({ message: m, ticketAuthorName, notify }: { message: TicketMessage; ticketAuthorName?: string; notify: (message: string) => void }) {
  if (m.kind === 'system' || m.kind === 'system_admin') {
    return (
      <div className="text-center text-xs text-slate-500 dark:text-zinc-400">
        {m.kind === 'system_admin' ? <span className="mr-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800 dark:bg-amber-950 dark:text-amber-200">só Inovação</span> : null}
        {m.body}{m.author && m.kind === 'system' ? ` (${m.author.name})` : ''} · {formatDate(m.createdAt)}
      </div>
    );
  }
  const internal = m.kind === 'internal';
  const staff = !!m.author?.isStaff;
  return (
    <div className={cn('flex', staff ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[92%] rounded-2xl border px-4 py-3 text-sm',
          internal
            ? 'border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-950/20'
            : staff
              ? 'border-sky-200 bg-sky-50 dark:border-sky-500/30 dark:bg-sky-950/20'
              : 'border-slate-200 bg-white dark:border-[#2b2b31] dark:bg-[#0f0f10]',
        )}
      >
        <div className="mb-1 flex flex-wrap items-center gap-x-2 text-xs text-slate-500 dark:text-zinc-400">
          <span className="font-semibold text-slate-800 dark:text-zinc-100">{m.author?.name ?? ticketAuthorName ?? 'Sistema'}</span>
          {staff ? <span>Inovação</span> : null}
          {internal ? <span className="font-semibold text-amber-700 dark:text-amber-300">nota interna</span> : null}
          {m.fromTicket ? <span className="rounded bg-violet-100 px-1.5 py-0.5 text-violet-700 dark:bg-violet-950 dark:text-violet-200">do chamado #{m.fromTicket.number}</span> : null}
          <span>{formatDate(m.createdAt)}</span>
        </div>
        {m.body ? <p className="whitespace-pre-wrap break-words text-slate-800 dark:text-zinc-100">{m.body}</p> : null}
        {m.attachments.length > 0 ? (
          <div className={cn('flex flex-wrap gap-2', m.body && 'mt-2')}>
            {m.attachments.map((a) => <AttachmentView key={a.id} attachment={a} notify={notify} />)}
          </div>
        ) : null}
      </div>
    </div>
  );
}
