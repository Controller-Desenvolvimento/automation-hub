import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DashboardService } from '../src/dashboard/dashboard.service';

// Painéis de verdade (um servidor HTTP mínimo em Python) numa porta da faixa dos painéis (8500–8599).
const PORT = 8597;

const SERVER_PY = `
import sys, http.server
port = int(sys.argv[1])
versao = open('versao.txt', encoding='utf-8').read().strip()
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        if self.path.startswith('/com-cache'):
            self.send_header('Cache-Control', 'public, max-age=3600')
        self.send_header('Last-Modified', 'Wed, 07 Oct 2026 20:18:36 GMT')
        self.end_headers(); self.wfile.write(versao.encode())
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
`;

function matar(pid: number | undefined) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch { /* já morreu */ }
}

async function versaoNoar(): Promise<string | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(2000) });
    return (await r.text()).trim();
  } catch {
    return null;
  }
}

async function esperarVersao(esperada: string, ms = 15000) {
  const fim = Date.now() + ms;
  let ultima: string | null = null;
  while (Date.now() < fim) {
    ultima = await versaoNoar();
    if (ultima === esperada) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.fail(`esperava a versão "${esperada}" no ar, mas ficou "${ultima}"`);
}

function criarCenario() {
  const dir = mkdtempSync(join(tmpdir(), 'painel-restart-'));
  writeFileSync(join(dir, 'server.py'), SERVER_PY);
  writeFileSync(join(dir, 'versao.txt'), 'v1');
  const db: Record<string, unknown> = {
    id: 'd1', slug: 'painel-teste', type: 'server', streamlitPort: PORT, streamlitStatus: 'stopped',
    serverCommand: 'python server.py {PORT}', serverWorkingDirectory: dir, mainFile: null,
  };
  const prisma = {
    dashboard: {
      findUniqueOrThrow: async () => ({ ...db }),
      update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(db, data); return { ...db }; },
      findMany: async () => [],
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new DashboardService(prisma as any);
  return { dir, db, svc };
}

test('Reiniciar põe no ar o código NOVO (Parar + Iniciar não garantia isso)', async () => {
  const { dir, db, svc } = criarCenario();
  try {
    await svc.startServer('d1');
    await esperarVersao('v1');

    writeFileSync(join(dir, 'versao.txt'), 'v2');            // "atualização do painel"
    const r = await svc.restart('d1');

    await esperarVersao('v2');
    assert.equal(r.processoAntigoEncerrado, false);          // o parar normal bastou
    assert.equal(db.streamlitStatus, 'running');
    assert.equal(svc.isRunning('d1'), true);
  } finally {
    svc.onModuleDestroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Reiniciar encerra um processo antigo que ficou preso na porta e sobe o novo', async () => {
  const { dir, svc } = criarCenario();
  // processo fora do controle do hub (como um que sobreviveu a um "parar" ou a um reinício do hub)
  const preso = spawn('python', ['server.py', String(PORT)], { cwd: dir, detached: true, stdio: 'ignore', windowsHide: true });
  preso.unref();
  try {
    await esperarVersao('v1');
    writeFileSync(join(dir, 'versao.txt'), 'v2');

    const r = await svc.restart('d1');

    assert.equal(r.processoAntigoEncerrado, true);
    await esperarVersao('v2');                               // sem o fix, o "Iniciar" reaproveitaria o v1
  } finally {
    svc.onModuleDestroy();
    matar(preso.pid);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Reiniciar limpa __pycache__ do projeto, mas não entra em node_modules/venv', async () => {
  const { dir, svc } = criarCenario();
  try {
    mkdirSync(join(dir, '__pycache__'));
    writeFileSync(join(dir, '__pycache__', 'app.cpython-314.pyc'), 'x');
    mkdirSync(join(dir, 'pacote', '__pycache__'), { recursive: true });
    writeFileSync(join(dir, 'pacote', '__pycache__', 'm.pyc'), 'x');
    mkdirSync(join(dir, 'node_modules', 'x', '__pycache__'), { recursive: true });
    mkdirSync(join(dir, 'venv', 'Lib', '__pycache__'), { recursive: true });

    const r = await svc.restart('d1');

    assert.equal(r.pycacheRemovido, 2);
    assert.equal(existsSync(join(dir, '__pycache__')), false);
    assert.equal(existsSync(join(dir, 'pacote', '__pycache__')), false);
    assert.equal(existsSync(join(dir, 'node_modules', 'x', '__pycache__')), true);
    assert.equal(existsSync(join(dir, 'venv', 'Lib', '__pycache__')), true);
  } finally {
    svc.onModuleDestroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a saída tardia de um processo parado de propósito não vira "erro" no banco', async () => {
  const { dir, db, svc } = criarCenario();
  try {
    await svc.startServer('d1');
    await esperarVersao('v1');
    await svc.stopServer('d1');                              // o processo morre com código 1 (taskkill /F)
    assert.equal(db.streamlitStatus, 'stopped');
    await new Promise((r) => setTimeout(r, 1500));           // dá tempo do "exit" chegar
    assert.equal(db.streamlitStatus, 'stopped');             // antes virava "error" ("encerrou com erro" na tela)
    assert.equal(svc.isRunning('d1'), false);

    await svc.restart('d1');                                 // e o reinício depois disso deixa tudo "rodando"
    await esperarVersao('v1');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(db.streamlitStatus, 'running');
    assert.equal(svc.isRunning('d1'), true);
    assert.ok(svc.getProxy('d1'));
  } finally {
    svc.onModuleDestroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('o proxy manda Cache-Control: no-cache quando o painel não manda (e respeita o que o painel manda)', async () => {
  const { dir, svc } = criarCenario();
  const ponte = createServer((req, res) => {
    const proxy = svc.getProxy('d1');
    if (!proxy) { res.writeHead(503); res.end(); return; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (proxy as any)(req, res, () => { res.writeHead(404); res.end(); });
  });
  try {
    await svc.startServer('d1');
    await esperarVersao('v1');
    await new Promise<void>((r) => ponte.listen(0, '127.0.0.1', r));
    const porta = (ponte.address() as AddressInfo).port;

    const semHeader = await fetch(`http://127.0.0.1:${porta}/d/painel-teste/static/theme.js`);
    assert.equal(semHeader.status, 200);
    assert.equal(semHeader.headers.get('cache-control'), 'no-cache');        // antes: nenhum → o navegador "adivinhava" a validade
    assert.equal(semHeader.headers.get('last-modified'), 'Wed, 07 Oct 2026 20:18:36 GMT');   // validadores continuam passando

    const comHeader = await fetch(`http://127.0.0.1:${porta}/d/painel-teste/com-cache.png`);
    assert.equal(comHeader.headers.get('cache-control'), 'public, max-age=3600');  // o do painel prevalece
  } finally {
    ponte.close();
    svc.onModuleDestroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Reiniciar recusa painel sem comando configurado e painel que não é de processo', async () => {
  const { dir, db, svc } = criarCenario();
  try {
    db.serverCommand = null;
    await assert.rejects(() => svc.restart('d1'), /serverCommand/);
    db.serverCommand = 'python server.py {PORT}';
    db.type = 'html';
    await assert.rejects(() => svc.restart('d1'), /processo/);
  } finally {
    svc.onModuleDestroy();
    rmSync(dir, { recursive: true, force: true });
  }
});
