import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useContainerWidth } from './chart-utils';

// Peças de desenho compartilhadas pelos gráficos da Saúde dos robôs. Reproduzem, em React/SVG, o que o protótipo HTML
// aprovado fazia: degradês por ficha de cor, curva suave (interpolação monótona), barras com ponta arredondada e vão de 2 px,
// grade pontilhada, dica que acompanha o mouse e área rolável com eixo fixo.

// ---------- degradês ----------

const TOKENS = ['s1', 's2', 's3', 's4', 's5', 's6', 'crit', 'cancel', 'nocause', 'warn'];
const mix = (token: string, pc: number) => `color-mix(in srgb, var(--${token}) ${pc}%, #fff)`;

/** Define os degradês (barras verticais, horizontais e áreas) de todas as fichas: renderizar UMA vez na página. */
export function ChartDefs() {
  return (
    <svg width={0} height={0} aria-hidden="true" style={{ position: 'absolute' }}>
      <defs>
        {TOKENS.map((t) => (
          <Fragment key={t}>
            <linearGradient id={`gv-${t}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: mix(t, 84) }} />
              <stop offset="100%" style={{ stopColor: `var(--${t})` }} />
            </linearGradient>
            <linearGradient id={`gh-${t}`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" style={{ stopColor: `var(--${t})` }} />
              <stop offset="100%" style={{ stopColor: mix(t, 80) }} />
            </linearGradient>
            <linearGradient id={`ga-${t}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: `var(--${t})`, stopOpacity: 0.26 }} />
              <stop offset="100%" style={{ stopColor: `var(--${t})`, stopOpacity: 0 }} />
            </linearGradient>
          </Fragment>
        ))}
      </defs>
    </svg>
  );
}

/** 'var(--s1)' → 'url(#gv-s1)' (v = vertical, h = horizontal, a = área); cores que não são ficha ficam como estão. */
export function G(color: string, dir: 'v' | 'h' | 'a' = 'v') {
  const m = /^var\(--(\w+)\)$/.exec(color);
  return m && TOKENS.includes(m[1]) ? `url(#g${dir}-${m[1]})` : color;
}

// ---------- curva suave e escala ----------

/** Interpolação monótona (Fritsch–Carlson): curva suave que nunca passa de cima ou de baixo dos pontos. */
export function curvePath(pts: Array<[number, number]>): string {
  const n = pts.length;
  if (n === 0) return '';
  if (n < 2) return `M${pts[0][0]},${pts[0][1]}`;
  const dx: number[] = [];
  const m: number[] = [];
  const t = new Array<number>(n);
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    m[i] = (pts[i + 1][1] - pts[i][1]) / (dx[i] || 1);
  }
  t[0] = m[0];
  t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = t[i + 1] = 0;
      continue;
    }
    const a = t[i] / m[i];
    const b = t[i + 1] / m[i];
    const q2 = a * a + b * b;
    if (q2 > 9) {
      const k = 3 / Math.sqrt(q2);
      t[i] = k * a * m[i];
      t[i + 1] = k * b * m[i];
    }
  }
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    d += `C${pts[i][0] + dx[i] / 3},${pts[i][1] + (t[i] * dx[i]) / 3} ${pts[i + 1][0] - dx[i] / 3},${pts[i + 1][1] - (t[i + 1] * dx[i]) / 3} ${pts[i + 1][0]},${pts[i + 1][1]}`;
  }
  return d;
}

export function niceScale(max: number, ticks = 4) {
  if (max <= 0) return { max: 1, step: 1 };
  const raw = max / ticks;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  return { max: Math.ceil(max / step - 1e-9) * step, step };
}

export function ticksOf(scale: { max: number; step: number }) {
  const out: number[] = [];
  for (let v = 0; v <= scale.max + 1e-9; v += scale.step) out.push(v);
  return out;
}

