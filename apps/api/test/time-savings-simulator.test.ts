import assert from 'node:assert/strict';
import test from 'node:test';
import { DAY_MS, monthsBetween, peopleOf, periodDays, simInsights, simulate, simulateMonthly, type SimExecution, type SimInput, type SimRobot } from '../src/reports/time-savings-simulator';

const NOW = new Date(2026, 10, 19, 12, 0, 0).getTime();
const day = (n: number) => new Date(2026, 10, 19 - n, 0, 0, 0).getTime();
const exec = (over: Partial<SimExecution> = {}): SimExecution => ({ finishedAt: NOW - DAY_MS, scheduled: false, storedGain: 0, units: null, ...over });
const robot = (id: string, n: number, over: Partial<SimRobot> = {}, e: Partial<SimExecution> = {}): SimRobot => ({
  robotId: id, name: `Robô ${id}`, hasTime: false, firstAt: day(400), fallbackAvgItems: null, executions: Array.from({ length: n }, () => exec(e)), ...over,
});
const input = (robots: SimRobot[], over: Partial<SimInput> = {}): SimInput => ({
  robots, base: 'exec', times: {}, workdayHours: 7, from: day(29), now: NOW, reportSavedSeconds: 0, ...over,
});
const MONTHS = 11 / 31 + 19 / 30; // período de 30 dias (21/10 a 19/11): 11 dias de outubro + 19 de novembro, em meses do calendário

test('período: dias entre o início e hoje; sem início vale a primeira execução', () => {
  assert.equal(periodDays(input([], { from: day(29) })), 30);
  assert.equal(periodDays(input([robot('a', 1, { firstAt: day(9) })], { from: null })), 10);
  assert.equal(periodDays(input([], { from: null })), 1);
});

test('por execução: tempo × execuções do período, levado para 1 mês; sem tempo informado não soma', () => {
  const r = simulate(input([robot('a', 60), robot('b', 10)], { times: { a: 300 } }));
  const a = r.rows.find((x) => x.robotId === 'a')!;
  const b = r.rows.find((x) => x.robotId === 'b')!;
  assert.equal(a.source, 'informado');
  assert.ok(Math.abs(a.simulatedMonth - (300 * 60) / MONTHS) < 1e-6);
  assert.equal(a.perExecution, 300);
  assert.equal(b.source, 'nenhum');
  assert.equal(b.simulatedMonth, 0);
  assert.ok(Math.abs(r.extra - a.simulatedMonth) < 1e-6);
  assert.ok(Math.abs(r.fromWithout - a.simulatedMonth) < 1e-6);
  assert.equal(r.fromNewTimes, 0);
});

test('faixa: ×0,5 e ×1,5 valem só para os tempos estimados dos robôs sem tempo', () => {
  const robots = [robot('a', 60), robot('c', 20, { hasTime: true }, { storedGain: 600, units: 2 })];
  const inp = input(robots, { times: { a: 300, c: 100 } });
  const low = simulate(inp, 0.5);
  const high = simulate(inp, 1.5);
  const main = simulate(inp, 1);
  const rowA = (res: typeof main) => res.rows.find((x) => x.robotId === 'a')!.simulatedMonth;
  const rowC = (res: typeof main) => res.rows.find((x) => x.robotId === 'c')!.simulatedMonth;
  assert.ok(Math.abs(rowA(low) - rowA(main) / 2) < 1e-6);
  assert.ok(Math.abs(rowA(high) - rowA(main) * 1.5) < 1e-6);
  assert.equal(rowC(low), rowC(main), 'o novo tempo de quem já tem ganho não varia');
  assert.equal(rowC(high), rowC(main));
});

test('quem já tem ganho: sem novo tempo mantém o que o relatório mostra; com novo tempo conta por item', () => {
  const c = robot('c', 20, { hasTime: true }, { storedGain: 600, units: 2 });
  const keep = simulate(input([c]));
  assert.equal(keep.rows[0].source, 'atual');
  assert.ok(Math.abs(keep.rows[0].simulatedMonth - (600 * 20) / MONTHS) < 1e-6);
  assert.equal(keep.extra, 0);
  const novo = simulate(input([c], { times: { c: 100 } }));
  assert.equal(novo.rows[0].source, 'novo');
  assert.ok(Math.abs(novo.rows[0].simulatedMonth - (100 * 2 * 20) / MONTHS) < 1e-6, '100 s × 2 itens × 20 execuções');
  assert.ok(Math.abs(novo.fromNewTimes - (100 * 40 - 600 * 20) / MONTHS) < 1e-6);
  assert.ok(novo.fromNewTimes < 0 && novo.extra === novo.fromNewTimes, 'novo tempo menor que o atual reduz o ganho (negativo)');
});

