import { useMemo, useState, type PointerEvent } from 'react';
import {
  CATEGORY_COLOR,
  CATEGORY_ORDER,
  SITUATION_BADGE,
  SITUATION_HINTS,
  SITUATION_ICON,
  SITUATION_LABELS,
  SITUATION_ORDER,
  deltaOf as deltaOfLocal,
  fmtDateTime,
  fmtDayYear,
  mins,
  nf,
  pct,
  pl,
  relDay,
  type CategoryInfo,
  type CauseRow,
  type Delta,
  type MiniBucket,
  type RobotRow,
  type Totals,
} from '../../lib/robot-health';
import { HcCard, HcInfo, Spark, tip } from './kit';

// ---------- indicadores (cartões centralizados, com minigráfico) ----------

type TileProps = {
  label: string;
  value: string;
  sub: string;
  delta: Delta;
  vals: Array<number | null>;
  color: string;
  lo?: number;
  hi?: number;
  info: string;
};

function Tile({ label, value, sub, delta: d, vals, color, lo, hi, info }: TileProps) {
  return (
    <div className="hc-tile" style={{ ['--tc' as string]: color }}>
      <div className="l">{label}</div>
      <HcInfo label={`Sobre ${label}`} text={info} />
      <div className="v">{value}</div>
      <div className="s">{sub}</div>
      <div className={`d ${d.cls}`}>
        {d.icon ? <span aria-hidden="true">{d.icon}</span> : null}
        {d.text}
      </div>
      <Spark vals={vals} w={150} h={30} color={color} lo={lo} hi={hi} />
    </div>
  );
}

function tileInfo(name: string, desc: string, d: Delta, fmt: (v: number) => string, period: { from: string; to: string; days: number }, previous: { from: string; to: string } | null, miniUnit: string) {
  const line = (v: number | null) => (v === null ? 'sem dados' : fmt(v));
  const parts = [
    desc,
    `PERÍODO ATUAL: ${fmtDayYear(period.from)} a ${fmtDayYear(period.to)} (${pl(period.days, 'dia', 'dias')})\n${name} no período atual: ${line(d.cur)}`,
    previous
      ? `PERÍODO COMPARADO: ${fmtDayYear(previous.from)} a ${fmtDayYear(previous.to)} (${pl(period.days, 'dia', 'dias')}, logo antes do atual)\n${name} no período comparado: ${line(d.prev)}`
      : 'PERÍODO COMPARADO: não há (todo o histórico).',
    d.text === 'sem comparação'
      ? 'VARIAÇÃO: sem comparação possível.'
      : `VARIAÇÃO: ${d.icon ? `${d.icon} ` : ''}${d.text} (de ${line(d.prev)} para ${line(d.cur)}), ${d.cls === 'flat' ? 'estável' : d.cls === 'good' ? 'mudança boa' : 'mudança ruim'}.\nVerde = mudança boa, vermelho = ruim. Menos de ${d.kind === 'pp' ? '0,5 p.p.' : '1%'} conta como estável.`,
    `MINIGRÁFICO: um ponto por ${miniUnit} (escolhido pelo tamanho do período: por dia até 2 semanas, por semana até 3 meses, por mês acima disso). Trecho tracejado = ${miniUnit} sem dados para este número.\n\nVale para os filtros atuais.`,
  ];
  return parts.join('\n\n');
}