export function topRound(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/** Linha suave de 2 px, com área em degradê opcional; trechos sem valor interrompem a linha. */
export function SmoothLine({ vals, X, Y, color, yBase, area }: { vals: Array<number | null>; X: (i: number) => number; Y: (v: number) => number; color: string; yBase: number; area?: boolean }) {
  const segs: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  vals.forEach((v, i) => {
    if (v === null) {
      if (cur.length) segs.push(cur);
      cur = [];
    } else cur.push([X(i), Y(v)]);
  });
  if (cur.length) segs.push(cur);
  return (
    <>
      {segs
        .filter((s) => s.length >= 2)
        .map((s, k) => {
          const d = curvePath(s);
          return (
            <g key={k}>
              {area && G(color, 'a') !== color ? <path d={`${d}L${s[s.length - 1][0]},${yBase}L${s[0][0]},${yBase}Z`} style={{ fill: G(color, 'a'), stroke: 'none', pointerEvents: 'none' }} /> : null}
              <path d={d} style={{ fill: 'none', stroke: color, strokeWidth: 2, strokeLinejoin: 'round', strokeLinecap: 'round' }} />
            </g>
          );
        })}
    </>
  );
}

/** Buracos (balde sem dados): ligação tracejada clara entre os pontos que existem. */
export function GapLinks({ vals, X, Y, color }: { vals: Array<number | null>; X: (i: number) => number; Y: (v: number) => number; color: string }) {
  const pts = vals.map((v, i) => (v === null ? null : ([i, v] as [number, number]))).filter((p): p is [number, number] => p !== null);
  return (
    <>
      {pts.slice(1).map((p, k) =>
        p[0] - pts[k][0] > 1 ? (
          <line key={k} x1={X(pts[k][0])} y1={Y(pts[k][1])} x2={X(p[0])} y2={Y(p[1])} style={{ stroke: color, strokeWidth: 1.5, strokeDasharray: '3 3', opacity: 0.45, pointerEvents: 'none' }} />
        ) : null,
      )}
    </>
  );
}

/** Barras empilhadas (vão de 2 px; ponta de cima arredondada). */
export function StackBars({ x, bw, Y, segs }: { x: number; bw: number; Y: (v: number) => number; segs: Array<{ v: number; c: string }> }) {
  const live = segs.filter((s) => s.v > 0);
  let acc = 0;
  return (
    <>
      {live.map((s, j) => {
        const y0 = Y(acc);
        const y1 = Y(acc + s.v);
        acc += s.v;
        const top = j === live.length - 1;
        const gap = j === 0 ? 0 : 2;
        const h = Math.max(3, y0 - y1 - gap);
        const y = Math.min(y1, y0 - h);
        return top ? <path key={j} d={topRound(x, y, bw, h, 4)} style={{ fill: G(s.c) }} /> : <rect key={j} x={x} y={y} width={bw} height={h} rx={1} style={{ fill: G(s.c) }} />;
      })}
    </>
  );
}

// ---------- dica que acompanha o mouse ----------

export type TipData = { title?: string; rows?: Array<{ c?: string; shape?: string; v: string; l: string }>; note?: string };
type TipState = { x: number; y: number; d: TipData } | null;
let setTipState: ((s: TipState) => void) | null = null;
export const tip = {
  show: (x: number, y: number, d: TipData) => setTipState?.({ x, y, d }),
  hide: () => setTipState?.(null),
};

/** A dica flutuante (uma só para a página inteira). Fica dentro da raiz `.hc` para herdar as cores. */
export function TipLayer() {
  const [state, set] = useState<TipState>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  useEffect(() => {
    setTipState = set;
    return () => {
      setTipState = null;
    };
  }, []);
  useLayoutEffect(() => {
    if (!state || !ref.current) return;
    const w = ref.current.offsetWidth;
    const h = ref.current.offsetHeight;
    let left = state.x + 14;
    let top = state.y - h - 10;
    if (left + w > window.innerWidth - 8) left = state.x - w - 14;
    if (left < 8) left = 8;
    if (top < 8) top = state.y + 16;
    setPos({ left, top });
  }, [state]);
  if (!state) return null;
  return (
    <div ref={ref} className="hc-tip" role="status" style={{ left: pos.left, top: pos.top }}>
      {state.d.title ? <div className="tt">{state.d.title}</div> : null}
      {(state.d.rows ?? []).map((r, i) => (
        <div className="tr" key={i}>
          {r.c ? <span className={`hc-key ${r.shape ?? ''}`} style={{ background: r.c }} /> : null}
          <b>{r.v}</b>
          <span className="l">{r.l}</span>
        </div>
      ))}
      {state.d.note ? <div className="nt">{state.d.note}</div> : null}
    </div>
  );
}

// ---------- ícone "i" com explicação ----------

export function HcInfo({ label, text, children }: { label: string; text?: string; children?: ReactNode }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setAnchor(r);
  };
  const hide = () => {
    setAnchor(null);
    setPos(null);
  };
  // Mede a dica e a mantém inteira na tela: abre embaixo do "i" se couber; senão sobe (acima dele); se nem assim couber,
  // encosta no topo da janela. Na horizontal, nunca passa das bordas.
  useLayoutEffect(() => {
    if (!anchor || !tipRef.current) return;
    const w = tipRef.current.offsetWidth;
    const h = tipRef.current.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;
    const left = Math.max(margin, Math.min(anchor.left, vw - w - margin));
    const below = anchor.bottom + margin;
    const above = anchor.top - margin - h;
    let top: number;
    if (below + h <= vh - margin) top = below;
    else if (above >= margin) top = above;
    else top = Math.max(margin, vh - h - margin);
    setPos({ left, top });
  }, [anchor]);
  // rolar a página ou redimensionar a janela com a dica aberta a deixaria no lugar errado: fecha
  useEffect(() => {
    if (!anchor) return;
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [anchor]);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="hc-info"
        aria-label={label}
        aria-expanded={!!anchor}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onKeyDown={(e) => e.key === 'Escape' && hide()}
      >
        i
      </button>
      {anchor ? (
        <div ref={tipRef} className="hc-infotip" role="tooltip" style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden', maxHeight: 'calc(100vh - 16px)', overflow: 'hidden' }}>
          {children ?? text}
        </div>
      ) : null}
    </>
  );
}

