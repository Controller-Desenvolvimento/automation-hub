import assert from 'node:assert/strict';
import test from 'node:test';
import { UserRole } from '@prisma/client';
import { RobotsService } from '../src/robots/robots.service';

const user = {
  id: 'user-1',
  role: UserRole.employee,
  departments: ['fiscal'],
};

test('favorita um robô acessível de forma idempotente', async () => {
  let upsertInput: Record<string, unknown> | undefined;
  const prisma = {
    robot: {
      findUnique: async () => ({
        id: 'robot-1',
        allowedDepartments: ['fiscal'],
      }),
    },
    robotFavorite: {
      upsert: async (input: Record<string, unknown>) => {
        upsertInput = input;
        return input;
      },
    },
  };
  const service = new RobotsService(prisma as never);

  const result = await service.favoriteRobot('robot-1', user as never);

  assert.deepEqual(result, { robotId: 'robot-1', isFavorite: true });
  assert.deepEqual(upsertInput, {
    where: {
      userId_robotId: {
        userId: 'user-1',
        robotId: 'robot-1',
      },
    },
    create: {
      userId: 'user-1',
      robotId: 'robot-1',
    },
    update: {},
  });
});

test('desfavoritar é seguro mesmo quando o vínculo já não existe', async () => {
  let deleteInput: Record<string, unknown> | undefined;
  const prisma = {
    robot: {
      findUnique: async () => ({
        id: 'robot-1',
        allowedDepartments: [],
      }),
    },
    robotFavorite: {
      deleteMany: async (input: Record<string, unknown>) => {
        deleteInput = input;
        return { count: 0 };
      },
    },
  };
  const service = new RobotsService(prisma as never);

  const result = await service.unfavoriteRobot('robot-1', user as never);

  assert.deepEqual(result, { robotId: 'robot-1', isFavorite: false });
  assert.deepEqual(deleteInput, {
    where: {
      userId: 'user-1',
      robotId: 'robot-1',
    },
  });
});

test('não permite favoritar robô fora dos departamentos do usuário', async () => {
  const prisma = {
    robot: {
      findUnique: async () => ({
        id: 'robot-1',
        allowedDepartments: ['contabil'],
      }),
    },
    robotFavorite: {
      upsert: async () => {
        throw new Error('não deveria ser chamado');
      },
    },
  };
  const service = new RobotsService(prisma as never);

  await assert.rejects(
    () => service.favoriteRobot('robot-1', user as never),
    /Automação não encontrada/,
  );
});
