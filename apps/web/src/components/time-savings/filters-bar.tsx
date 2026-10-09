import { CalendarDays, ChevronDown, Download, Search, SlidersHorizontal } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import {
  PERIOD_PRESETS,
  formatDay,
  matchPreset,
  presetRange,
} from '../../lib/time-savings-metrics';
import type { TimeSavingsOriginFilter } from '../../lib/types';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Popover } from './popover';

export type TimeSavingsFilters = {
  from: string;
  to: string;
  robotId: string;
  department: string;
  userIds: string[];
  origin: '' | TimeSavingsOriginFilter;
};

const CONTROL_CLASS =
  'flex h-10 items-center gap-2 rounded-xl border border-slate-300 bg-white px-3.5 text-sm text-slate-900 outline-none transition hover:border-slate-400 focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:hover:border-[#3b3b42]';

const DATE_INPUT_CLASS =
  'h-9 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-2.5 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15 [color-scheme:light] dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:[color-scheme:dark]';

function SelectControl({
  value,
  onChange,
  label,
  className,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn(CONTROL_CLASS, 'w-full cursor-pointer truncate pr-8 sm:w-[215px]', className)}
    >
      {children}
    </select>
  );
}

export function FiltersBar({
  filters,
  onChange,
  robots,
  departments,
  userOptions,
  canClear,
  onClear,
  onExport,
  exportDisabled,
}: {
  filters: TimeSavingsFilters;
  onChange: (patch: Partial<TimeSavingsFilters>) => void;
  robots: Array<{ id: string; name: string }>;
  departments: Array<{ slug: string; name: string }>;
  userOptions: Array<{ userId: string; userName: string }>;
  canClear: boolean;
  onClear: () => void;
  onExport: () => void;
  exportDisabled: boolean;
}) {
  const preset = matchPreset(filters.from, filters.to);
  const presetLabel = PERIOD_PRESETS.find((item) => item.id === preset)?.label;
  const periodLabel =
    presetLabel ??
    (filters.from && filters.to
      ? `${formatDay(filters.from)} – ${formatDay(filters.to)}`
      : 'Todo o histórico');
  const moreCount = filters.userIds.length + (filters.origin ? 1 : 0);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Popover
        trigger={({ open, toggle }) => (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-haspopup="dialog"
            className={cn(CONTROL_CLASS, 'w-full sm:w-auto')}
          >
            <CalendarDays className="h-4 w-4 text-slate-400" aria-hidden="true" />
            <span className="font-medium">{periodLabel}</span>
            {presetLabel && filters.from && filters.to ? (
              <span className="hidden text-slate-400 dark:text-zinc-500 2xl:inline">
                {formatDay(filters.from)} – {formatDay(filters.to)}
              </span>
            ) : null}
            <ChevronDown className="h-4 w-4 text-slate-400" aria-hidden="true" />
          </button>
        )}
        panelClassName="w-[330px] max-w-[calc(100vw-2rem)]"
      >
        {({ close }) => (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-1.5">
              {PERIOD_PRESETS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    onChange(presetRange(item.id));
                    close();
                  }}
                  className={cn(
                    'h-9 rounded-lg px-3 text-sm font-medium transition-colors',
                    preset === item.id
                      ? 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-200'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-zinc-300 dark:hover:bg-[#1c1c20]',
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="border-t border-slate-100 pt-3 dark:border-[#27272a]">
              <p className="mb-2 text-xs font-medium text-slate-500 dark:text-zinc-400">Intervalo personalizado</p>
              <div className="grid grid-cols-2 gap-2">
                <label className="grid gap-1 text-xs text-slate-500 dark:text-zinc-400">
                  De
                  <input
                    type="date"
                    className={DATE_INPUT_CLASS}
                    value={filters.from}
                    max={filters.to || undefined}
                    onChange={(event) => onChange({ from: event.target.value })}
                  />
                </label>
                <label className="grid gap-1 text-xs text-slate-500 dark:text-zinc-400">
                  Até
                  <input
                    type="date"
                    className={DATE_INPUT_CLASS}
                    value={filters.to}
                    min={filters.from || undefined}
                    onChange={(event) => onChange({ to: event.target.value })}
                  />
                </label>
              </div>
              <button
                type="button"
                onClick={() => {
                  onChange({ from: '', to: '' });
                  close();
                }}
                className="mt-3 text-xs font-medium text-sky-600 hover:underline dark:text-sky-400"
              >
                Todo o histórico
              </button>
            </div>
          </div>
        )}
      </Popover>

      <SelectControl label="Automação" value={filters.robotId} onChange={(robotId) => onChange({ robotId })}>
        <option value="">Todas as automações</option>
        {robots.map((robot) => (
          <option key={robot.id} value={robot.id}>
            {robot.name}
          </option>
        ))}
      </SelectControl>

      <SelectControl label="Departamento" value={filters.department} onChange={(department) => onChange({ department })}>
        <option value="">Todos os departamentos</option>
        {departments.map((department) => (
          <option key={department.slug} value={department.slug}>
            {department.name}
          </option>
        ))}
      </SelectControl>

      <MoreFilters filters={filters} onChange={onChange} userOptions={userOptions} activeCount={moreCount} />

      {canClear ? (
        <Button variant="ghost" size="sm" onClick={onClear} className="h-10">
          Limpar filtros
        </Button>
      ) : null}

      <Button variant="outline" className="h-10 gap-2 sm:ml-auto" disabled={exportDisabled} onClick={onExport}>
        <Download className="h-4 w-4" aria-hidden="true" />
        Exportar
      </Button>
    </div>
  );
}

