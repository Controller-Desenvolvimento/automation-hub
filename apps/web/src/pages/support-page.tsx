import { ChevronLeft, ChevronRight, LifeBuoy, Link2, Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/page-header';
import { StatusBadge, UrgencyBadge } from '../components/support-badges';
import { SupportMergeDialog } from '../components/support-merge-dialog';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { useAuth } from '../contexts/auth-context';
import { useHub } from '../contexts/hub-context';
import { api } from '../lib/api';
import {
  TYPE_LABELS,
  URGENCIES,
  URGENCY_LABELS,
  formatWait,
  subjectText,
  type TicketList,
  type TicketRow,
  type TicketType,
  type TicketUrgency,
} from '../lib/support';
import { cn, departmentLabel, timeAgo } from '../lib/utils';

type Situation = 'open' | 'closed' | 'all';
type SortKey = 'recent' | 'oldest' | 'urgency';

// Filtros e página: tudo vai para o servidor (a lista é paginada lá, sem limite de chamados).
type Filters = {
  tab: 'all' | 'mine';
  situation: Situation;
  q: string;
  urgency: '' | TicketUrgency;
  person: string;
  department: string;
  type: '' | TicketType;
  robot: string;
  sort: SortKey;
  page: number;
};

const INITIAL: Filters = { tab: 'all', situation: 'open', q: '', urgency: '', person: '', department: '', type: '', robot: '', sort: 'recent', page: 1 };
const PAGE_SIZE = 25;

const selectClass =
  'h-10 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100';

export function SupportPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { notify, departments, refreshSupportUnread } = useHub();
  const isAdmin = user?.role === 'admin' || user?.departments.includes('inovacao') === true;

  const [filters, setFilters] = useState<Filters>(INITIAL);
  // A busca por texto só vai ao servidor depois de uma pausa na digitação.
  const [queryText, setQueryText] = useState('');
  const [data, setData] = useState<TicketList | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // A seleção para juntar vale entre páginas: guarda os ids e os dados dos chamados já vistos.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const known = useRef(new Map<string, TicketRow>());
  const [mergeIds, setMergeIds] = useState<string[] | null>(null);
  const [mergeRows, setMergeRows] = useState<TicketRow[]>([]);
  const requestId = useRef(0);
  const topRef = useRef<HTMLDivElement>(null);

  const update = useCallback((patch: Partial<Filters>) => setFilters((current) => ({ ...current, page: 1, ...patch })), []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (queryText.trim() !== filters.q) update({ q: queryText.trim() });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [queryText, filters.q, update]);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    const params = new URLSearchParams({ page: String(filters.page), pageSize: String(PAGE_SIZE), situation: filters.situation, sort: filters.sort, tab: filters.tab });
    if (filters.q) params.set('q', filters.q);
    if (filters.urgency) params.set('urgency', filters.urgency);
    if (filters.type) params.set('type', filters.type);
    if (filters.person) params.set('person', filters.person);
    if (filters.department) params.set('department', filters.department);
    if (filters.robot) params.set('robot', filters.robot);
    try {
      const result = await api<TicketList>(`/support/tickets?${params.toString()}`);
      if (id !== requestId.current) return; // chegou uma resposta mais nova: esta ficou velha
      result.tickets.forEach((t) => known.current.set(t.id, t));
      result.suggestions?.flat().forEach((t) => known.current.set(t.id, t));
      setData(result);
      setLoadError(null);
      // Foi para uma página que não existe mais (chamados encerrados/filtro): o servidor devolve a última.
      if (result.page !== filters.page) setFilters((current) => ({ ...current, page: result.page }));
    } catch (err) {
      if (id === requestId.current) setLoadError(err instanceof Error ? err.message : 'Não foi possível carregar os chamados.');
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    setLoading(true);
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  function goToPage(page: number) {
    update({ page });
    topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function openMerge(ids: string[]) {
    const rows = ids.map((id) => known.current.get(id)).filter((t): t is TicketRow => !!t);
    setMergeRows(rows);
    setMergeIds(ids);
  }

  const tickets = data?.tickets ?? [];
  const counts = data?.counts ?? { open: 0, closed: 0, all: 0 };
  const total = data?.total ?? 0;
  const kpis = data?.kpis;
  const facets = data?.facets;
  const suggestions = (data?.suggestions ?? []).filter((group) => group.length >= 2);
  const viewer = isAdmin ? 'admin' : 'author';
  const wait = formatWait(kpis?.avgFirstReplySeconds ?? null);
  const filtered = !!(filters.q || filters.urgency || filters.type || filters.person || filters.department || filters.robot || filters.tab === 'mine');
  const firstShown = total === 0 ? 0 : ((data?.page ?? 1) - 1) * PAGE_SIZE + 1;
  const lastShown = firstShown === 0 ? 0 : firstShown + tickets.length - 1;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Suporte"
        title={isAdmin ? 'Chamados' : 'Meus chamados'}
        description={
          isAdmin
            ? 'Todos os chamados abertos pelas pessoas. Responda, mude o status e junte os que são o mesmo problema.'
            : 'Algo não funciona, uma ideia ou uma dúvida? Abra um chamado e acompanhe a resposta por aqui.'
        }
        actions={
          <Button onClick={() => navigate('/support/new')}>
            <Plus className="mr-2 h-4 w-4" />
            Abrir chamado
          </Button>
        }
      />

      {isAdmin && kpis ? (
        <div className="grid grid-cols-2 gap-x-8 gap-y-5 lg:grid-cols-4">
          <Kpi title="Chamados abertos" value={String(kpis.open)} note={`${kpis.openCritical} crítico${kpis.openCritical === 1 ? '' : 's'} · ${kpis.openHigh} de urgência alta`} />
          <Kpi
            title="Sem resposta ainda"
            value={String(kpis.withoutReply)}
            note={kpis.oldestWithoutReplyAt ? `o mais antigo ${timeAgo(kpis.oldestWithoutReplyAt)}` : 'nenhum esperando'}
          />
          <Kpi
            title="Tempo até a 1ª resposta"
            value={wait.value}
            unit={wait.unit}
            note={kpis.firstReplySample ? `média dos últimos 30 dias (${kpis.firstReplySample} chamado${kpis.firstReplySample === 1 ? '' : 's'})` : 'ainda sem respostas nos últimos 30 dias'}
          />
          <Kpi
            title="Robô com mais chamados"
            value={String(kpis.topRobot?.count ?? 0)}
            note={kpis.topRobot ? `${kpis.topRobot.name} (30 dias)` : 'nos últimos 30 dias'}
          />
        </div>
      ) : null}

      {isAdmin && suggestions.length > 0 ? (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-100">
          <div className="font-medium">
            {suggestions.length === 1 ? 'Há chamados parecidos que podem ser o mesmo problema.' : `Há ${suggestions.length} grupos de chamados parecidos.`}
          </div>
          <ul className="mt-2 grid gap-2">
            {suggestions.map((group) => {
              const first = group[0];
              return (
                <li key={group.map((t) => t.id).join('-')} className="flex flex-wrap items-center gap-3">
                  <span>
                    {group.map((t) => `#${t.number}`).join(', ')} — {subjectText(first)} ({TYPE_LABELS[first.type].toLowerCase()})
                  </span>
                  <Button size="sm" variant="outline" onClick={() => openMerge(group.map((t) => t.id))}>
                    <Link2 className="mr-1.5 h-3.5 w-3.5" />
                    Revisar e juntar
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <Card className="rounded-3xl">
        <CardContent className="space-y-4">
          <div ref={topRef} />
          {isAdmin ? (
            <div role="tablist" aria-label="Quais chamados" className="flex gap-2 border-b border-slate-200 pb-3 dark:border-[#2b2b31]">
              {([['all', 'Todos os chamados'], ['mine', 'Atribuídos a mim']] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={filters.tab === value}
                  onClick={() => update({ tab: value })}
                  className={cn(
                    'rounded-lg px-3 py-1.5 text-sm font-medium transition',
                    filters.tab === value ? 'bg-slate-100 text-slate-950 dark:bg-[#1b1b20] dark:text-white' : 'text-slate-500 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-white',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <div role="group" aria-label="Situação" className="inline-flex overflow-hidden rounded-xl border border-slate-300 dark:border-[#2b2b31]">
              {([['open', `Em aberto (${counts.open})`], ['closed', `Encerrados (${counts.closed})`], ['all', `Todos (${counts.all})`]] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={filters.situation === value}
                  onClick={() => update({ situation: value })}
                  className={cn(
                    'px-3 py-2 text-sm transition',
                    filters.situation === value ? 'bg-slate-950 text-white dark:bg-white dark:text-slate-950' : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-[#0f0f10] dark:text-zinc-300 dark:hover:bg-[#18181b]',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input aria-label="Buscar" className="pl-9" placeholder="Buscar por título ou número" value={queryText} onChange={(e) => setQueryText(e.target.value)} />
            </div>
          </div>

          {isAdmin ? (
            <div className="flex flex-wrap items-center gap-2">
              <select aria-label="Urgência" className={selectClass} value={filters.urgency} onChange={(e) => update({ urgency: e.target.value as '' | TicketUrgency })}>
                <option value="">Toda urgência</option>
                {URGENCIES.map((u) => <option key={u} value={u}>{URGENCY_LABELS[u]}</option>)}
              </select>
              <select aria-label="Pessoa" className={selectClass} value={filters.person} onChange={(e) => update({ person: e.target.value })}>
                <option value="">Toda pessoa</option>
                {(facets?.people ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <select aria-label="Departamento" className={selectClass} value={filters.department} onChange={(e) => update({ department: e.target.value })}>
                <option value="">Todo departamento</option>
                {(facets?.departments ?? []).map((d) => <option key={d} value={d}>{departmentLabel(d, departments)}</option>)}
              </select>
              <select aria-label="Tipo" className={selectClass} value={filters.type} onChange={(e) => update({ type: e.target.value as '' | TicketType })}>
                <option value="">Todo tipo</option>
                {(Object.keys(TYPE_LABELS) as TicketType[]).map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
              </select>
              <select aria-label="Robô" className={selectClass} value={filters.robot} onChange={(e) => update({ robot: e.target.value })}>
                <option value="">Todo robô</option>
                {(facets?.robots ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              <select aria-label="Ordenar" className={selectClass} value={filters.sort} onChange={(e) => update({ sort: e.target.value as SortKey })}>
                <option value="recent">Mais recentes primeiro</option>
                <option value="oldest">Mais antigos primeiro</option>
                <option value="urgency">Mais urgentes primeiro</option>
              </select>
            </div>
          ) : null}

          {isAdmin && selected.size > 0 ? (
            <div className="flex flex-wrap items-center gap-3 rounded-xl bg-sky-50 px-4 py-2.5 text-sm dark:bg-sky-950/30">
              <span className="font-medium">{selected.size} selecionado{selected.size === 1 ? '' : 's'}</span>
              <Button size="sm" disabled={selected.size < 2} onClick={() => openMerge([...selected])} title={selected.size < 2 ? 'Marque pelo menos 2 chamados' : undefined}>
                <Link2 className="mr-1.5 h-3.5 w-3.5" />
                Juntar chamados
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Limpar seleção</Button>
            </div>
          ) : null}

          {loadError ? (
            <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-200">{loadError}</p>
          ) : !data ? (
            <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="h-16 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800/60" />)}</div>
          ) : tickets.length === 0 ? (
            <div className="py-12 text-center">
              <LifeBuoy className="mx-auto mb-3 h-9 w-9 text-slate-300 dark:text-zinc-600" />
              <p className="text-sm text-slate-500 dark:text-zinc-400">
                {counts.all === 0 && !filtered
                  ? isAdmin ? 'Nenhum chamado aberto ainda.' : 'Você ainda não abriu nenhum chamado.'
                  : 'Nenhum chamado com esses filtros.'}
              </p>
              {counts.all === 0 && !filtered && !isAdmin ? (
                <Button className="mt-4" onClick={() => navigate('/support/new')}>Abrir meu primeiro chamado</Button>
              ) : null}
            </div>
          ) : (
            <ul className={cn('divide-y divide-slate-100 transition-opacity dark:divide-white/[0.06]', loading && 'opacity-60')} aria-busy={loading}>
              {tickets.map((t) => {
                const unread = isAdmin ? !!t.needsAdmin && !t.mainTicketId : t.authorUnread;
                return (
                  <li key={t.id} className="flex items-start gap-3 py-3">
                    {isAdmin ? (
                      <input
                        type="checkbox"
                        aria-label={`Selecionar chamado #${t.number}`}
                        className="mt-1.5 h-4 w-4 shrink-0 accent-sky-600"
                        checked={selected.has(t.id)}
                        onChange={() => toggle(t.id)}
                      />
                    ) : null}
                    <span
                      aria-label={unread ? 'Novidade' : undefined}
                      className={cn('mt-2 h-2.5 w-2.5 shrink-0 rounded-full', unread ? 'bg-sky-500' : 'bg-transparent')}
                    />
                    <Link to={`/support/${t.id}`} className="min-w-0 flex-1 rounded-lg outline-none focus-visible:ring-4 focus-visible:ring-sky-500/20">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold text-slate-400">#{t.number}</span>
                        <span className={cn('text-sm text-slate-900 dark:text-zinc-100', unread ? 'font-semibold' : 'font-medium')}>{t.title}</span>
                        {t.mainTicketId ? <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-zinc-300">ligado a outro</span> : null}
                        {t.linkedCount ? <span className="rounded-md bg-violet-100 px-1.5 py-0.5 text-[11px] text-violet-700 dark:bg-violet-950 dark:text-violet-200">{t.linkedCount} ligado{t.linkedCount === 1 ? '' : 's'}</span> : null}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-zinc-400">
                        <span>{TYPE_LABELS[t.type]}</span>
                        <span>{subjectText(t)}</span>
                        {t.author ? (
                          <span>
                            {t.author.name}
                            {t.author.departments[0] ? ` (${departmentLabel(t.author.departments[0], departments)})` : ''}
                          </span>
                        ) : null}
                        {t.assignee ? <span>Responsável: {t.assignee.name}</span> : null}
                        <span>atualizado {timeAgo(t.updatedAt)}</span>
                      </div>
                    </Link>
                    <div className="flex shrink-0 flex-col items-end gap-1.5 sm:flex-row sm:items-center">
                      <UrgencyBadge urgency={t.urgency} />
                      <StatusBadge status={t.status} viewer={viewer} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {data && total > 0 ? (
            <Pagination page={data.page} totalPages={data.totalPages} from={firstShown} to={lastShown} total={total} onPage={goToPage} />
          ) : null}
        </CardContent>
      </Card>

      {mergeIds ? (
        <SupportMergeDialog
          tickets={mergeRows}
          onClose={() => setMergeIds(null)}
          onMerged={async (mainId, count) => {
            setMergeIds(null);
            setSelected(new Set());
            notify(`${count} chamado${count === 1 ? '' : 's'} ligado${count === 1 ? '' : 's'} ao #${known.current.get(mainId)?.number ?? ''}. Responda uma vez no principal.`);
            void refreshSupportUnread();
            navigate(`/support/${mainId}`);
          }}
        />
      ) : null}
    </div>
  );
}

/** Números de página com reticências: 1 … 4 5 6 … 20. */
function pageList(page: number, totalPages: number): Array<number | '…'> {
  const wanted = new Set([1, totalPages, page - 1, page, page + 1]);
  const pages = [...wanted].filter((n) => n >= 1 && n <= totalPages).sort((a, b) => a - b);
  const out: Array<number | '…'> = [];
  pages.forEach((n, i) => {
    if (i > 0 && n - pages[i - 1] > 1) out.push('…');
    out.push(n);
  });
  return out;
}

function Pagination({ page, totalPages, from, to, total, onPage }: { page: number; totalPages: number; from: number; to: number; total: number; onPage: (page: number) => void }) {
  return (
    <nav aria-label="Páginas de chamados" className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4 dark:border-white/[0.06]">
      <span className="text-xs text-slate-500 dark:text-zinc-400">
        Mostrando {from}–{to} de {total} chamado{total === 1 ? '' : 's'}
      </span>
      {totalPages > 1 ? (
        <div className="flex items-center gap-1">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Página anterior">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          {pageList(page, totalPages).map((n, i) =>
            n === '…' ? (
              <span key={`gap-${i}`} className="px-1.5 text-sm text-slate-400">…</span>
            ) : (
              <Button
                key={n}
                size="sm"
                variant={n === page ? 'default' : 'ghost'}
                aria-current={n === page ? 'page' : undefined}
                aria-label={`Página ${n}`}
                onClick={() => onPage(n)}
              >
                {n}
              </Button>
            ),
          )}
          <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => onPage(page + 1)} aria-label="Próxima página">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      ) : null}
    </nav>
  );
}

function Kpi({ title, value, unit, note }: { title: string; value: string; unit?: string; note: string }) {
  return (
    <div>
      <div className="text-[13.5px] font-medium text-slate-500 dark:text-zinc-400">{title}</div>
      <div className="mt-2 text-[1.8rem] font-semibold leading-none tracking-tight tabular-nums text-slate-950 dark:text-white">
        {value}
        {unit ? <small className="ml-1.5 text-sm font-medium text-slate-500 dark:text-zinc-400">{unit}</small> : null}
      </div>
      <div className="mt-1.5 text-xs text-slate-500 dark:text-zinc-400">{note}</div>
    </div>
  );
}