test('por item: usa os itens informados; execução sem a quantidade usa a média do robô e conta como estimada', () => {
  const execs = [exec({ units: 10 }), exec({ units: 20 }), exec(), exec()];
  const r = simulate(input([robot('a', 0, { executions: execs })], { base: 'item', times: { a: 60 } }));
  const row = r.rows[0];
  // 30 itens conhecidos + 2 execuções sem quantidade × média 15 = 60 itens
  assert.ok(Math.abs(row.simulatedMonth - (60 * 60) / MONTHS) < 1e-6);
  assert.equal(row.estimated, 2);
  assert.equal(r.estimatedExecutions, 2);
  assert.equal(row.avgItems, 15);
  assert.equal(row.perExecution, 900);
  // sem nenhuma quantidade conhecida, cada execução conta 1 item
  const none = simulate(input([robot('a', 4)], { base: 'item', times: { a: 60 } }));
  assert.ok(Math.abs(none.rows[0].simulatedMonth - (60 * 4) / MONTHS) < 1e-6);
});

test('robô que começou há pouco não é diluído no período inteiro', () => {
  const young = simulate(input([robot('a', 10, { firstAt: day(9) })], { times: { a: 60 } }));
  const old = simulate(input([robot('a', 10)], { times: { a: 60 } }));
  assert.equal(young.rows[0].days, 10);
  assert.ok(Math.abs(young.rows[0].simulatedMonth - 600 / (10 / 30)) < 1e-6, '10 dias de novembro = 10/30 do mês');
  assert.ok(young.rows[0].simulatedMonth > old.rows[0].simulatedMonth);
});

test('pessoas equivalentes = horas por mês ÷ (jornada × 21 dias úteis), com sinal', () => {
  assert.equal(peopleOf(21 * 7 * 3600, 7), 1);
  assert.equal(peopleOf(21 * 8 * 3600, 8), 1);
  assert.equal(peopleOf(-21 * 7 * 3600, 7), -1);
});

test('insights: avisa período curto, robô sem tempo, tempo acima da jornada e o que o ganho equivale em pessoas', () => {
  const short = input([robot('a', 5), robot('z', 3)], { from: day(4), times: { a: 8 * 3600 }, reportSavedSeconds: 3600 });
  const res = simulate(short);
  const ins = simInsights(res, { base: 'exec', workdayHours: 7 });
  const warns = ins.filter((i) => i.kind === 'warn').map((i) => i.text);
  assert.ok(warns.some((t) => /só 5 dias/.test(t)), warns.join('|'));
  assert.ok(warns.some((t) => /Confira Robô a/.test(t)));
  assert.ok(warns.some((t) => /sem tempo informado.*Robô z/.test(t)));
  assert.ok(ins.some((i) => i.kind === 'info' && /equivale a .* pessoas?/.test(i.text)));
  // os avisos vêm antes das informações
  assert.equal(ins.findIndex((i) => i.kind === 'info') > ins.map((i) => i.kind).lastIndexOf('warn'), true);
});

test('insights: robô que não rodou no período e ganho concentrado', () => {
  const robots = [robot('a', 40), robot('b', 10), robot('c', 5), robot('d', 3), robot('e', 2), robot('idle', 0)];
  const res = simulate(input(robots, { times: { a: 600, b: 600, c: 600, d: 600, e: 600, idle: 600 } }));
  const texts = simInsights(res, { base: 'exec', workdayHours: 7 }).map((i) => i.text).join('\n');
  assert.match(texts, /Robô a responde por/);
  assert.match(texts, /Os 3 maiores somam/);
  assert.match(texts, /1 robô não rodou no período \(Robô idle\)/);
});

// ---------- evolução mensal ----------


const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0, 0).getTime(); // meio-dia local (m = 1..12)

test('evolução mensal: ganho do relatório + extra simulado nas execuções de cada mês; mês corrente incompleto', () => {
  const r = robot('a', 0, {
    firstAt: at(2026, 8, 5),
    executions: [exec({ finishedAt: at(2026, 9, 10) }), exec({ finishedAt: at(2026, 9, 11) }), exec({ finishedAt: at(2026, 10, 3) }), exec({ finishedAt: at(2026, 11, 2) })],
  });
  const { months } = simulateMonthly({
    robots: [r], base: 'exec', times: { a: 600 }, workdayHours: 7, now: NOW, windowMonths: 4,
    currentByMonth: { '2026-08': 100, '2026-09': 200, '2026-10': 300, '2026-11': 50 }, firstDataAt: at(2026, 8, 1),
  });
  assert.deepEqual(months.map((m) => m.key), ['2026-08', '2026-09', '2026-10', '2026-11']);
  assert.deepEqual(months.map((m) => m.extra), [0, 1200, 600, 600]);
  assert.deepEqual(months.map((m) => m.partial), [false, false, false, true]);
  assert.deepEqual(months.map((m) => m.current), [100, 200, 300, 50]);
});

