import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import { STORAGE_LINK_TTL_MS, createStorageLinkToken, verifyStorageLinkToken } from '../src/shared/storage-links';
import { createStorageAccessMiddleware } from '../src/shared/storage-middleware';

// `storageRoot` usa process.cwd() ao carregar o módulo: troca de pasta antes dos imports dinâmicos (cada arquivo de
// teste roda em seu próprio processo) e volta no fim — no Windows não dá para apagar a pasta em que o processo está.
const cwdOriginal = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), 'storage-links-'));
process.chdir(tmp);

type Controller = import('../src/storage/storage.controller').StorageController;
let StorageController: new (auth: never, prisma: never) => Controller;
let storageRoot: string;

test.before(async () => {
  ({ StorageController } = await import('../src/storage/storage.controller'));
  ({ storageRoot } = await import('../src/shared/storage'));
});
test.after(() => {
  process.chdir(cwdOriginal);
  rmSync(tmp, { recursive: true, force: true });
});

const CAMINHO = '/executions/e1/output/output.zip';

test('o token vale só para o caminho pedido, só até expirar e só se não foi adulterado', () => {
  const agora = 1_000_000;
  const token = createStorageLinkToken(CAMINHO, 'u1', agora);
  assert.equal(verifyStorageLinkToken(token, CAMINHO, agora + 1000), true);
  assert.equal(verifyStorageLinkToken(token, '/executions/e2/output/output.zip', agora + 1000), false);   // outro arquivo
  assert.equal(verifyStorageLinkToken(token, CAMINHO, agora + STORAGE_LINK_TTL_MS + 1), false);           // expirou
  assert.equal(verifyStorageLinkToken(token, CAMINHO, agora + STORAGE_LINK_TTL_MS - 1), true);

  const [payload, assinatura] = token.split('.');
  const outroPayload = Buffer.from(JSON.stringify({ p: '/executions/e2/output/output.zip', u: 'u1', e: agora + 99_999_999 })).toString('base64url');
  assert.equal(verifyStorageLinkToken(`${outroPayload}.${assinatura}`, '/executions/e2/output/output.zip', agora), false);   // payload trocado
  assert.equal(verifyStorageLinkToken(`${payload}.${assinatura.slice(0, -2)}xx`, CAMINHO, agora), false);                      // assinatura alterada
  for (const lixo of [undefined, null, 42, '', 'abc', 'a.b.c', `${payload}`, `${payload}.`]) {
    assert.equal(verifyStorageLinkToken(lixo, CAMINHO, agora), false);
  }
});

