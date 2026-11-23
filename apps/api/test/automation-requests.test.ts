import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AutomationRequestsService } from '../src/automation-requests/automation-requests.service';

type Row = { id: string; status: string; statusNote: string | null; title: string; requesterUserId: string; requesterName: string };

function setup(initial: Partial<Row> = {}) {
  const row: Row = { id: 'r1', status: 'pending', statusNote: null, title: 'Pedido', requesterUserId: 'u2', requesterName: 'Ana', ...initial };
  const notified: unknown[] = [];
  const calls = { deleted: 0 };
  const prisma = {
    automationRequest: {
      findUnique: async () => row,
      update: async ({ data }: { data: Partial<Row> }) => Object.assign(row, data),
      delete: async () => {
        calls.deleted++;
      },
      count: async () => 7,
    },
  };
  const notifications = { createForAutomationRequestStatusChange: async (p: unknown) => void notified.push(p) };
  const service = new AutomationRequestsService(prisma as never, notifications as never);
  return { service, row, notified, calls };
}

const admin = { id: 'a', role: 'admin', departments: [] } as never;
const employee = { id: 'e', role: 'employee', departments: ['fiscal'] } as never;

test('recusar sem motivo é recusado; com motivo grava e avisa quem pediu com o motivo', async () => {
  const { service, row, notified } = setup();
  await assert.rejects(() => service.update('r1', admin, { status: 'rejected' }), BadRequestException);
  await assert.rejects(() => service.update('r1', admin, { status: 'rejected', statusNote: '   ' }), BadRequestException);
  assert.equal(row.status, 'pending');

  await service.update('r1', admin, { status: 'rejected', statusNote: 'Já existe um robô para isso.' });
  assert.equal(row.status, 'rejected');
  assert.equal(row.statusNote, 'Já existe um robô para isso.');
  assert.equal((notified[0] as { note: string }).note, 'Já existe um robô para isso.');
});

test('mudar de situação sem mensagem apaga a mensagem antiga; sem mudança não mexe nela', async () => {
  const { service, row } = setup({ status: 'rejected', statusNote: 'motivo antigo' });
  await service.update('r1', admin, { adminNotes: 'interno' });
  assert.equal(row.statusNote, 'motivo antigo');
  await service.update('r1', admin, { status: 'review' });
  assert.equal(row.statusNote, null);
});

test('só administrador exclui e vê o número do selo', async () => {
  const { service, calls } = setup();
  await assert.rejects(() => service.remove('r1', employee), ForbiddenException);
  assert.equal(calls.deleted, 0);
  await service.remove('r1', admin);
  assert.equal(calls.deleted, 1);
  assert.deepEqual(await service.summary(employee), { pending: 0 });
  assert.deepEqual(await service.summary(admin), { pending: 7 });
});