// ---------- controles e cartão ----------

export function Seg({ label, items, value, onChange }: { label: string; items: Array<[string, string]>; value: string; onChange: (v: string) => void }) {
  return (
    <div className="hc-seg" role="group" aria-label={label}>
      {items.map(([v, t]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>
          {t}
        </button>
      ))}
    </div>
  );
}

export type LegendItem = { c: string; l: string; shape?: string };

export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <div className="hc-legend">
      {items.map((i) => (
        <span className="it" key={i.l}>
          <span className={`hc-key ${i.shape ?? ''}`} style={{ background: i.c }} />
          {i.l}
        </span>
      ))}
    </div>
  );
}

export function DataTable({ head, rows, numFrom = 1 }: { head: string[]; rows: Array<Array<string | number>>; numFrom?: number }) {
  return (
    <div className="hc-tw" style={{ maxHeight: 360, overflow: 'auto' }}>
      <table className="hc-table">
        <thead>
          <tr>{head.map((h, i) => <th key={h} className={i >= numFrom ? 'num' : ''}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j} className={j >= numFrom ? 'num' : ''}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Cartão como o do protótipo: título com ponto dourado, "i" com a explicação, controles (agrupar, gráfico/tabela),
 * legenda e o corpo, que recebe a largura disponível para desenhar.
 */
export function HcCard({
  title,
  info,
  gran,
  legend,
  table,
  wide,
  children,
}: {
  title: string;
  info?: ReactNode;
  gran?: { value: string; onChange: (v: string) => void };
  legend?: LegendItem[];
  table?: () => { head: string[]; rows: Array<Array<string | number>>; numFrom?: number };
  wide?: boolean;
  children: (width: number) => ReactNode;
}) {
  const [mode, setMode] = useState<'chart' | 'table'>('chart');
  const [setBody, width] = useContainerWidth();
  const t = mode === 'table' && table ? table() : null;
  return (
    <section className="hc-card" style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <div className="hc-h">
        <div>
          <h3>
            <span>{title}</span>
            {info ? <HcInfo label={`Sobre: ${title}`}>{info}</HcInfo> : null}
          </h3>
        </div>
        <div className="hc-tools">
          {gran ? <Seg label="Agrupar por" items={[['day', 'Dia'], ['week', 'Semana'], ['month', 'Mês']]} value={gran.value} onChange={gran.onChange} /> : null}
          {table ? <Seg label="Forma de exibição" items={[['chart', 'Gráfico'], ['table', 'Tabela']]} value={mode} onChange={(v) => setMode(v as 'chart' | 'table')} /> : null}
        </div>
      </div>
      {legend ? <Legend items={legend} /> : null}
      <div className="hc-body" ref={setBody}>
        {t ? <DataTable head={t.head} rows={t.rows} numFrom={t.numFrom} /> : width > 0 ? children(Math.max(280, Math.floor(width))) : null}
      </div>
    </section>
  );
}

// ---------- área rolável com eixo fixo ----------

/** Eixo fixo à esquerda + área rolável; começa mostrando o fim do período (o mais recente). */
export function ScrollPlot({ axis, plot, avail, plotW }: { axis: ReactNode; plot: ReactNode; avail: number; plotW: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (plotW > avail + 1 && ref.current) ref.current.scrollLeft = ref.current.scrollWidth;
  }, [plotW, avail]);
  return (
    <div className="hc-splot">
      {axis}
      <div className="hc-xscroll" ref={ref} tabIndex={0} role="group" aria-label="Área do gráfico: role para os lados para ver todo o período">
        {plot}
      </div>
    </div>
  );
}

// ---------- passar o mouse por faixa (barras e linhas) ----------

/**
 * Faixa de hover/teclado de um gráfico: devolve o que o `<svg>` precisa (ref, foco, teclas), o realce da faixa e a camada
 * que captura o ponteiro. Com `cross`, o realce é uma linha vertical (gráficos de linha); sem, uma faixa suave (barras).
 */
export function useBand(o: { n: number; x0: number; y0: number; h: number; band: number; cross?: boolean; tip: (i: number) => TipData | null }) {
  const [active, setActive] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const hide = useCallback(() => {
    setActive(null);
    tip.hide();
  }, []);
  const show = (idx: number, cx?: number, cy?: number) => {
    const i = Math.max(0, Math.min(o.n - 1, idx));
    const d = o.tip(i);
    if (!d || !svgRef.current) return hide();
    setActive(i);
    if (cx === undefined) {
      // teclado: rola a área do gráfico para a faixa escolhida ficar à vista
      const sc = svgRef.current.closest('.hc-xscroll') as HTMLElement | null;
      if (sc) {
        const bx = o.x0 + i * o.band;
        if (bx < sc.scrollLeft) sc.scrollLeft = Math.max(0, bx - 8);
        else if (bx + o.band > sc.scrollLeft + sc.clientWidth) sc.scrollLeft = bx + o.band - sc.clientWidth + 8;
      }
    }
    const r = svgRef.current.getBoundingClientRect();
    tip.show(cx ?? r.left + o.x0 + (i + 0.5) * o.band, cy ?? r.top + o.y0 + o.h / 2, d);
  };
  const onKeyDown = (e: ReactKeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const right = e.key === 'ArrowRight';
      show(active === null ? (right ? 0 : o.n - 1) : active + (right ? 1 : -1));
    } else if (e.key === 'Escape') hide();
  };
  const highlight =
    active === null ? null : o.cross ? (
      <rect x={o.x0 + (active + 0.5) * o.band - 0.5} y={o.y0} width={1} height={o.h} style={{ fill: 'var(--hc-axis)', pointerEvents: 'none' }} />
    ) : (
      <rect x={o.x0 + active * o.band} y={o.y0} width={o.band} height={o.h} style={{ fill: 'var(--hc-ink)', opacity: 0.07, pointerEvents: 'none' }} />
    );
  const overlay = (
    <rect
      x={o.x0}
      y={o.y0}
      width={o.band * o.n}
      height={o.h}
      style={{ fill: 'transparent', cursor: 'crosshair' }}
      onPointerMove={(ev) => {
        const r = svgRef.current?.getBoundingClientRect();
        if (r) show(Math.floor((ev.clientX - r.left - o.x0) / o.band), ev.clientX, ev.clientY);
      }}
      onPointerLeave={hide}
    />
  );
  return { svgRef: svgRef as RefObject<SVGSVGElement>, svgProps: { ref: svgRef, tabIndex: 0, onKeyDown, onBlur: hide }, highlight, overlay, active };
}

// ---------- minigráfico ----------

/** Minigráfico dos cartões e da coluna "Tendência": curva suave com área e o último ponto em dourado. */
export function Spark({ vals, w = 120, h = 26, color = 'var(--s1)', lo, hi }: { vals: Array<number | null>; w?: number; h?: number; color?: string; lo?: number; hi?: number }) {
  const pts = vals.map((v, i) => (v === null ? null : ([i, v] as [number, number]))).filter((p): p is [number, number] => p !== null);
  if (!pts.length) return <svg width={w} height={h} aria-hidden="true" />;
  const known = vals.filter((v): v is number => v !== null);
  let low = lo ?? Math.min(...known);
  let high = hi ?? Math.max(...known);
  if (high === low) {
    high += 1;
    low -= 1;
  }
  const n = vals.length;
  const X = (i: number) => 5 + (n > 1 ? (i * (w - 10)) / (n - 1) : (w - 10) / 2);
  const Y = (v: number) => h - 6 - ((v - low) / (high - low)) * (h - 12);
  const [li, lv] = pts[pts.length - 1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <GapLinks vals={vals} X={X} Y={Y} color={color} />
      <SmoothLine vals={vals} X={X} Y={Y} color={color} yBase={h - 2} area />
      {pts.map(([i, v]) => (vals[i - 1] == null && vals[i + 1] == null ? <circle key={i} cx={X(i)} cy={Y(v)} r={2} style={{ fill: color }} /> : null))}
      <circle cx={X(li)} cy={Y(lv)} r={4} style={{ fill: 'var(--accent)', stroke: 'var(--hc-surface)', strokeWidth: 2 }} />
    </svg>
  );
}
