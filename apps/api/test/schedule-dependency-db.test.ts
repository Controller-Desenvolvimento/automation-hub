// Testes de dependência entre agendamentos e teto de tempo contra um PostgreSQL REAL e DESCARTÁVEL.
// Só rodam com TEST_DATABASE_URL apontando para um banco de teste (nome "hub_dev", porta 5544): a trava abaixo recusa
// qualquer outro, para nunca apagar dados do banco de produção. Sem a variável, os testes são ignorados.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { limparTmp } from './_limpar-tmp';
import test, { after, before, beforeEach } from 'node:test';
import { BadRequestException } from '@nestjs/common';

/* eslint-disable @typescript-eslint/no-explicit-any */
const url = process.env.TEST_DATABASE_URL ?? '';
const skip = !/\/hub_dev(\?|$)/.test(url) || !/:5544\//.test(url)
  ? 'defina TEST_DATABASE_URL apontando para o banco descartável (hub_dev na porta 5544)'
  : false;

const tmp = mkdtempSync(join(tmpdir(), 'dep-db-'));
const cwdOriginal = process.cwd();
let prisma: any;
let executions: any;
let scheduledTasks: any;
let checks: any;
const sent = { skipped: [] as any[], simple: [] as any[], restartFailed: [] as any[] };
const stopped: string[] = [];

const mail = {
  sendDependencySkippedAlert: async (i: unknown) => { sent.skipped.push(i); },
  sendScheduledExecutionAlert: async (i: unknown) => { sent.simple.push(i); },
  sendRestartFailedAlert: async (i: unknown) => { sent.restartFailed.push(i); },
  sendScheduleSlowAlert: async () => undefined,
};
const runner = { stopExecution: async (id: string) => { stopped.push(id); } };

before(async () => {
  if (skip) return;
  process.chdir(tmp); // o storage vai para uma pasta temporária
  process.env.DATABASE_URL = url;
  const { PrismaService } = await import('../src/prisma/prisma.service');
  const { ExecutionsService } = await import('../src/executions/executions.service');
  const { ScheduledTasksService } = await import('../src/scheduled-tasks/scheduled-tasks.service');
  const { ScheduleChecksService } = await import('../src/scheduled-tasks/schedule-checks.service');
  prisma = new PrismaService();
  await prisma.$connect();
  executions = new ExecutionsService(prisma);
  scheduledTasks = new ScheduledTasksService(prisma, executions, mail as any);
  checks = new ScheduleChecksService(prisma, executions, runner as any, scheduledTasks, mail as any);
  await prisma.user.upsert({ where: { id: 'u1' }, update: {}, create: { id: 'u1', name: 'Teste', email: 'teste@example.invalid', passwordHash: 'x' } });
  for (const [id, slug, name] of [['rg', 'robo-gestta', 'Robô Gestta'], ['rx', 'robo-excel', 'Robô Excel']]) {
    await prisma.robot.upsert({ where: { id }, update: {}, create: { id, slug, name, command: 'echo ok' } });
  }
});

after(async () => {
  process.chdir(cwdOriginal);
  if (prisma) await prisma.onModuleDestroy();
  limparTmp(tmp);
});

beforeEach(async () => {
  if (skip) return;
  await prisma.executionLog.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.execution.deleteMany();
  await prisma.scheduledTask.deleteMany();
  sent.skipped.length = 0; sent.simple.length = 0; sent.restartFailed.length = 0; stopped.length = 0;
});

const T = { verifyT0Minutes: 20, verifyT1Minutes: 15, verifyT2Minutes: 10 };
const min = (n: number) => new Date(Date.now() + n * 60_000);

