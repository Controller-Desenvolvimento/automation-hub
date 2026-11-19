import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInsights, type InsightInput } from '../src/robot-health/robot-health-insights';
import { capacityByHour, cancelReasonOf, cyclesOf, quietHours, type CycleExecution } from '../src/robot-health/robot-health-server';
import type { HealthExecution } from '../src/robot-health/robot-health-metrics';

const at = (day: number, hour = 10, min = 0) => new Date(2026, 10, day, hour, min, 0); // 2026-11-DD (fuso local)
let seq = 0;
const run = (start: Date, minutes: number, over: Partial<HealthExecution> = {}): HealthExecution => ({
  id: `s${++seq}`, robotId: 'r1', status: 'success', createdAt: start, startedAt: start, finishedAt: new Date(start.getTime() + minutes * 60_000),
  scheduled: false, errorMessage: null, ...over,
});

test('cancelReasonOf: reconhece T2, teto de tempo, pulada e cancelada à mão', () => {
  assert.equal(cancelReasonOf('Cancelada automaticamente: passou do limite de verificação (T2 = 30 min desde o início).'), 't2');
  assert.equal(cancelReasonOf('Cancelada automaticamente: passou do tempo máximo (60 min desde o início). Não foi reiniciada.'), 'teto');
  assert.equal(cancelReasonOf('Pulada: o agendamento Gestta não terminou com sucesso'), 'pulada');
  assert.equal(cancelReasonOf(null), 'mao');
  assert.equal(cancelReasonOf(''), 'mao');
});

test('capacidade: conta robôs ao mesmo tempo por hora e marca o limite', () => {
  const list = [
    run(at(10, 9, 0), 50, { robotId: 'a' }),
    run(at(10, 9, 10), 30, { robotId: 'b' }), // 9h: 2 ao mesmo tempo
    run(at(10, 14, 0), 20, { robotId: 'c' }),
  ];
  const cap = capacityByHour(list, at(10, 0), new Date(2026, 10, 10, 23, 59, 59), 2, new Date(2026, 10, 12));
  assert.equal(cap.any, true);
  assert.equal(cap.hours[9].peak, 2);
  assert.equal(cap.hours[9].daysLimit, 1);
  assert.equal(cap.hours[14].peak, 1);
  assert.equal(cap.hours[3].peak, 0);
  assert.deepEqual(cap.atLimit, [9]);
  assert.equal(cap.busiest, 9);
  assert.ok(cap.hours[9].busyShare > 0.8 && cap.hours[9].busyShare <= 1);
});

test('capacidade: execução de menos de 1 minuto conta e interrompida pelo Hub não conta', () => {
  const quick = run(at(10, 5, 0), 0.5, { robotId: 'a' });
  const hubKilled = run(at(10, 6, 0), 300, { robotId: 'b', status: 'error', errorMessage: 'Execução interrompida: o servidor do Hub foi reiniciado enquanto rodava' });
  const cap = capacityByHour([quick, hubKilled], at(10, 0), new Date(2026, 10, 10, 23, 59, 59), 2, new Date(2026, 10, 12));
  assert.equal(cap.hours[5].peak, 1);
  assert.equal(cap.hours[6].peak, 0);
  assert.equal(cap.hours[8].peak, 0);
});

test('capacidade: sem execuções nada é marcado', () => {
  const cap = capacityByHour([], at(1, 0), new Date(2026, 10, 3, 23, 59, 59), 2, new Date(2026, 10, 12));
  assert.equal(cap.any, false);
  assert.deepEqual(cap.atLimit, []);
});

test('horários bons para agendar: empate vira faixas e 23h–9h se junta passando da meia-noite', () => {
  const cap = capacityByHour([run(at(10, 12, 0), 60), run(at(10, 13, 0), 60)], at(10, 0), new Date(2026, 10, 10, 23, 59, 59), 2, new Date(2026, 10, 12));
  const q = quietHours(cap.hours);
  assert.equal(cap.hours[q.best].peak, 0);
  assert.ok(q.hours.length >= 20);
  assert.ok(q.ranges.length >= 1);
  assert.ok(!q.hours.includes(12) && !q.hours.includes(13));
  // a faixa que cruza a meia-noite aparece uma vez só
  const wraps = q.ranges.filter(([a, b]) => a > b || b > 24);
  assert.ok(wraps.length <= 1);
});

const cx = (over: Partial<CycleExecution> & { id: string }): CycleExecution => ({
  robotId: 'r1', createdAt: at(10), status: 'success', scheduledTaskId: 't1', attempt: 1, restartOfId: null, ...over,
});

