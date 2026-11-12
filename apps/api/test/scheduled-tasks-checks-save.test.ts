import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { ScheduledTasksService } from '../src/scheduled-tasks/scheduled-tasks.service';

/* eslint-disable @typescript-eslint/no-explicit-any */
const admin: any = { id: 'u1', name: 'Admin', email: 'a@x', role: 'admin', departments: [] };
const manager: any = { id: 'u2', name: 'Gestor', email: 'g@x', role: 'manager', departments: [] };

function tomorrow() {
  const d = new Date(Date.now() + 36 * 3600_000);
  return d.toISOString().slice(0, 10);
}

function montar(existing: Record<string, any> | null) {
  const writes: { create?: any; update?: any } = {};
  const prisma = {
    robot: { findUnique: async () => ({ id: 'r1', name: 'Robô', schema: {}, allowedDepartments: [], isActive: true }) },
    scheduledTask: {
      findUnique: async () => existing,
      findMany: async () => [],
      create: async ({ data }: any) => { writes.create = data; return { id: 'novo', ...data }; },
      update: async ({ data }: any) => { writes.update = data; return { id: existing?.id, ...data }; },
    },
  };
  const svc = new ScheduledTasksService(prisma as any, {} as any);
  const base = { name: 'Gestta', robotId: 'r1', frequency: 'daily', timesOfDay: ['06:30'], startDate: tomorrow() };
  return { svc, writes, base };
}

const existente = (extra: Record<string, any> = {}) => ({
  id: 't1', userId: 'u1', user: { id: 'u1', departments: [] }, timeOfDay: '06:30', timesOfDay: ['06:30'], startDate: new Date(`${tomorrow()}T00:00:00`),
  recipientScope: 'specific', recipientDepartments: [], recipientUserIds: [], creditMode: 'creator', creditUserIds: [], creditDepartment: null,
  verifyT0Minutes: 20, verifyT1Minutes: 15, verifyT2Minutes: 10, ...extra,
});

test('administrador cria com T0/T1/T2: os três são gravados como números', async () => {
  const { svc, writes, base } = montar(null);
  await svc.saveTask(admin, { ...base, verifyT0Minutes: '20', verifyT1Minutes: '15', verifyT2Minutes: '10' }, []);
  assert.equal(writes.create.verifyT0Minutes, 20);
  assert.equal(writes.create.verifyT1Minutes, 15);
  assert.equal(writes.create.verifyT2Minutes, 10);
});

test('administrador cria sem enviar T: nada é gravado (fica "sem verificação")', async () => {
  const { svc, writes, base } = montar(null);
  await svc.saveTask(admin, base, []);
  for (const k of ['verifyT0Minutes', 'verifyT1Minutes', 'verifyT2Minutes']) assert.equal(k in writes.create, false, k);
});

test('edição que NÃO envia os campos (tela antiga em cache) preserva a verificação existente', async () => {
  const { svc, writes, base } = montar(existente());
  await svc.saveTask(admin, { ...base, id: 't1' }, []);
  for (const k of ['verifyT0Minutes', 'verifyT1Minutes', 'verifyT2Minutes']) assert.equal(k in writes.update, false, k);
});

test('administrador que limpa os três campos desliga a verificação (null)', async () => {
  const { svc, writes, base } = montar(existente());
  await svc.saveTask(admin, { ...base, id: 't1', verifyT0Minutes: '', verifyT1Minutes: '', verifyT2Minutes: '' }, []);
  assert.equal(writes.update.verifyT0Minutes, null);
  assert.equal(writes.update.verifyT1Minutes, null);
  assert.equal(writes.update.verifyT2Minutes, null);
});

test('administrador que troca os valores: atualiza', async () => {
  const { svc, writes, base } = montar(existente());
  await svc.saveTask(admin, { ...base, id: 't1', verifyT0Minutes: 30, verifyT1Minutes: 10, verifyT2Minutes: 5 }, []);
  assert.deepEqual([writes.update.verifyT0Minutes, writes.update.verifyT1Minutes, writes.update.verifyT2Minutes], [30, 10, 5]);
});

test('preenchimento incompleto ou inválido é recusado com mensagem clara', async () => {
  const { svc, base } = montar(existente());
  await assert.rejects(
    () => svc.saveTask(admin, { ...base, id: 't1', verifyT0Minutes: '20', verifyT1Minutes: '', verifyT2Minutes: '10' }, []),
    (e: unknown) => e instanceof BadRequestException && /T0, T1 e T2/.test((e as Error).message),
  );
  await assert.rejects(
    () => svc.saveTask(admin, { ...base, id: 't1', verifyT0Minutes: '0', verifyT1Minutes: '15', verifyT2Minutes: '10' }, []),
    BadRequestException,
  );
});

test('quem não é administrador não consegue alterar nem apagar a verificação', async () => {
  const { svc, writes, base } = montar(existente({ userId: 'u2', user: { id: 'u2', departments: [] } }));
  await svc.saveTask(manager, { ...base, id: 't1', verifyT0Minutes: '', verifyT1Minutes: '', verifyT2Minutes: '' }, []);
  for (const k of ['verifyT0Minutes', 'verifyT1Minutes', 'verifyT2Minutes']) assert.equal(k in writes.update, false, k);

  const novo = montar(null);
  await novo.svc.saveTask(manager, { ...novo.base, verifyT0Minutes: '20', verifyT1Minutes: '15', verifyT2Minutes: '10' }, []);
  assert.equal('verifyT0Minutes' in novo.writes.create, false);
});
