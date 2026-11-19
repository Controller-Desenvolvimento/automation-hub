// Simulador de ganhos (aba "Robôs sem ganho" do Tempo ganho). Funções puras: nada aqui lê o banco nem grava nada.
// A conta repete a do protótipo aprovado: projeta as execuções REAIS do período para 1 mês, robô por robô.

import { dayStart as reportDayStart, toReportDay } from './time-savings-metrics';

export const MONTH_DAYS = 30.4375; // dias de um mês médio (só para referência: a projeção usa meses do calendário, ver `monthsBetween`)
export const BUSINESS_DAYS = 21; // dias úteis por mês (pessoas equivalentes = horas por mês ÷ (jornada × 21))
export const DAY_MS = 86_400_000;
export const MAX_SIM_SECONDS = 86_400; // o mesmo teto do tempo manual configurado

export type SimBase = 'exec' | 'item';
export type SimScope = 'sem' | 'todos';

export type SimExecution = {
  finishedAt: number;
  scheduled: boolean;
  /** Ganho já gravado na execução (o que o relatório mostra hoje). */
  storedGain: number;
  /** Itens desta execução (só no modo "por item"); null = a execução não informou e será estimada pela média do robô. */
  units: number | null;
};

export type SimRobot = {
  robotId: string;
  name: string;
  /** Tem tempo manual configurado hoje (só aparece no escopo "somando os que já têm ganho"). */
  hasTime: boolean;
  executions: SimExecution[];
  /** Primeira execução do robô (ms): um robô que começou há 20 dias não é diluído no período inteiro. */
  firstAt: number | null;
  /** Média de itens por execução fora do período (usada quando o robô não rodou nele). */
  fallbackAvgItems: number | null;
  /** Métrica que o robô mais informa (a que vale como "item") e a média por execução, para mostrar na tela. */
  metricKey?: string | null;
  metricAvg?: number | null;
};

export type SimInput = {
  robots: SimRobot[];
  base: SimBase;
  /** Segundos por item (ou por execução) escolhidos para cada robô; ausente = sem estimativa (mantém o tempo atual se já tem). */
  times: Record<string, number>;
  /** Jornada da pessoa, em horas por dia (padrão 7: a mesma do relatório). */
  workdayHours: number;
  /** Início e fim do período em ms (null = todo o histórico / até hoje) e "agora". */
  from: number | null;
  to?: number | null;
  now: number;
  /** Ganho total do relatório no período, em segundos (para comparar o simulado com o que o relatório mostra). */
  reportSavedSeconds: number;
};

export type SimSource = 'atual' | 'novo' | 'informado' | 'nenhum';

export type SimRow = {
  robotId: string;
  name: string;
  hasTime: boolean;
  executions: number;
  scheduled: number;
  /** Segundos por mês, hoje e simulado. */
  currentMonth: number;
  simulatedMonth: number;
  source: SimSource;
  /** Segundos que cada execução somaria (null quando o robô mantém o tempo atual). */
  perExecution: number | null;
  avgItems: number | null;
  estimated: number;
  /** Dias de histórico do robô dentro do período. */
  days: number;
  /** Meses do calendário que o robô cobre no período (o divisor da projeção). */
  monthsCovered: number;
  /** Execuções por mês (projetadas). */
  executionsMonth: number;
  metricKey: string | null;
  metricAvg: number | null;
};

export type SimResult = {
  days: number;
  months: number;
  rows: SimRow[];
  currentMonth: number;
  simulatedMonth: number;
  /** Ganho a mais por mês (simulado − hoje). Pode ser negativo (novos tempos menores que os atuais). */
  extra: number;
  /** Parte do ganho a mais que vem dos robôs sem tempo / dos novos tempos de quem já tinha. */
  fromWithout: number;
  fromNewTimes: number;
  estimatedExecutions: number;
  reportMonth: number;
};

// Início do dia no fuso do relatório (o mesmo do resto da tela), e não no fuso em que o servidor estiver.
const dayStart = (ms: number) => reportDayStart(toReportDay(new Date(ms))).getTime();

