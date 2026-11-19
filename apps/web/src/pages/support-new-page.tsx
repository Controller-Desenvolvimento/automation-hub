import { AlertTriangle, Send } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AttachmentBar, useAttachments } from '../components/support-attachments';
import { Field } from '../components/field';
import { PageHeader } from '../components/page-header';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { useHub } from '../contexts/hub-context';
import { api } from '../lib/api';
import {
  HUB_AREAS,
  SUBJECT_LABELS,
  TYPE_LABELS,
  URGENCIES,
  URGENCY_HINTS,
  URGENCY_LABELS,
  type SupportOptions,
  type TicketSubject,
  type TicketType,
  type TicketUrgency,
} from '../lib/support';
import type { Execution } from '../lib/types';
import { cn, formatDate, statusLabel as executionStatusLabel } from '../lib/utils';

type Draft = {
  type: TicketType | '';
  subject: TicketSubject | '';
  hubArea: string;
  robotId: string;
  dashboardId: string;
  urgency: TicketUrgency;
  title: string;
  body: string;
};

const EMPTY: Draft = { type: '', subject: '', hubArea: '', robotId: '', dashboardId: '', urgency: 'medium', title: '', body: '' };
const DRAFT_KEY = 'automation-hub-support-draft';

// O rascunho fica guardado no navegador: sair da tela e voltar não perde o que foi escrito (os anexos não ficam).
function loadDraft(): Draft {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    return raw ? { ...EMPTY, ...(JSON.parse(raw) as Partial<Draft>) } : EMPTY;
  } catch {
    return EMPTY;
  }
}
function saveDraft(draft: Draft) {
  try {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // sem armazenamento: o rascunho simplesmente não é guardado
  }
}
function clearDraft() {
  try {
    window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    // ignora
  }
}
const isEmpty = (d: Draft) => !d.title.trim() && !d.body.trim();

const selectClass =
  'flex h-10 w-full rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100';

