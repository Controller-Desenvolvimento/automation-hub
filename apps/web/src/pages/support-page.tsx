import { LifeBuoy, Link2, Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
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
  OPEN_STATUSES,
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

const URGENCY_ORDER: Record<TicketUrgency, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const selectClass =
  'h-10 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100';

export function SupportPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { notify, departments, refreshSupportUnread } = useHub();
  const isAdmin = user?.role === 'admin' || user?.departments.includes('inovacao') === true;

  const [data, setData] = useState<TicketList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<'all' | 'mine'>('all');
  const [situation, setSituation] = useState<Situation>('open');
  const [query, setQuery] = useState('');
  const [urgency, setUrgency] = useState<'' | TicketUrgency>('');
  const [person, setPerson] = useState('');
  const [department, setDepartment] = useState('');
  const [type, setType] = useState<'' | TicketType>('');
  const [robot, setRobot] = useState('');
  const [sort, setSort] = useState<SortKey>('recent');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mergeIds, setMergeIds] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<TicketList>('/support/tickets'));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Não foi possível carregar os chamados.');
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const tickets = data?.tickets ?? [];
  const byId = useMemo(() => new Map(tickets.map((t) => [t.id, t])), [tickets]);

  const people = useMemo(() => {
    const map = new Map<string, string>();
    tickets.forEach((t) => t.author && map.set(t.author.id, t.author.name));
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'));
  }, [tickets]);
  const robots = useMemo(() => {
    const map = new Map<string, string>();
    tickets.forEach((t) => t.robot && map.set(t.robot.id, t.robot.name));
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'));
  }, [tickets]);
  const authorDepartments = useMemo(
    () => [...new Set(tickets.flatMap((t) => t.author?.departments ?? []))].sort(),
    [tickets],
  );

  const scoped = useMemo(
    () => (isAdmin && tab === 'mine' ? tickets.filter((t) => t.assignee?.id === user?.id) : tickets),
    [isAdmin, tab, tickets, user?.id],
  );
  const counts = useMemo(() => {
    const open = scoped.filter((t) => OPEN_STATUSES.includes(t.status)).length;
    return { open, closed: scoped.length - open, all: scoped.length };
  }, [scoped]);

  const rows = useMemo(() => {
    const term = query.trim().toLowerCase().replace(/^#/, '');
    const list = scoped.filter((t) => {
      if (situation === 'open' && !OPEN_STATUSES.includes(t.status)) return false;
      if (situation === 'closed' && OPEN_STATUSES.includes(t.status)) return false;
      if (urgency && t.urgency !== urgency) return false;
      if (type && t.type !== type) return false;
      if (person && t.author?.id !== person) return false;
      if (department && !t.author?.departments.includes(department)) return false;
      if (robot && t.robot?.id !== robot) return false;
      if (term && !t.title.toLowerCase().includes(term) && !String(t.number).includes(term)) return false;
      return true;
    });
    const sorters: Record<SortKey, (a: TicketRow, b: TicketRow) => number> = {
      recent: (a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt),
      oldest: (a, b) => +new Date(a.createdAt) - +new Date(b.createdAt),
      urgency: (a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency] || +new Date(b.updatedAt) - +new Date(a.updatedAt),
    };
    return list.sort(sorters[sort]);
  }, [scoped, situation, urgency, type, person, department, robot, query, sort]);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const suggestions = (data?.suggestions ?? []).filter((group) => group.every((id) => byId.has(id)));
  const kpis = data?.kpis;
  const viewer = isAdmin ? 'admin' : 'author';
  const wait = formatWait(kpis?.avgFirstReplySeconds ?? null);

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
              const first = byId.get(group[0])!;
              return (
                <li key={group.join('-')} className="flex flex-wrap items-center gap-3">
                  <span>
                    {group.map((id) => `#${byId.get(id)!.number}`).join(', ')} — {subjectText(first)} ({TYPE_LABELS[first.type].toLowerCase()})
                  </span>
                  <Button size="sm" variant="outline" onClick={() => setMergeIds(group)}>
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
          {isAdmin ? (
            <div role="tablist" aria-label="Quais chamados" className="flex gap-2 border-b border-slate-200 pb-3 dark:border-[#2b2b31]">
              {([['all', 'Todos os chamados'], ['mine', 'Atribuídos a mim']] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={tab === value}
                  onClick={() => setTab(value)}
                  className={cn(
                    'rounded-lg px-3 py-1.5 text-sm font-medium transition',
                    tab === value ? 'bg-slate-100 text-slate-950 dark:bg-[#1b1b20] dark:text-white' : 'text-slate-500 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-white',
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
                  aria-pressed={situation === value}
                  onClick={() => setSituation(value)}
                  className={cn(
                    'px-3 py-2 text-sm transition',
                    situation === value ? 'bg-slate-950 text-white dark:bg-white dark:text-slate-950' : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-[#0f0f10] dark:text-zinc-300 dark:hover:bg-[#18181b]',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input aria-label="Buscar" className="pl-9" placeholder="Buscar por título ou número" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          </div>

          {isAdmin ? (
            <div className="flex flex-wrap items-center gap-2">
              <select aria-label="Urgência" className={selectClass} value={urgency} onChange={(e) => setUrgency(e.target.value as '' | TicketUrgency)}>
                <option value="">Toda urgência</option>
                {URGENCIES.map((u) => <option key={u} value={u}>{URGENCY_LABELS[u]}</option>)}
              </select>
              <select aria-label="Pessoa" className={selectClass} value={person} onChange={(e) => setPerson(e.target.value)}>
                <option value="">Toda pessoa</option>
                {people.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
              <select aria-label="Departamento" className={selectClass} value={department} onChange={(e) => setDepartment(e.target.value)}>
                <option value="">Todo departamento</option>
                {authorDepartments.map((d) => <option key={d} value={d}>{departmentLabel(d, departments)}</option>)}
              </select>
              <select aria-label="Tipo" className={selectClass} value={type} onChange={(e) => setType(e.target.value as '' | TicketType)}>
                <option value="">Todo tipo</option>
                {(Object.keys(TYPE_LABELS) as TicketType[]).map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
              </select>
              <select aria-label="Robô" className={selectClass} value={robot} onChange={(e) => setRobot(e.target.value)}>
                <option value="">Todo robô</option>
                {robots.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
              <select aria-label="Ordenar" className={selectClass} value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                <option value="recent">Mais recentes primeiro</option>
                <option value="oldest">Mais antigos primeiro</option>
                <option value="urgency">Mais urgentes primeiro</option>
              </select>
            </div>
          ) : null}

          {isAdmin && selected.size > 0 ? (
            <div className="flex flex-wrap items-center gap-3 rounded-xl bg-sky-50 px-4 py-2.5 text-sm dark:bg-sky-950/30">
              <span className="font-medium">{selected.size} selecionado{selected.size === 1 ? '' : 's'}</span>
              <Button size="sm" disabled={selected.size < 2} onClick={() => setMergeIds([...selected])} title={selected.size < 2 ? 'Marque pelo menos 2 chamados' : undefined}>
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
          ) : rows.length === 0 ? (
            <div className="py-12 text-center">
              <LifeBuoy className="mx-auto mb-3 h-9 w-9 text-slate-300 dark:text-zinc-600" />
              <p className="text-sm text-slate-500 dark:text-zinc-400">
                {tickets.length === 0
                  ? isAdmin ? 'Nenhum chamado aberto ainda.' : 'Você ainda não abriu nenhum chamado.'
                  : 'Nenhum chamado com esses filtros.'}
              </p>
              {tickets.length === 0 && !isAdmin ? (
                <Button className="mt-4" onClick={() => navigate('/support/new')}>Abrir meu primeiro chamado</Button>
              ) : null}
            </div>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-white/[0.06]">
              {rows.map((t) => {
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
        </CardContent>
      </Card>

      {mergeIds ? (
        <SupportMergeDialog
          tickets={mergeIds.map((id) => byId.get(id)).filter((t): t is TicketRow => !!t)}
          onClose={() => setMergeIds(null)}
          onMerged={async (mainId, count) => {
            setMergeIds(null);
            setSelected(new Set());
            notify(`${count} chamado${count === 1 ? '' : 's'} ligado${count === 1 ? '' : 's'} ao #${byId.get(mainId)?.number ?? ''}. Responda uma vez no principal.`);
            await load();
            void refreshSupportUnread();
            navigate(`/support/${mainId}`);
          }}
        />
      ) : null}
    </div>
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
