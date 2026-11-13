import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { limparTmp } from './_limpar-tmp';
import test, { after, before } from 'node:test';

// O serviço grava em <cwd>/storage: aponta para uma pasta temporária ANTES de importar o módulo.
const tmp = mkdtempSync(join(tmpdir(), 'dash-flow-'));
const cwdOriginal = process.cwd();
/* eslint-disable @typescript-eslint/no-explicit-any */
let DashboardService: any;
let UpdateInProgressError: any;
let DashboardSchedulerService: any;

before(async () => {
  process.chdir(tmp);
  const svc = await import('../src/dashboard/dashboard.service');
  DashboardService = svc.DashboardService;
  UpdateInProgressError = svc.UpdateInProgressError;
  DashboardSchedulerService = (await import('../src/dashboard/dashboard-scheduler.service')).DashboardSchedulerService;
});

after(() => {
  process.chdir(cwdOriginal);
  limparTmp(tmp);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- painel de mentira: um servidor HTTP de verdade ----
interface FakePanel {
  port: number;
  hits: string[];
  mode: 'ok' | 'fail500' | 'slow';
  delayMs: number;
  close(): Promise<void>;
}
async function startPanel(): Promise<FakePanel> {
  const panel = { hits: [] as string[], mode: 'ok' as FakePanel['mode'], delayMs: 0 } as FakePanel;
  const server = http.createServer((req, res) => {
    panel.hits.push(`${req.method} ${req.url}`);
    if (req.url?.startsWith('/api/atualizar') && req.method === 'POST') {
      setTimeout(() => {
        if (panel.mode === 'fail500') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ detail: 'banco fora do ar' }));
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        }
      }, panel.delayMs);
      return;
    }
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  panel.port = (server.address() as AddressInfo).port;
  panel.close = () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
  return panel;
}

// ---- banco em memória (só o que o serviço usa) ----
function fakePrisma(initial: Record<string, any>) {
  const rows = new Map<string, any>(Object.entries(initial));
  const writes: Array<{ id: string; data: any }> = [];
  const pick = (row: any, select?: any) => {
    if (!row) return null;
    if (!select) return { ...row };
    return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));
  };
  const dashboard = {
    findUnique: async ({ where, select }: any) => pick(rows.get(where.id), select),
    findUniqueOrThrow: async ({ where }: any) => {
      const r = rows.get(where.id);
      if (!r) throw new Error('not found');
      return { ...r };
    },
    update: async ({ where, data }: any) => {
      const r = rows.get(where.id);
      Object.assign(r, data);
      writes.push({ id: where.id, data });
      return { ...r };
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const r of rows.values()) {
        if (r.lastUpdateStatus === where.lastUpdateStatus) { Object.assign(r, data); count++; }
      }
      return { count };
    },
    findMany: async (args?: any) => {
      if (args?.select) return [...rows.values()].map((r) => pick(r, args.select));
      if (args?.where?.type) return []; // início automático de painéis: nenhum
      return [...rows.values()].filter((r) => r.isActive && r.updatePath).map((r) => ({ ...r }));
    },
  };
  return { prisma: { dashboard }, rows, writes };
}

function baseRow(port: number | null, extra: Record<string, any> = {}) {
  return {
    id: 'd1', slug: 'meu-painel', name: 'Meu Painel', type: 'server', isActive: true,
    streamlitPort: port, updatePath: '/api/atualizar', warmupMode: 'disabled', warmupPaths: [],
    updateFrequency: 'daily', updateTimesOfDay: ['06:00'], updateDayOfWeek: null, updateDayOfMonth: null,
    lastUpdateStatus: 'ok', lastUpdateAt: new Date('2026-11-11T06:01:00'), lastUpdateError: null, updateRetryAt: null,
    ...extra,
  };
}

function fakeMail() {
  const sent: any[] = [];
  return { sent, mail: { sendPanelUpdateFailure: async (input: unknown) => { sent.push(input); } } };
}

