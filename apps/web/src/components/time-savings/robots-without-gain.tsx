import { X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHub } from '../../contexts/hub-context';
import { api } from '../../lib/api';
import {
  DEFAULT_METRIC_KEY,
  TIME_UNITS,
  executionModeKey,
  normalizeMetricKey,
  previewGain,
  toSeconds,
  type RobotWithoutGain,
  type RobotsWithoutGainResponse,
  type TimeUnit,
} from '../../lib/robots-without-gain';
import { formatNumber } from '../../lib/time-savings-metrics';
import { hrs, nf, pl } from '../../lib/gain-simulator';
import { cn, formatSecondsToHuman } from '../../lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { GainSimulator } from './gain-simulator';
import { SgInfo } from './sg-parts';

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const nf0 = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 0 });

// ---------- janela "Configurar" ----------

function ConfigureDialog({ robot, onClose, onSaved }: { robot: RobotWithoutGain; onClose: () => void; onSaved: (message: string) => void | Promise<void> }) {
  const hasMetrics = robot.metrics.length > 0;
  const hasTime = robot.manualSecondsPerUnit > 0;
  // quem já tem tempo abre com ele na unidade que não perde precisão (horas, minutos ou segundos)
  const seg = robot.manualSecondsPerUnit;
  const initialUnit: TimeUnit = hasTime && seg % 3600 === 0 ? 'hours' : hasTime && seg % 60 === 0 ? 'minutes' : hasTime ? 'seconds' : 'minutes';
  const initialFactor = TIME_UNITS.find((u) => u.value === initialUnit)?.factor ?? 60;
  const [time, setTime] = useState(hasTime ? String(seg / initialFactor).replace('.', ',') : '');
  const [unit, setUnit] = useState<TimeUnit>(initialUnit);
  const [label, setLabel] = useState(hasTime || (robot.unitLabel && robot.unitLabel !== 'item') ? robot.unitLabel : '');
  // quem já tem tempo mantém a forma de contar que tem hoje (a métrica configurada), em vez de trocar pela mais informada
  const keepCurrentMetric = hasTime && (robot.unitMetricKey !== DEFAULT_METRIC_KEY || robot.metrics.some((m) => m.key === robot.unitMetricKey));
  const [mode, setMode] = useState<'execution' | 'metric'>(keepCurrentMetric || (!hasTime && hasMetrics) ? 'metric' : 'execution');
  const [metricKey, setMetricKey] = useState(keepCurrentMetric ? robot.unitMetricKey : hasMetrics ? robot.metrics[0].key : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstField.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const seconds = toSeconds(time, unit);
  const timeInvalid = time.trim() !== '' && seconds === null;
  const keyToSave = mode === 'execution' ? executionModeKey(robot) : normalizeMetricKey(metricKey) || DEFAULT_METRIC_KEY;
  const itemLabel = label.trim() || (mode === 'metric' ? 'item' : 'execução');
  const preview = useMemo(() => (seconds ? previewGain(robot, seconds, mode, keyToSave) : null), [robot, seconds, mode, keyToSave]);
  const canSave = seconds !== null && label.trim().length > 0 && label.trim().length <= 40 && !busy;

  async function save() {
    if (!canSave || seconds === null) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/robots/${robot.robotId}/time-savings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manualSecondsPerUnit: seconds, unitLabel: label.trim(), unitMetricKey: keyToSave }),
      });
      await onSaved(`Tempo salvo para ${robot.name}. Vale para as próximas execuções.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível salvar o tempo.');
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <button type="button" aria-label="Fechar" className="absolute inset-0 bg-black/50" onClick={() => !busy && onClose()} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="rsg-title"
        className="relative max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-[#27272a] dark:bg-[#111113]"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="rsg-title" className="text-lg font-semibold text-slate-950 dark:text-white">
              Configurar tempo manual
            </h2>
            <p className="mt-0.5 truncate text-sm text-slate-500 dark:text-zinc-400">{robot.name}</p>
          </div>
          <button type="button" aria-label="Fechar" onClick={() => !busy && onClose()} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-[#18181b] dark:hover:text-zinc-200">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <div className="mt-5 space-y-5">
          <fieldset className="space-y-1.5">
            <label htmlFor="rsg-time" className="text-sm font-medium text-slate-800 dark:text-zinc-200">
              Quanto tempo uma pessoa levaria para fazer isso à mão, por item?
            </label>
            <div className="flex gap-2">
              <Input
                id="rsg-time"
                ref={firstField}
                inputMode="decimal"
                placeholder="Ex.: 5"
                value={time}
                aria-invalid={timeInvalid}
                onChange={(e) => setTime(e.target.value)}
                className={cn(timeInvalid && 'border-rose-400 focus:border-rose-500')}
              />
              <select
                aria-label="Unidade de tempo"
                value={unit}
                onChange={(e) => setUnit(e.target.value as TimeUnit)}
                className="h-10 shrink-0 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-sky-500 focus:ring-4 focus:ring-sky-500/15 dark:border-[#2b2b31] dark:bg-[#0f0f10] dark:text-zinc-100"
              >
                {TIME_UNITS.map((u) => (
                  <option key={u.value} value={u.value}>
                    {u.label}
                  </option>
                ))}
              </select>
            </div>
            {timeInvalid ? <p className="text-xs text-rose-600 dark:text-rose-400">Digite um número maior que zero.</p> : null}
          </fieldset>

          <fieldset className="space-y-1.5">
            <label htmlFor="rsg-label" className="text-sm font-medium text-slate-800 dark:text-zinc-200">
              O que é um item?
            </label>
            <Input id="rsg-label" placeholder="Ex.: empresa, nota, planilha" maxLength={40} value={label} onChange={(e) => setLabel(e.target.value)} />
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-slate-800 dark:text-zinc-200">Como contar os itens de cada execução?</legend>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-slate-200 p-3 text-sm dark:border-[#27272a]">
              <input type="radio" name="rsg-mode" className="mt-0.5" checked={mode === 'execution'} onChange={() => setMode('execution')} />
              <span>
                <span className="font-medium text-slate-900 dark:text-zinc-100">Cada execução conta como 1 item</span>
                <span className="block text-xs text-slate-500 dark:text-zinc-400">Use quando o robô faz uma tarefa só por vez.</span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-slate-200 p-3 text-sm dark:border-[#27272a]">
              <input type="radio" name="rsg-mode" className="mt-0.5" checked={mode === 'metric'} onChange={() => setMode('metric')} />
              <span className="min-w-0 flex-1">
                <span className="font-medium text-slate-900 dark:text-zinc-100">Pela quantidade que o robô informa</span>
                <span className="block text-xs text-slate-500 dark:text-zinc-400">Métrica (<code>AH_METRIC</code>) que o robô escreve com o número de itens.</span>
                {mode === 'metric' ? (
                  <span className="mt-2 block space-y-2">
                    {hasMetrics ? (
                      <span className="flex flex-wrap gap-1.5">
                        {robot.metrics.map((m) => (
                          <button
                            key={m.key}
                            type="button"
                            onClick={() => setMetricKey(m.key)}
                            aria-pressed={normalizeMetricKey(metricKey) === m.key}
                            className={cn(
                              'rounded-full border px-2.5 py-1 text-xs transition-colors',
                              normalizeMetricKey(metricKey) === m.key
                                ? 'border-sky-500 bg-sky-50 text-sky-800 dark:bg-sky-950 dark:text-sky-200'
                                : 'border-slate-200 text-slate-600 hover:border-slate-400 dark:border-[#2b2b31] dark:text-zinc-300',
                            )}
                          >
                            {m.key} · média {formatNumber(m.total / Math.max(1, m.executions), 1)}/execução
                          </button>
                        ))}
                      </span>
                    ) : (
                      <span className="block text-xs text-amber-700 dark:text-amber-300">
                        Este robô não informou nenhuma métrica no período (ou os logs já foram apagados). Digite o nome da métrica, se souber; sem ela, conta 1 item por execução.
                      </span>
                    )}
                    <Input aria-label="Nome da métrica" placeholder="nome_da_metrica" value={metricKey} onChange={(e) => setMetricKey(e.target.value)} />
                  </span>
                ) : null}
              </span>
            </label>
          </fieldset>

          <div aria-live="polite" className="rounded-xl bg-slate-50 p-3 text-sm dark:bg-[#18181b]">
            {preview && seconds ? (
              <>
                <p className="font-medium text-slate-900 dark:text-zinc-100">
                  Com isso, o período mostrado somaria ≈ {formatSecondsToHuman(preview.seconds)}
                  <span className="font-normal text-slate-500 dark:text-zinc-400">
                    {' '}
                    ({formatSecondsToHuman(seconds)} × {nf0(preview.items)} {plural(preview.items, itemLabel, `${itemLabel}s`)} em {nf0(robot.executions)} {plural(robot.executions, 'execução', 'execuções')})
                  </span>
                </p>
                {preview.metricMissing ? (
                  <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                    Essa métrica não apareceu nas execuções do período; a prévia conta 1 item por execução. Se o robô não a enviar, é isso que o relatório vai contar.
                  </p>
                ) : preview.assumed > 0 && mode === 'metric' ? (
                  <p className="mt-1 text-xs text-slate-500 dark:text-zinc-400">
                    {nf0(preview.assumed)} {plural(preview.assumed, 'execução não informou', 'execuções não informaram')} a métrica e conta{preview.assumed === 1 ? '' : 'm'} 1 item (regra do Hub).
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-slate-500 dark:text-zinc-400">Digite o tempo para ver quanto isso somaria no período.</p>
            )}
            <p className="mt-2 text-xs text-slate-500 dark:text-zinc-400">
              Vale só <strong>daqui para frente</strong>: as execuções que já aconteceram continuam como estão no relatório e nenhum número já apresentado muda.
            </p>
          </div>

          {error ? (
            <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-200">
              {error}
            </p>
          ) : null}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={!canSave}>
            {busy ? 'Salvando...' : 'Salvar'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------- aba ----------

const dmy = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');

export function RobotsWithoutGain({
  from,
  to,
  departmentLabel,
  notify,
  onChanged,
  sub,
  onSub,
  isAdmin,
  reportSavedSeconds,
  reportFiltered,
}: {
  from: string;
  to: string;
  departmentLabel: (slug: string) => string;
  notify: (message: string) => void;
  /** Avisa a página que um tempo foi salvo (ela atualiza a lista de robôs e a contagem da aba). */
  onChanged: () => void;
  /** Sub-aba: a lista ou o simulador de ganhos (vive na URL: `aba=simular`). */
  sub: 'lista' | 'sim';
  onSub: (sub: 'lista' | 'sim') => void;
  isAdmin: boolean;
  /** Tempo ganho do relatório no período (para o terceiro indicador). */
  reportSavedSeconds: number | null;
  /** O relatório da página está com filtros de automação, departamento, pessoas ou origem (o total não é o do Hub inteiro). */
  reportFiltered: boolean;
}) {
  const { hub } = useHub();
  const [data, setData] = useState<RobotsWithoutGainResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<RobotWithoutGain | null>(null);
  const [show, setShow] = useState<'sem' | 'todos'>('sem');
  const seq = useRef(0);
  // O simulador guarda o resultado e os cenários na própria tela: depois de aberto, fica montado (só escondido) ao voltar para a Lista.
  const [simOpened, setSimOpened] = useState(sub === 'sim');
  useEffect(() => {
    if (sub === 'sim') setSimOpened(true);
  }, [sub]);

  const load = useCallback(() => {
    const id = ++seq.current;
    setLoading(true);
    const query = new URLSearchParams({ all: 'true' });
    if (from) query.set('from', from);
    if (to) query.set('to', to);
    return api<RobotsWithoutGainResponse>(`/reports/robots-without-gain?${query.toString()}`)
      .then((result) => {
        if (id !== seq.current) return;
        setData(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (id !== seq.current) return;
        setError(err instanceof Error ? err.message : 'Não foi possível carregar os robôs sem ganho.');
      })
      .finally(() => {
        if (id === seq.current) setLoading(false);
      });
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const hubRobots = (hub?.robots ?? [])
    .filter((r) => r.isActive && !r.isExternal)
    .map((r) => ({ id: r.id, name: r.name, manualSecondsPerUnit: r.manualSecondsPerUnit ?? 0, unitLabel: r.unitLabel ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  if (error) {
    return (
      <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
        {error}
      </p>
    );
  }
  if (!data) {
    return (
      <p role="status" aria-live="polite" className="text-sm text-slate-500 dark:text-zinc-400">
        Carregando robôs sem ganho...
      </p>
    );
  }

  const all = data.robots;
  const without = all.filter((r) => !r.manualSecondsPerUnit);
  const shown = (show === 'sem' ? without : all).slice().sort((a, b) => b.executions - a.executions || a.name.localeCompare(b.name, 'pt-BR'));
  const runsWithout = without.reduce((sum, r) => sum + r.executions, 0);
  const othersTotal = data.others.reduce((sum, o) => sum + o.zeroItems + o.beforeTime, 0);

  return (
    <div className={`sg${loading ? ' opacity-60' : ''}`} aria-busy={loading}>
      <div className="kpis">
        <div className="kpi">
          <div className="t">
            Robôs sem tempo manual
            <SgInfo label="Sobre: Robôs sem tempo manual">
              <p>Robôs ativos do Hub que ainda não têm "tempo manual por item" configurado. Toda execução deles entra no relatório com 0 h de ganho.</p>
              <p>Robôs externos (que rodam fora do Hub) não entram: o sistema deles informa o tempo ganho de cada execução.</p>
            </SgInfo>
          </div>
          <div className="v">
            {nf(without.length)}
            <small>de {nf(hubRobots.length)}</small>
          </div>
          <div className="s">robôs ativos do Hub</div>
        </div>
        <div className="kpi">
          <div className="t">Execuções deles no período</div>
          <div className="v">{nf(runsWithout)}</div>
          <div className="s">todas somaram 0 h</div>
        </div>
        <div className="kpi">
          <div className="t">Tempo ganho no período</div>
          <div className="v">
            {reportSavedSeconds === null ? '—' : hrs(reportSavedSeconds)}
            <small>h</small>
          </div>
          <div className="s">{reportFiltered ? 'total do relatório com os filtros atuais' : 'total do relatório hoje'}</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
        <button type="button" className={`btn${sub === 'lista' ? ' on' : ''}`} aria-pressed={sub === 'lista'} onClick={() => onSub('lista')}>
          Robôs sem tempo manual
        </button>
        <button type="button" className={`btn${sub === 'sim' ? ' on' : ''}`} aria-pressed={sub === 'sim'} onClick={() => onSub('sim')}>
          Simular ganhos
        </button>
      </div>

      {sub === 'sim' || simOpened ? (
        <div hidden={sub !== 'sim'}>
          <GainSimulator
            from={from}
            to={to}
            hubRobots={hubRobots}
            withoutGain={all}
            isAdmin={isAdmin}
            notify={notify}
            onApplied={async () => {
              await load();
              onChanged();
            }}
          />
        </div>
      ) : null}

      {sub === 'lista' ? (
        <>
          <div className="sechead">
            <div>
              <h2>Robôs sem tempo manual</h2>
              <p>Configure aqui mesmo: o valor passa a valer para as próximas execuções. As que já aconteceram continuam como estão. Esta aba segue só o período escolhido lá em cima: os filtros de automação, departamento, pessoas e origem não se aplicam a ela.</p>
            </div>
            <span className="seg" role="group" aria-label="Quais robôs mostrar">
              <button type="button" aria-pressed={show === 'sem'} onClick={() => setShow('sem')}>
                Sem tempo manual ({nf(without.length)})
              </button>
              <button type="button" aria-pressed={show === 'todos'} onClick={() => setShow('todos')}>
                Todos ({nf(all.length)})
              </button>
            </span>
          </div>

          {shown.length === 0 ? (
            <div className="empty">Todos os robôs ativos do Hub têm tempo manual configurado.</div>
          ) : (
            <div className="list">
              {shown.map((r) => {
                const hasTime = r.manualSecondsPerUnit > 0;
                const metric = r.metrics[0];
                const avg = metric ? metric.total / Math.max(1, metric.executions) : 0;
                const scheduled = r.executions > 0 && r.scheduledExecutions === r.executions ? 'todas agendadas' : r.scheduledExecutions > 0 ? `${nf(r.scheduledExecutions)} agendadas` : '';
                return (
                  <div className={`row${r.executions === 0 ? ' zero' : ''}`} key={r.robotId}>
                    <div>
                      <div className="nm">
                        {r.name}
                        {hasTime ? (
                          <span className="chip good">
                            tempo atual: {r.manualSecondsPerUnit % 60 === 0 && r.manualSecondsPerUnit >= 60 ? `${nf(r.manualSecondsPerUnit / 60)} min` : `${nf(r.manualSecondsPerUnit)} s`} por {r.unitLabel}
                          </span>
                        ) : (
                          <span className="chip acc">sem tempo manual</span>
                        )}
                        {metric ? (
                          <span className="chip">
                            {metric.key}: média {nf(avg, avg < 10 ? 1 : 0)} por execução
                          </span>
                        ) : r.executions > 0 ? (
                          <span className="chip warn">não informa itens: conta 1 por execução</span>
                        ) : (
                          <span className="chip">sem execuções recentes para ver a métrica</span>
                        )}
                      </div>
                      <div className="meta">
                        <span>{r.departments.length ? r.departments.map(departmentLabel).join(', ') : 'Todos os departamentos'}</span>
                        <span>{r.lastExecutionAt ? `última execução ${dmy(r.lastExecutionAt)}` : 'nunca executou'}</span>
                        {scheduled ? <span>{scheduled}</span> : null}
                      </div>
                    </div>
                    <div className="side">
                      <div className="num">
                        <b>{nf(r.executions)}</b>
                        <span>{r.executions === 1 ? 'execução' : 'execuções'} no período</span>
                      </div>
                      {isAdmin ? (
                        <button type="button" className="btn" onClick={() => setEditing(r)} aria-label={`Configurar o tempo manual de ${r.name}`}>
                          Configurar
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {othersTotal > 0 ? (
            <details className="list" style={{ marginTop: 16 }}>
              <summary style={{ cursor: 'pointer', padding: '14px 18px', fontWeight: 600 }}>
                Outras {pl(othersTotal, 'execução sem ganho', 'execuções sem ganho')} no período, de robôs que já têm tempo manual
              </summary>
              <div style={{ padding: '0 18px 14px', fontSize: 13.5 }}>
                <p className="ro" style={{ whiteSpace: 'normal', margin: '0 0 8px' }}>
                  Execuções de robôs que já têm tempo manual e mesmo assim somaram 0 h: ou o robô informou 0 itens (esperado, nada a fazer) ou a execução foi gravada antes de o robô ter tempo.
                </p>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {data.others.map((o) => (
                    <li key={o.robotId}>
                      <b>{o.name}</b>:{' '}
                      {[o.zeroItems ? `${nf(o.zeroItems)} com 0 itens (esperado)` : '', o.beforeTime ? pl(o.beforeTime, 'gravada com 0 h antes de o robô ter tempo', 'gravadas com 0 h antes de o robô ter tempo') : ''].filter(Boolean).join(' · ')}
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          ) : null}
        </>
      ) : null}

      <div style={{ marginTop: 32, paddingTop: 16, borderTop: '1px dashed var(--line)', fontSize: 12.5, color: 'var(--muted)' }}>
        Como o Hub calcula: tempo ganho de uma execução = tempo manual por item × itens que o robô informou (métrica <code>AH_METRIC</code>). Se o robô não informa, conta 1 item. O valor fica gravado na execução no momento em que ela termina.
      </div>

      {editing ? (
        <ConfigureDialog
          robot={editing}
          onClose={() => setEditing(null)}
          onSaved={async (message) => {
            setEditing(null);
            notify(message);
            await load();
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}