test('ciclos: sucesso, recuperado pelo reinício, falhou de vez, cancelado e em andamento', () => {
  const list: CycleExecution[] = [
    cx({ id: 'a', status: 'success' }),
    cx({ id: 'b', status: 'error' }),
    cx({ id: 'b2', status: 'success', attempt: 2, restartOfId: 'b' }),
    cx({ id: 'c', status: 'error' }),
    cx({ id: 'c2', status: 'error', attempt: 2, restartOfId: 'c' }),
    cx({ id: 'd', status: 'canceled' }),
    cx({ id: 'e', status: 'running' }),
    cx({ id: 'f', status: 'error', scheduledTaskId: 't2' }), // sem reinício configurado: terminou em erro = falhou
  ];
  const rows = cyclesOf([{ id: 't1', hasRestart: true }, { id: 't2', hasRestart: false }], list, at(1, 0), new Date(2026, 10, 30));
  const t1 = rows.find((r) => r.taskId === 't1')!;
  assert.deepEqual([t1.ok, t1.recovered, t1.failed, t1.canceled, t1.attempting], [1, 1, 1, 1, 1]);
  const t2 = rows.find((r) => r.taskId === 't2')!;
  assert.deepEqual([t2.ok, t2.recovered, t2.failed], [0, 0, 1]);
  assert.equal(t2.hasRestart, false);
});

test('ciclos: o reinício não vira ciclo próprio e fora do período não conta', () => {
  const list: CycleExecution[] = [
    cx({ id: 'a', status: 'error', createdAt: at(10) }),
    cx({ id: 'a2', status: 'success', attempt: 2, restartOfId: 'a', createdAt: at(10, 11) }),
    cx({ id: 'old', status: 'error', createdAt: at(1) }),
  ];
  const rows = cyclesOf([{ id: 't1', hasRestart: true }], list, at(5, 0), new Date(2026, 10, 30));
  assert.deepEqual([rows[0].ok, rows[0].recovered, rows[0].failed], [0, 1, 0]);
});

// ---------- insights ----------

const base = (over: Partial<InsightInput> = {}): InsightInput => ({
  current: [], previous: null, days: 30, from: '2026-10-21', to: '2026-11-19', previousRange: null,
  robotNames: new Map([['r1', 'Robô Um'], ['r2', 'Robô Dois']]), capacity: null, cycles: [], taskT2: new Map(), ...over,
});
const many = (n: number, make: (i: number) => HealthExecution) => Array.from({ length: n }, (_, i) => make(i));

test('insights: sem execuções nada aparece', () => {
  assert.deepEqual(buildInsights(base()), []);
});

test('insights: 80% de erros sem motivo vira crítico e cita os robôs', () => {
  const current = [
    ...many(12, (i) => run(at(2 + (i % 20)), 2, { status: 'error', errorMessage: 'Comando finalizado com codigo 1' })),
    ...many(10, (i) => run(at(2 + (i % 20)), 2)),
  ];
  const ins = buildInsights(base({ current }));
  const sem = ins.find((i) => i.id === 'sem-causa');
  assert.ok(sem, 'regra sem-causa');
  assert.equal(sem!.sev, 'crit');
  assert.match(sem!.text, /Robô Um/);
  assert.ok(sem!.why.length > 50 && sem!.acts?.[0].go === 'erros');
});

test('insights: robô sem nenhum sucesso vira cartão crítico com ficha', () => {
  const current = [
    ...many(4, (i) => run(at(2 + i), 2, { robotId: 'r2', status: 'error', errorMessage: 'HTTP 503' })),
    ...many(10, (i) => run(at(2 + i), 2, { robotId: 'r1' })),
  ];
  const ins = buildInsights(base({ current }));
  const ficha = ins.find((i) => i.id === 'robo-r2');
  assert.ok(ficha && ficha.kind === 'robo');
  assert.equal(ficha!.sev, 'crit');
  assert.ok(ficha!.facts!.some((f) => /Nenhum sucesso/.test(f.t)));
  assert.equal(ins.find((i) => i.id === 'robo-r1'), undefined, 'robô saudável não ganha cartão');
});

test('insights: taxa de sucesso que cai 10 p.p. ou mais é crítica; só com 20 concluídas em cada período', () => {
  const prevOk = many(30, (i) => run(new Date(2026, 9, 1 + (i % 15)), 2));
  const curMix = [...many(18, (i) => run(at(1 + (i % 18)), 2)), ...many(12, (i) => run(at(1 + (i % 18)), 2, { status: 'error', errorMessage: 'HTTP 503' }))];
  const ins = buildInsights(base({ current: curMix, previous: prevOk, previousRange: { from: '2026-09-21', to: '2026-10-20' } }));
  const t = ins.find((i) => i.id === 'taxa-mudou');
  assert.ok(t);
  assert.equal(t!.sev, 'crit');
  const few = buildInsights(base({ current: curMix.slice(0, 10), previous: prevOk.slice(0, 10), previousRange: { from: '2026-09-21', to: '2026-10-20' } }));
  assert.equal(few.find((i) => i.id === 'taxa-mudou'), undefined);
});