test('atualização manual: grava o horário do FIM, limpa o erro e a repetição pendente', async () => {
  const panel = await startPanel();
  panel.delayMs = 200;
  const { prisma, rows } = fakePrisma({ d1: baseRow(panel.port, { lastUpdateError: 'erro antigo', updateRetryAt: new Date() }) });
  const svc = new DashboardService(prisma);
  try {
    const t0 = Date.now();
    await svc.triggerUpdate('d1');
    const row = rows.get('d1');
    assert.equal(row.lastUpdateStatus, 'ok');
    assert.equal(row.lastUpdateError, null);
    assert.equal(row.updateRetryAt, null);
    assert.ok(row.lastUpdateAt.getTime() >= t0 + 190, 'o horário deve ser o do fim, depois dos 200 ms do painel');
    assert.equal(svc.isUpdating('d1'), false);
  } finally { await panel.close(); }
});

test('falha do painel: guarda status e o corpo da resposta como motivo', async () => {
  const panel = await startPanel();
  panel.mode = 'fail500';
  const { prisma, rows } = fakePrisma({ d1: baseRow(panel.port) });
  const svc = new DashboardService(prisma);
  try {
    await assert.rejects(() => svc.triggerUpdate('d1'), /status 500/);
    const row = rows.get('d1');
    assert.equal(row.lastUpdateStatus, 'error');
    assert.match(row.lastUpdateError, /status 500/);
    assert.match(row.lastUpdateError, /banco fora do ar/);
    assert.equal(svc.isUpdating('d1'), false);
  } finally { await panel.close(); }
});

test('painel sem porta (parado): falha com motivo claro, sem travar a marca de "atualizando"', async () => {
  const { prisma, rows } = fakePrisma({ d1: baseRow(null) });
  const svc = new DashboardService(prisma);
  await assert.rejects(() => svc.triggerUpdate('d1'), /não está em execução/);
  assert.equal(rows.get('d1').lastUpdateStatus, 'error');
  assert.match(rows.get('d1').lastUpdateError, /não está em execução/);
  assert.equal(svc.isUpdating('d1'), false);
});

test('duas atualizações ao mesmo tempo: a segunda é recusada, a primeira conclui', async () => {
  const panel = await startPanel();
  panel.delayMs = 250;
  const { prisma, rows } = fakePrisma({ d1: baseRow(panel.port) });
  const svc = new DashboardService(prisma);
  try {
    const first = svc.triggerUpdate('d1');
    await sleep(50);
    await assert.rejects(() => svc.triggerUpdate('d1'), (e: unknown) => e instanceof UpdateInProgressError);
    await first;
    assert.equal(panel.hits.filter((h) => h.startsWith('POST /api/atualizar')).length, 1);
    assert.equal(rows.get('d1').lastUpdateStatus, 'ok');
  } finally { await panel.close(); }
});

test('programada, 1ª tentativa falha: agenda a 2ª em ~5 min e NÃO manda e-mail', async () => {
  const panel = await startPanel();
  panel.mode = 'fail500';
  const { prisma, rows } = fakePrisma({ d1: baseRow(panel.port) });
  const { mail, sent } = fakeMail();
  const svc = new DashboardService(prisma, mail);
  try {
    const antes = Date.now();
    assert.equal(await svc.runScheduledUpdate('d1', 1), 'retry-scheduled');
    const retryAt = rows.get('d1').updateRetryAt.getTime();
    assert.ok(retryAt >= antes + 4.9 * 60_000 && retryAt <= Date.now() + 5.1 * 60_000, new Date(retryAt).toISOString());
    assert.equal(sent.length, 0);
  } finally { await panel.close(); }
});

