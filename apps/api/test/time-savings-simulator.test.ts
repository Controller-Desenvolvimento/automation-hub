import assert from 'node:assert/strict';
import test from 'node:test';
import { DAY_MS, MONTH_DAYS, peopleOf, periodDays, simInsights, simulate, type SimExecution, type SimInput, type SimRobot } from '../src/reports/time-savings-simulator';

const NOW = new Date(2026, 10, 19, 12, 0, 0).getTime();
const day = (n: number) => new Date(2026, 10, 19 - n, 0, 0, 0).getTime();
const exec = (over: Partial<SimExecution> = {}): SimExecution => ({ finishedAt: NOW - DAY_MS, scheduled: false, storedGain: 0, units: null, ...over });
const robot = (id: string, n: number, over: Partial<SimRobot> = {}, e: Partial<SimExecution> = {}): SimRobot => ({
  robotId: id, name: `Robô ${id}`, hasTime: false, firstAt: day(400), fallbackAvgItems: null, executions: Array.from({ length: n }, () => exec(e)), ...over,
});
const input = (robots: SimRobot[], over: Partial<SimInput> = {}): SimInput => ({
  robots, base: 'exec', times: {}, workdayHours: 7, from: day(29), now: NOW, reportSavedSeconds: 0, ...over,
});
const MONTHS = 30 / MONTH_DAYS; // período de 30 dias

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
  assert.ok(Math.abs(young.rows[0].simulatedMonth - (600 / (10 / MONTH_DAYS))) < 1e-6);
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
