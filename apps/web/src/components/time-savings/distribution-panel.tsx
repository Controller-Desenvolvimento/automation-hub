import { useMemo, useState } from 'react';
import { UNKNOWN_DEPARTMENT_LABEL, formatPct } from '../../lib/time-savings-metrics';
import type { TimeSavingsConcentration, TimeSavingsReport } from '../../lib/types';
import { cn, formatSecondsToHuman } from '../../lib/utils';
import { InfoTip } from './info-tip';

type TabId = 'robot' | 'department' | 'user';

type Row = {
  id: string;
  name: string;
  savedSeconds: number;
  sharePct: number;
  executions: number;
};

const TOP_LIMIT = 10;

export function DistributionPanel({
  report,
  departmentLabel,
}: {
  report: TimeSavingsReport;
  departmentLabel: (slug: string) => string;
}) {
  const [tab, setTab] = useState<TabId>('robot');
  const [expanded, setExpanded] = useState(false);

  const rows = useMemo<Record<TabId, Row[]>>(
    () => ({
      robot: report.byRobot.map((row) => ({
        id: row.robotId,
        name: row.robotName,
        savedSeconds: row.savedSeconds,
        sharePct: row.sharePct,
        executions: row.executions,
      })),
      department: report.byDepartment.map((row) => ({
        id: row.department,
        name: row.department === 'outros' ? UNKNOWN_DEPARTMENT_LABEL : departmentLabel(row.department),
        savedSeconds: row.savedSeconds,
        sharePct: row.sharePct,
        executions: row.executions,
      })),
      user: report.byUser.map((row) => ({
        id: row.userId,
        name: row.userName,
        savedSeconds: row.savedSeconds,
        sharePct: row.sharePct,
        executions: row.executions,
      })),
    }),
    [report, departmentLabel],
  );

  const tabs: Array<{ id: TabId; label: string }> = [
    { id: 'robot', label: 'Automação' },
    { id: 'department', label: 'Departamento' },
    { id: 'user', label: 'Pessoa' },
  ];

  const current = rows[tab];
  const visible = expanded ? current : current.slice(0, TOP_LIMIT);
  const concentration: TimeSavingsConcentration | null =
    tab === 'robot'
      ? report.concentration.byRobot
      : tab === 'department'
        ? report.concentration.byDepartment
        : null;
  const maxShare = Math.max(1, ...current.map((row) => row.sharePct));

  function selectTab(next: TabId) {
    setTab(next);
    setExpanded(false);
  }

  return (
    <section aria-labelledby="distribution-title" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="distribution-title" className="text-lg font-semibold tracking-tight text-slate-950 dark:text-white">
          Onde o tempo está sendo economizado
        </h2>
        <div role="tablist" aria-label="Agrupar por" className="flex gap-1">
          {tabs.map((item) => (
            <button
              key={item.id}
              id={`distribution-tab-${item.id}`}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              aria-controls="distribution-panel"
              onClick={() => selectTab(item.id)}
              className={cn(
                'h-8 rounded-lg px-3 text-sm font-medium transition-colors',
                tab === item.id
                  ? 'bg-slate-100 text-slate-950 dark:bg-[#1c1c20] dark:text-white'
                  : 'text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-100',
              )}
            >
              {item.label}
              <span className="ml-1.5 text-xs tabular-nums text-slate-400 dark:text-zinc-500">
                {rows[item.id].length}
              </span>
            </button>
          ))}
        </div>
      </div>

      {concentration && concentration.count > 0 ? (
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500 dark:text-zinc-400">
          <span className="flex items-center gap-1">
            Concentração
            <InfoTip label="O que é concentração">
              Quanto do tempo economizado vem das 1 e das 3 maiores linhas. Valores altos indicam dependência de poucas
              {tab === 'robot' ? ' automações' : ' áreas'}.
            </InfoTip>
          </span>
          <span>
            Top 1: <strong className="font-semibold tabular-nums text-slate-900 dark:text-zinc-100">{formatPct(concentration.top1Pct)}</strong>
          </span>
          {concentration.count > 1 ? (
            <span>
              Top 3: <strong className="font-semibold tabular-nums text-slate-900 dark:text-zinc-100">{formatPct(concentration.top3Pct)}</strong>
            </span>
          ) : null}
        </p>
      ) : null}

      <div
        id="distribution-panel"
        role="tabpanel"
        aria-labelledby={`distribution-tab-${tab}`}
      >
        {current.length === 0 ? (
          <p className="py-6 text-sm text-slate-500 dark:text-zinc-400">Nenhum ganho registrado para este agrupamento no período.</p>
        ) : (
          <ol className="divide-y divide-slate-100 dark:divide-[#1f1f23]">
            {visible.map((row, index) => (
              <li
                key={row.id}
                className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 py-2.5 sm:grid-cols-[1.25rem_minmax(0,1.2fr)_minmax(0,1fr)_5.5rem_3.5rem]"
              >
                <span className="text-right text-xs tabular-nums text-slate-400 dark:text-zinc-600">{index + 1}</span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-900 dark:text-zinc-100" title={row.name}>
                    {row.name}
                  </p>
                  <p className="text-xs text-slate-400 dark:text-zinc-500">
                    {row.executions} {row.executions === 1 ? 'execução' : 'execuções'}
                  </p>
                </div>
                <div className="hidden h-1.5 rounded-full bg-slate-100 dark:bg-[#1c1c20] sm:block" aria-hidden="true">
                  <div
                    className="h-1.5 rounded-full bg-sky-500"
                    style={{ width: `${Math.max(2, (row.sharePct / maxShare) * 100)}%` }}
                  />
                </div>
                <span className="text-right text-sm font-semibold tabular-nums text-slate-900 dark:text-zinc-100">
                  {formatSecondsToHuman(row.savedSeconds)}
                </span>
                <span className="hidden text-right text-sm tabular-nums text-slate-500 dark:text-zinc-400 sm:block">
                  {formatPct(row.sharePct)}
                </span>
              </li>
            ))}
          </ol>
        )}

        {current.length > TOP_LIMIT ? (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="mt-2 text-sm font-medium text-sky-600 hover:underline dark:text-sky-400"
          >
            {expanded ? 'Mostrar menos' : `Ver todos (${current.length})`}
          </button>
        ) : null}
      </div>
    </section>
  );
}
