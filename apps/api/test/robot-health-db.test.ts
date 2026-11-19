// Saúde dos robôs contra um PostgreSQL REAL e DESCARTÁVEL (mesma trava dos outros testes com banco: hub_dev, porta 5544).
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

const tmp = mkdtempSync(join(tmpdir(), 'health-db-'));
const cwdOriginal = process.cwd();
let prisma: any;
let health: any;
const U: Record<string, any> = {};
const ids = { robots: ['h-robo', 'h-ext', 'h-b'], executions: [] as string[] };
const day = (n: number, h = 10) => new Date(Date.now() - n * 86400_000 + (h - 10) * 3600_000);

before(async () => {
  if (skip) return;
  process.chdir(tmp);
  process.env.DATABASE_URL = url;
  const { PrismaService } = await import('../src/prisma/prisma.service');
  const { RobotHealthService } = await import('../src/robot-health/robot-health.service');
  prisma = new PrismaService();
  await prisma.$connect();
  health = new RobotHealthService(prisma);
  const mk = (id: string, name: string, role: string, departments: string[]) =>
    prisma.user.upsert({ where: { id }, update: { role, departments, isActive: true }, create: { id, name, email: `${id}@example.invalid`, passwordHash: 'x', role, departments } });
  U.adm = await mk('h-adm', 'Admin', 'admin', []);
  U.ino = await mk('h-ino', 'Inovação', 'employee', ['inovacao']);
  U.mgr = await mk('h-mgr', 'Gestor', 'manager', ['fiscal']);
  U.emp = await mk('h-emp', 'Funcionário', 'employee', ['fiscal']);
  await wipe();
  await prisma.robot.createMany({
    data: [
      { id: 'h-robo', slug: 'h-robo', name: 'Robô Saúde A', command: 'echo' },
      { id: 'h-ext', slug: 'h-ext', name: 'Robô Externo', command: 'echo', isExternal: true },
      { id: 'h-b', slug: 'h-b', name: 'Robô Saúde B', command: 'echo' },
    ],
  });
  let n = 0;
  const add = async (robotId: string, status: string, when: Date, extra: Record<string, unknown> = {}) => {
    const id = `h-ex${++n}`;
    ids.executions.push(id);
    await prisma.execution.create({
      data: { id, robotId, userId: 'h-emp', status, createdAt: when, startedAt: when, finishedAt: new Date(when.getTime() + 120_000), ...extra },
    });
  };
  // Robô A, período atual (últimos 30 dias): 8 sucessos + 2 erros do robô + 1 erro do Hub + 1 cancelada (1 agendada)
  for (let i = 0; i < 8; i++) await add('h-robo', 'success', day(2 + i), i === 0 ? { scheduledTaskId: null } : {});
  await add('h-robo', 'error', day(3), { errorMessage: "KeyError: 'x'" });
  await add('h-robo', 'error', day(4), { errorMessage: 'HTTP 503' });
  await add('h-robo', 'error', day(5), { errorMessage: 'Execução interrompida: o servidor do Hub foi reiniciado' });
  await add('h-robo', 'canceled', day(6));
  // Robô A, período anterior (31–60 dias atrás): 10 sucessos
  for (let i = 0; i < 10; i++) await add('h-robo', 'success', day(35 + i));
  // Robô B: crítico (3 sucessos, 3 erros)
  for (let i = 0; i < 3; i++) await add('h-b', 'success', day(2 + i));
  for (let i = 0; i < 3; i++) await add('h-b', 'error', day(2 + i), { errorMessage: 'Comando finalizado com codigo 1' });
  // Externo: nunca entra em conta nenhuma
  for (let i = 0; i < 5; i++) await add('h-ext', 'success', day(2 + i));
  // Em andamento: também não entra
  await add('h-robo', 'running', day(1), { finishedAt: null });
});

async function wipe() {
  await prisma.execution.deleteMany({ where: { id: { startsWith: 'h-ex' } } });
  await prisma.scheduledTask.deleteMany({ where: { id: { startsWith: 'h-task' } } });
  await prisma.robot.deleteMany({ where: { id: { in: ids.robots } } });
}

after(async () => {
  process.chdir(cwdOriginal);
  if (prisma) {
    await wipe();
    await prisma.onModuleDestroy();
  }
  limparTmp(tmp);
});

