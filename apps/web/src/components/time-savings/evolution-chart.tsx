import { useEffect, useMemo, useRef, useState } from 'react';
import { formatDay, formatDayShort, formatNumber } from '../../lib/time-savings-metrics';
import type { TimeSavingsBucket, TimeSavingsGranularity } from '../../lib/types';
import { cn, formatSecondsToHuman } from '../../lib/utils';

const GRANULARITIES: Array<{ id: TimeSavingsGranularity; label: string }> = [
  { id: 'day', label: 'Dia' },
  { id: 'week', label: 'Semana' },
  { id: 'month', label: 'Mês' },
];

const HEIGHT = 248;
const MARGIN = { top: 12, right: 8, bottom: 28, left: 52 };
const TOOLTIP_WIDTH = 196;

function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}

// Escala "bonita": passos de 1, 2, 2,5, 5 × 10^n, sempre cobrindo o máximo.
function niceScale(maxValue: number, tickCount = 4) {
  if (!(maxValue > 0)) return { max: 1, ticks: [0, 1] };
  const rawStep = maxValue / tickCount;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) * magnitude;
  const max = Math.ceil(maxValue / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step / 1000; value += step) ticks.push(Number(value.toFixed(6)));
  return { max, ticks };
}

function bucketTitle(bucket: TimeSavingsBucket, granularity: TimeSavingsGranularity) {
  if (granularity === 'day') {
    const weekday = new Date(`${bucket.from}T12:00:00Z`).toLocaleDateString('pt-BR', {
      weekday: 'short',
      timeZone: 'UTC',
    });
    return `${formatDay(bucket.from)} (${weekday.replace('.', '')})`;
  }
  if (granularity === 'week') {
    return `Semana de ${formatDayShort(bucket.from)} a ${formatDayShort(bucket.to)}`;
  }
  return new Date(`${bucket.from}T12:00:00Z`).toLocaleDateString('pt-BR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function EvolutionChart({
  buckets,
  granularity,
  onGranularityChange,
  compare,
  onCompareChange,
  canCompare,
  loading,
}: {
  buckets: TimeSavingsBucket[];
  granularity: TimeSavingsGranularity;
  onGranularityChange: (value: TimeSavingsGranularity) => void;
  compare: boolean;
  onCompareChange: (value: boolean) => void;
  canCompare: boolean;
  loading: boolean;
}) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const showPrevious = compare && canCompare;

  const hasData = buckets.some((bucket) => bucket.savedSeconds > 0 || (bucket.previousSavedSeconds ?? 0) > 0);

  const scale = useMemo(() => {
    const maxSeconds = Math.max(
      0,
      ...buckets.map((bucket) =>
        Math.max(bucket.savedSeconds, showPrevious ? (bucket.previousSavedSeconds ?? 0) : 0),
      ),
    );
    // Abaixo de 1h o eixo fica em minutos; senão em horas.
    const useMinutes = maxSeconds < 3600;
    const divisor = useMinutes ? 60 : 3600;
    const suffix = useMinutes ? 'min' : 'h';
    return { ...niceScale(maxSeconds / divisor), divisor, suffix };
  }, [buckets, showPrevious]);

  const innerWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const band = buckets.length > 0 ? innerWidth / buckets.length : 0;
  const barWidth = Math.min(44, Math.max(2, band * 0.68));
  const yFor = (seconds: number) =>
    MARGIN.top + innerHeight - (seconds / scale.divisor / scale.max) * innerHeight;
  const centerX = (index: number) => MARGIN.left + index * band + band / 2;

  const labelEvery = band > 0 ? Math.max(1, Math.ceil(56 / band)) : 1;
  const totalSeconds = buckets.reduce((sum, bucket) => sum + bucket.savedSeconds, 0);
  const ariaLabel = `Gráfico de barras do tempo economizado por ${
    granularity === 'day' ? 'dia' : granularity === 'week' ? 'semana' : 'mês'
  }, total de ${formatSecondsToHuman(totalSeconds)}.`;

  const hovered = hover !== null ? buckets[hover] : null;
  const tooltipLeft =
    hover !== null
      ? centerX(hover) < width / 2
        ? Math.min(width - TOOLTIP_WIDTH, centerX(hover) + 14)
        : Math.max(0, centerX(hover) - 14 - TOOLTIP_WIDTH)
      : 0;

  const previousPath = showPrevious
    ? buckets
        .map((bucket, index) => `${index === 0 ? 'M' : 'L'}${centerX(index)},${yFor(bucket.previousSavedSeconds ?? 0)}`)
        .join(' ')
    : '';

  return (
    <section aria-labelledby="evolution-title" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <h2 id="evolution-title" className="text-lg font-semibold tracking-tight text-slate-950 dark:text-white">
            Evolução do tempo economizado
          </h2>
          {showPrevious ? (
            <div className="flex items-center gap-4 text-xs text-slate-500 dark:text-zinc-400" aria-hidden="true">
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm bg-sky-500" /> Período atual
              </span>
              <span className="flex items-center gap-1.5">
                <svg width="16" height="6" className="stroke-slate-400 dark:stroke-zinc-400">
                  <line x1="0" y1="3" x2="16" y2="3" strokeWidth="2" strokeDasharray="3 3" />
                </svg>
                Período anterior
              </span>
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <label
            className={cn(
              'flex items-center gap-2 text-sm text-slate-600 dark:text-zinc-300',
              canCompare ? 'cursor-pointer' : 'cursor-not-allowed opacity-50',
            )}
          >
            <input
              type="checkbox"
              checked={showPrevious}
              disabled={!canCompare}
              onChange={(event) => onCompareChange(event.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500 dark:border-[#3b3b42]"
            />
            Comparar com período anterior
          </label>
          <div role="group" aria-label="Granularidade" className="flex rounded-lg bg-slate-100 p-0.5 dark:bg-[#18181b]">
            {GRANULARITIES.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={granularity === item.id}
                onClick={() => onGranularityChange(item.id)}
                className={cn(
                  'h-8 rounded-md px-3 text-sm font-medium transition-colors',
                  granularity === item.id
                    ? 'bg-white text-slate-950 shadow-sm dark:bg-[#2a2a30] dark:text-white'
                    : 'text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-100',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div
        ref={containerRef}
        className={cn('relative transition-opacity', loading && 'opacity-60')}
        style={{ height: HEIGHT }}
      >
        {!hasData ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-500 dark:text-zinc-400">
            Nenhuma execução com ganho neste período.
          </div>
        ) : width > 0 ? (
          <>
            <svg width={width} height={HEIGHT} role="img" aria-label={ariaLabel} className="block overflow-visible">
              {scale.ticks.map((tick) => {
                const y = yFor(tick * scale.divisor);
                return (
                  <g key={tick}>
                    <line
                      x1={MARGIN.left}
                      x2={width - MARGIN.right}
                      y1={y}
                      y2={y}
                      className={tick === 0 ? 'stroke-slate-300 dark:stroke-[#3a3a42]' : 'stroke-slate-100 dark:stroke-[#1f1f23]'}
                    />
                    <text
                      x={MARGIN.left - 10}
                      y={y}
                      textAnchor="end"
                      dominantBaseline="middle"
                      className="fill-slate-500 text-[11px] tabular-nums dark:fill-zinc-500"
                    >
                      {formatNumber(tick, Number.isInteger(tick) ? 0 : 1)}
                      {scale.suffix}
                    </text>
                  </g>
                );
              })}

              {buckets.map((bucket, index) => {
                const top = yFor(bucket.savedSeconds);
                const height = Math.max(0, MARGIN.top + innerHeight - top);
                return (
                  <rect
                    key={bucket.key}
                    x={centerX(index) - barWidth / 2}
                    y={top}
                    width={barWidth}
                    height={bucket.savedSeconds > 0 ? Math.max(1.5, height) : 0}
                    rx={Math.min(3, barWidth / 3)}
                    className={cn(
                      'transition-colors',
                      hover === index
                        ? 'fill-sky-400'
                        : bucket.weekend
                          ? 'fill-sky-500/40'
                          : 'fill-sky-500',
                    )}
                  />
                );
              })}

              {showPrevious ? (
                <>
                  <path
                    d={previousPath}
                    fill="none"
                    strokeWidth={2}
                    strokeDasharray="4 4"
                    strokeLinejoin="round"
                    className="stroke-slate-400 dark:stroke-zinc-400"
                  />
                  {buckets.length <= 40
                    ? buckets.map((bucket, index) => (
                        <circle
                          key={bucket.key}
                          cx={centerX(index)}
                          cy={yFor(bucket.previousSavedSeconds ?? 0)}
                          r={2.5}
                          className="fill-white stroke-slate-400 dark:fill-[#09090b] dark:stroke-zinc-400"
                          strokeWidth={1.5}
                        />
                      ))
                    : null}
                </>
              ) : null}

              {buckets.map((bucket, index) =>
                index % labelEvery === 0 ? (
                  <text
                    key={bucket.key}
                    x={centerX(index)}
                    y={HEIGHT - 8}
                    textAnchor="middle"
                    className="fill-slate-500 text-[11px] tabular-nums dark:fill-zinc-500"
                  >
                    {bucket.label}
                  </text>
                ) : null,
              )}

              {/* Faixas de interação: uma por bucket, cobrindo a altura toda. */}
              {buckets.map((bucket, index) => (
                <rect
                  key={`hit-${bucket.key}`}
                  x={MARGIN.left + index * band}
                  y={MARGIN.top}
                  width={band}
                  height={innerHeight}
                  fill="transparent"
                  onMouseEnter={() => setHover(index)}
                  onMouseMove={() => setHover(index)}
                  onMouseLeave={() => setHover((current) => (current === index ? null : current))}
                  onClick={() => setHover((current) => (current === index ? null : index))}
                />
              ))}
            </svg>

            {hovered ? (
              <div
                role="status"
                className="pointer-events-none absolute z-10 rounded-xl border border-slate-200 bg-white p-3 text-xs shadow-lg dark:border-[#2b2b31] dark:bg-[#18181b]"
                style={{ left: tooltipLeft, top: 4, width: TOOLTIP_WIDTH }}
              >
                <p className="mb-1.5 font-medium capitalize text-slate-500 dark:text-zinc-400">
                  {bucketTitle(hovered, granularity)}
                </p>
                <p className="text-base font-semibold tabular-nums text-slate-950 dark:text-white">
                  {formatSecondsToHuman(hovered.savedSeconds)}
                </p>
                <p className="text-slate-500 dark:text-zinc-400">
                  {hovered.executions} {hovered.executions === 1 ? 'execução com ganho' : 'execuções com ganho'}
                </p>
                {showPrevious ? (
                  <p className="mt-1.5 border-t border-slate-100 pt-1.5 text-slate-500 dark:border-[#27272a] dark:text-zinc-400">
                    Período anterior:{' '}
                    <span className="font-medium text-slate-700 dark:text-zinc-200">
                      {formatSecondsToHuman(hovered.previousSavedSeconds ?? 0)}
                    </span>
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