export function SupportNewPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const executionId = params.get('execution');
  const { notify, refreshSupportUnread } = useHub();
  const [draft, setDraft] = useState<Draft>(() => (executionId ? EMPTY : loadDraft()));
  const [options, setOptions] = useState<SupportOptions | null>(null);
  const [execution, setExecution] = useState<Execution | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const att = useAttachments(notify);
  const sent = useRef(false);

  useEffect(() => {
    void api<SupportOptions>('/support/options').then(setOptions).catch(() => setOptions({ robots: [], dashboards: [], admins: [] }));
  }, []);

  // "Reportar problema" na tela da execução: o chamado já abre sobre o robô e leva erro, parâmetros (sem senha) e o log.
  useEffect(() => {
    if (!executionId) return;
    api<Execution>(`/executions/${executionId}`)
      .then((data) => {
        setExecution(data);
        setDraft((current) => ({
          ...current,
          type: current.type || 'problem',
          subject: 'robot',
          robotId: data.robot.id,
          urgency: data.status === 'error' ? 'high' : current.urgency,
          title: current.title || (data.status === 'error' ? `${data.robot.name}: execução com erro` : `${data.robot.name}: problema na execução`),
        }));
      })
      .catch((err) => setExecutionError(err instanceof Error ? err.message : 'Não foi possível carregar a execução.'));
  }, [executionId]);

  useEffect(() => {
    if (!executionId && !sent.current) saveDraft(draft);
  }, [draft, executionId]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending) return;
    if (!draft.type) return notify('Escolha o tipo do chamado.');
    if (!draft.subject) return notify('Escolha sobre o que é o chamado.');
    if (draft.title.trim().length < 3) return notify('Dê um título ao chamado.');
    if (!draft.body.trim()) return notify('Descreva o que aconteceu.');

    const form = new FormData();
    form.set('type', draft.type);
    form.set('subject', draft.subject);
    form.set('urgency', draft.urgency);
    form.set('title', draft.title.trim());
    form.set('body', draft.body.trim());
    if (draft.subject === 'hub' && draft.hubArea) form.set('hubArea', draft.hubArea);
    if (draft.subject === 'robot' && draft.robotId) form.set('robotId', draft.robotId);
    if (draft.subject === 'dashboard' && draft.dashboardId) form.set('dashboardId', draft.dashboardId);
    if (executionId) form.set('executionId', executionId);
    att.files.forEach((file) => form.append('files', file));

    setSending(true);
    try {
      const created = await api<{ id: string; number: number }>('/support/tickets', { method: 'POST', body: form });
      sent.current = true;
      clearDraft();
      notify(`Chamado #${created.number} aberto. Você acompanha as respostas aqui, em Suporte.`);
      void refreshSupportUnread();
      navigate(`/support/${created.id}`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Não foi possível abrir o chamado.');
      setSending(false);
    }
  }

  function cancel() {
    if (!isEmpty(draft) || att.files.length > 0) {
      if (!window.confirm('Descartar o que você escreveu neste chamado?')) return;
    }
    sent.current = true;
    clearDraft();
    navigate('/support');
  }

  const optionCard = (active: boolean) =>
    cn(
      'flex cursor-pointer flex-col gap-0.5 rounded-xl border px-4 py-3 text-sm transition focus-within:ring-4 focus-within:ring-sky-500/15',
      active
        ? 'border-sky-500 bg-sky-50 dark:border-sky-500/60 dark:bg-sky-950/30'
        : 'border-slate-300 bg-white hover:bg-slate-50 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:hover:bg-[#18181b]',
    );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Suporte"
        title="Abrir chamado"
        description="Conte o que está acontecendo. Quanto mais claro, mais rápido a Inovação consegue ajudar. Você acompanha tudo na aba Suporte."
      />

      <form onSubmit={submit} className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="rounded-3xl">
          <CardContent className="grid gap-6">
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium text-slate-700 dark:text-zinc-200">O que você quer fazer?</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {(Object.keys(TYPE_LABELS) as TicketType[]).map((type) => (
                  <label key={type} className={optionCard(draft.type === type)}>
                    <input type="radio" name="type" className="sr-only" checked={draft.type === type} onChange={() => set('type', type)} />
                    <span className="font-medium">{TYPE_LABELS[type]}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium text-slate-700 dark:text-zinc-200">Sobre o quê?</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {(Object.keys(SUBJECT_LABELS) as TicketSubject[]).map((subject) => (
                  <label key={subject} className={optionCard(draft.subject === subject)}>
                    <input type="radio" name="subject" className="sr-only" checked={draft.subject === subject} onChange={() => set('subject', subject)} />
                    <span className="font-medium">{SUBJECT_LABELS[subject]}</span>
                  </label>
                ))}
              </div>
              {draft.subject === 'hub' ? (
                <Field label="Qual parte do Hub?">
                  <select className={selectClass} value={draft.hubArea} onChange={(e) => set('hubArea', e.target.value)}>
                    <option value="">Não sei / outra parte</option>
                    {HUB_AREAS.map((area) => (
                      <option key={area} value={area}>{area}</option>
                    ))}
                  </select>
                </Field>
              ) : null}
              {draft.subject === 'robot' ? (
                <Field label="Qual robô?">
                  <select className={selectClass} value={draft.robotId} onChange={(e) => set('robotId', e.target.value)} disabled={!!execution}>
                    <option value="">Não sei / vários</option>
                    {(options?.robots ?? []).map((robot) => (
                      <option key={robot.id} value={robot.id}>{robot.name}</option>
                    ))}
                  </select>
                </Field>
              ) : null}
              {draft.subject === 'dashboard' ? (
                <Field label="Qual painel ou BI?">
                  <select className={selectClass} value={draft.dashboardId} onChange={(e) => set('dashboardId', e.target.value)}>
                    <option value="">Não sei / vários</option>
                    {(options?.dashboards ?? []).map((dash) => (
                      <option key={dash.id} value={dash.id}>{dash.name}</option>
                    ))}
                  </select>
                </Field>
              ) : null}
              {draft.subject === 'other' ? (
                <p className="text-xs text-slate-500 dark:text-zinc-400">
                  Pedido de automação nova? Use <Link to="/automation-requests" className="font-medium text-sky-600 underline dark:text-sky-400">Solicitar automação</Link>.
                  Painel novo? <Link to="/dashboard-requests" className="font-medium text-sky-600 underline dark:text-sky-400">Solicitar dashboard</Link>.
                </p>
              ) : null}
            </fieldset>

            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium text-slate-700 dark:text-zinc-200">Qual a urgência?</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {URGENCIES.map((urgency) => (
                  <label key={urgency} className={optionCard(draft.urgency === urgency)}>
                    <input type="radio" name="urgency" className="sr-only" checked={draft.urgency === urgency} onChange={() => set('urgency', urgency)} />
                    <span className="font-medium">{URGENCY_LABELS[urgency]}</span>
                    <span className="text-xs text-slate-500 dark:text-zinc-400">{URGENCY_HINTS[urgency]}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <Field label="Título" hint="Uma frase que resume o problema.">
              <Input value={draft.title} maxLength={120} onChange={(e) => set('title', e.target.value)} placeholder="Ex.: Robô Gestta parou na linha 5" />
            </Field>

            <div className="grid gap-2">
              <Field label="O que aconteceu?" hint="O que você fez, o que esperava e o que aconteceu. Dica: cole um print aqui com Ctrl+V.">
                <Textarea
                  value={draft.body}
                  maxLength={5000}
                  className="min-h-40"
                  onChange={(e) => set('body', e.target.value)}
                  onPaste={att.onPaste}
                />
              </Field>
              <AttachmentBar att={att} />
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={sending}>
                <Send className="mr-2 h-4 w-4" />
                {sending ? 'Enviando...' : 'Abrir chamado'}
              </Button>
              <Button type="button" variant="outline" onClick={cancel} disabled={sending}>
                Cancelar
              </Button>
              {!executionId && !isEmpty(draft) ? <span className="text-xs text-slate-500 dark:text-zinc-400">Rascunho guardado neste navegador.</span> : null}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          {executionId ? (
            <Card className="rounded-3xl">
              <CardContent className="grid gap-2 text-sm">
                <div className="font-semibold text-slate-900 dark:text-white">Execução que vai junto</div>
                {executionError ? (
                  <p className="flex items-start gap-2 text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    {executionError} O chamado abre normalmente, sem a execução.
                  </p>
                ) : execution ? (
                  <>
                    <div className="text-slate-700 dark:text-zinc-200">{execution.robot.name}</div>
                    <div className="text-xs text-slate-500 dark:text-zinc-400">
                      {executionStatusLabel(execution.status)} · {formatDate(execution.createdAt)}
                    </div>
                    {execution.errorMessage ? (
                      <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/40 dark:text-rose-200">{execution.errorMessage}</p>
                    ) : null}
                    <p className="text-xs text-slate-500 dark:text-zinc-400">
                      A Inovação recebe o erro, os parâmetros que você digitou (senhas ficam de fora) e o fim do log.
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-slate-500">Carregando…</p>
                )}
              </CardContent>
            </Card>
          ) : null}
          <Card className="rounded-3xl">
            <CardContent className="grid gap-2 text-sm text-slate-600 dark:text-zinc-300">
              <div className="font-semibold text-slate-900 dark:text-white">Como funciona</div>
              <p>Só você e a Inovação veem o seu chamado. As respostas aparecem aqui, em Suporte, com um número ao lado do menu e no sino. Não enviamos e-mail.</p>
            </CardContent>
          </Card>
        </div>
      </form>
    </div>
  );
}
