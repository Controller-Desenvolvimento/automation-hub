import type { ReactNode } from 'react';
import {
  CATEGORY_COLOR,
  CATEGORY_ORDER,
  GRANULARITY_LABELS,
  bucketInfo,
  fmtDay,
  mins,
  nf,
  pct,
  pl,
  type CategoryBucket,
  type CategoryInfo,
  type DurationSeries,
  type EvolutionBucket,
  type Granularity,
} from '../../lib/robot-health';
import { G, GapLinks, HcCard, ScrollPlot, SmoothLine, StackBars, niceScale, ticksOf, useBand } from './kit';

const MINCOL = 32; // largura mínima de cada balde: o rótulo dd/mm de todos cabe; períodos longos rolam para os lados

type Period = { from: string; to: string; days: number };

// ---------- Execuções por dia ----------

function ExecDailyPlot({ days, period, w }: { days: EvolutionBucket[]; period: Period; w: number }) {
  const nd = days.length;
  const aw = 38;
  const m = { t: 22, b: 26 };
  const h = 250;
  const ph = h - m.t - m.b;
  const avail = w - aw;
  const band = Math.max(MINCOL, avail / nd);
  const plotW = band * nd;
  const bw = Math.max(2, Math.min(24, band - 2));
  const total = (d: EvolutionBucket) => d.success + d.errors + d.hubErrors + d.canceled;
  const sc = niceScale(Math.max(1, ...days.map(total)), 4);
  const Y = (v: number) => m.t + ph * (1 - v / sc.max);
  const avg = days.reduce((a, d) => a + total(d), 0) / nd;
  const hov = useBand({
    n: nd, x0: 0, y0: m.t, h: ph, band,
    tip: (i) => {
      const d = days[i];
      const err = d.errors + d.hubErrors;
      return {
        title: bucketInfo(d.start, 'day', period.from, period.to).title,
        rows: [
          { c: 'var(--s1)', v: nf(d.success), l: 'com sucesso' },
          { c: 'var(--crit)', v: nf(err), l: 'com erro' },
          { c: 'var(--cancel)', v: nf(d.canceled), l: 'canceladas' },
        ],
        note: total(d)
          ? `Taxa de sucesso do dia: ${pct(d.successRate)}${d.hubErrors ? ` · Hub reiniciado: ${d.hubErrors === 1 ? '1 execução interrompida' : `${d.hubErrors} execuções interrompidas`}` : ''}`
          : 'Sem execuções',
      };
    },
  });
  return (
    <ScrollPlot
      avail={avail}
      plotW={plotW}
      axis={
        <svg width={aw} height={h} viewBox={`0 0 ${aw} ${h}`} aria-hidden="true">
          {ticksOf(sc).map((v) => <text key={v} className="ax" x={aw - 6} y={Y(v) + 4} textAnchor="end">{nf(v, 0)}</text>)}
        </svg>
      }
      plot={
        <svg width={plotW} height={h} viewBox={`0 0 ${plotW} ${h}`} role="img" aria-label="Execuções por dia, empilhadas por resultado" {...hov.svgProps}>
          {hov.highlight}
          {ticksOf(sc).map((v) => <line key={v} className="grid" x1={0} x2={plotW} y1={Y(v)} y2={Y(v)} />)}
          <g>
            {days.map((d, i) => {
              const x = i * band + (band - bw) / 2;
              const cy = Math.max(8, Y(total(d)) - 10);
              const cx = x + bw / 2;
              return (
                <g key={d.start}>
                  <StackBars x={x} bw={bw} Y={Y} segs={[{ v: d.success, c: 'var(--s1)' }, { v: d.canceled, c: 'var(--cancel)' }, { v: d.errors + d.hubErrors, c: 'var(--crit)' }]} />
                  {d.hubErrors ? <path d={`M${cx},${cy - 5}L${cx + 5},${cy}L${cx},${cy + 5}L${cx - 5},${cy}Z`} style={{ fill: 'var(--hubmark)', stroke: 'var(--hc-surface)', strokeWidth: 2 }} /> : null}
                  <text className="ax" x={x + bw / 2} y={h - 8} textAnchor="middle">{fmtDay(d.start)}</text>
                </g>
              );
            })}
          </g>
          {avg > 0 ? <line x1={0} x2={plotW} y1={Y(avg)} y2={Y(avg)} style={{ stroke: 'var(--accent)', strokeWidth: 1.5, strokeDasharray: '5 4', pointerEvents: 'none' }} /> : null}
          <line className="axis" x1={0} x2={plotW} y1={Y(0)} y2={Y(0)} />
          {hov.overlay}
        </svg>
      }
    />
  );
}

