// Simulador de ganhos contra um PostgreSQL REAL e DESCARTÁVEL (mesma trava dos outros testes com banco: hub_dev, porta 5544).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { limparTmp } from './_limpar-tmp';

/* eslint-disable @typescript-eslint/no-explicit-any */
const url = process.env.TEST_DATABASE_URL ?? '';
const skip = !/\/hub_dev(\?|$)/.test(url) || !/:5544\//.test(url)
  ? 'defina TEST_DATABASE_URL apontando para o banco descartável (hub_dev na porta 5544)'
  : false;

const tmp = mkdtempSync(join(tmpdir(), 'sim-db-'));
const cwdOriginal = process.cwd();
let prisma: any;
let reports: any;
let admin: any;
const ROBOTS = ['ss-a', 'ss-b', 'ss-ext', 'ss-off'];
const day = (n: number) => new Date(Date.now() - n * 86400_000);
// meses do calendário entre dois dias (AAAA-MM-DD), calculados à parte do código do simulador
function calendarMonths(from: string, to: string): number {
  let [y, m] = from.split('-').map(Number);
  const [ly, lm] = to.split('-').map(Number);
  let total = 0;
  while (y < ly || (y === ly && m <= lm)) {
    const inMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const a = y === Number(from.slice(0, 4)) && m === Number(from.slice(5, 7)) ? Number(from.slice(8, 10)) : 1;
    const b = y === ly && m === lm ? Number(to.slice(8, 10)) : inMonth;
    total += (b - a + 1) / inMonth;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return total;
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function wipe() {
  await prisma.executionLog.deleteMany({ where: { executionId: { startsWith: 'ss-ex' } } });
  await prisma.execution.deleteMany({ where: { id: { startsWith: 'ss-ex' } } });
  await prisma.robot.deleteMany({ where: { id: { in: ROBOTS } } });
  await prisma.user.deleteMany({ where: { id: 'ss-user' } });
}

before(async () => {
  if (skip) return;
  process.chdir(tmp);
  process.env.DATABASE_URL = url;
  const { PrismaService } = await import('../src/prisma/prisma.service');
  const { ReportsService } = await import('../src/reports/reports.service');
  prisma = new PrismaService();
  await prisma.$connect();
  reports = new ReportsService(prisma);
  await wipe();
  admin = await prisma.user.create({ data: { id: 'ss-user', name: 'Admin SS', email: 'ss-user@example.invalid', passwordHash: 'x', role: 'admin', departments: [] } });
  await prisma.robot.createMany({
    data: [
      { id: 'ss-a', slug: 'ss-a', name: 'SS Sem tempo', command: 'echo', manualSecondsPerUnit: 0 },
      { id: 'ss-b', slug: 'ss-b', name: 'SS Com tempo', command: 'echo', manualSecondsPerUnit: 60, unitMetricKey: 'itens_processados' },
      { id: 'ss-ext', slug: 'ss-ext', name: 'SS Externo', command: 'echo', manualSecondsPerUnit: 0, isExternal: true },
      { id: 'ss-off', slug: 'ss-off', name: 'SS Inativo', command: 'echo', manualSecondsPerUnit: 0, isActive: false },
    ],
  });
  let n = 0;
  const add = async (robotId: string, when: Date, extra: Record<string, unknown> = {}) => {
    const id = `ss-ex${++n}`;
    await prisma.execution.create({
      data: { id, robotId, userId: 'ss-user', status: 'success', createdAt: when, startedAt: when, finishedAt: new Date(when.getTime() + 60_000), manualEstimatedSeconds: 0, ...extra },
    });
    return id;
  };
  // ss-a: 10 execuções nos últimos 29 dias (3 informaram "notas": 10, 20 e 30) — a primeira há 40 dias
  await add('ss-a', day(40));
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) ids.push(await add('ss-a', day(2 + i * 2)));
  for (const [i, v] of [[0, 10], [1, 20], [2, 30]] as const) {
    await prisma.executionLog.create({ data: { executionId: ids[i], level: 'info', message: `Metrica registrada: notas=${v}` } });
  }
  // ss-b (já tem tempo, 60 s por item): 5 execuções, 2 itens cada, ganho gravado 120 s
  for (let i = 0; i < 5; i++) await add('ss-b', day(3 + i * 3), { unitsProcessed: 2, manualEstimatedSeconds: 120 });
  await add('ss-ext', day(2));
  await add('ss-off', day(2));
});

after(async () => {
  process.chdir(cwdOriginal);
  if (prisma) {
    await wipe();
    await prisma.onModuleDestroy();
  }
  limparTmp(tmp);
});

const range = () => ({ from: iso(day(29)), to: iso(new Date()) });
const mine = (rows: any[]) => rows.filter((r) => ROBOTS.includes(r.robotId));

test('simular por execução: só robôs sem tempo, projeção mensal, faixa e frases', { skip }, async () => {
  const r = await reports.simulateGains(admin, { ...range(), scope: 'sem', base: 'exec', times: { 'ss-a': 300 }, workdayHours: 7 });
  const rows = mine(r.rows);
  assert.deepEqual(rows.map((x: any) => x.robotId), ['ss-a'], 'com tempo, externo e inativo ficam de fora do escopo "sem"');
  const a = rows[0];
  assert.equal(a.source, 'informado');
  assert.equal(a.executions, 10, 'a execução de 40 dias atrás fica fora do período');
  assert.equal(a.perExecution, 300);
  const expected = (300 * 10) / calendarMonths(range().from, range().to);
  assert.ok(Math.abs(a.simulatedMonth - expected) < 1e-6, `${a.simulatedMonth} vs ${expected}`);
  assert.ok(r.extraMonth >= a.simulatedMonth - 1e-6);
  assert.ok(Math.abs(r.extraYear - r.extraMonth * 12) < 1e-6);
  assert.ok(r.band.low.extraMonth < r.band.likely.extraMonth && r.band.likely.extraMonth < r.band.high.extraMonth);
  assert.ok(Array.isArray(r.insights) && r.insights.every((i: any) => ['warn', 'info'].includes(i.kind) && i.text));
  assert.ok(typeof r.people.extra === 'number');
  // evolução mensal (12 meses, independente do período): o mês corrente é incompleto e o extra simulado aparece nele
  assert.ok(r.monthly.months.length >= 1 && r.monthly.months.length <= 12);
  const last = r.monthly.months[r.monthly.months.length - 1];
  assert.equal(last.partial, true);
  assert.ok(last.extra > 0, 'as execuções do mês corrente trazem extra simulado');
  assert.ok(r.monthly.months.every((m: any) => /^\d{4}-\d{2}$/.test(m.key) && typeof m.current === 'number' && typeof m.currentSim === 'number'));
  const total = r.monthly.months.reduce((acc: number, m: any) => acc + m.extra, 0);
  // meses anteriores ao 1º mês completo de dados não aparecem: o total fica entre o do mês corrente e o das 10 execuções (300 s cada)
  // (o banco de teste pode ter outros dados do relatório, que antecipam o 1º mês completo: vale até as 11 execuções do robô)
  assert.ok(total >= last.extra - 1e-6 && total <= 300 * 11 + 1e-6, String(total));
});

test('simular por item: usa a métrica que o robô mais informa e estima as execuções sem ela pela média', { skip }, async () => {
  const r = await reports.simulateGains(admin, { ...range(), scope: 'sem', base: 'item', times: { 'ss-a': 60 } });
  const a = mine(r.rows).find((x: any) => x.robotId === 'ss-a');
  // 3 execuções informaram (10 + 20 + 30 = 60 itens); as outras 7 usam a média (20): 140 itens → 200 itens no total
  assert.equal(a.estimated, 7);
  assert.equal(a.avgItems, 20);
  const expected = (60 * 200) / calendarMonths(range().from, range().to);
  assert.ok(Math.abs(a.simulatedMonth - expected) < 1e-6, `${a.simulatedMonth} vs ${expected}`);
});

test('somando os que já têm ganho: mantém o tempo atual e aceita novo tempo (por item)', { skip }, async () => {
  const keep = await reports.simulateGains(admin, { ...range(), scope: 'todos', base: 'exec', times: { 'ss-a': 300 } });
  const b = mine(keep.rows).find((x: any) => x.robotId === 'ss-b');
  assert.equal(b.source, 'atual');
  assert.ok(Math.abs(b.simulatedMonth - b.currentMonth) < 1e-9);
  assert.ok(b.currentMonth > 0, 'o ganho gravado (120 s × 5) aparece como "hoje"');
  const novo = await reports.simulateGains(admin, { ...range(), scope: 'todos', base: 'exec', times: { 'ss-a': 300, 'ss-b': 30 } });
  const b2 = mine(novo.rows).find((x: any) => x.robotId === 'ss-b');
  assert.equal(b2.source, 'novo');
  // 30 s × 2 itens × 5 execuções = 300 s (antes 600 s): o novo tempo reduz o ganho
  assert.ok(b2.simulatedMonth < b2.currentMonth);
  assert.ok(novo.fromNewTimes < 0);
});

test('excluir robô, ignorar tempo inválido e validar a jornada', { skip }, async () => {
  const r = await reports.simulateGains(admin, { ...range(), scope: 'sem', base: 'exec', times: { 'ss-a': 'abc', 'ss-b': -5 }, excluded: ['ss-a'], workdayHours: 99 });
  assert.equal(mine(r.rows).length, 0, 'o robô excluído sai da conta');
  assert.equal(r.workdayHours, 7, 'jornada fora de 1 a 24 volta ao padrão');
  const none = await reports.simulateGains(admin, { ...range(), scope: 'sem', base: 'exec', times: { 'ss-a': 'abc' } });
  assert.equal(mine(none.rows)[0].source, 'nenhum', 'tempo inválido = sem tempo informado');
});

test('simular não grava nada', { skip }, async () => {
  const before = await prisma.robot.findUnique({ where: { id: 'ss-a' } });
  await reports.simulateGains(admin, { ...range(), scope: 'sem', base: 'exec', times: { 'ss-a': 300 } });
  const after = await prisma.robot.findUnique({ where: { id: 'ss-a' } });
  assert.equal(after.manualSecondsPerUnit, before.manualSecondsPerUnit);
  assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
});

test('período que termina no passado: os dias e a projeção usam o "Até", não hoje', { skip }, async () => {
  const r = await reports.simulateGains(admin, { from: iso(day(29)), to: iso(day(10)), scope: 'sem', base: 'exec', times: { 'ss-a': 300 } });
  const a = mine(r.rows).find((x: any) => x.robotId === 'ss-a');
  assert.equal(r.days, 20, '29 a 10 dias atrás, contando os dois');
  assert.equal(a.days, 20);
  assert.equal(a.executions, 6, 'só as execuções até o "Até" (10, 12, 14, 16, 18 e 20 dias atrás)');
  const expected = (300 * 6) / calendarMonths(iso(day(29)), iso(day(10)));
  assert.ok(Math.abs(a.simulatedMonth - expected) < 1e-6, `${a.simulatedMonth} vs ${expected}`);
  assert.ok(Math.abs(r.months - calendarMonths(iso(day(29)), iso(day(10)))) < 1e-9);
});

test('modo leve (formulário): só as linhas por robô, com execuções por mês e a métrica que o robô informa', { skip }, async () => {
  const r = await reports.simulateGains(admin, { ...range(), scope: 'sem', base: 'item', times: {}, light: true });
  assert.deepEqual(Object.keys(r).sort(), ['days', 'months', 'rows']);
  const a = mine(r.rows).find((x: any) => x.robotId === 'ss-a');
  assert.ok(Math.abs(a.executionsMonth - a.executions / a.monthsCovered) < 1e-9);
  assert.equal(a.metricKey, 'notas');
  assert.equal(a.metricAvg, 20, 'média das 3 execuções que informaram (10, 20 e 30)');
});

test('frases do simulador trazem ícone e a unidade escolhida', { skip }, async () => {
  const r = await reports.simulateGains(admin, { ...range(), scope: 'sem', base: 'exec', times: { 'ss-a': 300 }, unit: 'hours', defaultIds: ['ss-a'] });
  assert.ok(r.insights.every((i: any) => i.icon));
  assert.ok(r.insights.some((i: any) => i.icon === '±' && /Cada 1 h a mais/.test(i.text)));
  assert.ok(r.insights.some((i: any) => i.icon === '=' && /tempo padrão/.test(i.text)));
});

test('robôs externos: só entram se pedido (escopo "todos"), como quem já tem ganho; novo tempo simula sem gravar', { skip }, async () => {
  await prisma.execution.deleteMany({ where: { robotId: 'ss-ext' } });
  const when = day(2);
  const addExt = (id: string, units: number | null, gain: number) =>
    prisma.execution.create({
      data: { id, robotId: 'ss-ext', userId: 'ss-user', status: 'success', createdAt: when, startedAt: when, finishedAt: new Date(when.getTime() + 1000), unitsProcessed: units, manualEstimatedSeconds: gain },
    });
  await addExt('ss-ex-e1', 3, 360);
  await addExt('ss-ex-e2', 3, 360);
  await addExt('ss-ex-e3', null, 120); // não informou a quantidade: 1 por execução
  await addExt('ss-ex-e4', 0, 120); // informou 0: também conta 1 (o ganho já veio gravado)
  // o externo começou há 2 dias: a projeção dele conta só desde o 1º dia (meses do calendário calculados à parte)
  const months = calendarMonths(iso(day(2)), iso(new Date()));

  // padrão: sem a opção, o externo nunca aparece (nem no escopo "todos")
  const sem = await reports.simulateGains(admin, { ...range(), scope: 'todos', base: 'exec' });
  assert.equal(mine(sem.rows).some((x: any) => x.robotId === 'ss-ext'), false);
  // a opção só vale no escopo "todos"
  const escopoSem = await reports.simulateGains(admin, { ...range(), scope: 'sem', base: 'exec', includeExternal: true });
  assert.equal(mine(escopoSem.rows).some((x: any) => x.robotId === 'ss-ext'), false);

  // com a opção: entra como quem já tem ganho, com o tempo atual (nada muda sem novo tempo)
  const incl = await reports.simulateGains(admin, { ...range(), scope: 'todos', base: 'exec', includeExternal: true });
  const ext = mine(incl.rows).find((x: any) => x.robotId === 'ss-ext');
  assert.ok(ext, 'o externo aparece');
  assert.equal(ext.external, true);
  assert.equal(ext.hasTime, true);
  assert.equal(ext.source, 'atual');
  assert.equal(ext.executions, 4);
  assert.ok(Math.abs(ext.currentMonth - 960 / months) < 1e-6, `${ext.currentMonth}`);
  assert.ok(Math.abs(ext.simulatedMonth - ext.currentMonth) < 1e-6);
  assert.ok(Math.abs(ext.currentPerUnit - 120) < 1e-9, `8 itens (3+3+1+1) para 960 s = 120 s por item: ${ext.currentPerUnit}`);
  // os demais robôs não mudam por causa da opção
  for (const id of ['ss-a', 'ss-b']) {
    const antes = mine(sem.rows).find((x: any) => x.robotId === id);
    const depois = mine(incl.rows).find((x: any) => x.robotId === id);
    assert.equal(depois.currentMonth, antes.currentMonth);
    assert.equal(depois.simulatedMonth, antes.simulatedMonth);
  }

  // novo tempo (180 s por item) no externo: 8 itens × 180 s = 1.440 s no período; extra = +480 s
  const novo = await reports.simulateGains(admin, { ...range(), scope: 'todos', base: 'exec', includeExternal: true, times: { 'ss-ext': 180 } });
  const e2 = mine(novo.rows).find((x: any) => x.robotId === 'ss-ext');
  assert.equal(e2.source, 'novo');
  assert.ok(Math.abs(e2.simulatedMonth - 1440 / months) < 1e-6);
  assert.ok(Math.abs(novo.fromNewTimes - 480 / months) < 1e-6, `${novo.fromNewTimes}`);
  assert.ok(novo.insights.some((i: any) => /robô externo/.test(i.text) && /não grava/.test(i.text)), 'avisa que o tempo vem do sistema dele');
  // a evolução mensal também usa o externo
  const mes = novo.monthly.months.find((m: any) => m.extra > 0);
  assert.ok(mes, 'algum mês recebe o extra do externo');

  // o modo leve (tabela do formulário) também respeita a opção
  const leve = await reports.simulateGains(admin, { ...range(), scope: 'todos', base: 'exec', includeExternal: true, light: true });
  assert.ok(mine(leve.rows).some((x: any) => x.robotId === 'ss-ext'));
  const leveSem = await reports.simulateGains(admin, { ...range(), scope: 'todos', base: 'exec', light: true });
  assert.equal(mine(leveSem.rows).some((x: any) => x.robotId === 'ss-ext'), false);
});
