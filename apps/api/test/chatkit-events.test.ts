import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROGRESS_QUERYING,
  SseJsonParser,
  applyChatKitEvent,
  finalText,
  newTurn,
  type ChatKitEvent,
} from '../src/site-chat/chatkit-events';

// Formatos copiados de respostas reais do /chatkit do painel BI_DEPES (2026-10-08).
const ITEM_ID = 'msg_0f8a8f03efe2fc10006ac7cd3c8aa487d29c6386feb3875506';
const FINAL = 'Posso analisar dados de colaboradores, clientes e tarefas.';

const realConversation: ChatKitEvent[] = [
  { type: 'thread.created', thread: { id: 'thr_42149cf5', status: { type: 'active' }, items: { data: [], has_more: false } } },
  { type: 'thread.item.done', item: { id: 'msg_3e4fb86f', type: 'user_message', content: [{ type: 'input_text', text: 'Olá!' }] } },
  { type: 'stream_options', stream_options: { allow_cancel: true } },
  { type: 'thread.item.added', item: { id: 'wf_e16ecff8', type: 'workflow', workflow: { type: 'reasoning', tasks: [], expanded: false } } },
  { type: 'progress_update', text: 'Analisando os dados...' },
  { type: 'thread.item.done', item: { id: 'wf_e16ecff8', type: 'workflow', workflow: { type: 'reasoning', tasks: [], summary: { duration: 47 } } } },
  { type: 'thread.item.added', item: { id: ITEM_ID, type: 'assistant_message', content: [] } },
  { type: 'thread.item.updated', item_id: ITEM_ID, update: { type: 'assistant_message.content_part.added', content_index: 0, content: { text: '', type: 'output_text' } } },
  { type: 'thread.item.updated', item_id: ITEM_ID, update: { type: 'assistant_message.content_part.text_delta', content_index: 0, delta: 'Posso analisar ' } },
  { type: 'thread.item.updated', item_id: ITEM_ID, update: { type: 'assistant_message.content_part.text_delta', content_index: 0, delta: 'dados de colaboradores, clientes e tarefas.' } },
  { type: 'thread.item.updated', item_id: ITEM_ID, update: { type: 'assistant_message.content_part.done', content_index: 0, content: { text: FINAL, type: 'output_text' } } },
  { type: 'thread.item.done', item: { id: ITEM_ID, type: 'assistant_message', content: [{ annotations: [], text: FINAL, type: 'output_text' }] } },
];

function run(events: ChatKitEvent[]) {
  const turn = newTurn();
  const deltas: string[] = [];
  const progress: string[] = [];
  for (const event of events) {
    const effect = applyChatKitEvent(turn, event);
    if (effect.delta !== undefined) deltas.push(effect.delta);
    if (effect.progress !== undefined) progress.push(effect.progress);
  }
  return { turn, deltas, progress };
}

test('conversa real: guarda o id da thread, repassa texto e progresso e monta o texto final', () => {
  const { turn, deltas, progress } = run(realConversation);
  assert.equal(turn.threadId, 'thr_42149cf5');
  assert.deepEqual(deltas, ['Posso analisar ', 'dados de colaboradores, clientes e tarefas.']);
  assert.deepEqual(progress, [PROGRESS_QUERYING, 'Analisando os dados...']);
  assert.equal(finalText(turn), FINAL);
  assert.equal(turn.error, undefined);
});

test('o texto consolidado do servidor prevalece sobre a soma dos trechos', () => {
  const events: ChatKitEvent[] = [
    { type: 'thread.item.added', item: { id: 'a', type: 'assistant_message', content: [] } },
    { type: 'thread.item.updated', update: { type: 'assistant_message.content_part.text_delta', delta: 'incompleto' } },
    { type: 'thread.item.done', item: { id: 'a', type: 'assistant_message', content: [{ text: 'Texto completo e correto.' }] } },
  ];
  assert.equal(finalText(run(events).turn), 'Texto completo e correto.');
});

