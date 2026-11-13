import assert from 'node:assert/strict';
import test from 'node:test';
import { SiteCategory, UserRole } from '@prisma/client';
import { RobotsService } from '../src/robots/robots.service';
import { SitesController } from '../src/sites/sites.controller';
import { SitesService } from '../src/sites/sites.service';
import {
  canAccessDashboard,
  canAccessRobot,
  canAccessSite,
  usersMissingDashboardAccess,
} from '../src/shared/access';

type U = { id: string; role: UserRole; departments: string[] };
const u = (id: string, departments: string[] = [], role: UserRole = UserRole.employee): U => ({ id, role, departments });

const COMERCIAL_ANA = u('ana', ['comercial']);
const COMERCIAL_GESTOR = u('gestor', ['comercial'], UserRole.manager);
const FISCAL = u('fiscal1', ['fiscal']);
const RITA = u('rita', ['pessoal']); // de outro departamento, liberada pelo nome
const ADMIN = u('adm', [], UserRole.admin);
const INOVACAO = u('inov', ['inovacao']);

test('o caso do pedido: departamento inteiro + duas pessoas de fora, ao mesmo tempo (painel, BI e robô)', () => {
  const audiencia = { allowedDepartments: ['comercial'], allowedUserIds: ['rita', 'laura'] };
  for (const check of [
    (user: U) => canAccessDashboard(user, { ...audiencia, minRole: UserRole.employee }),
    (user: U) => canAccessSite(user, { ...audiencia, minRole: UserRole.employee }),
    (user: U) => canAccessRobot(user, audiencia),
  ]) {
    assert.equal(check(COMERCIAL_ANA), true); // o departamento inteiro
    assert.equal(check(RITA), true); // pessoa de fora, pelo nome
    assert.equal(check(u('laura', ['rh'])), true);
    assert.equal(check(FISCAL), false); // quem não é de nenhum dos dois
    assert.equal(check(ADMIN), true);
    assert.equal(check(INOVACAO), true);
  }
});

test('só departamentos, só pessoas e nada marcado', () => {
  const soDeptos = { allowedDepartments: ['comercial'], allowedUserIds: [] };
  const soPessoas = { allowedDepartments: [], allowedUserIds: ['rita'] };
  const aberto = { allowedDepartments: [], allowedUserIds: [] };
  assert.equal(canAccessRobot(COMERCIAL_ANA, soDeptos), true);
  assert.equal(canAccessRobot(RITA, soDeptos), false);
  assert.equal(canAccessRobot(RITA, soPessoas), true);
  assert.equal(canAccessRobot(COMERCIAL_ANA, soPessoas), false); // só pessoas: o departamento não entra de carona
  assert.equal(canAccessRobot(FISCAL, aberto), true); // nada marcado: todos
  // tolera quem ainda não traz o campo (consulta antiga): trata como "sem pessoas"
  assert.equal(canAccessRobot(COMERCIAL_ANA, { allowedDepartments: ['comercial'] }), true);
  assert.equal(canAccessRobot(FISCAL, { allowedDepartments: ['comercial'] }), false);
});

test('"só gestores": a pessoa liberada pelo nome passa; funcionário só por departamento não', () => {
  const painel = { allowedDepartments: ['comercial'], allowedUserIds: ['rita'], minRole: UserRole.manager };
  assert.equal(canAccessDashboard(COMERCIAL_GESTOR, painel), true);
  assert.equal(canAccessDashboard(COMERCIAL_ANA, painel), false); // funcionário do departamento, mas o painel é de gestor
  assert.equal(canAccessDashboard(RITA, painel), true); // liberada pelo nome, mesmo sendo funcionária
  assert.equal(canAccessSite(RITA, painel), true);
  assert.equal(canAccessSite(COMERCIAL_ANA, painel), false);
  // só gestores sem restrição de departamento: gestores de qualquer lugar, e funcionários nunca (a menos que listados)
  assert.equal(canAccessSite(u('g2', ['fiscal'], UserRole.manager), { allowedDepartments: [], allowedUserIds: [], minRole: UserRole.manager }), true);
  assert.equal(canAccessSite(FISCAL, { allowedDepartments: [], allowedUserIds: [], minRole: UserRole.manager }), false);
});

