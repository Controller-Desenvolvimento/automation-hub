import { useMemo, useState } from 'react';
import {
  CATEGORY_ORDER,
  GRANULARITY_LABELS,
  bucketLabel,
  bucketTitle,
  num,
  type CategoryBucket,
  type CategoryInfo,
  type ErrorCategory,
  type Granularity,
} from '../../lib/robot-health';
import { InfoTip } from '../time-savings/info-tip';
import { niceMax, topRounded, useContainerWidth } from './chart-utils';

const COLOR: Record<ErrorCategory, string> = {
  entrada: 'var(--hc-entrada)',
  externo: 'var(--hc-externo)',
  hub: 'var(--hc-hub)',
  robo: 'var(--hc-robo)',
  config: 'var(--hc-config)',
  sem: 'var(--hc-sem)',
};

export const categoryColor = (key: ErrorCategory) => COLOR[key];

// Medidas das marcas (skill de dataviz): barra de no máximo 24 px, vão de 2 px na cor da superfície entre os segmentos,
// 4 px de canto arredondado só na ponta dos dados (o pé da barra é reto), linhas-guia finas e sólidas.
const H = 240;
const M = { top: 12, right: 12, bottom: 30, left: 38 };
const BAR_MAX = 24;
const SLOT_MIN = 26;
const GAP = 2;
const RADIUS = 4;

