// Robôs sem ganho contra um PostgreSQL REAL e DESCARTÁVEL (mesma trava dos outros testes com banco: hub_dev, porta 5544).
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

const tmp = mkdtempSync(join(tmpdir(), 'sg-db-'));
const cwdOriginal = process.cwd();
let prisma: any;
let reports: any;
let robots: any;
const ROBOTS = ['sg-a', 'sg-b', 'sg-ext', 'sg-off'];
const day = (n: number) => new Date(Date.now() - n * 86400_000);

async function wipe() {
  await prisma.executionLog.deleteMany({ where: { executionId: { startsWith: 'sg-ex' } } });
  await prisma.execution.deleteMany({ where: { id: { startsWith: 'sg-ex' } } });
  await prisma.robot.deleteMany({ where: { id: { in: ROBOTS } } });
  await prisma.user.deleteMany({ where: { id: 'sg-user' } });
}

before(async () => {
  if (skip) return;
  process.chdir(tmp);
  process.env.DATABASE_URL = url;
  const { PrismaService } = await import('../src/prisma/prisma.service');
  const { ReportsService } = await import('../src/reports/reports.service');
  const { RobotsService } = await import('../src/robots/robots.service');
  prisma = new PrismaService();
  await prisma.$connect();
  reports = new ReportsService(prisma);
  robots = new RobotsService(prisma);
  await wipe();
  await prisma.user.create({ data: { id: 'sg-user', name: 'Admin SG', email: 'sg-user@example.invalid', passwordHash: 'x', role: 'admin', departments: [] } });
  await prisma.robot.createMany({
    data: [
      { id: 'sg-a', slug: 'sg-a', name: 'SG Sem tempo', command: 'echo', manualSecondsPerUnit: 0, allowedDepartments: ['fiscal'], summary: 'resumo que não pode sumir' },
      { id: 'sg-b', slug: 'sg-b', name: 'SG Com tempo', command: 'echo', manualSecondsPerUnit: 30 },
      { id: 'sg-ext', slug: 'sg-ext', name: 'SG Externo', command: 'echo', manualSecondsPerUnit: 0, isExternal: true },
      { id: 'sg-off', slug: 'sg-off', name: 'SG Inativo', command: 'echo', manualSecondsPerUnit: 0, isActive: false },
    ],
  });
  let n = 0;
  const add = async (robotId: string, status: string, when: Date, extra: Record<string, unknown> = {}) => {
    const id = `sg-ex${++n}`;
    await prisma.execution.create({ data: { id, robotId, userId: 'sg-user', status, createdAt: when, startedAt: when, finishedAt: new Date(when.getTime() + 60_000), manualEstimatedSeconds: 0, ...extra } });
    return id;
  };
  // sg-a: 3 sucessos no período (2 informaram a métrica "empresas"), 1 erro (não conta), 1 sucesso antigo (fora do período)
  const e1 = await add('sg-a', 'success', day(2), { unitsProcessed: 10 });
  const e2 = await add('sg-a', 'success', day(3), { unitsProcessed: 4 });
  await add('sg-a', 'success', day(4));
  await add('sg-a', 'error', day(5));
  const old = await add('sg-a', 'success', day(100));
  for (const [id, msg] of [[e1, 'Metrica registrada: empresas=6'], [e1, 'Metrica registrada: empresas=4'], [e2, 'Metrica registrada: empresas=4'], [old, 'Metrica registrada: empresas=999']]) {
    await prisma.executionLog.create({ data: { executionId: id, level: 'info', message: msg } });
  }
  await add('sg-b', 'success', day(2));
  await add('sg-ext', 'success', day(2));
  await add('sg-off', 'success', day(2));
});

after(async () => {
  process.chdir(cwdOriginal);
  if (prisma) {
    await wipe();
    await prisma.onModuleDestroy();
  }
  limparTmp(tmp);
});

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('lista: só robô ativo do Hub com tempo 0, com uso no período, métricas e itens gravados', { skip }, async () => {
  const r = await reports.listRobotsWithoutGain({ from: iso(day(30)), to: iso(new Date()) });
  const mine = r.robots.filter((x: any) => ROBOTS.includes(x.robotId));
  assert.deepEqual(mine.map((x: any) => x.robotId), ['sg-a'], 'com tempo, externo e inativo ficam de fora');
  const a = mine[0];
  assert.equal(a.name, 'SG Sem tempo');
  assert.deepEqual(a.departments, ['fiscal']);
  assert.equal(a.executions, 3, 'só sucessos do período: o erro e o antigo não contam');
  assert.ok(a.lastExecutionAt);
  assert.deepEqual(a.recordedUnits, { executions: 2, total: 14 });
  assert.deepEqual(a.metrics, [{ key: 'empresas', executions: 2, total: 14 }], 'a métrica do sucesso antigo (fora do período) não entra');
});

