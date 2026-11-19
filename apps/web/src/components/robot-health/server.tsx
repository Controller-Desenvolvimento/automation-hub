import { useTheme } from '../../contexts/theme-context';
import { blueRamp, hourLabel, mins, nf, pct, pctTxt, pl, type Capacity, type CycleRow } from '../../lib/robot-health';
import { G, HcCard, HcInfo, niceScale, tip, topRound, ticksOf, useBand } from './kit';

// ---------- Capacidade do servidor (quantos robôs rodam ao mesmo tempo, por hora do dia) ----------

const tierOf = (peak: number, limit: number) => (peak >= limit ? 'crit' : limit >= 3 && peak >= limit - 1 ? 'warn' : 's1');
const luminance = (rgb: string) => {
  const m = /(\d+),\s*(\d+),\s*(\d+)/.exec(rgb);
  return m ? 0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3]) : 128;
};
const fmtDateTime = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} às ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function SummaryCard({ label, value, info }: { label: string; value: string; info: string }) {
  return (
    <div className="hc-cs">
      <div className="k">{label}</div>
      <HcInfo label={`Sobre ${label}`} text={info} />
      <div className="v">{value}</div>
    </div>
  );
}

function CapacityPlot({ cap, w }: { cap: Capacity; w: number }) {
  const { theme } = useTheme();
  const dark = theme === 'dark';
  const { limit, hours } = cap;
  const m = { l: 36, r: 8, t: 24 };
  const hB = 190;
  const base = m.t + hB;
  const sy = base + 30;
  const sh = 28;
  const h = sy + sh + 22;
  const pw = w - m.l - m.r;
  const band = pw / 24;
  const bw = Math.max(6, Math.min(28, band - 6));
  const maxPeak = Math.max(limit, ...hours.map((o) => o.peak));
  const sc = niceScale(maxPeak, 4);
  const Y = (v: number) => m.t + hB * (1 - v / sc.max);
  const maxPct = Math.max(0.01, ...hours.map((o) => o.busyShare));
  const hov = useBand({
    n: 24, x0: m.l, y0: m.t, h: sy + sh - m.t, band,
    tip: (i) => {
      const o = hours[i];
      if (!o.peak) return { title: hourLabel(i), rows: [{ v: '0', l: 'robôs rodando nesta hora, em todo o período' }] };
      return {
        title: hourLabel(i),
        rows: [
          { c: `var(--${tierOf(o.peak, limit)})`, v: pl(o.peak, 'robô', 'robôs'), l: `ao mesmo tempo no pior momento (limite: ${limit})` },
          { v: pctTxt(o.busyShare), l: 'do tempo com algum robô rodando' },
          { v: mins(o.minutesPerDay * 60), l: 'de robô rodando por dia, em média (somando todos)' },
          { v: `${nf(o.daysLimit)} de ${pl(o.days, 'dia', 'dias')}`, l: 'em que chegou ao limite' },
        ],
        note: `O pico aconteceu em ${fmtDateTime(o.peakAt)}`,
      };
    },
  });
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Pico de robôs ao mesmo tempo e percentual do tempo ocupado, por hora do dia" {...hov.svgProps}>
      {hov.highlight}
      {ticksOf(sc).map((v) => (
        <g key={v}>
          <line className="grid" x1={m.l} x2={m.l + pw} y1={Y(v)} y2={Y(v)} />
          <text className="ax" x={m.l - 6} y={Y(v) + 4} textAnchor="end">{nf(v, 0)}</text>
        </g>
      ))}
      <line x1={m.l} x2={m.l + pw} y1={Y(limit)} y2={Y(limit)} style={{ stroke: 'var(--crit)', strokeWidth: 1.5, strokeDasharray: '6 4' }} />
      <g>
        {hours.map((o, hh) => {
          const x = m.l + hh * band + (band - bw) / 2;
          const cx = x + bw / 2;
          const tier = tierOf(o.peak, limit);
          const cw = band - 4;
          const fill = o.busyShare > 0 ? blueRamp(o.busyShare / maxPct, dark) : null;
          return (
            <g key={hh}>
              {/* trilho: a capacidade inteira */}
              <path d={topRound(x, Y(limit), bw, Y(0) - Y(limit), Math.min(6, bw / 2))} style={{ fill: 'var(--hc-wash)' }} />
              {o.peak > 0 ? (
                <>
                  <path d={topRound(x, Y(o.peak), bw, Math.max(3, Y(0) - Y(o.peak)), Math.min(6, bw / 2))} style={{ fill: G(`var(--${tier})`) }} />
                  {tier !== 's1' ? <text className="lbl" x={cx} y={Y(o.peak) - 5} textAnchor="middle" style={{ fontWeight: 700, fill: 'var(--hc-ink)', fontSize: 11.5 }}>{o.peak}</text> : null}
                </>
              ) : null}
              <rect x={m.l + hh * band + 2} y={sy} width={Math.max(4, cw)} height={sh} rx={6} style={fill ? { fill } : { fill: 'var(--hc-grid)', opacity: 0.45 }} />
              {fill && cw >= 30 ? (
                <text x={m.l + hh * band + band / 2} y={sy + sh / 2 + 4} textAnchor="middle" style={{ fontSize: 11, fontWeight: 650, fill: luminance(fill) > 150 ? '#0b1220' : '#ffffff' }}>{pctTxt(o.busyShare)}</text>
              ) : null}
              {band >= 22 || hh % 3 === 0 ? <text className="ax" x={m.l + hh * band + band / 2} y={h - 6} textAnchor="middle">{hh}h</text> : null}
            </g>
          );
        })}
      </g>
      <text className="lbl" x={m.l + 4} y={Y(limit) - 6} style={{ fill: 'var(--bad-text)', fontWeight: 650, fontSize: 11.5, paintOrder: 'stroke', stroke: 'var(--hc-surface)', strokeWidth: 4, strokeLinejoin: 'round' }}>
        {w < 560 ? 'Limite: ' : 'Limite do servidor: '}{limit} ao mesmo tempo
      </text>
      <line className="axis" x1={m.l} x2={m.l + pw} y1={Y(0)} y2={Y(0)} />
      <text className="lbl" x={m.l} y={base + 20} style={{ fill: 'var(--hc-ink2)', fontSize: 11.5 }}>
        {w < 560 ? 'Tempo com robô rodando (mais forte = mais tempo)' : 'Quanto do tempo havia robô rodando, em cada hora (cor mais forte = mais tempo)'}
      </text>
      {hov.overlay}
    </svg>
  );
}

