import { ArrowDownRight, ArrowUpRight, Minus, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CategoryChart, categoryColor } from '../components/robot-health/category-chart';
import { PageHeader } from '../components/page-header';
import { InfoTip } from '../components/time-savings/info-tip';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { useHub } from '../contexts/hub-context';
import { api } from '../lib/api';
import {
  GRANULARITY_LABELS,
  PERIOD_PRESETS,
  SITUATION_HINTS,
  SITUATION_LABELS,
  SITUATION_ORDER,
  duration,
  num,
  pct,
  presetRange,
  type Granularity,
  type HealthOverview,
  type PeriodPreset,
  type RobotRow,
  type Scope,
  type Situation,
  type Totals,
} from '../lib/robot-health';
import { cn, timeAgo } from '../lib/utils';

const selectClass =
  'h-10 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100';

const SCOPES: Array<{ value: Scope; label: string }> = [
  { value: 'all', label: 'Todas' },
  { value: 'manual', label: 'Manuais' },
  { value: 'scheduled', label: 'Agendadas' },
];

type SortKey = 'situation' | 'name' | 'executions' | 'successRate' | 'errors' | 'duration' | 'lastRun';

export function RobotHealthPage() {
  const { notify } = useHub();
  const [params, setParams] = useSearchParams();
  const preset = (params.get('periodo') as PeriodPreset | null) ?? '30';
  const scope: Scope = params.get('origem') === 'manual' || params.get('origem') === 'scheduled' ? (params.get('origem') as Scope) : 'all';
  const from = params.get('de') ?? '';
  const to = params.get('ate') ?? '';
  const granParam = params.get('agrupar');
  const gran: Granularity | null = granParam === 'day' || granParam === 'week' || granParam === 'month' ? granParam : null;

  const [data, setData] = useState<HealthOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const [situation, setSituation] = useState<Situation | 'all'>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'situation', dir: 'desc' });

  const setParam = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === '') next.delete(k);
        else next.set(k, v);
      }
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  // Datas pedidas ao servidor: as do período escolhido ('all' pede o histórico inteiro).
  const range = useMemo(() => (preset === 'custom' ? { from, to } : presetRange(preset)), [preset, from, to]);
  const query = useMemo(() => {
    const q = new URLSearchParams({ scope });
    if (preset === 'all') q.set('all', '1');
    else if (range?.from && range?.to) {
      q.set('from', range.from);
      q.set('to', range.to);
    }
    if (gran) q.set('granularity', gran);
    return q.toString();
  }, [preset, range, scope, gran]);

  useEffect(() => {
    const id = ++requestId.current;
    setLoading(true);
    api<HealthOverview>(`/robot-health?${query}`)
      .then((result) => {
        if (id !== requestId.current) return;
        setData(result);
        setError(null);
      })
      .catch((err) => {
        if (id !== requestId.current) return;
        setError(err instanceof Error ? err.message : 'Não foi possível carregar a Saúde dos robôs.');
        notify('Não foi possível carregar a Saúde dos robôs.');
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
  }, [query, notify]);

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = (data?.robots ?? []).filter((r) => (situation === 'all' || r.situation === situation) && (!term || r.name.toLowerCase().includes(term)));
    const dir = sort.dir === 'asc' ? 1 : -1;
    const value = (r: RobotRow): number | string => {
      switch (sort.key) {
        case 'name': return r.name.toLowerCase();
        case 'executions': return r.executions;
        case 'successRate': return r.successRate ?? -1;
        case 'errors': return r.errors;
        case 'duration': return r.avgDurationSeconds ?? -1;
        case 'lastRun': return r.lastRunAt;
        default: return SITUATION_ORDER[r.situation] * 1_000_000 + r.errors;
      }
    };
    return [...list].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    });
  }, [data, situation, search, sort]);

  const counts = useMemo(() => {
    const c: Record<Situation | 'all', number> = { all: 0, critical: 0, attention: 0, healthy: 0, few: 0 };
    for (const r of data?.robots ?? []) {
      c.all += 1;
      c[r.situation] += 1;
    }
    return c;
  }, [data]);

  const current = data?.summary.current;
  const previous = data?.summary.previous ?? null;
  const granularity = data?.categories.granularity ?? 'day';

  function sortBy(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: key === 'name' ? 'asc' : 'desc' }));
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Administração"
        title="Saúde dos robôs"
        description="Como os robôs do Hub estão se saindo: taxa de sucesso, situação de cada um e o que causa os erros. Só administradores veem esta tela."
      />

      {/* ---------- filtros ---------- */}
      <div className="flex flex-wrap items-center gap-3">
        <select aria-label="Período" className={selectClass} value={preset} onChange={(e) => setParam({ periodo: e.target.value === '30' ? null : e.target.value, de: null, ate: null })}>
          {PERIOD_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        {preset === 'custom' ? (
          <>
            <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-zinc-300">
              De <Input type="date" aria-label="Data inicial" className="w-auto" value={from} max={to || undefined} onChange={(e) => setParam({ de: e.target.value })} />
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-zinc-300">
              Até <Input type="date" aria-label="Data final" className="w-auto" value={to} min={from || undefined} onChange={(e) => setParam({ ate: e.target.value })} />
            </label>
          </>
        ) : null}
        <div role="group" aria-label="Origem das execuções" className="inline-flex overflow-hidden rounded-xl border border-slate-300 dark:border-[#2b2b31]">
          {SCOPES.map((s) => (
            <button
              key={s.value}
              type="button"
              aria-pressed={scope === s.value}
              onClick={() => setParam({ origem: s.value === 'all' ? null : s.value })}
              className={cn(
                'px-3 py-2 text-sm transition',
                scope === s.value ? 'bg-slate-950 text-white dark:bg-white dark:text-slate-950' : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-[#0f0f10] dark:text-zinc-300 dark:hover:bg-[#18181b]',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        {data ? (
          <span className="text-xs text-slate-500 dark:text-zinc-400">
            {data.period.from.split('-').reverse().join('/')} a {data.period.to.split('-').reverse().join('/')} ({data.period.days} dia{data.period.days === 1 ? '' : 's'})
            {data.previousPeriod ? ` · comparado com ${data.previousPeriod.from.split('-').reverse().join('/')} a ${data.previousPeriod.to.split('-').reverse().join('/')}` : ' · sem período anterior para comparar'}
          </span>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-200">{error}</p>
      ) : !data || !current ? (
        <div className="space-y-4" aria-busy="true">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{[1, 2, 3, 4].map((i) => <div key={i} className="h-28 animate-pulse rounded-2xl bg-slate-100 dark:bg-slate-800/60" />)}</div>
          <div className="h-72 animate-pulse rounded-3xl bg-slate-100 dark:bg-slate-800/60" />
        </div>
      ) : (
        <div className={cn('space-y-6 transition-opacity', loading && 'opacity-60')} aria-busy={loading}>
          {/* ---------- indicadores ---------- */}
          <div className="grid grid-cols-2 gap-x-8 gap-y-5 lg:grid-cols-4">
            <Tile
              title="Execuções"
              value={num(current.executions)}
              tip="Execuções terminadas (sucesso, erro ou cancelada) dos robôs que rodam no Hub, no período. Os robôs externos (que só avisam que rodaram) não entram nesta tela. Mais execuções = mais uso, por isso subir aparece em verde."
              delta={delta(current.executions, previous?.executions ?? null)}
              upIsGood
              note={`${num(current.canceled)} cancelada${current.canceled === 1 ? '' : 's'}`}
              comparable={!!previous}
            />
            <Tile
              title="Taxa de sucesso"
              value={pct(current.successRate, 1)}
              tip="Sucessos ÷ execuções concluídas (sucessos + erros dos robôs). Cancelada não conta, e erro causado pelo reinício do Hub também não: o robô não teve culpa."
              delta={pointsDelta(current.successRate, previous?.successRate ?? null)}
              upIsGood
              note={`${num(current.success)} de ${num(current.concluded)} concluídas`}
              comparable={!!previous}
            />
            <Tile
              title="Erros dos robôs"
              value={num(current.errors)}
              tip="Execuções que terminaram em erro, sem os erros do Hub (reinício do servidor). Menos é melhor."
              delta={delta(current.errors, previous?.errors ?? null)}
              upIsGood={false}
              note={current.hubErrors ? `+ ${num(current.hubErrors)} do Hub (fora da conta)` : 'nenhum erro do Hub'}
              comparable={!!previous}
            />
            <Tile
              title="Duração média"
              value={duration(current.avgDurationSeconds)}
              tip="Tempo médio das execuções que terminaram com sucesso (do início ao fim). Erros e canceladas não entram, porque terminam antes ou depois do normal."
              delta={delta(current.avgDurationSeconds, previous?.avgDurationSeconds ?? null)}
              neutral
              note="só execuções com sucesso"
              comparable={!!previous}
            />
          </div>

          {/* ---------- erros por categoria ---------- */}
          <Card className="rounded-3xl">
            <CardContent>
              <CategoryChart
                buckets={data.categories.buckets}
                granularity={granularity}
                onGranularity={(g) => setParam({ agrupar: g })}
                info={data.categoryInfo}
              />
              <p className="mt-3 text-xs text-slate-500 dark:text-zinc-400">
                Uma barra por {GRANULARITY_LABELS[granularity].one}. O que está em "Hub" não pesa na taxa de sucesso do robô.
              </p>
            </CardContent>
          </Card>

          {/* ---------- principais causas ---------- */}
          <Card className="rounded-3xl">
            <CardContent className="space-y-3">
              <div className="flex items-center gap-1.5">
                <h2 className="text-base font-semibold text-slate-900 dark:text-white">Principais causas de erro</h2>
                <InfoTip label="Como ler as causas" wide>
                  Cada erro é lido pela mensagem que o robô (ou o Hub) deixou e colocado numa causa conhecida. A cor mostra a categoria. "Sem causa" é quando
                  o robô falhou sem escrever o motivo: o robô deveria terminar com uma linha de erro dizendo o que houve e o que fazer.
                </InfoTip>
              </div>
              {data.causes.length === 0 ? (
                <p className="text-sm text-slate-500 dark:text-zinc-400">Nenhum erro no período.</p>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-white/[0.06]">
                  {data.causes.map((c) => {
                    const top = data.causes[0].count;
                    return (
                      <li key={c.cause} className="py-2.5">
                        <div className="flex items-center gap-3">
                          <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: categoryColor(c.category) }} aria-hidden="true" />
                          <span className="min-w-0 flex-1 truncate text-sm text-slate-800 dark:text-zinc-100" title={c.cause}>{c.cause}</span>
                          <span className="shrink-0 text-xs text-slate-500 dark:text-zinc-400">{data.categoryInfo.find((i) => i.key === c.category)?.label}</span>
                          <span className="w-24 shrink-0 text-right text-xs text-slate-500 dark:text-zinc-400">{c.robots} robô{c.robots === 1 ? '' : 's'}</span>
                          <span className="w-10 shrink-0 text-right text-sm font-medium tabular-nums text-slate-900 dark:text-white">{num(c.count)}</span>
                        </div>
                        <div className="ml-[22px] mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-white/[0.06]">
                          <div className="h-full rounded-full" style={{ width: `${(c.count / top) * 100}%`, background: categoryColor(c.category) }} />
                        </div>
                        <p className="ml-[22px] mt-1 text-xs text-slate-500 dark:text-zinc-400">{c.description}</p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* ---------- robôs ---------- */}
          <Card className="rounded-3xl">
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-1.5">
                  <h2 className="text-base font-semibold text-slate-900 dark:text-white">Robôs</h2>
                  <InfoTip label="Como a situação é calculada" wide>
                    <p className="mb-1.5 font-medium text-slate-800 dark:text-zinc-100">Situação pelo % de erro entre as execuções concluídas (sucessos + erros dos robôs):</p>
                    {(['critical', 'attention', 'healthy', 'few'] as Situation[]).map((s) => (
                      <p key={s}><strong>{SITUATION_LABELS[s]}:</strong> {SITUATION_HINTS[s]}.</p>
                    ))}
                    <p className="mt-1.5">Erros do Hub (reinício do servidor) e canceladas não entram na conta.</p>
                  </InfoTip>
                </div>
                <div className="relative min-w-[220px]">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input aria-label="Buscar robô" className="pl-9" placeholder="Buscar robô" value={search} onChange={(e) => setSearch(e.target.value)} />
                </div>
              </div>
              <div role="group" aria-label="Situação" className="flex flex-wrap gap-2">
                {(['all', 'critical', 'attention', 'healthy', 'few'] as Array<Situation | 'all'>).map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={situation === s}
                    onClick={() => setSituation(s)}
                    className={cn(
                      'rounded-lg border px-3 py-1.5 text-sm transition',
                      situation === s ? 'border-slate-950 bg-slate-950 text-white dark:border-white dark:bg-white dark:text-slate-950' : 'border-slate-300 text-slate-600 hover:bg-slate-50 dark:border-[#2b2b31] dark:text-zinc-300 dark:hover:bg-[#18181b]',
                    )}
                  >
                    {s === 'all' ? 'Todos' : SITUATION_LABELS[s]} ({counts[s]})
                  </button>
                ))}
              </div>

              {rows.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-500 dark:text-zinc-400">{counts.all === 0 ? 'Nenhum robô rodou no período.' : 'Nenhum robô com esse filtro.'}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[860px] text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-[#2b2b31] dark:text-zinc-400">
                        <Th label="Robô" k="name" sort={sort} onSort={sortBy} />
                        <Th label="Situação" k="situation" sort={sort} onSort={sortBy} />
                        <Th label="Taxa de sucesso" k="successRate" sort={sort} onSort={sortBy} align="right" />
                        <Th label="Execuções" k="executions" sort={sort} onSort={sortBy} align="right" />
                        <Th label="Erros" k="errors" sort={sort} onSort={sortBy} align="right" />
                        <Th label="Duração média" k="duration" sort={sort} onSort={sortBy} align="right" />
                        <th className="px-3 py-2 font-medium">Principal causa</th>
                        <Th label="Último uso" k="lastRun" sort={sort} onSort={sortBy} align="right" />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => <RobotLine key={r.robotId} row={r} info={data.categoryInfo} />)}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

// ---------- pedaços ----------

type Delta = { text: string; tone: 'up' | 'down' | 'flat' } | null;

function delta(current: number | null, previous: number | null): Delta {
  if (current === null || previous === null) return null;
  if (previous === 0) return current === 0 ? { text: 'igual', tone: 'flat' } : { text: 'novo', tone: 'up' };
  const change = (current - previous) / previous;
  if (Math.abs(change) < 0.005) return { text: 'igual', tone: 'flat' };
  return { text: `${change > 0 ? '+' : '−'}${Math.abs(change * 100).toFixed(Math.abs(change) < 0.1 ? 1 : 0).replace('.', ',')}%`, tone: change > 0 ? 'up' : 'down' };
}

function pointsDelta(current: number | null, previous: number | null): Delta {
  if (current === null || previous === null) return null;
  const points = (current - previous) * 100;
  if (Math.abs(points) < 0.05) return { text: 'igual', tone: 'flat' };
  return { text: `${points > 0 ? '+' : '−'}${Math.abs(points).toFixed(1).replace('.', ',')} p.p.`, tone: points > 0 ? 'up' : 'down' };
}

function Tile({
  title, value, tip, delta: d, upIsGood, neutral, note, comparable,
}: {
  title: string; value: string; tip: string; delta: Delta; upIsGood?: boolean; neutral?: boolean; note: string; comparable: boolean;
}) {
  // Cor = direção × se subir é bom; sempre com seta e sinal (nunca só pela cor).
  const good = d && d.tone !== 'flat' && !neutral ? (d.tone === 'up') === !!upIsGood : null;
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[13.5px] font-medium text-slate-500 dark:text-zinc-400">
        {title}
        <InfoTip label={`Como ${title.toLowerCase()} é calculado`}>{tip}</InfoTip>
      </div>
      <div className="mt-2 text-[1.8rem] font-semibold leading-none tracking-tight tabular-nums text-slate-950 dark:text-white">{value}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs">
        {!comparable ? (
          <span className="text-slate-500 dark:text-zinc-400">sem período anterior</span>
        ) : d ? (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 font-medium',
              good === null ? 'text-slate-500 dark:text-zinc-400' : good ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400',
            )}
          >
            {d.tone === 'up' ? <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" /> : d.tone === 'down' ? <ArrowDownRight className="h-3.5 w-3.5" aria-hidden="true" /> : <Minus className="h-3.5 w-3.5" aria-hidden="true" />}
            {d.text}
            <span className="font-normal text-slate-500 dark:text-zinc-400">vs período anterior</span>
          </span>
        ) : (
          <span className="text-slate-500 dark:text-zinc-400">sem dados antes</span>
        )}
      </div>
      <div className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">{note}</div>
    </div>
  );
}

function Th({ label, k, sort, onSort, align }: { label: string; k: SortKey; sort: { key: SortKey; dir: 'asc' | 'desc' }; onSort: (k: SortKey) => void; align?: 'right' }) {
  const active = sort.key === k;
  return (
    <th className={cn('px-3 py-2 font-medium', align === 'right' && 'text-right')} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => onSort(k)} className={cn('inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white', active && 'text-slate-900 dark:text-white')}>
        {label}
        <span aria-hidden="true" className="text-[10px]">{active ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span>
      </button>
    </th>
  );
}

const SITUATION_STYLE: Record<Situation, string> = {
  critical: 'border-rose-200 bg-rose-100 text-rose-700 dark:border-rose-500/40 dark:bg-rose-950 dark:text-rose-200',
  attention: 'border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-500/40 dark:bg-amber-950 dark:text-amber-200',
  healthy: 'border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-950 dark:text-emerald-200',
  few: 'border-slate-200 bg-slate-100 text-slate-600 dark:border-slate-500/35 dark:bg-slate-800 dark:text-zinc-300',
};
// Ícone + texto, nunca só a cor.
const SITUATION_ICON: Record<Situation, string> = { critical: '▲', attention: '●', healthy: '✓', few: '·' };

function RobotLine({ row: r, info }: { row: RobotRow; info: HealthOverview['categoryInfo'] }) {
  const trend =
    r.previousErrorRate !== null && r.errorRate !== null && Math.abs(r.errorRate - r.previousErrorRate) >= 0.05
      ? r.errorRate > r.previousErrorRate ? { text: `piorou (antes ${pct(r.previousErrorRate)} de erro)`, bad: true } : { text: `melhorou (antes ${pct(r.previousErrorRate)} de erro)`, bad: false }
      : null;
  return (
    <tr className="border-b border-slate-100 align-top dark:border-white/[0.06]">
      <td className="px-3 py-2.5 font-medium text-slate-900 dark:text-zinc-100">
        {r.name}
        {!r.active ? <span className="ml-2 text-xs font-normal text-slate-400">inativo</span> : null}
      </td>
      <td className="px-3 py-2.5">
        <span title={SITUATION_HINTS[r.situation]} className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-lg border px-2 py-0.5 text-[11px] font-medium', SITUATION_STYLE[r.situation])}>
          <span aria-hidden="true">{SITUATION_ICON[r.situation]}</span>
          {SITUATION_LABELS[r.situation]}
        </span>
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums">
        <div className="text-slate-900 dark:text-white">{pct(r.successRate, 1)}</div>
        {trend ? <div className={cn('text-[11px]', trend.bad ? 'text-rose-700 dark:text-rose-400' : 'text-emerald-700 dark:text-emerald-400')}>{trend.bad ? '▲' : '▼'} {trend.text}</div> : null}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-slate-700 dark:text-zinc-200">
        {num(r.executions)}
        {r.canceled ? <div className="text-[11px] text-slate-400">{r.canceled} cancelada{r.canceled === 1 ? '' : 's'}</div> : null}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-slate-700 dark:text-zinc-200">
        {num(r.errors)}
        {r.hubErrors ? <div className="text-[11px] text-slate-400">+ {r.hubErrors} do Hub</div> : null}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-slate-700 dark:text-zinc-200">{duration(r.avgDurationSeconds)}</td>
      <td className="max-w-[260px] px-3 py-2.5 text-slate-600 dark:text-zinc-300">
        {r.mainCause ? (
          <span className="flex items-start gap-1.5" title={r.mainCause.cause}>
            <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: categoryColor(r.mainCause.category) }} aria-hidden="true" />
            <span className="truncate">
              {r.mainCause.cause}
              <span className="text-slate-400"> · {info.find((i) => i.key === r.mainCause!.category)?.label} · {r.mainCause.count}×</span>
            </span>
          </span>
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-right text-xs text-slate-500 dark:text-zinc-400">{timeAgo(r.lastRunAt)}</td>
    </tr>
  );
}

// Totals é usado só como tipo de apoio acima.
export type { Totals };