export function ExecDailyCard({ daily, period, avgPerDay }: { daily: EvolutionBucket[]; period: Period; avgPerDay: number }) {
  return (
    <HcCard
      title="Execuções por dia"
      info="Resultado de cada dia. O losango marca dias em que o Hub reiniciou e interrompeu execuções. Períodos longos rolam para os lados, começando pelo dia mais recente. Erros do reinício do Hub aparecem em vermelho aqui, mas ficam fora da taxa de sucesso."
      legend={[
        { c: 'var(--s1)', l: 'Sucesso' },
        { c: 'var(--cancel)', l: 'Cancelada' },
        { c: 'var(--crit)', l: 'Erro' },
        { c: 'var(--hubmark)', shape: 'dia', l: 'Hub reiniciado' },
        { c: 'var(--accent)', shape: 'dash', l: `Média: ${nf(avgPerDay, 1)} por dia` },
      ]}
      table={() => ({ head: ['Dia', 'Sucesso', 'Erro', 'Canceladas'], rows: daily.map((d) => [fmtDay(d.start), nf(d.success), nf(d.errors + d.hubErrors), nf(d.canceled)]) })}
    >
      {(w) => <ExecDailyPlot days={daily} period={period} w={w} />}
    </HcCard>
  );
}

// ---------- Taxa de sucesso por dia, semana ou mês ----------

function RatePlot({ buckets, gran, period, w, avgRate }: { buckets: EvolutionBucket[]; gran: Granularity; period: Period; w: number; avgRate: number | null }) {
  const n = buckets.length;
  const aw = 38;
  const mr = 44;
  const m = { t: 14, b: 26 };
  const h = 250;
  const ph = h - m.t - m.b;
  const avail = w - aw;
  const band = Math.max(MINCOL, (avail - mr) / n);
  const plotW = band * n + mr;
  const Y = (v: number) => m.t + ph * (1 - v);
  const X = (i: number) => (i + 0.5) * band;
  const vals = buckets.map((b) => (b.concluded >= 3 ? b.successRate : null));
  const infos = buckets.map((b) => bucketInfo(b.start, gran, period.from, period.to));
  let last = -1;
  vals.forEach((v, i) => { if (v !== null) last = i; });
  const hov = useBand({
    n, x0: 0, y0: m.t, h: ph, band, cross: true,
    tip: (i) => {
      const b = buckets[i];
      return {
        title: infos[i].title,
        rows: [{ c: 'var(--s1)', shape: 'line', v: vals[i] === null ? '—' : pct(vals[i]), l: 'taxa de sucesso' }],
        note: `${pl(b.concluded, 'concluída', 'concluídas')}${vals[i] === null ? ' (poucas para calcular)' : ''}${infos[i].note ? `. ${infos[i].note}` : ''}`,
      };
    },
  });
  return (
    <ScrollPlot
      avail={avail}
      plotW={plotW}
      axis={
        <svg width={aw} height={h} viewBox={`0 0 ${aw} ${h}`} aria-hidden="true">
          {[0, 0.25, 0.5, 0.75, 1].map((v) => <text key={v} className="ax" x={aw - 6} y={Y(v) + 4} textAnchor="end">{Math.round(v * 100)}%</text>)}
        </svg>
      }
      plot={
        <svg width={plotW} height={h} viewBox={`0 0 ${plotW} ${h}`} role="img" aria-label={`Taxa de sucesso por ${GRANULARITY_LABELS[gran].one}`} {...hov.svgProps}>
          {hov.highlight}
          {[0, 0.25, 0.5, 0.75, 1].map((v) => <line key={v} className="grid" x1={0} x2={plotW} y1={Y(v)} y2={Y(v)} />)}
          {avgRate !== null ? <line x1={0} x2={plotW} y1={Y(avgRate)} y2={Y(avgRate)} style={{ stroke: 'var(--accent)', strokeWidth: 1.5, strokeDasharray: '5 4', pointerEvents: 'none' }} /> : null}
          <GapLinks vals={vals} X={X} Y={Y} color="var(--s1)" />
          <SmoothLine vals={vals} X={X} Y={Y} color="var(--s1)" yBase={Y(0)} area />
          {vals.map((v, i) => (
            <g key={buckets[i].start}>
              <text className="ax" x={X(i)} y={h - 8} textAnchor="middle" style={infos[i].part ? { opacity: 0.5 } : undefined}>{infos[i].label}</text>
              {v !== null ? <circle cx={X(i)} cy={Y(v)} r={3.5} style={{ fill: 'var(--s1)', stroke: 'var(--hc-surface)', strokeWidth: 2, pointerEvents: 'none' }} /> : null}
            </g>
          ))}
          {last >= 0 ? <text className="lbl" x={X(last) + 9} y={Y(vals[last]!) + 4} style={{ fontWeight: 650, fill: 'var(--hc-ink)' }}>{pct(vals[last])}</text> : null}
          <line className="axis" x1={0} x2={plotW} y1={Y(0)} y2={Y(0)} />
          {hov.overlay}
        </svg>
      }
    />
  );
}

