import assert from 'node:assert/strict';
import test from 'node:test';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ScheduledTasksService } from '../src/scheduled-tasks/scheduled-tasks.service';

/* eslint-disable @typescript-eslint/no-explicit-any */
const admin: any = { id: 'u-admin', name: 'Admin', email: 'a@x', role: 'admin', departments: [] };
const owner: any = { id: 'u-dono', name: 'Dono', email: 'd@x', role: 'employee', departments: ['fiscal'] };
const other: any = { id: 'u-outro', name: 'Outro', email: 'o@x', role: 'employee', departments: ['fiscal'] };

const robot = { id: 'r1', name: 'Gestta', allowedDepartments: [], allowedUserIds: [], isActive: true };

function montar(opts: { task?: any; lastStatus?: string; lastExecution?: any } = {}) {
  const created: any[] = [];
  const logs: any[] = [];
  const updates: any[] = [];
  const task =
    opts.task === undefined
      ? {
          id: 't1', name: 'Gestta 06:30', userId: owner.id, robotId: 'r1', robot, user: { departments: ['fiscal'] },
          notes: 'obs', parameters: { mes: '10' }, lastExecutionId: opts.lastStatus ? 'e-ultima' : null,
        }
      : opts.task;
  const prisma = {
    scheduledTask: {
      findUnique: async () => task,
      findMany: async () => (task ? [{ ...task, user: { id: task.userId, name: 'x', email: 'x', departments: [] } }] : []),
      update: async (args: any) => { updates.push(args); return {}; },
    },
    execution: {
      findUnique: async () => (opts.lastStatus ? { status: opts.lastStatus } : null),
      findMany: async () => (opts.lastExecution ? [opts.lastExecution] : []),
    },
  };
  const executions = {
    createExecution: async (robotId: string, payload: any, files: any[]) => {
      created.push({ robotId, payload, files });
      return { id: 'nova-exec' };
    },
    log: async (id: string, level: string, message: string) => { logs.push({ id, level, message }); },
  };
  return { svc: new ScheduledTasksService(prisma as any, executions as any), created, logs, updates };
}

test('rodar agora: cria uma execução AGENDADA (com scheduledTaskId) igual à do horário: dono, parâmetros, observação', async () => {
  const { svc, created } = montar();
  const r = await svc.runNow(owner, 't1');
  assert.deepEqual(r, { executionId: 'nova-exec' });
  assert.equal(created.length, 1);
  assert.equal(created[0].robotId, 'r1');
  assert.equal(created[0].payload.userId, owner.id);
  assert.deepEqual(created[0].payload.parameters, { mes: '10' });
  assert.equal(created[0].payload.notes, 'obs');
  assert.equal(created[0].payload.scheduledTaskId, 't1');            // conta como execução do agendamento (e-mail de alerta, T0/T1/T2, crédito, ciclo)
  assert.equal(created[0].payload.waitingOnExecutionId, undefined);  // não fica retida esperando o agendamento de que depende
});

test('rodar agora: administrador roda o agendamento de outra pessoa; a execução fica no nome do dono e o log diz quem clicou', async () => {
  const { svc, created, logs } = montar();
  await svc.runNow(admin, 't1');
  assert.equal(created[0].payload.userId, owner.id);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].id, 'nova-exec');
  assert.match(logs[0].message, /Rodar agora.*Admin/);
});

test('rodar agora: o resumo passa a mostrar a execução, sem mexer no próximo horário nem em "ativo"', async () => {
  const { svc, updates } = montar();
  await svc.runNow(owner, 't1');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].where.id, 't1');
  assert.equal(updates[0].data.lastExecutionId, 'nova-exec');
  assert.ok(updates[0].data.lastRunAt instanceof Date);
  assert.equal(updates[0].data.lastError, null);
  assert.equal('nextRunAt' in updates[0].data, false);
  assert.equal('isActive' in updates[0].data, false);
});

test('rodar agora: quem não é dono nem administrador leva 403; agendamento inexistente leva 404', async () => {
  const { svc, created } = montar();
  await assert.rejects(() => svc.runNow(other, 't1'), ForbiddenException);
  assert.equal(created.length, 0);

  const sem = montar({ task: null });
  await assert.rejects(() => sem.svc.runNow(admin, 'nao-existe'), NotFoundException);
});

test('rodar agora: recusa (409) se a última execução ainda está na fila ou rodando; libera se terminou', async () => {
  for (const status of ['queued', 'running']) {
    const { svc, created } = montar({ lastStatus: status });
    await assert.rejects(() => svc.runNow(owner, 't1'), ConflictException);
    assert.equal(created.length, 0);
  }
  for (const status of ['success', 'error', 'canceled']) {
    const { svc, created } = montar({ lastStatus: status });
    await svc.runNow(owner, 't1');
    assert.equal(created.length, 1);
  }
});

test('lista: traz o resumo da última execução (erro, duração, tentativa) e mantém lastExecutionStatus', async () => {
  const last = {
    id: 'e-ultima', status: 'error', errorMessage: 'Senha digitada errada', progress: 40, attempt: 2,
    createdAt: new Date('2026-11-24T06:30:00Z'), startedAt: new Date('2026-11-24T06:31:00Z'), finishedAt: new Date('2026-11-24T06:40:00Z'),
  };
  const { svc } = montar({ lastStatus: 'error', lastExecution: last });
  const [item] = (await svc.listTasks(owner)) as any[];
  assert.equal(item.lastExecutionStatus, 'error');
  assert.equal(item.lastExecution.errorMessage, 'Senha digitada errada');
  assert.equal(item.lastExecution.attempt, 2);

  const nunca = montar();
  const [semExec] = (await nunca.svc.listTasks(owner)) as any[];
  assert.equal(semExec.lastExecution, null);
  assert.equal(semExec.lastExecutionStatus, null);
});
