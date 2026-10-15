import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { HttpException } from '@nestjs/common';
import { BiChatBridgeService, type BiLink } from '../src/site-chat/bi-chat-bridge.service';

// Painel falso: cada rota responde com o status combinado; as que dão 200 devolvem um ChatKit mínimo.
function sse(text: string) {
  const id = 'msg_1';
  const events = [
    { type: 'thread.created', thread: { id: 'thr_1', status: { type: 'active' }, items: { data: [], has_more: false } } },
    { type: 'thread.item.added', item: { id, type: 'assistant_message', content: [] } },
    { type: 'thread.item.updated', item_id: id, update: { type: 'assistant_message.content_part.text_delta', content_index: 0, delta: text } },
    { type: 'thread.item.done', item: { id, type: 'assistant_message', content: [{ annotations: [], text, type: 'output_text' }] } },
  ];
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

async function fakePanel(routes: Record<string, number>, hits: string[]) {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    hits.push(`${req.method} ${path}`);
    req.resume();
    req.on('end', () => {
      const status = routes[path] ?? 404;
      if (status !== 200) {
        res.statusCode = status;
        res.end('nao');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(sse('resposta do painel'));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const link: BiLink = { siteId: null, siteName: 'Painel', dashboardId: `d${port}`, dashboardSlug: `p${port}`, dashboardName: 'Painel', port };
  return { server, link, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const user = { id: 'u1' } as never;
const ask = (bridge: BiChatBridgeService, link: BiLink) => bridge.ask({ user, link, question: 'oi', onDelta: () => undefined });

test('painel que serve o chat em /chatkit continua funcionando', async () => {
  const hits: string[] = [];
  const panel = await fakePanel({ '/chatkit': 200 }, hits);
  try {
    assert.equal(await ask(new BiChatBridgeService({} as never), panel.link), 'resposta do painel');
    assert.deepEqual(hits, ['POST /chatkit']);
  } finally {
    await panel.close();
  }
});

test('painel que serve em /api/chatkit (BI DRE Contábil): tenta o segundo caminho e lembra qual funcionou', async () => {
  const hits: string[] = [];
  const panel = await fakePanel({ '/chatkit': 405, '/api/chatkit': 200 }, hits);
  try {
    const bridge = new BiChatBridgeService({} as never);
    assert.equal(await ask(bridge, panel.link), 'resposta do painel');
    assert.deepEqual(hits, ['POST /chatkit', 'POST /api/chatkit']);
    // segunda pergunta: vai direto no caminho que funcionou (nada de 405 de novo)
    hits.length = 0;
    assert.equal(await ask(bridge, panel.link), 'resposta do painel');
    assert.deepEqual(hits, ['POST /api/chatkit']);
  } finally {
    await panel.close();
  }
});

test('painel sem chat nenhum: mensagem clara em vez de "não conseguiu responder"', async () => {
  const hits: string[] = [];
  const panel = await fakePanel({ '/chatkit': 405 }, hits);
  try {
    await assert.rejects(
      () => ask(new BiChatBridgeService({} as never), panel.link),
      (error: unknown) => {
        assert.ok(error instanceof HttpException);
        assert.match(String(error.message), /ainda não tem o chat de IA/);
        return true;
      },
    );
    assert.deepEqual(hits, ['POST /chatkit', 'POST /api/chatkit']);
  } finally {
    await panel.close();
  }
});

test('erro de verdade do painel (500) não vira "sem chat" nem tenta outro caminho', async () => {
  const hits: string[] = [];
  const panel = await fakePanel({ '/chatkit': 500 }, hits);
  try {
    await assert.rejects(
      () => ask(new BiChatBridgeService({} as never), panel.link),
      (error: unknown) => error instanceof HttpException && /não conseguiu responder/.test(String(error.message)),
    );
    assert.deepEqual(hits, ['POST /chatkit']);
  } finally {
    await panel.close();
  }
});