export function RateCard({ buckets, gran, onGran, period, avgRate }: { buckets: EvolutionBucket[]; gran: Granularity; onGran: (g: Granularity) => void; period: Period; avgRate: number | null }) {
  const label = GRANULARITY_LABELS[gran];
  return (
    <HcCard
      title={`Taxa de sucesso por ${label.one}`}
      gran={{ value: gran, onChange: (v) => onGran(v as Granularity) }}
      info={`Um ponto por ${label.one}; períodos longos rolam para os lados, começando pelo mais recente. ${label.many} com menos de 3 execuções concluídas ficam sem ponto (o trecho tracejado liga os vizinhos). Pedaços incompletos (semana ou mês cortado pelo período) aparecem com o rótulo mais claro; passe o mouse para ver quantos dias entram. A taxa é sucessos ÷ concluídas: canceladas e erros do reinício do Hub ficam de fora.`}
      legend={[{ c: 'var(--s1)', shape: 'line', l: `Taxa ${label.of}` }, { c: 'var(--accent)', shape: 'dash', l: `Média do período: ${pct(avgRate)}` }]}
      table={() => ({
        head: [label.col, 'Concluídas', 'Taxa de sucesso'],
        rows: buckets.map((b) => {
          const info = bucketInfo(b.start, gran, period.from, period.to);
          return [info.label + (info.part ? ' (incompleto)' : ''), nf(b.concluded), pct(b.concluded >= 3 ? b.successRate : null)];
        }),
      })}
    >
      {(w) => <RatePlot buckets={buckets} gran={gran} period={period} w={w} avgRate={avgRate} />}
    </HcCard>
  );
}

// ---------- Erros por categoria ----------

