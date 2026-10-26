import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DashboardService } from '../src/dashboard/dashboard.service';
import { TRACING_ENV, panelProcessEnv } from '../src/shared/panel-env';

test('rastreamento da OpenAI: desligado por padrão, ligado só se o painel pedir', () => {
  assert.equal(panelProcessEnv(false, { PATH: 'x' })[TRACING_ENV], '1');
  assert.equal(panelProcessEnv(undefined, { PATH: 'x' })[TRACING_ENV], '1');
  assert.equal(panelProcessEnv(null, { PATH: 'x' })[TRACING_ENV], '1');
  assert.equal(TRACING_ENV in panelProcessEnv(true, { PATH: 'x' }), false);
  // o resto do ambiente do hub segue igual, e o objeto original não é alterado
  const hub = { PATH: 'x', FOO: 'bar', [TRACING_ENV]: '0' };
  const painel = panelProcessEnv(false, hub);
  assert.equal(painel.FOO, 'bar');
  assert.equal(painel[TRACING_ENV], '1');
  assert.equal(hub[TRACING_ENV], '0');
  // se o hub tem a variável definida (qualquer maiúscula/minúscula) e o painel pede o rastreamento, ela é retirada
  assert.equal(Object.keys(panelProcessEnv(true, { [TRACING_ENV.toLowerCase()]: '1' })).length, 0);
});

// Painel de verdade (Python) que devolve o valor da variável que recebeu, na faixa dos painéis (8500–8599).
const PORT = 8596;
const SERVER_PY = `
import os, sys, http.server
port = int(sys.argv[1])
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers()
        self.wfile.write(os.environ.get('${TRACING_ENV}', 'ausente').encode())
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

async function valorNoPainel(ms = 15000): Promise<string> {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(2000) });
      return (await r.text()).trim();
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  assert.fail('o painel de teste não subiu');
}

test('o painel iniciado pelo hub recebe a variável (desligado) ou não (ligado), mesmo que o hub a tenha definida', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'painel-env-'));
  writeFileSync(join(dir, 'server.py'), SERVER_PY);
  const db: Record<string, unknown> = {
    id: 'd1', slug: 'painel-env', type: 'server', streamlitPort: PORT, streamlitStatus: 'stopped',
    serverCommand: 'python server.py {PORT}', serverWorkingDirectory: dir, mainFile: null, aiTracing: false,
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
  const antes = process.env[TRACING_ENV];
  process.env[TRACING_ENV] = '0';                      // o hub tem a variável "ligando" o rastreamento; o padrão do painel tem de prevalecer
  try {
    await svc.startServer('d1');
    assert.equal(await valorNoPainel(), '1', 'padrão: rastreamento desligado');

    db.aiTracing = true;                               // o admin liga a opção e reinicia o painel
    await svc.restart('d1');
    // espera o painel NOVO responder (o antigo pode ainda estar respondendo por instantes)
    const fim = Date.now() + 15000;
    let atual = '';
    while (Date.now() < fim) {
      atual = await valorNoPainel();
      if (atual === 'ausente') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(atual, 'ausente', 'opção ligada: a variável não chega ao painel (vale o padrão do SDK, que envia)');
  } finally {
    if (antes === undefined) delete process.env[TRACING_ENV]; else process.env[TRACING_ENV] = antes;
    svc.onModuleDestroy();
    matar((svc as unknown as { processes: Map<string, { pid?: number }> }).processes.get('d1')?.pid);
    rmSync(dir, { recursive: true, force: true });
  }
});