export function CapacityCard({ cap }: { cap: Capacity }) {
  const hs = cap.hours;
  const limit = cap.limit;
  const filt = '\n\nSegue o período; ignora o filtro de origem (manual/agendada).';
  const pico = pl(hs[cap.busiest].peak, 'robô', 'robôs');
  const q = cap.quiet;
  const rangesTxt = q.ranges.map(([a, b]) => `${a}h–${b % 24}h`);
  const joinPt = (a: string[]) => (a.length > 2 ? `${a.slice(0, -1).join(', ')} e ${a[a.length - 1]}` : a.join(' e '));
  const shown = `${joinPt(rangesTxt.slice(0, 3))}${rangesTxt.length > 3 ? '…' : ''}`;
  const table = () => ({
    head: ['Hora', 'Pico (robôs ao mesmo tempo)', '% do tempo ocupado', 'Dias em que chegou ao limite'],
    rows: hs.map((o, i) => [hourLabel(i), nf(o.peak), pctTxt(o.busyShare), nf(o.daysLimit)]),
    numFrom: 1,
  });
  return (
    <HcCard
      title="Horários de pico do servidor"
      info={`Quantos robôs rodavam ao mesmo tempo em cada hora do dia, somando todos os dias do período. Barra = pior momento daquela hora; a linha vermelha é o limite do servidor (${limit}). A faixa de baixo mostra quanto do tempo havia algum robô rodando (cor mais forte = mais tempo). Só robôs rodados pelo Hub; execuções interrompidas pelo reinício do Hub ficam de fora.${filt}`}
      legend={[
        { c: 'var(--s1)', l: 'Pico dentro do limite' },
        { c: 'var(--warn)', l: 'Quase no limite' },
        { c: 'var(--crit)', l: 'No limite do servidor' },
      ]}
      table={table}
      wide
    >
      {(w) =>
        cap.any ? (
          <>
            <div className="hc-capsum">
              <SummaryCard
                label="Horário mais cheio"
                value={hourLabel(cap.busiest)}
                info={`O horário do dia em que mais robôs rodaram ao mesmo tempo, somando todo o período.\n\nNo pior momento desse horário, ${pico} ao mesmo tempo (o limite do servidor é ${limit}). Se dois horários empatam no pico, vale o que ficou mais tempo ocupado.${filt}`}
              />
              <SummaryCard
                label="Chegaram ao limite"
                value={cap.atLimit.length ? pl(cap.atLimit.length, 'horário', 'horários') : 'Nenhum horário'}
                info={`${cap.atLimit.length ? `Horários em que o servidor chegou a ${limit} robôs ao mesmo tempo (o limite) em algum momento do período: ${cap.atLimit.map((i) => `${i}h`).join(', ')}.\n\nNesses momentos o servidor lotou e as execuções novas esperaram na fila.` : `Em nenhum horário o servidor chegou ao limite de ${limit} robôs ao mesmo tempo. O pico foi ${pico}.`}${filt}`}
              />
              <SummaryCard
                label="Mais tempo ocupado"
                value={hourLabel(cap.mostBusy)}
                info={`O horário do dia em que mais havia robô rodando, olhando minuto a minuto durante o período.\n\nNesse horário, havia pelo menos um robô rodando em ${pctTxt(hs[cap.mostBusy].busyShare)} do tempo.${filt}`}
              />
              <SummaryCard
                label={q.hours.length > 1 ? 'Bons horários para agendar' : 'Bom horário para agendar'}
                value={shown}
                info={`Considera as 24 horas do dia, porque o agendamento roda sozinho no Hub, sem depender de ninguém acordado.\n\nSão os horários mais vazios do período: ${q.hours.length > 1 ? `vários empatam, então aparecem todos (${joinPt(rangesTxt)}). ` : `${rangesTxt[0]}. `}${hs[q.best].peak ? `Neles o pico foi de ${pl(hs[q.best].peak, 'robô', 'robôs')} ao mesmo tempo e havia robô rodando em ${pctTxt(hs[q.best].busyShare)} do tempo.` : `Nenhum robô rodou ${q.hours.length > 1 ? 'nesses horários' : 'nesse horário'} neste período.`}\n\nMuda conforme o período escolhido.`}
              />
            </div>
            <CapacityPlot cap={cap} w={w} />
          </>
        ) : (
          <p className="hc-empty">Nenhum robô rodado pelo Hub neste período.</p>
        )
      }
    </HcCard>
  );
}