function CatsPlot({ buckets, gran, period, w, info }: { buckets: CategoryBucket[]; gran: Granularity; period: Period; w: number; info: CategoryInfo[] }) {
  const n = buckets.length;
  const aw = 36;
  const m = { t: 14, b: 26 };
  const h = 250;
  const ph = h - m.t - m.b;
  const avail = w - aw;
  const band = Math.max(MINCOL, avail / n);
  const plotW = band * n;
  const bw = Math.max(4, Math.min(24, band - 2));
  const sc = niceScale(Math.max(1, ...buckets.map((b) => b.total)), 4);
  const Y = (v: number) => m.t + ph * (1 - v / sc.max);
  const infos = buckets.map((b) => bucketInfo(b.start, gran, period.from, period.to));
  const name = (k: (typeof CATEGORY_ORDER)[number]) => info.find((i) => i.key === k)?.label ?? k;
  const hov = useBand({
    n, x0: 0, y0: m.t, h: ph, band,
    tip: (i) => {
      const b = buckets[i];
      return {
        title: infos[i].title,
        rows: CATEGORY_ORDER.filter((k) => b.counts[k]).map((k) => ({ c: CATEGORY_COLOR[k], v: nf(b.counts[k]), l: name(k) })),
        note: `${b.total ? `${pl(b.total, 'erro', 'erros')} no total` : 'Nenhum erro'}${infos[i].note ? `. ${infos[i].note}` : ''}`,
      };
    },
  });
  return (
    <ScrollPlot
      avail={avail}
      plotW={plotW}
      axis={
        <svg width={aw} height={h} viewBox={`0 0 ${aw} ${h}`} aria-hidden="true">
          {ticksOf(sc).map((v) => <text key={v} className="ax" x={aw - 6} y={Y(v) + 4} textAnchor="end">{nf(v, 0)}</text>)}
        </svg>
      }
      plot={
        <svg width={plotW} height={h} viewBox={`0 0 ${plotW} ${h}`} role="img" aria-label={`Erros por ${GRANULARITY_LABELS[gran].one}, por categoria de causa`} {...hov.svgProps}>
          {hov.highlight}
          {ticksOf(sc).map((v) => <line key={v} className="grid" x1={0} x2={plotW} y1={Y(v)} y2={Y(v)} />)}
          <g>
            {buckets.map((b, i) => {
              const x = i * band + (band - bw) / 2;
              return (
                <g key={b.start}>
                  <StackBars x={x} bw={bw} Y={Y} segs={CATEGORY_ORDER.map((k) => ({ v: b.counts[k], c: CATEGORY_COLOR[k] }))} />
                  <text className="ax" x={x + bw / 2} y={h - 8} textAnchor="middle" style={infos[i].part ? { opacity: 0.5 } : undefined}>{infos[i].label}</text>
                </g>
              );
            })}
          </g>
          <line className="axis" x1={0} x2={plotW} y1={Y(0)} y2={Y(0)} />
          {hov.overlay}
        </svg>
      }
    />
  );
}

export function CatsCard({ buckets, gran, onGran, period, info, guide }: { buckets: CategoryBucket[]; gran: Granularity; onGran: (g: Granularity) => void; period: Period; info: CategoryInfo[]; guide: ReactNode }) {
  const label = GRANULARITY_LABELS[gran];
  const empty = !buckets.some((b) => b.total);
  return (
    <HcCard
      title={`Erros por categoria, por ${label.one}`}
      gran={{ value: gran, onChange: (v) => onGran(v as Granularity) }}
      info={guide}
      legend={CATEGORY_ORDER.map((k) => ({ c: CATEGORY_COLOR[k], l: info.find((i) => i.key === k)?.label ?? k }))}
      table={() => ({
        head: [label.col, ...CATEGORY_ORDER.map((k) => info.find((i) => i.key === k)?.label ?? k)],
        rows: buckets.map((b) => {
          const bi = bucketInfo(b.start, gran, period.from, period.to);
          return [bi.label + (bi.part ? ' (incompleto)' : ''), ...CATEGORY_ORDER.map((k) => nf(b.counts[k]))];
        }),
      })}
    >
      {(w) => (empty ? <div className="hc-empty">Nenhum erro neste filtro.</div> : <CatsPlot buckets={buckets} gran={gran} period={period} w={w} info={info} />)}
    </HcCard>
  );
}

// ---------- Duração dos robôs mais usados (pequenos múltiplos) ----------