async function mkTask(id: string, name: string, robotId: string, extra: Record<string, any> = {}) {
  return prisma.scheduledTask.create({
    data: { id, name, robotId, userId: 'u1', frequency: 'daily', timeOfDay: '06:00', timesOfDay: ['06:00'], nextRunAt: min(-1), ...extra },
  });
}
async function mkExec(id: string, robotId: string, taskId: string | null, extra: Record<string, any> = {}) {
  return prisma.execution.create({ data: { id, robotId, userId: 'u1', scheduledTaskId: taskId, status: 'running', startedAt: min(-10), createdAt: min(-10), ...extra } });
}
const wait = (ms = 25) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------------------
// Disparo do agendamento dependente
// ---------------------------------------------------------------------------------------------------------------
test('disparo: ciclo do Gestta ainda rodando → o Excel entra na fila RETIDO, com o motivo visível', { skip }, async () => {
  await mkTask('tg', 'Gestta 06:30', 'rg', T);
  await mkTask('tx', 'Excel 06:55', 'rx', { dependsOnTaskId: 'tg' });
  await mkExec('cg1', 'rg', 'tg', { status: 'running' });

  await scheduledTasks.triggerTask('tx');
  const ex = await prisma.execution.findFirst({ where: { scheduledTaskId: 'tx' } });
  assert.equal(ex.status, 'queued');
  assert.equal(ex.waitingOnExecutionId, 'cg1');
  assert.match(ex.currentStep, /Aguardando o agendamento "Gestta 06:30" terminar/);
  assert.equal(sent.skipped.length, 0);
  assert.equal((await prisma.scheduledTask.findUnique({ where: { id: 'tx' } })).lastExecutionId, ex.id);
});

test('disparo: ciclo do Gestta já terminou com sucesso → o Excel roda normal (não retido)', { skip }, async () => {
  if (skip) return;
  await mkTask('tg', 'Gestta 06:30', 'rg', T);
  await mkTask('tx', 'Excel 06:55', 'rx', { dependsOnTaskId: 'tg' });
  await mkExec('cg1', 'rg', 'tg', { status: 'success', finishedAt: min(-5) });
  await scheduledTasks.triggerTask('tx');
  const ex = await prisma.execution.findFirst({ where: { scheduledTaskId: 'tx' } });
  assert.equal(ex.status, 'queued');
  assert.equal(ex.waitingOnExecutionId, null);
});

test('disparo: ciclo do Gestta falhou → o Excel é PULADO: fica no histórico como cancelado, com motivo, e avisa por e-mail', { skip }, async () => {
  if (skip) return;
  await mkTask('tg', 'Gestta 06:30', 'rg', T);
  await mkTask('tx', 'Excel 06:55', 'rx', { dependsOnTaskId: 'tg' });
  await mkExec('cg1', 'rg', 'tg', { status: 'error', finishedAt: min(-5), errorMessage: 'Download incompleto' });
  await scheduledTasks.triggerTask('tx');
  await wait();
  const ex = await prisma.execution.findFirst({ where: { scheduledTaskId: 'tx' } });
  assert.equal(ex.status, 'canceled');
  assert.match(ex.errorMessage, /Pulada: O agendamento "Gestta 06:30" terminou com erro: Download incompleto/);
  assert.match((await prisma.scheduledTask.findUnique({ where: { id: 'tx' } })).lastError, /Pulada neste ciclo/);
  assert.equal(sent.skipped.length, 1);
  assert.equal(sent.skipped[0].dependentSchedule, 'Excel 06:55');
  assert.equal(sent.skipped[0].dependencySchedule, 'Gestta 06:30');
  assert.equal(sent.skipped[0].dependencyExecutionId, 'cg1');
});

test('disparo: um Gestta de ciclo ANTERIOR (antes da última execução do Excel) não vale para este ciclo', { skip }, async () => {
  if (skip) return;
  await mkTask('tg', 'Gestta 06:30', 'rg', T);
  await mkTask('tx', 'Excel 06:55', 'rx', { dependsOnTaskId: 'tg', lastRunAt: min(-30) });
  await mkExec('cg0', 'rg', 'tg', { status: 'error', finishedAt: min(-200), createdAt: min(-240), errorMessage: 'ontem falhou' });
  await scheduledTasks.triggerTask('tx');
  const ex = await prisma.execution.findFirst({ where: { scheduledTaskId: 'tx' } });
  assert.equal(ex.status, 'queued');            // o Gestta não disparou neste ciclo e não há erro de disparo: roda normal
  assert.equal(ex.waitingOnExecutionId, null);
});

