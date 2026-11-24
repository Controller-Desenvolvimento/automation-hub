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
  };
  return { svc: new ScheduledTasksService(prisma as any, executions as any), created };
}

test('rodar agora: dono cria uma execução MANUAL (sem scheduledTaskId) com os dados do agendamento', async () => {
  const { svc, created } = montar();
  const r = await svc.runNow(owner, 't1');
  assert.deepEqual(r, { executionId: 'nova-exec' });
  assert.equal(created.length, 1);
  assert.equal(created[0].robotId, 'r1');
  assert.equal(created[0].payload.userId, owner.id);              // aparece nas execuções de quem clicou
  assert.deepEqual(created[0].payload.parameters, { mes: '10' });
  assert.equal(created[0].payload.notes, 'obs');
  assert.equal(created[0].payload.scheduledTaskId, undefined);    // sem e-mail de alerta, sem T0/T1/T2, fora do ciclo de dependência
});

test('rodar agora: administrador roda o agendamento de outra pessoa, e ele fica no nome do administrador', async () => {
  const { svc, created } = montar();
  await svc.runNow(admin, 't1');
  assert.equal(created[0].payload.userId, admin.id);
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