function DurationPlot({ series, gran, period, cw }: { series: DurationSeries; gran: Granularity; period: Period; cw: number }) {
  const pts = series.points;
  const n = pts.length;
  const aw = 38;
  const mr = 38;
  const m = { t: 14, b: 24 };
  const h = 190;
  const ph = h - m.t - m.b;
  const avail = cw - aw;
  const band = Math.max(MINCOL, (avail - mr) / n);
  const plotW = band * n + mr;
  const toMin = (s: number | null) => (s === null ? null : s / 60);
  const med = pts.map((p) => toMin(p.med));
  const p95 = pts.map((p) => toMin(p.p95));
  const lim = series.t2Minutes;
  const mx = Math.max(1, ...p95.map((v) => v ?? 0), ...med.map((v) => v ?? 0), lim ?? 0);
  const sc = niceScale(mx, 3);
  const Y = (v: number) => m.t + ph * (1 - v / sc.max);
  const X = (i: number) => (i + 0.5) * band;
  const infos = pts.map((p) => bucketInfo(p.start, gran, period.from, period.to));
  const lastOf = (vals: Array<number | null>) => { let li = -1; vals.forEach((v, i) => { if (v !== null) li = i; }); return li; };
  const lm = lastOf(med);
  const lp = lastOf(p95);
  const hov = useBand({
    n, x0: 0, y0: m.t, h: ph, band, cross: true,
    tip: (i) => {
      const p = pts[i];
      return {
        title: infos[i].title + (infos[i].part ? ' (incompleto)' : ''),
        rows: p.med === null ? [{ v: '—', l: `poucos dados (${p.n} com sucesso)` }] : [{ c: 'var(--s1)', shape: 'line', v: mins(p.med), l: 'típica (mediana)' }, { c: 'var(--s2)', shape: 'line', v: mins(p.p95), l: 'dos casos mais lentos (95%)' }],
        note: p.med === null ? undefined : `${pl(p.n, 'execução', 'execuções')} com sucesso`,
      };
    },
  });
  return (
    <ScrollPlot
      avail={avail}
      plotW={plotW}
      axis={
        <svg width={aw} height={h} viewBox={`0 0 ${aw} ${h}`} aria-hidden="true">
          {ticksOf(sc).map((v) => <text key={v} className="ax" x={aw - 6} y={Y(v) + 4} textAnchor="end">{nf(v, sc.step < 1 ? 1 : 0)}</text>)}
        </svg>
      }
      plot={
        <svg width={plotW} height={h} viewBox={`0 0 ${plotW} ${h}`} role="img" aria-label={`Duração por ${GRANULARITY_LABELS[gran].one} de ${series.name}`} {...hov.svgProps}>
          {hov.highlight}
          {ticksOf(sc).map((v) => <line key={v} className="grid" x1={0} x2={plotW} y1={Y(v)} y2={Y(v)} />)}
          {lim ? (
            <>
              <line x1={0} x2={plotW} y1={Y(lim)} y2={Y(lim)} style={{ stroke: 'var(--hc-ink)', strokeWidth: 1.5, strokeDasharray: '6 4' }} />
              <text className="lbl" x={plotW - 4} y={Y(lim) - 4} textAnchor="end" style={{ fill: 'var(--hc-ink)', fontWeight: 650 }}>T2 = {lim} min (reinício)</text>
            </>
          ) : null}
          <GapLinks vals={p95} X={X} Y={Y} color="var(--s2)" />
          <SmoothLine vals={p95} X={X} Y={Y} color="var(--s2)" yBase={Y(0)} />
          <GapLinks vals={med} X={X} Y={Y} color="var(--s1)" />
          <SmoothLine vals={med} X={X} Y={Y} color="var(--s1)" yBase={Y(0)} area />
          {p95.map((v, i) => (v !== null ? <circle key={`p${i}`} cx={X(i)} cy={Y(v)} r={3} style={{ fill: 'var(--s2)', stroke: 'var(--hc-surface)', strokeWidth: 1.5, pointerEvents: 'none' }} /> : null))}
          {med.map((v, i) => (v !== null ? <circle key={`m${i}`} cx={X(i)} cy={Y(v)} r={3} style={{ fill: 'var(--s1)', stroke: 'var(--hc-surface)', strokeWidth: 1.5, pointerEvents: 'none' }} /> : null))}
          {lp >= 0 ? <text className="lbl" x={X(lp) + 8} y={Y(p95[lp]!) + (lm === lp && Math.abs(Y(med[lm]!) - Y(p95[lp]!)) < 15 ? -3 : 4)} style={{ fontWeight: 650, fill: 'var(--hc-ink)' }}>{nf(p95[lp], 0)}</text> : null}
          {lm >= 0 ? <text className="lbl" x={X(lm) + 8} y={Y(med[lm]!) + (lm === lp && Math.abs(Y(med[lm]!) - Y(p95[lp]!)) < 15 ? 14 : 4)} style={{ fontWeight: 650, fill: 'var(--hc-ink)' }}>{nf(med[lm], 0)}</text> : null}
          {pts.map((p, i) => <text key={p.start} className="ax" x={X(i)} y={h - 7} textAnchor="middle" style={infos[i].part ? { opacity: 0.5 } : undefined}>{infos[i].label}</text>)}
          <line className="axis" x1={0} x2={plotW} y1={Y(0)} y2={Y(0)} />
          {hov.overlay}
        </svg>
      }
    />
  );
}