test('disparo: Gestta que falhou ao INICIAR neste ciclo (lastError) → Excel pulado', { skip }, async () => {
  if (skip) return;
  await mkTask('tg', 'Gestta 06:30', 'rg', { ...T, lastError: 'Esta automação exige upload obrigatório.' });
  await mkTask('tx', 'Excel 06:55', 'rx', { dependsOnTaskId: 'tg' });
  await scheduledTasks.triggerTask('tx');
  const ex = await prisma.execution.findFirst({ where: { scheduledTaskId: 'tx' } });
  assert.equal(ex.status, 'canceled');
  assert.match(ex.errorMessage, /falhou ao iniciar/);
  assert.equal(sent.skipped.length, 1);
  assert.equal(sent.skipped[0].dependencyExecutionId, null);
});

test('disparo: agendamento do Gestta DESATIVADO → a dependência é ignorada e o Excel roda normal', { skip }, async () => {
  if (skip) return;
  await mkTask('tg', 'Gestta 06:30', 'rg', { ...T, isActive: false });
  await mkTask('tx', 'Excel 06:55', 'rx', { dependsOnTaskId: 'tg' });
  await mkExec('cg1', 'rg', 'tg', { status: 'error', finishedAt: min(-5) });
  await scheduledTasks.triggerTask('tx');
  const ex = await prisma.execution.findFirst({ where: { scheduledTaskId: 'tx' } });
  assert.equal(ex.status, 'queued');
  assert.equal(ex.waitingOnExecutionId, null);
});

test('disparo: Gestta executado À MÃO não conta (só o disparo agendado define o ciclo)', { skip }, async () => {
  if (skip) return;
  await mkTask('tg', 'Gestta 06:30', 'rg', T);
  await mkTask('tx', 'Excel 06:55', 'rx', { dependsOnTaskId: 'tg' });
  await mkExec('manual1', 'rg', null, { status: 'success', finishedAt: min(-1) });      // manual: sem agendamento
  await mkExec('cg1', 'rg', 'tg', { status: 'running' });                                // o agendado ainda roda
  await scheduledTasks.triggerTask('tx');
  const ex = await prisma.execution.findFirst({ where: { scheduledTaskId: 'tx' } });
  assert.equal(ex.waitingOnExecutionId, 'cg1', 'o Gestta manual não libera o Excel agendado');
});

test('disparo: sem dependência configurada nada muda', { skip }, async () => {
  if (skip) return;
  await mkTask('tx', 'Excel 06:55', 'rx');
  await scheduledTasks.triggerTask('tx');
  const ex = await prisma.execution.findFirst({ where: { scheduledTaskId: 'tx' } });
  assert.equal(ex.status, 'queued');
  assert.equal(ex.waitingOnExecutionId, null);
});

// ---------------------------------------------------------------------------------------------------------------
// Resolvedor das execuções retidas
// ---------------------------------------------------------------------------------------------------------------
async function setupHeld(cycleStatus: string, extra: Record<string, any> = {}) {
  await mkTask('tg', 'Gestta 06:30', 'rg', T);
  await mkTask('tx', 'Excel 06:55', 'rx', { dependsOnTaskId: 'tg' });
  await mkExec('cg1', 'rg', 'tg', { status: cycleStatus, ...extra });
  await mkExec('hx1', 'rx', 'tx', { status: 'queued', startedAt: null, waitingOnExecutionId: 'cg1', currentStep: 'Aguardando o agendamento "Gestta 06:30" terminar' });
}
const held = () => prisma.execution.findUnique({ where: { id: 'hx1' } });

test('resolvedor: ciclo ainda rodando → continua retido', { skip }, async () => {
  if (skip) return;
  await setupHeld('running');
  await (checks as any).resolveHeld(new Date());
  assert.equal((await held()).waitingOnExecutionId, 'cg1');
});

