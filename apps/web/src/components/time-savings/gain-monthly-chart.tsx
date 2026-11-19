import { useMemo, useState } from 'react';
import { dur, nf, signed, signedDur, type MonthlyPoint } from '../../lib/gain-simulator';
import { useContainerWidth } from '../robot-health/chart-utils';
import { SgSeg } from './sg-parts';

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MONTH_NAMES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const m3 = (key: string) => MONTHS[Number(key.slice(5, 7)) - 1];
const yy = (key: string) => key.slice(2, 4);
const monthName = (key: string) => {
  const name = `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} de ${key.slice(0, 4)}`;
  return name.charAt(0).toUpperCase() + name.slice(1);
};
const pctTxt = (v: number) => signed(v, (a) => `${nf(a)}%`);
const dmy = (d: Date) => d.toLocaleDateString('pt-BR');

/** Máximo "redondo" do eixo (4 intervalos): o mesmo do protótipo. */
function niceMax(v: number) {
  if (v <= 0) return { max: 1, step: 1 };
  const raw = v / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  return { max: Math.ceil(v / step) * step, step };
}

type Row = { m: MonthlyPoint; atual: number; extra: number; tot: number; vari: number | null };

/**
 * Evolução mensal do protótipo: faixa de cima = variação sobre o mês anterior (linha cheia nos meses fechados, pontilhada até o mês
 * em andamento); barras = ganho atual (cinza) + extra simulado (azul), com o total em cima; um retângulo por mês para mouse, toque
 * e teclado (Tab passa pelos meses), com a dica acompanhando o ponteiro.
 */