test('programada, 2ª tentativa falha: UM e-mail com as duas tentativas e motivos; repetição limpa', async () => {
  const panel = await startPanel();
  panel.mode = 'fail500';
  const { prisma, rows } = fakePrisma({ d1: baseRow(panel.port) });
  const { mail, sent } = fakeMail();
  const svc = new DashboardService(prisma, mail);
  try {
    await svc.runScheduledUpdate('d1', 1);
    const primeiroErro = rows.get('d1').lastUpdateError;
    rows.get('d1').updateRetryAt = new Date(Date.now() - 1000); // venceu
    assert.equal(await svc.runScheduledUpdate('d1', 2), 'failed');
    await sleep(20);
    assert.equal(rows.get('d1').updateRetryAt, null);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].panelName, 'Meu Painel');
    assert.equal(sent[0].slug, 'meu-painel');
    assert.equal(sent[0].attempts.length, 2);
    assert.equal(sent[0].attempts[0].error, primeiroErro);
    assert.match(sent[0].attempts[1].error, /status 500/);
  } finally { await panel.close(); }
});

test('programada: 1ª tentativa ok → sem repetição e sem e-mail; 2ª ok depois de falha → sem e-mail', async () => {
  const panel = await startPanel();
  const { prisma, rows } = fakePrisma({ d1: baseRow(panel.port) });
  const { mail, sent } = fakeMail();
  const svc = new DashboardService(prisma, mail);
  try {
    assert.equal(await svc.runScheduledUpdate('d1', 1), 'ok');
    assert.equal(rows.get('d1').updateRetryAt, null);
    panel.mode = 'fail500';
    await svc.runScheduledUpdate('d1', 1);
    panel.mode = 'ok';
    rows.get('d1').updateRetryAt = new Date(Date.now() - 1000);
    assert.equal(await svc.runScheduledUpdate('d1', 2), 'ok');
    assert.equal(rows.get('d1').lastUpdateError, null);
    assert.equal(rows.get('d1').updateRetryAt, null);
    await sleep(20);
    assert.equal(sent.length, 0);
  } finally { await panel.close(); }
});

test('agendador: horário perdido é recuperado uma vez; repetição só quando vence', async () => {
  const panel = await startPanel();
  const { prisma, rows } = fakePrisma({ d1: baseRow(panel.port) });
  const svc = new DashboardService(prisma, fakeMail().mail);
  const scheduler = new DashboardSchedulerService(prisma, svc);
  scheduler.bootAt = 0; // sem a carência de logo-após-subir
  const hits = () => panel.hits.filter((h) => h.startsWith('POST /api/atualizar')).length;
  try {
    // Hub fora do ar às 06:00, voltou às 06:25: recupera
    await scheduler.tick(new Date('2026-11-12T06:25:00'));
    await sleep(80);
    assert.equal(hits(), 1);
    assert.equal(rows.get('d1').lastUpdateStatus, 'ok');
    // próximo ciclo: já atualizou depois do horário, não repete
    await scheduler.tick(new Date('2026-11-12T06:26:00'));
    await sleep(40);
    assert.equal(hits(), 1);
    // repetição marcada no futuro: espera; vencida: roda
    rows.get('d1').updateRetryAt = new Date('2026-11-12T08:00:00');
    await scheduler.tick(new Date('2026-11-12T07:00:00'));
    await sleep(40);
    assert.equal(hits(), 1);
    await scheduler.tick(new Date('2026-11-12T08:01:00'));
    await sleep(80);
    assert.equal(hits(), 2);
    assert.equal(rows.get('d1').updateRetryAt, null);
  } finally { await panel.close(); }
});

test('agendador: passou da janela de recuperação, não atualiza fora de hora', async () => {
  const panel = await startPanel();
  const { prisma } = fakePrisma({ d1: baseRow(panel.port) });
  const scheduler = new DashboardSchedulerService(prisma, new DashboardService(prisma, fakeMail().mail));
  scheduler.bootAt = 0;
  try {
    await scheduler.tick(new Date('2026-11-12T09:30:00')); // 3h30 depois das 06:00
    await sleep(40);
    assert.equal(panel.hits.filter((h) => h.startsWith('POST')).length, 0);
  } finally { await panel.close(); }
});