test('resolvedor: ciclo terminou com sucesso → o Excel é liberado e a fila pode iniciá-lo', { skip }, async () => {
  if (skip) return;
  await setupHeld('success', { finishedAt: new Date() });
  await (checks as any).resolveHeld(new Date());
  const h = await held();
  assert.equal(h.waitingOnExecutionId, null);
  assert.equal(h.status, 'queued');
  assert.equal(sent.skipped.length, 0);
});

test('resolvedor: ciclo falhou → o Excel é pulado (cancelado com motivo) e sai UM e-mail de "pulado"', { skip }, async () => {
  if (skip) return;
  await setupHeld('error', { finishedAt: new Date(), errorMessage: 'Download incompleto' });
  await (checks as any).resolveHeld(new Date());
  await wait();
  const h = await held();
  assert.equal(h.status, 'canceled');
  assert.match(h.errorMessage, /Pulada: O agendamento "Gestta 06:30" terminou com erro/);
  assert.equal(sent.skipped.length, 1);
  assert.equal(sent.skipped[0].dependentSchedule, 'Excel 06:55');
  assert.match((await prisma.scheduledTask.findUnique({ where: { id: 'tx' } })).lastError, /Pulada neste ciclo: O agendamento "Gestta 06:30"/);
});

test('resolvedor: se o e-mail do Gestta já citou o Excel (dependencyNotified), não manda um segundo', { skip }, async () => {
  if (skip) return;
  await setupHeld('error', { finishedAt: new Date(), errorMessage: 'x' });
  await prisma.execution.update({ where: { id: 'hx1' }, data: { dependencyNotified: true } });
  await (checks as any).resolveHeld(new Date());
  await wait();
  assert.equal((await held()).status, 'canceled');
  assert.equal(sent.skipped.length, 0);
});

test('resolvedor: Gestta cancelado em T2 e reinício ainda não criado → pendente (não escapa na brecha)', { skip }, async () => {
  if (skip) return;
  const { t2Reason } = await import('../src/scheduled-tasks/schedule-checks');
  await setupHeld('canceled', { finishedAt: new Date(), errorMessage: t2Reason({ t0: 20, t1: 15, t2: 10 }) });
  await (checks as any).resolveHeld(new Date());
  assert.equal((await held()).waitingOnExecutionId, 'cg1');
  assert.equal((await held()).status, 'queued');
});

test('resolvedor: com reinício, vale o desfecho do reinício (rodando = espera; sucesso = libera; falha = pula)', { skip }, async () => {
  if (skip) return;
  const { t2Reason } = await import('../src/scheduled-tasks/schedule-checks');
  await setupHeld('canceled', { finishedAt: min(-30), errorMessage: t2Reason({ t0: 20, t1: 15, t2: 10 }) });
  await mkExec('cg2', 'rg', 'tg', { status: 'running', attempt: 2, restartOfId: 'cg1' });

  await (checks as any).resolveHeld(new Date());
  assert.equal((await held()).waitingOnExecutionId, 'cg1', 'reinício rodando: continua retido');

  await prisma.execution.update({ where: { id: 'cg2' }, data: { status: 'success', finishedAt: new Date() } });
  await (checks as any).resolveHeld(new Date());
  assert.equal((await held()).waitingOnExecutionId, null, 'reinício deu certo: libera');

  // outro ciclo, reinício que também falhou
  await prisma.execution.update({ where: { id: 'hx1' }, data: { waitingOnExecutionId: 'cg1', status: 'queued', dependencyNotified: false } });
  await prisma.execution.update({ where: { id: 'cg2' }, data: { status: 'canceled', errorMessage: 'passou do T2 de novo' } });
  await (checks as any).resolveHeld(new Date());
  await wait();
  assert.equal((await held()).status, 'canceled');
  assert.equal(sent.skipped[0].dependencyExecutionId, 'cg2', 'o e-mail aponta para a última tentativa');
});

