import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DataQuality } from '../components/time-savings/data-quality';
import { DistributionPanel } from '../components/time-savings/distribution-panel';
import { EvolutionChart } from '../components/time-savings/evolution-chart';
import { ExecutionsTable } from '../components/time-savings/executions-table';
import { FiltersBar, type TimeSavingsFilters } from '../components/time-savings/filters-bar';
import { InfoTip } from '../components/time-savings/info-tip';
import { InsightsCard } from '../components/time-savings/insights-card';
import { KpiRow } from '../components/time-savings/kpi-row';
import { useHub } from '../contexts/hub-context';
import { api } from '../lib/api';
import { buildInsights, buildSummaryCsv, presetRange } from '../lib/time-savings-metrics';
import type { TimeSavingsGranularity, TimeSavingsReport } from '../lib/types';
import { cn, departmentLabel as labelForDepartment } from '../lib/utils';

type View = 'overview' | 'executions';

const GRANULARITIES: TimeSavingsGranularity[] = ['day', 'week', 'month'];

export function TimeSavingsPage() {
  const { hub, departments, notify } = useHub();
  const [searchParams, setSearchParams] = useSearchParams();

  // Todos os filtros vivem na URL: o link da tela é compartilhável. Sem
  // parâmetros de data, o padrão é o mês corrente; `from=` vazio significa
  // "todo o histórico".
  const defaults = useMemo(() => presetRange('month'), []);
  const filters: TimeSavingsFilters = {
    from: searchParams.has('from') ? (searchParams.get('from') ?? '') : defaults.from,
    to: searchParams.has('to') ? (searchParams.get('to') ?? '') : defaults.to,
    robotId: searchParams.get('robot') ?? '',
    department: searchParams.get('dept') ?? '',
    userIds: (searchParams.get('users') ?? '').split(',').filter(Boolean),
    origin: searchParams.get('origin') === 'hub' || searchParams.get('origin') === 'external'
      ? (searchParams.get('origin') as 'hub' | 'external')
      : '',
  };
  const view: View = searchParams.get('view') === 'executions' ? 'executions' : 'overview';
  const granularityParam = searchParams.get('gran');
  const granularityOverride = GRANULARITIES.includes(granularityParam as TimeSavingsGranularity)
    ? (granularityParam as TimeSavingsGranularity)
    : null;

  const [report, setReport] = useState<TimeSavingsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Comparação ligada por padrão. É estado da página (não do gráfico): mudar
  // período ou filtros não remonta a página, então a escolha do usuário se mantém.
  const [compare, setCompare] = useState(true);
  const [userOptions, setUserOptions] = useState<Array<{ userId: string; userName: string }>>([]);
  const requestSeq = useRef(0);

  const updateParams = useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          mutate(next);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  function setFilters(patch: Partial<TimeSavingsFilters>) {
    updateParams((next) => {
      if (patch.from !== undefined) next.set('from', patch.from);
      if (patch.to !== undefined) next.set('to', patch.to);
      const optional: Array<[keyof TimeSavingsFilters, string]> = [
        ['robotId', 'robot'],
        ['department', 'dept'],
        ['origin', 'origin'],
      ];
      for (const [key, param] of optional) {
        if (patch[key] === undefined) continue;
        const value = patch[key] as string;
        if (value) next.set(param, value);
        else next.delete(param);
      }
      if (patch.userIds !== undefined) {
        if (patch.userIds.length > 0) next.set('users', patch.userIds.join(','));
        else next.delete('users');
      }
      // Início maior que o fim: o fim acompanha o início.
      const from = next.get('from');
      const to = next.get('to');
      if (from && to && from > to) {
        if (patch.from !== undefined) next.set('to', from);
        else next.set('from', to);
      }
    });
  }

  const canClear =
    filters.from !== defaults.from ||
    filters.to !== defaults.to ||
    Boolean(filters.robotId || filters.department || filters.origin) ||
    filters.userIds.length > 0;

  function clearFilters() {
    updateParams((next) => {
      for (const key of ['from', 'to', 'robot', 'dept', 'users', 'origin', 'gran']) next.delete(key);
    });
  }

  function setView(nextView: View) {
    updateParams((next) => {
      if (nextView === 'executions') next.set('view', 'executions');
      else next.delete('view');
    });
  }

  function setGranularity(value: TimeSavingsGranularity) {
    updateParams((next) => next.set('gran', value));
  }

  // Filtros globais serializados — compartilhados pelo resumo e pela tabela de detalhes.
  const baseQuery = useMemo(() => {
    const query = new URLSearchParams();
    if (filters.from) query.set('from', filters.from);
    if (filters.to) query.set('to', filters.to);
    if (filters.robotId) query.set('robotId', filters.robotId);
    if (filters.userIds.length > 0) query.set('userIds', filters.userIds.join(','));
    if (filters.department) query.set('department', filters.department);
    if (filters.origin) query.set('origin', filters.origin);
    return query.toString();
  }, [filters.from, filters.to, filters.robotId, filters.userIds, filters.department, filters.origin]);

  const reportQuery = useMemo(() => {
    const query = new URLSearchParams(baseQuery);
    if (granularityOverride) query.set('granularity', granularityOverride);
    return query.toString();
  }, [baseQuery, granularityOverride]);

  const mergeUserOptions = useCallback((rows: Array<{ userId: string; userName: string }>) => {
    setUserOptions((current) => {
      const known = new Map(current.map((user) => [user.userId, user]));
      let changed = false;
      for (const row of rows) {
        if (!known.has(row.userId)) {
          known.set(row.userId, { userId: row.userId, userName: row.userName });
          changed = true;
        }
      }
      return changed
        ? Array.from(known.values()).sort((a, b) => a.userName.localeCompare(b.userName, 'pt-BR'))
        : current;
    });
  }, []);

  useEffect(() => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setLoadError(null);

    api<TimeSavingsReport>(`/reports/time-savings?${reportQuery}`)
      .then(async (data) => {
        if (seq !== requestSeq.current) return;
        setReport(data);
        mergeUserOptions(data.byUser);

        // Link com colaboradores selecionados: os nomes só existem num relatório
        // sem esse filtro, então busca uma vez para montar a lista.
        const selected = new URLSearchParams(baseQuery).get('userIds');
        if (selected) {
          const unfiltered = new URLSearchParams(baseQuery);
          unfiltered.delete('userIds');
          const all = await api<TimeSavingsReport>(`/reports/time-savings?${unfiltered.toString()}`).catch(() => null);
          if (all && seq === requestSeq.current) mergeUserOptions(all.byUser);
        }
      })
      .catch((error: unknown) => {
        if (seq !== requestSeq.current) return;
        const message = error instanceof Error ? error.message : 'Não foi possível carregar o relatório.';
        setLoadError(message);
        notify(message);
      })
      .finally(() => {
        if (seq === requestSeq.current) setLoading(false);
      });
    // `notify` e `mergeUserOptions` são estáveis; reportQuery cobre todos os filtros.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportQuery]);

  const departmentLabel = useCallback(
    (slug: string) => labelForDepartment(slug, departments),
    [departments],
  );

  const departmentOptions = useMemo(() => {
    const list = departments.filter((dept) => dept.isActive).map((dept) => ({ slug: dept.slug, name: dept.name }));
    if (filters.department && !list.some((dept) => dept.slug === filters.department)) {
      list.push({ slug: filters.department, name: departmentLabel(filters.department) });
    }
    return list;
  }, [departments, filters.department, departmentLabel]);

  const robotOptions = useMemo(
    () => (hub?.robots ?? []).map((robot) => ({ id: robot.id, name: robot.name })),
    [hub],
  );

  const insights = useMemo(() => (report ? buildInsights(report) : []), [report]);

  function exportSummary() {
    if (!report) return;
    const csv = buildSummaryCsv({ report, departmentLabel });
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = report.range
      ? `tempo-ganho_${report.range.from}_a_${report.range.to}.csv`
      : 'tempo-ganho_historico.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  const tabs: Array<{ id: View; label: string }> = [
    { id: 'overview', label: 'Visão geral' },
    { id: 'executions', label: 'Execuções' },
  ];

  return (
    <div className="grid grid-cols-1 gap-7">
      <header className="space-y-2">
        <h1 className="text-[1.8rem] font-semibold tracking-tight text-slate-950 dark:text-white sm:text-[2.05rem]">
          Tempo ganho com <span className="text-sky-600 dark:text-sky-400">automações</span>
        </h1>
        <p className="flex items-center gap-1 text-sm text-slate-500 dark:text-zinc-400">
          Estimativa do esforço manual evitado pelas automações.
          <InfoTip label="O que significa tempo ganho">
            Representa o esforço manual estimado que as automações evitaram, calculado como tempo manual por unidade ×
            unidades processadas (ou o valor informado por sistemas externos). Não é, necessariamente, o tempo líquido de
            processamento: não desconta o tempo que o robô levou nem a supervisão humana.
          </InfoTip>
        </p>
      </header>

      <FiltersBar
        filters={filters}
        onChange={setFilters}
        robots={robotOptions}
        departments={departmentOptions}
        userOptions={userOptions}
        canClear={canClear}
        onClear={clearFilters}
        onExport={exportSummary}
        exportDisabled={!report}
      />

      <div role="tablist" aria-label="Seções" className="flex gap-6 border-b border-slate-200 dark:border-[#27272a]">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={view === tab.id}
            onClick={() => setView(tab.id)}
            className={cn(
              '-mb-px border-b-2 pb-2.5 text-sm font-medium transition-colors',
              view === tab.id
                ? 'border-sky-500 text-slate-950 dark:text-white'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-100',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {view === 'executions' ? (
        <ExecutionsTable
          baseQuery={baseQuery}
          exportFileSuffix={report?.range ? `${report.range.from}_a_${report.range.to}` : 'historico'}
          departmentLabel={departmentLabel}
          active
          notify={notify}
        />
      ) : !report ? (
        loadError ? (
          <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
            {loadError}
          </p>
        ) : (
          <p role="status" aria-live="polite" className="text-sm text-slate-500 dark:text-zinc-400">
            Carregando relatório...
          </p>
        )
      ) : (
        <div aria-busy={loading} className={cn('grid grid-cols-1 gap-10 transition-opacity', loading && 'opacity-60')}>
          <KpiRow report={report} />

          <div className="border-t border-slate-200 pt-8 dark:border-[#27272a]">
            <EvolutionChart
              buckets={report.series}
              granularity={report.granularity}
              onGranularityChange={setGranularity}
              compare={compare}
              onCompareChange={setCompare}
              canCompare={report.previousRange?.comparable === true}
              loading={loading}
            />
          </div>

          <div className="grid grid-cols-1 gap-x-14 gap-y-10 border-t border-slate-200 pt-8 dark:border-[#27272a] xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
            <DistributionPanel report={report} departmentLabel={departmentLabel} />
            <InsightsCard insights={insights} />
          </div>

          <DataQuality report={report} />
        </div>
      )}
    </div>
  );
}