test('agendador: painel parado de propósito não é atualizado, não gera e-mail e cancela a repetição pendente', async () => {
  const panel = await startPanel();
  const { prisma, rows } = fakePrisma({ d1: baseRow(panel.port, { streamlitStatus: 'stopped', updateRetryAt: new Date('2026-11-12T06:10:00') }) });
  const { mail, sent } = fakeMail();
  const scheduler = new DashboardSchedulerService(prisma, new DashboardService(prisma, mail));
  scheduler.bootAt = 0;
  try {
    await scheduler.tick(new Date('2026-11-12T06:25:00')); // horário vencido E repetição vencida
    await sleep(60);
    assert.equal(panel.hits.filter((h) => h.startsWith('POST')).length, 0);
    assert.equal(rows.get('d1').updateRetryAt, null);
    assert.equal(sent.length, 0);
    // painel parado, sem repetição pendente: também não faz nada
    rows.get('d1').lastUpdateAt = new Date('2026-11-11T06:01:00');
    await scheduler.tick(new Date('2026-11-12T06:26:00'));
    await sleep(40);
    assert.equal(panel.hits.filter((h) => h.startsWith('POST')).length, 0);
  } finally { await panel.close(); }
});

test('agendador: painel que CAIU (status error) continua sendo tentado, e o e-mail sai depois da 2ª falha', async () => {
  // porta fechada = painel fora do ar de verdade
  const { prisma, rows } = fakePrisma({ d1: baseRow(null, { streamlitStatus: 'error' }) });
  const { mail, sent } = fakeMail();
  const scheduler = new DashboardSchedulerService(prisma, new DashboardService(prisma, mail));
  scheduler.bootAt = 0;
  await scheduler.tick(new Date('2026-11-12T06:25:00'));
  await sleep(60);
  assert.ok(rows.get('d1').updateRetryAt, '1ª tentativa falhou: repetição agendada');
  assert.equal(sent.length, 0);
  rows.get('d1').updateRetryAt = new Date('2026-11-12T06:00:00'); // venceu
  await scheduler.tick(new Date('2026-11-12T06:31:00'));
  await sleep(60);
  assert.equal(sent.length, 1);
  assert.equal(rows.get('d1').updateRetryAt, null);
});

test('agendador: painel sem processo (tipo html, sem status) segue a regra normal', async () => {
  const panel = await startPanel();
  const { prisma } = fakePrisma({ d1: baseRow(panel.port, { streamlitStatus: null }) });
  const scheduler = new DashboardSchedulerService(prisma, new DashboardService(prisma, fakeMail().mail));
  scheduler.bootAt = 0;
  try {
    await scheduler.tick(new Date('2026-11-12T06:25:00'));
    await sleep(80);
    assert.equal(panel.hits.filter((h) => h.startsWith('POST')).length, 1);
  } finally { await panel.close(); }
});

test('agendador: logo depois do Hub subir, painel que ainda não abriu espera o próximo ciclo', async () => {
  const panel = await startPanel();
  const { prisma } = fakePrisma({ d1: baseRow(panel.port) });
  const scheduler = new DashboardSchedulerService(prisma, new DashboardService(prisma, fakeMail().mail));
  // bootAt = agora (padrão) e o painel não está "rodando" para o serviço → não tenta
  try {
    await scheduler.tick(new Date('2026-11-12T06:25:00'));
    await sleep(40);
    assert.equal(panel.hits.filter((h) => h.startsWith('POST')).length, 0);
  } finally { await panel.close(); }
});

test('onModuleInit: atualização que ficou "running" num reinício vira erro e o cache de rotas é carregado', async () => {
  const { prisma, rows } = fakePrisma({ d1: baseRow(null, { lastUpdateStatus: 'running' }) });
  const svc = new DashboardService(prisma);
  await svc.onModuleInit();
  assert.equal(rows.get('d1').lastUpdateStatus, 'error');
  assert.match(rows.get('d1').lastUpdateError, /interrompida/);
  assert.equal(svc.updatePaths.get('d1'), '/api/atualizar');
});

