import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import AdmZip from 'adm-zip';

// `storageRoot` é calculado com process.cwd() quando o módulo é carregado: troca de pasta ANTES do import,
// para os arquivos de teste irem para uma pasta temporária (cada arquivo de teste roda em seu próprio processo).
const cwdOriginal = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), 'retry-test-'));
process.chdir(tmp);

type Svc = import('../src/executions/executions.service').ExecutionsService;
let ExecutionsService: new (prisma: never) => Svc;
let storageRoot: string;

test.before(async () => {
  ({ ExecutionsService } = await import('../src/executions/executions.service'));
  ({ storageRoot } = await import('../src/shared/storage'));
});
test.after(() => {
  process.chdir(cwdOriginal);   // no Windows não dá para apagar a pasta em que o próprio processo está
  rmSync(tmp, { recursive: true, force: true });
});

const DONO = { id: 'u-dono', name: 'Jefferson', email: 'j@x.com', role: 'employee', departments: ['contabil'] };
const COLEGA = { id: 'u-colega', name: 'Colega', email: 'c@x.com', role: 'employee', departments: ['contabil'] };
const ADMIN = { id: 'u-admin', name: 'Davi', email: 'd@x.com', role: 'admin', departments: ['inovacao'] };
const ROBO = { id: 'r1', name: 'Consulta CF-e', allowedDepartments: [] as string[] };

type Arq = { kind: string; name: string; content: Buffer | string };

// Monta no disco uma execução "original" e um prisma de mentira que a enxerga.
function cenario(opcoes: { status?: string; inputs: Arq[]; outputs: Arq[]; outputZip?: boolean; inputJson?: object }) {
  const id = 'orig1';
  const root = join(storageRoot, 'executions', id);
  mkdirSync(join(root, 'input'), { recursive: true });
  mkdirSync(join(root, 'output'), { recursive: true });

  const files: Array<Record<string, unknown>> = [];
  let n = 0;
  for (const f of opcoes.inputs) {
    const stored = `1792584406395-bz281m-${f.name}`;
    writeFileSync(join(root, 'input', stored), f.content);
    files.push({
      id: `f${++n}`, executionId: id, kind: 'input', filename: stored, originalName: f.name, downloadName: f.name,
      storagePath: `executions/${id}/input/${stored}`, mimeType: 'application/octet-stream', size: Buffer.byteLength(f.content),
    });
  }
  if (opcoes.outputZip) {
    const zip = new AdmZip();
    for (const f of opcoes.outputs) zip.addFile(f.name, Buffer.from(f.content));
    zip.writeZip(join(root, 'output', 'output.zip'));
    files.push({ id: `f${++n}`, executionId: id, kind: 'output', filename: 'output.zip', originalName: null, downloadName: 'output.zip', storagePath: `executions/${id}/output/output.zip`, mimeType: null, size: 1 });
  } else {
    for (const f of opcoes.outputs) {
      writeFileSync(join(root, 'output', f.name), f.content);
      files.push({ id: `f${++n}`, executionId: id, kind: 'output', filename: f.name, originalName: null, downloadName: f.name, storagePath: `executions/${id}/output/${f.name}`, mimeType: null, size: 1 });
    }
  }

  const execs = new Map<string, Record<string, unknown>>();
  execs.set(id, {
    id, robotId: ROBO.id, userId: DONO.id, requestedByName: DONO.name, requestedByEmail: DONO.email, notes: null, priority: 0,
    status: opcoes.status ?? 'error', cleanedAt: null, scheduledTaskId: null,
    inputJson: opcoes.inputJson ?? { cgf: '64794830', tipo: 'nfce', cpf: '111', senha: 'abc' },
  });
  const allFiles = [...files];
  const logs: Array<{ executionId: string; level: string; message: string }> = [];
  let seq = 0;

  const montar = (e: Record<string, unknown>) => ({
    ...e, robot: ROBO, user: { id: e.userId, departments: ['contabil'] },
    files: allFiles.filter((f) => f.executionId === e.id), logs: logs.filter((l) => l.executionId === e.id),
  });
  const prisma = {
    execution: {
      findUnique: async ({ where }: { where: { id: string } }) => (execs.has(where.id) ? montar(execs.get(where.id)!) : null),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const novo = { id: `nova${++seq}`, status: 'queued', progress: 0, cleanedAt: null, scheduledTaskId: null, ...data };
        execs.set(novo.id as string, novo);
        return novo;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        Object.assign(execs.get(where.id)!, data);
        return execs.get(where.id);
      },
    },
    executionFile: { createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => { allFiles.push(...data.map((d) => ({ id: `n${++n}`, ...d }))); return { count: data.length }; } },
    executionLog: { create: async ({ data }: { data: { executionId: string; level: string; message: string } }) => { logs.push(data); return data; } },
  };
  const svc = new ExecutionsService(prisma as never);
  const inputsDe = (execId: string) => allFiles.filter((f) => f.executionId === execId && f.kind === 'input');
  const leInput = (f: Record<string, unknown>) => readFileSync(join(storageRoot, f.storagePath as string)).toString();
  return { svc, execs, logs, inputsDe, leInput };
}