/** Último dia do período: o "Até" escolhido, nunca depois de hoje. */
function periodEnd(input: Pick<SimInput, 'to' | 'now'>): number {
  const today = dayStart(input.now);
  return input.to === null || input.to === undefined || !Number.isFinite(input.to) ? today : Math.min(today, dayStart(input.to));
}

/** Início do período (ms): o "De" ou, no histórico todo, o dia da primeira execução. */
function periodStart(input: Pick<SimInput, 'robots' | 'from' | 'now'>): number {
  if (input.from !== null && Number.isFinite(input.from)) return dayStart(input.from);
  let first = Infinity;
  for (const r of input.robots) if (r.firstAt && r.firstAt < first) first = r.firstAt;
  return Number.isFinite(first) ? dayStart(first) : dayStart(input.now);
}

export function periodDays(input: Pick<SimInput, 'robots' | 'from' | 'to' | 'now'>): number {
  // dias corridos entre o início e o fim do período (o "Até", ou hoje), contando os dois; o horário de agora não vira um dia a mais
  return Math.max(1, Math.round((periodEnd(input) - periodStart(input)) / DAY_MS) + 1);
}

/**
 * Quantos "meses" tem um intervalo de dias, pelo calendário: um mês inteiro vale exatamente 1 (outubro = 1, fevereiro = 1) e um
 * pedaço de mês vale a fração dos dias dele (19 dias de novembro = 19/30). Assim 119 execuções de 5 min em outubro inteiro dão
 * 9,9 h por mês, e não 9,7 h (que sairia de dividir 31 dias por um mês "médio" de 30,4375).
 */
export function monthsBetween(startMs: number, endMs: number): number {
  const a = toReportDay(new Date(startMs));
  let b = toReportDay(new Date(endMs));
  if (b < a) b = a;
  let year = Number(a.slice(0, 4));
  let month = Number(a.slice(5, 7)); // 1..12
  const lastYear = Number(b.slice(0, 4));
  const lastMonth = Number(b.slice(5, 7));
  let total = 0;
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    const inMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const first = year === Number(a.slice(0, 4)) && month === Number(a.slice(5, 7)) ? Number(a.slice(8, 10)) : 1;
    const last = year === lastYear && month === lastMonth ? Number(b.slice(8, 10)) : inMonth;
    total += (last - first + 1) / inMonth;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return total;
}

/** Primeiro dia em que o robô conta no período: um robô que começou há 20 dias não é diluído no período inteiro. */
function robotStart(robot: SimRobot, input: Pick<SimInput, 'robots' | 'from' | 'now'>): number {
  const start = periodStart(input);
  return robot.firstAt ? Math.max(start, dayStart(robot.firstAt)) : start;
}

function robotDays(robot: SimRobot, input: Pick<SimInput, 'robots' | 'from' | 'to' | 'now'>): number {
  return Math.max(1, Math.round((periodEnd(input) - robotStart(robot, input)) / DAY_MS) + 1);
}

/** Itens de cada execução; as que não informaram a quantidade usam a média do robô (e contam como "estimadas"). */
function unitsOf(robot: SimRobot, base: SimBase, hasTimeRobot: boolean): { total: number; estimated: number; avg: number | null } {
  const list = robot.executions;
  if (base === 'exec' || list.length === 0) return { total: list.length, estimated: 0, avg: list.length ? 1 : robot.fallbackAvgItems };
  const known = list.filter((e) => e.units !== null) as Array<SimExecution & { units: number }>;
  const knownTotal = known.reduce((a, e) => a + e.units, 0);
  // Robô que já tem tempo configurado segue a regra do Hub: execução sem a quantidade conta 1 item.
  const fill = hasTimeRobot ? 1 : known.length ? knownTotal / known.length : 1;
  const missing = list.length - known.length;
  const total = knownTotal + missing * fill;
  return { total, estimated: hasTimeRobot ? 0 : missing, avg: total / list.length };
}