// ---- "Atualizar" de dentro do painel, pelo proxy de verdade ----
async function proxyHarness(panel: FakePanel, rowExtra: Record<string, any> = {}) {
  const { prisma, rows } = fakePrisma({ d1: baseRow(panel.port, rowExtra) });
  const svc = new DashboardService(prisma);
  svc.updatePaths.set('d1', '/api/atualizar');
  const proxy = svc.setupProxy('d1', panel.port, 'meu-painel');
  const server = http.createServer((req, res) => proxy(req, res, () => undefined));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const post = (path: string) =>
    new Promise<{ status: number }>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-length': '0' } }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      });
      r.on('error', reject);
      r.end();
    });
  return { svc, rows, post, port, close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}

test('proxy: "Atualizar" de dentro do painel move o selo: running → ok com o horário do fim', async () => {
  const panel = await startPanel();
  panel.delayMs = 250;
  const h = await proxyHarness(panel, { lastUpdateStatus: 'error', lastUpdateError: 'antigo' });
  try {
    const t0 = Date.now();
    const pending = h.post('/d/meu-painel/api/atualizar');
    await sleep(100);
    assert.equal(h.rows.get('d1').lastUpdateStatus, 'running');
    assert.equal(h.svc.isUpdating('d1'), true);
    assert.equal((await pending).status, 200);
    await sleep(60);
    const row = h.rows.get('d1');
    assert.equal(row.lastUpdateStatus, 'ok');
    assert.equal(row.lastUpdateError, null);
    assert.ok(row.lastUpdateAt.getTime() >= t0 + 240);
    assert.equal(h.svc.isUpdating('d1'), false);
  } finally { await h.close(); await panel.close(); }
});

test('proxy: painel responde 500 ao "Atualizar" → selo vira erro', async () => {
  const panel = await startPanel();
  panel.mode = 'fail500';
  const h = await proxyHarness(panel);
  try {
    assert.equal((await h.post('/d/meu-painel/api/atualizar')).status, 500);
    await sleep(60);
    assert.equal(h.rows.get('d1').lastUpdateStatus, 'error');
    assert.match(h.rows.get('d1').lastUpdateError, /status 500/);
    assert.equal(h.svc.isUpdating('d1'), false);
  } finally { await h.close(); await panel.close(); }
});

test('proxy: outras requisições (POST em outra rota, GET no updatePath) não mexem no estado', async () => {
  const panel = await startPanel();
  const h = await proxyHarness(panel);
  try {
    await h.post('/d/meu-painel/api/chat');
    await h.post('/d/meu-painel/api/atualizar-outra-coisa');
    await sleep(60);
    assert.equal(h.rows.get('d1').lastUpdateAt.toISOString(), new Date('2026-11-11T06:01:00').toISOString());
    assert.equal(h.svc.isUpdating('d1'), false);
  } finally { await h.close(); await panel.close(); }
});

test('proxy: navegador que fecha antes do fim → estado volta ao que era e a marca é solta', async () => {
  const panel = await startPanel();
  panel.delayMs = 400;
  const h = await proxyHarness(panel, { lastUpdateStatus: 'ok' });
  try {
    await new Promise<void>((resolve) => {
      const r = http.request({ host: '127.0.0.1', port: h.port, path: '/d/meu-painel/api/atualizar', method: 'POST', headers: { 'content-length': '0' } });
      r.on('error', () => resolve());
      r.end();
      setTimeout(() => { r.destroy(); resolve(); }, 120);
    });
    await sleep(700);
    assert.equal(h.rows.get('d1').lastUpdateStatus, 'ok');
    assert.equal(h.svc.isUpdating('d1'), false);
  } finally { await h.close(); await panel.close(); }
});

// POST completo (status + corpo), para conferir a mensagem da recusa
function postFull(port: number, path: string) {
  return new Promise<{ status: number; body: string; type: string }>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-length': '0' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, type: String(res.headers['content-type'] ?? '') }));
    });
    r.on('error', reject);
    r.end();
  });
}
const postsRecebidos = (panel: FakePanel) => panel.hits.filter((x) => x.startsWith('POST')).length;