test('compatibilidade: painel que já era só de pessoas continua só delas', () => {
  const bi = { allowedDepartments: [], allowedUserIds: ['a', 'b', 'c'], minRole: UserRole.employee };
  assert.equal(canAccessDashboard(u('a', ['comercial']), bi), true);
  assert.equal(canAccessDashboard(u('z', ['comercial', 'sucesso_do_cliente']), bi), false);
  assert.equal(canAccessDashboard(INOVACAO, bi), true);
});

test('usersMissingDashboardAccess: só quem ainda não enxerga o painel', () => {
  const painelDeptos = { allowedDepartments: ['comercial'], allowedUserIds: [], minRole: UserRole.employee };
  assert.deepEqual(usersMissingDashboardAccess([COMERCIAL_ANA, RITA, FISCAL], painelDeptos).map((x) => x.id), ['rita', 'fiscal1']);
  const painelAberto = { allowedDepartments: [], allowedUserIds: [], minRole: UserRole.employee };
  assert.deepEqual(usersMissingDashboardAccess([RITA, FISCAL], painelAberto), []);
  const jaListada = { allowedDepartments: ['comercial'], allowedUserIds: ['rita'], minRole: UserRole.employee };
  assert.deepEqual(usersMissingDashboardAccess([RITA], jaListada), []);
});

// ---- SitesService com um "banco" em memória ----
function fakeSites(dashboard: Record<string, unknown> | null, people: Array<Record<string, unknown>>, existingSite: Record<string, unknown> | null = null) {
  const calls: { siteData?: Record<string, unknown>; dashboardUpdate?: Record<string, unknown> } = {};
  const prisma = {
    site: {
      findFirst: async () => null,
      findUnique: async () => existingSite,
      create: async ({ data }: { data: Record<string, unknown> }) => { calls.siteData = data; return { id: 's1', faviconStoragePath: null, ...data }; },
      update: async ({ data }: { data: Record<string, unknown> }) => { calls.siteData = data; return { id: 's1', faviconStoragePath: null, ...existingSite, ...data }; },
    },
    dashboard: {
      findUnique: async () => dashboard,
      update: async (args: Record<string, unknown>) => { calls.dashboardUpdate = args; return args; },
    },
    user: { findMany: async () => people },
  };
  return { service: new SitesService(prisma as never, {} as never), calls };
}
const PAINEL_COMERCIAL = { id: 'd1', name: 'Painel Comercial', type: 'server', allowedDepartments: ['comercial'], allowedUserIds: [], minRole: UserRole.employee };
const BI = { name: 'BI Comercial', url: 'https://exemplo.test/bi', category: SiteCategory.bi, linkedDashboardId: 'd1', allowedDepartments: ['comercial'] };

test('BI: pessoas liberadas que ainda não veem o painel vinculado entram na lista dele, e a tela é avisada', async () => {
  const { service, calls } = fakeSites(PAINEL_COMERCIAL, [
    { id: 'rita', name: 'Rita', role: 'employee', departments: ['pessoal'] },
    { id: 'ana', name: 'Ana', role: 'employee', departments: ['comercial'] }, // já vê pelo departamento: não precisa entrar
  ]);
  const result = (await service.saveSite({ ...BI, allowedUserIds: ['rita', 'ana'] })) as Record<string, unknown>;
  assert.deepEqual(calls.siteData?.allowedUserIds, ['rita', 'ana']);
  assert.deepEqual((calls.dashboardUpdate as { data: { allowedUserIds: string[] } }).data.allowedUserIds, ['rita']);
  assert.deepEqual(result.linkedDashboardGrant, { dashboardName: 'Painel Comercial', users: [{ id: 'rita', name: 'Rita' }] });
});

test('BI: painel aberto a todos, ou sem ninguém novo, não é alterado', async () => {
  const aberto = fakeSites({ ...PAINEL_COMERCIAL, allowedDepartments: [] }, [{ id: 'rita', name: 'Rita', role: 'employee', departments: ['pessoal'] }]);
  const r1 = (await aberto.service.saveSite({ ...BI, allowedUserIds: ['rita'] })) as Record<string, unknown>;
  assert.equal(aberto.calls.dashboardUpdate, undefined);
  assert.equal('linkedDashboardGrant' in r1, false);

  const jaListada = fakeSites({ ...PAINEL_COMERCIAL, allowedUserIds: ['rita'] }, [{ id: 'rita', name: 'Rita', role: 'employee', departments: ['pessoal'] }]);
  await jaListada.service.saveSite({ ...BI, allowedUserIds: ['rita'] });
  assert.equal(jaListada.calls.dashboardUpdate, undefined);

  const semPessoas = fakeSites(PAINEL_COMERCIAL, []);
  await semPessoas.service.saveSite({ ...BI, allowedUserIds: [] });
  assert.equal(semPessoas.calls.dashboardUpdate, undefined);
});