export function Tiles({
  current,
  previous,
  mini,
  period,
  previousPeriod,
}: {
  current: Totals;
  previous: Totals | null;
  mini: { granularity: 'day' | 'week' | 'month'; buckets: MiniBucket[] };
  period: { from: string; to: string; days: number };
  previousPeriod: { from: string; to: string } | null;
  deltaOf?: never;
}) {
  const unit = mini.granularity === 'day' ? 'dia' : mini.granularity === 'week' ? 'semana' : 'mês';
  const b = previous;
  const semShare = current.errorsAll ? current.semErrors / current.errorsAll : null;
  const prevSem = b && b.errorsAll ? b.semErrors / b.errorsAll : null;
  const D = (cur: number | null, prev: number | null, kind: 'pp' | 'rel', upGood: boolean) => deltaOfLocal(cur, prev, kind, upGood);
  const items: TileProps[] = [
    {
      label: 'Execuções',
      value: nf(current.executions),
      sub: `${pl(current.concluded + current.hubErrors, 'concluída', 'concluídas')} e ${pl(current.canceled, 'cancelada', 'canceladas')}`,
      delta: D(current.executions, b?.executions ?? null, 'rel', true),
      vals: mini.buckets.map((x) => x.executionsPerDay),
      color: 'var(--s1)',
      info: '',
    },
    {
      label: 'Taxa de sucesso',
      value: pct(current.successRate),
      sub: `${pl(current.success, 'sucesso', 'sucessos')}, ${pl(current.errors, 'erro', 'erros')}${current.hubErrors ? ` (+${nf(current.hubErrors)} do Hub)` : ''}`,
      delta: D(current.successRate, b?.successRate ?? null, 'pp', true),
      vals: mini.buckets.map((x) => x.successRate),
      color: 'var(--s3)',
      lo: 0,
      hi: 1,
      info: '',
    },
    {
      label: 'Duração típica',
      value: mins(current.medianDurationSeconds),
      sub: current.p95DurationSeconds !== null ? `95% terminam em até ${mins(current.p95DurationSeconds)}` : '',
      delta: D(current.medianDurationSeconds, b?.medianDurationSeconds ?? null, 'rel', false),
      vals: mini.buckets.map((x) => x.medianDurationSeconds),
      color: 'var(--s4)',
      info: '',
    },
    {
      label: 'Erros sem causa',
      value: pct(semShare),
      sub: `${nf(current.semErrors)} de ${pl(current.errorsAll, 'erro', 'erros')}`,
      delta: D(semShare, prevSem, 'pp', false),
      vals: mini.buckets.map((x) => x.semShare),
      color: 'var(--nocause)',
      lo: 0,
      hi: 1,
      info: '',
    },
  ];
  const descs = [
    ['Execuções', 'Execuções terminadas no período, com sucesso, erro ou canceladas. As que ainda estão na fila ou rodando não entram. Os robôs externos (que só avisam que rodaram) ficam de fora desta tela. Mais execuções = mais uso, por isso subir é bom (verde).', (v: number) => nf(v)],
    ['Taxa de sucesso', 'Sucessos ÷ (sucessos + erros dos robôs). Canceladas, execuções em andamento e erros causados pelo reinício do Hub ficam de fora (não são culpa do robô). A variação é em pontos percentuais (p.p.): de 78% para 68% são 10 p.p. a menos.', (v: number) => pct(v)],
    ['Duração típica', 'Mediana do tempo de execução (do início ao fim), só das execuções com sucesso dos robôs rodados pelo Hub: metade termina em menos que isso.', (v: number) => mins(v)],
    ['Erros sem causa', 'Parte dos erros em que o robô não informou o motivo (só terminou com código de saída). A variação é em pontos percentuais (p.p.).', (v: number) => pct(v)],
  ] as const;
  return (
    <div className="hc-tiles">
      {items.map((t, i) => (
        <Tile key={t.label} {...t} info={tileInfo(descs[i][0], descs[i][1], t.delta, descs[i][2], period, previousPeriod, unit)} />
      ))}
    </div>
  );
}

// ---------- causas de erro (Pareto) ----------