/** `mult` = faixa (×0,5 / ×1 / ×1,5): vale só para os tempos estimados dos robôs sem tempo; os novos tempos escolhidos não variam. */
export function simulate(input: SimInput, mult = 1): SimResult {
  const days = periodDays(input);
  const end = periodEnd(input);
  const months = Math.max(1 / 31, monthsBetween(periodStart(input), end));
  const rows: SimRow[] = [];
  let estimatedExecutions = 0;

  for (const robot of input.robots) {
    const list = robot.executions;
    const current = list.reduce((a, e) => a + e.storedGain, 0);
    const guess = input.times[robot.robotId];
    const has = Number.isFinite(guess) && guess > 0;
    const d = list.length ? robotDays(robot, input) : days;
    // meses do calendário que o robô cobre no período (um robô novo conta só desde o 1º dia dele)
    const mr = Math.max(1 / 31, list.length ? monthsBetween(robotStart(robot, input), end) : months);
    let simulated: number;
    let source: SimSource;
    let perExecution: number | null = null;
    let avgItems: number | null = null;
    let estimated = 0;

    if (robot.hasTime) {
      if (!has) {
        simulated = current;
        source = 'atual';
      } else {
        // novo tempo de quem já tem ganho: vale por item (a configuração dele já é por item)
        const u = unitsOf(robot, 'item', true);
        simulated = guess * u.total;
        source = 'novo';
        avgItems = list.length ? u.avg : robot.fallbackAvgItems;
        perExecution = guess * (avgItems ?? 1);
      }
    } else if (!has) {
      simulated = 0;
      source = 'nenhum';
    } else {
      const u = unitsOf(robot, input.base, false);
      simulated = guess * u.total * mult;
      source = 'informado';
      estimated = u.estimated;
      avgItems = input.base === 'item' ? u.avg : null;
      perExecution = guess * (input.base === 'item' ? u.avg ?? 1 : 1) * mult;
    }
    estimatedExecutions += estimated;
    rows.push({
      robotId: robot.robotId,
      name: robot.name,
      hasTime: robot.hasTime,
      executions: list.length,
      scheduled: list.filter((e) => e.scheduled).length,
      currentMonth: current / mr,
      simulatedMonth: simulated / mr,
      source,
      perExecution,
      avgItems,
      estimated,
      days: d,
      monthsCovered: mr,
      executionsMonth: list.length / mr,
      metricKey: robot.metricKey ?? null,
      metricAvg: robot.metricAvg ?? null,
    });
  }

  const delta = (r: SimRow) => r.simulatedMonth - r.currentMonth;
  const currentMonth = rows.reduce((a, r) => a + r.currentMonth, 0);
  const simulatedMonth = rows.reduce((a, r) => a + r.simulatedMonth, 0);
  return {
    days,
    months,
    rows,
    currentMonth,
    simulatedMonth,
    extra: simulatedMonth - currentMonth,
    fromWithout: rows.filter((r) => !r.hasTime).reduce((a, r) => a + delta(r), 0),
    fromNewTimes: rows.filter((r) => r.source === 'novo').reduce((a, r) => a + delta(r), 0),
    estimatedExecutions,
    reportMonth: input.reportSavedSeconds / months,
  };
}

/** Pessoas equivalentes = horas por mês ÷ (jornada × 21 dias úteis); aceita negativo (simulação que reduz o ganho). */
export const peopleOf = (secondsPerMonth: number, workdayHours: number) => secondsPerMonth / 3600 / (workdayHours * BUSINESS_DAYS);

// ---------- insights ----------

export type SimInsight = { kind: 'warn' | 'info'; icon: string; text: string };

export type SimInsightOptions = {
  base: SimBase;
  workdayHours: number;
  /** Unidade escolhida na tela (só para a frase "cada 1 min a mais"). */
  unit?: 'seconds' | 'minutes' | 'hours';
  scope?: SimScope;
  /** Robôs que usaram o tempo padrão (no modo "por robô"): quando há, avisa quantos. */
  defaultIds?: string[];
};

