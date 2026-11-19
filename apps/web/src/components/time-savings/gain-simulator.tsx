import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api } from '../../lib/api';
import {
  MAX_SECONDS,
  UNIT_AB,
  UNIT_NAME,
  UNIT_SECONDS,
  convertUnit,
  dur,
  hrs,
  jornadaTxt,
  nf,
  nfx,
  parseNum,
  peopleNum,
  peopleTxt,
  peopleWord,
  perUnitTxt,
  pl,
  signed,
  signedDur,
  type SimPreview,
  type SimRow,
  type SimUnit,
  type SimulationResult,
} from '../../lib/gain-simulator';
import { DEFAULT_METRIC_KEY, type RobotWithoutGain } from '../../lib/robots-without-gain';
import { GainMonthlyChart } from './gain-monthly-chart';
import { SgInfo, SgSeg } from './sg-parts';

type HubRobot = { id: string; name: string; manualSecondsPerUnit: number; unitLabel?: string | null };

/** Um cenário guardado (só nesta tela, enquanto ela estiver aberta). */
type Scenario = { letter: string; name: string; desc: string; per: string; mais: number; lo: number; hi: number; tot: number; jh: number };
const LETTERS = ['A', 'B', 'C', 'D'];

/** Campo numérico do protótipo: lê vírgula decimal e mostra o erro logo abaixo, em vermelho. */
function NumField({ value, onChange, max, width, placeholder, label }: { value: string; onChange: (v: string) => void; max: number; width: number; placeholder?: string; label: string }) {
  const parsed = parseNum(value, max);
  const error = 'error' in parsed ? parsed.error : null;
  return (
    <div className="fwrap">
      <input className={`inp${error ? ' bad' : ''}`} style={{ width }} inputMode="decimal" value={value} placeholder={placeholder} aria-label={label} aria-invalid={!!error} onChange={(e) => onChange(e.target.value)} />
      {error ? <div className="fe" role="alert">{error}</div> : null}
    </div>
  );
}

function Frow({ label, info, children }: { label: string; info?: ReactNode; children: ReactNode }) {
  return (
    <div className="frow">
      <span className="fl">
        {label}
        {info ? <SgInfo label={`Sobre: ${label}`}>{info}</SgInfo> : null}
      </span>
      {children}
    </div>
  );
}

function Kpi({ title, value, small, sub }: { title: string; value: string; small?: string; sub?: string }) {
  return (
    <div className="kpi">
      <div className="t">{title}</div>
      <div className="v">
        {value}
        {small ? <small>{small}</small> : null}
      </div>
      {sub ? <div className="s">{sub}</div> : null}
    </div>
  );
}

