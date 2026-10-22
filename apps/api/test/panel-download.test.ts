import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { HttpException } from '@nestjs/common';
import express from 'express';
import { PanelDownloadService, isValidPanelFile, panelFileDisplayName } from '../src/site-chat/panel-download.service';
import { SiteChatController } from '../src/site-chat/site-chat.controller';
import { STORAGE_LINK_TTL_MS, createStorageLinkToken } from '../src/shared/storage-links';

const HEX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const ARQUIVO = `${HEX}__Balancete setembro.xlsx`;
const CONTEUDO = randomBytes(300_000);                          // "Excel" binário de verdade (não é texto)
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const DONO = { id: 'u-dono', name: 'Ana', email: 'a@x.com', role: 'employee', departments: ['contabil'] };
const OUTRO = { id: 'u-outro', name: 'Beto', email: 'b@x.com', role: 'employee', departments: ['fiscal'] };
const USUARIOS: Record<string, typeof DONO> = { dono: DONO, outro: OUTRO };

type Painel = { server: Server; port: number; pedidos: string[]; fechouNoMeio: boolean };

// Painel de mentira: serve o arquivo em `prefixo`/<arquivo> como o /chatkit-download real.
async function subirPainel(opcoes: { prefixo: string; semDisposition?: boolean; lento?: boolean }): Promise<Painel> {
  const painel = { pedidos: [] as string[], fechouNoMeio: false } as Painel;
  painel.server = createServer((req: IncomingMessage, res) => {
    painel.pedidos.push(decodeURIComponent(req.url ?? ''));
    const alvo = `${opcoes.prefixo}/${encodeURIComponent(ARQUIVO)}`;
    if (req.url !== alvo && decodeURIComponent(req.url ?? '') !== `${opcoes.prefixo}/${ARQUIVO}` && !/Balancete \(set\)/.test(decodeURIComponent(req.url ?? ''))) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"detail":"Not Found"}');
      return;
    }
    const cabecalhos: Record<string, string | number> = {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Length': CONTEUDO.length,
      'Cache-Control': 'max-age=3600',                       // o hub NÃO pode repassar isso
    };
    if (!opcoes.semDisposition) cabecalhos['Content-Disposition'] = 'attachment; filename="Balancete setembro.xlsx"';
    res.writeHead(200, cabecalhos);
    if (!opcoes.lento) { res.end(CONTEUDO); return; }
    // arquivo "grande" entregue devagar: serve para provar que o hub para de puxar quando o cliente desiste
    let enviado = 0;
    const timer = setInterval(() => {
      if (enviado >= CONTEUDO.length) { clearInterval(timer); res.end(); return; }
      res.write(CONTEUDO.subarray(enviado, enviado + 20_000));
      enviado += 20_000;
    }, 40);
    req.on('close', () => { if (enviado < CONTEUDO.length) { painel.fechouNoMeio = true; } clearInterval(timer); });
  });
  await new Promise<void>((r) => painel.server.listen(0, '127.0.0.1', r));
  painel.port = (painel.server.address() as AddressInfo).port;
  return painel;
}

const fechar = (s: Server) => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); });

type Cenario = {
  base: string; svc: PanelDownloadService; fechar: () => Promise<void>;
};

// Hub de mentira: o controller de verdade (rotas) + o serviço de verdade, atrás de um Express, com o banco simulado.
async function subirHub(dashboards: Record<string, Record<string, unknown>>): Promise<Cenario> {
  const prisma = { dashboard: { findUnique: async ({ where }: { where: { id: string } }) => dashboards[where.id] ?? null } };
  const svc = new PanelDownloadService(prisma as never);
  const auth = {
    requireUser: async (req: express.Request) => {
      const quem = USUARIOS[String(req.headers['x-user'] ?? '')];
      if (!quem) throw new HttpException('Não autorizado.', 401);
      return quem;
    },
  };
  const controller = new SiteChatController(null as never, auth as never, svc);
  const erro = (e: unknown, res: express.Response) => {
    if (res.headersSent) { res.destroy(); return; }
    const status = e instanceof HttpException ? e.getStatus() : 500;
    res.status(status).json({ message: e instanceof Error ? e.message : String(e) });
  };
  const app = express();
  app.post('/api/site-chat/panel-download', express.json(), async (req, res) => {
    try { res.json(await controller.panelDownloadLink(req, req.body)); } catch (e) { erro(e, res); }
  });
  app.get('/api/site-chat/panel-download', async (req, res) => {
    try { await controller.panelDownload(req, res, req.query.d as string, req.query.f as string, req.query.dl as string); } catch (e) { erro(e, res); }
  });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, svc, fechar: () => fechar(server) };
}

const painelDoBanco = (porta: number, extra: Record<string, unknown> = {}) => ({
  id: 'dash1', slug: 'bi-teste', type: 'server', isActive: true, streamlitPort: porta,
  allowedDepartments: [], minRole: 'employee', allowedUserIds: [], ...extra,
});

