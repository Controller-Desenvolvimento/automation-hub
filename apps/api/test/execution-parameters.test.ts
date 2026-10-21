import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canSeeSecretParameters,
  parametersForViewer,
  secretParameterNames,
  withoutParameters,
} from '../src/shared/execution-parameters';
import { ExecutionsService } from '../src/executions/executions.service';

const DONO = { id: 'u-dono', name: 'Jefferson', email: 'j@x.com', role: 'employee', departments: ['contabil'] };
const GESTOR = { id: 'u-gestor', name: 'Gestora', email: 'g@x.com', role: 'manager', departments: ['contabil'] };
const COLEGA = { id: 'u-colega', name: 'Colega', email: 'c@x.com', role: 'employee', departments: ['contabil'] };
const ADMIN = { id: 'u-admin', name: 'Davi', email: 'd@x.com', role: 'admin', departments: ['tecnologia'] };
const INOVACAO = { id: 'u-inov', name: 'Inov', email: 'i@x.com', role: 'employee', departments: ['inovacao'] };

const SCHEMA = {
  fields: [
    { name: 'cgf', type: 'text' },
    { name: 'cpf', type: 'text' },
    { name: 'senha', type: 'password' },
    { name: 'tipo', type: 'select' },
  ],
};
const PARAMS = { cgf: '64794830', cpf: '42988888353', senha: 'Segredo123*', tipo: 'nfce' };
const exec = { userId: DONO.id, inputJson: PARAMS, robot: { schema: SCHEMA } };

test('secretParameterNames: campos "password" do formulário e nomes que lembram segredo', () => {
  assert.deepEqual(secretParameterNames(SCHEMA, PARAMS), ['senha']);
  // o robô NFS-e tem "senha_certificado"; um campo declarado "password" com nome qualquer também vale
  assert.deepEqual(
    secretParameterNames({ fields: [{ name: 'chave_acesso', type: 'password' }] }, { chave_acesso: 'x', empresas: 'y', senha_certificado: 'z', api_token: 't', cpf: '1' }).sort(),
    ['api_token', 'chave_acesso', 'senha_certificado'],
  );
  assert.deepEqual(secretParameterNames(undefined, { cgf: '1' }), []);
  assert.deepEqual(secretParameterNames({ fields: 'quebrado' }, { senha: 'x' }), ['senha']);
});

test('quem executou, admin e Inovação veem tudo; os demais não veem as senhas', () => {
  for (const quem of [DONO, ADMIN, INOVACAO]) {
    assert.equal(canSeeSecretParameters(quem as never, exec), true);
    assert.deepEqual(parametersForViewer(exec, quem as never), { inputJson: PARAMS, hiddenParameters: [] });
  }
  for (const quem of [GESTOR, COLEGA]) {
    assert.equal(canSeeSecretParameters(quem as never, exec), false);
    assert.deepEqual(parametersForViewer(exec, quem as never), {
      inputJson: { cgf: '64794830', cpf: '42988888353', tipo: 'nfce' },
      hiddenParameters: ['senha'],
    });
  }
  // execução sem dono (externa/agendada antiga): só admin vê
  assert.equal(canSeeSecretParameters(DONO as never, { userId: null }), false);
});

test('inputJson que não é objeto vira vazio, sem quebrar', () => {
  for (const estranho of [null, undefined, 'texto', 42, ['a']]) {
    assert.deepEqual(parametersForViewer({ userId: DONO.id, inputJson: estranho }, DONO as never), { inputJson: {}, hiddenParameters: [] });
  }
});

test('withoutParameters tira só o inputJson', () => {
  assert.deepEqual(withoutParameters({ id: '1', status: 'error', inputJson: PARAMS }), { id: '1', status: 'error' });
});

function servicoCom(rows: Record<string, unknown>[]) {
  const prisma = {
    execution: {
      findUnique: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
      findMany: async () => rows,
      updateMany: async () => ({ count: 1 }),
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id)!,
    },
    scheduledTask: { findMany: async () => [] },
  };
  return new ExecutionsService(prisma as never);
}

const LINHA = {
  id: 'e1', userId: DONO.id, status: 'error', scheduledTaskId: null, robotId: 'r1', inputJson: PARAMS,
  robot: { id: 'r1', name: 'Consulta CF-e', schema: SCHEMA, allowedDepartments: [] },
  user: { id: DONO.id, departments: ['contabil'] }, files: [], logs: [],
};

test('detalhe da execução: dono vê a senha, gestor do mesmo departamento vê sem ela, uso interno não muda nada', async () => {
  const svc = servicoCom([LINHA]);
  const doDono = await svc.getExecution('e1', DONO as never);
  assert.deepEqual(doDono.inputJson, PARAMS);
  assert.deepEqual(doDono.hiddenParameters, []);

  const doGestor = await svc.getExecution('e1', GESTOR as never);
  assert.deepEqual(doGestor.inputJson, { cgf: '64794830', cpf: '42988888353', tipo: 'nfce' });
  assert.deepEqual(doGestor.hiddenParameters, ['senha']);
  assert.ok(!JSON.stringify(doGestor).includes('Segredo123'));          // a senha não aparece em lugar nenhum da resposta

  const interno = await svc.getExecution('e1');
  assert.deepEqual(interno.inputJson, PARAMS);
});

test('listas (histórico, resultados) e a resposta do cancelamento nunca levam parâmetros', async () => {
  const svc = servicoCom([{ ...LINHA, status: 'success', files: [{ id: 'f', kind: 'output' }] }]);
  for (const resposta of [await svc.listExecutions(ADMIN as never), await svc.listResults(ADMIN as never)]) {
    assert.equal(resposta.length, 1);
    assert.ok(!('inputJson' in resposta[0]));
    assert.ok(!JSON.stringify(resposta).includes('Segredo123'));
  }
  const cancelada = await servicoCom([{ ...LINHA, status: 'running' }]).cancel('e1', ADMIN as never);
  assert.ok(!('inputJson' in cancelada));
});
