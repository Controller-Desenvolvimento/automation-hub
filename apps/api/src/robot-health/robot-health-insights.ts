// Insights da Saúde dos robôs: frases prontas, calculadas por regras fixas (sem IA) sobre os mesmos dados dos gráficos.
// Cada regra só aparece com amostra mínima. Funções puras (sem banco): o serviço monta a entrada.
import { CATEGORY_INFO, type ErrorCategory } from './error-causes';
import { cancelReasonOf, type Capacity, type CycleRow } from './robot-health-server';
import { MIN_CONCLUDED, createClassifier, situationOf, summarize, type HealthExecution, type Totals } from './robot-health-metrics';

export type InsightSeverity = 'crit' | 'warn' | 'info' | 'good';
export type InsightTarget = 'visao' | 'robos' | 'erros' | 'duracao' | 'servidor' | 'agend';

export type Insight = {
  id: string;
  sev: InsightSeverity;
  pri: number;
  /** "robo" = cartão de um robô (junta tudo o que ele tem de problema). */
  kind?: 'robo';
  title: string;
  text: string;
  why: string;
  facts?: Array<{ sev: 'crit' | 'warn' | 'info'; t: string }>;
  chipsLabel?: string;
  chips?: Array<{ t: string; n: string }>;
  acts?: Array<{ l: string; go: InsightTarget }>;
};

export type InsightInput = {
  current: HealthExecution[];
  previous: HealthExecution[] | null;
  days: number;
  from: string; // AAAA-MM-DD
  to: string;
  previousRange: { from: string; to: string } | null;
  robotNames: Map<string, string>;
  capacity: Capacity | null;
  cycles: Array<CycleRow & { name: string; robotName: string }>;
  /** Limite de reinício (T2) de cada agendamento, em minutos. */
  taskT2: Map<string, number>;
};

// ---------- texto ----------

const nf = (v: number | null | undefined, d = 0) => (v === null || v === undefined ? '—' : v.toLocaleString('pt-BR', { maximumFractionDigits: d, minimumFractionDigits: d }));
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
const pl = (n: number, one: string, many: string) => `${nf(n)} ${n === 1 ? one : many}`;
const mins = (seconds: number | null | undefined) => {
  if (seconds === null || seconds === undefined) return '—';
  const v = seconds / 60;
  return `${v < 10 ? nf(v, 1) : nf(Math.round(v))} min`;
};
const day = (key: string) => `${key.slice(8, 10)}/${key.slice(5, 7)}`;
const joinPt = (a: string[]) => (a.length > 2 ? `${a.slice(0, -1).join(', ')} e ${a[a.length - 1]}` : a.join(' e '));
const hourLabel = (h: number) => `${h}h–${(h + 1) % 24}h`;
const pctTxt = (v: number) => (v > 0 && v < 0.01 ? '<1%' : `${Math.round(v * 100)}%`);

const FILT = '\n\nVale para o período e os filtros atuais.';
const SEV_ORDER: Record<InsightSeverity, number> = { crit: 0, warn: 1, info: 2, good: 3 };
const WAIT_LIMIT_MIN = 5;
/** Quando cada recurso entrou no Hub (fatos fixos). */
const REINICIO_DESDE = '14–16/11/2026';
const T2_DESDE = '13/11/2026';
const T2_LIVE = new Date(2026, 10, 13, 0, 0, 0).getTime();
const SUCCESS_NOTE =
  'Atenção: "sucesso" aqui só quer dizer que o robô encerrou devolvendo código de saída 0 ao Hub. Ele pode ter tido falhas no caminho (dados que faltaram, etapa que não funcionou, erro tratado pelo próprio robô) e mesmo assim encerrar com 0. Por isso "sucesso" não garante que o trabalho saiu certo: uma execução que demora demais pode estar com problema e ainda assim ser marcada como sucesso.';

function group(list: HealthExecution[]) {
  const map = new Map<string, HealthExecution[]>();
  for (const e of list) map.set(e.robotId, [...(map.get(e.robotId) ?? []), e]);
  return map;
}

