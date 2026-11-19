// Etapa 3 da Saúde dos robôs: capacidade do servidor (horários de pico) e ciclos dos agendamentos. Funções puras.
import { createClassifier, dayKey, type HealthExecution } from './robot-health-metrics';

export type CancelReason = 'mao' | 't2' | 'teto' | 'pulada';

/** Motivo de uma execução cancelada, pela mensagem que o Hub grava; sem mensagem = cancelada à mão. */
export function cancelReasonOf(message: string | null | undefined): CancelReason {
  const m = message ?? '';
  if (/passou do limite de verifica/i.test(m)) return 't2';
  if (/passou do tempo m[aá]ximo/i.test(m)) return 'teto';
  if (/^Pulada/i.test(m)) return 'pulada';
  return 'mao';
}

// ---------- capacidade: quantos robôs rodam ao mesmo tempo, por hora do dia ----------

export type HourStat = {
  /** Tempo observado nesta hora do dia, somando todos os dias do período (ms). */
  ms: number;
  busyMs: number;
  sumMs: number;
  /** Maior número de robôs ao mesmo tempo em algum momento desta hora. */
  peak: number;
  peakAt: string | null;
  /** Em quantos dias do período esta hora chegou ao limite do servidor. */
  daysLimit: number;
  days: number;
  /** Fração do tempo com pelo menos 1 robô rodando. */
  busyShare: number;
  /** Minutos de robô rodando por dia, em média (somando todos os robôs). */
  minutesPerDay: number;
};

export type Capacity = {
  limit: number;
  hours: HourStat[];
  any: boolean;
  busiest: number;
  atLimit: number[];
  mostBusy: number;
  quiet: { best: number; hours: number[]; ranges: Array<[number, number]> };
};

const HOUR_MS = 3_600_000;

/**
 * Percorre os inícios e fins das execuções: entre dois eventos o número de robôs rodando é constante (exato, inclusive para
 * execuções de menos de 1 minuto). Ficam de fora as interrompidas pelo reinício do Hub (o fim gravado delas não é o real).
 */
export function capacityByHour(list: HealthExecution[], from: Date, to: Date, limit: number, now = new Date(), classify = createClassifier()): Capacity {
  const a = from.getTime();
  const b = Math.min(now.getTime(), to.getTime());
  const events: Array<[number, number]> = [];
  for (const e of list) {
    if (!e.startedAt || !e.finishedAt) continue;
    if (e.status === 'error' && classify(e.errorMessage).category === 'hub') continue;
    const start = Math.max(a, e.startedAt.getTime());
    const end = Math.min(b, e.finishedAt.getTime());
    if (end <= start) continue;
    events.push([start, 1], [end, -1]);
  }
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1]); // fim antes de início no mesmo instante
  const hours = Array.from({ length: 24 }, () => ({ ms: 0, busyMs: 0, sumMs: 0, peak: 0, peakAt: null as number | null }));
  const dayMax = new Map<string, number>();
  const add = (t0: number, t1: number, c: number) => {
    for (let t = t0; t < t1; ) {
      const d = new Date(t);
      const hh = d.getHours();
      const end = Math.min(t1, new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh + 1).getTime());
      const o = hours[hh];
      const len = end - t;
      o.ms += len;
      if (c > 0) {
        o.busyMs += len;
        o.sumMs += c * len;
      }
      if (c > o.peak) {
        o.peak = c;
        o.peakAt = t;
      }
      const key = `${dayKey(d)}#${hh}`;
      dayMax.set(key, Math.max(dayMax.get(key) ?? 0, c));
      t = end;
    }
  };
  let t = a;
  let c = 0;
  for (const [ti, delta] of events) {
    if (ti > t) {
      add(t, ti, c);
      t = ti;
    }
    c += delta;
  }
  if (b > t) add(t, b, c);
  const daysLimit = new Array<number>(24).fill(0);
  for (const [key, v] of dayMax) if (v >= limit) daysLimit[Number(key.split('#')[1])] += 1;
  const stats: HourStat[] = hours.map((o, i) => {
    const days = Math.max(1, Math.round(o.ms / HOUR_MS));
    return {
      ms: o.ms,
      busyMs: o.busyMs,
      sumMs: o.sumMs,
      peak: o.peak,
      peakAt: o.peakAt === null ? null : new Date(o.peakAt).toISOString(),
      daysLimit: daysLimit[i],
      days,
      busyShare: o.ms ? o.busyMs / o.ms : 0,
      minutesPerDay: o.sumMs / 60000 / days,
    };
  });
  const idx = [...Array(24).keys()];
  const busiest = idx.slice().sort((x, y) => stats[y].peak - stats[x].peak || stats[y].busyShare - stats[x].busyShare)[0];
  const mostBusy = idx.slice().sort((x, y) => stats[y].busyShare - stats[x].busyShare)[0];
  return { limit, hours: stats, any: stats.some((s) => s.peak > 0), busiest, atLimit: idx.filter((i) => stats[i].peak >= limit), mostBusy, quiet: quietHours(stats) };
}