// ---------- Resultado dos ciclos agendados ----------

const PARTS = [
  { key: 'ok', color: 'var(--s1)', text: () => 'ok de primeira' },
  { key: 'recovered', color: 'var(--warn)', text: () => 'recuperados pelo reinício' },
  { key: 'failed', color: 'var(--crit)', text: (c: CycleRow) => (c.hasRestart ? 'falharam de vez (também no reinício)' : 'terminaram em erro (sem reinício configurado)') },
  { key: 'canceled', color: 'var(--cancel)', text: () => 'cancelados ou pulados' },
] as const;

export function CyclesCard({ cycles }: { cycles: CycleRow[] }) {
  const rows = cycles.filter((c) => c.ok + c.recovered + c.failed + c.canceled > 0);
  const table = () => ({
    head: ['Agendamento', 'Robô', 'Ciclos', 'Ok de primeira', 'Salvos pelo reinício', 'Falharam', 'Cancelados ou pulados', 'Reinício automático'],
    rows: rows.map((c) => {
      const tot = c.ok + c.recovered + c.failed + c.canceled;
      return [c.name, c.robotName, nf(tot), nf(c.ok), nf(c.recovered), nf(c.failed), nf(c.canceled), c.hasRestart ? 'sim' : 'não'];
    }),
    numFrom: 2,
  });
  return (
    <HcCard
      title="Resultado dos ciclos agendados"
      info={'Ciclo = a execução do horário mais o reinício, se houve. "Ok de primeira" = deu certo na 1ª tentativa; "recuperado" = falhou e o reinício automático (T0/T1/T2) deu certo; "falhou de vez" = terminou em erro e, se há reinício, ele também falhou. Canceladas à mão, pelo teto de tempo ou puladas (o agendamento de que dependem falhou) não são falha do robô. Ciclos ainda em andamento não entram. O reinício automático só existe desde 14–16/11/2026.\n\nSegue o período; ignora o filtro de origem.'}
      legend={PARTS.map((p) => ({ c: p.color, l: p.key === 'ok' ? 'Ok de primeira' : p.key === 'recovered' ? 'Recuperado pelo reinício' : p.key === 'failed' ? 'Falhou de vez' : 'Cancelado ou pulado' }))}
      table={table}
      wide
    >
      {() =>
        rows.length ? (
          <div className="hc-sched">
            {rows.map((c) => {
              const tot = c.ok + c.recovered + c.failed + c.canceled;
              return (
                <div key={c.taskId} className="hc-sched-row">
                  <div className="nm">
                    <b>{c.name}</b>
                    <span>{c.robotName}</span>
                  </div>
                  <div
                    className="sbar"
                    role="img"
                    aria-label={`${c.name}: ${c.ok} ok de primeira, ${c.recovered} recuperados, ${c.failed} falharam, ${c.canceled} cancelados ou pulados`}
                  >
                    {PARTS.map((p) =>
                      c[p.key] ? (
                        <i
                          key={p.key}
                          style={{ width: `${(c[p.key] / tot) * 100}%`, background: p.color }}
                          onPointerMove={(ev) => tip.show(ev.clientX, ev.clientY, { title: c.name, rows: [{ c: p.color, v: nf(c[p.key]), l: p.text(c) }], note: `${pct(c[p.key] / tot)} de ${pl(tot, 'ciclo', 'ciclos')}` })}
                          onPointerLeave={tip.hide}
                        />
                      ) : null,
                    )}
                  </div>
                  <div className="ct">
                    {pl(tot, 'ciclo', 'ciclos')} · {pct(c.ok / tot)} ok de primeira
                    {c.recovered ? ` · ${c.recovered === 1 ? '1 salvo' : `${c.recovered} salvos`} pelo reinício` : ''}
                    {c.failed ? ` · ${c.failed === 1 ? '1 falhou' : `${c.failed} falharam`}` : ''}
                    {c.canceled ? ` · ${pl(c.canceled, 'cancelado ou pulado', 'cancelados ou pulados')}` : ''}
                    {c.hasRestart ? '' : ' · sem reinício automático'}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="hc-empty">Nenhum ciclo agendado concluído no período.</p>
        )
      }
    </HcCard>
  );
}
