import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { API_BASE_URL, api, downloadWithFeedback } from '../../lib/api';
import { ORIGIN_LABEL, UNKNOWN_DEPARTMENT_LABEL, formatDateTime } from '../../lib/time-savings-metrics';
import type { TimeSavingsExecutionRow, TimeSavingsExecutionsPage } from '../../lib/types';
import { cn, formatSecondsToHuman } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';

type SortField = 'at' | 'robot' | 'user' | 'department' | 'units' | 'saved';

const PAGE_SIZE = 25;

const COLUMNS: Array<{ field: SortField; label: string; align?: 'right' }> = [
  { field: 'at', label: 'Data' },
  { field: 'robot', label: 'Automação' },
  { field: 'user', label: 'Pessoa' },
  { field: 'department', label: 'Departamento' },
  { field: 'units', label: 'Unidades', align: 'right' },
  { field: 'saved', label: 'Tempo economizado', align: 'right' },
];

const ORIGIN_SHORT: Record<TimeSavingsExecutionRow['origin'], string> = {
  hub: 'Hub',
  external: 'Integração',
  external_metric: 'Legado',
};

export function ExecutionsTable({
  baseQuery,
  exportFileSuffix,
  departmentLabel,
  active,
  notify,
}: {
  // Filtros globais da página já serializados (período, automação, setor...).
  baseQuery: string;
  exportFileSuffix: string;
  departmentLabel: (slug: string) => string;
  active: boolean;
  notify: (message: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sort, setSort] = useState<SortField>('at');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [includeZero, setIncludeZero] = useState(false);
  const [outliersOnly, setOutliersOnly] = useState(false);
  const [data, setData] = useState<TimeSavingsExecutionsPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  // Qualquer mudança de filtro volta para a primeira página.
  useEffect(() => {
    setPage(1);
  }, [baseQuery, debouncedSearch, includeZero, outliersOnly, sort, dir]);

  function detailQuery(extra: Record<string, string>) {
    const query = new URLSearchParams(baseQuery);
    if (debouncedSearch) query.set('search', debouncedSearch);
    if (includeZero) query.set('includeZero', 'true');
    if (outliersOnly) query.set('outliersOnly', 'true');
    query.set('sort', sort);
    query.set('dir', dir);
    for (const [key, value] of Object.entries(extra)) query.set(key, value);
    return query.toString();
  }

  useEffect(() => {
    if (!active) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    api<TimeSavingsExecutionsPage>(
      `/reports/time-savings/executions?${detailQuery({ page: String(page), pageSize: String(PAGE_SIZE) })}`,
    )
      .then((result) => {
        if (seq === requestSeq.current) setData(result);
      })
      .catch((err: unknown) => {
        if (seq === requestSeq.current) {
          setError(err instanceof Error ? err.message : 'Não foi possível carregar as execuções.');
        }
      })
      .finally(() => {
        if (seq === requestSeq.current) setLoading(false);
      });
    // detailQuery depende dos mesmos estados listados abaixo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, baseQuery, debouncedSearch, includeZero, outliersOnly, sort, dir, page]);

  function toggleSort(field: SortField) {
    if (sort === field) {
      setDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(field);
      setDir(field === 'at' || field === 'saved' || field === 'units' ? 'desc' : 'asc');
    }
  }

  function exportCsv() {
    void downloadWithFeedback(
      `${API_BASE_URL}/reports/time-savings/executions?${detailQuery({ format: 'csv' })}`,
      `tempo-ganho-execucoes_${exportFileSuffix}.csv`,
      notify,
    );
  }

  const items = data?.items ?? [];
  const start = data && data.total > 0 ? (data.page - 1) * data.pageSize + 1 : 0;
  const end = data ? Math.min(data.total, data.page * data.pageSize) : 0;

  return (
    <section aria-labelledby="executions-title" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="executions-title" className="text-lg font-semibold tracking-tight text-slate-950 dark:text-white">
            Detalhes das execuções
          </h2>
          <p className="text-sm text-slate-500 dark:text-zinc-400">
            Uma linha por execução com ganho, para auditar de onde vem cada número.
          </p>
        </div>
        <Button variant="outline" className="h-10 gap-2" onClick={exportCsv} disabled={!data || data.total === 0}>
          <Download className="h-4 w-4" aria-hidden="true" />
          Exportar CSV
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="relative w-full sm:w-72">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar automação, pessoa ou setor"
            aria-label="Buscar nas execuções"
            className="h-10 w-full rounded-xl border border-slate-300 bg-white pl-9 pr-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:placeholder:text-zinc-500"
          />
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={includeZero}
            onChange={(event) => setIncludeZero(event.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500 dark:border-[#3b3b42]"
          />
          Incluir execuções sem ganho
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={outliersOnly}
            onChange={(event) => setOutliersOnly(event.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500 dark:border-[#3b3b42]"
          />
          Só outliers
        </label>
      </div>

      <div className={cn('-mx-4 transition-opacity sm:mx-0', loading && 'opacity-60')}>
        <Table className="min-w-[860px] table-fixed">
          <colgroup>
            <col className="w-[130px]" />
            <col className="w-[18%]" />
            <col className="w-[16%]" />
            <col className="w-[105px]" />
            <col className="w-[13%]" />
            <col className="w-[175px]" />
            <col className="w-[160px]" />
          </colgroup>
          <TableHeader>
            <TableRow>
              {COLUMNS.map((column) => (
                <TableHead
                  key={column.field}
                  className={cn('whitespace-nowrap px-3', column.align === 'right' && 'text-right')}
                  aria-sort={sort === column.field ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(column.field)}
                    className={cn(
                      'inline-flex items-center gap-1 uppercase tracking-[0.12em] transition-colors hover:text-slate-700 dark:hover:text-zinc-200',
                      sort === column.field && 'text-slate-700 dark:text-zinc-200',
                    )}
                  >
                    {column.label}
                    {sort === column.field ? (
                      dir === 'asc' ? (
                        <ArrowUp className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <ArrowDown className="h-3 w-3" aria-hidden="true" />
                      )
                    ) : null}
                  </button>
                </TableHead>
              ))}
              <TableHead className="px-3">Origem</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="whitespace-nowrap px-3 py-2.5 tabular-nums text-slate-500 dark:text-zinc-400">
                  {formatDateTime(item.at)}
                </TableCell>
                <TableCell className="max-w-[240px] truncate px-3 py-2.5 font-medium" title={item.robotName}>
                  {item.robotName}
                </TableCell>
                <TableCell className="max-w-[200px] truncate px-3 py-2.5" title={item.userName}>
                  {item.userName}
                </TableCell>
                <TableCell className="px-3 py-2.5 text-slate-500 dark:text-zinc-400">
                  {item.department === 'outros' ? UNKNOWN_DEPARTMENT_LABEL : departmentLabel(item.department)}
                </TableCell>
                <TableCell
                  className="truncate px-3 py-2.5 text-right tabular-nums text-slate-500 dark:text-zinc-400"
                  title={item.unitsMissing ? 'Unidades não informadas' : `${item.unitsProcessed.toLocaleString('pt-BR')} ${item.unitLabel}`}
                >
                  {item.unitsMissing ? '—' : `${item.unitsProcessed.toLocaleString('pt-BR')} ${item.unitLabel}`}
                </TableCell>
                <TableCell className="whitespace-nowrap px-3 py-2.5 text-right font-semibold tabular-nums text-slate-900 dark:text-zinc-100">
                  {item.savedSeconds > 0 ? (
                    formatSecondsToHuman(item.savedSeconds)
                  ) : (
                    <span className="font-normal text-slate-400 dark:text-zinc-500">Sem ganho</span>
                  )}
                </TableCell>
                <TableCell className="px-3 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    <Badge variant="muted" title={ORIGIN_LABEL[item.origin]}>
                      {ORIGIN_SHORT[item.origin]}
                    </Badge>
                    {item.isOutlier ? (
                      <Badge variant="warning" title="Acima do limite de outlier do período">
                        Outlier
                      </Badge>
                    ) : null}
                    {item.unitsAssumed ? (
                      <Badge variant="muted" title="Ganho calculado assumindo 1 unidade (unidades não informadas pelo robô)">
                        Unid. assumida
                      </Badge>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {error ? (
          <p role="alert" className="px-3 py-6 text-sm text-rose-600 dark:text-rose-400">
            {error}
          </p>
        ) : !loading && items.length === 0 ? (
          <p className="px-3 py-8 text-sm text-slate-500 dark:text-zinc-400">
            Nenhuma execução encontrada para os filtros atuais.
            {!includeZero ? ' Execuções sem ganho estão ocultas.' : ''}
          </p>
        ) : null}
      </div>

      {data && data.total > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-500 dark:text-zinc-400">
          <span className="tabular-nums">
            {start}–{end} de {data.total.toLocaleString('pt-BR')} · {formatSecondsToHuman(data.savedSeconds)} no total
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={data.page <= 1 || loading}
              onClick={() => setPage((prev) => prev - 1)}
              className="gap-1"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              Anterior
            </Button>
            <span className="tabular-nums">
              Página {data.page} de {data.totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={data.page >= data.totalPages || loading}
              onClick={() => setPage((prev) => prev + 1)}
              className="gap-1"
            >
              Próxima
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
