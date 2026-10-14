import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ExecutionIdentitiesService,
  normalizeExternalLogin,
} from '../src/execution-identities/execution-identities.service';

test('normaliza login externo ignorando caixa e espaços', () => {
  assert.equal(normalizeExternalLogin(' Taina.Decon '), 'taina.decon');
});

test('resolve primeiro pelo athenasLogin normalizado', async () => {
  let athenasQuery: Record<string, unknown> | undefined;
  const user = {
    id: 'user-1',
    name: 'Taina',
    email: 'taina.decon@athenas.local',
    athenasLogin: 'TAINA.DECON',
  };
  const prisma = {
    user: {
      findFirst: async (query: Record<string, unknown>) => {
        athenasQuery = query;
        return user;
      },
    },
    execution: { findMany: async () => [] },
  };

  const service = new ExecutionIdentitiesService(prisma as never);
  const result = await service.findUserByLogin(' Taina.Decon ');

  assert.equal(result?.user.id, user.id);
  assert.equal(result?.method, 'ATHENAS_LOGIN');
  assert.deepEqual(athenasQuery, {
    where: {
      athenasLogin: {
        equals: 'taina.decon',
        mode: 'insensitive',
      },
    },
  });
});

test('agrupa identidades não vinculadas pelo login, preservando o nome recebido', async () => {
  const prisma = {
    externalIdentity: { findMany: async () => [] },   // identidades marcadas como ignoradas
    execution: {
      findMany: async () => [
        {
          requestedByName: 'Tainá de Sousa',
          requestedByEmail: ' Taina.Decon ',
          manualEstimatedSeconds: 120,
          createdAt: new Date('2026-07-20T12:00:00.000Z'),
          finishedAt: null,
        },
        {
          requestedByName: 'taina.decon',
          requestedByEmail: 'TAINA.DECON',
          manualEstimatedSeconds: 180,
          createdAt: new Date('2026-07-21T12:00:00.000Z'),
          finishedAt: new Date('2026-07-21T12:05:00.000Z'),
        },
      ],
    },
  };

  const service = new ExecutionIdentitiesService(prisma as never);
  const result = await service.listUnlinkedIdentities();

  assert.equal(result.length, 1);
  assert.deepEqual(result[0], {
    login: 'taina.decon',
    receivedName: 'Tainá de Sousa',
    executions: 2,
    savedSeconds: 300,
    firstSeenAt: new Date('2026-07-20T12:00:00.000Z'),
    lastSeenAt: new Date('2026-07-21T12:05:00.000Z'),
  });
});

test('vínculo administrativo atualiza somente execuções externas sem userId', async () => {
  let updateQuery: Record<string, unknown> | undefined;
  const prisma = {
    user: {
      findUnique: async () => ({ id: 'user-1', name: 'Tainá de Sousa' }),
      findFirst: async () => null,
    },
    execution: {
      findMany: async () => [],
      updateMany: async (query: Record<string, unknown>) => {
        updateQuery = query;
        return { count: 3 };
      },
    },
  };

  const service = new ExecutionIdentitiesService(prisma as never);
  const result = await service.linkIdentity(' Taina.Decon ', 'user-1');

  assert.equal(result.linkedExecutions, 3);
  assert.deepEqual(updateQuery, {
    where: {
      userId: null,
      robot: { isExternal: true },
      OR: [
        {
          requestedByName: {
            equals: 'taina.decon',
            mode: 'insensitive',
          },
        },
        {
          requestedByEmail: {
            equals: 'taina.decon',
            mode: 'insensitive',
          },
        },
      ],
    },
    data: { userId: 'user-1' },
  });
});