test('evolução mensal: começa no 1º mês COMPLETO de dados', () => {
  const r = robot('a', 0, { firstAt: at(2026, 9, 15), executions: [exec({ finishedAt: at(2026, 9, 20) }), exec({ finishedAt: at(2026, 10, 3) })] });
  const base = { robots: [r], base: 'exec' as const, times: { a: 60 }, workdayHours: 7, now: NOW, windowMonths: 4, currentByMonth: {} };
  const cut = simulateMonthly({ ...base, firstDataAt: at(2026, 9, 15) });
  assert.deepEqual(cut.months.map((m) => m.key), ['2026-10', '2026-11'], 'setembro começou no meio: sai');
  assert.equal(cut.cut, true);
  const full = simulateMonthly({ ...base, firstDataAt: at(2026, 9, 1) });
  assert.deepEqual(full.months.map((m) => m.key), ['2026-09', '2026-10', '2026-11']);
  assert.equal(full.cut, false);
});

test('evolução mensal: novo tempo de quem já tem ganho e por item com média; "só simulados" separa o ganho dos robôs da simulação', () => {
  const c = robot('c', 0, {
    hasTime: true, firstAt: at(2026, 9, 1),
    executions: [exec({ finishedAt: at(2026, 10, 5), storedGain: 600, units: 2 }), exec({ finishedAt: at(2026, 10, 6), storedGain: 600, units: 2 })],
  });
  const a = robot('a', 0, { firstAt: at(2026, 9, 1), executions: [exec({ finishedAt: at(2026, 10, 7), units: 10 }), exec({ finishedAt: at(2026, 10, 8) })] });
  const { months } = simulateMonthly({
    robots: [c, a], base: 'item', times: { c: 100, a: 60 }, workdayHours: 7, now: NOW, windowMonths: 3,
    currentByMonth: { '2026-10': 5000 }, firstDataAt: at(2026, 9, 1),
  });
  const oct = months.find((m) => m.key === '2026-10')!;
  // c: 2 × (100 × 2 − 600) = −800; a: 60 × 10 + 60 × média 10 = 1200
  assert.equal(oct.extra, 400);
  assert.equal(oct.currentSim, 1200, 'só o que os robôs da simulação já têm gravado');
  assert.equal(oct.current, 5000, 'o do relatório inteiro vem da própria série do relatório');
});

// ---------- período que termina antes de hoje (o "Até" conta) ----------

test('período com "Até" no passado: os dias vão do "De" até o "Até", não até hoje', () => {
  const to = day(19); // 31/10 (NOW = 19/11)
  const inp = input([robot('a', 119, { firstAt: day(400) })], { from: day(49), to, times: { a: 300 } }); // 01/10 a 31/10
  assert.equal(periodDays(inp), 31);
  const r = simulate(inp);
  assert.equal(r.days, 31);
  const a = r.rows[0];
  assert.equal(a.days, 31);
  // outubro inteiro = exatamente 1 mês: 119 execuções × 5 min = 35.700 s (9,9 h) por mês
  assert.ok(Math.abs(a.simulatedMonth - 300 * 119) < 1e-6, String(a.simulatedMonth));
  assert.equal(r.months, 1);
  assert.ok(Math.abs(simulate(input([robot('a', 119)], { from: day(49), to, times: { a: 300 }, reportSavedSeconds: 31 * 3600 })).reportMonth - 31 * 3600) < 1e-6, 'o relatório do período também usa os meses do período');
});

test('período: "Até" depois de hoje vale hoje; sem "Até" vale hoje; robô novo conta só até o "Até"', () => {
  assert.equal(periodDays(input([], { from: day(29), to: day(-10) })), 30, '"Até" no futuro não aumenta o período');
  assert.equal(periodDays(input([], { from: day(29), to: null })), 30);
  // robô que começou em 11/10 (dia 39 antes de hoje): de 11/10 a 31/10 são 21 dias
  const young = simulate(input([robot('a', 10, { firstAt: day(39) })], { from: day(49), to: day(19), times: { a: 60 } }));
  assert.equal(young.rows[0].days, 21);
});