/** Explicação das 6 categorias (conteúdo do "i" do gráfico). */
export function CategoryGuide({ info }: { info: CategoryInfo[] }) {
  return (
    <div className="space-y-2.5">
      <p className="font-medium text-slate-800 dark:text-zinc-100">De quem é a falha: define quem precisa agir.</p>
      {info.map((c) => (
        <div key={c.key} className="grid grid-cols-[10px_1fr] gap-x-2">
          <span className="mt-1 h-2.5 w-2.5 rounded-[3px]" style={{ background: COLOR[c.key] }} aria-hidden="true" />
          <div>
            <p>
              <strong className="text-slate-800 dark:text-zinc-100">{c.label}.</strong> {c.summary}
              {!c.countsAgainstRobot ? <span className="ml-1 rounded bg-slate-100 px-1 text-[11px] dark:bg-[#27272a]">fora da taxa de sucesso</span> : null}
            </p>
            <p className="text-slate-500 dark:text-zinc-400">Ex.: {c.example}</p>
            <p className="text-slate-500 dark:text-zinc-400">Quem age: {c.who}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export function CategoryChart({
  buckets,
  granularity,
  info,
}: {
  buckets: CategoryBucket[];
  granularity: Granularity;
  info: CategoryInfo[];
}) {
  const [asTable, setAsTable] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  // Largura disponível: o gráfico ocupa a largura toda e só rola para os lados quando há barras demais.
  const [setWrapEl, cw] = useContainerWidth();
  const label = (key: ErrorCategory) => info.find((c) => c.key === key)?.label ?? key;

  const totals = useMemo(() => {
    const sums = Object.fromEntries(CATEGORY_ORDER.map((c) => [c, 0])) as Record<ErrorCategory, number>;
    for (const b of buckets) for (const c of CATEGORY_ORDER) sums[c] += b.counts[c];
    return sums;
  }, [buckets]);
  const totalErrors = CATEGORY_ORDER.reduce((s, c) => s + totals[c], 0);
  const max = niceMax(Math.max(1, ...buckets.map((b) => b.total)));
  const slot = Math.max(SLOT_MIN, cw > 0 ? (cw - M.left - M.right) / Math.max(1, buckets.length) : SLOT_MIN);
  const width = M.left + M.right + buckets.length * slot;
  const barW = Math.min(BAR_MAX, slot - 6);
  const ph = H - M.top - M.bottom;
  const y = (v: number) => M.top + ph - (v / max) * ph;
  const ticks = [0, 1, 2, 3, 4].map((i) => (max / 4) * i);
  const labelEvery = Math.max(1, Math.ceil(44 / slot));

  const tip = active !== null ? buckets[active] : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <h2 className="text-base font-semibold text-slate-900 dark:text-white">Erros por categoria</h2>
          <InfoTip label="Explicar as categorias de erro" wide>
            <CategoryGuide info={info} />
          </InfoTip>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-pressed={asTable}
            onClick={() => setAsTable((v) => !v)}
            className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-600 transition hover:bg-slate-50 dark:border-[#2b2b31] dark:text-zinc-300 dark:hover:bg-[#18181b]"
          >
            {asTable ? 'Ver gráfico' : 'Ver como tabela'}
          </button>
        </div>
      </div>

      {/* Legenda sempre à vista (identidade nunca só pela cor), com o total de cada categoria no período. */}
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-slate-600 dark:text-zinc-300" aria-label="Categorias">
        {CATEGORY_ORDER.map((c) => (
          <li key={c} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: COLOR[c] }} aria-hidden="true" />
            {label(c)} <span className="tabular-nums text-slate-400 dark:text-zinc-500">{num(totals[c])}</span>
          </li>
        ))}
      </ul>

      {totalErrors === 0 ? (
        <p className="rounded-xl bg-emerald-50 px-4 py-6 text-center text-sm text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200">
          Nenhum erro no período.
        </p>
      ) : asTable ? (
        <div className="max-h-[320px] overflow-auto rounded-xl border border-slate-200 dark:border-[#2b2b31]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 text-left text-xs text-slate-500 dark:bg-[#18181b] dark:text-zinc-400">
              <tr>
                <th className="px-3 py-2 font-medium">{GRANULARITY_LABELS[granularity].one.replace(/^./, (s) => s.toUpperCase())}</th>
                {CATEGORY_ORDER.map((c) => <th key={c} className="px-3 py-2 text-right font-medium">{label(c)}</th>)}
                <th className="px-3 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.start} className="border-t border-slate-100 dark:border-white/[0.06]">
                  <td className="px-3 py-1.5 text-slate-700 dark:text-zinc-200">{bucketTitle(b.start, granularity)}</td>
                  {CATEGORY_ORDER.map((c) => <td key={c} className="px-3 py-1.5 text-right tabular-nums text-slate-600 dark:text-zinc-300">{b.counts[c] || '·'}</td>)}
                  <td className="px-3 py-1.5 text-right font-medium tabular-nums text-slate-900 dark:text-white">{b.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <div ref={setWrapEl} className="overflow-x-auto pb-1" onMouseLeave={() => setActive(null)}>
            <svg
              width={width}
              height={H}
              viewBox={`0 0 ${width} ${H}`}
              role="group"
              aria-label={`Erros por categoria, por ${GRANULARITY_LABELS[granularity].one}`}
            >
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} stroke="var(--hc-grid)" strokeWidth={1} />
                  <text x={M.left - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--hc-axis)">{Number.isInteger(t) ? t : t.toFixed(1)}</text>
                </g>
              ))}
              {buckets.map((b, i) => {
                const x = M.left + i * slot + (slot - barW) / 2;
                let acc = 0;
                const segs = CATEGORY_ORDER.filter((c) => b.counts[c] > 0).map((c) => {
                  const from = acc;
                  acc += b.counts[c];
                  return { c, from, to: acc };
                });
                return (
                  <g key={b.start}>
                    {segs.map((s, k) => {
                      const top = y(s.to);
                      const bottom = y(s.from);
                      // vão de 2 px entre os segmentos (a cor da superfície aparece entre eles)
                      const h = Math.max(2, bottom - top - (k > 0 ? GAP : 0)); // o vão fica na base do segmento (entre ele e o de baixo)
                      const isTop = k === segs.length - 1;
                      return isTop ? (
                        <path key={s.c} d={topRounded(x, top, barW, h, RADIUS)} fill={COLOR[s.c]} opacity={active === null || active === i ? 1 : 0.55} />
                      ) : (
                        <rect key={s.c} x={x} y={top} width={barW} height={h} fill={COLOR[s.c]} opacity={active === null || active === i ? 1 : 0.55} />
                      );
                    })}
                    {i % labelEvery === 0 ? (
                      <text x={M.left + i * slot + slot / 2} y={H - 10} textAnchor="middle" fontSize={11} fill="var(--hc-axis)">{bucketLabel(b.start, granularity)}</text>
                    ) : null}
                    {/* Área de toque/foco maior que a barra (também para teclado). */}
                    <rect
                      x={M.left + i * slot}
                      y={M.top}
                      width={slot}
                      height={ph}
                      fill="transparent"
                      tabIndex={0}
                      role="img"
                      aria-label={`${bucketTitle(b.start, granularity)}: ${b.total} erro${b.total === 1 ? '' : 's'}`}
                      onMouseEnter={() => setActive(i)}
                      onFocus={() => setActive(i)}
                      onBlur={() => setActive(null)}
                      className="outline-none focus-visible:stroke-sky-500"
                      style={{ stroke: 'transparent' }}
                    />
                  </g>
                );
              })}
              <line x1={M.left} x2={width - M.right} y1={y(0)} y2={y(0)} stroke="var(--hc-grid)" strokeWidth={1} />
            </svg>
          </div>
          {tip ? (
            <div
              role="status"
              className="pointer-events-none absolute right-2 top-0 z-10 w-56 rounded-xl border border-slate-200 bg-white p-3 text-xs shadow-lg dark:border-[#2b2b31] dark:bg-[#18181b]"
            >
              <p className="mb-1.5 font-semibold text-slate-900 dark:text-white">{bucketTitle(tip.start, granularity)}</p>
              {CATEGORY_ORDER.filter((c) => tip.counts[c] > 0).map((c) => (
                <p key={c} className="flex items-center justify-between gap-2 text-slate-600 dark:text-zinc-300">
                  <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: COLOR[c] }} aria-hidden="true" />{label(c)}</span>
                  <span className="tabular-nums">{tip.counts[c]}</span>
                </p>
              ))}
              {tip.total === 0 ? <p className="text-slate-500 dark:text-zinc-400">Nenhum erro.</p> : <p className="mt-1.5 flex justify-between border-t border-slate-100 pt-1.5 font-medium text-slate-900 dark:border-white/10 dark:text-white"><span>Total</span><span className="tabular-nums">{tip.total}</span></p>}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