const U = (u: typeof DONO) => u as never;

test('planilha final (dentro do output.zip, com nome acentuado) vira a entrada da nova execução', async () => {
  const c = cenario({
    inputs: [{ kind: 'input', name: 'COMERCIAL GÁS 5.xls', content: 'PLANILHA-ORIGINAL' }],
    outputs: [
      { kind: 'output', name: '23261017932396000531650010000098061000000498.xml', content: '<xml/>' },
      { kind: 'output', name: 'COMERCIAL GÁS 5.xlsx', content: 'PLANILHA-FINAL' },
    ],
    outputZip: true,
  });
  const nova = await c.svc.retryWithOutputSpreadsheet('orig1', U(DONO));
  const entradas = c.inputsDe(nova.id as string);
  assert.equal(entradas.length, 1);
  assert.equal(entradas[0].originalName, 'COMERCIAL GÁS 5.xlsx');        // nome da original, extensão da final
  assert.equal(entradas[0].mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(c.leInput(entradas[0]), 'PLANILHA-FINAL');
  assert.deepEqual(nova.inputJson, { cgf: '64794830', tipo: 'nfce', cpf: '111', senha: 'abc' });   // mesmos parâmetros
  assert.equal(nova.userId, DONO.id);
  assert.ok(c.logs.some((l) => l.executionId === nova.id && /planilha de saída "COMERCIAL GÁS 5\.xlsx"/.test(l.message)));
  assert.equal(c.inputsDe('orig1').length, 1);                           // a execução original não foi tocada
  assert.equal(c.leInput(c.inputsDe('orig1')[0]), 'PLANILHA-ORIGINAL');
});

test('planilha solta na saída (sem zip) também serve', async () => {
  const c = cenario({
    inputs: [{ kind: 'input', name: 'dados.xlsx', content: 'ORIGINAL' }],
    outputs: [{ kind: 'output', name: 'dados.xlsx', content: 'FINAL' }],
  });
  const nova = await c.svc.retryWithOutputSpreadsheet('orig1', U(DONO));
  assert.equal(c.leInput(c.inputsDe(nova.id as string)[0]), 'FINAL');
});

test('só troca a planilha: os outros arquivos de entrada continuam', async () => {
  const c = cenario({
    inputs: [
      { kind: 'input', name: 'certificado.pfx', content: 'PFX' },
      { kind: 'input', name: 'base.xls', content: 'ORIGINAL' },
    ],
    outputs: [{ kind: 'output', name: 'base.xlsx', content: 'FINAL' }],
  });
  const nova = await c.svc.retryWithOutputSpreadsheet('orig1', U(DONO));
  const porNome = Object.fromEntries(c.inputsDe(nova.id as string).map((f) => [f.originalName, c.leInput(f)]));
  assert.deepEqual(porNome, { 'certificado.pfx': 'PFX', 'base.xlsx': 'FINAL' });
});

test('rodar novamente com as mesmas entradas: quem executou pode, um colega não, admin pode', async () => {
  const mk = () => cenario({ inputs: [{ kind: 'input', name: 'a.xlsx', content: 'X' }], outputs: [] });
  const c1 = mk();
  const nova = await c1.svc.retry('orig1', U(DONO));
  assert.equal(c1.leInput(c1.inputsDe(nova.id as string)[0]), 'X');
  await assert.rejects(() => mk().svc.retry('orig1', U(COLEGA)), /Só quem executou/);
  await assert.rejects(() => mk().svc.retryWithOutputSpreadsheet('orig1', U(COLEGA)), /Só quem executou/);
  const comoAdmin = await mk().svc.retry('orig1', U(ADMIN));
  assert.equal(comoAdmin.userId, DONO.id);   // a execução nova continua sendo de quem executou (parâmetros e credenciais dele)
});

test('só execuções com erro ou canceladas podem ser repetidas', async () => {
  const c = cenario({ status: 'success', inputs: [{ kind: 'input', name: 'a.xlsx', content: 'X' }], outputs: [{ kind: 'output', name: 'a.xlsx', content: 'Y' }] });
  await assert.rejects(() => c.svc.retryWithOutputSpreadsheet('orig1', U(DONO)), /falha ou canceladas/);
  const c2 = cenario({ status: 'running', inputs: [], outputs: [] });
  await assert.rejects(() => c2.svc.retry('orig1', U(DONO)), /falha ou canceladas/);
  const c3 = cenario({ status: 'canceled', inputs: [{ kind: 'input', name: 'a.xlsx', content: 'X' }], outputs: [{ kind: 'output', name: 'a.xlsx', content: 'Y' }] });
  await c3.svc.retryWithOutputSpreadsheet('orig1', U(DONO));   // cancelada vale
});

test('sem planilha na saída, ou sem planilha na entrada: erro claro e nada é criado', async () => {
  const semSaida = cenario({ inputs: [{ kind: 'input', name: 'a.xlsx', content: 'X' }], outputs: [{ kind: 'output', name: 'log.txt', content: 'x' }] });
  await assert.rejects(() => semSaida.svc.retryWithOutputSpreadsheet('orig1', U(DONO)), /nenhuma planilha/);
  assert.equal(semSaida.execs.size, 1);

  const semEntrada = cenario({ inputs: [{ kind: 'input', name: 'dados.csv', content: 'x' }], outputs: [{ kind: 'output', name: 'saida.xlsx', content: 'y' }] });
  await assert.rejects(() => semEntrada.svc.retryWithOutputSpreadsheet('orig1', U(DONO)), /não recebeu planilha/);
  assert.equal(semEntrada.execs.size, 1);
});

test('várias planilhas na saída: vale a de mesmo nome da entrada; se não der, pede o nome', async () => {
  const c = cenario({
    inputs: [{ kind: 'input', name: 'Controle 2026.xls', content: 'O' }],
    outputs: [{ kind: 'output', name: 'resumo.xlsx', content: 'RESUMO' }, { kind: 'output', name: 'Controle 2026.xlsx', content: 'FINAL' }],
  });
  const nova = await c.svc.retryWithOutputSpreadsheet('orig1', U(DONO));
  assert.equal(c.leInput(c.inputsDe(nova.id as string)[0]), 'FINAL');

  const ambigua = cenario({
    inputs: [{ kind: 'input', name: 'entrada.xls', content: 'O' }],
    outputs: [{ kind: 'output', name: 'a.xlsx', content: 'A' }, { kind: 'output', name: 'b.xlsx', content: 'B' }],
  });
  await assert.rejects(() => ambigua.svc.retryWithOutputSpreadsheet('orig1', U(DONO)), /mais de uma planilha na saída \(a\.xlsx, b\.xlsx\)/);
  const escolhida = await ambigua.svc.retryWithOutputSpreadsheet('orig1', U(DONO), 'B.XLSX');
  assert.equal(ambigua.leInput(ambigua.inputsDe(escolhida.id as string)[0]), 'B');
});