async function pedirLink(base: string, quem: string, dashboardId: string, file: string) {
  const r = await fetch(`${base}/api/site-chat/panel-download`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': quem }, body: JSON.stringify({ dashboardId, file }) });
  return { status: r.status, corpo: (await r.json()) as { url?: string; name?: string; message?: string } };
}

test('o nome do arquivo é validado e a parte técnica some do nome mostrado', () => {
  assert.equal(isValidPanelFile(ARQUIVO), true);
  assert.equal(isValidPanelFile(`${HEX}__Balancete (set) çãõ.xlsx`), true);
  for (const ruim of ['', 'relatorio.xlsx', `${HEX}.xlsx`, `${HEX}__`, `${HEX}__../segredo.xlsx`, `${HEX}__a/b.xlsx`, `${HEX}__a\\b.xlsx`, `${HEX}__a?b.xlsx`, `xyz__a.xlsx`, `${HEX}__${'a'.repeat(300)}.xlsx`, undefined, 42, null]) {
    assert.equal(isValidPanelFile(ruim), false, String(ruim));
  }
  assert.equal(panelFileDisplayName(ARQUIVO), 'Balancete setembro.xlsx');
});

test('fluxo completo: link com a sessão, download sem cabeçalho, binário idêntico e sem cache', async () => {
  const painel = await subirPainel({ prefixo: '/chatkit-download' });
  const hub = await subirHub({ dash1: painelDoBanco(painel.port) });
  try {
    const { status, corpo } = await pedirLink(hub.base, 'dono', 'dash1', ARQUIVO);
    assert.equal(status, 200);                                          // (no Nest de verdade o POST responde 201; o frontend aceita 2xx)
    assert.equal(corpo.name, 'Balancete setembro.xlsx');
    assert.match(corpo.url!, /^\/api\/site-chat\/panel-download\?d=dash1&f=.+&dl=.+/);

    const r = await fetch(hub.base + corpo.url);                          // como o navegador: sem Authorization, sem x-user
    assert.equal(r.status, 200);
    const bytes = Buffer.from(await r.arrayBuffer());
    assert.equal(bytes.length, CONTEUDO.length);
    assert.equal(sha(bytes), sha(CONTEUDO));                              // idêntico, byte a byte
    assert.equal(r.headers.get('content-disposition'), 'attachment; filename="Balancete setembro.xlsx"');   // mantido
    assert.equal(r.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.equal(r.headers.get('content-length'), String(CONTEUDO.length));
    assert.match(r.headers.get('cache-control')!, /no-store/);            // o "max-age=3600" do painel NÃO passa
    assert.equal(r.headers.get('x-accel-buffering'), 'no');
    assert.equal(painel.pedidos[0], `/chatkit-download/${ARQUIVO}`);      // pediu o arquivo certo ao painel
  } finally {
    await hub.fechar(); await fechar(painel.server);
  }
});

test('quem não tem acesso ao painel, painel inativo ou arquivo inválido não ganham link', async () => {
  const painel = await subirPainel({ prefixo: '/chatkit-download' });
  const hub = await subirHub({
    dash1: painelDoBanco(painel.port, { allowedUserIds: [DONO.id] }),            // lista fechada: só a Ana
    inativo: painelDoBanco(painel.port, { id: 'inativo', isActive: false }),
  });
  try {
    assert.equal((await pedirLink(hub.base, 'dono', 'dash1', ARQUIVO)).status, 200);
    assert.equal((await pedirLink(hub.base, 'outro', 'dash1', ARQUIVO)).status, 404);        // igual a "não existe"
    assert.equal((await pedirLink(hub.base, 'dono', 'inativo', ARQUIVO)).status, 404);
    assert.equal((await pedirLink(hub.base, 'dono', 'nao-existe', ARQUIVO)).status, 404);
    assert.equal((await pedirLink(hub.base, 'dono', 'dash1', `${HEX}__../../etc/passwd`)).status, 400);
    assert.equal((await pedirLink(hub.base, 'dono', 'dash1', 'qualquer.xlsx')).status, 400);
    assert.equal((await pedirLink(hub.base, 'dono', '../x', ARQUIVO)).status, 400);
    const semSessao = await fetch(`${hub.base}/api/site-chat/panel-download`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dashboardId: 'dash1', file: ARQUIVO }) });
    assert.equal(semSessao.status, 401);
    assert.equal(painel.pedidos.length, 0);                                                  // nada chegou ao painel
  } finally {
    await hub.fechar(); await fechar(painel.server);
  }
});