// ---------------------------------------------------------------------------------------------------------------
// E-mail do agendamento que falha: cita quem não rodou
// ---------------------------------------------------------------------------------------------------------------
test('collectSkippedDependents: lista os retidos esperando o ciclo, marca como avisados e não repete', { skip }, async () => {
  if (skip) return;
  await setupHeld('error', { finishedAt: new Date() });
  const first = await executions.collectSkippedDependents('cg1');
  assert.deepEqual(first, ['Robô Excel — Excel 06:55']);
  assert.equal((await held()).dependencyNotified, true);
  assert.deepEqual(await executions.collectSkippedDependents('cg1'), []);
  assert.deepEqual(await executions.collectSkippedDependents('outro-ciclo'), []);
});

// ---------------------------------------------------------------------------------------------------------------
// Teto de tempo ("sem verificação")
// ---------------------------------------------------------------------------------------------------------------
test('teto: passou do tempo rodando → cancela, mata o processo, avisa (kind limit), cita os dependentes e NÃO reinicia', { skip }, async () => {
  if (skip) return;
  await mkTask('tg', 'Gestta 06:30', 'rg', { maxRuntimeMinutes: 30 });
  await mkTask('tx', 'Excel 06:55', 'rx', { dependsOnTaskId: 'tg' });
  await mkExec('cg1', 'rg', 'tg', { status: 'running', startedAt: min(-31) });
  await mkExec('hx1', 'rx', 'tx', { status: 'queued', startedAt: null, waitingOnExecutionId: 'cg1' });

  await checks.tick(new Date());
  await wait(60);
  const g = await prisma.execution.findUnique({ where: { id: 'cg1' } });
  assert.equal(g.status, 'canceled');
  assert.match(g.errorMessage, /passou do tempo máximo \(30 min/);
  assert.deepEqual(stopped, ['cg1']);
  assert.equal(sent.simple.length, 1);
  assert.equal(sent.simple[0].kind, 'limit');
  assert.deepEqual(sent.simple[0].skipped, ['Robô Excel — Excel 06:55']);
  assert.equal(await prisma.execution.count({ where: { restartOfId: 'cg1' } }), 0, 'teto não reinicia');
  // e o Excel retido é pulado no mesmo ciclo (sem 2º e-mail: já foi citado)
  assert.equal((await held()).status, 'canceled');
  assert.equal(sent.skipped.length, 0);
});

test('teto: dentro do tempo não faz nada; com T0/T1/T2 o teto é ignorado', { skip }, async () => {
  if (skip) return;
  await mkTask('tg', 'Gestta', 'rg', { maxRuntimeMinutes: 30 });
  await mkExec('cg1', 'rg', 'tg', { status: 'running', startedAt: min(-29) });
  await mkTask('tc', 'Com T', 'rx', { ...T, maxRuntimeMinutes: 5 });
  await mkExec('cx1', 'rx', 'tc', { status: 'running', startedAt: min(-10) }); // passou de 5, mas com T vale só o T
  await checks.tick(new Date());
  assert.equal((await prisma.execution.findUnique({ where: { id: 'cg1' } })).status, 'running');
  assert.equal((await prisma.execution.findUnique({ where: { id: 'cx1' } })).status, 'running');
  assert.equal(stopped.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// Validações ao salvar o agendamento
// ---------------------------------------------------------------------------------------------------------------
const admin: any = { id: 'u1', name: 'Admin', email: 'a@x', role: 'admin', departments: [] };
const base = () => ({
  name: 'Novo', robotId: 'rx', frequency: 'daily', timesOfDay: ['06:55'],
  startDate: new Date(Date.now() + 36 * 3600_000).toISOString().slice(0, 10),
});

test('salvar: dependência de um agendamento SEM limite de tempo é recusada, com explicação', { skip }, async () => {
  if (skip) return;
  await mkTask('tg', 'Gestta 06:30', 'rg'); // sem T e sem teto
  await assert.rejects(
    () => scheduledTasks.saveTask(admin, { ...base(), dependsOnTaskId: 'tg' }, []),
    (e: unknown) => e instanceof BadRequestException && /precisa ter verificação por tempo/.test((e as Error).message),
  );
});

test('salvar: dependência de um agendamento COM T0/T1/T2 ou com teto é aceita', { skip }, async () => {
  if (skip) return;
  await mkTask('tg', 'Gestta com T', 'rg', T);
  await mkTask('tt', 'Gestta com teto', 'rg', { maxRuntimeMinutes: 60 });
  const a = await scheduledTasks.saveTask(admin, { ...base(), name: 'A', dependsOnTaskId: 'tg' }, []);
  const b = await scheduledTasks.saveTask(admin, { ...base(), name: 'B', dependsOnTaskId: 'tt' }, []);
  assert.equal(a.dependsOnTaskId, 'tg');
  assert.equal(b.dependsOnTaskId, 'tt');
});

test('salvar: dependência de si mesmo, de agendamento inexistente e circular são recusadas', { skip }, async () => {
  if (skip) return;
  await mkTask('ta', 'A', 'rg', T);
  await mkTask('tb', 'B', 'rx', { ...T, dependsOnTaskId: 'ta' });
  await assert.rejects(() => scheduledTasks.saveTask(admin, { ...base(), id: 'ta', name: 'A', robotId: 'rg', dependsOnTaskId: 'ta' }, []), /dele mesmo/);
  await assert.rejects(() => scheduledTasks.saveTask(admin, { ...base(), dependsOnTaskId: 'nao-existe' }, []), /não existe/);
  // A depende de B, e B já depende de A → circular
  await assert.rejects(() => scheduledTasks.saveTask(admin, { ...base(), id: 'ta', name: 'A', robotId: 'rg', dependsOnTaskId: 'tb' }, []), /circular/);
});

test('salvar: tirar o limite de tempo de um agendamento do qual outros dependem é recusado', { skip }, async () => {
  if (skip) return;
  await mkTask('tg', 'Gestta 06:30', 'rg', T);
  await mkTask('tx', 'Excel 06:55', 'rx', { dependsOnTaskId: 'tg' });
  await assert.rejects(
    () => scheduledTasks.saveTask(admin, { ...base(), id: 'tg', name: 'Gestta 06:30', robotId: 'rg', verifyT0Minutes: '', verifyT1Minutes: '', verifyT2Minutes: '' }, []),
    (e: unknown) => e instanceof BadRequestException && /outros dependem dele \(Excel 06:55\)/.test((e as Error).message),
  );
  // trocar T por um teto continua válido (ainda há limite)
  const ok = await scheduledTasks.saveTask(admin, { ...base(), id: 'tg', name: 'Gestta 06:30', robotId: 'rg', verifyT0Minutes: '', verifyT1Minutes: '', verifyT2Minutes: '', maxRuntimeMinutes: '90' }, []);
  assert.equal(ok.maxRuntimeMinutes, 90);
});

test('salvar: teto com T0/T1/T2 preenchidos é descartado (o T2 já é o teto); edição sem os campos preserva dependência e teto', { skip }, async () => {
  if (skip) return;
  await mkTask('tg', 'Gestta', 'rg', T);
  await mkTask('tx', 'Excel', 'rx', { dependsOnTaskId: 'tg', maxRuntimeMinutes: 45 });
  const comT = await scheduledTasks.saveTask(admin, { ...base(), name: 'Com T e teto', robotId: 'rg', verifyT0Minutes: 20, verifyT1Minutes: 15, verifyT2Minutes: 10, maxRuntimeMinutes: 99 }, []);
  assert.equal(comT.maxRuntimeMinutes, null);
  const edit = await scheduledTasks.saveTask(admin, { ...base(), id: 'tx', name: 'Excel', robotId: 'rx' }, []);
  assert.equal(edit.dependsOnTaskId, 'tg');
  assert.equal(edit.maxRuntimeMinutes, 45);
});

test('apagar o agendamento do qual se depende limpa o campo (o banco faz isso sozinho)', { skip }, async () => {
  if (skip) return;
  await mkTask('tg', 'Gestta', 'rg', T);
  await mkTask('tx', 'Excel', 'rx', { dependsOnTaskId: 'tg' });
  await prisma.scheduledTask.delete({ where: { id: 'tg' } });
  assert.equal((await prisma.scheduledTask.findUnique({ where: { id: 'tx' } })).dependsOnTaskId, null);
});