test('BI: lista de pessoas do painel é somada (nunca substituída) e id que não é de um usuário não entra', async () => {
  const { service, calls } = fakeSites({ ...PAINEL_COMERCIAL, allowedUserIds: ['carlos'] }, [{ id: 'rita', name: 'Rita', role: 'employee', departments: ['pessoal'] }]);
  await service.saveSite({ ...BI, allowedUserIds: ['rita', 'fantasma'] });
  assert.deepEqual((calls.dashboardUpdate as { data: { allowedUserIds: string[] } }).data.allowedUserIds, ['carlos', 'rita']);
});

test('salvar um site sem enviar allowedUserIds (tela antiga em cache) preserva a lista existente', async () => {
  const { service, calls } = fakeSites(null, [], { id: 's1', maintenanceOverride: false });
  await service.saveSite({ id: 's1', name: 'BI Comercial', url: 'https://exemplo.test/bi', category: SiteCategory.sistema });
  assert.equal('allowedUserIds' in (calls.siteData ?? {}), false);
});

test('a lista de pessoas só sai para administradores (site)', () => {
  const { service } = fakeSites(null, []);
  const site = { id: 's1', faviconStoragePath: null, allowedUserIds: ['rita'] };
  assert.deepEqual(service.forViewer(site, ADMIN).allowedUserIds, ['rita']);
  assert.deepEqual(service.forViewer(site, INOVACAO).allowedUserIds, ['rita']); // Inovação é admin no Hub
  assert.deepEqual(service.forViewer(site, RITA).allowedUserIds, []);
});

test('robô: salvar sem enviar allowedUserIds preserva a lista; enviando, grava normalizada', async () => {
  const gravados: Array<Record<string, unknown>> = [];
  const prisma = {
    robot: {
      findFirst: async () => null,
      findUnique: async () => ({ id: 'r1' }),
      update: async ({ data }: { data: Record<string, unknown> }) => { gravados.push(data); return { id: 'r1', apiKeyHash: null, ...data }; },
      create: async ({ data }: { data: Record<string, unknown> }) => { gravados.push(data); return { id: 'r2', apiKeyHash: null, ...data }; },
    },
  };
  const service = new RobotsService(prisma as never);
  await service.saveRobot({ id: 'r1', name: 'Robô', slug: 'robo' });
  assert.equal('allowedUserIds' in gravados[0], false);
  await service.saveRobot({ id: 'r1', name: 'Robô', slug: 'robo', allowedUserIds: ['rita', 'rita', '', 'laura'] });
  assert.deepEqual(gravados[1].allowedUserIds, ['rita', 'laura']);
  await service.saveRobot({ id: 'r1', name: 'Robô', slug: 'robo', allowedUserIds: [] });
  assert.deepEqual(gravados[2].allowedUserIds, []); // enviar vazio limpa de propósito
});

test('GET /sites/:id agora confere o acesso (antes qualquer usuário logado lia qualquer site, inclusive BIs restritos)', async () => {
  const site = { id: 's1', name: 'BI Comercial', url: 'https://exemplo.test/bi', faviconStoragePath: null, allowedDepartments: ['comercial'], allowedUserIds: ['rita'], minRole: UserRole.employee };
  const sitesService = new SitesService({ site: { findUnique: async () => site } } as never, {} as never);
  const auth = (user: U) => ({ requireUser: async () => user });
  const controller = (user: U) => new SitesController(sitesService, auth(user) as never, {} as never);
  const req = {} as never;
  assert.equal(((await controller(COMERCIAL_ANA).findOne('s1', req)) as { name: string }).name, 'BI Comercial');
  assert.equal(((await controller(RITA).findOne('s1', req)) as { name: string }).name, 'BI Comercial'); // liberada pelo nome
  assert.deepEqual(((await controller(COMERCIAL_ANA).findOne('s1', req)) as { allowedUserIds: string[] }).allowedUserIds, []); // não admin: sem a lista
  await assert.rejects(() => controller(FISCAL).findOne('s1', req), { name: 'NotFoundException' });
});