test('acesso: só administrador e Inovação; funcionário e gestor recebem 404', { skip }, async () => {
  assert.ok(await health.overview(U.adm, {}));
  assert.ok(await health.overview(U.ino, {}));
  await assert.rejects(() => health.overview(U.mgr, {}), /não encontrada/);
  await assert.rejects(() => health.overview(U.emp, {}), /não encontrada/);
});

test('números: só robôs do Hub, sem externo nem em andamento, com erro do Hub e cancelada fora da taxa', { skip }, async () => {
  const r = await health.overview(U.adm, {});
  const mine = r.robots.filter((x: any) => ['h-robo', 'h-b'].includes(x.robotId));
  assert.equal(r.robots.some((x: any) => x.robotId === 'h-ext'), false, 'externo fora');
  const a = mine.find((x: any) => x.robotId === 'h-robo');
  assert.equal(a.success, 8);
  assert.equal(a.errors, 2);
  assert.equal(a.hubErrors, 1);
  assert.equal(a.canceled, 1);
  assert.equal(a.executions, 12, 'o "em andamento" não conta');
  assert.equal(a.successRate, 0.8);
  assert.equal(a.situation, 'attention', '20% de erro');
  assert.equal(a.name, 'Robô Saúde A');
  assert.ok(a.mainCause.cause);
  const b = mine.find((x: any) => x.robotId === 'h-b');
  assert.equal(b.situation, 'critical');
  assert.equal(b.errors, 3);
  assert.equal(r.period.days, 30);
  assert.equal(r.summary.previous.success >= 10, true, 'o período anterior traz os 10 sucessos antigos');
  assert.equal(r.categories.granularity, 'day');
  assert.equal(r.categories.buckets.length, 30);
  const totalErrors = r.categories.buckets.reduce((s: number, b: any) => s + b.total, 0);
  assert.ok(totalErrors >= 6, 'os erros aparecem nos baldes (inclui o do Hub, que tem categoria própria)');
  assert.equal(r.categoryInfo.length, 6);
});

test('escopo manual × agendada e período todo o histórico', { skip }, async () => {
  await prisma.scheduledTask.deleteMany({ where: { id: 'h-task' } });
  await prisma.scheduledTask.create({
    data: { id: 'h-task', name: 'Agendamento teste', robotId: 'h-robo', userId: 'h-emp', frequency: 'daily', timeOfDay: '08:00', nextRunAt: new Date() },
  });
  try {
    await prisma.execution.update({ where: { id: 'h-ex1' }, data: { scheduledTaskId: 'h-task' } });
    const scheduled = await health.overview(U.adm, { scope: 'scheduled' });
    const a = scheduled.robots.find((x: any) => x.robotId === 'h-robo');
    assert.equal(a.executions, 1, 'só a agendada');
    const manual = await health.overview(U.adm, { scope: 'manual' });
    assert.equal(manual.robots.find((x: any) => x.robotId === 'h-robo').executions, 11);
  } finally {
    await prisma.execution.update({ where: { id: 'h-ex1' }, data: { scheduledTaskId: null } });
    await prisma.scheduledTask.delete({ where: { id: 'h-task' } });
  }
  const all = await health.overview(U.adm, { all: '1' });
  assert.equal(all.allHistory, true);
  assert.equal(all.previousPeriod, null, 'todo o histórico não tem período anterior');
  assert.ok(all.robots.find((x: any) => x.robotId === 'h-robo').executions >= 22, 'inclui os 10 sucessos antigos');
  const weird = await health.overview(U.adm, { from: 'lixo', to: '2026-99-99', scope: 'xyz', granularity: 'abc' });
  assert.equal(weird.scope, 'all');
  assert.equal(weird.period.days, 30, 'valores inválidos viram o padrão');
});