test('proxy: se já há atualização em curso (agendador, botão do Hub), o "Atualizar" de dentro é recusado com 409 e NÃO chega ao painel', async () => {
  const panel = await startPanel();
  const h = await proxyHarness(panel);
  try {
    const desde = new Date('2026-11-13T17:32:00Z');
    h.svc.updating.set('d1', desde); // por exemplo, o agendador já está atualizando
    const r = await postFull(h.port, '/d/meu-painel/api/atualizar');
    assert.equal(r.status, 409);
    assert.match(r.type, /application\/json/);
    const corpo = JSON.parse(r.body);
    assert.equal(corpo.statusCode, 409);
    assert.match(corpo.message, /já está sendo atualizado \(desde 14:32\)/);
    assert.equal(corpo.detail, corpo.message, 'telas que leem "detail" (FastAPI) também acham o texto');
    assert.equal(postsRecebidos(panel), 0, 'o painel não recebeu nada: nada de segunda carga');
    assert.equal(h.svc.updatingSince('d1')?.getTime(), desde.getTime(), 'a marca do outro continua sendo dele');
  } finally { await h.close(); await panel.close(); }
});

test('proxy: dois cliques de dentro: o 1º atualiza, o 2º é recusado (1 carga só); depois que termina, um novo clique passa', async () => {
  const panel = await startPanel();
  panel.delayMs = 300;
  const h = await proxyHarness(panel);
  try {
    const primeiro = postFull(h.port, '/d/meu-painel/api/atualizar');
    await sleep(80);
    const segundo = await postFull(h.port, '/d/meu-painel/api/atualizar');
    assert.equal(segundo.status, 409);
    assert.equal(postsRecebidos(panel), 1);
    assert.equal((await primeiro).status, 200);
    await sleep(80);
    assert.equal(h.svc.isUpdating('d1'), false);
    assert.equal((await postFull(h.port, '/d/meu-painel/api/atualizar')).status, 200, 'terminou: liberado');
    assert.equal(postsRecebidos(panel), 2);
  } finally { await h.close(); await panel.close(); }
});

test('proxy: com a atualização em curso, só o "Atualizar" é recusado; chat, outras rotas e a leitura do status seguem', async () => {
  const panel = await startPanel();
  const h = await proxyHarness(panel);
  try {
    h.svc.updating.set('d1', new Date());
    assert.equal((await postFull(h.port, '/d/meu-painel/api/chat')).status, 200);
    assert.equal((await postFull(h.port, '/d/meu-painel/api/atualizar-outra-coisa')).status, 200);
    assert.equal((await postFull(h.port, '/d/meu-painel/api/atualizar/banco')).status, 200, 'por fonte não é o updatePath configurado');
    // GET no updatePath (ex.: status) não é recusado
    const get = await new Promise<number>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: h.port, path: '/d/meu-painel/api/atualizar' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); }).on('error', reject);
    });
    assert.notEqual(get, 409);
  } finally { await h.close(); await panel.close(); }
});

test('proxy: a recusa vale também com barra no fim, com query string, e sem o prefixo /d/<slug> (como o proxy é montado)', async () => {
  const panel = await startPanel();
  const h = await proxyHarness(panel);
  try {
    h.svc.updating.set('d1', new Date());
    assert.equal((await postFull(h.port, '/d/meu-painel/api/atualizar/')).status, 409);
    assert.equal((await postFull(h.port, '/d/meu-painel/api/atualizar?x=1')).status, 409);
    assert.equal((await postFull(h.port, '/api/atualizar')).status, 409);
    // outro painel com prefixo parecido não é confundido
    assert.equal((await postFull(h.port, '/d/meu-painel-2/api/atualizar')).status, 200);
    assert.equal(postsRecebidos(panel), 1);
  } finally { await h.close(); await panel.close(); }
});

test('proxy: painel sem updatePath configurado nunca é recusado (não há como reconhecer o "Atualizar")', async () => {
  const panel = await startPanel();
  const h = await proxyHarness(panel);
  try {
    h.svc.updatePaths.set('d1', null);
    h.svc.updating.set('d1', new Date());
    assert.equal((await postFull(h.port, '/d/meu-painel/api/atualizar')).status, 200);
  } finally { await h.close(); await panel.close(); }
});

