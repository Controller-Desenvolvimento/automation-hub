import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/page-header';
import { Input } from '../components/ui/input';
import { CatsCard, DurationCard, ExecDailyCard, RateCard } from '../components/robot-health/charts';
import { InsightsView, attentionCount } from '../components/robot-health/insights';
import { ChartDefs, TipLayer } from '../components/robot-health/kit';
import { ParetoCard, RobotsTableCard, Tiles } from '../components/robot-health/parts';
import { HeatmapCard } from '../components/robot-health/robot-heatmap';
import { CapacityCard, CyclesCard } from '../components/robot-health/server';
import { useHub } from '../contexts/hub-context';
import { api } from '../lib/api';
import {
  CATEGORY_COLOR,
  CATEGORY_ORDER,
  PERIOD_PRESETS,
  fmtDayYear,
  presetRange,
  type CategoryInfo,
  type Granularity,
  type HealthOverview,
  type InsightTarget,
  type PeriodPreset,
  type Scope,
} from '../lib/robot-health';
import { cn } from '../lib/utils';

const selectClass =
  'h-10 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100';

const SCOPES: Array<{ value: Scope; label: string }> = [
  { value: 'all', label: 'Todas' },
  { value: 'manual', label: 'Manuais' },
  { value: 'scheduled', label: 'Agendadas' },
];

/** O "i" do gráfico de erros por categoria: as 6 categorias (significado, exemplo e quem age). */
function CategoryGuide({ info }: { info: CategoryInfo[] }) {
  return (
    <div style={{ display: 'grid', gap: 10, minWidth: 320 }}>
      <strong>De quem é a falha: define quem precisa agir.</strong>
      {CATEGORY_ORDER.map((k) => {
        const c = info.find((i) => i.key === k);
        if (!c) return null;
        return (
          <div key={k} style={{ display: 'grid', gridTemplateColumns: '10px 1fr', columnGap: 8 }}>
            <span className="hc-key" style={{ background: CATEGORY_COLOR[k], marginTop: 4 }} />
            <div>
              <div>
                <strong>{c.label}.</strong> {c.summary}
                {!c.countsAgainstRobot ? <em> (fora da taxa de sucesso)</em> : null}
              </div>
              <div style={{ color: 'var(--hc-ink2)' }}>Ex.: {c.example}</div>
              <div style={{ color: 'var(--hc-ink2)' }}>Quem age: {c.who}</div>
            </div>
          </div>
        );
      })}
      <div style={{ color: 'var(--hc-ink2)' }}>Uma barra por período. O que está em "Hub" não pesa na taxa de sucesso do robô.</div>
    </div>
  );
}

export function RobotHealthPage() {
  const { notify } = useHub();
  const [params, setParams] = useSearchParams();
  const preset = (params.get('periodo') as PeriodPreset | null) ?? '30';
  const scope: Scope = params.get('origem') === 'manual' || params.get('origem') === 'scheduled' ? (params.get('origem') as Scope) : 'all';
  const from = params.get('de') ?? '';
  const to = params.get('ate') ?? '';
  const granParam = params.get('agrupar');
  const view: 'graficos' | 'insights' = params.get('exibir') === 'insights' ? 'insights' : 'graficos';
  const gran: Granularity | null = granParam === 'day' || granParam === 'week' || granParam === 'month' ? granParam : null;

  const [data, setData] = useState<HealthOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

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

  const granularity = data?.categories.granularity ?? gran ?? 'day';
  const setGran = (g: Granularity) => setParam({ agrupar: g });
  const attention = data ? attentionCount(data.insights) : 0;
  const hasCrit = !!data?.insights.some((i) => i.sev === 'crit');
  // "Ver ..." dos insights: volta para os gráficos e rola até a seção.
  const goTo = (target: InsightTarget) => {
    setParam({ exibir: null });
    window.setTimeout(() => document.getElementById(`hc-${target}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 150);
  };

  return (
    <div className="hc space-y-6">
      <ChartDefs />
      <TipLayer />
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
            {fmtDayYear(data.period.from)} a {fmtDayYear(data.period.to)} ({data.period.days} dia{data.period.days === 1 ? '' : 's'})
            {data.previousPeriod ? ` · comparado com ${fmtDayYear(data.previousPeriod.from)} a ${fmtDayYear(data.previousPeriod.to)}` : ' · sem período anterior para comparar'}
          </span>
        ) : null}
      </div>

      {data ? (
        <div className="hc-views">
          <div className="hc-seg" role="group" aria-label="Exibição">
            <button type="button" aria-pressed={view === 'graficos'} onClick={() => setParam({ exibir: null })}>Gráficos</button>
            <button type="button" aria-pressed={view === 'insights'} onClick={() => setParam({ exibir: 'insights' })}>
              Insights
              {attention ? <span className="badge" data-sev={hasCrit ? 'crit' : 'warn'} aria-label={`${attention} para atender`}>{attention}</span> : null}
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-200">{error}</p>
      ) : !data ? (
        <div className="space-y-4" aria-busy="true">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{[1, 2, 3, 4].map((i) => <div key={i} className="h-36 animate-pulse rounded-2xl bg-slate-100 dark:bg-slate-800/60" />)}</div>
          <div className="h-72 animate-pulse rounded-3xl bg-slate-100 dark:bg-slate-800/60" />
        </div>
      ) : (
        <div className={cn('space-y-4', loading && 'hc-refetch')} aria-busy={loading}>
          {view === 'insights' ? (
            <InsightsView insights={data.insights} hasExecutions={data.summary.current.executions > 0} onGo={goTo} />
          ) : (
            <>
          <div className="hc-sec" id="hc-visao">Visão geral</div>
          <Tiles current={data.summary.current} previous={data.summary.previous} mini={data.mini} period={data.period} previousPeriod={data.previousPeriod} />
          <ExecDailyCard daily={data.daily} period={data.period} avgPerDay={data.summary.current.executions / Math.max(1, data.period.days)} />
          <RateCard buckets={data.evolution} gran={granularity} onGran={setGran} period={data.period} avgRate={data.summary.current.successRate} />

          <div className="hc-sec" id="hc-robos">Robôs</div>
          <HeatmapCard heatmap={data.heatmap} period={data.period} />
          <RobotsTableCard robots={data.robots} />

          <div className="hc-sec" id="hc-erros">Erros</div>
          <ParetoCard causes={data.causes} info={data.categoryInfo} />
          <CatsCard buckets={data.categories.buckets} gran={granularity} onGran={setGran} period={data.period} info={data.categoryInfo} guide={<CategoryGuide info={data.categoryInfo} />} />

          <div className="hc-sec" id="hc-duracao">Duração</div>
          <DurationCard durations={data.durations} gran={granularity} onGran={setGran} period={data.period} />

          <div className="hc-sec" id="hc-servidor">Capacidade do servidor</div>
          <CapacityCard cap={data.capacity} />

          <div className="hc-sec" id="hc-agend">Agendamentos</div>
          <CyclesCard cycles={data.cycles} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