/** Melhor(es) horário(s) para agendar: nas 24 h, o de menor pico e menor ocupação; se vários empatam, devolve todos, em faixas. */
export function quietHours(stats: HourStat[]) {
  const withData = [...Array(24).keys()].filter((i) => stats[i].ms > 0);
  const idx = withData.length ? withData : [...Array(24).keys()];
  const best = idx.slice().sort((x, y) => stats[x].peak - stats[y].peak || stats[x].busyShare - stats[y].busyShare || x - y)[0];
  const free = idx.filter((i) => stats[i].peak === stats[best].peak && stats[i].busyShare === stats[best].busyShare);
  const ranges: Array<[number, number]> = [];
  for (const i of free) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else ranges.push([i, i + 1]);
  }
  // 23h–0h e 0h–9h viram 23h–9h
  if (ranges.length > 1 && ranges[0][0] === 0 && ranges[ranges.length - 1][1] === 24) {
    const tail = ranges.pop()!;
    ranges[0][0] = tail[0];
  }
  return { best, hours: free, ranges };
}

// ---------- ciclos dos agendamentos ----------

export type CycleExecution = Pick<HealthExecution, 'id' | 'robotId' | 'createdAt'> & {
  status: 'success' | 'error' | 'canceled' | 'queued' | 'running';
  scheduledTaskId: string | null;
  attempt: number;
  restartOfId: string | null;
};

export type CycleRow = {
  taskId: string;
  ok: number;
  recovered: number;
  failed: number;
  canceled: number;
  /** Ciclos ainda em andamento (não entram nas contas). */
  attempting: number;
  hasRestart: boolean;
};

/**
 * Um ciclo é a execução do horário mais o reinício, se houve. "Falhou de vez" = terminou em erro e, se o agendamento tem
 * reinício automático (T0/T1/T2), o reinício também falhou. Cancelada (à mão, teto de tempo) e pulada não são falha do robô.
 */
export function cyclesOf(tasks: Array<{ id: string; hasRestart: boolean }>, executions: CycleExecution[], from: Date, to: Date): CycleRow[] {
  const rows = new Map<string, CycleRow>(tasks.map((t) => [t.id, { taskId: t.id, ok: 0, recovered: 0, failed: 0, canceled: 0, attempting: 0, hasRestart: t.hasRestart }]));
  const restarts = new Map<string, CycleExecution[]>();
  for (const e of executions) {
    if (e.restartOfId) restarts.set(e.restartOfId, [...(restarts.get(e.restartOfId) ?? []), e]);
  }
  for (const e of executions) {
    if (!e.scheduledTaskId || e.restartOfId || e.attempt > 1) continue;
    if (e.createdAt < from || e.createdAt > to) continue;
    const row = rows.get(e.scheduledTaskId);
    if (!row) continue;
    if (e.status === 'success') {
      row.ok += 1;
      continue;
    }
    const rs = (restarts.get(e.id) ?? []).sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
    const last = rs.length ? rs[rs.length - 1] : e;
    if (rs.length && last.status === 'success') row.recovered += 1;
    else if (last.status === 'queued' || last.status === 'running') row.attempting += 1;
    else if (last.status === 'canceled') row.canceled += 1;
    else row.failed += 1;
  }
  return [...rows.values()];
}