/** Ordena as frases: gravidade e, dentro dela, a prioridade (maior primeiro). */
export function buildInsights(input: InsightInput): Insight[] {
  const classify = createClassifier();
  const out: Insight[] = [];
  const add = (i: Insight) => out.push(i);
  const cur = summarize(input.current, classify);
  const prev: Totals | null = input.previous ? summarize(input.previous, classify) : null;
  if (!cur.executions) return out;

  const name = (id: string) => input.robotNames.get(id) ?? 'Robô removido';
  const curBy = group(input.current);
  const prevBy = input.previous ? group(input.previous) : new Map<string, HealthExecution[]>();
  const curTxt = `${day(input.from)} a ${day(input.to)}`;
  const vs = input.previousRange ? `${day(input.previousRange.from)} a ${day(input.previousRange.to)}` : 'sem período anterior';
  const catOf = (e: HealthExecution): ErrorCategory => classify(e.errorMessage).category;

  // 1. erros sem motivo informado
  if (cur.errorsAll >= 10 && cur.semErrors / cur.errorsAll >= 0.5) {
    const share = cur.semErrors / cur.errorsAll;
    const perRobot = [...curBy.entries()]
      .map(([id, list]) => ({ id, n: list.filter((e) => e.status === 'error' && catOf(e) === 'sem').length }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, 3);
    add({
      id: 'sem-causa', sev: share >= 0.8 ? 'crit' : 'warn', pri: cur.semErrors, title: `${pct(share)} dos erros não dizem o motivo`,
      text: `${nf(cur.semErrors)} de ${pl(cur.errorsAll, 'erro', 'erros')} terminaram só com o código de saída, sem o robô escrever a causa. Sem o motivo, ninguém sabe o que corrigir.${perRobot.length ? ` Os robôs com mais casos: ${joinPt(perRobot.map((x) => `${name(x.id)} (${x.n})`))}.` : ''}`,
      why: `Erros da categoria "Sem causa" ÷ todos os erros do período: ${nf(cur.semErrors)} de ${nf(cur.errorsAll)} (${pct(share)}). Aparece com 10 erros ou mais e quando a parcela passa de 50%; 80% ou mais é crítico. A causa só existe quando o robô termina com uma linha de erro explicando o que houve.${FILT}`,
      acts: [{ l: 'Ver as causas', go: 'erros' }],
    });
  }

  // 2. ficha por robô: junta num cartão só tudo o que um robô tem de problema
  const W = { crit: 100, warn: 10, info: 1 } as const;
  const fichas = new Map<string, Array<{ sev: 'crit' | 'warn' | 'info'; t: string }>>();
  const fato = (id: string, sev: 'crit' | 'warn' | 'info', t: string) => fichas.set(id, [...(fichas.get(id) ?? []), { sev, t }]);
  const errTotal = cur.errors;
  for (const [id, list] of curBy) {
    const s = summarize(list, classify);
    const ps = prevBy.has(id) ? summarize(prevBy.get(id)!, classify) : null;
    const lastOk = list.filter((e) => e.status === 'success').reduce((m, e) => Math.max(m, e.createdAt.getTime()), 0);
    if (s.success === 0 && s.errors >= 3) {
      fato(id, 'crit', `Nenhum sucesso no período: ${pl(s.errors, 'erro', 'erros')}${lastOk ? `; último sucesso em ${day(new Date(lastOk).toISOString().slice(0, 10))}` : '; nenhum sucesso no período'}.`);
    } else if (situationOf(s.concluded, s.errors) === 'critical') {
      fato(id, 'crit', `Situação crítica: ${pct(s.errors / s.concluded)} de erro (${nf(s.errors)} de ${pl(s.concluded, 'concluída', 'concluídas')}).`);
    }
    if (ps && ps.concluded >= MIN_CONCLUDED && s.errors - ps.errors >= 3 && s.errors / input.days > (ps.errors / input.days) * 1.5) {
      fato(id, 'warn', `Mais erros que no período anterior: de ${ps.errors} para ${s.errors}.`);
    }
    const sem = list.filter((e) => e.status === 'error' && catOf(e) === 'sem').length;
    if (sem >= 5 && s.errorsAll && sem / s.errorsAll >= 0.5) fato(id, 'warn', `${pl(sem, 'erro sem motivo informado', 'erros sem motivo informado')} (${pct(sem / s.errorsAll)} dos erros dele).`);
    const byHand = list.filter((e) => e.status === 'canceled' && cancelReasonOf(e.errorMessage) === 'mao').length;
    if (byHand >= 3 && byHand / s.executions >= 0.2) fato(id, 'warn', `${pct(byHand / s.executions)} das execuções foram canceladas à mão (${nf(byHand)} de ${nf(s.executions)}). Pode esconder robô travado ou execução pedida errada.`);
    if (ps && s.durationSamples >= 10 && ps.durationSamples >= 10 && s.medianDurationSeconds !== null && ps.medianDurationSeconds !== null) {
      const ch = (s.medianDurationSeconds - ps.medianDurationSeconds) / ps.medianDurationSeconds;
      if (ch >= 0.4 && s.medianDurationSeconds - ps.medianDurationSeconds >= 120) fato(id, 'warn', `Ficou mais lento: tempo típico de ${mins(ps.medianDurationSeconds)} para ${mins(s.medianDurationSeconds)}.`);
    }
    if (errTotal >= 20 && s.errors / errTotal >= 0.2) fato(id, 'info', `Concentra ${pct(s.errors / errTotal)} dos erros do período.`);
  }
  const fichaWhy = `Junta num cartão só o que este robô tem de problema no período. Regras: nenhum sucesso (3 erros ou mais, nenhum sucesso); situação crítica (40% de erro ou mais, com 5 concluídas ou mais); mais erros que no período anterior (3 a mais e 50% a mais por dia, comparando com ${vs}); erros sem motivo (5 ou mais e metade ou mais dos erros dele); canceladas à mão (3 ou mais e 20% ou mais das execuções; as canceladas pelo Hub, como T2, teto de tempo ou agendamento pulado, não contam); mais lento (tempo típico 40% maior e 2 min a mais, com 10 sucessos ou mais em cada período); concentra 20% ou mais dos erros do período. Erros causados pelo reinício do Hub não entram. O cartão aparece quando há pelo menos um ponto crítico ou de atenção.${FILT}`;
  for (const [id, facts] of fichas) {
    if (!facts.some((f) => f.sev === 'crit' || f.sev === 'warn')) continue;
    facts.sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev]);
    const s = summarize(curBy.get(id)!, classify);
    const sit = situationOf(s.concluded, s.errors);
    add({
      id: `robo-${id}`, kind: 'robo', sev: facts[0].sev, pri: facts.reduce((a, f) => a + W[f.sev], 0) + s.errors / 1000, title: name(id),
      text: `${sit === 'critical' ? 'Crítico' : sit === 'attention' ? 'Atenção' : sit === 'healthy' ? 'Saudável' : 'Poucos dados'} · ${pl(s.executions, 'execução', 'execuções')} no período`,
      facts, why: fichaWhy, acts: [{ l: 'Ver na tabela de robôs', go: 'robos' }, { l: 'Ver as causas', go: 'erros' }],
    });
  }

  // 3. a taxa de sucesso mudou
  if (prev && cur.concluded >= 20 && prev.concluded >= 20 && cur.successRate !== null && prev.successRate !== null) {
    const diff = (cur.successRate - prev.successRate) * 100;
    if (Math.abs(diff) >= 5) {
      const rows = [...curBy.entries()].map(([id, list]) => {
        const ce = summarize(list, classify).errors;
        const pe = prevBy.has(id) ? summarize(prevBy.get(id)!, classify).errors : 0;
        return { id, pe, ce, d: ce - pe };
      });
      const down = diff < 0;
      const who = (down ? rows.filter((x) => x.ce - x.pe >= 2).sort((a, b) => b.d - a.d) : rows.filter((x) => x.pe - x.ce >= 2).sort((a, b) => a.d - b.d)).slice(0, 3);
      add({
        id: 'taxa-mudou', sev: down ? (diff <= -10 ? 'crit' : 'warn') : 'good', pri: Math.abs(diff), title: `A taxa de sucesso ${down ? 'caiu' : 'subiu'} ${nf(Math.abs(diff))} p.p.`,
        text: `Foi de ${pct(prev.successRate)} (${vs}) para ${pct(cur.successRate)} (${curTxt}).${who.length ? ` ${down ? 'Quem mais piorou' : 'Quem mais melhorou'}: ${joinPt(who.map((x) => `${name(x.id)} (${x.pe} → ${x.ce} erros)`))}.` : ''}`,
        why: `Taxa de sucesso = sucessos ÷ (sucessos + erros). Período atual (${curTxt}): ${pct(cur.successRate)}, ${nf(cur.success)} de ${nf(cur.concluded)}. Período comparado (${vs}): ${pct(prev.successRate)}, ${nf(prev.success)} de ${nf(prev.concluded)}. Só aparece com 20 execuções concluídas ou mais em cada período e diferença de 5 p.p. ou mais; queda de 10 p.p. ou mais é crítica. Os robôs listados são os que mais mudaram a quantidade de erros (com pelo menos 2 erros de diferença).${FILT}`,
        acts: [{ l: 'Ver taxa ao longo do tempo', go: 'visao' }, { l: 'Ver erros por robô', go: 'erros' }],
      });
    }
  }

  // 4. o que mais causa erro, por categoria
  if (cur.errorsAll >= 10) {
    const byCat = new Map<ErrorCategory, number>();
    const byCause = new Map<string, number>();
    const hubDays = new Set<string>();
    for (const e of input.current) {
      if (e.status !== 'error') continue;
      const c = classify(e.errorMessage);
      byCat.set(c.category, (byCat.get(c.category) ?? 0) + 1);
      byCause.set(`${c.category}|${c.cause}`, (byCause.get(`${c.category}|${c.cause}`) ?? 0) + 1);
      if (c.category === 'hub') hubDays.add(e.createdAt.toDateString());
    }
    const topCause = (k: ErrorCategory) => [...byCause.entries()].filter(([key]) => key.startsWith(`${k}|`)).sort((a, b) => b[1] - a[1])[0] ?? null;
    const catRule = (k: ErrorCategory, sev: InsightSeverity, title: string, lead: string) => {
      const n = byCat.get(k) ?? 0;
      if (n / cur.errorsAll < 0.25) return;
      const t = topCause(k);
      add({
        id: `cat-${k}`, sev, pri: n, title: `${title}${pct(n / cur.errorsAll)} dos erros`,
        text: `${lead}${t ? ` Causa mais comum: ${t[0].split('|')[1]} (${nf(t[1])}).` : ''}`,
        why: `Categoria "${CATEGORY_INFO[k].label}" (${CATEGORY_INFO[k].summary}): ${nf(n)} de ${nf(cur.errorsAll)} erros do período (${pct(n / cur.errorsAll)}). Aparece com 10 erros ou mais e quando a categoria passa de 25%.${FILT}`,
        acts: [{ l: 'Ver as causas', go: 'erros' }],
      });
    };
    catRule('robo', 'warn', 'Falhas do próprio robô: ', 'Tela que mudou, travamento ou erro de programação: quem corrige é a equipe do robô.');
    catRule('externo', 'info', 'Sistemas externos: ', 'Portal fora do ar, sessão presa ou erro HTTP. Não é defeito do robô, mas pode pedir nova tentativa ou outro horário.');
    catRule('entrada', 'info', 'Dados de entrada: ', 'Planilha, certificado ou senha com problema: a pessoa que roda precisa corrigir. Vale orientar ou validar antes.');
    catRule('config', 'warn', 'Cadastro do robô no Hub: ', 'Comando ou pasta de execução errada no cadastro: quem corrige é o administrador do Hub.');
    const hub = byCat.get('hub') ?? 0;
    if (hub > 0) {
      add({ id: 'hub-reinicio', sev: 'info', pri: hub, title: `${pl(hub, 'execução interrompida', 'execuções interrompidas')} por reinício do Hub`, text: `O Hub reiniciou em ${pl(hubDays.size, 'dia', 'dias')} do período e derrubou o que estava rodando.`, why: `Erros da categoria "Hub" (reinício do servidor). Os dias com reinício aparecem como um losango no gráfico "Execuções por dia".${FILT}`, acts: [{ l: 'Ver execuções por dia', go: 'visao' }] });
    } else if (cur.executions >= 30) {
      add({ id: 'hub-ok', sev: 'good', pri: 1, title: 'Nenhuma execução interrompida pelo Hub', text: 'O Hub não reiniciou nem derrubou execuções neste período.', why: `Nenhum erro da categoria "Hub" em ${pl(cur.executions, 'execução', 'execuções')}.${FILT}` });
    }
  } else if (cur.errorsAll === 0 && cur.executions >= 30) {
    add({ id: 'hub-ok', sev: 'good', pri: 1, title: 'Nenhuma execução interrompida pelo Hub', text: 'O Hub não reiniciou nem derrubou execuções neste período.', why: `Nenhum erro da categoria "Hub" em ${pl(cur.executions, 'execução', 'execuções')}.${FILT}` });
  }

  // 5. erros sem motivo diminuíram
  if (prev && cur.errorsAll >= 10 && prev.errorsAll >= 10) {
    const a = cur.semErrors / cur.errorsAll;
    const b = prev.semErrors / prev.errorsAll;
    if (b - a >= 0.15) {
      add({ id: 'sem-causa-caiu', sev: 'good', pri: (b - a) * 100, title: 'Os erros sem motivo diminuíram', text: `Eram ${pct(b)} dos erros (${vs}) e agora são ${pct(a)}. Os robôs estão informando mais a causa.`, why: `Parcela de erros "Sem causa" no período atual (${pct(a)}) contra o comparado (${pct(b)}). Aparece com 10 erros ou mais em cada período e queda de 15 p.p. ou mais. Período comparado: ${vs}.${FILT}`, acts: [{ l: 'Ver por categoria', go: 'erros' }] });
    }
  }

  // 7. robôs que ficaram mais rápidos
  const fast: Array<{ id: string; ch: number; t: string }> = [];
  for (const [id, list] of curBy) {
    const s = summarize(list, classify);
    const ps = prevBy.has(id) ? summarize(prevBy.get(id)!, classify) : null;
    if (!ps || s.durationSamples < 10 || ps.durationSamples < 10 || s.medianDurationSeconds === null || ps.medianDurationSeconds === null) continue;
    const ch = (s.medianDurationSeconds - ps.medianDurationSeconds) / ps.medianDurationSeconds;
    if (ch <= -0.4 && s.medianDurationSeconds - ps.medianDurationSeconds <= -120) fast.push({ id, ch, t: `${mins(ps.medianDurationSeconds)} → ${mins(s.medianDurationSeconds)}` });
  }
  if (fast.length) {
    add({
      id: 'mais-rapidos', sev: 'good', pri: fast.length * 10, title: fast.length === 1 ? '1 robô ficou bem mais rápido' : `${fast.length} robôs ficaram bem mais rápidos`, text: 'O tempo típico de execução caiu 40% ou mais.',
      chipsLabel: 'Robôs:', chips: fast.sort((a, b) => a.ch - b.ch).slice(0, 5).map((o) => ({ t: name(o.id), n: o.t })),
      why: `Tempo típico (mediana) das execuções com sucesso de cada robô, período atual contra o comparado (${vs}). Só entram robôs com 10 execuções com sucesso ou mais em cada período e queda de 40% ou mais (e pelo menos 2 minutos).${FILT}`,
      acts: [{ l: 'Ver duração', go: 'duracao' }],
    });
  }

  // 8. agendadas acima do limite de reinício (T2). O T2 só passou a existir em 13/11/2026.
  const t2late: Array<{ id: string; n: number; lim: number; max: number }> = [];
  const t2early: Array<{ id: string; n: number; share: number; lim: number; max: number }> = [];
  const scheduledOk = new Map<string, HealthExecution[]>();
  for (const e of input.current) {
    if (e.status !== 'success' || !e.scheduledTaskId || e.restartOfId || (e.attempt ?? 1) > 1 || !e.startedAt || !e.finishedAt || !input.taskT2.has(e.scheduledTaskId)) continue;
    scheduledOk.set(e.robotId, [...(scheduledOk.get(e.robotId) ?? []), e]);
  }
  for (const [id, list] of scheduledOk) {
    const secs = (e: HealthExecution) => (e.finishedAt!.getTime() - e.startedAt!.getTime()) / 1000;
    const over = list.filter((e) => secs(e) > input.taskT2.get(e.scheduledTaskId!)! * 60);
    const late = over.filter((e) => e.startedAt!.getTime() >= T2_LIVE);
    const early = over.filter((e) => e.startedAt!.getTime() < T2_LIVE);
    const mk = (l: HealthExecution[]) => ({ id, n: l.length, lim: Math.min(...l.map((e) => input.taskT2.get(e.scheduledTaskId!)!)), max: Math.max(...l.map(secs)) });
    if (late.length) t2late.push(mk(late));
    if (early.length >= 3 && early.length / list.length >= 0.03) t2early.push({ ...mk(early), share: early.length / list.length });
  }
  if (t2late.length) {
    add({
      id: 't2-passou', sev: 'warn', pri: 40, title: t2late.length === 1 ? '1 agendamento passou do limite de reinício com o T2 ligado' : `${t2late.length} agendamentos passaram do limite de reinício com o T2 ligado`,
      text: 'Execuções agendadas levaram mais que o limite e terminaram marcadas como sucesso, quando o T2 deveria ter cancelado e refeito. "Sucesso" aqui só quer dizer que o robô encerrou com código 0: ele pode ter tido falhas no caminho e mesmo assim sair como sucesso, então não prova que o trabalho saiu certo. Vale conferir a verificação desse agendamento e o resultado dessas execuções.',
      chipsLabel: 'Robôs:', chips: t2late.map((o) => ({ t: name(o.id), n: `${pl(o.n, 'execução', 'execuções')} > ${o.lim} min, a maior com ${mins(o.max)}` })),
      why: `Execuções agendadas marcadas como sucesso (só a 1ª tentativa de cada ciclo), iniciadas a partir de ${T2_DESDE} (quando o reinício por tempo T2 entrou no ar), que passaram do limite de T2 do próprio agendamento (${joinPt(t2late.map((o) => `${name(o.id)}: ${o.lim} min`))}). ${SUCCESS_NOTE}${FILT}`,
      acts: [{ l: 'Ver duração', go: 'duracao' }],
    });
  }
  if (t2early.length) {
    add({
      id: 't2-antes', sev: 'info', pri: 8, title: `Antes do T2 existir, ${t2early.length === 1 ? '1 agendamento passava' : `${t2early.length} agendamentos passavam`} do limite`,
      text: `O reinício por tempo (T2) entrou no ar em ${T2_DESDE}; antes disso nada cancelava uma execução longa. Elas acabavam marcadas como sucesso, mas isso só quer dizer que o robô encerrou com código 0: ele pode ter tido falhas no caminho (dados faltando, etapa que não funcionou) e mesmo assim sair como sucesso. Demorar tanto indica que algo não estava normal. Com o T2, teriam sido canceladas e refeitas.`,
      chipsLabel: 'Robôs:', chips: t2early.map((o) => ({ t: name(o.id), n: `${pl(o.n, 'execução', 'execuções')} > ${o.lim} min (${pct(o.share)}), a maior com ${mins(o.max)}` })),
      why: `Execuções agendadas marcadas como sucesso (só a 1ª tentativa de cada ciclo), iniciadas antes de ${T2_DESDE}, que levaram mais que o limite atual de T2 do agendamento (${joinPt(t2early.map((o) => `${name(o.id)}: ${o.lim} min`))}). É um retrato do passado: nessa época o limite não existia. ${SUCCESS_NOTE} Aparece com 3 execuções ou mais e pelo menos 3% das marcadas como sucesso.${FILT}`,
      acts: [{ l: 'Ver duração', go: 'duracao' }],
    });
  }

  // 9. capacidade do servidor
  const cap = input.capacity;
  if (cap?.any) {
    const hs = cap.hours;
    const atLimit = cap.atLimit;
    const peak = Math.max(...hs.map((o) => o.peak));
    const daysLimit = atLimit.reduce((a, i) => a + hs[i].daysLimit, 0);
    const capWhy = `Olhando o número de robôs rodando ao mesmo tempo (só os rodados pelo Hub, sem os interrompidos por reinício). O limite do servidor é ${cap.limit}. Ignora os filtros de origem (manual/agendada): só segue o período.`;
    if (atLimit.length) {
      add({
        id: 'cap-limite', sev: daysLimit >= 3 ? 'warn' : 'info', pri: 20 + daysLimit, title: `O servidor chegou ao limite em ${atLimit.length === 1 ? 'um horário' : pl(atLimit.length, 'horário', 'horários')}`,
        text: `Chegou a ${cap.limit} robôs ao mesmo tempo às ${joinPt(atLimit.slice(0, 6).map((i) => `${i}h (${pl(hs[i].daysLimit, 'dia', 'dias')})`))}${atLimit.length > 6 ? '…' : ''}. Nesses momentos as execuções novas esperam na fila.`,
        why: `${capWhy} Aparece quando alguma hora do dia chegou ao limite em algum momento; entre parênteses, em quantos dias do período isso aconteceu naquela hora.`, acts: [{ l: 'Ver horários de pico', go: 'servidor' }],
      });
    } else {
      add({ id: 'cap-ok', sev: 'good', pri: 5, title: 'O servidor nunca chegou ao limite', text: `O maior número de robôs ao mesmo tempo foi ${peak} (limite: ${cap.limit}): não faltou vaga no servidor. Se alguém esperou na fila, o motivo foi outro (robôs que não podem rodar juntos, memória cheia ou atualização do Hub).`, why: capWhy, acts: [{ l: 'Ver horários de pico', go: 'servidor' }] });
    }
    const q = cap.quiet;
    const txt = q.ranges.slice(0, 3).map(([a, b]) => `${a}h–${b % 24}h`);
    add({
      id: 'cap-silencio', sev: 'info', pri: 10, title: `${q.hours.length > 1 ? 'Bons horários para agendar: ' : 'Bom horário para agendar: '}${joinPt(txt)}${q.ranges.length > 3 ? '…' : ''}`,
      text: hs[q.best].peak ? `São os mais vazios do dia: no máximo ${pl(hs[q.best].peak, 'robô', 'robôs')} ao mesmo tempo e algum robô rodando em ${pctTxt(hs[q.best].busyShare)} do tempo.` : `Nenhum robô rodou ${q.hours.length > 1 ? 'nesses horários' : 'nesse horário'} no período.`,
      why: 'Considera as 24 horas, porque o agendamento roda sozinho no Hub. São os horários com menor pico e menor ocupação; quando vários empatam, aparecem todos. Ignora os filtros de origem (manual/agendada).', acts: [{ l: 'Ver horários de pico', go: 'servidor' }],
    });
  }

  // 10. fila das execuções manuais
  const waits = input.current.filter((e) => !e.scheduled && e.startedAt).map((e) => Math.max(0, (e.startedAt!.getTime() - e.createdAt.getTime()) / 60000)).sort((x, y) => x - y);
  if (waits.length >= 10) {
    const over = waits.filter((v) => v > WAIT_LIMIT_MIN);
    const share = over.length / waits.length;
    const med = waits[Math.floor((waits.length - 1) / 2)];
    const days = new Map<string, number>();
    for (const e of input.current) {
      if (!e.scheduled && e.startedAt && (e.startedAt.getTime() - e.createdAt.getTime()) / 60000 > WAIT_LIMIT_MIN) {
        const k = `${String(e.createdAt.getDate()).padStart(2, '0')}/${String(e.createdAt.getMonth() + 1).padStart(2, '0')}`;
        days.set(k, (days.get(k) ?? 0) + 1);
      }
    }
    const worst = [...days.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (share >= 0.05) {
      add({
        id: 'fila-manual', sev: share >= 0.15 ? 'warn' : 'info', pri: share * 100, title: `${pct(share)} das execuções manuais esperaram mais de ${WAIT_LIMIT_MIN} min`,
        text: `A espera típica é de ${med < 1 ? `${Math.max(1, Math.round(med * 60))} s` : `${nf(med, med < 10 ? 1 : 0)} min`}, mas ${pl(over.length, 'execução', 'execuções')} ficaram mais de ${WAIT_LIMIT_MIN} min na fila${worst.length ? `, concentradas em ${joinPt(worst.map(([d, n]) => `${d} (${n})`))}` : ''}. Quem pede uma execução manual fica olhando a tela parada.`,
        why: `Espera = início − pedido, só das execuções manuais (as agendadas esperam de propósito quando dependem de outra). ${pl(waits.length, 'execução manual', 'execuções manuais')} no período. Aparece quando 5% ou mais esperam mais de ${WAIT_LIMIT_MIN} min; 15% ou mais é atenção.${FILT}`,
        acts: [{ l: 'Ver horários de pico', go: 'servidor' }],
      });
    }
  }

  // 10b. canceladas
  const cn = { mao: 0, t2: 0, teto: 0, pulada: 0 };
  for (const e of input.current) if (e.status === 'canceled') cn[cancelReasonOf(e.errorMessage)] += 1;
  const cnWhy = 'Motivo pela mensagem que o Hub grava ao cancelar: T2 (cancela e reinicia), teto de tempo (cancela sem reiniciar) e "pulada" (o agendamento de que ela depende falhou). Sem mensagem = cancelada à mão: pela pessoa, por um administrador ou pelo botão "Atualizar agora" do deploy (o Hub não diferencia esses três). Canceladas ficam fora da taxa de sucesso.';
  if (cur.executions >= 30 && cn.mao / cur.executions >= 0.1) {
    add({ id: 'canc-mao', sev: 'warn', pri: 12, title: `${pct(cn.mao / cur.executions)} das execuções foram canceladas à mão`, text: `${nf(cn.mao)} de ${nf(cur.executions)} execuções foram canceladas por alguém. Elas ficam fora da taxa de sucesso, mas podem esconder robô travado ou execução pedida errada.`, why: `${cnWhy} Aparece com 30 execuções ou mais e 10% ou mais canceladas à mão.${FILT}`, acts: [{ l: 'Ver execuções por dia', go: 'visao' }] });
  }
  const auto = cn.t2 + cn.teto + cn.pulada;
  if (auto) {
    add({
      id: 'canc-hub', sev: 'info', pri: 9, title: `${pl(auto, 'execução cancelada', 'execuções canceladas')} pelo próprio Hub`,
      text: `${joinPt([cn.pulada ? pl(cn.pulada, 'pulada porque o agendamento de que depende falhou', 'puladas porque o agendamento de que dependem falhou') : '', cn.t2 ? pl(cn.t2, 'cancelada pelo T2 e reiniciada', 'canceladas pelo T2 e reiniciadas') : '', cn.teto ? pl(cn.teto, 'cancelada pelo teto de tempo, sem reinício', 'canceladas pelo teto de tempo, sem reinício') : ''].filter(Boolean))}. Não foram decisões de ninguém: são as regras dos agendamentos funcionando.`,
      why: `${cnWhy}${FILT}`, acts: [{ l: 'Ver ciclos agendados', go: 'agend' }],
    });
  }

  // 11. agendamentos
  const bad = input.cycles.filter((c) => c.ok + c.recovered + c.failed >= 3 && c.failed / (c.ok + c.recovered + c.failed) >= 0.5);
  const saved = input.cycles.reduce((a, c) => a + c.recovered, 0);
  if (bad.length) {
    const withRestart = bad.filter((c) => c.hasRestart).length;
    add({
      id: 'agend-falham', sev: 'crit', pri: 80 + bad.length, title: bad.length === 1 ? '1 agendamento falha de vez com frequência' : `${bad.length} agendamentos falham de vez com frequência`,
      text: withRestart === bad.length ? 'Em metade dos ciclos ou mais, nem o reinício automático deu jeito.' : withRestart === 0 ? `Em metade dos ciclos ou mais, a execução terminou em erro. ${bad.length === 1 ? 'Esse agendamento não tem' : 'Esses agendamentos não têm'} reinício automático configurado (T0/T1/T2).` : `Em metade dos ciclos ou mais, a execução terminou em erro (onde há reinício automático, ele também falhou; ${pl(bad.length - withRestart, 'agendamento não tem', 'agendamentos não têm')} reinício configurado).`,
      chipsLabel: 'Agendamentos:', chips: bad.map((c) => ({ t: c.name, n: `${c.failed} de ${pl(c.ok + c.recovered + c.failed, 'ciclo', 'ciclos')} falharam${c.hasRestart ? '' : ' (sem reinício)'}` })),
      why: 'Ciclo = a execução do horário mais o reinício, se houve. "Falhou de vez" = terminou em erro e, se o agendamento tem reinício automático (T0/T1/T2), o reinício também falhou. Canceladas e puladas não contam como falha nem entram na conta. Aparece com 3 ciclos ou mais e metade ou mais falhando. Vale o período; ignora os demais filtros.',
      acts: [{ l: 'Ver ciclos agendados', go: 'agend' }],
    });
  }
  if (saved > 0) {
    add({ id: 'agend-salvos', sev: 'good', pri: 15, title: `O reinício automático salvou ${pl(saved, 'ciclo', 'ciclos')}`, text: 'Execuções agendadas que falharam na primeira tentativa e deram certo no reinício, sem ninguém precisar agir.', why: `Ciclos em que a 1ª tentativa falhou e o reinício terminou com sucesso. O reinício automático por erro e por T2 só existe desde ${REINICIO_DESDE}, então períodos antigos mostram poucos casos. Vale o período.`, acts: [{ l: 'Ver ciclos agendados', go: 'agend' }] });
  }

  // 12. amostra pequena e 13. robôs saudáveis
  const sits = [...curBy.entries()].map(([id, list]) => ({ id, s: summarize(list, classify) })).map((x) => ({ ...x, sit: situationOf(x.s.concluded, x.s.errors) }));
  const few = sits.filter((x) => x.sit === 'few' && x.s.executions > 0);
  if (few.length >= 3) {
    add({
      id: 'poucos-dados', sev: 'info', pri: 1, title: `${few.length} robôs com poucos dados`, text: 'Têm menos de 5 execuções concluídas no período, então a taxa de erro deles ainda não é confiável.',
      chipsLabel: 'Alguns:', chips: few.sort((a, b) => b.s.executions - a.s.executions).slice(0, 4).map((x) => ({ t: name(x.id), n: pl(x.s.concluded, 'concluída', 'concluídas') })),
      why: `Robôs com menos de 5 execuções concluídas (sucesso ou erro) no período ficam em "Poucos dados" e não entram em conclusões sobre situação.${FILT}`,
    });
  }
  const okR = sits.filter((x) => x.sit === 'healthy');
  const judged = sits.filter((x) => x.sit !== 'few');
  if (judged.length >= 4 && okR.length / judged.length >= 0.5) {
    add({ id: 'saudaveis', sev: 'good', pri: 2, title: `${okR.length} de ${judged.length} robôs saudáveis`, text: 'Menos de 15% de erro nas execuções concluídas.', why: `Entre os robôs com 5 execuções concluídas ou mais, os que ficam abaixo de 15% de erro. Aparece quando metade ou mais está saudável.${FILT}` });
  }

  return out.sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev] || b.pri - a.pri);
}

export { hourLabel };
