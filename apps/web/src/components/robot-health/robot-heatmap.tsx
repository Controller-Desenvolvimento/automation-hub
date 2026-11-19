import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTheme } from '../../contexts/theme-context';
import { HEAT_BANDS, bucketInfo, fmtDay, heatColor, nf, pct, pl, type Heatmap } from '../../lib/robot-health';
import { HcCard, tip } from './kit';

const MINCOL = 32;
const CH = 22; // altura de cada linha
const HH = 24; // altura do cabeçalho de datas

type Period = { from: string; to: string };

/**
 * Mapa "Resultado por robô, dia a dia" do protótipo: uma linha por robô (do que mais executou para o que menos), um quadrado
 * por dia. A cor é o % de erro das execuções concluídas no dia: 0% = verde-água claro; com erro = rampa vermelha (quanto mais
 * forte, mais erro); quadrado só com contorno tracejado = nenhuma execução concluída. Erros do reinício do Hub ficam de fora
 * (aparecem só na dica). Nomes fixos à esquerda, datas fixas no alto, rolagem dos dois lados.
 */
function HeatPlot({ heatmap, period, w }: { heatmap: Heatmap; period: Period; w: number }) {
  const { theme } = useTheme();
  const dark = theme === 'dark';
  const { granularity, buckets } = heatmap;
  const rows = useMemo(
    () =>
      [...heatmap.rows]
        .map((r) => ({ ...r, total: r.cells.reduce((s, c) => s + c[0] + c[1] + c[3], 0) }))
        .filter((r) => r.total > 0 || r.cells.some((c) => c[2] > 0))
        .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'pt-BR')),
    [heatmap.rows],
  );
  const nd = buckets.length;
  const aw = w < 520 ? 120 : 210;
  const avail = w - aw - 14;
  const cw = Math.max(MINCOL, avail / nd);
  const plotW = cw * nd;
  const bodyH = CH * rows.length + 4;
  const maxCh = w < 520 ? 17 : 30;
  const infos = useMemo(() => buckets.map((b) => bucketInfo(b, granularity, period.from, period.to)), [buckets, granularity, period.from, period.to]);
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [ring, setRing] = useState<{ r: number; c: number } | null>(null);

  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollLeft = boxRef.current.scrollWidth;
  }, [plotW, w]);

  const describe = (r: number, c: number) => {
    const cell = rows[r].cells[c];
    const [ok, err, hub] = cell;
    const fin = ok + err;
    return {
      title: `${rows[r].name} · ${infos[c].title}`,
      rows: fin ? [{ v: nf(fin), l: 'concluídas' }, { v: nf(err), l: `com erro (${pct(err / fin)})` }] : [{ v: '—', l: `sem execução concluída neste ${granularity === 'day' ? 'dia' : granularity === 'week' ? 'período' : 'mês'}` }],
      note: hub ? `${pl(hub, 'interrompida pelo reinício do Hub (fora da conta)', 'interrompidas pelo reinício do Hub (fora da conta)')}` : undefined,
    };
  };

  const onMove = (ev: PointerEvent<SVGRectElement>) => {
    const rc = svgRef.current?.getBoundingClientRect();
    if (!rc) return;
    const c = Math.floor((ev.clientX - rc.left) / cw);
    const r = Math.floor((ev.clientY - rc.top) / CH);
    if (c < 0 || r < 0 || c >= nd || r >= rows.length) {
      setRing(null);
      tip.hide();
      return;
    }
    setRing({ r, c });
    tip.show(ev.clientX, ev.clientY, describe(r, c));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const moves: Record<string, [number, number]> = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] };
    if (e.key === 'Escape') {
      setRing(null);
      tip.hide();
      return;
    }
    const mv = moves[e.key];
    if (!mv) return;
    e.preventDefault();
    const base = ring ?? { r: 0, c: 0 };
    const next = { r: Math.min(rows.length - 1, Math.max(0, base.r + (ring ? mv[0] : 0))), c: Math.min(nd - 1, Math.max(0, base.c + (ring ? mv[1] : 0))) };
    setRing(next);
    const rc = svgRef.current?.getBoundingClientRect();
    // O retângulo do svg já acompanha a rolagem: a célula está em rc.left + a posição dela (antes descontava a rolagem e somava o eixo de novo).
    if (rc) tip.show(rc.left + (next.c + 0.5) * cw, rc.top + (next.r + 0.5) * CH, describe(next.r, next.c));
  };

  if (!rows.length) return <div className="hc-empty">Nenhuma execução neste filtro.</div>;

  return (
    <div
      ref={boxRef}
      className="hc-hm"
      style={{ gridTemplateColumns: `${aw}px max-content` }}
      tabIndex={0}
      role="group"
      aria-label="Mapa de falhas por robô e dia: role para os lados e para baixo (a Tabela traz os mesmos números)"
    >
      <div className="c" style={{ height: HH }} />
      <div className="hd">
        <svg width={plotW} height={HH} viewBox={`0 0 ${plotW} ${HH}`} aria-hidden="true">
          {buckets.map((b, i) => <text key={b} className="ax" x={(i + 0.5) * cw} y={16} textAnchor="middle" style={infos[i].part ? { opacity: 0.5 } : undefined}>{infos[i].label}</text>)}
        </svg>
      </div>
      <div className="lb">
        <svg width={aw} height={bodyH} viewBox={`0 0 ${aw} ${bodyH}`} aria-hidden="true">
          {rows.map((r, ri) => (
            <text key={r.robotId} className="lbl" x={aw - 8} y={ri * CH + CH / 2 + 4} textAnchor="end">
              {r.name.length > maxCh ? `${r.name.slice(0, maxCh - 1)}…` : r.name}
              <title>{r.name}</title>
            </text>
          ))}
        </svg>
      </div>
      <div>
        <svg
          ref={svgRef}
          width={plotW}
          height={bodyH}
          viewBox={`0 0 ${plotW} ${bodyH}`}
          role="img"
          aria-label="Percentual de erro por robô e por dia, do robô com mais execuções para o com menos"
          tabIndex={0}
          onKeyDown={onKey}
          onBlur={() => {
            setRing(null);
            tip.hide();
          }}
        >
          {rows.map((r, ri) =>
            r.cells.map((cell, ci) => {
              const fin = cell[0] + cell[1];
              const common = { x: ci * cw + 1.5, y: ri * CH + 1.5, width: Math.max(1, cw - 3), height: CH - 3, rx: 3 };
              return fin ? (
                <rect key={`${r.robotId}-${ci}`} {...common} style={{ fill: heatColor(cell[1] / fin, dark) }} />
              ) : (
                <rect key={`${r.robotId}-${ci}`} {...common} style={{ fill: 'transparent', stroke: 'var(--hc-axis)', strokeWidth: 1, strokeDasharray: '3 3' }} />
              );
            }),
          )}
          {ring ? <rect x={ring.c * cw} y={ring.r * CH} width={cw} height={CH} style={{ fill: 'none', stroke: 'var(--hc-ink)', strokeWidth: 2, pointerEvents: 'none' }} /> : null}
          <rect
            x={0}
            y={0}
            width={plotW}
            height={CH * rows.length}
            style={{ fill: 'transparent', cursor: 'crosshair' }}
            onPointerMove={onMove}
            onPointerLeave={() => {
              setRing(null);
              tip.hide();
            }}
          />
        </svg>
      </div>
    </div>
  );
}