test('etapa 2: evolução, duração dos robôs mais usados e mapa robô × dia na resposta', { skip }, async () => {
  const r = await health.overview(U.adm, {});
  assert.equal(r.evolution.length, 30, 'um balde por dia no período de 30 dias');
  const sumSuccess = r.evolution.reduce((s: number, b: any) => s + b.success, 0);
  assert.equal(sumSuccess, r.summary.current.success, 'a evolução soma o mesmo que o indicador');
  assert.equal(r.evolution.reduce((s: number, b: any) => s + b.errors, 0), r.summary.current.errors);
  assert.ok(r.durations.length >= 1 && r.durations.length <= 4);
  assert.ok(r.durations.every((d: any) => d.points.length === 30 && d.name && d.executions >= 3 && 't2Minutes' in d), 'só robôs com 3 sucessos ou mais');
  assert.equal(r.daily.length, 30, 'execuções por dia: um balde por dia');
  assert.equal(r.mini.granularity, 'week');
  assert.ok(r.mini.buckets.length >= 4);
  const robotA = r.robots.find((x: any) => x.robotId === 'h-robo');
  assert.equal(robotA.trend.length, r.mini.buckets.length, 'a tendência de cada robô acompanha os baldes do minigráfico');
  assert.ok(robotA.lastSuccessAt);
  assert.ok(r.summary.current.medianDurationSeconds > 0 && r.summary.current.p95DurationSeconds >= r.summary.current.medianDurationSeconds);
  assert.ok(r.causes.every((c: any) => Array.isArray(c.robotList) && c.robotList.every((x: any) => x.name)), 'causas trazem os robôs, com nome');
  assert.deepEqual(r.categoryInfo.map((c: any) => c.key), ['entrada', 'externo', 'hub', 'config', 'robo', 'sem']);
  assert.equal(r.heatmap.granularity, 'day');
  assert.equal(r.heatmap.buckets.length, 30);
  const a = r.heatmap.rows.find((x: any) => x.robotId === 'h-robo');
  assert.equal(a.name, 'Robô Saúde A');
  const totals = a.cells.reduce((acc: number[], c: number[]) => acc.map((v, i) => v + c[i]), [0, 0, 0, 0]);
  assert.deepEqual(totals, [8, 2, 1, 1], 'sucessos, erros do robô, erro do Hub e cancelada do Robô A');
  assert.equal(r.heatmap.rows.some((x: any) => x.robotId === 'h-ext'), false, 'externo fora do mapa');
  const longo = await health.overview(U.adm, { all: '1' });
  assert.ok(['day', 'week', 'month'].includes(longo.heatmap.granularity));
});


test('etapa 3: capacidade do servidor, ciclos dos agendamentos e insights na resposta', { skip }, async () => {
  await prisma.scheduledTask.create({
    data: { id: 'h-task1', name: 'Agendamento Saúde', robotId: 'h-b', userId: 'h-emp', frequency: 'daily', timeOfDay: '08:00', nextRunAt: new Date(Date.now() + 86400_000), verifyT0Minutes: 10, verifyT1Minutes: 10, verifyT2Minutes: 10 },
  });
  const mk = (id: string, status: string, when: Date, extra: Record<string, unknown> = {}) =>
    prisma.execution.create({ data: { id, robotId: 'h-b', userId: 'h-emp', status, createdAt: when, startedAt: when, finishedAt: new Date(when.getTime() + 120_000), scheduledTaskId: 'h-task1', ...extra } });
  await mk('h-ex-c1', 'success', day(8));
  await mk('h-ex-c2', 'error', day(9), { errorMessage: 'HTTP 503' });
  await mk('h-ex-c3', 'success', day(9, 11), { attempt: 2, restartOfId: 'h-ex-c2' });
  await mk('h-ex-c4', 'canceled', day(10), { errorMessage: 'Cancelada automaticamente: passou do tempo máximo (60 min desde o início). Não foi reiniciada.' });

  const r = await health.overview(U.adm, {});
  assert.equal(r.capacity.hours.length, 24);
  assert.ok(r.capacity.limit >= 1 && r.capacity.any === true);
  assert.ok(Array.isArray(r.capacity.quiet.ranges));
  const c = r.cycles.find((x: any) => x.taskId === 'h-task1');
  assert.ok(c, 'o agendamento aparece nos ciclos');
  assert.equal(c.name, 'Agendamento Saúde');
  assert.equal(c.hasRestart, true);
  assert.deepEqual([c.ok, c.recovered, c.failed, c.canceled], [1, 1, 0, 1]);
  assert.ok(Array.isArray(r.insights) && r.insights.every((i: any) => i.id && i.title && i.why && ['crit', 'warn', 'info', 'good'].includes(i.sev)));
  assert.ok(r.insights.some((i: any) => i.id === 'agend-salvos'), 'o reinício que salvou um ciclo é lembrado');

  // a capacidade e os ciclos ignoram o filtro de origem; os insights seguem o filtro
  const manual = await health.overview(U.adm, { scope: 'manual' });
  assert.deepEqual(manual.capacity.hours.map((h: any) => h.peak), r.capacity.hours.map((h: any) => h.peak));
  assert.ok(manual.cycles.find((x: any) => x.taskId === 'h-task1'));
});
