import assert from 'node:assert/strict';
import test from 'node:test';
import { ScheduleChecksService } from '../src/scheduled-tasks/schedule-checks.service';

/* eslint-disable @typescript-eslint/no-explicit-any */
const start = new Date('2026-11-12T06:30:00');
const at = (min: number) => new Date(start.getTime() + min * 60_000);
const CFG = { verifyT0Minutes: 20, verifyT1Minutes: 15, verifyT2Minutes: 10 }; // T0=20, T1=35, T2=45
const SEM_VERIFICACAO = { verifyT0Minutes: null, verifyT1Minutes: null, verifyT2Minutes: null };

interface Setup {
  attempt?: number;
  checkStage?: number;
  task?: Record<string, any>;
  cancelOk?: boolean;
  restartResult?: 'ok' | 'null' | 'throws';
  interrupted?: Array<{ id: string; scheduledTaskId: string }>;
}

function montar(opts: Setup = {}) {
  const calls = { advance: [] as Array<[string, number]>, cancel: [] as Array<[string, string]>, stop: [] as string[], restart: [] as Array<[string, string]>, logs: [] as Array<[string, string, string]> };
  const slow: any[] = [];
  const restartFailed: any[] = [];
  const simple: any[] = [];
  const running = [{ id: 'e1', scheduledTaskId: 't1', startedAt: start, attempt: opts.attempt ?? 1, checkStage: opts.checkStage ?? 0, robot: { name: 'Robô X' } }];
  const task = { id: 't1', name: 'Agendamento X', isActive: true, ...(opts.task ?? CFG) };

  const executionsService = {
    listRunningScheduledExecutions: async () => running,
    advanceCheckStage: async (id: string, stage: number) => {
      const row = running.find((r) => r.id === id)!;
      calls.advance.push([id, stage]);
      if (row.checkStage >= stage) return false;
      row.checkStage = stage;
      return true;
    },
    cancelBySystem: async (id: string, reason: string) => { calls.cancel.push([id, reason]); return opts.cancelOk ?? true; },
    log: async (id: string, level: string, msg: string) => { calls.logs.push([id, level, msg]); },
    getScheduledExecutionForAlert: async () => ({
      robotName: 'Robô X', scheduleName: 'Agendamento X', scheduledTaskId: 't1', attempt: opts.attempt ?? 1, cycleFirstId: 'e1', restartExpected: true,
      startedAt: start, finishedAt: at(45), errorMessage: 'Cancelada automaticamente: ...',
      first: (opts.attempt ?? 1) >= 2 ? { executionId: 'e0', startedAt: at(-60), finishedAt: at(-15), outcome: 'primeira tentativa travou' } : null,
    }),
    listInterruptedToRestart: async () => opts.interrupted ?? [],
    listHeldExecutions: async () => [],
    collectSkippedDependents: async () => [] as string[],
  };
  const prisma = {
    scheduledTask: { findMany: async () => [task] },
    execution: { findUnique: async () => ({ robot: { name: 'Robô X' } }) },
  };
  const runner = { stopExecution: async (id: string) => { calls.stop.push(id); } };
  const scheduledTasks = {
    restartScheduledRun: async (taskId: string, failedId: string) => {
      calls.restart.push([taskId, failedId]);
      if (opts.restartResult === 'throws') throw new Error('sem espaço em disco');
      return opts.restartResult === 'null' ? null : { id: 'e2' };
    },
  };
  const mail = {
    sendScheduleSlowAlert: async (i: unknown) => { slow.push(i); },
    sendRestartFailedAlert: async (i: unknown) => { restartFailed.push(i); },
    sendScheduledExecutionAlert: async (i: unknown) => { simple.push(i); },
  };
  const svc = new ScheduleChecksService(prisma as any, executionsService as any, runner as any, scheduledTasks as any, mail as any);
  const tick = async (min: number) => { await svc.tick(at(min)); await new Promise((r) => setTimeout(r, 15)); };
  return { svc, tick, calls, slow, restartFailed, simple };
}

test('antes de T0 não acontece nada', async () => {
  const t = montar();
  await t.tick(19);
  assert.equal(t.slow.length + t.calls.cancel.length + t.calls.restart.length, 0);
});