test('insights: servidor no limite avisa; sem chegar ao limite é positivo', () => {
  const lim = capacityByHour([run(at(10, 9, 0), 50, { robotId: 'a' }), run(at(10, 9, 10), 30, { robotId: 'b' })], at(10, 0), new Date(2026, 10, 10, 23, 59, 59), 2, new Date(2026, 10, 12));
  const withLimit = buildInsights(base({ current: [run(at(10), 5)], capacity: lim }));
  assert.ok(withLimit.find((i) => i.id === 'cap-limite'));
  assert.ok(withLimit.find((i) => i.id === 'cap-silencio'));
  const relaxed = capacityByHour([run(at(10, 9, 0), 50, { robotId: 'a' })], at(10, 0), new Date(2026, 10, 10, 23, 59, 59), 2, new Date(2026, 10, 12));
  const ok = buildInsights(base({ current: [run(at(10), 5)], capacity: relaxed }));
  assert.equal(ok.find((i) => i.id === 'cap-limite'), undefined);
  assert.equal(ok.find((i) => i.id === 'cap-ok')?.sev, 'good');
});

test('insights: agendamento que falha de vez com frequência é crítico e o reinício que salvou é positivo', () => {
  const cycles = [
    { taskId: 't1', ok: 1, recovered: 0, failed: 3, canceled: 0, attempting: 0, hasRestart: true, name: 'Gestta', robotName: 'Robô Um' },
    { taskId: 't2', ok: 5, recovered: 2, failed: 0, canceled: 0, attempting: 0, hasRestart: true, name: 'Excel', robotName: 'Robô Dois' },
  ];
  const ins = buildInsights(base({ current: [run(at(10), 5)], cycles }));
  assert.equal(ins.find((i) => i.id === 'agend-falham')?.sev, 'crit');
  assert.match(ins.find((i) => i.id === 'agend-salvos')!.title, /2 ciclos/);
});

test('insights: agendada que passou do T2 depois dele existir é aviso; antes do T2 é só informação', () => {
  const taskT2 = new Map([['t1', 30]]);
  const mk = (start: Date, minutes: number) => run(start, minutes, { robotId: 'r1', scheduled: true, scheduledTaskId: 't1', attempt: 1, restartOfId: null });
  const after = buildInsights(base({ current: [mk(at(15), 50), mk(at(16), 10)], taskT2 }));
  assert.equal(after.find((i) => i.id === 't2-passou')?.sev, 'warn');
  const before = buildInsights(base({ current: [mk(new Date(2026, 10, 1), 50), mk(new Date(2026, 10, 2), 45), mk(new Date(2026, 10, 3), 60), mk(new Date(2026, 10, 4), 5)], taskT2 }));
  assert.equal(before.find((i) => i.id === 't2-antes')?.sev, 'info');
  assert.equal(before.find((i) => i.id === 't2-passou'), undefined);
});

test('insights: ordenados por gravidade e cada um traz "por quê"', () => {
  const current = [
    ...many(12, (i) => run(at(2 + (i % 20)), 2, { status: 'error', errorMessage: 'Comando finalizado com codigo 1' })),
    ...many(30, (i) => run(at(2 + (i % 20)), 2)),
  ];
  const ins = buildInsights(base({ current, cycles: [{ taskId: 't', ok: 0, recovered: 3, failed: 0, canceled: 0, attempting: 0, hasRestart: true, name: 'X', robotName: 'Robô Um' }] }));
  const order = { crit: 0, warn: 1, info: 2, good: 3 } as const;
  for (let i = 1; i < ins.length; i++) assert.ok(order[ins[i - 1].sev] <= order[ins[i].sev]);
  assert.ok(ins.every((i) => i.why.length > 20 && i.title.length > 3));
});

test('insights: espera na fila das execuções manuais', () => {
  const mk = (waitMin: number) => run(at(10, 10, 0), 2, { createdAt: new Date(at(10, 10, 0).getTime() - waitMin * 60_000), scheduled: false });
  const current = [...many(8, () => mk(1)), ...many(4, () => mk(12))];
  const ins = buildInsights(base({ current }));
  const fila = ins.find((i) => i.id === 'fila-manual');
  assert.ok(fila);
  assert.equal(fila!.sev, 'warn');
  const calm = buildInsights(base({ current: many(12, () => mk(1)) }));
  assert.equal(calm.find((i) => i.id === 'fila-manual'), undefined);
});
