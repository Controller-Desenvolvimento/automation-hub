import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { join } from 'node:path';
import test from 'node:test';
import { UserRole } from '@prisma/client';
import { createProxyMiddleware } from 'http-proxy-middleware';
import {
  authorizeUpgrade,
  createUpgradeHandler,
  isPanelWsAuthEnabled,
  parseUpgradeRequest,
  type UpgradeDashboard,
  type UpgradeUser,
} from '../src/dashboard/ws-access';

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

const USERS: Record<string, UpgradeUser> = {
  [hash('tok-ana')]: { id: 'ana', role: UserRole.employee, departments: ['comercial'], isActive: true },
  [hash('tok-zeca')]: { id: 'zeca', role: UserRole.employee, departments: ['fiscal'], isActive: true },
  [hash('tok-inativo')]: { id: 'in', role: UserRole.employee, departments: ['comercial'], isActive: false },
  [hash('tok-admin')]: { id: 'adm', role: UserRole.admin, departments: [], isActive: true },
};
const PAINEL: UpgradeDashboard = { id: 'p1', isActive: true, allowedDepartments: [], allowedUserIds: ['ana'], minRole: UserRole.employee };

function deps(over: { dashboard?: UpgradeDashboard | null; proxy?: unknown } = {}) {
  const log: string[] = [];
  return {
    log,
    findSession: async (h: string) => (USERS[h] ? { user: USERS[h] } : null),
    findDashboardBySlug: async (slug: string) => (slug === 'painel' ? (over.dashboard === undefined ? PAINEL : over.dashboard) : null),
    getProxy: () => over.proxy as never,
    logFn: (m: string) => log.push(m),
  };
}
const req = (url: string, cookie?: string) => ({ url, headers: cookie ? { cookie } : {} }) as Pick<http.IncomingMessage, 'url' | 'headers'>;

test('parseUpgradeRequest: slug, cookie dauth e ?t= (o ?t= tem precedência, como no guarda HTTP)', () => {
  assert.deepEqual(parseUpgradeRequest(req('/d/painel/_stcore/stream', 'a=1; dauth=tok-ana; b=2')), { slug: 'painel', token: 'tok-ana' });
  assert.deepEqual(parseUpgradeRequest(req('/d/painel/x?t=tok-zeca', 'dauth=tok-ana')), { slug: 'painel', token: 'tok-zeca' });
  assert.deepEqual(parseUpgradeRequest(req('/d/painel')), { slug: 'painel', token: null });
  assert.equal(parseUpgradeRequest(req('/outra/coisa', 'dauth=x')), null);
  assert.deepEqual(parseUpgradeRequest(req('/d/painel/x', 'dauth=%E0%A4%A')), { slug: 'painel', token: null }); // cookie malformado não derruba
});

test('authorizeUpgrade: sem sessão, sessão inválida/inativa, painel inexistente, sem acesso e com acesso', async () => {
  const d = deps();
  assert.deepEqual(await authorizeUpgrade(req('/d/painel/ws'), d), { ok: false, status: 401, reason: 'sem sessão', slug: 'painel' });
  assert.equal((await authorizeUpgrade(req('/d/painel/ws', 'dauth=lixo'), d)).ok, false);
  assert.equal((await authorizeUpgrade(req('/d/painel/ws', 'dauth=lixo'), d) as { status: number }).status, 401);
  assert.equal((await authorizeUpgrade(req('/d/painel/ws', 'dauth=tok-inativo'), d) as { status: number }).status, 401);
  assert.equal((await authorizeUpgrade(req('/d/naoexiste/ws', 'dauth=tok-ana'), d) as { status: number }).status, 404);
  assert.equal((await authorizeUpgrade(req('/d/painel/ws', 'dauth=tok-ana'), deps({ dashboard: { ...PAINEL, isActive: false } })) as { status: number }).status, 404);
  assert.equal((await authorizeUpgrade(req('/d/painel/ws', 'dauth=tok-zeca'), d) as { status: number }).status, 403); // logado, mas fora da lista
  assert.equal((await authorizeUpgrade(req('/d/painel/ws', 'dauth=tok-ana'), d)).ok, true);
  assert.equal((await authorizeUpgrade(req('/d/painel/ws', 'dauth=tok-admin'), d)).ok, true);
  assert.equal((await authorizeUpgrade(req('/d/painel/ws?t=tok-ana'), d)).ok, true);
});

test('PANEL_WS_AUTH: ligado por padrão; só "false" desliga', () => {
  assert.equal(isPanelWsAuthEnabled({}), true);
  assert.equal(isPanelWsAuthEnabled({ PANEL_WS_AUTH: 'true' }), true);
  assert.equal(isPanelWsAuthEnabled({ PANEL_WS_AUTH: '' }), true);
  assert.equal(isPanelWsAuthEnabled({ PANEL_WS_AUTH: ' FALSE ' }), false);
});