export function ParetoCard({ causes, info }: { causes: CauseRow[]; info: CategoryInfo[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const total = causes.reduce((a, c) => a + c.count, 0);
  const max = Math.max(1, ...causes.map((c) => c.count));
  const catName = (k: CauseRow['category']) => info.find((i) => i.key === k)?.label ?? k;
  let acc = 0;
  return (
    <HcCard
      title="Causas de erro, todas"
      wide
      info="Todas as causas encontradas, da mais para a menos frequente, com a categoria em cores. Clique numa causa para ver o que ela significa e quais robôs a tiveram. O acumulado mostra quantas causas explicam a maior parte. Cada erro é lido pela mensagem que o robô (ou o Hub) deixou e colocado numa causa conhecida; 'Sem causa' é quando o robô falhou sem escrever o motivo."
      legend={CATEGORY_ORDER.map((k) => ({ c: CATEGORY_COLOR[k], l: catName(k) }))}
      table={() => ({
        head: ['Causa', 'Categoria', 'Erros', '% do total', 'Robôs', 'Último erro'],
        rows: causes.map((c) => [c.cause, catName(c.category), nf(c.count), pct(c.count / total), nf(c.robots), fmtDateTime(c.lastAt)]),
        numFrom: 2,
      })}
    >
      {() =>
        !total ? (
          <div className="hc-empty">Nenhum erro neste filtro.</div>
        ) : (
          <div className="hc-pareto">
            <div className="h">Causa (clique para detalhar)</div>
            <div className="h" />
            <div className="h n">Erros</div>
            <div className="h n">Acumulado</div>
            {causes.map((c) => {
              acc += c.count;
              const color = CATEGORY_COLOR[c.category];
              const isOpen = open.has(c.cause);
              const toggle = () => setOpen((cur) => { const next = new Set(cur); if (next.has(c.cause)) next.delete(c.cause); else next.add(c.cause); return next; });
              const onMove = (ev: PointerEvent) => tip.show(ev.clientX, ev.clientY, { title: c.cause, rows: [{ c: color, v: nf(c.count), l: `${c.count === 1 ? 'erro' : 'erros'} (${pct(c.count / total)} do total) · ${nf(c.robots)} ${c.robots === 1 ? 'robô' : 'robôs'}` }], note: `Categoria: ${catName(c.category)}` });
              return (
                <div key={c.cause} style={{ display: 'contents' }}>
                  <div className="lab" onPointerMove={onMove} onPointerLeave={tip.hide}>
                    <button type="button" aria-expanded={isOpen} onClick={toggle}>
                      <span className="car" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                      <span className="hc-key" style={{ background: color }} />
                      <span className="t" title={c.cause}>{c.cause}</span>
                    </button>
                  </div>
                  <div className="tr" onPointerMove={onMove} onPointerLeave={tip.hide}>
                    <div className="fill" style={{ width: `${Math.max(0.5, (c.count / max) * 100)}%`, background: `linear-gradient(90deg, ${color}, color-mix(in srgb, ${color} 70%, #fff))` }} />
                  </div>
                  <div className="n">{nf(c.count)}</div>
                  <div className="acc">{pct(acc / total)}</div>
                  {isOpen ? (
                    <div className="hc-pdet">
                      <div>{c.description || 'Sem descrição.'}</div>
                      <div className="rb">
                        <span style={{ color: 'var(--hc-muted)' }}>Robô</span>
                        <span style={{ color: 'var(--hc-muted)' }}>Erros</span>
                        <span style={{ color: 'var(--hc-muted)' }}>Último</span>
                        {c.robotList.flatMap((r) => [<span key={`${r.robotId}-n`}>{r.name}</span>, <span key={`${r.robotId}-c`}>{nf(r.count)}</span>, <span key={`${r.robotId}-l`}>{fmtDateTime(r.lastAt)}</span>])}
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )
      }
    </HcCard>
  );
}

// ---------- tabela de robôs ----------

type SortKey = 'name' | 'sit' | 'rate' | 'n' | 'err' | 'last' | 'med' | 'top';

export function RobotsTableCard({ robots }: { robots: RobotRow[] }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'sit', dir: -1 });
  const [all, setAll] = useState(false);
  const rows = useMemo(() => {
    const get = (r: RobotRow): number | string => {
      switch (sort.key) {
        case 'name': return r.name.toLowerCase();
        case 'rate': return r.successRate ?? -1;
        case 'n': return r.executions;
        case 'err': return r.errors;
        case 'last': return r.lastSuccessAt ?? '';
        case 'med': return r.medianDurationSeconds ?? -1;
        case 'top': return r.mainCause?.count ?? -1;
        default: return SITUATION_ORDER[r.situation] * 1000 + (r.errorRate ?? 0) * 100;
      }
    };
    return [...robots].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir || b.executions - a.executions;
    });
  }, [robots, sort]);
  const shown = all ? rows : rows.slice(0, 15);
  const cols: Array<{ k: SortKey; t: string; num?: boolean }> = [
    { k: 'name', t: 'Robô' }, { k: 'sit', t: 'Situação' }, { k: 'rate', t: 'Sucesso', num: true },
    { k: 'n', t: 'Exec.', num: true }, { k: 'err', t: 'Erros', num: true }, { k: 'last', t: 'Última com sucesso', num: true }, { k: 'med', t: 'Duração típica', num: true }, { k: 'top', t: 'Causa de erro mais comum' },
  ];
  const click = (k: SortKey) => setSort((s) => (s.key === k ? { key: k, dir: (s.dir * -1) as 1 | -1 } : { key: k, dir: k === 'name' ? 1 : -1 }));
  return (
    <HcCard
      title="Todos os robôs"
      wide
      info={`Clique no título de uma coluna para ordenar. Esta tabela traz os mesmos números dos gráficos.\n\nSituação pelo % de erro entre as execuções concluídas (sucessos + erros dos robôs): Crítico = 40% ou mais; Atenção = de 15% a menos de 40%; Saudável = menos de 15%; Poucos dados = menos de 5 concluídas. Erros do Hub (reinício do servidor) e canceladas não entram na conta.`}
    >
      {() =>
        rows.length === 0 ? (
          <div className="hc-empty">Nenhum robô rodou no período.</div>
        ) : (
          <>
            <div className="hc-tw">
              <table className="hc-table">
                <thead>
                  <tr>
                    {cols.slice(0, 2).map((c) => <Th key={c.k} c={c} sort={sort} onClick={click} />)}
                    <th>Tendência</th>
                    {cols.slice(2).map((c) => <Th key={c.k} c={c} sort={sort} onClick={click} />)}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.robotId}>
                      <td style={{ minWidth: 190 }}>
                        <div style={{ fontWeight: 600 }}>{r.name}{!r.active ? <span style={{ color: 'var(--hc-muted)', fontWeight: 400 }}> · inativo</span> : null}</div>
                        <div style={{ color: 'var(--hc-muted)', fontSize: 11.5 }}>{r.slug}</div>
                      </td>
                      <td>
                        <span className={`hc-badge ${SITUATION_BADGE[r.situation]}`} title={SITUATION_HINTS[r.situation]}>
                          <span aria-hidden="true">{SITUATION_ICON[r.situation]}</span>
                          {SITUATION_LABELS[r.situation]}
                        </span>
                      </td>
                      <td>{r.concluded ? <Spark vals={r.trend} w={100} h={24} lo={0} hi={1} /> : <span className="ax">—</span>}</td>
                      <td className="num">{pct(r.successRate)}</td>
                      <td className="num">{nf(r.executions)}</td>
                      <td className="num" title={r.hubErrors ? pl(r.hubErrors, 'erro do reinício do Hub fora da conta', 'erros do reinício do Hub fora da conta') : undefined}>
                        {nf(r.errors)}{r.hubErrors ? ` (+${nf(r.hubErrors)} Hub)` : ''}
                      </td>
                      <td className="num">{relDay(r.lastSuccessAt)}</td>
                      <td className="num">{mins(r.medianDurationSeconds)}</td>
                      <td className="cz" title={r.mainCause ? `${r.mainCause.count} de ${pl(r.errors, 'erro', 'erros')}: ${r.mainCause.cause}` : ''}>{r.mainCause ? `${r.mainCause.count}× ${r.mainCause.cause}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > 15 ? (
              <div className="hc-more">
                <button type="button" onClick={() => setAll((v) => !v)}>{all ? 'Mostrar só os 15 primeiros' : `Mostrar todos os ${rows.length} robôs`}</button>
              </div>
            ) : null}
          </>
        )
      }
    </HcCard>
  );
}

function Th({ c, sort, onClick }: { c: { k: SortKey; t: string; num?: boolean }; sort: { key: SortKey; dir: 1 | -1 }; onClick: (k: SortKey) => void }) {
  return (
    <th className={c.num ? 'num' : ''} aria-sort={c.k === sort.key ? (sort.dir < 0 ? 'descending' : 'ascending') : 'none'}>
      <button type="button" onClick={() => onClick(c.k)}>{c.t + (c.k === sort.key ? (sort.dir < 0 ? ' ↓' : ' ↑') : '')}</button>
    </th>
  );
}