test('link de outro arquivo/painel, adulterado, expirado ou ausente é recusado e o painel nem é consultado', async () => {
  const painel = await subirPainel({ prefixo: '/chatkit-download' });
  const hub = await subirHub({ dash1: painelDoBanco(painel.port) });
  try {
    const ok = (await pedirLink(hub.base, 'dono', 'dash1', ARQUIVO)).corpo.url!;
    const f = encodeURIComponent(ARQUIVO);
    const bom = new URL(hub.base + ok).searchParams.get('dl')!;
    const cenarios: Array<[string, string]> = [
      ['sem token', `/api/site-chat/panel-download?d=dash1&f=${f}`],
      ['token adulterado', `/api/site-chat/panel-download?d=dash1&f=${f}&dl=${bom.slice(0, -3)}abc`],
      ['token de outro arquivo', `/api/site-chat/panel-download?d=dash1&f=${encodeURIComponent(`${HEX}__Outro.xlsx`)}&dl=${bom}`],
      ['token de outro painel', `/api/site-chat/panel-download?d=dash2&f=${f}&dl=${bom}`],
      ['expirado', `/api/site-chat/panel-download?d=dash1&f=${f}&dl=${createStorageLinkToken(`panel:dash1:${ARQUIVO}`, DONO.id, Date.now() - STORAGE_LINK_TTL_MS - 5000)}`],
      ['arquivo com ..', `/api/site-chat/panel-download?d=dash1&f=${encodeURIComponent(`${HEX}__../x`)}&dl=${bom}`],
    ];
    for (const [nome, caminho] of cenarios) assert.equal((await fetch(hub.base + caminho)).status, 401, nome);
    assert.equal(painel.pedidos.length, 0);
  } finally {
    await hub.fechar(); await fechar(painel.server);
  }
});

test('arquivo que o painel já apagou (24 h) vira mensagem clara; painel fora do ar vira 503', async () => {
  const painel = await subirPainel({ prefixo: '/chatkit-download' });
  const hub = await subirHub({ dash1: painelDoBanco(painel.port) });
  try {
    const expirado = `${HEX.replace(/./g, 'f')}__Antigo.xlsx`;                              // o painel responde 404 a este
    const link = (await pedirLink(hub.base, 'dono', 'dash1', expirado)).corpo.url!;
    const r = await fetch(hub.base + link);
    assert.equal(r.status, 404);
    assert.match(((await r.json()) as { message: string }).message, /ficam 24 horas/);

    await fechar(painel.server);                                                             // painel cai
    const link2 = (await pedirLink(hub.base, 'dono', 'dash1', ARQUIVO)).corpo.url!;
    const r2 = await fetch(hub.base + link2);
    assert.equal(r2.status, 503);
    assert.match(((await r2.json()) as { message: string }).message, /painel não respondeu/);
  } finally {
    await hub.fechar(); await fechar(painel.server);
  }
});

test('painel que serve em /api/chatkit-download (ex.: BI DRE) também funciona, e o hub lembra o caminho', async () => {
  const painel = await subirPainel({ prefixo: '/api/chatkit-download' });
  const hub = await subirHub({ dash1: painelDoBanco(painel.port) });
  try {
    const link = (await pedirLink(hub.base, 'dono', 'dash1', ARQUIVO)).corpo.url!;
    const r = await fetch(hub.base + link);
    assert.equal(r.status, 200);
    assert.equal(sha(Buffer.from(await r.arrayBuffer())), sha(CONTEUDO));
    assert.deepEqual(painel.pedidos, [`/chatkit-download/${ARQUIVO}`, `/api/chatkit-download/${ARQUIVO}`]);   // tentou o 1º, achou no 2º

    const link2 = (await pedirLink(hub.base, 'dono', 'dash1', ARQUIVO)).corpo.url!;
    assert.equal((await fetch(hub.base + link2)).status, 200);
    assert.equal(painel.pedidos.length, 3);                                                  // 2ª vez foi direto no caminho certo
  } finally {
    await hub.fechar(); await fechar(painel.server);
  }
});

test('painel sem Content-Disposition: o hub põe um com o nome limpo (com acento e espaço)', async () => {
  const painel = await subirPainel({ prefixo: '/chatkit-download', semDisposition: true });
  const hub = await subirHub({ dash1: painelDoBanco(painel.port) });
  try {
    const nome = `${HEX}__Balancete (set) çãõ.xlsx`;
    const link = (await pedirLink(hub.base, 'dono', 'dash1', nome)).corpo.url!;
    const r = await fetch(hub.base + link);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-disposition'), `attachment; filename*=UTF-8''${encodeURIComponent('Balancete (set) çãõ.xlsx')}`);
    assert.match(painel.pedidos[0], /Balancete \(set\) çãõ\.xlsx$/);                         // o nome chegou inteiro ao painel
    await r.arrayBuffer();
  } finally {
    await hub.fechar(); await fechar(painel.server);
  }
});

test('se o cliente desiste no meio do download, o hub para de puxar do painel', async () => {
  const painel = await subirPainel({ prefixo: '/chatkit-download', lento: true });
  const hub = await subirHub({ dash1: painelDoBanco(painel.port) });
  try {
    const link = (await pedirLink(hub.base, 'dono', 'dash1', ARQUIVO)).corpo.url!;
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(hub.base + link, (res) => {
        res.once('data', () => { req.destroy(); resolve(); });                               // leu um pedaço e desistiu
      });
      req.on('error', () => resolve());
      req.on('close', () => resolve());
      req.end();
      setTimeout(() => reject(new Error('o download não começou')), 8000);
    });
    for (let i = 0; i < 40 && !painel.fechouNoMeio; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(painel.fechouNoMeio, true, 'o hub continuou puxando o arquivo do painel depois que o cliente desistiu');
  } finally {
    await hub.fechar(); await fechar(painel.server);
  }
});