// ---- Com sockets de verdade: painel que aceita "upgrade" e devolve o que recebe, atrás do mesmo tipo de proxy do Hub ----
type Resultado = { status: number } | { upgraded: true; eco: string };

async function montar(authEnabled: boolean) {
  // Conexões "upgradadas" saem do controle do http.Server (closeAllConnections não as fecha): guardo todas para fechar no fim.
  const sockets = new Set<Duplex>();
  const painel = http.createServer();
  painel.on('connection', (s) => sockets.add(s));
  painel.on('upgrade', (_req, socket: Duplex) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: x\r\n\r\n');
    socket.on('data', (d) => socket.write(d));
    socket.on('error', () => undefined);
  });
  await new Promise<void>((r) => painel.listen(0, '127.0.0.1', r));
  const portaPainel = (painel.address() as { port: number }).port;

  const proxy = createProxyMiddleware({ target: `http://127.0.0.1:${portaPainel}`, ws: true, pathRewrite: { '^/d/painel': '' } });
  const d = deps({ proxy });
  const front = http.createServer();
  front.on('connection', (s) => sockets.add(s));
  front.on('upgrade', createUpgradeHandler({ ...d, log: d.logFn }, { authEnabled: () => authEnabled }));
  await new Promise<void>((r) => front.listen(0, '127.0.0.1', r));
  const porta = (front.address() as { port: number }).port;

  const conectar = (cookie?: string, path = '/d/painel/_stcore/stream'): Promise<Resultado> =>
    new Promise((resolve, reject) => {
      const r = http.request({
        host: '127.0.0.1', port: porta, path,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...(cookie ? { Cookie: cookie } : {}) },
      });
      r.on('upgrade', (_res, socket) => {
        socket.on('data', (b) => { socket.destroy(); resolve({ upgraded: true, eco: b.toString() }); });
        socket.write('ola-painel');
      });
      r.on('response', (res) => { res.resume(); resolve({ status: res.statusCode ?? 0 }); });
      r.on('error', reject);
      r.end();
    });

  const fechar = () => {
    for (const s of sockets) s.destroy();
    front.closeAllConnections();
    painel.closeAllConnections();
    front.close();
    painel.close();
  };
  return { conectar, fechar, log: d.log };
}

test('websocket de verdade atrás do proxy: sem login e sem acesso são recusados; com acesso conecta e troca dados', async () => {
  const { conectar, fechar, log } = await montar(true);
  try {
    assert.deepEqual(await conectar(), { status: 401 }); // sem cookie
    assert.deepEqual(await conectar('dauth=lixo'), { status: 401 }); // sessão inexistente
    assert.deepEqual(await conectar('dauth=tok-zeca'), { status: 403 }); // logado, sem acesso ao painel
    assert.deepEqual(await conectar('dauth=tok-inativo'), { status: 401 });
    assert.deepEqual(await conectar('dauth=tok-ana', '/d/naoexiste/ws'), { status: 404 });
    assert.deepEqual(await conectar('dauth=tok-ana'), { upgraded: true, eco: 'ola-painel' }); // com acesso: funciona de ponta a ponta
    assert.deepEqual(await conectar('dauth=tok-admin'), { upgraded: true, eco: 'ola-painel' });
    assert.ok(log.some((l) => l.includes('usuário sem acesso ao painel')), 'a recusa fica registrada no log');
    assert.ok(!log.join('\n').includes('tok-'), 'o log nunca contém o token');
  } finally {
    fechar();
  }
});

test('com PANEL_WS_AUTH=false o comportamento antigo volta (sem checagem de sessão)', async () => {
  const { conectar, fechar } = await montar(false);
  try {
    assert.deepEqual(await conectar(), { upgraded: true, eco: 'ola-painel' });
  } finally {
    fechar();
  }
});

test('trava: o serviço dos painéis passa pelo tratador com checagem e o main.ts continua ligando o evento "upgrade"', () => {
  const servico = readFileSync(join(__dirname, '..', 'src', 'dashboard', 'dashboard.service.ts'), 'utf8');
  assert.match(servico, /createUpgradeHandler\(/);
  assert.ok(!/\.upgrade\?\.\(req, socket, head\)/.test(servico), 'não pode chamar proxy.upgrade direto, sem checar a sessão');
  const main = readFileSync(join(__dirname, '..', 'src', 'main.ts'), 'utf8');
  assert.match(main, /httpServer\.on\('upgrade'[\s\S]*dashboardService\.handleUpgrade/);
});