test('lista: sem datas vale o histórico todo', { skip }, async () => {
  const r = await reports.listRobotsWithoutGain({});
  const a = r.robots.find((x: any) => x.robotId === 'sg-a');
  assert.equal(a.executions, 4);
  assert.equal(r.range, null);
  assert.equal(a.metrics[0].total, 1013);
});

test('salvar: muda só os 3 campos, não mexe no resto do cadastro nem nas execuções passadas', { skip }, async () => {
  const updated = await robots.updateTimeSavings('sg-a', { manualSecondsPerUnit: 300, unitLabel: 'empresa', unitMetricKey: 'Empresas' }, { id: 'sg-user' });
  assert.deepEqual([updated.manualSecondsPerUnit, updated.unitLabel, updated.unitMetricKey], [300, 'empresa', 'empresas']);
  const robot = await prisma.robot.findUnique({ where: { id: 'sg-a' } });
  assert.equal(robot.summary, 'resumo que não pode sumir');
  assert.equal(robot.command, 'echo');
  assert.deepEqual(robot.allowedDepartments, ['fiscal']);
  assert.equal(robot.name, 'SG Sem tempo');
  const past = await prisma.execution.findMany({ where: { robotId: 'sg-a' }, select: { manualEstimatedSeconds: true } });
  assert.ok(past.every((e: any) => e.manualEstimatedSeconds === 0), 'o passado continua como estava (só vale daqui pra frente)');
  const r = await reports.listRobotsWithoutGain({});
  assert.equal(r.robots.some((x: any) => x.robotId === 'sg-a'), false, 'depois de configurado o robô sai da lista');
});

test('salvar: recusa robô externo, robô que não existe e valores inválidos', { skip }, async () => {
  await assert.rejects(() => robots.updateTimeSavings('sg-ext', { manualSecondsPerUnit: 60, unitLabel: 'x' }, { id: 'sg-user' }), /externos/);
  await assert.rejects(() => robots.updateTimeSavings('nao-existe', { manualSecondsPerUnit: 60, unitLabel: 'x' }, { id: 'sg-user' }), /não encontrada/);
  await assert.rejects(() => robots.updateTimeSavings('sg-off', { manualSecondsPerUnit: 0, unitLabel: 'x' }, { id: 'sg-user' }), /pelo menos 1 segundo/);
  const off = await prisma.robot.findUnique({ where: { id: 'sg-off' } });
  assert.equal(off.manualSecondsPerUnit, 0, 'nada foi gravado');
});

test('lista com "todos": traz quem já tem tempo, execuções agendadas e as execuções com ganho 0 de robôs que já têm tempo', { skip }, async () => {
  // sg-b tem 30 s por item: uma execução recente com ganho 0 (0 itens) e outra gravada com 0 h antes de ter tempo
  await prisma.execution.create({ data: { id: 'sg-ex-zero1', robotId: 'sg-b', userId: 'sg-user', status: 'success', createdAt: day(1), startedAt: day(1), finishedAt: new Date(day(1).getTime() + 60_000), manualEstimatedSeconds: 0, unitsProcessed: 0 } });
  await prisma.execution.create({ data: { id: 'sg-ex-zero2', robotId: 'sg-b', userId: 'sg-user', status: 'success', createdAt: day(2), startedAt: day(2), finishedAt: new Date(day(2).getTime() + 60_000), manualEstimatedSeconds: 0 } });
  const range = { from: iso(day(30)), to: iso(new Date()) };
  const sem = await reports.listRobotsWithoutGain(range);
  assert.equal(sem.robots.some((x: any) => x.robotId === 'sg-b'), false, 'sem o "todos", só quem não tem tempo');
  const all = await reports.listRobotsWithoutGain({ ...range, all: true });
  const b = all.robots.find((x: any) => x.robotId === 'sg-b');
  assert.equal(b.manualSecondsPerUnit, 30);
  assert.equal(b.scheduledExecutions, 0);
  const other = sem.others.find((x: any) => x.robotId === 'sg-b');
  // (a execução que o próprio preparo do teste criou para o sg-b também tem ganho 0 e conta como "antes de ter tempo")
  assert.deepEqual([other.zeroItems, other.beforeTime], [1, 2], 'uma com 0 itens (esperado) e duas gravadas antes de o robô ter tempo');
});