test('T0 manda o 1º aviso uma única vez, mesmo com várias verificações seguidas', async () => {
  const t = montar();
  await t.tick(20); await t.tick(21); await t.tick(22);
  assert.equal(t.slow.length, 1);
  assert.equal(t.slow[0].stage, 1);
  assert.equal(t.slow[0].executionId, 'e1');
  assert.equal(t.slow[0].scheduleName, 'Agendamento X');
  assert.equal(t.slow[0].robotName, 'Robô X');
  assert.deepEqual(t.slow[0].t2At, at(45));
});

test('T0 e depois T1: dois avisos, nessa ordem, sem repetir', async () => {
  const t = montar();
  await t.tick(20); await t.tick(34); await t.tick(35); await t.tick(36);
  assert.deepEqual(t.slow.map((s) => s.stage), [1, 2]);
});

test('T2 na 1ª tentativa: cancela, mata o processo e REINICIA — sem e-mail nesse momento', async () => {
  const t = montar({ checkStage: 2 });
  await t.tick(45);
  assert.equal(t.calls.cancel.length, 1);
  assert.match(t.calls.cancel[0][1], /Cancelada automaticamente.*T2 = 45 min/);
  assert.deepEqual(t.calls.stop, ['e1']);
  assert.deepEqual(t.calls.restart, [['t1', 'e1']]);
  assert.equal(t.slow.length + t.restartFailed.length + t.simple.length, 0);
  assert.ok(t.calls.logs.some(([id, , m]) => id === 'e1' && /Reiniciada automaticamente.*e2/.test(m)));
  assert.ok(t.calls.logs.some(([id, , m]) => id === 'e2' && /Reinício automático.*e1/.test(m)));
});

test('2ª tentativa: sem avisos intermediários; em T2 cancela de vez e manda UM e-mail final com as duas tentativas', async () => {
  const t = montar({ attempt: 2 });
  await t.tick(20); await t.tick(35);
  assert.equal(t.slow.length, 0, 'o reinício não manda avisos de T0/T1');
  await t.tick(45);
  assert.deepEqual(t.calls.stop, ['e1']);
  assert.equal(t.calls.restart.length, 0, 'não reinicia de novo');
  assert.equal(t.restartFailed.length, 1);
  assert.equal(t.restartFailed[0].first.executionId, 'e0');
  assert.equal(t.restartFailed[0].second.executionId, 'e1');
  assert.equal(t.restartFailed[0].scheduleName, 'Agendamento X');
});

test('agendamento "sem verificação" (T em branco) nunca avisa, cancela nem reinicia', async () => {
  const t = montar({ task: SEM_VERIFICACAO });
  await t.tick(20); await t.tick(60); await t.tick(500);
  assert.equal(t.slow.length + t.calls.cancel.length + t.calls.restart.length + t.restartFailed.length, 0);
});

test('execução que terminou no meio-tempo (cancelamento recusado): não mata, não reinicia, não manda e-mail', async () => {
  const t = montar({ cancelOk: false, checkStage: 2 });
  await t.tick(50);
  assert.equal(t.calls.cancel.length, 1);
  assert.equal(t.calls.stop.length + t.calls.restart.length + t.restartFailed.length + t.simple.length, 0);
});

test('falha ao criar o reinício: avisa por e-mail comum com o motivo (senão ninguém saberia)', async () => {
  const t = montar({ checkStage: 2, restartResult: 'throws' });
  await t.tick(45);
  assert.equal(t.simple.length, 1);
  assert.equal(t.simple[0].kind, 'error');
  assert.match(t.simple[0].errorMessage, /Não foi possível reiniciar automaticamente: Error: sem espaço em disco/);
});

test('agendamento desativado/removido: cancela, mas não reinicia e não manda e-mail', async () => {
  const t = montar({ checkStage: 2, restartResult: 'null' });
  await t.tick(45);
  assert.deepEqual(t.calls.stop, ['e1']);
  assert.equal(t.simple.length + t.restartFailed.length, 0);
  assert.ok(t.calls.logs.some(([, , m]) => /Não foi reiniciada/.test(m)));
});

test('interrompida pelo reinício do Hub: com verificação, é refeita uma vez; sem verificação, não', async () => {
  const com = montar({ interrupted: [{ id: 'ex-int', scheduledTaskId: 't1' }] });
  await com.tick(0);
  assert.deepEqual(com.calls.restart, [['t1', 'ex-int']]);

  const sem = montar({ task: SEM_VERIFICACAO, interrupted: [{ id: 'ex-int', scheduledTaskId: 't1' }] });
  await sem.tick(0);
  assert.equal(sem.calls.restart.length, 0);
});