export function GainSimulator({
  from,
  to,
  hubRobots,
  withoutGain,
  isAdmin,
  notify,
  onApplied,
}: {
  from: string;
  to: string;
  hubRobots: HubRobot[];
  /** Robôs sem ganho (da lista da aba): servem para sugerir o rótulo e a métrica ao aplicar os tempos. */
  withoutGain: RobotWithoutGain[];
  isAdmin: boolean;
  notify: (message: string) => void;
  onApplied: () => void;
}) {
  const [scope, setScope] = useState<'sem' | 'todos'>('sem');
  const [mode, setMode] = useState<'igual' | 'robo'>('igual');
  const [base, setBase] = useState<'exec' | 'item'>('exec');
  const [unit, setUnit] = useState<SimUnit>('minutes');
  const [equal, setEqual] = useState('5');
  const [perRobot, setPerRobot] = useState<Record<string, string>>({});
  const [newTimes, setNewTimes] = useState(false);
  const [perCurrent, setPerCurrent] = useState<Record<string, string>>({});
  const [workday, setWorkday] = useState('7');
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<SimPreview | null>(null);
  const [result, setResult] = useState<{ data: SimulationResult; desc: string; per: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState(false);
  // "Igual para todos": a lista de robôs começa recolhida (dá para abrir para ver e tirar algum da conta)
  const [expanded, setExpanded] = useState(false);
  const resultRef = useRef<HTMLDivElement>(null);

  const without = useMemo(() => hubRobots.filter((r) => !r.manualSecondsPerUnit), [hubRobots]);
  const unitSec = UNIT_SECONDS[unit];
  const maxInUnit = MAX_SECONDS / unitSec;

  // linhas por robô para a tabela do formulário (execuções por mês, ganho de hoje, métrica que o robô informa)
  useEffect(() => {
    let alive = true;
    const t = window.setTimeout(() => {
      api<SimPreview>('/reports/robots-without-gain/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: from || undefined, to: to || undefined, scope, base, times: {}, light: true }),
      })
        .then((data) => alive && setPreview(data))
        .catch(() => alive && setPreview(null));
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [from, to, scope, base]);

  const robotsById = useMemo(() => new Map(hubRobots.map((r) => [r.id, r])), [hubRobots]);
  const rows: SimRow[] = useMemo(() => (preview ? [...preview.rows].sort((a, b) => (a.hasTime ? 1 : 0) - (b.hasTime ? 1 : 0) || a.name.localeCompare(b.name, 'pt-BR')) : []), [preview]);

  // tempos válidos em segundos; campo preenchido e inválido bloqueia o "Simular"
  const errors: string[] = [];
  const secondsOf = (raw: string): number | null => {
    const p = parseNum(raw, maxInUnit);
    if ('error' in p) {
      errors.push(p.error);
      return null;
    }
    return p.empty ? null : Math.round(p.value * unitSec);
  };
  const equalSeconds = secondsOf(equal);
  const times: Record<string, number> = {};
  const defaultIds: string[] = [];
  for (const row of rows) {
    if (excluded.has(row.robotId)) continue;
    if (row.hasTime) {
      if (scope === 'todos' && newTimes) {
        const s = secondsOf(perCurrent[row.robotId] ?? '');
        if (s) times[row.robotId] = s;
      }
    } else if (mode === 'robo') {
      const own = secondsOf(perRobot[row.robotId] ?? '');
      if (own) times[row.robotId] = own;
      else if (equalSeconds) {
        times[row.robotId] = equalSeconds;
        defaultIds.push(row.robotId);
      }
    } else if (equalSeconds) times[row.robotId] = equalSeconds;
  }
  const workdayParsed = parseNum(workday, 24);
  if ('error' in workdayParsed) errors.push(workdayParsed.error);
  const workdayHours = 'error' in workdayParsed || workdayParsed.empty ? 7 : workdayParsed.value;

  const request = { from: from || undefined, to: to || undefined, scope, base, times, excluded: [...excluded].sort(), workdayHours, unit, defaultIds };
  const key = JSON.stringify(request);
  const stale = result !== null && result.key !== key;
  const canRun = errors.length === 0 && !busy;

  function describe(): string {
    const u = UNIT_AB[unit];
    const per = base === 'exec' ? 'por execução' : 'por item';
    let how: string;
    if (mode === 'igual') how = `${equalSeconds ? `${nfx(equalSeconds / unitSec)} ${u}` : 'sem tempo'} ${per} para todos`;
    else {
      const informed = rows.filter((r) => !r.hasTime && !excluded.has(r.robotId) && (perRobot[r.robotId] ?? '').trim()).length;
      how = `tempo por robô ${per} (${pl(informed, 'informado', 'informados')}${equalSeconds ? `, padrão ${nfx(equalSeconds / unitSec)} ${u}` : ''})`;
    }
    if (scope === 'sem') return `${how} · só os sem ganho`;
    const news = rows.filter((r) => r.hasTime && !excluded.has(r.robotId) && newTimes && (perCurrent[r.robotId] ?? '').trim()).length;
    return `${how} · ${news ? `somando os que já têm ganho, com novos tempos em ${pl(news, 'robô', 'robôs')}` : 'somando os que já têm ganho (tempos atuais)'}`;
  }

  async function run() {
    if (!canRun) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api<SimulationResult>('/reports/robots-without-gain/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      setResult({ data, desc: describe(), per: `execuções reais de ${pl(data.days, 'dia', 'dias')}`, key });
      setConfirming(false);
      window.setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível simular.');
    } finally {
      setBusy(false);
    }
  }

  function changeUnit(next: SimUnit) {
    const conv = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, convertUnit(v, unit, next)]));
    setEqual(convertUnit(equal, unit, next));
    setPerRobot(conv(perRobot));
    setPerCurrent(conv(perCurrent));
    setUnit(next);
  }

  const letter = LETTERS.find((l) => !scenarios.some((s) => s.letter === l));
  const m = result?.data;
  const applicable = m && !stale ? m.rows.filter((r) => (r.source === 'informado' && !r.hasTime) || r.source === 'novo') : [];

  function saveScenario() {
    if (!result || !m || stale || !letter) return;
    setScenarios((prev) =>
      [...prev, { letter, name: `Cenário ${letter}`, desc: result.desc, per: result.per, mais: m.extraMonth, lo: m.band.low.extraMonth, hi: m.band.high.extraMonth, tot: m.reportMonth + m.extraMonth, jh: m.workdayHours }].sort((a, b) =>
        a.letter.localeCompare(b.letter),
      ),
    );
    notify('Cenário guardado. Mude os tempos e simule de novo para comparar.');
  }

  async function apply() {
    if (!m) return;
    setApplying(true);
    let ok = 0;
    const failed: string[] = [];
    for (const row of applicable) {
      const seconds = times[row.robotId];
      if (!seconds) continue;
      const info = withoutGain.find((r) => r.robotId === row.robotId);
      const hub = robotsById.get(row.robotId);
      const novo = row.source === 'novo';
      try {
        await api(`/robots/${row.robotId}/time-savings`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            manualSecondsPerUnit: seconds,
            unitLabel: novo ? hub?.unitLabel || 'item' : base === 'exec' ? 'execução' : info?.unitLabel && info.unitLabel !== 'item' ? info.unitLabel : 'item',
            unitMetricKey: novo ? info?.unitMetricKey ?? DEFAULT_METRIC_KEY : base === 'exec' ? DEFAULT_METRIC_KEY : info?.metrics[0]?.key ?? DEFAULT_METRIC_KEY,
          }),
        });
        ok += 1;
      } catch {
        failed.push(row.name);
      }
    }
    setApplying(false);
    setConfirming(false);
    notify(failed.length ? `${ok} salvos; falhou em: ${failed.join(', ')}.` : `Tempos salvos em ${pl(ok, 'robô', 'robôs')}. Valem para as próximas execuções.`);
    setResult(null);
    onApplied();
  }

  const showEditable = mode === 'robo' || (scope === 'todos' && newTimes);
  // com campos de tempo por robô a lista precisa estar à vista; no "igual para todos" ela pode ficar recolhida
  const listOpen = showEditable || expanded;
  const includedCount = rows.filter((r) => !excluded.has(r.robotId)).length;
  const modeHeader = showEditable ? 'Tempo estimado' : 'Tempo usado';

  return (
    <div>
      {/* ---------------- formulário ---------------- */}
      <div className="card">
        <h3>
          Simular ganhos
          <SgInfo label="Sobre: Simular ganhos">
            <p>Para conversar sobre "e se": coloque tempos estimados de cabeça e veja quanto o tempo ganho subiria.</p>
            <p>A conta usa as execuções reais do período escolhido no filtro lá em cima, levadas para um mês e um ano (cada robô pelos dias em que ele rodou no período).</p>
            <p>Nada é salvo e o relatório não muda.</p>
          </SgInfo>
        </h3>
        <p className="sub">Coloque tempos estimados, ajuste o que quiser e clique em Simular. Nada é salvo.</p>

        <Frow label="Quais robôs">
          <SgSeg label="Quais robôs" value={scope} onChange={setScope} items={[['sem', `Só os sem ganho (${without.length})`], ['todos', `Somar com os que já têm ganho (${hubRobots.length})`]]} />
        </Frow>
        {scope === 'todos' ? (
          <Frow
            label="Robôs que já têm ganho"
            info={
              <>
                <p>Usar os tempos atuais: o simulador soma o que esses robôs já ganham, com o tempo cadastrado.</p>
                <p>Simular novos tempos: dá para testar outro tempo por item em cada um (mesmo item e mesma métrica de hoje). O resultado mostra a diferença, para mais ou para menos.</p>
              </>
            }
          >
            <SgSeg label="Robôs que já têm ganho" value={newTimes ? 'novos' : 'manter'} onChange={(v) => setNewTimes(v === 'novos')} items={[['manter', 'Usar os tempos atuais'], ['novos', 'Simular novos tempos']]} />
            {newTimes ? <span className="ro">preencha na tabela; em branco = mantém o atual</span> : null}
          </Frow>
        ) : null}
        <Frow label="Como informar o tempo">
          <SgSeg label="Como informar o tempo" value={mode} onChange={setMode} items={[['igual', 'Igual para todos'], ['robo', 'Por robô']]} />
        </Frow>
        <Frow
          label="O tempo é"
          info={
            <>
              <p>Por execução: quanto tempo uma pessoa levaria para fazer à mão o que o robô faz numa rodada. É o mais fácil de estimar de cabeça.</p>
              <p>Por item: tempo de 1 nota, 1 empresa, 1 e-mail… multiplicado pelos itens que o robô informa (ou 1 por execução, se ele não informa). Execuções antigas, cujo log já foi apagado, usam a média de itens do robô. Cuidado com robôs que fazem centenas de itens por rodada.</p>
              <p>Trocar a unidade converte os números já digitados.</p>
            </>
          }
        >
          <SgSeg label="Base do tempo" value={base} onChange={setBase} items={[['exec', 'por execução'], ['item', 'por item']]} />
          <span className="ro">em</span>
          <select className="inp" aria-label="Unidade de tempo" value={unit} onChange={(e) => changeUnit(e.target.value as SimUnit)}>
            <option value="seconds">segundos</option>
            <option value="minutes">minutos</option>
            <option value="hours">horas</option>
          </select>
        </Frow>
        <Frow
          label="Jornada da pessoa"
          info={
            <>
              <p>Usada para converter horas em "pessoas": horas por mês ÷ (horas por dia × 21 dias úteis).</p>
              <p>Ex.: com 8 h por dia, 168 h por mês = 1 pessoa. Com 6 h por dia, 126 h por mês = 1 pessoa. Vazio = 7 h.</p>
            </>
          }
        >
          <NumField value={workday} onChange={setWorkday} max={24} width={80} label="Horas por dia da pessoa" />
          <span className="ro">h por dia × 21 dias úteis no mês (padrão 7 h; de 1 a 24)</span>
        </Frow>
        <Frow label={mode === 'igual' ? 'Tempo para todos' : 'Tempo padrão'}>
          <NumField value={equal} onChange={setEqual} max={maxInUnit} width={100} label={mode === 'igual' ? 'Tempo para todos' : 'Tempo padrão'} />
          <span className="ro">
            {UNIT_NAME[unit]} {base === 'exec' ? 'por execução' : 'por item'}
          </span>
          {mode === 'robo' ? <span className="ro">· vale para quem ficar em branco</span> : null}
        </Frow>

        {/* ---------------- tabela de robôs ---------------- */}
        {rows.length === 0 && preview ? (
          <div className="empty">Todos os robôs ativos do Hub já têm tempo manual. Escolha "Somar com os que já têm ganho" para simular novos tempos para eles.</div>
        ) : null}
        {rows.length > 0 && !showEditable ? (
          <div className="listbar" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 14px', margin: '4px 0 10px' }}>
            <span className="ro" style={{ whiteSpace: 'normal' }}>
              {pl(includedCount, 'robô incluído', 'robôs incluídos')} na simulação
              {excluded.size ? ` · ${pl(excluded.size, 'fora da conta', 'fora da conta')}` : ''}
            </span>
            <button type="button" className="btn" aria-expanded={expanded} aria-controls="sim-robots" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Recolher a lista de robôs' : `Ver os ${nf(rows.length)} robôs e tirar algum da conta`}
            </button>
          </div>
        ) : null}
        {rows.length > 0 && listOpen ? (
          <div className="tbl-wrap" id="sim-robots">
            <table className="sim stack">
              <thead>
                <tr>
                  <th />
                  <th>Robô</th>
                  <th className="n">Execuções por mês</th>
                  <th className="n">Ganho hoje por mês</th>
                  <th className="n">{modeHeader}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const hub = robotsById.get(r.robotId);
                  const seg = hub?.manualSecondsPerUnit ?? 0;
                  const label = hub?.unitLabel || 'item';
                  const sub: string[] = [];
                  if (r.hasTime) sub.push(`hoje: ${perUnitTxt(seg, label)}`);
                  if (base === 'item' && !r.hasTime) sub.push(r.metricKey ? `informa ${r.metricKey} (média ${nf(r.metricAvg ?? 0, (r.metricAvg ?? 0) < 10 ? 1 : 0)})` : 'não informa itens: 1 por execução');
                  const off = excluded.has(r.robotId);
                  let cell: ReactNode;
                  if (r.hasTime && scope === 'todos' && newTimes) {
                    const current = nfx(Math.round((seg / unitSec) * 100) / 100);
                    cell = (
                      <div className="tcell">
                        <NumField value={perCurrent[r.robotId] ?? ''} onChange={(v) => setPerCurrent((p) => ({ ...p, [r.robotId]: v }))} max={maxInUnit} width={110} placeholder={`atual: ${current}`} label={`Novo tempo de ${r.name} (hoje ${current} ${UNIT_AB[unit]} por ${label})`} />
                        <span className="ro un">
                          {UNIT_AB[unit]} por {label}
                        </span>
                      </div>
                    );
                  } else if (mode === 'robo' && !r.hasTime) {
                    cell = (
                      <div className="tcell">
                        <NumField value={perRobot[r.robotId] ?? ''} onChange={(v) => setPerRobot((p) => ({ ...p, [r.robotId]: v }))} max={maxInUnit} width={110} placeholder="padrão" label={`Tempo de ${r.name}`} />
                        <span className="ro un">
                          {UNIT_AB[unit]}
                          {base === 'exec' ? ' por execução' : ' por item'}
                        </span>
                      </div>
                    );
                  } else cell = <span className="ro">{r.hasTime ? 'tempo atual' : 'tempo para todos'}</span>;
                  return (
                    <tr key={r.robotId} className={off ? 'off' : ''}>
                      <td className="cbc">
                        <input
                          type="checkbox"
                          aria-label={`Incluir ${r.name}`}
                          checked={!off}
                          onChange={(e) =>
                            setExcluded((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.delete(r.robotId);
                              else next.add(r.robotId);
                              return next;
                            })
                          }
                        />
                      </td>
                      <td className="nomec">
                        <div style={{ fontWeight: 500 }}>{r.name}</div>
                        {sub.length ? <div className="ro">{sub.join(' · ')}</div> : null}
                      </td>
                      <td className="n" data-label="Execuções por mês">{nf(r.executionsMonth, r.executionsMonth < 10 ? 1 : 0)}</td>
                      <td className="n" data-label="Ganho hoje por mês">{r.currentMonth ? dur(r.currentMonth) : '0 h'}</td>
                      <td className="n" data-label="Tempo">{cell}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {error ? <div className="fe" role="alert">{error}</div> : null}
        <div className="simgo">
          <span className="note">
            Base: {preview ? `execuções reais de ${pl(preview.days, 'dia', 'dias')}` : 'execuções reais do período escolhido'}, levadas para 1 mês do calendário (um mês inteiro vale 1; um pedaço vale a fração dos dias dele).
            {errors.length ? (
              <span className="fe" style={{ display: 'block' }}>
                Corrija os campos marcados em vermelho para simular.
              </span>
            ) : null}
          </span>
          <button type="button" className="btn pri big" onClick={run} disabled={!canRun}>
            {busy ? 'Simulando...' : 'Simular'}
          </button>
        </div>
      </div>

      {/* ---------------- resultado ---------------- */}
      {result && m ? (
        <div ref={resultRef} className={stale ? 'stale' : ''} style={{ marginTop: 18, scrollMarginTop: 16 }}>
          {stale ? (
            <div className="stale-msg" role="status">
              Os valores mudaram: clique em Simular para atualizar o resultado.
            </div>
          ) : null}
          <div className="card">
            <h3>Resultado da simulação</h3>
            <p className="sub">
              {result.desc} · base: {result.per} · pessoa: {jornadaTxt(m.workdayHours)}
            </p>
            <div className="kpis" style={{ marginBottom: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '24px 28px' }}>
              <Kpi title="Ganho a mais por mês" value={signed(m.extraMonth, hrs)} small="h" sub="sobre o que estes robôs somam hoje" />
              <Kpi title="Ganho a mais por ano" value={signed(m.extraMonth * 12, (v) => nf(v / 3600))} small="h" sub="mês simulado × 12" />
              <Kpi
                title="Pessoas a mais"
                value={peopleNum(m.extraMonth, m.workdayHours)}
                small={peopleWord(m.extraMonth, m.workdayHours)}
                sub={m.rows.some((r) => r.source === 'novo') ? `robôs sem tempo: ${peopleTxt(m.fromWithout, m.workdayHours)} · novos tempos: ${m.fromNewTimes > 0 ? '+' : ''}${peopleTxt(m.fromNewTimes, m.workdayHours)}` : 'só o ganho a mais dos robôs sem tempo'}
              />
              <Kpi title="Pessoas no total" value={peopleNum(m.reportMonth + m.extraMonth, m.workdayHours)} small={peopleWord(m.reportMonth + m.extraMonth, m.workdayHours)} sub={`todo o tempo ganho com a simulação (hoje: ${peopleTxt(m.reportMonth, m.workdayHours)})`} />
            </div>
          </div>

          <div className="card">
            <h3>
              Evolução mensal com a simulação
              <SgInfo label="Sobre: Evolução mensal">
                <p>Barras: tempo ganho total de cada mês. Cinza = o que já está cadastrado. Azul = o extra que os tempos simulados dariam, aplicados às execuções reais daquele mês.</p>
                <p>"Todo o relatório" soma todos os robôs, como o relatório. "Só os simulados" mostra apenas os robôs da simulação, para o extra aparecer melhor quando o resto é muito maior.</p>
                <p>Linha: variação do total sobre o mês anterior. O primeiro mês começa em 0%. O gráfico começa no primeiro mês completo de dados (um mês que começou no meio daria uma variação falsa).</p>
                <p>O mês atual (*) ainda não terminou: a barra aparece mais clara e a linha até ele fica pontilhada; a variação dele é parcial (só os dias que já passaram). Verde = variação maior ou igual a 0; vermelho = menor que 0.</p>
              </SgInfo>
            </h3>
            <GainMonthlyChart months={m.monthly.months} cut={m.monthly.cut} />
          </div>

          <div className="two" style={{ marginTop: 18 }}>
            <div>
              <div className="card" style={{ margin: 0 }}>
                <ReportBars m={m} />
              </div>
              <div className="card" style={{ marginTop: 18 }}>
                <RankingBars rows={m.rows} />
              </div>
            </div>
            <div className="card" style={{ margin: 0, alignSelf: 'start' }}>
              <h3>Insights</h3>
              {m.insights.length ? (
                <ul className="insl">
                  {m.insights.map((i, idx) => (
                    <li key={idx} className={i.kind === 'warn' ? 'warn' : ''}>
                      <span className="ic" aria-hidden="true">{i.icon}</span>
                      <span>{i.text}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="sub">Nada a destacar.</p>
              )}
            </div>
          </div>

          <div className="simgo">
            <span className="note">{letter ? 'Guarde o resultado para comparar com outra simulação.' : 'Limite de 4 cenários: remova um para guardar outro.'}</span>
            <button type="button" className="btn" disabled={!letter || stale} onClick={saveScenario}>
              Guardar como Cenário {letter ?? ''}
            </button>
            {isAdmin && applicable.length ? (
              <button type="button" className="btn" disabled={stale} onClick={() => setConfirming(true)}>
                Usar estes tempos na configuração ({pl(applicable.length, 'robô', 'robôs')})
              </button>
            ) : null}
          </div>
          {confirming && !stale && isAdmin ? (
            <div className="warnbox" style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 650, marginBottom: 6 }}>Configurar {pl(applicable.length, 'robô', 'robôs')} com os tempos da simulação (provável)?</div>
              <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>
                {applicable.map((r) => {
                  const hub = robotsById.get(r.robotId);
                  const info = withoutGain.find((x) => x.robotId === r.robotId);
                  const novo = r.source === 'novo';
                  const unitName = novo ? hub?.unitLabel || 'item' : base === 'exec' ? 'execução' : info?.unitLabel && info.unitLabel !== 'item' ? info.unitLabel : 'item';
                  return (
                    <li key={r.robotId}>
                      {r.name}: {hub?.manualSecondsPerUnit ? `${perUnitTxt(hub.manualSecondsPerUnit, hub.unitLabel || 'item')} → ` : ''}
                      {perUnitTxt(times[r.robotId] ?? 0, unitName)}
                    </li>
                  );
                })}
              </ul>
              <div>Vale só para as próximas execuções (os números já apresentados não mudam). Dá para revisar cada um depois na lista de robôs.</div>
              <div className="acts" style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={applying}>
                  Cancelar
                </button>
                <button type="button" className="btn pri" onClick={apply} disabled={applying}>
                  {applying ? 'Salvando...' : 'Confirmar'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ---------------- cenários ---------------- */}
      {scenarios.length ? <ScenariosTable scenarios={scenarios} onRemove={(l) => setScenarios((prev) => prev.filter((s) => s.letter !== l))} /> : null}
    </div>
  );
}

/** "Tempo ganho do relatório, por mês": hoje × com a simulação, e a faixa conservador/provável/otimista. */
function ReportBars({ m }: { m: SimulationResult }) {
  const rel = m.reportMonth;
  const sim = rel + m.extraMonth;
  const mx = Math.max(rel, sim, 1);
  const loses = m.extraMonth < 0;
  const seg = (v: number, style: CSSProperties) => (v > 0 ? <span style={{ width: `${(v / mx) * 100}%`, ...style }} /> : null);
  const bar = (label: string, parts: ReactNode, value: string) => (
    <div className="cb">
      <span className="lb">{label}</span>
      <div className="track" role="img" aria-label={`${label}: ${value}`}>{parts}</div>
      <span className="val">{value}</span>
    </div>
  );
  const fx = (title: string, extra: number, note: string, mid?: boolean) => (
    <div className={`pv${mid ? ' mid' : ''}`}>
      <div className="t">{title}</div>
      <div className="v">{signedDur(extra)}</div>
      <div className="c">{note}</div>
    </div>
  );
  return (
    <>
      <h3>
        Tempo ganho do relatório, por mês
        <SgInfo label="Sobre: Tempo ganho do relatório">
          <p>"Hoje" é o tempo ganho de todos os robôs (Hub, externos e painéis) no período, levado para um mês.</p>
          <p>"Com a simulação" soma a diferença simulada. Os outros robôs não mudam. Se a simulação reduz o ganho, a parte perdida aparece com contorno vermelho.</p>
        </SgInfo>
      </h3>
      <div className="cmpbars">
        {bar('Hoje', seg(rel, { background: 'var(--faint)' }), dur(rel))}
        {bar(
          'Com a simulação',
          <>
            {seg(Math.min(rel, sim), { background: 'var(--faint)' })}
            {loses ? seg(-m.extraMonth, { background: 'transparent', border: '1.5px dashed var(--bad-ink)', boxSizing: 'border-box', borderRadius: 4 }) : seg(m.extraMonth, { background: 'var(--accent)' })}
          </>,
          dur(sim),
        )}
      </div>
      <div className="legend">
        <span><span className="sw" style={{ background: 'var(--faint)' }} />o que já existe</span>
        {loses ? (
          <span><span className="sw" style={{ border: '1.5px dashed var(--bad-ink)', boxSizing: 'border-box' }} />a menos na simulação</span>
        ) : (
          <span><span className="sw" style={{ background: 'var(--accent)' }} />a mais na simulação</span>
        )}
      </div>
      <div style={{ marginTop: 20 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink2)', marginBottom: 8, display: 'flex', gap: 5, alignItems: 'center' }}>
          Faixa (ganho a mais por mês)
          <SgInfo label="Sobre: Faixa">
            <p>O tempo de cabeça raramente é exato. A faixa mostra o resultado com metade e com 1,5 vez os tempos estimados para os robôs sem tempo.</p>
            <p>Não variam: os robôs que mantêm o tempo atual e os novos tempos escolhidos para eles.</p>
          </SgInfo>
        </div>
        <div className="faixa">
          {fx('Conservador', m.band.low.extraMonth, 'metade dos tempos')}
          {fx('Provável', m.band.likely.extraMonth, 'os tempos informados', true)}
          {fx('Otimista', m.band.high.extraMonth, '1,5 vez os tempos')}
        </div>
      </div>
    </>
  );
}

/** "Quanto cada robô soma por mês": cinza = o que já soma; azul = o que a simulação acrescenta; contorno vermelho = o que um novo tempo menor tira. */
function RankingBars({ rows }: { rows: SimRow[] }) {
  const shown = rows.filter((r) => r.simulatedMonth > 0 || r.currentMonth > 0).sort((a, b) => b.simulatedMonth - a.simulatedMonth);
  const rmx = Math.max(1, ...shown.map((r) => Math.max(r.simulatedMonth, r.currentMonth)));
  const noRuns = rows.filter((r) => !r.executions).length;
  const noTime = rows.filter((r) => r.executions && !(r.simulatedMonth > 0 || r.currentMonth > 0)).length;
  const out = [noRuns ? pl(noRuns, 'robô sem execuções no período', 'robôs sem execuções no período') : '', noTime ? pl(noTime, 'robô sem tempo informado', 'robôs sem tempo informado') : ''].filter(Boolean);
  return (
    <>
      <h3>Quanto cada robô soma por mês</h3>
      <p className="sub">Cinza = o que o robô já soma hoje (tempo atual); azul = o que a simulação acrescenta; contorno vermelho = o que um novo tempo menor tira.</p>
      <div className="rank">
        {shown.map((r) => (
          <div className="rk" key={r.robotId}>
            <span className="nm" title={r.name}>{r.name}</span>
            <div className="track" style={{ height: 16, borderRadius: 5, background: 'var(--line2)', display: 'flex', gap: 2, overflow: 'hidden' }}>
              {r.currentMonth > 0 ? <span style={{ display: 'block', height: '100%', width: `${(Math.min(r.currentMonth, r.simulatedMonth) / rmx) * 100}%`, background: 'var(--faint)' }} /> : null}
              {r.simulatedMonth > r.currentMonth ? <span style={{ display: 'block', height: '100%', width: `${((r.simulatedMonth - r.currentMonth) / rmx) * 100}%`, background: 'var(--accent)' }} /> : null}
              {r.simulatedMonth < r.currentMonth ? <span style={{ display: 'block', height: '100%', boxSizing: 'border-box', border: '1.5px dashed var(--bad-ink)', borderRadius: 4, width: `${((r.currentMonth - r.simulatedMonth) / rmx) * 100}%` }} /> : null}
            </div>
            <span className="val">
              <b>{dur(r.simulatedMonth)}</b>
              {r.source === 'novo' ? (r.simulatedMonth < r.currentMonth ? ` (novo tempo, era ${dur(r.currentMonth)})` : ' (novo tempo)') : r.hasTime ? ' (tempo atual)' : ' (simulado)'}
            </span>
          </div>
        ))}
      </div>
      {out.length ? <p className="ro" style={{ margin: '10px 0 0' }}>Não aparecem: {out.join(' e ')}.</p> : null}
    </>
  );
}

function ScenariosTable({ scenarios, onRemove }: { scenarios: Scenario[]; onRemove: (letter: string) => void }) {
  const best = Math.max(...scenarios.map((c) => c.mais));
  const mx = Math.max(1, ...scenarios.map((c) => Math.abs(c.hi)), ...scenarios.map((c) => Math.abs(c.mais)));
  return (
    <div className="card" style={{ marginTop: 18 }}>
      <h3>Cenários guardados</h3>
      <p className="sub">Lado a lado, para comparar. Somem ao recarregar a página.</p>
      <div className="tbl-wrap">
        <table className="sim stack cen">
          <thead>
            <tr>
              <th>Cenário</th>
              <th>Como foi simulado</th>
              <th className="n">A mais por mês</th>
              <th className="n">Por ano</th>
              <th className="n">Pessoas a mais</th>
              <th className="n">Pessoas no total</th>
              <th>Faixa (conservador a otimista)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {scenarios.map((c) => {
              const lo = Math.max(0, Math.min(c.lo, c.hi));
              const hi = Math.max(0, Math.max(c.lo, c.hi));
              return (
                <tr key={c.letter}>
                  <td>
                    <b>{c.name}</b>
                    {c.mais === best && scenarios.length > 1 ? <span className="chip good" style={{ marginLeft: 6 }}>maior</span> : null}
                  </td>
                  <td>
                    <div>{c.desc}</div>
                    <div className="ro">base: {c.per} · pessoa: {nfx(c.jh)} h por dia</div>
                  </td>
                  <td className="n" data-label="A mais por mês"><b>{signedDur(c.mais)}</b></td>
                  <td className="n" data-label="Por ano">{signed(c.mais * 12, (v) => `${nf(v / 3600)} h`)}</td>
                  <td className="n" data-label="Pessoas a mais">{peopleNum(c.mais, c.jh)}</td>
                  <td className="n" data-label="Pessoas no total">{peopleNum(c.tot, c.jh)}</td>
                  <td style={{ minWidth: 150 }} data-label="Faixa">
                    <div title={`de ${signedDur(c.lo)} a ${signedDur(c.hi)}`} aria-label={`Faixa de ${signedDur(c.lo)} a ${signedDur(c.hi)}`} role="img" style={{ position: 'relative', height: 14, background: 'var(--line2)', borderRadius: 5 }}>
                      <span style={{ position: 'absolute', top: 0, bottom: 0, borderRadius: 5, background: 'var(--accent-soft)', left: `${(lo / mx) * 100}%`, width: `${((hi - lo) / mx) * 100}%` }} />
                      <span style={{ position: 'absolute', top: -2, bottom: -2, width: 3, borderRadius: 2, background: 'var(--accent)', left: `calc(${(Math.max(0, c.mais) / mx) * 100}% - 1px)` }} />
                    </div>
                  </td>
                  <td className="n">
                    <button type="button" className="link" aria-label={`Remover ${c.name}`} onClick={() => onRemove(c.letter)}>
                      Remover
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