export function HeatmapCard({ heatmap, period }: { heatmap: Heatmap; period: Period }) {
  const { theme } = useTheme();
  const dark = theme === 'dark';
  const g = heatmap.granularity;
  const unit = g === 'day' ? 'dia' : g === 'week' ? 'semana' : 'mês';
  const rows = useMemo(
    () => [...heatmap.rows].map((r) => ({ ...r, total: r.cells.reduce((s, c) => s + c[0] + c[1] + c[3], 0) })).filter((r) => r.total > 0).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'pt-BR')),
    [heatmap.rows],
  );
  return (
    <HcCard
      title={`Resultado por robô, ${g === 'day' ? 'dia a dia' : g === 'week' ? 'semana a semana' : 'mês a mês'}`}
      info={`Cada quadrado é um ${unit} de um robô, do robô com mais execuções para o com menos. A cor mostra o % de erro das execuções concluídas no ${unit}: verde-água = nenhum erro; vermelho = teve erro, e quanto mais forte o vermelho, mais erro (a legenda mostra a escala). Quadrado só com contorno = nenhuma execução concluída. Erros causados pelo reinício do Hub ficam de fora (aparecem só na dica). Períodos longos rolam para os lados; passe o mouse ou use as setas do teclado.`}
      legend={[
        ...HEAT_BANDS.map(([a, b, t]) => ({ c: heatColor(b === 0 ? 0 : (a + b) / 2, dark), l: t })),
        { c: 'transparent', shape: 'hmk', l: 'sem execução' },
      ]}
      table={() => ({
        head: ['Robô', `${unit === 'dia' ? 'Dias' : unit === 'semana' ? 'Semanas' : 'Meses'} com execução`, `${unit === 'dia' ? 'Dias' : unit === 'semana' ? 'Semanas' : 'Meses'} com erro`, `Pior ${unit}`, '% de erro no período'],
        rows: rows.map((r) => {
          let dias = 0;
          let comErro = 0;
          let worst: { t: number; i: number } | null = null;
          let okAll = 0;
          let errAll = 0;
          r.cells.forEach((c, i) => {
            const fin = c[0] + c[1];
            okAll += c[0];
            errAll += c[1];
            if (!fin) return;
            dias += 1;
            if (c[1]) comErro += 1;
            const t = c[1] / fin;
            if (!worst || t > worst.t) worst = { t, i };
          });
          const wr = worst as { t: number; i: number } | null;
          return [r.name, nf(dias), nf(comErro), wr && wr.t > 0 ? `${fmtDay(heatmap.buckets[wr.i])} (${pct(wr.t)})` : '—', okAll + errAll ? pct(errAll / (okAll + errAll)) : '—'];
        }),
      })}
    >
      {(w) => <HeatPlot heatmap={heatmap} period={period} w={w} />}
    </HcCard>
  );
}