test('só o done, sem trechos (resposta que veio de uma vez)', () => {
  const events: ChatKitEvent[] = [{ type: 'thread.item.done', item: { id: 'a', type: 'assistant_message', content: [{ text: 'Resposta única.' }] } }];
  assert.equal(finalText(run(events).turn), 'Resposta única.');
});

test('duas mensagens do assistente no mesmo turno são separadas por linha em branco', () => {
  const events: ChatKitEvent[] = [
    { type: 'thread.item.added', item: { id: 'a', type: 'assistant_message', content: [] } },
    { type: 'thread.item.updated', update: { type: 'assistant_message.content_part.text_delta', delta: 'Primeira.' } },
    { type: 'thread.item.done', item: { id: 'a', type: 'assistant_message', content: [{ text: 'Primeira.' }] } },
    { type: 'thread.item.added', item: { id: 'b', type: 'assistant_message', content: [] } },
    { type: 'thread.item.updated', update: { type: 'assistant_message.content_part.text_delta', delta: 'Segunda.' } },
    { type: 'thread.item.done', item: { id: 'b', type: 'assistant_message', content: [{ text: 'Segunda.' }] } },
  ];
  const { turn, deltas } = run(events);
  assert.deepEqual(deltas, ['Primeira.', '\n\n', 'Segunda.']);
  assert.equal(finalText(turn), 'Primeira.\n\nSegunda.');
});

test('workflow depois que o texto já começou não volta a mostrar "Consultando"', () => {
  const events: ChatKitEvent[] = [
    { type: 'thread.item.added', item: { id: 'a', type: 'assistant_message', content: [] } },
    { type: 'thread.item.updated', update: { type: 'assistant_message.content_part.text_delta', delta: 'Oi' } },
    { type: 'thread.item.added', item: { id: 'w', type: 'workflow', workflow: { type: 'reasoning', tasks: [] } } },
  ];
  assert.deepEqual(run(events).progress, []);
});

test('evento de erro é registrado', () => {
  const { turn } = run([{ type: 'error', code: 'stream.error', message: 'Falha no modelo', allow_retry: true }]);
  assert.equal(turn.error, 'Falha no modelo');
  const sem = run([{ type: 'error', code: 'stream.error' }]);
  assert.equal(sem.turn.error, 'stream.error');
});

test('eventos desconhecidos ou malformados são ignorados sem quebrar', () => {
  const { turn, deltas } = run([
    { type: 'stream_options' },
    { type: 'thread.item.updated', update: null },
    { type: 'thread.item.added', item: null },
    { type: 'progress_update', text: '   ' },
    { type: 'thread.item.updated', update: { type: 'assistant_message.content_part.text_delta', delta: 123 } },
    {},
  ]);
  assert.deepEqual(deltas, []);
  assert.equal(finalText(turn), '');
});

test('SseJsonParser junta blocos cortados em qualquer posição', () => {
  const sse = realConversation.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  for (const size of [1, 7, 64, 500]) {
    const parser = new SseJsonParser();
    const out: ChatKitEvent[] = [];
    for (let i = 0; i < sse.length; i += size) out.push(...parser.push(sse.slice(i, i + size)));
    out.push(...parser.flush());
    assert.equal(out.length, realConversation.length, `tamanho de pedaço ${size}`);
    assert.deepEqual(out, realConversation);
  }
});

test('SseJsonParser aceita CRLF, ignora linhas que não são data e JSON inválido', () => {
  const parser = new SseJsonParser();
  const out = parser.push(': keepalive\r\n\r\nevent: x\r\ndata: {"type":"progress_update","text":"ok"}\r\n\r\ndata: {quebrado\n\n');
  assert.deepEqual(out, [{ type: 'progress_update', text: 'ok' }]);
});

test('SseJsonParser.flush recupera o último bloco sem linha em branco final', () => {
  const parser = new SseJsonParser();
  assert.deepEqual(parser.push('data: {"type":"thread.created","thread":{"id":"t1"}}'), []);
  assert.deepEqual(parser.flush(), [{ type: 'thread.created', thread: { id: 't1' } }]);
});
