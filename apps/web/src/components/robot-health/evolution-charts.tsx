import { useState, type ReactNode } from 'react';
import {
  GRANULARITY_LABELS,
  bucketLabel,
  bucketTitle,
  duration,
  num,
  pct,
  type DurationSeries,
  type EvolutionBucket,
  type Granularity,
} from '../../lib/robot-health';
import { cn } from '../../lib/utils';
import { InfoTip } from '../time-savings/info-tip';
import { CHART, niceMax, topRounded, useContainerWidth } from './chart-utils';

const { H, M, BAR_MAX, GAP, RADIUS } = CHART;
const MIN_SAMPLE = 5;

// ---------- peças compartilhadas ----------

function ChartHeader({ title, tip, asTable, onToggle }: { title: string; tip: ReactNode; asTable: boolean; onToggle: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-1.5">
        <h2 className="text-base font-semibold text-slate-900 dark:text-white">{title}</h2>
        <InfoTip label={`Como ler: ${title}`} wide>{tip}</InfoTip>
      </div>
      <button
        type="button"
        aria-pressed={asTable}
        onClick={onToggle}
        className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 transition hover:bg-slate-50 dark:border-[#2b2b31] dark:text-zinc-300 dark:hover:bg-[#18181b]"
      >
        {asTable ? 'Ver gráfico' : 'Ver como tabela'}
      </button>
    </div>
  );
}

function Legend({ items }: { items: Array<{ color: string; label: string; total?: string; glyph?: string }> }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-slate-600 dark:text-zinc-300" aria-label="Legenda">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span className="grid h-3 w-3 place-items-center rounded-[3px] text-[9px] font-bold leading-none text-white" style={{ background: i.color }} aria-hidden="true">{i.glyph}</span>
          {i.label}
          {i.total ? <span className="tabular-nums text-slate-400 dark:text-zinc-500">{i.total}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** Um único detalhe com todas as séries daquele ponto (valor em destaque, nome em segundo plano). */
function Tip({ title, rows, note }: { title: string; rows: Array<{ label: string; value: string; color?: string }>; note?: string }) {
  return (
    <div role="status" className="pointer-events-none absolute right-2 top-0 z-10 w-56 rounded-xl border border-slate-200 bg-white p-3 text-xs shadow-lg dark:border-[#2b2b31] dark:bg-[#18181b]">
      <p className="mb-1.5 font-semibold text-slate-900 dark:text-white">{title}</p>
      {rows.map((r) => (
        <p key={r.label} className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-slate-500 dark:text-zinc-400">
            {r.color ? <span className="h-0.5 w-3 rounded-full" style={{ background: r.color }} aria-hidden="true" /> : null}
            {r.label}
          </span>
          <span className="font-medium tabular-nums text-slate-900 dark:text-white">{r.value}</span>
        </p>
      ))}
      {note ? <p className="mt-1.5 border-t border-slate-100 pt-1.5 text-slate-500 dark:border-white/10 dark:text-zinc-400">{note}</p> : null}
    </div>
  );
}

function EvolutionTable({ buckets, granularity }: { buckets: EvolutionBucket[]; granularity: Granularity }) {
  return (
    <div className="max-h-[320px] overflow-auto rounded-xl border border-slate-200 dark:border-[#2b2b31]">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-slate-50 text-left text-xs text-slate-500 dark:bg-[#18181b] dark:text-zinc-400">
          <tr>
            <th className="px-3 py-2 font-medium">{GRANULARITY_LABELS[granularity].one.replace(/^./, (c) => c.toUpperCase())}</th>
            {['Sucesso', 'Erro do robô', 'Erro do Hub', 'Cancelada', 'Taxa de sucesso', 'Duração média'].map((h) => <th key={h} className="px-3 py-2 text-right font-medium">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {buckets.map((b) => (
            <tr key={b.start} className="border-t border-slate-100 dark:border-white/[0.06]">
              <td className="px-3 py-1.5 text-slate-700 dark:text-zinc-200">{bucketTitle(b.start, granularity)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{b.success || '·'}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{b.errors || '·'}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{b.hubErrors || '·'}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{b.canceled || '·'}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{pct(b.successRate, 1)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{duration(b.avgDurationSeconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Eixo X comum: rótulo a cada N barras para não encavalar. */
function useSlot(count: number, min = 9) {
  const [setEl, cw] = useContainerWidth();
  // Barras finas são aceitas (a skill limita só o máximo, 24 px): 30 dias cabem num cartão de meia largura sem rolar.
  const slot = Math.max(min, cw > 0 ? (cw - M.left - M.right) / Math.max(1, count) : min);
  return { setEl, slot, width: M.left + M.right + count * slot, labelEvery: Math.max(1, Math.ceil(44 / slot)) };
}

// ---------- 1. Resultado das execuções (colunas empilhadas) ----------

export function ResultsChart({ buckets, granularity }: { buckets: EvolutionBucket[]; granularity: Granularity }) {
  const [asTable, setAsTable] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const { setEl, slot, width, labelEvery } = useSlot(buckets.length);
  const outOf = (b: EvolutionBucket) => b.canceled + b.hubErrors;
  const total = (b: EvolutionBucket) => b.success + b.errors + outOf(b);
  const max = niceMax(Math.max(1, ...buckets.map(total)));
  const ph = H - M.top - M.bottom;
  const y = (v: number) => M.top + ph - (v / max) * ph;
  const barW = Math.min(BAR_MAX, Math.max(3, slot - 4));
  const sums = buckets.reduce((a, b) => ({ s: a.s + b.success, e: a.e + b.errors, o: a.o + outOf(b) }), { s: 0, e: 0, o: 0 });
  const tip = active !== null ? buckets[active] : null;

  return (
    <div className="space-y-3">
      <ChartHeader
        title="Resultado das execuções"
        asTable={asTable}
        onToggle={() => setAsTable((v) => !v)}
        tip={
          <>
            <p>Quantas execuções terminaram em cada resultado, por {GRANULARITY_LABELS[granularity].one}.</p>
            <p className="mt-1.5"><strong>Fora da conta</strong> = canceladas e erros do Hub (reinício do servidor): não são sucesso nem erro do robô e não entram na taxa de sucesso.</p>
          </>
        }
      />
      <Legend
        items={[
          { color: 'var(--hc-ok)', label: 'Sucesso', total: num(sums.s) },
          { color: 'var(--hc-out)', label: 'Fora da conta', total: num(sums.o) },
          { color: 'var(--hc-crit)', label: 'Erro do robô', total: num(sums.e), glyph: '×' },
        ]}
      />
      {asTable ? (
        <EvolutionTable buckets={buckets} granularity={granularity} />
      ) : (
        <div className="relative">
          <div ref={setEl} className="overflow-x-auto pb-1" onMouseLeave={() => setActive(null)}>
            <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} role="group" aria-label={`Resultado das execuções, por ${GRANULARITY_LABELS[granularity].one}`}>
              {[0, 1, 2, 3, 4].map((i) => {
                const t = (max / 4) * i;
                return (
                  <g key={i}>
                    <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} stroke="var(--hc-grid)" strokeWidth={1} />
                    <text x={M.left - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--hc-axis)">{Number.isInteger(t) ? t : t.toFixed(1)}</text>
                  </g>
                );
              })}
              {buckets.map((b, i) => {
                const x = M.left + i * slot + (slot - barW) / 2;
                const parts = [
                  { c: 'var(--hc-ok)', v: b.success },
                  { c: 'var(--hc-out)', v: outOf(b) },
                  { c: 'var(--hc-crit)', v: b.errors },
                ].filter((p) => p.v > 0);
                let acc = 0;
                return (
                  <g key={b.start}>
                    {parts.map((p, k) => {
                      const from = acc;
                      acc += p.v;
                      const top = y(acc);
                      const h = Math.max(2, y(from) - top - (k > 0 ? GAP : 0));
                      const last = k === parts.length - 1;
                      const o = active === null || active === i ? 1 : 0.55;
                      return last ? <path key={p.c} d={topRounded(x, top, barW, h, RADIUS)} fill={p.c} opacity={o} /> : <rect key={p.c} x={x} y={top} width={barW} height={h} fill={p.c} opacity={o} />;
                    })}
                    {i % labelEvery === 0 ? <text x={M.left + i * slot + slot / 2} y={H - 10} textAnchor="middle" fontSize={11} fill="var(--hc-axis)">{bucketLabel(b.start, granularity)}</text> : null}
                    <rect
                      x={M.left + i * slot} y={M.top} width={slot} height={ph} fill="transparent" tabIndex={0} role="img"
                      aria-label={`${bucketTitle(b.start, granularity)}: ${b.success} sucesso, ${b.errors} erro${b.errors === 1 ? '' : 's'} do robô, ${outOf(b)} fora da conta`}
                      onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} onBlur={() => setActive(null)} className="outline-none"
                    />
                  </g>
                );
              })}
              <line x1={M.left} x2={width - M.right} y1={y(0)} y2={y(0)} stroke="var(--hc-grid)" strokeWidth={1} />
            </svg>
          </div>
          {tip ? (
            <Tip
              title={bucketTitle(tip.start, granularity)}
              rows={[
                { label: 'Sucesso', value: num(tip.success), color: 'var(--hc-ok)' },
                { label: 'Erro do robô', value: num(tip.errors), color: 'var(--hc-crit)' },
                { label: 'Cancelada', value: num(tip.canceled), color: 'var(--hc-out)' },
                { label: 'Erro do Hub', value: num(tip.hubErrors), color: 'var(--hc-out)' },
              ]}
              note={tip.concluded ? `Taxa de sucesso: ${pct(tip.successRate, 1)} (${tip.concluded} concluídas)` : 'Nada concluído neste período.'}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

// ---------- 2. Taxa de sucesso (linha) ----------

export function RateChart({ buckets, granularity }: { buckets: EvolutionBucket[]; granularity: Granularity }) {
  const [asTable, setAsTable] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const { setEl, slot, width, labelEvery } = useSlot(buckets.length);
  const ph = H - M.top - M.bottom;
  const y = (v: number) => M.top + ph - v * ph;
  const cx = (i: number) => M.left + i * slot + slot / 2;
  const withRate = buckets.map((b, i) => ({ b, i })).filter((p) => p.b.successRate !== null);
  const last = withRate[withRate.length - 1];

  // Trechos contínuos: o dia sem execução concluída quebra a linha (não vira 0%).
  const runs: Array<Array<{ b: EvolutionBucket; i: number }>> = [];
  buckets.forEach((b, i) => {
    if (b.successRate === null) {
      runs.push([]);
      return;
    }
    if (!runs.length) runs.push([]);
    runs[runs.length - 1].push({ b, i });
  });
  const segments = runs.filter((r) => r.length > 0);
  const tip = active !== null ? buckets[active] : null;

  return (
    <div className="space-y-3">
      <ChartHeader
        title="Taxa de sucesso"
        asTable={asTable}
        onToggle={() => setAsTable((v) => !v)}
        tip={
          <>
            <p>Sucessos ÷ execuções concluídas (sucessos + erros dos robôs), por {GRANULARITY_LABELS[granularity].one}. Cancelada e erro do Hub ficam fora da conta.</p>
            <p className="mt-1.5">A linha para onde não houve nenhuma execução concluída (não é 0%). Ponto vazado = menos de {MIN_SAMPLE} concluídas: pouco para julgar. A faixa vermelha é a zona <strong>crítica</strong> (40% de erro ou mais).</p>
          </>
        }
      />
      <Legend items={[{ color: 'var(--hc-ink)', label: 'Taxa de sucesso' }, { color: 'var(--hc-crit)', label: 'Zona crítica (40% de erro ou mais)', glyph: '!' }]} />
      {asTable ? (
        <EvolutionTable buckets={buckets} granularity={granularity} />
      ) : (
        <div className="relative">
          <div ref={setEl} className="overflow-x-auto pb-1" onMouseLeave={() => setActive(null)}>
            <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} role="group" aria-label={`Taxa de sucesso, por ${GRANULARITY_LABELS[granularity].one}`}>
              <rect x={M.left} y={y(0.6)} width={width - M.left - M.right} height={y(0) - y(0.6)} fill="var(--hc-crit)" opacity={0.07} />
              {[0, 0.25, 0.5, 0.75, 1].map((t) => (
                <g key={t}>
                  <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} stroke="var(--hc-grid)" strokeWidth={1} />
                  <text x={M.left - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--hc-axis)">{Math.round(t * 100)}%</text>
                </g>
              ))}
              {segments.map((seg, k) => {
                const line = seg.map((p, j) => `${j === 0 ? 'M' : 'L'}${cx(p.i)},${y(p.b.successRate!)}`).join(' ');
                const area = `${line} L${cx(seg[seg.length - 1].i)},${y(0)} L${cx(seg[0].i)},${y(0)} Z`;
                return (
                  <g key={k}>
                    <path d={area} fill="var(--hc-ink)" opacity={0.1} />
                    <path d={line} fill="none" stroke="var(--hc-ink)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  </g>
                );
              })}
              {withRate.map(({ b, i }) => (
                <circle key={b.start} cx={cx(i)} cy={y(b.successRate!)} r={b.concluded < MIN_SAMPLE ? 3 : 2.5} fill={b.concluded < MIN_SAMPLE ? 'var(--hc-surface)' : 'var(--hc-ink)'} stroke="var(--hc-ink)" strokeWidth={b.concluded < MIN_SAMPLE ? 1.5 : 0} />
              ))}
              {last ? <circle cx={cx(last.i)} cy={y(last.b.successRate!)} r={4.5} fill="var(--hc-ink)" stroke="var(--hc-surface)" strokeWidth={2} /> : null}
              {active !== null ? <line x1={cx(active)} x2={cx(active)} y1={M.top} y2={y(0)} stroke="var(--hc-ink-2)" strokeWidth={1} opacity={0.4} /> : null}
              {active !== null && buckets[active].successRate !== null ? <circle cx={cx(active)} cy={y(buckets[active].successRate!)} r={5} fill="var(--hc-ink)" stroke="var(--hc-surface)" strokeWidth={2} /> : null}
              {buckets.map((b, i) => (
                <g key={`h-${b.start}`}>
                  {i % labelEvery === 0 ? <text x={cx(i)} y={H - 10} textAnchor="middle" fontSize={11} fill="var(--hc-axis)">{bucketLabel(b.start, granularity)}</text> : null}
                  <rect
                    x={M.left + i * slot} y={M.top} width={slot} height={ph} fill="transparent" tabIndex={0} role="img"
                    aria-label={`${bucketTitle(b.start, granularity)}: taxa de sucesso ${pct(b.successRate, 1)} (${b.concluded} concluídas)`}
                    onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} onBlur={() => setActive(null)} className="outline-none"
                  />
                </g>
              ))}
            </svg>
          </div>
          {tip ? (
            <Tip
              title={bucketTitle(tip.start, granularity)}
              rows={[
                { label: 'Taxa de sucesso', value: pct(tip.successRate, 1), color: 'var(--hc-ink)' },
                { label: 'Concluídas', value: num(tip.concluded) },
                { label: 'Erros do robô', value: num(tip.errors) },
              ]}
              note={tip.concluded === 0 ? 'Nenhuma execução concluída: sem taxa.' : tip.concluded < MIN_SAMPLE ? `Só ${tip.concluded} concluída${tip.concluded === 1 ? '' : 's'}: pouco para julgar.` : undefined}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

// ---------- 3. Duração dos robôs mais usados (4 gráficos pequenos) ----------

const MINI_H = 96;
const MINI_M = { top: 8, right: 14, bottom: 18, left: 34 };

function MiniDuration({ series, granularity }: { series: DurationSeries; granularity: Granularity }) {
  const [setEl, cw] = useContainerWidth();
  const [active, setActive] = useState<number | null>(null);
  const w = Math.max(160, cw);
  const points = series.points;
  const known = points.map((p, i) => ({ p, i })).filter((x) => x.p.avgSeconds !== null);
  const max = niceMax(Math.max(1, ...known.map((x) => x.p.avgSeconds!)) / 60) * 60; // eixo em minutos "redondos"
  const pw = w - MINI_M.left - MINI_M.right;
  const ph = MINI_H - MINI_M.top - MINI_M.bottom;
  const step = pw / Math.max(1, points.length - 1);
  const x = (i: number) => MINI_M.left + (points.length === 1 ? pw / 2 : i * step);
  const y = (v: number) => MINI_M.top + ph - (v / max) * ph;
  const runs: Array<Array<{ i: number; v: number }>> = [];
  points.forEach((p, i) => {
    if (p.avgSeconds === null) runs.push([]);
    else {
      if (!runs.length) runs.push([]);
      runs[runs.length - 1].push({ i, v: p.avgSeconds });
    }
  });
  const segments = runs.filter((r) => r.length);
  const last = known[known.length - 1];
  const all = known.reduce((s, k) => s + k.p.avgSeconds! * k.p.n, 0);
  const n = known.reduce((s, k) => s + k.p.n, 0);
  const tipPoint = active !== null ? points[active] : null;

  return (
    <div className="rounded-2xl border border-slate-200 p-4 dark:border-[#2b2b31]">
      <div className="flex items-baseline justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-medium text-slate-900 dark:text-zinc-100" title={series.name}>{series.name}</p>
        <p className="shrink-0 text-lg font-semibold tabular-nums text-slate-950 dark:text-white">{duration(n ? all / n : null)}</p>
      </div>
      <p className="text-xs text-slate-500 dark:text-zinc-400">{num(series.executions)} execuções · duração média (só sucessos)</p>
      <div ref={setEl} className="relative mt-2" onMouseLeave={() => setActive(null)}>
        {known.length === 0 ? (
          <p className="py-6 text-center text-xs text-slate-500 dark:text-zinc-400">Nenhum sucesso no período.</p>
        ) : (
          <svg width={w} height={MINI_H} viewBox={`0 0 ${w} ${MINI_H}`} role="group" aria-label={`Duração média de ${series.name}, por ${GRANULARITY_LABELS[granularity].one}`}>
            {[0, max].map((t) => (
              <g key={t}>
                <line x1={MINI_M.left} x2={w - MINI_M.right} y1={y(t)} y2={y(t)} stroke="var(--hc-grid)" strokeWidth={1} />
                <text x={MINI_M.left - 5} y={y(t) + 4} textAnchor="end" fontSize={10} fill="var(--hc-axis)">{duration(t)}</text>
              </g>
            ))}
            {segments.map((seg, k) => (
              <path key={k} d={seg.map((p, j) => `${j === 0 ? 'M' : 'L'}${x(p.i)},${y(p.v)}`).join(' ')} fill="none" stroke="var(--hc-ink)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {segments.filter((s) => s.length === 1).map((s) => <circle key={s[0].i} cx={x(s[0].i)} cy={y(s[0].v)} r={3} fill="var(--hc-ink)" />)}
            {last ? <circle cx={x(last.i)} cy={y(last.p.avgSeconds!)} r={4.5} fill="var(--hc-ink)" stroke="var(--hc-surface)" strokeWidth={2} /> : null}
            {active !== null && points[active].avgSeconds !== null ? (
              <>
                <line x1={x(active)} x2={x(active)} y1={MINI_M.top} y2={y(0)} stroke="var(--hc-ink-2)" strokeWidth={1} opacity={0.4} />
                <circle cx={x(active)} cy={y(points[active].avgSeconds!)} r={5} fill="var(--hc-ink)" stroke="var(--hc-surface)" strokeWidth={2} />
              </>
            ) : null}
            <text x={MINI_M.left} y={MINI_H - 3} fontSize={10} fill="var(--hc-axis)">{bucketLabel(points[0].start, granularity)}</text>
            <text x={w - MINI_M.right} y={MINI_H - 3} textAnchor="end" fontSize={10} fill="var(--hc-axis)">{bucketLabel(points[points.length - 1].start, granularity)}</text>
            {points.map((p, i) => (
              <rect
                key={p.start} x={x(i) - step / 2} y={MINI_M.top} width={Math.max(step, 6)} height={ph} fill="transparent" tabIndex={0} role="img"
                aria-label={`${bucketTitle(p.start, granularity)}: ${p.avgSeconds === null ? 'sem execução com sucesso' : `duração média ${duration(p.avgSeconds)} (${p.n} execuções)`}`}
                onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} onBlur={() => setActive(null)} className="outline-none"
              />
            ))}
          </svg>
        )}
        {tipPoint ? (
          <div role="status" className="pointer-events-none absolute right-0 top-0 z-10 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-lg dark:border-[#2b2b31] dark:bg-[#18181b]">
            <p className="font-semibold text-slate-900 dark:text-white">{bucketTitle(tipPoint.start, granularity)}</p>
            <p className="text-slate-500 dark:text-zinc-400">
              {tipPoint.avgSeconds === null ? 'Sem sucesso neste período' : <><span className="font-medium tabular-nums text-slate-900 dark:text-white">{duration(tipPoint.avgSeconds)}</span> · {tipPoint.n} execuç{tipPoint.n === 1 ? 'ão' : 'ões'}</>}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function DurationCharts({ series, granularity }: { series: DurationSeries[]; granularity: Granularity }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        <h2 className="text-base font-semibold text-slate-900 dark:text-white">Duração dos robôs mais usados</h2>
        <InfoTip label="Como ler a duração" wide>
          <p>Duração média, por {GRANULARITY_LABELS[granularity].one}, dos 4 robôs com mais execuções no período. Só entram execuções com <strong>sucesso</strong> (erros e canceladas terminam antes ou depois do normal e distorceriam a média).</p>
          <p className="mt-1.5">O número grande é a média do período inteiro; o ponto destacado é o último. Um gráfico por robô, todos na mesma cor: aqui a comparação é com o próprio robô ao longo do tempo. Trecho cortado = sem sucesso naquele período.</p>
        </InfoTip>
      </div>
      {series.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-zinc-400">Nenhum robô rodou no período.</p>
      ) : (
        <div className={cn('grid gap-4', series.length > 1 ? 'md:grid-cols-2' : '')}>
          {series.map((s) => <MiniDuration key={s.robotId} series={s} granularity={granularity} />)}
        </div>
      )}
    </div>
  );
}
