import { CalendarClock, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Plus, RefreshCw, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/page-header';
import { SiteFavicon } from '../components/site-favicon';
import { Avatar, AvatarFallback } from '../components/ui/avatar';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { useHub } from '../contexts/hub-context';
import { api } from '../lib/api';
import type { Execution, PowerBIRefreshLog } from '../lib/types';
import { formatDate, initialsFor, statusLabel, statusVariant, timeAgo } from '../lib/utils';

const STATUS_OPTIONS: Execution['status'][] = ['running', 'queued', 'success', 'error', 'canceled'];

type View = 'all' | 'manual' | 'scheduled' | 'bi';

export function HistoryPage() {
  const { hub, executions, refreshHub, notify } = useHub();
  const [view, setView] = useState<View>('all');
  // Filtro por automação via link: /history?robotId=<id> (botão "Ver histórico" da página do robô)
  const [searchParams, setSearchParams] = useSearchParams();
  const robotFilterId = searchParams.get('robotId');
  const robotFilterName = useMemo(
    () =>
      robotFilterId
        ? hub?.robots.find((r) => r.id === robotFilterId)?.name ??
          executions.find((e) => e.robotId === robotFilterId)?.robot?.name ??
          null
        : null,
    [hub, executions, robotFilterId],
  );
  const [userFilter, setUserFilter] = useState('');
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<Execution['status'][]>([]);
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [logs, setLogs] = useState<PowerBIRefreshLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  const scheduledCount = useMemo(() => executions.filter((e) => e.scheduledTaskId).length, [executions]);
  const manualCount    = useMemo(() => executions.filter((e) => !e.scheduledTaskId).length, [executions]);

  const filteredExecutions = useMemo(() => {
    const term = userFilter.trim().toLowerCase();

    return executions.filter((execution) => {
      const name = execution.requestedByName?.toLowerCase() ?? '';
      const email = execution.requestedByEmail?.toLowerCase() ?? '';
      const robot = execution.robot?.name?.toLowerCase() ?? '';
      const step = execution.currentStep?.toLowerCase() ?? '';
      const matchesTerm =
        !term ||
        name.includes(term) ||
        email.includes(term) ||
        robot.includes(term) ||
        step.includes(term);
      const matchesStatus = statusFilter.length === 0 || statusFilter.includes(execution.status);
      const matchesRobot = !robotFilterId || execution.robotId === robotFilterId;
      const matchesOrigin =
        view !== 'scheduled' && view !== 'manual' ||
        (view === 'scheduled' && Boolean(execution.scheduledTaskId)) ||
        (view === 'manual' && !execution.scheduledTaskId);
      return matchesTerm && matchesStatus && matchesOrigin && matchesRobot;
    });
  }, [executions, view, statusFilter, userFilter, robotFilterId]);

  const totalPages = Math.max(1, Math.ceil(filteredExecutions.length / rowsPerPage));
  const currentPage = Math.min(page, totalPages);
  const pageStart = filteredExecutions.length === 0 ? 0 : (currentPage - 1) * rowsPerPage + 1;
  const pageEnd = Math.min(filteredExecutions.length, currentPage * rowsPerPage);

  const pageExecutions = useMemo(() => {
    const start = (currentPage - 1) * rowsPerPage;
    return filteredExecutions.slice(start, start + rowsPerPage);
  }, [currentPage, filteredExecutions, rowsPerPage]);

  const toggleStatus = (status: Execution['status']) => {
    setPage(1);
    setStatusFilter((current) =>
      current.includes(status) ? current.filter((item) => item !== status) : [...current, status],
    );
  };

  useEffect(() => {
    setPage(1);
  }, [rowsPerPage, userFilter, statusFilter, view, robotFilterId]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      await refreshHub();
      if (cancelled) return;
      timer = window.setTimeout(poll, 2500);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [refreshHub]);

  useEffect(() => {
    if (view === 'bi') {
      void loadLogs();
    }
  }, [view]);

  async function loadLogs() {
    try {
      setLogsLoading(true);
      const data = await api<PowerBIRefreshLog[]>('/sites/powerbi-refresh-logs');
      setLogs(data);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível carregar o histórico BI.');
    } finally {
      setLogsLoading(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-5">
      <PageHeader
        title={<>Execuções <span className="text-sky-600 dark:text-sky-400">registradas</span></>}
        description="Veja e filtre as execuções do hub."
      />

      <div className="flex gap-1 rounded-2xl border border-slate-200 bg-slate-50 p-1 dark:border-[#27272a] dark:bg-[#111113]">
        {(
          [
            { key: 'all', label: 'Todas', count: executions.length },
            { key: 'manual', label: 'Manuais', count: manualCount },
            { key: 'scheduled', label: 'Agendamentos', count: scheduledCount },
          ] as const
        ).map(({ key, label, count }) => (
          <button
            key={key}
            type="button"
            onClick={() => setView(key)}
            className={[
              'flex items-center gap-2 rounded-xl px-4 py-1.5 text-sm font-medium transition',
              view === key
                ? 'bg-white text-slate-900 shadow-sm dark:bg-[#1b1b20] dark:text-white'
                : 'text-slate-700 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-200',
            ].join(' ')}
          >
            {label}
            <span
              className={[
                'rounded-full px-1.5 py-0.5 text-xs',
                view === key
                  ? 'bg-slate-100 text-slate-600 dark:bg-[#27272a] dark:text-zinc-300'
                  : 'bg-transparent text-slate-400 dark:text-zinc-500',
              ].join(' ')}
            >
              {count}
            </span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => setView('bi')}
          className={[
            'flex items-center gap-2 rounded-xl px-4 py-1.5 text-sm font-medium transition',
            view === 'bi'
              ? 'bg-white text-slate-900 shadow-sm dark:bg-[#1b1b20] dark:text-white'
              : 'text-slate-700 hover:text-slate-900 dark:text-zinc-400 dark:hover:text-zinc-200',
          ].join(' ')}
        >
          Atualizações BI
        </button>
      </div>

      {view !== 'bi' ? (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="relative w-full sm:max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                className="pl-9"
                value={userFilter}
                onChange={(event) => setUserFilter(event.target.value)}
                placeholder="Buscar por robô, usuário ou status..."
              />
            </div>

            {robotFilterId ? (
              <button
                type="button"
                onClick={() => setSearchParams({}, { replace: true })}
                title="Remover filtro de automação"
                className="inline-flex h-12 items-center gap-2 rounded-2xl border border-sky-300 bg-sky-50 px-4 text-sm font-medium text-sky-800 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200 dark:hover:bg-sky-950/70"
              >
                <span className="max-w-[16rem] truncate">Automação: {robotFilterName ?? 'selecionada'}</span>
                <X className="h-4 w-4 shrink-0" />
              </button>
            ) : null}

            <div className="relative">
              <Button variant="outline" onClick={() => setStatusMenuOpen((current) => !current)}>
                <Plus className="mr-2 h-4 w-4" />
                Status
                <ChevronDown className="ml-2 h-4 w-4" />
              </Button>

              {statusMenuOpen ? (
                <div className="absolute left-0 z-20 mt-2 w-72 rounded-2xl border border-slate-300 bg-white p-2 shadow-lg dark:border-[#2b2b31] dark:bg-[#111113]">
                  <div className="mb-2 px-2 pt-1 text-sm font-medium text-slate-500 dark:text-zinc-400">Status</div>
                  <div className="grid grid-cols-1 gap-1">
                    {STATUS_OPTIONS.map((status) => {
                      const active = statusFilter.includes(status);

                      return (
                        <button
                          key={status}
                          type="button"
                          className={[
                            'flex items-center justify-between rounded-xl px-3 py-2 text-sm transition',
                            active
                              ? 'bg-slate-100 text-slate-950 dark:bg-[#1b1b20] dark:text-white'
                              : 'text-slate-600 hover:bg-slate-50 dark:text-zinc-300 dark:hover:bg-[#18181b]',
                          ].join(' ')}
                          onClick={() => toggleStatus(status)}
                        >
                          <span className="flex items-center gap-3">
                            <span
                              className={[
                                'flex h-4 w-4 items-center justify-center rounded border',
                                active
                                  ? 'border-sky-500 bg-sky-500 text-white'
                                  : 'border-slate-300 bg-white dark:border-[#384965] dark:bg-transparent',
                              ].join(' ')}
                            >
                              {active ? <Check className="h-3 w-3" /> : null}
                            </span>
                            {statusLabel(status)}
                          </span>
                          <span className="text-xs text-slate-400">
                            {executions.filter((execution) => execution.status === status).length}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <Card className="overflow-hidden rounded-3xl">
            <CardContent className="px-0 pb-0 pt-1">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Execução</TableHead>
                    <TableHead className="w-px whitespace-nowrap">Status</TableHead>
                    <TableHead className="w-px whitespace-nowrap">Solicitante</TableHead>
                    <TableHead className="w-px whitespace-nowrap">Etapa atual</TableHead>
                    <TableHead className="w-px whitespace-nowrap">Data</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageExecutions.map((execution) => (
                    <TableRow key={execution.id}>
                      <TableCell>
                        <Link to={`/executions/${execution.id}`} className="grid grid-cols-1 gap-1">
                          <span className="flex items-center gap-2 font-medium text-slate-950 dark:text-white">
                            {execution.robot?.name ?? 'Execução'}
                            {execution.scheduledTaskId ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
                                <CalendarClock className="h-3 w-3" />
                                Agendado
                              </span>
                            ) : null}
                          </span>
                          <span className="text-xs text-slate-500 dark:text-zinc-400">
                            {execution.robot?.summary || execution.currentStep || 'Execução registrada no hub'}
                          </span>
                        </Link>
                      </TableCell>
                      <TableCell className="w-px whitespace-nowrap">
                        <Badge variant={statusVariant(execution.status)}>{statusLabel(execution.status)}</Badge>
                      </TableCell>
                      <TableCell className="w-px whitespace-nowrap">
                        <div className="flex items-center gap-3">
                          <Avatar className="h-9 w-9">
                            <AvatarFallback>
                              {initialsFor(execution.requestedByName || execution.requestedByEmail || 'U')}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <div className="font-medium">{execution.requestedByName || 'Usuário interno'}</div>
                            <div className="text-xs text-slate-500 dark:text-zinc-400">
                              {execution.requestedByEmail || ''}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="w-px whitespace-nowrap text-slate-500 dark:text-zinc-400">
                        {execution.currentStep || 'Aguardando na fila'}
                      </TableCell>
                      <TableCell className="w-px whitespace-nowrap text-slate-500 dark:text-zinc-400">{formatDate(execution.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div className="flex flex-col gap-3 border-t border-slate-200 px-4 pb-2 pt-4 text-sm text-slate-500 dark:border-[#27272a] dark:text-zinc-400 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                  <span>Linhas por página:</span>
                  <select
                    value={rowsPerPage}
                    onChange={(event) => setRowsPerPage(Number(event.target.value))}
                    className="h-9 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-800 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100"
                  >
                    <option value={5}>5</option>
                    <option value={10}>10</option>
                    <option value={20}>20</option>
                  </select>
                  <span>
                    {pageStart}-{pageEnd} de {filteredExecutions.length}
                  </span>
                </div>

                <div className="flex items-center gap-2 self-end sm:self-auto">
                  <Button variant="outline" size="sm" onClick={() => setPage(1)} disabled={currentPage === 1}>
                    <ChevronsLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((value) => Math.max(1, value - 1))}
                    disabled={currentPage === 1}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="px-2 text-xs font-medium text-slate-600 dark:text-zinc-300">
                    {currentPage} / {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                    disabled={currentPage === totalPages}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setPage(totalPages)} disabled={currentPage === totalPages}>
                    <ChevronsRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      ) : logsLoading ? (
        <div className="animate-pulse rounded-3xl border border-slate-200 bg-slate-100 dark:border-[#27272a] dark:bg-slate-800/50">
          <div className="px-5 py-6">
            <div className="h-4 w-1/2 rounded bg-slate-200 dark:bg-slate-700" />
          </div>
        </div>
      ) : (
        <Card className="overflow-hidden rounded-3xl">
          <CardContent className="p-0">
            {logs.length === 0 ? (
              <p className="px-5 py-6 text-sm text-slate-500 dark:text-zinc-400">Nenhuma atualização BI registrada ainda.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Dashboard</TableHead>
                      <TableHead>Solicitado por</TableHead>
                      <TableHead>Quando</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {logs.map((log) => (
                      <TableRow key={log.id}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <SiteFavicon siteId={log.siteId} />
                            <span className="font-medium text-slate-950 dark:text-white">{log.site.name}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="text-slate-900 dark:text-zinc-100">{log.requestedByName ?? '—'}</div>
                          {log.requestedByEmail ? (
                            <div className="text-xs text-slate-500 dark:text-zinc-400">{log.requestedByEmail}</div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-slate-600 dark:text-zinc-300">
                          {timeAgo(log.requestedAt)}
                        </TableCell>
                        <TableCell>
                          <RefreshLogBadge status={log.status} completedAt={log.completedAt} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function RefreshLogBadge({ status, completedAt }: { status: string; completedAt?: string | null }) {
  if (status === 'Unknown' || status === 'InProgress') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-600 dark:bg-sky-900/20 dark:text-sky-400">
        <RefreshCw className="h-2.5 w-2.5 animate-spin" />
        Atualizando...
      </span>
    );
  }
  if (status === 'Completed') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400">
        Concluído{completedAt ? ` • ${timeAgo(completedAt)}` : ''}
      </span>
    );
  }
  if (status === 'Failed') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600 dark:bg-red-900/20 dark:text-red-400">
        Falha
      </span>
    );
  }
  return <span className="text-xs text-slate-400">—</span>;
}