// ---- servidor Express de verdade: middleware de acesso + arquivos estáticos, como em main.ts ----
async function comServidor(
  prisma: unknown,
  teste: (get: (path: string, headers?: Record<string, string>) => Promise<{ status: number; headers: Record<string, unknown>; body: string }>) => Promise<void>,
) {
  const raiz = join(tmp, 'estatico');
  mkdirSync(join(raiz, 'executions', 'e1', 'output'), { recursive: true });
  writeFileSync(join(raiz, 'executions', 'e1', 'output', 'output.zip'), '0123456789');
  writeFileSync(join(raiz, 'executions', 'e1', 'output', 'Relatório final 5.xlsx'), 'PLANILHA');

  const app = express();
  app.use('/storage', createStorageAccessMiddleware(prisma as never));
  app.use('/storage', express.static(raiz));
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const porta = (server.address() as AddressInfo).port;
  const get = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: porta, path, headers }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });
  try {
    await teste(get);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const SEM_SESSAO = { session: { findFirst: async () => null } };

test('com o link assinado baixa sem cabeçalho, como anexo, e aceita download parcial (Range)', async () => {
  await comServidor(SEM_SESSAO, async (get) => {
    const token = createStorageLinkToken(CAMINHO, 'u1');
    const r = await get(`/storage${CAMINHO}?dl=${token}`);
    assert.equal(r.status, 200);
    assert.equal(r.body, '0123456789');
    assert.equal(r.headers['content-disposition'], 'attachment');

    const parcial = await get(`/storage${CAMINHO}?dl=${token}`, { Range: 'bytes=2-5' });   // retomar/baixar por partes
    assert.equal(parcial.status, 206);
    assert.equal(parcial.body, '2345');
  });
});

test('nome com acento e espaço funciona (caminho codificado na URL)', async () => {
  await comServidor(SEM_SESSAO, async (get) => {
    const caminho = '/executions/e1/output/Relatório final 5.xlsx';
    const token = createStorageLinkToken(caminho, 'u1');
    const r = await get(`/storage${encodeURI(caminho)}?dl=${token}`);
    assert.equal(r.status, 200);
    assert.equal(r.body, 'PLANILHA');
  });
});

test('link de outro arquivo, expirado, adulterado ou ausente é recusado', async () => {
  await comServidor(SEM_SESSAO, async (get) => {
    const doOutro = createStorageLinkToken('/executions/e2/output/output.zip', 'u1');
    assert.equal((await get(`/storage${CAMINHO}?dl=${doOutro}`)).status, 401);

    const expirado = createStorageLinkToken(CAMINHO, 'u1', Date.now() - STORAGE_LINK_TTL_MS - 5000);
    assert.equal((await get(`/storage${CAMINHO}?dl=${expirado}`)).status, 401);

    const bom = createStorageLinkToken(CAMINHO, 'u1');
    assert.equal((await get(`/storage${CAMINHO}?dl=${bom.slice(0, -3)}abc`)).status, 401);
    assert.equal((await get(`/storage${CAMINHO}?dl=lixo`)).status, 401);

    assert.equal((await get(`/storage${CAMINHO}`)).status, 401);                          // sem link e sem cabeçalho
    const r = await get(`/storage${CAMINHO}?dl=${doOutro}`);
    assert.match(r.body, /inválido ou expirado/);
    // o link NÃO abre outro arquivo trocando o caminho na URL
    assert.equal((await get(`/storage/executions/e1/output/${encodeURIComponent('Relatório final 5.xlsx')}?dl=${bom}`)).status, 401);
  });
});

test('o jeito antigo (cabeçalho Authorization) continua funcionando e respeitando o acesso', async () => {
  const usuario = { id: 'u1', role: 'admin', departments: [], isActive: true };
  const prisma = {
    session: { findFirst: async () => ({ user: usuario }) },
    execution: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === 'e1' ? { userId: 'u1', scheduledTaskId: null, user: { departments: [] }, robot: { allowedDepartments: [] } } : null) },
  };
  await comServidor(prisma, async (get) => {
    const r = await get(`/storage${CAMINHO}`, { Authorization: 'Bearer qualquer' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-disposition'], undefined);                              // sem "attachment" nesse caminho
    assert.equal((await get('/storage/executions/e9/output/x.zip', { Authorization: 'Bearer qualquer' })).status, 404);
  });
});

// ---- POST /api/storage/link ----
function controlador(opcoes: { execucaoExiste?: boolean } = {}) {
  const usuario = { id: 'u1', role: 'admin', departments: [], isActive: true };
  const auth = { requireUser: async () => usuario };
  const prisma = {
    execution: {
      findUnique: async () =>
        opcoes.execucaoExiste === false
          ? null
          : { userId: 'u1', scheduledTaskId: null, user: { departments: [] }, robot: { allowedDepartments: [] } },
    },
  };
  return new StorageController(auth as never, prisma as never);
}

function arquivoNoStorage(rel: string, conteudo: string) {
  const full = join(storageRoot, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, conteudo);
}

test('emite o link para um arquivo que existe e o link serve exatamente aquele caminho', async () => {
  arquivoNoStorage('executions/e1/output/COMERCIAL GÁS 5.xlsx', 'abc');
  const c = controlador();
  const r = await c.createLink({} as never, { path: '/storage/executions/e1/output/COMERCIAL GÁS 5.xlsx' });
  assert.equal(r.size, 3);
  const url = new URL(r.url, 'http://x');
  assert.equal(decodeURIComponent(url.pathname), '/storage/executions/e1/output/COMERCIAL GÁS 5.xlsx');
  assert.equal(verifyStorageLinkToken(url.searchParams.get('dl'), '/executions/e1/output/COMERCIAL GÁS 5.xlsx'), true);
  assert.equal(verifyStorageLinkToken(url.searchParams.get('dl'), '/executions/e1/output/outro.xlsx'), false);
});

test('sem acesso: 404 igual ao /storage; arquivo apagado: mensagem clara; caminho estranho: recusado', async () => {
  arquivoNoStorage('executions/e1/output/ok.txt', 'x');
  await assert.rejects(() => controlador({ execucaoExiste: false }).createLink({} as never, { path: '/storage/executions/e1/output/ok.txt' }), /Arquivo não encontrado/);
  await assert.rejects(() => controlador().createLink({} as never, { path: '/storage/executions/e1/output/apagado-pela-retencao.zip' }), /não está mais no servidor/);
  for (const ruim of ['/outra/coisa', '', undefined, 42, '/storage/../segredo.txt', '/storage/executions/../../.env']) {
    await assert.rejects(() => controlador().createLink({} as never, { path: ruim as never }));
  }
});