const UNIT_SECONDS = { seconds: 1, minutes: 60, hours: 3600 } as const;
const UNIT_AB = { seconds: 's', minutes: 'min', hours: 'h' } as const;

const nf = (v: number, d = 0) => v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const pl = (n: number, one: string, many: string) => `${nf(n)} ${n === 1 ? one : many}`;
function dur(sec: number) {
  const s = Math.round(sec || 0);
  if (s <= 0) return '0 h';
  if (s < 3600) return `${nf(Math.max(1, Math.round(s / 60)))} min`;
  const h = s / 3600;
  return `${nf(h, h < 10 ? 1 : 0)} h`;
}
const names = (rows: SimRow[]) => `${rows.slice(0, 3).map((r) => r.name).join(', ')}${rows.length > 3 ? '…' : ''}`;
const peopleTxt = (secondsPerMonth: number, jh: number) => {
  const p = Math.abs(peopleOf(secondsPerMonth, jh));
  const shown = nf(p, p < 10 ? 1 : 0);
  // a mesma regra dos indicadores da tela: 0 e 2 ou mais = "pessoas"; de 0,1 a 1,9 = "pessoa" ("0,3 pessoa", "1,8 pessoa")
  const rounded = p < 10 ? Math.round(p * 10) / 10 : Math.round(p);
  return `${shown} ${rounded === 0 || rounded >= 2 ? 'pessoas' : 'pessoa'}`;
};

