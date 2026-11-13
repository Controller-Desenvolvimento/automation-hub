import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { UserRole } from '@prisma/client';
import { canAccessDashboard } from '../src/shared/access';

const user = (over: Partial<{ id: string; role: UserRole; departments: string[] }> = {}) => ({
  id: 'u1',
  role: UserRole.employee,
  departments: ['comercial'],
  ...over,
});
const painel = (over: Partial<{ allowedDepartments: string[]; allowedUserIds: string[]; minRole: UserRole }> = {}) => ({
  allowedDepartments: [] as string[],
  allowedUserIds: [] as string[],
  minRole: UserRole.employee,
  ...over,
});

test('painel restrito a pessoas (sem departamentos): só quem está na lista abre, admin e Inovação também', () => {
  const p = painel({ allowedUserIds: ['ana', 'bia'] });
  assert.equal(canAccessDashboard(user({ id: 'ana' }), p), true);
  assert.equal(canAccessDashboard(user({ id: 'zeca' }), p), false); // o caso do BI Financeiro: antes entrava pelo endereço direto
  assert.equal(canAccessDashboard(user({ id: 'zeca', departments: ['comercial', 'sucesso_do_cliente'] }), p), false);
  assert.equal(canAccessDashboard(user({ id: 'zeca', role: UserRole.admin }), p), true);
  assert.equal(canAccessDashboard(user({ id: 'zeca', departments: ['inovacao'] }), p), true);
});

test('painel por departamento e "só gestor"', () => {
  const p = painel({ allowedDepartments: ['fiscal'], minRole: UserRole.manager });
  assert.equal(canAccessDashboard(user({ departments: ['fiscal'], role: UserRole.manager }), p), true);
  assert.equal(canAccessDashboard(user({ departments: ['fiscal'] }), p), false); // funcionário do departamento, mas o painel é de gestor
  assert.equal(canAccessDashboard(user({ departments: ['contabil'], role: UserRole.manager }), p), false);
  assert.equal(canAccessDashboard(user(), painel()), true); // sem restrição: todos
});

test('trava: o acesso direto /d/<painel> usa canAccessDashboard, não uma checagem própria só de departamentos', () => {
  const fonte = readFileSync(join(__dirname, '..', 'src', 'main.ts'), 'utf8');
  assert.match(fonte, /canAccessDashboard\(session\.user, dashboard\)/);
  assert.ok(!/dashboard\.allowedDepartments\.length > 0/.test(fonte), 'o guarda antigo (só departamentos) não pode voltar');
});
