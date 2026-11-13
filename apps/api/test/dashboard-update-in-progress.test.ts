import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { UserRole } from '@prisma/client';
import { DashboardController } from '../src/dashboard/dashboard.controller';
import { DashboardService, UpdateInProgressError } from '../src/dashboard/dashboard.service';
import { updateInProgressMessage } from '../src/dashboard/update-policy';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('updateInProgressMessage: diz desde que horas (horário de Brasília) ou fica genérica', () => {
  assert.match(updateInProgressMessage(new Date('2026-11-13T17:32:00Z')), /já está sendo atualizado \(desde 14:32\)/);
  assert.match(updateInProgressMessage(null), /^Este painel já está sendo atualizado\. Aguarde/);
});

test('atualização de verdade: enquanto roda o painel aparece como "atualizando desde...", a segunda é recusada, e no fim libera', async () => {
  let liberar: () => void = () => undefined;
  const portao = new Promise<void>((r) => { liberar = r; });
  const painel = http.createServer((_req, res) => { void portao.then(() => res.end('ok')); });
  await new Promise<void>((r) => painel.listen(0, r));
  const porta = (painel.address() as { port: number }).port;
  const prisma = {
    dashboard: {
      findUniqueOrThrow: async () => ({ id: 'd1', updatePath: '/atualizar', streamlitPort: porta, warmupMode: 'disabled', warmupPaths: [] }),
      update: async () => ({}),
    },
  };
  const svc = new DashboardService(prisma as never);
  try {
    assert.equal(svc.updatingSince('d1'), null);
    const primeira = svc.triggerUpdate('d1');
    for (let i = 0; i < 100 && !svc.updatingSince('d1'); i++) await wait(10);
    const desde = svc.updatingSince('d1');
    assert.ok(desde instanceof Date && Date.now() - desde.getTime() < 5000);
    assert.equal(svc.isUpdating('d1'), true);
    await assert.rejects(() => svc.triggerUpdate('d1'), UpdateInProgressError); // a segunda pessoa
    liberar();
    assert.deepEqual({ ok: (await primeira).ok }, { ok: true });
    assert.equal(svc.updatingSince('d1'), null); // terminou: libera para a próxima
    assert.equal(svc.isUpdating('d1'), false);
  } finally {
    liberar();
    painel.closeAllConnections();
    painel.close();
  }
});

type U = { id: string; role: UserRole; departments: string[] };
const ANA: U = { id: 'ana', role: UserRole.employee, departments: ['comercial'] };
const ZECA: U = { id: 'zeca', role: UserRole.employee, departments: ['fiscal'] };
const ADMIN: U = { id: 'adm', role: UserRole.admin, departments: [] };
const PAINEL = { id: 'd1', slug: 'p', type: 'server', isActive: true, updatePath: '/u', allowedDepartments: ['comercial'], allowedUserIds: [], minRole: UserRole.employee };

function controlador(user: U, over: { updating?: Date | null; triggerError?: Error; painel?: typeof PAINEL | null } = {}) {
  const chamadas = { trigger: 0 };
  const svc = {
    findById: async () => (over.painel === undefined ? PAINEL : over.painel),
    triggerUpdate: async () => { chamadas.trigger++; if (over.triggerError) throw over.triggerError; return { ok: true }; },
    updatingSince: () => over.updating ?? null,
    findAll: async () => [PAINEL],
    findAllActive: async () => [PAINEL],
    isRunning: () => true,
  };
  return { controller: new DashboardController(svc as never, { requireUser: async () => user } as never), chamadas };
}
const req = {} as never;

test('POST /dashboards/:id/update: sem acesso ao painel responde 404 e não atualiza nada', async () => {
  const { controller, chamadas } = controlador(ZECA);
  await assert.rejects(() => controller.triggerUpdate(req, 'd1'), { name: 'NotFoundException' });
  assert.equal(chamadas.trigger, 0);
  const ok = controlador(ANA);
  assert.deepEqual(await ok.controller.triggerUpdate(req, 'd1'), { ok: true });
  const adm = controlador(ADMIN);
  assert.deepEqual(await adm.controller.triggerUpdate(req, 'd1'), { ok: true });
  // painel inativo: só administrador
  const inativo = { ...PAINEL, isActive: false };
  await assert.rejects(() => controlador(ANA, { painel: inativo }).controller.triggerUpdate(req, 'd1'), { name: 'NotFoundException' });
  assert.deepEqual(await controlador(ADMIN, { painel: inativo }).controller.triggerUpdate(req, 'd1'), { ok: true });
});

test('POST /dashboards/:id/update: já atualizando vira 409 com a mensagem e o horário (antes era um erro genérico)', async () => {
  const { controller } = controlador(ANA, { triggerError: new UpdateInProgressError(), updating: new Date('2026-11-13T17:32:00Z') });
  await assert.rejects(
    () => controller.triggerUpdate(req, 'd1'),
    (err: Error & { getStatus?: () => number }) => {
      assert.equal(err.name, 'ConflictException');
      assert.equal(err.getStatus?.(), 409);
      assert.match(err.message, /já está sendo atualizado \(desde 14:32\)/);
      return true;
    },
  );
});

test('GET /dashboards: cada painel traz "updatingSince" (null quando não está atualizando)', async () => {
  const parado = await controlador(ANA).controller.list(req);
  assert.equal((parado as Array<{ updatingSince: unknown }>)[0].updatingSince, null);
  const rodando = await controlador(ANA, { updating: new Date('2026-11-13T17:32:00Z') }).controller.list(req);
  assert.equal((rodando as Array<{ updatingSince: unknown }>)[0].updatingSince, '2026-11-13T17:32:00.000Z');
});
