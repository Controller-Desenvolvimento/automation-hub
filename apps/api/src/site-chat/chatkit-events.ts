// Tradução dos eventos SSE do ChatKit (usado pelos painéis/BIs do hub, POST
// /chatkit) para o que o chat do hub precisa: trechos de texto, "progresso" e o
// texto final. Sem rede nem Nest de propósito — formatos conferidos com a
// resposta real de um painel (ver test/chatkit-events.test.ts).

export type ChatKitEvent = Record<string, unknown>;

export type ChatKitTurn = {
  threadId?: string;
  // Texto de cada mensagem do assistente, na ordem em que apareceram.
  messages: string[];
  error?: string;
};

export type ChatKitEffect = { delta?: string; progress?: string };

export const PROGRESS_QUERYING = 'Consultando os dados...';

export function newTurn(): ChatKitTurn {
  return { messages: [] };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const record = asRecord(part);
      return record && typeof record.text === 'string' ? record.text : '';
    })
    .join('');
}

// Atualiza o estado do turno e devolve o que deve ser repassado ao usuário
// agora (texto novo e/ou texto de progresso).
export function applyChatKitEvent(turn: ChatKitTurn, event: ChatKitEvent): ChatKitEffect {
  const type = event.type;

  if (type === 'thread.created') {
    const thread = asRecord(event.thread);
    if (thread && typeof thread.id === 'string') turn.threadId = thread.id;
    return {};
  }

  if (type === 'progress_update') {
    return typeof event.text === 'string' && event.text.trim() ? { progress: event.text.trim() } : {};
  }

  if (type === 'error') {
    const message = typeof event.message === 'string' && event.message.trim() ? event.message.trim() : null;
    turn.error = message ?? (typeof event.code === 'string' ? event.code : 'erro');
    return {};
  }

  const item = asRecord(event.item);

  if (type === 'thread.item.added' && item) {
    if (item.type === 'workflow' && turn.messages.length === 0) {
      return { progress: PROGRESS_QUERYING };
    }
    if (item.type === 'assistant_message') {
      // Nova mensagem do assistente no mesmo turno: separa da anterior.
      const hadText = turn.messages.some((m) => m.length > 0);
      turn.messages.push('');
      return hadText ? { delta: '\n\n' } : {};
    }
    return {};
  }

  if (type === 'thread.item.updated') {
    const update = asRecord(event.update);
    if (update && update.type === 'assistant_message.content_part.text_delta' && typeof update.delta === 'string') {
      if (turn.messages.length === 0) turn.messages.push('');
      turn.messages[turn.messages.length - 1] += update.delta;
      return { delta: update.delta };
    }
    return {};
  }

  if (type === 'thread.item.done' && item && item.type === 'assistant_message') {
    // O texto consolidado do servidor vale mais que a soma dos trechos.
    const full = contentText(item.content);
    if (turn.messages.length === 0) turn.messages.push(full);
    else turn.messages[turn.messages.length - 1] = full || turn.messages[turn.messages.length - 1];
    return {};
  }

  return {};
}

export function finalText(turn: ChatKitTurn): string {
  return turn.messages
    .map((m) => m.trim())
    .filter((m) => m.length > 0)
    .join('\n\n');
}

// Leitor incremental de SSE: recebe pedaços de bytes/texto em qualquer corte e
// devolve os objetos JSON dos blocos "data:" já completos.
export class SseJsonParser {
  private buffer = '';

  push(chunk: string): ChatKitEvent[] {
    this.buffer += chunk.replace(/\r\n/g, '\n');
    const blocks = this.buffer.split('\n\n');
    this.buffer = blocks.pop() ?? '';
    return blocks.flatMap((block) => parseBlock(block));
  }

  flush(): ChatKitEvent[] {
    const rest = this.buffer;
    this.buffer = '';
    return rest.trim() ? parseBlock(rest) : [];
  }
}

function parseBlock(block: string): ChatKitEvent[] {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data) return [];
  try {
    const parsed = JSON.parse(data) as unknown;
    return asRecord(parsed) ? [parsed as ChatKitEvent] : [];
  } catch {
    return [];
  }
}