function MoreFilters({
  filters,
  onChange,
  userOptions,
  activeCount,
}: {
  filters: TimeSavingsFilters;
  onChange: (patch: Partial<TimeSavingsFilters>) => void;
  userOptions: Array<{ userId: string; userName: string }>;
  activeCount: number;
}) {
  const [search, setSearch] = useState('');
  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('pt-BR');
    return term
      ? userOptions.filter((user) => user.userName.toLocaleLowerCase('pt-BR').includes(term))
      : userOptions;
  }, [search, userOptions]);

  function toggleUser(id: string) {
    onChange({
      userIds: filters.userIds.includes(id)
        ? filters.userIds.filter((existing) => existing !== id)
        : [...filters.userIds, id],
    });
  }

  return (
    <Popover
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="dialog"
          className={cn(CONTROL_CLASS, 'w-full sm:w-auto')}
        >
          <SlidersHorizontal className="h-4 w-4 text-slate-400" aria-hidden="true" />
          <span>Mais filtros</span>
          {activeCount > 0 ? (
            <span className="rounded-full bg-sky-100 px-1.5 text-xs font-semibold text-sky-700 dark:bg-sky-950 dark:text-sky-200">
              {activeCount}
            </span>
          ) : null}
        </button>
      )}
      align="end"
      panelClassName="w-[320px] max-w-[calc(100vw-2rem)]"
    >
      {() => (
        <div className="space-y-4">
          <label className="grid gap-1.5 text-xs font-medium text-slate-500 dark:text-zinc-400">
            Origem do dado
            <select
              value={filters.origin}
              onChange={(event) => onChange({ origin: event.target.value as TimeSavingsFilters['origin'] })}
              className="h-9 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-normal text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100"
            >
              <option value="">Todas as origens</option>
              <option value="hub">Robôs do hub</option>
              <option value="external">Integrações externas</option>
            </select>
          </label>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-medium text-slate-500 dark:text-zinc-400">Colaboradores</span>
              {filters.userIds.length > 0 ? (
                <button
                  type="button"
                  onClick={() => onChange({ userIds: [] })}
                  className="text-xs font-medium text-sky-600 hover:underline dark:text-sky-400"
                >
                  Limpar seleção ({filters.userIds.length})
                </button>
              ) : (
                <span className="text-xs text-slate-400 dark:text-zinc-500">Todos</span>
              )}
            </div>
            <div className="relative mb-2">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
                aria-hidden="true"
              />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar pessoa"
                aria-label="Buscar colaborador"
                className="h-9 w-full rounded-lg border border-slate-300 bg-white pl-8 pr-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100 dark:placeholder:text-zinc-500"
              />
            </div>
            <div className="max-h-56 overflow-y-auto pr-1">
              {visible.length === 0 ? (
                <p className="px-2 py-1.5 text-sm text-slate-500 dark:text-zinc-400">
                  {userOptions.length === 0 ? 'Nenhum colaborador no período.' : 'Ninguém encontrado.'}
                </p>
              ) : (
                visible.map((user) => (
                  <label
                    key={user.userId}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50 dark:hover:bg-white/[0.04]"
                  >
                    <input
                      type="checkbox"
                      checked={filters.userIds.includes(user.userId)}
                      onChange={() => toggleUser(user.userId)}
                      className="h-4 w-4 shrink-0 rounded border-slate-300 text-sky-600 focus:ring-sky-500 dark:border-[#3b3b42]"
                    />
                    <span className="truncate text-slate-700 dark:text-zinc-200">{user.userName}</span>
                  </label>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </Popover>
  );
}