export function DurationCard({ durations, gran, onGran, period }: { durations: DurationSeries[]; gran: Granularity; onGran: (g: Granularity) => void; period: Period }) {
  const label = GRANULARITY_LABELS[gran];
  const n = durations.length;
  return (
    <HcCard
      title={`Duração por ${label.one}${n <= 1 ? ' do robô mais usado' : ` dos ${n} robôs mais usados`}`}
      gran={{ value: gran, onChange: (v) => onGran(v as Granularity) }}
      info={`Por ${label.one}: tempo típico (mediana) e dos 5% mais lentos, só das execuções com sucesso dos robôs rodados pelo Hub. Cada gráfico tem a própria escala vertical (em minutos). ${label.many} com menos de 3 execuções com sucesso ficam sem ponto (o trecho tracejado liga os vizinhos). A linha do T2 vale para as execuções agendadas (o gráfico mostra todas); se o robô tem mais de um agendamento, mostra o menor T2. Períodos longos rolam para os lados em cada gráfico, começando pelo mais recente.`}
      legend={[
        { c: 'var(--s1)', shape: 'line', l: 'Típica (mediana)' },
        { c: 'var(--s2)', shape: 'line', l: '95% terminam em até (mais lentos)' },
        ...(durations.some((d) => d.t2Minutes) ? [{ c: 'var(--hc-ink)', shape: 'dash ink', l: 'Limite de reinício (T2) do agendamento' }] : []),
      ]}
      table={() => ({
        head: ['Robô', label.col, 'Execuções com sucesso', 'Típica (min)', '95% em até (min)'],
        rows: durations.flatMap((d) =>
          d.points.filter((p) => p.n > 0).map((p) => [d.name, bucketInfo(p.start, gran, period.from, period.to).label, nf(p.n), p.med === null ? '—' : nf(p.med / 60, 1), p.p95 === null ? '—' : nf(p.p95 / 60, 1)]),
        ),
        numFrom: 2,
      })}
    >
      {(w) =>
        n === 0 ? (
          <div className="hc-empty">Poucos dados: nenhum robô com ao menos 3 execuções com sucesso neste filtro.</div>
        ) : (
          <div className="hc-grid2e" style={{ marginTop: 4 }}>
            {durations.map((d) => (
              <div key={d.robotId} style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{d.name}</div>
                <div style={{ color: 'var(--hc-muted)', fontSize: 12, marginBottom: 2 }}>{pl(d.executions, 'execução', 'execuções')} com sucesso · minutos no eixo vertical</div>
                <div style={{ maxWidth: Math.floor((w - 16) / (w > 700 ? 2 : 1)) - 34 + 38 }}>
                  <DurationPlot series={d} gran={gran} period={period} cw={Math.floor((w - 16) / (w > 700 ? 2 : 1)) - 34} />
                </div>
              </div>
            ))}
          </div>
        )
      }
    </HcCard>
  );
}

// o degradê das áreas das curvas usa G(); reexportado para os outros arquivos do módulo
export { G };