/** Frases sobre o resultado: avisos primeiro (o que conferir), depois o que vale saber. */
export function simInsights(result: SimResult, input: SimInsightOptions): SimInsight[] {
  const { rows } = result;
  const jh = input.workdayHours;
  const warn: SimInsight[] = [];
  const out: SimInsight[] = [];
  const without = rows
    .filter((r) => !r.hasTime)
    .map((r) => ({ r, d: r.simulatedMonth - r.currentMonth }))
    .filter((x) => x.d > 0)
    .sort((a, b) => b.d - a.d);
  const totalPos = without.reduce((a, x) => a + x.d, 0);

  if (result.days < 14) warn.push({ kind: 'warn', icon: '!', text: `Projeção feita com só ${pl(result.days, 'dia', 'dias')} de execuções. Para uma média mais estável, escolha 30 ou 90 dias no período.` });
  const high = rows.filter((r) => r.perExecution !== null && r.perExecution > jh * 3600);
  for (const r of high.slice(0, 3)) warn.push({ kind: 'warn', icon: '!', text: `Confira ${r.name}: ${dur(r.perExecution!)} por execução, mais que uma jornada de ${nf(jh)} h. O tempo por item pode estar alto demais.` });
  if (high.length > 3) warn.push({ kind: 'warn', icon: '!', text: `Mais ${pl(high.length - 3, 'robô passa', 'robôs passam')} de uma jornada inteira por execução.` });
  const empty = rows.filter((r) => r.source === 'nenhum');
  if (empty.length) warn.push({ kind: 'warn', icon: '!', text: `${pl(empty.length, 'robô ficou', 'robôs ficaram')} sem tempo informado e não ${empty.length === 1 ? 'soma' : 'somam'} nada: ${names(empty)}.` });

  if (result.estimatedExecutions) out.push({ kind: 'info', icon: '≈', text: `${pl(result.estimatedExecutions, 'execução antiga foi estimada', 'execuções antigas foram estimadas')} pela média de itens do robô: o log com a quantidade já foi apagado pela retenção.` });
  const short = rows.filter((r) => r.executions > 0 && r.source !== 'atual' && r.source !== 'nenhum' && r.days < 30);
  if (short.length) out.push({ kind: 'info', icon: '⌛', text: `${names(short)} ${short.length === 1 ? 'tem' : 'têm'} menos de 30 dias de execuções no período: a projeção ${short.length === 1 ? 'dele' : 'deles'} é menos firme.` });
  if (without.length > 1) out.push({ kind: 'info', icon: '1º', text: `${without[0].r.name} responde por ${nf((without[0].d / totalPos) * 100)}% do ganho dos robôs sem tempo (${dur(without[0].d)} por mês).` });
  if (without.length >= 5) {
    const top3 = without.slice(0, 3).reduce((a, x) => a + x.d, 0);
    out.push({ kind: 'info', icon: '3', text: `Os 3 maiores somam ${nf((top3 / totalPos) * 100)}% desse ganho; os outros ${without.length - 3} pesam pouco.` });
  }
  if (result.reportMonth > 0 && dur(Math.abs(result.extra)) !== dur(0)) {
    out.push({ kind: 'info', icon: result.extra > 0 ? '↑' : '↓', text: `O tempo ganho do relatório passaria de ${dur(result.reportMonth)} para ${dur(result.reportMonth + result.extra)} por mês (${result.extra > 0 ? '+' : '−'}${nf(Math.abs(result.extra / result.reportMonth) * 100)}%).` });
  }
  const news = rows.filter((r) => r.source === 'novo');
  if (news.length) out.push({ kind: 'info', icon: '↻', text: `Novos tempos em ${pl(news.length, 'robô que já tem ganho', 'robôs que já têm ganho')}: ${result.fromNewTimes >= 0 ? '+' : '−'}${dur(Math.abs(result.fromNewTimes))} por mês em relação aos tempos atuais.${result.fromNewTimes < 0 ? ' Os tempos novos são menores que os cadastrados hoje.' : ''}` });
  // sensibilidade: o robô em que cada unidade de tempo a mais pesa mais no mês é o que vale estimar com mais cuidado
  const unitName = input.unit ?? 'minutes';
  const sens = rows
    .filter((r) => r.source === 'informado' && r.executions > 0)
    .map((r) => ({ r, s: ((input.base === 'exec' ? r.executions : r.executions * (r.avgItems || 1)) * UNIT_SECONDS[unitName]) / r.monthsCovered }))
    .sort((a, b) => b.s - a.s)[0];
  if (sens) out.push({ kind: 'info', icon: '±', text: `Cada 1 ${UNIT_AB[unitName]} a mais em ${sens.r.name} soma ~${dur(sens.s)} por mês: é o tempo que vale estimar com mais cuidado.` });
  if (totalPos > 0) {
    const sched = without.reduce((a, x) => a + (x.r.executions ? (x.d * x.r.scheduled) / x.r.executions : 0), 0) / totalPos;
    if (sched >= 0.5) out.push({ kind: 'info', icon: '⏱', text: `${nf(sched * 100)}% do ganho dos robôs sem tempo vem de execuções agendadas: o robô roda sozinho, sem ninguém precisar pedir.` });
  }
  if (input.scope === 'todos' && result.simulatedMonth > 0) {
    const without100 = rows.filter((r) => !r.hasTime).reduce((a, r) => a + r.simulatedMonth, 0);
    out.push({ kind: 'info', icon: '%', text: `Os robôs que hoje não têm ganho representariam ${nf((without100 / result.simulatedMonth) * 100)}% do total simulado destes robôs.` });
  }
  const idle = rows.filter((r) => r.executions === 0 && r.source !== 'nenhum' && r.source !== 'atual');
  if (idle.length) out.push({ kind: 'info', icon: '0', text: `${pl(idle.length, 'robô não rodou', 'robôs não rodaram')} no período (${names(idle)}): o tempo ${idle.length === 1 ? 'dele' : 'deles'} não muda o resultado.` });
  const usedDefault = rows.filter((r) => (input.defaultIds ?? []).includes(r.robotId) && r.source === 'informado');
  if (usedDefault.length) out.push({ kind: 'info', icon: '=', text: `${pl(usedDefault.length, 'robô usou', 'robôs usaram')} o tempo padrão (não informado um a um).` });
  if (dur(Math.abs(result.extra)) !== dur(0)) {
    out.push({
      kind: 'info',
      icon: '👥',
      text: `${result.extra > 0 ? `O ganho a mais equivale a ${peopleTxt(result.extra, jh)} trabalhando só nisso o mês todo` : `A simulação reduz o ganho em ${peopleTxt(result.extra, jh)}`}; o tempo ganho total equivaleria a ${peopleTxt(result.reportMonth + result.extra, jh)} (jornada de ${nf(jh)} h por dia, ${BUSINESS_DAYS} dias úteis).`,
    });
  }
  return [...warn, ...out];
}

