import { Settings2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHub } from '../../contexts/hub-context';
import { api } from '../../lib/api';
import {
  DEFAULT_METRIC_KEY,
  TIME_UNITS,
  normalizeMetricKey,
  previewGain,
  toSeconds,
  type RobotWithoutGain,
  type RobotsWithoutGainResponse,
  type TimeUnit,
} from '../../lib/robots-without-gain';
import { formatDateTime, formatNumber } from '../../lib/time-savings-metrics';
import { cn, formatSecondsToHuman } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { GainSimulator } from './gain-simulator';

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const nf0 = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 0 });

// ---------- janela "Configurar" ----------

function ConfigureDialog({ robot, onClose, onSaved }: { robot: RobotWithoutGain; onClose: () => void; onSaved: (message: string) => void | Promise<void> }) {
  const hasMetrics = robot.metrics.length > 0;
  const [time, setTime] = useState('');
  const [unit, setUnit] = useState<TimeUnit>('minutes');
  const [label, setLabel] = useState(robot.unitLabel && robot.unitLabel !== 'item' ? robot.unitLabel : '');
  const [mode, setMode] = useState<'execution' | 'metric'>(hasMetrics ? 'metric' : 'execution');
  const [metricKey, setMetricKey] = useState(hasMetrics ? robot.metrics[0].key : '');
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
  const keyToSave = mode === 'execution' ? DEFAULT_METRIC_KEY : normalizeMetricKey(metricKey) || DEFAULT_METRIC_KEY;
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

export function RobotsWithoutGain({
  from,
  to,
  departmentLabel,
  notify,
  onChanged,
  sub,
  onSub,
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
}) {
  const { hub } = useHub();
  const [data, setData] = useState<RobotsWithoutGainResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<RobotWithoutGain | null>(null);
  const seq = useRef(0);

  const load = useCallback(() => {
    const id = ++seq.current;
    setLoading(true);
    const query = new URLSearchParams();
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

  const robots = data?.robots ?? [];
  const hubRobots = (hub?.robots ?? [])
    .filter((r) => r.isActive && !r.isExternal)
    .map((r) => ({ id: r.id, name: r.name, manualSecondsPerUnit: r.manualSecondsPerUnit ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const totalRuns = robots.reduce((sum, r) => sum + r.executions, 0);
  const withRuns = robots.filter((r) => r.executions > 0).length;

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

  return (
    <section aria-busy={loading} className={cn('min-w-0 space-y-5 transition-opacity', loading && 'opacity-60')}>
      <div role="group" aria-label="Seção" className="inline-flex overflow-hidden rounded-xl border border-slate-300 dark:border-[#2b2b31]">
        {(
          [
            ['lista', 'Lista'],
            ['sim', 'Simular ganhos'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={sub === id}
            onClick={() => onSub(id)}
            className={cn(
              'px-3 py-2 text-sm transition',
              sub === id ? 'bg-slate-950 text-white dark:bg-white dark:text-slate-950' : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-[#0f0f10] dark:text-zinc-300 dark:hover:bg-[#18181b]',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {sub === 'sim' ? (
        <GainSimulator
          from={from}
          to={to}
          hubRobots={hubRobots}
          withoutGain={robots}
          notify={notify}
          onApplied={async () => {
            await load();
            onChanged();
          }}
        />
      ) : null}

      {sub === 'lista' ? (
      <>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight text-slate-950 dark:text-white">Robôs sem ganho</h2>
        <p className="max-w-3xl text-sm text-slate-500 dark:text-zinc-400">
          Robôs ativos do Hub sem tempo manual configurado: toda execução deles entra no relatório com 0 h, e o relatório subestima o ganho.
          Informe quanto tempo uma pessoa levaria à mão e como contar os itens. Vale só daqui para frente.
        </p>
      </div>

      {robots.length === 0 ? (
        <p className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-6 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-950/30 dark:text-emerald-200">
          Todos os robôs ativos do Hub têm tempo manual configurado.
        </p>
      ) : (
        <>
          <p className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-100">
            <strong>
              {robots.length} {plural(robots.length, 'robô ativo sem tempo manual', 'robôs ativos sem tempo manual')}.
            </strong>
            {totalRuns > 0
              ? ` ${withRuns} ${plural(withRuns, 'rodou', 'rodaram')} ${nf0(totalRuns)} ${plural(totalRuns, 'vez', 'vezes')} no período e não somou nada.`
              : ' Nenhum rodou com sucesso no período mostrado.'}
          </p>

          <div className="overflow-hidden rounded-2xl border border-slate-200 dark:border-[#27272a]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Robô</TableHead>
                  <TableHead>Departamentos</TableHead>
                  <TableHead className="text-right">Execuções no período</TableHead>
                  <TableHead>Última execução</TableHead>
                  <TableHead>Métricas que o robô informa</TableHead>
                  <TableHead className="relative text-right">
                    <span className="sr-only">Ações</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {robots.map((robot) => (
                  <TableRow key={robot.robotId}>
                    <TableCell>
                      <div className="font-medium text-slate-900 dark:text-zinc-100">{robot.name}</div>
                      <div className="text-xs text-slate-400 dark:text-zinc-500">{robot.slug}</div>
                    </TableCell>
                    <TableCell className="text-slate-600 dark:text-zinc-300">
                      {robot.departments.length ? robot.departments.map(departmentLabel).join(', ') : 'Todos'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {robot.executions > 0 ? nf0(robot.executions) : <span className="text-slate-400 dark:text-zinc-500">nenhuma</span>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-slate-600 dark:text-zinc-300">
                      {robot.lastExecutionAt ? formatDateTime(robot.lastExecutionAt) : '—'}
                    </TableCell>
                    <TableCell>
                      {robot.metrics.length ? (
                        <div className="flex flex-wrap gap-1">
                          {robot.metrics.slice(0, 3).map((m) => (
                            <Badge key={m.key} variant="muted" title={`${m.key}: informada em ${m.executions} ${plural(m.executions, 'execução', 'execuções')}, média de ${formatNumber(m.total / Math.max(1, m.executions), 1)} por execução`}>
                              {m.key} · {formatNumber(m.total / Math.max(1, m.executions), 1)}/exec.
                            </Badge>
                          ))}
                          {robot.metrics.length > 3 ? <span className="text-xs text-slate-400">+{robot.metrics.length - 3}</span> : null}
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400 dark:text-zinc-500">nenhuma (conta 1 item por execução)</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setEditing(robot)} aria-label={`Configurar o tempo manual de ${robot.name}`}>
                        <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
                        Configurar
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-slate-400 dark:text-zinc-500">
            As métricas vêm dos logs das execuções do período, que o Hub apaga depois de alguns dias; execuções antigas podem não mostrar nenhuma. Robôs externos
            não aparecem aqui: o sistema deles informa o tempo ganho de cada execução.
          </p>
        </>
      )}

      </>
      ) : null}

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
    </section>
  );
}
