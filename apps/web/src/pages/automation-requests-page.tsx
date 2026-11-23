import { ChevronRight, ExternalLink, Search, Send, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { Field } from '../components/field';
import { PageHeader } from '../components/page-header';
import { RequestTypeSwitch } from '../components/request-type-switch';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { useAuth } from '../contexts/auth-context';
import { useHub } from '../contexts/hub-context';
import { api } from '../lib/api';
import type {
  AutomationRequest,
  AutomationRequestCadence,
  AutomationRequestStatus,
  AutomationRequestUrgency,
} from '../lib/types';
import {
  automationRequestCadenceLabel,
  automationRequestStatusLabel,
  automationRequestUrgencyLabel,
  cn,
  formatDate,
} from '../lib/utils';

type Draft = {
  title: string;
  systemName: string;
  description: string;
  urgency: AutomationRequestUrgency;
  cadence: AutomationRequestCadence;
  requiresLogin: boolean;
  requiresCertificate: boolean;
  requiresCaptcha: boolean;
};

type BoardColumn = {
  status: AutomationRequestStatus;
  title: string;
  accent: string;
};

const STATUS_OPTIONS: Array<{ value: AutomationRequestStatus; label: string }> = [
  { value: 'pending', label: 'Pendente' },
  { value: 'review', label: 'Em analise' },
  { value: 'approved', label: 'Aprovado' },
  { value: 'in_progress', label: 'Em desenvolvimento' },
  { value: 'done', label: 'Concluido' },
  { value: 'rejected', label: 'Recusado' },
];

const URGENCY_OPTIONS: Array<{ value: AutomationRequestUrgency; label: string }> = [
  { value: 'low', label: 'Baixa' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'Alta' },
  { value: 'urgent', label: 'Urgente' },
];

const CADENCE_OPTIONS: Array<{ value: AutomationRequestCadence; label: string }> = [
  { value: 'once', label: 'Avulsa' },
  { value: 'daily', label: 'Diaria' },
  { value: 'weekly', label: 'Semanal' },
  { value: 'monthly', label: 'Mensal' },
];

const BOARD_COLUMNS: BoardColumn[] = [
  { status: 'pending', title: 'Pendente', accent: 'bg-amber-400' },
  { status: 'review', title: 'Em analise', accent: 'bg-indigo-400' },
  { status: 'approved', title: 'Aprovado', accent: 'bg-emerald-400' },
  { status: 'in_progress', title: 'Em desenvolvimento', accent: 'bg-sky-400' },
  { status: 'done', title: 'Concluido', accent: 'bg-zinc-400' },
  { status: 'rejected', title: 'Recusados', accent: 'bg-rose-400' },
];

function statusTone(status: AutomationRequestStatus) {
  switch (status) {
    case 'pending':
      return 'bg-amber-400';
    case 'review':
      return 'bg-indigo-400';
    case 'approved':
      return 'bg-emerald-400';
    case 'in_progress':
      return 'bg-sky-400';
    case 'done':
      return 'bg-zinc-400';
    case 'rejected':
      return 'bg-rose-400';
    default:
      return 'bg-slate-400';
  }
}

export function AutomationRequestsPage() {
  const { user } = useAuth();
  const { notify, refreshRequestsPending } = useHub();
  const location = useLocation();
  const [requests, setRequests] = useState<AutomationRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [selectedRequest, setSelectedRequest] = useState<AutomationRequest | null>(null);
  // Arrastar entre colunas: pedido sendo arrastado, coluna sob o mouse e pedido esperando o motivo da recusa.
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStatus, setOverStatus] = useState<AutomationRequestStatus | null>(null);
  const [rejectTarget, setRejectTarget] = useState<AutomationRequest | null>(null);

  const isBoardView = location.pathname === '/admin/quadro';
  const canManageRequests = user?.role === 'admin' || user?.departments.includes('inovacao') === true;

  useEffect(() => {
    if (isBoardView) {
      void loadRequests();
    }
  }, [isBoardView]);

  const filteredRequests = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return requests;

    return requests.filter((request) =>
      [
        request.title,
        request.systemName ?? '',
        request.description,
        request.requesterName,
        request.requesterEmail,
        automationRequestStatusLabel(request.status),
      ].some((value) => value.toLowerCase().includes(term)),
    );
  }, [query, requests]);

  const boardColumns = useMemo(
    () =>
      BOARD_COLUMNS.map((column) => ({
        ...column,
        items: filteredRequests.filter((request) => request.status === column.status),
      })),
    [filteredRequests],
  );

  async function loadRequests(silent = false) {
    try {
      if (!silent) setLoading(true);
      const data = await api<AutomationRequest[]>('/automation-requests');
      setRequests(data);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Nao foi possivel carregar os pedidos.');
    } finally {
      if (!silent) setLoading(false);
    }
  }

  async function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!draft.description.trim()) {
      notify('Descreva o que precisa ser automatizado.');
      return;
    }

    try {
      setSaving(true);
      await api('/automation-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      setDraft(emptyDraft());
      notify('Pedido enviado. Acompanhe o andamento em "Meus pedidos".');
      await loadRequests();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Nao foi possivel enviar o pedido.');
    } finally {
      setSaving(false);
    }
  }

  async function saveRequest(id: string, payload: { status: AutomationRequestStatus; statusNote?: string }) {
    try {
      setSavingId(id);
      await api(`/automation-requests/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      notify('Pedido atualizado.');
      await loadRequests(true);
      void refreshRequestsPending();
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível atualizar o pedido.');
      return false;
    } finally {
      setSavingId(null);
    }
  }

  // Solta o card numa coluna: o card troca de lugar na hora e volta se o servidor recusar.
  async function moveRequest(request: AutomationRequest, status: AutomationRequestStatus, statusNote?: string) {
    if (request.status === status) return true;
    const previous = requests;
    setRequests((current) =>
      current.map((item) => (item.id === request.id ? { ...item, status, statusNote: statusNote ?? null } : item)),
    );
    try {
      await api(`/automation-requests/${request.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, ...(statusNote ? { statusNote } : {}) }),
      });
      void loadRequests(true);
      void refreshRequestsPending();
      return true;
    } catch (error) {
      setRequests(previous);
      notify(error instanceof Error ? error.message : 'Não foi possível mover o pedido.');
      return false;
    }
  }

  function dropOn(status: AutomationRequestStatus) {
    const request = requests.find((item) => item.id === dragId);
    setDragId(null);
    setOverStatus(null);
    if (!request || request.status === status) return;
    // Recusar abre a janela do motivo (opcional): o card só se move depois que ela é confirmada.
    if (status === 'rejected') {
      setRejectTarget(request);
      return;
    }
    void moveRequest(request, status);
  }

  async function deleteRequest(id: string) {
    try {
      setSavingId(id);
      await api(`/automation-requests/${id}`, { method: 'DELETE' });
      notify('Pedido excluído.');
      setRequests((current) => current.filter((item) => item.id !== id));
      void refreshRequestsPending();
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível excluir o pedido.');
      return false;
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title={
          isBoardView ? (
            <>
              Quadro <span className="text-sky-600 dark:text-sky-400">de pedidos</span>
            </>
          ) : (
            <>
              Solicitar <span className="text-sky-600 dark:text-sky-400">automação</span>
            </>
          )
        }
        description={
          isBoardView
            ? 'Pedidos internos para a triagem do time de administraçao e inovação.'
            : 'Isso aqui e um pre-pedido rapido. Escreva o basico e depois a gente entra em contato para entender melhor o fluxo e, se fizer sentido, pedir video, prints ou acesso.'
        }
      />

      {!isBoardView ? <RequestTypeSwitch current="automation" /> : null}

      {!isBoardView ? (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.15fr_0.85fr]">
          <Card className="rounded-3xl">
            <CardHeader>
              <CardTitle>Descreva o pedido</CardTitle>
              <p className="text-sm text-slate-500 dark:text-zinc-400">
                Quanto mais claro for o contexto, mais rapido fica para avaliar se o processo e automatizavel.
              </p>
            </CardHeader>
            <CardContent>
              <form className="grid grid-cols-1 gap-4" onSubmit={(event) => void submitRequest(event)}>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <Field label="Titulo do pedido" hint="Uma frase curta que ajude a identificar o problema">
                    <Input
                      value={draft.title}
                      onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                      placeholder="Ex.: Conferencia de notas na SEFAZ"
                    />
                  </Field>
                  <Field label="Site ou app desktop" hint="So para sabermos onde acontece o processo">
                    <Input
                      value={draft.systemName}
                      onChange={(event) => setDraft((current) => ({ ...current, systemName: event.target.value }))}
                      placeholder="Ex.: SEFAZ-CE, sistema interno, app desktop"
                    />
                  </Field>
                </div>

                <Field
                  label="Resumo do que precisa"
                  hint="Em poucas linhas: o que a pessoa faz hoje, o que quer ganhar e o que costuma atrapalhar."
                >
                  <Textarea
                    className="min-h-36"
                    value={draft.description}
                    onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
                    placeholder="Ex.: a pessoa acessa o site, consulta dados da empresa, baixa um relatorio e salva na pasta correta..."
                  />
                </Field>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  <Field label="Urgencia">
                    <select
                      className="flex h-10 w-full rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100"
                      value={draft.urgency}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, urgency: event.target.value as AutomationRequestUrgency }))
                      }
                    >
                      {URGENCY_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </Field>

                  <Field label="Frequencia">
                    <select
                      className="flex h-10 w-full rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100"
                      value={draft.cadence}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, cadence: event.target.value as AutomationRequestCadence }))
                      }
                    >
                      {CADENCE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </Field>

                  <div className="grid gap-2">
                    <span className="text-sm font-medium text-slate-700 dark:text-zinc-200">Pre-requisitos</span>
                    <div className="flex flex-wrap gap-3">
                      <CheckPill
                        label="Login"
                        checked={draft.requiresLogin}
                        onToggle={(checked) => setDraft((current) => ({ ...current, requiresLogin: checked }))}
                      />
                      <CheckPill
                        label="Certificado"
                        checked={draft.requiresCertificate}
                        onToggle={(checked) => setDraft((current) => ({ ...current, requiresCertificate: checked }))}
                      />
                      <CheckPill
                        label="Captcha"
                        checked={draft.requiresCaptcha}
                        onToggle={(checked) => setDraft((current) => ({ ...current, requiresCaptcha: checked }))}
                      />
                    </div>
                    <span className="text-xs text-slate-500 dark:text-zinc-400">Marque o que ja aparece no caminho do usuario.</span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                  <p className="text-xs text-slate-500 dark:text-zinc-400">
                    Isso e so o primeiro passo. Depois vamos entrar em contato para detalhar o processo com calma.
                  </p>
                  <Button type="submit" disabled={saving}>
                    <Send className="mr-2 h-4 w-4" />
                    {saving ? 'Enviando...' : 'Enviar pedido'}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card className="rounded-3xl">
            <CardHeader>
              <CardTitle>Como funciona</CardTitle>
              <p className="text-sm text-slate-500 dark:text-zinc-400">
                A ideia é receber o básico rápido e seguir com o contato quando a gente precisar detalhar melhor.
              </p>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-slate-600 dark:text-zinc-300">
              <InfoRow title="1. ENVIE O RESUMO" text="Coloque o título do pedido, o sistema envolvido e o que precisa ser automatizado." />
              <InfoRow title="2. A GENTE ANALISA" text="Depois verificamos a melhor forma de entender o fluxo e os detalhes necessários." />
              <InfoRow title="3. ACOMPANHAMENTO" text="As etapas do processo vão aparecer nas notificações do sistema." />
            </CardContent>
          </Card>
        </div>
      ) : null}

      {isBoardView ? (
        <Card className="rounded-3xl">
          <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>Quadro de pedidos</CardTitle>
              <p className="text-sm text-slate-500 dark:text-zinc-400">
                Arraste os pedidos entre as colunas para mudar a situação. Quem pediu é avisado a cada mudança.
              </p>
            </div>

            <div className="relative w-full sm:max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                className="h-10 pl-9"
                placeholder="Buscar pedido..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </CardHeader>

          <CardContent>
            {loading ? (
              <div className="grid gap-4 pb-2 [grid-template-columns:repeat(auto-fit,minmax(15.75rem,1fr))]">
                {[1, 2, 3, 4, 5].map((item) => (
                  <div
                    key={item}
                    className="h-[22rem] w-full shrink-0 rounded-[28px] border border-slate-200/80 bg-slate-100/70 dark:border-white/10 dark:bg-slate-800/50 xl:w-[15.75rem]"
                  />
                ))}
              </div>
            ) : filteredRequests.length === 0 ? (
              <div className="py-16 text-center">
                <Send className="mx-auto mb-4 h-10 w-10 text-slate-300 dark:text-zinc-600" />
                <p className="text-sm text-slate-500 dark:text-zinc-400">
                  {query ? 'Nenhum pedido encontrado para essa busca.' : 'Nenhum pedido foi registrado ainda.'}
                </p>
              </div>
            ) : (
              <div className="space-y-5">
                <div className="grid items-start gap-4 pb-2 [grid-template-columns:repeat(auto-fit,minmax(15rem,1fr))]">
                  {boardColumns.map((column) => (
                    <section
                      key={column.status}
                      onDragOver={(event) => {
                        if (!dragId) return;
                        event.preventDefault();
                        setOverStatus(column.status);
                      }}
                      onDragLeave={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOverStatus(null);
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        dropOn(column.status);
                      }}
                      className={cn(
                        'flex min-h-[22rem] w-full flex-col rounded-[24px] border bg-white p-2.5 transition dark:bg-[#0f0f10]',
                        dragId && overStatus === column.status
                          ? 'border-sky-400 bg-sky-50/60 dark:border-sky-500/60 dark:bg-sky-950/20'
                          : 'border-slate-200/80 dark:border-white/10',
                      )}
                    >
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="truncate text-[0.92rem] font-semibold text-slate-900 dark:text-white">{column.title}</h3>
                          <div className={cn('mt-1 h-1 w-10 rounded-full', column.accent)} />
                        </div>
                        <Badge variant="muted" className="rounded-full px-2.5 py-1 text-xs">
                          {column.items.length}
                        </Badge>
                      </div>

                      <div className="flex flex-1 flex-col gap-3">
                        {column.items.map((request) => (
                          <AutomationRequestCard
                            key={request.id}
                            request={request}
                            onOpen={() => setSelectedRequest(request)}
                            dragging={dragId === request.id}
                            onDragStart={() => setDragId(request.id)}
                            onDragEnd={() => {
                              setDragId(null);
                              setOverStatus(null);
                            }}
                            compact
                          />
                        ))}

                        {column.items.length === 0 ? (
                          <div className="flex flex-1 items-center justify-center rounded-[22px] border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-400 dark:border-white/10 dark:bg-white/[0.02] dark:text-zinc-500">
                            Nenhum pedido nesta coluna.
                          </div>
                        ) : null}
                      </div>
                    </section>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      {isBoardView && selectedRequest ? (
        <AutomationRequestModal
          request={selectedRequest}
          canManageRequests={canManageRequests}
          saving={savingId === selectedRequest.id}
          onClose={() => setSelectedRequest(null)}
          onSave={async (payload) => {
            const saved = await saveRequest(selectedRequest.id, payload);
            if (saved) {
              setSelectedRequest(null);
            }
          }}
          onDelete={async () => {
            const deleted = await deleteRequest(selectedRequest.id);
            if (deleted) {
              setSelectedRequest(null);
            }
          }}
        />
      ) : null}

      {isBoardView && rejectTarget ? (
        <RejectDialog
          request={rejectTarget}
          onCancel={() => setRejectTarget(null)}
          onConfirm={async (reason) => {
            const target = rejectTarget;
            setRejectTarget(null);
            await moveRequest(target, 'rejected', reason);
          }}
        />
      ) : null}
    </div>
  );
}

function AutomationRequestCard({
  request,
  onOpen,
  onDragStart,
  onDragEnd,
  dragging = false,
  compact = false,
}: {
  request: AutomationRequest;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  dragging?: boolean;
  compact?: boolean;
}) {
  return (
    <Card
      draggable
      onDragStart={(event) => {
        // O Firefox so inicia o arrasto se houver algum dado no dataTransfer.
        event.dataTransfer.setData('text/plain', request.id);
        event.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={cn(
        'cursor-grab overflow-hidden rounded-[12px] border-slate-200/80 bg-white shadow-none transition hover:border-slate-300 active:cursor-grabbing dark:border-white/10 dark:bg-[#111113] dark:hover:border-white/20',
        compact && 'bg-white dark:bg-[#111113]',
        dragging && 'opacity-40',
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition hover:bg-slate-50 dark:hover:bg-white/[0.03]"
      >
        <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full opacity-70', statusTone(request.status))} />

        <div className="min-w-0 flex-1">
          <h4 className={cn('truncate font-semibold tracking-tight text-slate-950 dark:text-white', compact ? 'text-sm' : 'text-base')}>
            {request.title}
          </h4>
        </div>

        <ChevronRight className="h-4 w-4 shrink-0 text-slate-400 dark:text-zinc-500" />
      </button>
    </Card>
  );
}

function AutomationRequestModal({
  request,
  canManageRequests,
  saving,
  onClose,
  onSave,
  onDelete,
}: {
  request: AutomationRequest;
  canManageRequests: boolean;
  saving: boolean;
  onClose: () => void;
  onSave: (payload: { status: AutomationRequestStatus; statusNote?: string }) => void;
  onDelete: () => void;
}) {
  const [status, setStatus] = useState<AutomationRequestStatus>(request.status);
  const [note, setNote] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const changed = status !== request.status;
  const rejecting = changed && status === 'rejected';

  useEffect(() => {
    setStatus(request.status);
    setNote('');
    setConfirmingDelete(false);
  }, [request.id, request.status]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const preRequisites = [
    request.requiresLogin ? 'Precisa de login' : null,
    request.requiresCertificate ? 'Precisa de certificado' : null,
    request.requiresCaptcha ? 'Possui captcha' : null,
  ].filter(Boolean) as string[];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6">
      <button
        type="button"
        aria-label="Fechar modal"
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      <div className="relative z-10 w-full max-w-3xl overflow-hidden rounded-[10px] border border-slate-200 bg-white shadow-2xl dark:border-white/10 dark:bg-[#0f0f10]">
        <div className={cn('h-1.5 w-full', statusTone(status))} />

        <div className="border-b border-slate-200/80 bg-gradient-to-r from-slate-50 to-white px-5 py-4 dark:border-white/10 dark:from-white/[0.04] dark:to-white/[0.02]">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full opacity-70', statusTone(status))} />
                <h3 className="truncate text-xl font-semibold text-slate-950 dark:text-white">
                  Pedido por: {request.requesterName}
                </h3>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-500 dark:text-zinc-400">
                <span className="font-medium text-slate-700 dark:text-zinc-300">Pedido:</span>
                <span>{request.title}</span>
                <span className="text-slate-300 dark:text-zinc-600">|</span>
                <span className="font-medium text-slate-700 dark:text-zinc-300">Criado em:</span>
                <span>{formatDate(request.createdAt)}</span>
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={onClose} className="shrink-0 px-2">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="grid gap-4 px-5 py-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,0.65fr)]">
          <div className="space-y-4">
            <section className="rounded-[8px] border border-slate-200 bg-slate-50 p-4 dark:border-white/10 dark:bg-white/[0.03]">
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-zinc-400">
                Resumo do pedido
              </div>
              <p className="whitespace-pre-wrap text-sm leading-6 text-slate-700 dark:text-zinc-200">{request.description}</p>
            </section>

            <section className="rounded-[8px] border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-[#111113]">
              <div className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-zinc-400">
                Informacoes do pedido
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <DetailBlock label="Status" value={automationRequestStatusLabel(request.status)} />
                <DetailBlock
                  label="Prioridade"
                  value={automationRequestUrgencyLabel(request.urgency)}
                />
                <DetailBlock label="Frequencia" value={automationRequestCadenceLabel(request.cadence)} />
              </div>
            </section>

            {request.statusNote ? (
              <section className="rounded-[8px] border border-slate-200 bg-slate-50 p-4 dark:border-white/10 dark:bg-white/[0.03]">
                <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-zinc-400">
                  {request.status === 'rejected' ? 'Motivo da recusa' : 'Mensagem para quem pediu'}
                </div>
                <p className="whitespace-pre-wrap text-sm leading-6 text-slate-700 dark:text-zinc-200">{request.statusNote}</p>
              </section>
            ) : null}

            <section className="rounded-[8px] border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-[#111113]">
              <div className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-zinc-400">
                O que ja sabemos
              </div>

              <div className="space-y-3 text-sm text-slate-700 dark:text-zinc-200">
                {preRequisites.length > 0 ? (
                  <div className="rounded-[8px] border border-slate-200 bg-slate-50 px-4 py-3 dark:border-white/10 dark:bg-white/[0.03]">
                    <span className="font-medium text-slate-900 dark:text-white">Pre-requisitos:</span>{' '}
                    {preRequisites.join(', ')}
                  </div>
                ) : (
                  <div className="rounded-[8px] border border-slate-200 bg-slate-50 px-4 py-3 text-slate-500 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-400">
                    Nenhum pre-requisito informado.
                  </div>
                )}

                {request.portalUrl ? (
                  <div className="rounded-[8px] border border-slate-200 bg-slate-50 px-4 py-3 dark:border-white/10 dark:bg-white/[0.03]">
                    <div className="mb-1 font-medium text-slate-900 dark:text-white">Link informado</div>
                    <Button asChild variant="outline" size="sm">
                      <a href={request.portalUrl} target="_blank" rel="noreferrer">
                        <ExternalLink className="mr-2 h-3.5 w-3.5" />
                        Abrir link informado
                      </a>
                    </Button>
                  </div>
                ) : null}
              </div>
            </section>
          </div>

          <aside className="rounded-[8px] border border-slate-200 bg-white p-4 dark:border-white/10 dark:bg-[#111113]">
            <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-zinc-400">
              Atualizar status
            </div>
            {canManageRequests ? (
              <div className="space-y-3">
                <select
                  className="flex h-10 w-full rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15 dark:border-[#2b2b31] dark:bg-[#111113] dark:text-zinc-100"
                  value={status}
                  onChange={(event) => setStatus(event.target.value as AutomationRequestStatus)}
                >
                  {STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>

                {changed ? (
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-700 dark:text-zinc-200" htmlFor="request-status-note">
                      {rejecting ? 'Motivo da recusa (opcional)' : 'Mensagem para quem pediu (opcional)'}
                    </label>
                    <Textarea
                      id="request-status-note"
                      className="min-h-24"
                      maxLength={500}
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder={
                        rejecting
                          ? 'Se quiser, explique por que o pedido foi recusado. Quem pediu vai ver na notificação.'
                          : 'Ex.: previsão, o que ainda precisamos de você...'
                      }
                    />
                  </div>
                ) : null}

                <Button
                  size="sm"
                  className="w-full"
                  onClick={() => onSave({ status, ...(note.trim() ? { statusNote: note.trim() } : {}) })}
                  disabled={saving || !changed}
                >
                  {saving ? 'Salvando...' : 'Salvar status'}
                </Button>

                <div className="border-t border-slate-200 pt-3 dark:border-white/10">
                  {confirmingDelete ? (
                    <div className="space-y-2">
                      <p className="text-xs text-slate-500 dark:text-zinc-400">
                        Excluir apaga o pedido de vez e não dá para desfazer. Quem pediu não é avisado.
                      </p>
                      <div className="flex gap-2">
                        <Button size="sm" variant="danger" className="flex-1" onClick={onDelete} disabled={saving}>
                          Excluir
                        </Button>
                        <Button size="sm" variant="outline" className="flex-1" onClick={() => setConfirmingDelete(false)} disabled={saving}>
                          Cancelar
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="w-full text-rose-600 hover:text-rose-700 dark:text-rose-400"
                      onClick={() => setConfirmingDelete(true)}
                    >
                      <Trash2 className="mr-2 h-3.5 w-3.5" />
                      Excluir pedido
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-500 dark:text-zinc-400">Sem permissao para alterar o status.</p>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

function RejectDialog({
  request,
  onCancel,
  onConfirm,
}: {
  request: AutomationRequest;
  onCancel: () => void;
  onConfirm: (reason: string) => void | Promise<void>;
}) {
  const [reason, setReason] = useState('');

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6">
      <button type="button" aria-label="Cancelar" className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative z-10 w-full max-w-md space-y-4 rounded-[10px] border border-slate-200 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-[#0f0f10]">
        <div>
          <h3 className="text-lg font-semibold text-slate-950 dark:text-white">Recusar pedido</h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-zinc-400">
            {request.title} - {request.requesterName}
          </p>
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-slate-700 dark:text-zinc-200" htmlFor="reject-reason">
            Motivo da recusa (opcional)
          </label>
          <Textarea
            id="reject-reason"
            autoFocus
            className="min-h-28"
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Se quiser, explique por que o pedido foi recusado. Quem pediu vai ver na notificação."
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>
            Cancelar
          </Button>
          <Button variant="danger" onClick={() => void onConfirm(reason.trim())}>
            Recusar pedido
          </Button>
        </div>
      </div>
    </div>
  );
}

function DetailBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[8px] border border-slate-200 bg-slate-50 p-4 dark:border-white/10 dark:bg-white/[0.03]">
      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-zinc-400">{label}</div>
      <div className="mt-1 text-sm text-slate-700 dark:text-zinc-200">{value}</div>
    </div>
  );
}

function InfoRow({ title, text }: { title: string; text: string }) {
  return <DetailBlock label={title} value={text} />;
}

function CheckPill({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!checked)}
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition',
        checked
          ? 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/40 dark:bg-sky-950/60 dark:text-sky-200'
          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-[#2b2b31] dark:bg-[#111113] dark:text-zinc-300 dark:hover:bg-[#18181b]',
      )}
    >
      <span className={cn('h-2.5 w-2.5 rounded-full', checked ? 'bg-sky-500' : 'bg-slate-300 dark:bg-zinc-600')} />
      {label}
    </button>
  );
}

function emptyDraft(): Draft {
  return {
    title: '',
    systemName: '',
    description: '',
    urgency: 'normal',
    cadence: 'once',
    requiresLogin: false,
    requiresCertificate: false,
    requiresCaptcha: false,
  };
}