// ---------- evolução mensal (até 12 meses) ----------

export type MonthlyPoint = {
  /** AAAA-MM (mês do relatório, fuso de São Paulo). */
  key: string;
  /** O mês corrente: ainda não terminou, então fica incompleto (sem projeção). */
  partial: boolean;
  /** Ganho do relatório no mês (todos os robôs e fontes), em segundos. */
  current: number;
  /** Ganho do relatório no mês só dos robôs da simulação. */
  currentSim: number;
  /** Extra simulado no mês, nas execuções reais dele. */
  extra: number;
};

export type MonthlyInput = Omit<SimInput, 'from' | 'reportSavedSeconds'> & {
  /** Execuções dos robôs da simulação nos últimos meses da janela (não só as do período escolhido). */
  windowMonths: number;
  /** Ganho do relatório por mês (AAAA-MM -> segundos). */
  currentByMonth: Record<string, number>;
  /** Primeiro dado de ganho do relatório (ms), para começar no 1º mês COMPLETO. */
  firstDataAt: number | null;
};

const monthKeyOf = (ms: number) => toReportDay(new Date(ms)).slice(0, 7);
const monthKeyAt = (year: number, month0: number) => `${year}-${String(month0 + 1).padStart(2, '0')}`;

/**
 * Ganho atual + extra simulado nas execuções reais de cada mês. Começa no 1º mês COMPLETO de dados (um mês em que o histórico
 * começa no meio daria uma variação falsa no mês seguinte). O mês corrente fica incompleto, sem projeção.
 */
export function simulateMonthly(input: MonthlyInput): { months: MonthlyPoint[]; cut: boolean } {
  const nowKey = monthKeyOf(input.now);
  const [ny, nm] = nowKey.split('-').map(Number);
  const points: MonthlyPoint[] = [];
  for (let i = input.windowMonths - 1; i >= 0; i--) {
    const d = new Date(ny, nm - 1 - i, 1);
    const key = monthKeyAt(d.getFullYear(), d.getMonth());
    points.push({ key, partial: key === nowKey, current: input.currentByMonth[key] ?? 0, currentSim: 0, extra: 0 });
  }
  const byKey = new Map(points.map((p) => [p.key, p]));
  for (const robot of input.robots) {
    const guess = input.times[robot.robotId];
    const has = Number.isFinite(guess) && guess > 0;
    const known = robot.executions.filter((e) => e.units !== null) as Array<SimExecution & { units: number }>;
    const avg = known.length ? known.reduce((a, e) => a + e.units, 0) / known.length : 1;
    for (const e of robot.executions) {
      const point = byKey.get(monthKeyOf(e.finishedAt));
      if (!point) continue;
      point.currentSim += e.storedGain;
      if (!has) continue;
      if (robot.hasTime) point.extra += guess * (e.units ?? 1) - e.storedGain; // novo tempo de quem já tem ganho: por item
      else point.extra += input.base === 'exec' ? guess : guess * (e.units ?? avg);
    }
  }
  const firstKey = input.firstDataAt === null ? null : monthKeyOf(input.firstDataAt);
  let months = points;
  // meses inteiramente antes do primeiro dado saem
  if (firstKey) months = months.filter((m) => m.key >= firstKey);
  // se o histórico começa no meio do primeiro mês, ele sai também (e há mais de um mês para mostrar)
  let cut = false;
  if (months.length > 1 && input.firstDataAt !== null) {
    const firstDay = toReportDay(new Date(input.firstDataAt));
    if (firstDay.slice(0, 7) === months[0].key && firstDay.slice(8, 10) !== '01') {
      months = months.slice(1);
      cut = true;
    }
  }
  return { months, cut };
}

