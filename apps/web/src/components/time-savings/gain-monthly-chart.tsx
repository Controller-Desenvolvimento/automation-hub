import { useMemo, useState } from 'react';
import { dur, nf, signedDur, type MonthlyPoint } from '../../lib/gain-simulator';
import { cn } from '../../lib/utils';
import { niceMax, topRounded, useContainerWidth } from '../robot-health/chart-utils';

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MONTH_NAMES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const monthLabel = (key: string, withYear: boolean) => `${MONTHS[Number(key.slice(5, 7)) - 1]}${withYear ? `/${key.slice(2, 4)}` : ''}`;
const monthName = (key: string) => `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} de ${key.slice(0, 4)}`;
const pctText = (v: number) => `${v > 0.05 ? '+' : v < -0.05 ? '−' : ''}${nf(Math.abs(v), 0)}%`;

type Row = { m: MonthlyPoint; current: number; extra: number; total: number; variation: number | null };

/**
 * Evolução mensal do tempo ganho (últimos 12 meses): barras = ganho atual + extra simulado; faixa de cima = variação sobre o
 * mês anterior. O mês corrente ainda não terminou (pontilhado, sem projeção). "Só os simulados" tira o ganho dos demais robôs.
 */
export function GainMonthlyChart({ months, cut }: { months: MonthlyPoint[]; cut: boolean }) {
  const [scope, setScope] = useState<'todos' | 'sim'>('todos');
  const [asTable, setAsTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [setBody, width] = useContainerWidth();

  const rows: Row[] = useMemo(() => {
    const base = months.map((m) => ({ m, current: scope === 'todos' ? m.current : m.currentSim, extra: m.extra }));
    return base.map((r, i) => {
      const total = r.current + r.extra;
      const prev = i > 0 ? base[i - 1].current + base[i - 1].extra : null;
      return { ...r, total, variation: prev === null ? null : prev > 0 ? ((total - prev) / prev) * 100 : null };
    });
  }, [months, scope]);

  if (rows.length === 0) return <p className="text-sm text-slate-500 dark:text-zinc-400">Ainda não há meses completos de dados para mostrar a evolução.</p>;

  const w = Math.max(320, width);
  const n = rows.length;
  const m = { l: 52, r: 14 };
  const lineTop = 22;
  const lineH = 70;
  const barTop = lineTop + lineH + 34;
  const barH = 190;
  const h = barTop + barH + 30;
  const band = (w - m.l - m.r) / n;
  const bw = Math.max(8, Math.min(46, band * 0.58));
  const X = (i: number) => m.l + band * i + band / 2;
  const maxHours = Math.max(0.1, ...rows.map((r) => Math.max(r.total, r.current) / 3600));
  const top = niceMax(maxHours);
  const Y = (hours: number) => barTop + barH - (hours / top) * barH;
  const vmax = Math.max(5, ...rows.map((r) => Math.abs(r.variation ?? 0))) * 1.15;
  const VY = (v: number) => lineTop + lineH / 2 - (v / vmax) * (lineH / 2);
  const showYear = band >= 52;
  const pts = rows.map((r, i) => (r.variation === null ? null : { x: X(i), y: VY(r.variation), v: r.variation, partial: r.m.partial })).filter((p): p is NonNullable<typeof p> => p !== null);
  const full = pts.filter((p) => !p.partial);
  const partial = pts.find((p) => p.partial);
  const active = hover === null ? null : rows[hover];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="O que mostrar" className="inline-flex overflow-hidden rounded-xl border border-slate-300 dark:border-[#2b2b31]">
          {(
            [
              ['todos', 'Todo o relatório'],
              ['sim', 'Só os simulados'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={scope === id}
              onClick={() => setScope(id)}
              className={cn('px-3 py-1.5 text-xs transition', scope === id ? 'bg-slate-950 text-white dark:bg-white dark:text-slate-950' : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-[#0f0f10] dark:text-zinc-300 dark:hover:bg-[#18181b]')}
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => setAsTable((v) => !v)} aria-pressed={asTable} className="text-xs font-medium text-sky-600 hover:underline dark:text-sky-400">
          {asTable ? 'Ver o gráfico' : 'Ver os números em tabela'}
        </button>
      </div>

      {asTable ? (
        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-[#27272a]">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 dark:text-zinc-400">
                <th className="px-3 py-2">Mês</th>
                <th className="px-3 py-2 text-right">Atual</th>
                <th className="px-3 py-2 text-right">Extra simulado</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2 text-right">Variação</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.m.key} className="border-t border-slate-100 dark:border-[#1f1f23]">
                  <td className="px-3 py-1.5 first-letter:uppercase text-slate-800 dark:text-zinc-100">
                    {monthName(r.m.key)}
                    {r.m.partial ? ' (incompleto)' : ''}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{dur(r.current)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{signedDur(r.extra)}</td>
                  <td className="px-3 py-1.5 text-right font-medium tabular-nums">{dur(r.total)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.variation === null ? '—' : pctText(r.variation)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={setBody} className="relative w-full">
          <div className="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-zinc-400">
            <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-sm bg-slate-300 dark:bg-slate-600" />Atual (cadastrado)</span>
            <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-sm bg-sky-500" />Extra simulado</span>
            <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 rounded-sm border border-dashed border-slate-500" />Mês em andamento (incompleto)</span>
          </div>
          {width > 0 ? (
            <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="group" aria-label="Evolução mensal do tempo ganho: atual e extra simulado, com a variação mês a mês" className="block max-w-full overflow-visible">
              <text x={m.l - 8} y={lineTop - 8} className="fill-slate-600 text-[11.5px] font-semibold dark:fill-zinc-300">Variação mês a mês</text>
              <line x1={m.l} x2={w - m.r} y1={VY(0)} y2={VY(0)} className="stroke-slate-300 dark:stroke-zinc-700" strokeDasharray="4 4" />
              <text x={m.l - 8} y={VY(0) + 4} textAnchor="end" className="fill-slate-400 text-[11px]">0%</text>
              {full.length > 1 ? <polyline points={full.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className="stroke-slate-500 dark:stroke-zinc-400" /> : null}
              {partial && full.length ? <line x1={full[full.length - 1].x} y1={full[full.length - 1].y} x2={partial.x} y2={partial.y} strokeWidth={2} strokeDasharray="3 5" strokeLinecap="round" className="stroke-slate-500 dark:stroke-zinc-400" /> : null}
              {pts.map((p, i) => {
                const up = Math.round(p.v) >= 0;
                return (
                  <g key={i}>
                    <circle cx={p.x} cy={p.y} r={4} strokeWidth={2} className={cn(up ? 'stroke-emerald-600 dark:stroke-emerald-400' : 'stroke-rose-600 dark:stroke-rose-400', p.partial ? 'fill-white dark:fill-[#111113]' : up ? 'fill-emerald-600 dark:fill-emerald-400' : 'fill-rose-600 dark:fill-rose-400')} />
                    {band >= 34 || p.partial ? (
                      <text x={p.x} y={p.v >= 0 ? p.y - 9 : p.y + 17} textAnchor="middle" className={cn('text-[11px] font-semibold', up ? 'fill-emerald-700 dark:fill-emerald-400' : 'fill-rose-700 dark:fill-rose-400')}>
                        {pctText(p.v)}
                        {p.partial ? '*' : ''}
                      </text>
                    ) : null}
                  </g>
                );
              })}

              <text x={m.l - 8} y={barTop - 14} className="fill-slate-600 text-[11.5px] font-semibold dark:fill-zinc-300">Horas por mês</text>
              {[0, 1, 2, 3, 4].map((k) => {
                const v = (top / 4) * k;
                return (
                  <g key={k}>
                    <line x1={m.l} x2={w - m.r} y1={Y(v)} y2={Y(v)} className="stroke-slate-200 dark:stroke-zinc-800" />
                    <text x={m.l - 8} y={Y(v) + 4} textAnchor="end" className="fill-slate-400 text-[11px]">{nf(v, v % 1 ? 1 : 0)} h</text>
                  </g>
                );
              })}
              {rows.map((r, i) => {
                const cx = X(i);
                const x = cx - bw / 2;
                const hCur = (r.current / 3600 / top) * barH;
                const hExtra = (Math.abs(r.extra) / 3600 / top) * barH;
                const yCur = barTop + barH - hCur;
                // extra positivo empilha em cima do atual; negativo "come" a parte de cima do atual
                const extraY = r.extra >= 0 ? yCur - hExtra : yCur;
                const dashed = r.m.partial;
                return (
                  <g
                    key={r.m.key}
                    tabIndex={0}
                    role="img"
                    aria-label={`${monthName(r.m.key)}${r.m.partial ? ' (incompleto)' : ''}: atual ${dur(r.current)}, extra simulado ${signedDur(r.extra)}, total ${dur(r.total)}`}
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover(i)}
                    onBlur={() => setHover(null)}
                    className="outline-none focus-visible:[&_rect.hit]:stroke-sky-500"
                  >
                    <rect className="hit" x={cx - band / 2} y={lineTop} width={band} height={barTop + barH - lineTop} fill="transparent" />
                    {hCur > 0 ? <rect x={x} y={yCur} width={bw} height={hCur} rx={2} className={cn('fill-slate-300 dark:fill-slate-600', dashed && 'opacity-60')} stroke={dashed ? 'currentColor' : 'none'} strokeDasharray={dashed ? '3 3' : undefined} /> : null}
                    {hExtra > 0 ? <path d={topRounded(x, extraY, bw, hExtra, 4)} className={cn('fill-sky-500', r.extra < 0 && 'fill-rose-400', dashed && 'opacity-60')} /> : null}
                    <text x={cx} y={h - 8} textAnchor="middle" className={cn('text-[11px]', r.m.partial ? 'fill-slate-400' : 'fill-slate-500 dark:fill-zinc-400')}>
                      {monthLabel(r.m.key, showYear || i === 0 || r.m.key.endsWith('-01'))}
                      {r.m.partial ? '*' : ''}
                    </text>
                  </g>
                );
              })}
              <line x1={m.l} x2={w - m.r} y1={Y(0)} y2={Y(0)} className="stroke-slate-400 dark:stroke-zinc-600" />
            </svg>
          ) : null}
          {active ? (
            <div role="status" className="pointer-events-none absolute right-0 top-8 z-10 w-64 rounded-xl border border-slate-200 bg-white p-3 text-xs shadow-lg dark:border-[#27272a] dark:bg-[#111113]">
              <p className="font-semibold first-letter:uppercase text-slate-900 dark:text-zinc-100">
                {monthName(active.m.key)}
                {active.m.partial ? ' (incompleto)' : ''}
              </p>
              <p className="mt-1 text-slate-600 dark:text-zinc-300">Atual (cadastrado): {dur(active.current)}</p>
              <p className="text-slate-600 dark:text-zinc-300">Extra simulado: {signedDur(active.extra)}</p>
              <p className="font-semibold text-slate-900 dark:text-zinc-100">Total: {dur(active.total)}</p>
              <p className="mt-1 text-slate-500 dark:text-zinc-400">
                {active.variation === null ? 'Variação: sem mês anterior para comparar.' : `Variação sobre o mês anterior: ${pctText(active.variation)}${active.m.partial ? ' (parcial: o mês ainda não terminou)' : ''}`}
              </p>
            </div>
          ) : null}
        </div>
      )}
      <p className="text-xs text-slate-500 dark:text-zinc-400">
        O extra simulado aplica o tempo escolhido às execuções reais de cada mês. * Mês em andamento: ainda não terminou e não tem projeção, por isso a variação dele é parcial.
        {cut ? ' O 1º mês de dados ficou de fora porque o histórico começa no meio dele.' : ''}
      </p>
    </div>
  );
}