export function GainMonthlyChart({ months, cut }: { months: MonthlyPoint[]; cut: boolean }) {
  const [scope, setScope] = useState<'todos' | 'sim'>('todos');
  const [setBody, width] = useContainerWidth();
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);

  const rows: Row[] = useMemo(() => {
    const base = months.map((m) => ({ m, atual: scope === 'todos' ? m.current : m.currentSim, extra: m.extra }));
    return base.map((r, i) => {
      const tot = r.atual + r.extra;
      const prev = i > 0 ? base[i - 1].atual + base[i - 1].extra : null;
      // o primeiro mês começa em 0%; sem mês anterior com valor, não há variação
      const vari = i === 0 ? 0 : prev && prev > 0 ? ((tot - prev) / prev) * 100 : null;
      return { ...r, tot, vari };
    });
  }, [months, scope]);

  if (rows.length === 0) return <p className="sub">Ainda não há meses completos de dados para mostrar a evolução.</p>;

  const w = Math.max(300, width);
  const n = rows.length;
  const m = { l: 52, r: 14 };
  const lineTop = 22;
  const lineH = 74;
  const barTop = lineTop + lineH + 34;
  const barH = 210;
  const h = barTop + barH + 30;
  const band = (w - m.l - m.r) / n;
  const bw = Math.max(8, Math.min(46, band * 0.58));
  const X = (i: number) => m.l + band * i + band / 2;
  const vs = rows.map((r) => r.vari).filter((v): v is number => v !== null);
  const vmax = Math.max(5, ...vs.map(Math.abs)) * 1.15;
  const VY = (v: number) => lineTop + lineH / 2 - (v / vmax) * (lineH / 2);
  const sc = niceMax(Math.max(...rows.map((r) => Math.max(r.tot, r.atual))) / 3600);
  const BY = (hh: number) => barTop + barH - (hh / sc.max) * barH;
  const curto = band < 46;
  const pula = band < 24;
  const pts = rows.map((r, i) => (r.vari === null ? null : { x: X(i), y: VY(r.vari), v: r.vari, partial: r.m.partial })).filter((p): p is NonNullable<typeof p> => p !== null);
  const full = pts.filter((p) => !p.partial);
  const partial = pts.find((p) => p.partial);
  const grid: number[] = [];
  for (let v = 0; v <= sc.max + 1e-9; v += sc.step) grid.push(v);
  const active = hover ? rows[hover.i] : null;
  const tip = (() => {
    if (!hover || !active) return null;
    const tw = 300;
    const th = 150;
    let px = hover.x + 14;
    let py = hover.y + 14;
    if (typeof window !== 'undefined') {
      if (px + tw > window.innerWidth - 8) px = hover.x - tw - 14;
      if (py + th > window.innerHeight - 8) py = hover.y - th - 14;
    }
    return { left: Math.max(8, px), top: Math.max(8, py) };
  })();

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <p className="sub" style={{ margin: 0 }}>
          Últimos {nf(rows.length)} {rows.length === 1 ? 'mês' : 'meses'} com dados. Passe o mouse, toque ou use Tab num mês para ver os valores.
        </p>
        <SgSeg label="O que o gráfico soma" value={scope} onChange={setScope} items={[['todos', 'Todo o relatório'], ['sim', 'Só os simulados']]} />
      </div>
      <div ref={setBody} style={{ width: '100%', overflow: 'hidden', position: 'relative' }}>
        {width > 0 ? (
          <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="group" aria-label="Evolução mensal do tempo ganho: atual e extra simulado, com a variação mês a mês. Use Tab para ler cada mês." style={{ display: 'block', overflow: 'visible' }}>
            {hover ? <rect x={m.l + band * hover.i} y={lineTop - 4} width={band} height={h - lineTop - 18} rx={6} fill="rgba(14,165,233,.08)" pointerEvents="none" /> : null}
            <text x={m.l - 8} y={lineTop - 8} style={{ fontSize: 11.5, fill: 'var(--ink2)', fontWeight: 600 }}>Variação mês a mês</text>
            <line x1={m.l} x2={w - m.r} y1={VY(0)} y2={VY(0)} style={{ stroke: 'var(--line)', strokeWidth: 1, strokeDasharray: '4 4' }} />
            <text x={m.l - 8} y={VY(0) + 4} textAnchor="end" style={{ fontSize: 11.5, fill: 'var(--muted)' }}>0%</text>
            {full.length > 1 ? <polyline points={full.map((p) => `${p.x},${p.y}`).join(' ')} style={{ fill: 'none', stroke: 'var(--ink2)', strokeWidth: 2, strokeLinejoin: 'round', strokeLinecap: 'round' }} /> : null}
            {partial && full.length ? (
              <line x1={full[full.length - 1].x} y1={full[full.length - 1].y} x2={partial.x} y2={partial.y} style={{ stroke: 'var(--ink2)', strokeWidth: 2, strokeDasharray: '3 5', strokeLinecap: 'round' }} />
            ) : null}
            {pts.map((p, i) => {
              const col = Math.round(p.v) >= 0 ? 'var(--good-ink)' : 'var(--bad-ink)';
              return (
                <g key={i}>
                  <circle cx={p.x} cy={p.y} r={4} style={p.partial ? { fill: 'var(--surface)', stroke: col, strokeWidth: 2 } : { fill: col, stroke: 'var(--surface)', strokeWidth: 2 }} />
                  {band >= 34 || p.partial ? (
                    <text x={p.x} y={p.v >= 0 ? p.y - 9 : p.y + 17} textAnchor="middle" style={{ fontSize: 11.5, fontWeight: 650, fill: col, fontVariantNumeric: 'tabular-nums' }}>
                      {pctTxt(p.v)}
                      {p.partial ? '*' : ''}
                    </text>
                  ) : null}
                </g>
              );
            })}

            <text x={m.l - 8} y={barTop - 14} style={{ fontSize: 11.5, fill: 'var(--ink2)', fontWeight: 600 }}>Horas por mês</text>
            {grid.map((v) => (
              <g key={v}>
                <line x1={m.l} x2={w - m.r} y1={BY(v)} y2={BY(v)} style={{ stroke: 'var(--line2)', strokeWidth: 1 }} />
                <text x={m.l - 8} y={BY(v) + 4} textAnchor="end" style={{ fontSize: 11.5, fill: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>{nf(v, sc.step < 1 ? 1 : 0)} h</text>
              </g>
            ))}
            {rows.map((r, i) => {
              const x0 = X(i) - bw / 2;
              const yA = BY(r.atual / 3600);
              const yT = BY(r.tot / 3600);
              const base = BY(0);
              const label = curto ? (i === 0 || r.m.key.endsWith('-01') ? `${m3(r.m.key)}/${yy(r.m.key)}` : m3(r.m.key)) : `${m3(r.m.key)}/${yy(r.m.key)}`;
              const showLabel = !pula || i % 2 === (n - 1) % 2;
              return (
                <g key={r.m.key} style={r.m.partial ? { opacity: 0.55 } : undefined}>
                  {r.extra < 0 ? (
                    <>
                      {r.tot > 0 ? <rect x={x0} y={yT} width={bw} height={Math.max(1, base - yT)} rx={3} style={{ fill: 'var(--faint)' }} /> : null}
                      <rect x={x0 + 1} y={yA + 1} width={bw - 2} height={Math.max(1, yT - yA - 3)} rx={3} style={{ fill: 'none', stroke: 'var(--bad-ink)', strokeWidth: 1.5, strokeDasharray: '4 3' }} />
                    </>
                  ) : r.atual > 0 ? (
                    <rect x={x0} y={yA} width={bw} height={Math.max(1, base - yA)} rx={3} style={{ fill: 'var(--faint)' }} />
                  ) : null}
                  {r.extra > 0 ? <rect x={x0} y={yT} width={bw} height={Math.max(1, yA - yT - (r.atual > 0 ? 2 : 0))} rx={3} style={{ fill: 'var(--accent)' }} /> : null}
                  {r.tot > 0 && band >= 40 ? (
                    <text x={X(i)} y={yT - 6} textAnchor="middle" style={{ fontSize: 11, fill: 'var(--ink2)', fontVariantNumeric: 'tabular-nums' }}>{dur(r.tot)}</text>
                  ) : null}
                  {showLabel ? (
                    <text x={X(i)} y={h - 10} textAnchor="middle" style={{ fontSize: 11.5, fill: 'var(--muted)' }}>
                      {label}
                      {r.m.partial ? '*' : ''}
                    </text>
                  ) : null}
                </g>
              );
            })}
            <line x1={m.l} x2={w - m.r} y1={BY(0)} y2={BY(0)} style={{ stroke: 'var(--ctl-border)', strokeWidth: 1 }} />
            {/* um retângulo por mês: mouse, toque e teclado */}
            {rows.map((r, i) => (
              <rect
                key={`hit-${r.m.key}`}
                x={m.l + band * i}
                y={0}
                width={band}
                height={h}
                tabIndex={0}
                role="img"
                aria-label={`${monthName(r.m.key)}${r.m.partial ? ' (incompleto)' : ''}: atual ${dur(r.atual)}, extra simulado ${signedDur(r.extra)}, total ${dur(r.tot)}${r.vari === null ? '' : `, variação ${signed(r.vari, (a) => `${nf(a, 1)}%`)}`}`}
                style={{ fill: 'transparent', cursor: 'default', outline: 'none' }}
                onMouseMove={(ev) => setHover({ i, x: ev.clientX, y: ev.clientY })}
                onMouseLeave={() => setHover(null)}
                onPointerDown={(ev) => ev.pointerType !== 'mouse' && setHover({ i, x: ev.clientX, y: ev.clientY })}
                onFocus={(ev) => {
                  const rc = (ev.target as SVGRectElement).getBoundingClientRect();
                  setHover({ i, x: rc.left + rc.width / 2, y: rc.top + 120 });
                }}
                onBlur={() => setHover(null)}
              />
            ))}
          </svg>
        ) : null}
      </div>
      {active && tip ? (
        <div role="status" className="sg-tip" style={{ left: tip.left, top: tip.top }}>
          <p style={{ fontWeight: 650, color: 'var(--ink)' }}>
            {monthName(active.m.key)}
            {active.m.partial ? ` (até ${dmy(new Date())}, incompleto)` : ''}
          </p>
          <p>
            <span className="sw" style={{ background: 'var(--faint)' }} />
            Atual (cadastrado): {dur(active.atual)}
          </p>
          <p>
            <span className="sw" style={{ background: 'var(--accent)' }} />
            Extra simulado: {signedDur(active.extra)}
          </p>
          <p style={{ fontWeight: 600 }}>Total: {dur(active.tot)}</p>
          <p>
            {active.vari === null
              ? 'Variação: sem mês anterior para comparar.'
              : active === rows[0]
                ? 'Variação: 0% (mês inicial)'
                : `Variação sobre o mês anterior: ${signed(active.vari, (a) => `${nf(a, 1)}%`)}${active.m.partial ? ' (parcial: o mês ainda não terminou)' : ''}`}
          </p>
        </div>
      ) : null}
      <div className="legend">
        <span><span className="sw" style={{ background: 'var(--faint)' }} />ganho atual (cadastrado)</span>
        <span><span className="sw" style={{ background: 'var(--accent)' }} />ganho extra simulado</span>
        <span><span style={{ display: 'inline-block', width: 16, height: 2, background: 'var(--ink2)', verticalAlign: 3, marginRight: 5 }} />variação mês a mês</span>
        <span><span style={{ display: 'inline-block', width: 16, borderTop: '2px dotted var(--ink2)', verticalAlign: 3, marginRight: 5 }} />mês em andamento* (parcial)</span>
      </div>
      <details className="tbl-alt">
        <summary>Ver os números em tabela</summary>
        <div className="tbl-wrap">
          <table className="sim">
            <thead>
              <tr>
                <th>Mês</th>
                <th className="n">Atual</th>
                <th className="n">Extra simulado</th>
                <th className="n">Total</th>
                <th className="n">Variação</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.m.key}>
                  <td>
                    {m3(r.m.key)}/{yy(r.m.key)}
                    {r.m.partial ? ' (parcial)' : ''}
                  </td>
                  <td className="n">{dur(r.atual)}</td>
                  <td className="n">{signedDur(r.extra)}</td>
                  <td className="n">{dur(r.tot)}</td>
                  <td className="n">{r.vari === null ? '—' : i === 0 ? '0%' : signed(r.vari, (a) => `${nf(a, 1)}%`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      {cut ? <p className="sub" style={{ margin: '8px 0 0' }}>O 1º mês de dados ficou de fora porque o histórico começa no meio dele.</p> : null}
    </div>
  );
}