test('proxy: navegador que fecha no meio do 1º "Atualizar" libera a marca e o próximo clique passa', async () => {
  const panel = await startPanel();
  panel.delayMs = 400;
  const h = await proxyHarness(panel);
  try {
    await new Promise<void>((resolve) => {
      const r = http.request({ host: '127.0.0.1', port: h.port, path: '/d/meu-painel/api/atualizar', method: 'POST', headers: { 'content-length': '0' } });
      r.on('error', () => resolve());
      r.end();
      setTimeout(() => { r.destroy(); resolve(); }, 120);
    });
    await sleep(100);
    assert.equal(h.svc.isUpdating('d1'), false, 'marca solta');
    assert.equal((await postFull(h.port, '/d/meu-painel/api/atualizar')).status, 200);
  } finally { await h.close(); await panel.close(); }
});

const getJson = (port: number, path: string) =>
  new Promise<{ status: number; json: any; type: string; cache: string }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json: any = null; try { json = JSON.parse(body); } catch { /* não é JSON */ }
        resolve({ status: res.statusCode ?? 0, json, type: String(res.headers['content-type'] ?? ''), cache: String(res.headers['cache-control'] ?? '') });
      });
    }).on('error', reject);
  });

test('proxy: GET /__hub/atualizacao responde pelo Hub (não chega ao painel): "não está atualizando" e depois "desde quando"', async () => {
  const panel = await startPanel();
  const h = await proxyHarness(panel);
  try {
    const livre = await getJson(h.port, '/d/meu-painel/__hub/atualizacao');
    assert.equal(livre.status, 200);
    assert.match(livre.type, /application\/json/);
    assert.match(livre.cache, /no-store/);
    assert.deepEqual(livre.json, { atualizando: false, desde: null });
    const desde = new Date('2026-11-13T17:32:00Z');
    h.svc.updating.set('d1', desde);
    const ocupado = await getJson(h.port, '/d/meu-painel/__hub/atualizacao?x=1');
    assert.deepEqual(ocupado.json, { atualizando: true, desde: desde.toISOString() });
    assert.equal(panel.hits.length, 0, 'nenhum pedido chegou ao painel');
    h.svc.updating.delete('d1');
    assert.equal((await getJson(h.port, '/d/meu-painel/__hub/atualizacao')).json.atualizando, false, 'terminou: libera');
  } finally { await h.close(); await panel.close(); }
});

test('proxy: a consulta de estado só vale em GET na rota exata; outras rotas e métodos seguem para o painel', async () => {
  const panel = await startPanel();
  const h = await proxyHarness(panel);
  try {
    assert.equal((await postFull(h.port, '/d/meu-painel/__hub/atualizacao')).status, 200); // POST segue ao painel (200 "ok")
    assert.ok(panel.hits.includes('POST /__hub/atualizacao'));
    await getJson(h.port, '/d/meu-painel/__hub/outra-coisa');
    assert.ok(panel.hits.includes('GET /__hub/outra-coisa'));
  } finally { await h.close(); await panel.close(); }
});

test('proxy: a recusa 409 também diz que está atualizando e desde quando (telas novas usam isso)', async () => {
  const panel = await startPanel();
  const h = await proxyHarness(panel);
  try {
    const desde = new Date('2026-11-13T17:32:00Z');
    h.svc.updating.set('d1', desde);
    const corpo = JSON.parse((await postFull(h.port, '/d/meu-painel/api/atualizar')).body);
    assert.equal(corpo.atualizando, true);
    assert.equal(corpo.desde, desde.toISOString());
  } finally { await h.close(); await panel.close(); }
});

test('proxy: o websocket (upgrade) continua exposto no proxy', async () => {
  const panel = await startPanel();
  const h = await proxyHarness(panel);
  try {
    assert.equal(typeof h.svc.getProxy('d1')?.upgrade, 'function');
  } finally { await h.close(); await panel.close(); }
});
