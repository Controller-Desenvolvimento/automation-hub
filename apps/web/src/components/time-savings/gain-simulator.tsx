import { useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { SOURCE_LABEL, dur, nf, peopleText, signedDur, type SimulationResult } from '../../lib/gain-simulator';
import { DEFAULT_METRIC_KEY, TIME_UNITS, toSeconds, type RobotWithoutGain, type TimeUnit } from '../../lib/robots-without-gain';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { GainMonthlyChart } from './gain-monthly-chart';

type HubRobot = { id: string; name: string; manualSecondsPerUnit: number };

/** Um cenário guardado (só nesta tela, enquanto ela estiver aberta): o resultado e como ele foi simulado. */
type Scenario = {
  letter: string;
  description: string;
  extraMonth: number;
  extraYear: number;
  peopleExtra: number;
  simulatedReport: number;
  peopleTotal: number;
  low: number;
  high: number;
  days: number;
  informed: number;
};

const LETTERS = ['A', 'B', 'C', 'D'];

const MAX_SECONDS = 86_400;

const segBtn = (active: boolean) =>
  cn(
    'px-3 py-2 text-sm transition',
    active ? 'bg-slate-950 text-white dark:bg-white dark:text-slate-950' : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-[#0f0f10] dark:text-zinc-300 dark:hover:bg-[#18181b]',
  );

function Seg<T extends string>({ label, value, items, onChange }: { label: string; value: T; items: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <div role="group" aria-label={label} className="inline-flex flex-wrap overflow-hidden rounded-xl border border-slate-300 dark:border-[#2b2b31]">
      {items.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)} className={segBtn(value === v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 p-4 text-center dark:border-[#27272a]">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-zinc-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight text-slate-950 dark:text-white">{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">{hint}</div> : null}
    </div>
  );
}

export function GainSimulator({
  from,
  to,
  hubRobots,
  withoutGain,
  notify,
  onApplied,
}: {
  from: string;
  to: string;
  hubRobots: HubRobot[];
  /** Robôs sem ganho (da lista da aba): servem para sugerir o rótulo e a métrica ao aplicar os tempos. */
  withoutGain: RobotWithoutGain[];
  notify: (message: string) => void;
  onApplied: () => void;
}) {
  const [scope, setScope] = useState<'sem' | 'todos'>('sem');
  const [mode, setMode] = useState<'igual' | 'robo'>('igual');
  const [base, setBase] = useState<'exec' | 'item'>('exec');
  const [unit, setUnit] = useState<TimeUnit>('minutes');
  const [equal, setEqual] = useState('5');
  const [perRobot, setPerRobot] = useState<Record<string, string>>({});
  const [newTimes, setNewTimes] = useState(false);
  const [perCurrent, setPerCurrent] = useState<Record<string, string>>({});
  const [workday, setWorkday] = useState('7');
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [resultKey, setResultKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState(false);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);

  const without = useMemo(() => hubRobots.filter((r) => !r.manualSecondsPerUnit), [hubRobots]);
  const withTime = useMemo(() => hubRobots.filter((r) => r.manualSecondsPerUnit > 0), [hubRobots]);
  const shown = scope === 'sem' ? without : hubRobots;

  // Tempos válidos em segundos; campo preenchido e inválido é o que bloqueia o "Simular".
  const problems: string[] = [];
  const times: Record<string, number> = {};
  const parse = (raw: string, who: string): number | null => {
    if (!raw.trim()) return null;
    const s = toSeconds(raw, unit);
    if (s === null || s > MAX_SECONDS) {
      problems.push(who);
      return null;
    }
    return s;
  };
  const equalSeconds = parse(equal, 'o tempo padrão');
  for (const r of shown) {
    if (excluded.has(r.id)) continue;
    if (r.manualSecondsPerUnit > 0) {
      if (scope === 'todos' && newTimes) {
        const s = parse(perCurrent[r.id] ?? '', r.name);
        if (s !== null) times[r.id] = s;
      }
    } else if (mode === 'robo') {
      const s = parse(perRobot[r.id] ?? '', r.name);
      const final = s ?? equalSeconds;
      if (final !== null) times[r.id] = final;
    } else if (equalSeconds !== null) {
      times[r.id] = equalSeconds;
    }
  }
  const workdayNumber = Number(workday.trim().replace(',', '.'));
  const workdayOk = Number.isFinite(workdayNumber) && workdayNumber >= 1 && workdayNumber <= 24;
  if (!workdayOk) problems.push('a jornada (de 1 a 24 horas)');

  const request = useMemo(
    () => ({ from: from || undefined, to: to || undefined, scope, base, times, excluded: [...excluded], workdayHours: workdayOk ? workdayNumber : 7 }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [from, to, scope, base, JSON.stringify(times), [...excluded].sort().join(','), workdayNumber, workdayOk],
  );
  const key = JSON.stringify(request);
  const stale = result !== null && key !== resultKey;
  const canRun = problems.length === 0 && !busy;

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
      setResult(data);
      setResultKey(key);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível simular.');
    } finally {
      setBusy(false);
    }
  }

  // "Usar estes tempos": só os robôs que hoje não têm tempo e que a simulação trata como "tempo informado".
  const applicable = useMemo(
    () => (result && !stale ? result.rows.filter((r) => !r.hasTime && r.source === 'informado') : []),
    [result, stale],
  );
  async function apply() {
    if (!result) return;
    setApplying(true);
    let ok = 0;
    const failed: string[] = [];
    for (const row of applicable) {
      const info = withoutGain.find((r) => r.robotId === row.robotId);
      const seconds = times[row.robotId];
      if (!seconds) continue;
      try {
        await api(`/robots/${row.robotId}/time-savings`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            manualSecondsPerUnit: seconds,
            unitLabel: base === 'exec' ? 'execução' : info?.unitLabel && info.unitLabel !== 'item' ? info.unitLabel : 'item',
            unitMetricKey: base === 'exec' ? DEFAULT_METRIC_KEY : info?.metrics[0]?.key ?? DEFAULT_METRIC_KEY,
          }),
        });
        ok += 1;
      } catch {
        failed.push(row.name);
      }
    }
    setApplying(false);
    setConfirming(false);
    notify(failed.length ? `${ok} salvos; falhou em: ${failed.join(', ')}.` : `Tempos salvos em ${ok} ${ok === 1 ? 'robô' : 'robôs'}. Valem para as próximas execuções.`);
    onApplied();
  }

  const unitLabel = TIME_UNITS.find((u) => u.value === unit)?.label ?? 'minutos';
  const freeLetter = LETTERS.find((l) => !scenarios.some((sc) => sc.letter === l));
  function describe(): string {
    const ab = unit === 'seconds' ? 's' : unit === 'minutes' ? 'min' : 'h';
    const per = base === 'exec' ? 'por execução' : 'por item';
    const informed = shown.filter((r) => !excluded.has(r.id) && !r.manualSecondsPerUnit && (perRobot[r.id] ?? '').trim()).length;
    const how = mode === 'igual' ? `${equal.trim() ? `${equal.trim()} ${ab}` : 'sem tempo'} ${per} para todos` : `tempo por robô ${per} (${informed} ${informed === 1 ? 'informado' : 'informados'}${equal.trim() ? `, padrão ${equal.trim()} ${ab}` : ''})`;
    const news = shown.filter((r) => !excluded.has(r.id) && r.manualSecondsPerUnit > 0 && (perCurrent[r.id] ?? '').trim()).length;
    const who = scope === 'sem' ? 'só os sem ganho' : news && newTimes ? `somando os que já têm ganho, com novos tempos em ${news} ${news === 1 ? 'robô' : 'robôs'}` : 'somando os que já têm ganho (tempos atuais)';
    return `${how} · ${who}`;
  }
  function saveScenario() {
    if (!result || stale || !freeLetter) return;
    const informedCount = result.rows.filter((r) => r.source === 'informado' || r.source === 'novo').length;
    setScenarios((prev) =>
      [
        ...prev,
        {
          letter: freeLetter,
          description: describe(),
          extraMonth: result.extraMonth,
          extraYear: result.extraYear,
          peopleExtra: result.people.extra,
          simulatedReport: result.reportMonth + result.extraMonth,
          peopleTotal: result.people.total,
          low: result.band.low.extraMonth,
          high: result.band.high.extraMonth,
          days: result.days,
          informed: informedCount,
        },
      ].sort((a, b) => a.letter.localeCompare(b.letter)),
    );
    notify(`Cenário ${freeLetter} guardado. Ele fica só nesta tela, enquanto ela estiver aberta.`);
  }
  const toggleExcluded = (id: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className="min-w-0 space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight text-slate-950 dark:text-white">Simular ganhos</h2>
        <p className="max-w-3xl text-sm text-slate-500 dark:text-zinc-400">
          Chute um tempo e veja quanto o relatório passaria a mostrar, usando as execuções reais do período escolhido. <strong>Nada é salvo</strong> enquanto você
          não usar os tempos na configuração.
        </p>
      </div>

      <div className="space-y-4 rounded-2xl border border-slate-200 p-4 dark:border-[#27272a]">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="space-y-1">
            <div className="text-xs font-medium text-slate-500 dark:text-zinc-400">Quais robôs</div>
            <Seg label="Quais robôs" value={scope} onChange={setScope} items={[['sem', `Só os sem ganho (${without.length})`], ['todos', `Somando os que já têm ganho (${withTime.length})`]]} />
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium text-slate-500 dark:text-zinc-400">Como informar</div>
            <Seg label="Como informar" value={mode} onChange={setMode} items={[['igual', 'Igual para todos'], ['robo', 'Por robô']]} />
          </div>
          <div className="space-y-1">
            <div className="text-xs font-medium text-slate-500 dark:text-zinc-400">O tempo vale</div>
            <Seg label="O tempo vale" value={base} onChange={setBase} items={[['exec', 'Por execução'], ['item', 'Por item']]} />
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <label className="space-y-1">
            <span className="block text-xs font-medium text-slate-500 dark:text-zinc-400">{mode === 'igual' ? 'Tempo manual' : 'Tempo padrão (robôs em branco)'}</span>
            <span className="flex gap-2">
              <Input aria-label="Tempo padrão" inputMode="decimal" className="w-28" value={equal} onChange={(e) => setEqual(e.target.value)} placeholder="5" />
              <select
                aria-label="Unidade de tempo"
                value={unit}
                onChange={(e) => setUnit(e.target.value as TimeUnit)}
                className="h-10 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100"
              >
                {TIME_UNITS.map((u) => (
                  <option key={u.value} value={u.value}>
                    {u.label}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <label className="space-y-1">
            <span className="block text-xs font-medium text-slate-500 dark:text-zinc-400">Jornada da pessoa (h por dia)</span>
            <Input aria-label="Jornada em horas por dia" inputMode="decimal" className="w-24" value={workday} onChange={(e) => setWorkday(e.target.value)} />
          </label>
          {scope === 'todos' ? (
            <label className="flex items-center gap-2 pb-2 text-sm text-slate-700 dark:text-zinc-200">
              <input type="checkbox" checked={newTimes} onChange={(e) => setNewTimes(e.target.checked)} />
              Simular novos tempos para quem já tem ganho
            </label>
          ) : null}
        </div>

        {mode === 'robo' || (scope === 'todos' && newTimes) ? (
          <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-[#27272a]">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 dark:text-zinc-400">
                  <th className="px-3 py-2">Incluir</th>
                  <th className="px-3 py-2">Robô</th>
                  <th className="px-3 py-2">Tempo ({unitLabel}{base === 'exec' ? ' por execução' : ' por item'})</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const has = r.manualSecondsPerUnit > 0;
                  const off = excluded.has(r.id);
                  const editable = has ? scope === 'todos' && newTimes : mode === 'robo';
                  return (
                    <tr key={r.id} className="border-t border-slate-100 dark:border-[#1f1f23]">
                      <td className="px-3 py-1.5">
                        <input type="checkbox" aria-label={`Incluir ${r.name}`} checked={!off} onChange={() => toggleExcluded(r.id)} />
                      </td>
                      <td className="px-3 py-1.5 text-slate-800 dark:text-zinc-100">
                        {r.name}
                        {has ? <span className="ml-2 text-xs text-slate-400">já tem {dur(r.manualSecondsPerUnit)} por item</span> : null}
                      </td>
                      <td className="px-3 py-1.5">
                        {editable ? (
                          <Input
                            aria-label={`Tempo de ${r.name}`}
                            inputMode="decimal"
                            className="h-8 w-28"
                            disabled={off}
                            placeholder={has ? 'mantém' : equal || '—'}
                            value={(has ? perCurrent[r.id] : perRobot[r.id]) ?? ''}
                            onChange={(e) => (has ? setPerCurrent((p) => ({ ...p, [r.id]: e.target.value })) : setPerRobot((p) => ({ ...p, [r.id]: e.target.value })))}
                          />
                        ) : (
                          <span className="text-xs text-slate-400">{has ? 'tempo atual' : 'tempo padrão'}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : excluded.size > 0 ? (
          <p className="text-xs text-slate-500 dark:text-zinc-400">{excluded.size} robô(s) excluído(s) da simulação. Escolha "Por robô" para ver a lista.</p>
        ) : null}

        {problems.length ? (
          <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
            Corrija {problems.slice(0, 3).join(', ')}{problems.length > 3 ? ` e mais ${problems.length - 3}` : ''}: digite um número maior que zero (até 24 horas) para simular.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
            {error}
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <Button onClick={run} disabled={!canRun}>
            {busy ? 'Simulando...' : 'Simular'}
          </Button>
          {stale ? (
            <span role="status" className="text-sm text-amber-700 dark:text-amber-300">
              Os valores mudaram: clique em Simular para atualizar o resultado.
            </span>
          ) : null}
        </div>
      </div>

      {result ? (
        <div className={cn('space-y-6 transition-opacity', stale && 'opacity-50')} aria-busy={busy}>
          <p className="text-xs text-slate-500 dark:text-zinc-400">
            Base: execuções reais de {nf(result.days)} {result.days === 1 ? 'dia' : 'dias'}, levadas para 1 mês (jornada de {nf(result.workdayHours)} h por dia, 21 dias úteis).
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Ganho a mais por mês" value={signedDur(result.extraMonth)} hint={`${signedDur(result.extraYear)} por ano`} />
            <Stat label="Pessoas a mais" value={peopleText(result.people.extra)} hint="trabalhando só nisso o mês todo" />
            <Stat label="Relatório hoje" value={`${dur(result.reportMonth)} por mês`} hint={peopleText(result.people.current)} />
            <Stat label="Relatório simulado" value={`${dur(result.reportMonth + result.extraMonth)} por mês`} hint={peopleText(result.people.total)} />
          </div>

          <div className="rounded-2xl border border-slate-200 p-4 dark:border-[#27272a]">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">Faixa de estimativa</h3>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-zinc-400">
              Conservador = metade dos tempos informados, provável = os tempos informados, otimista = 1,5 vez. Os tempos de quem já tem ganho não variam.
            </p>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
              {(
                [
                  ['Conservador', result.band.low],
                  ['Provável', result.band.likely],
                  ['Otimista', result.band.high],
                ] as const
              ).map(([label, b]) => (
                <div key={label} className="rounded-xl bg-slate-50 p-3 text-center dark:bg-[#18181b]">
                  <div className="text-xs text-slate-500 dark:text-zinc-400">{label}</div>
                  <div className="text-lg font-semibold text-slate-950 dark:text-white">{signedDur(b.extraMonth)} por mês</div>
                  <div className="text-xs text-slate-500 dark:text-zinc-400">{peopleText(b.people)}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto rounded-2xl border border-slate-200 dark:border-[#27272a]">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 dark:text-zinc-400">
                  <th className="px-3 py-2">Robô</th>
                  <th className="px-3 py-2 text-right">Execuções</th>
                  <th className="px-3 py-2 text-right">Hoje por mês</th>
                  <th className="px-3 py-2 text-right">Simulado por mês</th>
                  <th className="px-3 py-2 text-right">Diferença</th>
                  <th className="px-3 py-2">Como entrou</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.robotId} className="border-t border-slate-100 dark:border-[#1f1f23]">
                    <td className="px-3 py-1.5 font-medium text-slate-900 dark:text-zinc-100">{r.name}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{nf(r.executions)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{dur(r.currentMonth)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{dur(r.simulatedMonth)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{signedDur(r.simulatedMonth - r.currentMonth)}</td>
                    <td className="px-3 py-1.5 text-xs text-slate-500 dark:text-zinc-400">
                      {SOURCE_LABEL[r.source]}
                      {r.perExecution !== null ? ` · ${dur(r.perExecution)} por execução` : ''}
                      {r.estimated ? ` · ${nf(r.estimated)} estimadas` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {result.insights.length ? (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">O que a simulação mostra</h3>
              <ul className="space-y-1.5">
                {result.insights.map((i, idx) => (
                  <li
                    key={idx}
                    className={cn(
                      'rounded-xl px-3 py-2 text-sm',
                      i.kind === 'warn' ? 'bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-100' : 'bg-slate-50 text-slate-700 dark:bg-[#18181b] dark:text-zinc-300',
                    )}
                  >
                    <span aria-hidden="true" className="mr-2">{i.kind === 'warn' ? '⚠' : '•'}</span>
                    {i.text}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="space-y-3 rounded-2xl border border-slate-200 p-4 dark:border-[#27272a]">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">Evolução mensal</h3>
            <GainMonthlyChart months={result.monthly.months} cut={result.monthly.cut} />
          </div>

          <div className="space-y-3 rounded-2xl border border-slate-200 p-4 dark:border-[#27272a]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100">Cenários</h3>
                <p className="text-xs text-slate-500 dark:text-zinc-400">Guarde até 4 simulações para comparar lado a lado. Ficam só nesta tela, enquanto ela estiver aberta.</p>
              </div>
              <Button size="sm" variant="outline" onClick={saveScenario} disabled={stale || !freeLetter}>
                {freeLetter ? `Guardar como Cenário ${freeLetter}` : 'Limite de 4 cenários'}
              </Button>
            </div>
            {scenarios.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-zinc-400">Nenhum cenário guardado ainda.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-[#27272a]">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 dark:text-zinc-400">
                      <th className="px-3 py-2"> </th>
                      {scenarios.map((sc) => (
                        <th key={sc.letter} className="px-3 py-2 align-top">
                          <div className="flex items-center justify-between gap-2 normal-case">
                            <span className="text-sm font-semibold tracking-normal text-slate-900 dark:text-zinc-100">Cenário {sc.letter}</span>
                            <button type="button" onClick={() => setScenarios((prev) => prev.filter((x) => x.letter !== sc.letter))} aria-label={`Remover o cenário ${sc.letter}`} className="text-xs font-normal text-rose-600 hover:underline dark:text-rose-400">
                              Remover
                            </button>
                          </div>
                          <div className="mt-0.5 text-xs font-normal normal-case tracking-normal text-slate-500 dark:text-zinc-400">{sc.description}</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(
                      [
                        ['Ganho a mais por mês', (sc: Scenario) => signedDur(sc.extraMonth), 'extraMonth'],
                        ['Ganho a mais por ano', (sc: Scenario) => signedDur(sc.extraYear), 'extraYear'],
                        ['Pessoas a mais', (sc: Scenario) => peopleText(sc.peopleExtra), 'peopleExtra'],
                        ['Relatório simulado por mês', (sc: Scenario) => `${dur(sc.simulatedReport)} (${peopleText(sc.peopleTotal)})`, 'simulatedReport'],
                        ['Faixa: conservador', (sc: Scenario) => signedDur(sc.low), 'low'],
                        ['Faixa: otimista', (sc: Scenario) => signedDur(sc.high), 'high'],
                        ['Robôs com tempo informado', (sc: Scenario) => nf(sc.informed), null],
                        ['Base (dias de execuções)', (sc: Scenario) => nf(sc.days), null],
                      ] as Array<[string, (sc: Scenario) => string, keyof Scenario | null]>
                    ).map(([label, fmt, best]) => {
                      const top = best && scenarios.length > 1 ? Math.max(...scenarios.map((sc) => Number(sc[best]))) : null;
                      return (
                        <tr key={label} className="border-t border-slate-100 dark:border-[#1f1f23]">
                          <td className="px-3 py-1.5 text-xs text-slate-500 dark:text-zinc-400">{label}</td>
                          {scenarios.map((sc) => (
                            <td key={sc.letter} className={cn('px-3 py-1.5 tabular-nums', best && top !== null && Number(sc[best]) === top && 'font-semibold text-emerald-700 dark:text-emerald-400')}>
                              {fmt(sc)}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {applicable.length > 0 ? (
            <div className="rounded-2xl border border-slate-200 p-4 dark:border-[#27272a]">
              <p className="text-sm text-slate-700 dark:text-zinc-300">
                Gostou? Use estes tempos na configuração de {applicable.length} {applicable.length === 1 ? 'robô' : 'robôs'} sem ganho. Vale só para as próximas
                execuções.
              </p>
              <Button className="mt-3" variant="outline" onClick={() => setConfirming(true)}>
                Usar estes tempos na configuração
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {confirming ? (
        <div className="fixed inset-0 z-50 grid place-items-center p-4">
          <button type="button" aria-label="Fechar" className="absolute inset-0 bg-black/50" onClick={() => !applying && setConfirming(false)} />
          <div role="dialog" aria-modal="true" aria-labelledby="sim-apply-title" className="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-[#27272a] dark:bg-[#111113]">
            <h2 id="sim-apply-title" className="text-lg font-semibold text-slate-950 dark:text-white">
              Salvar estes tempos?
            </h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-zinc-300">
              O tempo manual de {applicable.length} {applicable.length === 1 ? 'robô' : 'robôs'} será gravado no cadastro, {base === 'exec' ? 'por execução' : 'por item'}. As próximas
              execuções passam a somar ganho; as que já aconteceram não mudam.
            </p>
            <ul className="mt-3 max-h-40 space-y-0.5 overflow-y-auto text-sm text-slate-700 dark:text-zinc-300">
              {applicable.map((r) => (
                <li key={r.robotId}>
                  {r.name}: {dur(times[r.robotId] ?? 0)} {base === 'exec' ? 'por execução' : 'por item'}
                </li>
              ))}
            </ul>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirming(false)} disabled={applying}>
                Cancelar
              </Button>
              <Button onClick={apply} disabled={applying}>
                {applying ? 'Salvando...' : 'Salvar'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