test('período: o dia é o do fuso do relatório, mesmo com "agora" perto da meia-noite', () => {
  // 22h30 de 19/11 em São Paulo = 01h30 de 20/11 em UTC: continua sendo 19/11 para o relatório
  const lateNow = Date.parse('2026-11-19T22:30:00-03:00');
  const inp = input([], { from: Date.parse('2026-11-01T00:00:00-03:00'), now: lateNow });
  assert.equal(periodDays(inp), 19);
});

test('meses do calendário: mês inteiro vale 1 (31, 30 ou 28 dias); pedaço de mês é a fração; vários meses somam', () => {
  const d = (y: number, m: number, dd: number) => new Date(y, m - 1, dd, 12).getTime();
  assert.equal(monthsBetween(d(2026, 10, 1), d(2026, 10, 31)), 1, 'outubro (31 dias)');
  assert.equal(monthsBetween(d(2026, 11, 1), d(2026, 11, 30)), 1, 'novembro (30 dias)');
  assert.equal(monthsBetween(d(2026, 2, 1), d(2026, 2, 28)), 1, 'fevereiro (28 dias)');
  assert.equal(monthsBetween(d(2026, 10, 1), d(2026, 11, 30)), 2);
  assert.equal(monthsBetween(d(2025, 12, 1), d(2026, 1, 31)), 2, 'vira o ano');
  assert.ok(Math.abs(monthsBetween(d(2026, 11, 1), d(2026, 11, 19)) - 19 / 30) < 1e-12);
  assert.ok(Math.abs(monthsBetween(d(2026, 10, 21), d(2026, 11, 19)) - (11 / 31 + 19 / 30)) < 1e-12, 'um pedaço de cada mês');
  assert.ok(Math.abs(monthsBetween(d(2026, 11, 10), d(2026, 11, 10)) - 1 / 30) < 1e-12, 'um dia só');
});

// ---------- frases do protótipo: ícones, sensibilidade (±), % e tempo padrão (=) ----------

test('insights: todos trazem ícone; sensibilidade usa a unidade escolhida; "%" só somando os que já têm ganho; "=" só com tempo padrão', () => {
  const robots = [robot('a', 40), robot('b', 10), robot('c', 20, { hasTime: true }, { storedGain: 600, units: 2 })];
  const inp = input(robots, { times: { a: 300, b: 300 } });
  const res = simulate(inp);
  const base = simInsights(res, { base: 'exec', workdayHours: 7, unit: 'minutes', scope: 'sem' });
  assert.ok(base.every((i) => i.icon && i.icon.length > 0), 'todos com ícone');
  const sens = base.find((i) => i.icon === '±')!;
  assert.ok(sens, 'sensibilidade');
  assert.match(sens.text, /Cada 1 min a mais em Robô a soma ~.* por mês/);
  const hours = simInsights(res, { base: 'exec', workdayHours: 7, unit: 'hours' }).find((i) => i.icon === '±')!;
  assert.match(hours.text, /Cada 1 h a mais em Robô a/);
  assert.equal(base.find((i) => i.icon === '%'), undefined, '"%" só no escopo "todos"');
  assert.equal(base.find((i) => i.icon === '='), undefined, '"=" só quando há robôs no tempo padrão');
  const todos = simInsights(res, { base: 'exec', workdayHours: 7, scope: 'todos', defaultIds: ['b'] });
  assert.match(todos.find((i) => i.icon === '%')!.text, /representariam \d+% do total simulado/);
  assert.match(todos.find((i) => i.icon === '=')!.text, /1 robô usou o tempo padrão/);
  // os avisos continuam com "!"
  const warn = simInsights(simulate(input([robot('a', 5)], { from: day(4), times: { a: 8 * 3600 } })), { base: 'exec', workdayHours: 7 }).filter((i) => i.kind === 'warn');
  assert.ok(warn.length && warn.every((i) => i.icon === '!'));
});

test('insights: "pessoa" no singular de 0,1 a 1,9 e "pessoas" em 0 e a partir de 2 (como nos indicadores da tela)', () => {
  const base = simulate(input([robot('a', 1)], { times: { a: 300 } }));
  const text = (people: number) => simInsights({ ...base, extra: people * 147 * 3600, reportMonth: 0 }, { base: 'exec', workdayHours: 7 }).find((i) => i.icon === '👥')?.text ?? '';
  // 7 h por dia × 21 dias úteis = 147 h por pessoa
  assert.match(text(0.3), /equivale a 0,3 pessoa trabalhando/, '0,3 pessoa (singular)');
  assert.match(text(1.8), /equivale a 1,8 pessoa trabalhando/, '1,8 pessoa (singular)');
  assert.match(text(2.4), /equivale a 2,4 pessoas trabalhando/, '2,4 pessoas (plural)');
  assert.match(text(12), /equivale a 12 pessoas trabalhando/, '12 pessoas (plural)');
});
