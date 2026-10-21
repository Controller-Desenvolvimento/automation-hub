import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Link curto e assinado para baixar UM arquivo de /storage.
//
// Por quê: /storage exige o cabeçalho Authorization, que um link comum do navegador não manda. O frontend então
// baixava o arquivo com fetch() + blob, o que carrega o arquivo INTEIRO na memória do navegador antes de salvar:
// em arquivos grandes (entradas de até ~700 MB) a tela parecia parada por minutos e o download podia ser cancelado.
// Com o link assinado o navegador baixa direto para o disco, com a barra de progresso dele.
//
// Segurança: o link vale para um único caminho e para o usuário que o pediu (a autorização `canAccessStoragePath` é
// conferida quando o link é emitido), expira em 1 minuto e é assinado com um segredo que só existe na memória do
// servidor (reiniciar o hub invalida os links em aberto, o que é aceitável para 1 minuto de validade).

const SECRET = randomBytes(32);
export const STORAGE_LINK_TTL_MS = 60_000;

function base64url(buffer: Buffer) {
  return buffer.toString('base64url');
}

function sign(payloadB64: string) {
  return base64url(createHmac('sha256', SECRET).update(payloadB64).digest());
}

/** `path` = caminho decodificado dentro de /storage, ex.: "/executions/<id>/output/output.zip". */
export function createStorageLinkToken(path: string, userId: string, now = Date.now()): string {
  const payload = base64url(Buffer.from(JSON.stringify({ p: path, u: userId, e: now + STORAGE_LINK_TTL_MS })));
  return `${payload}.${sign(payload)}`;
}

/** true só se a assinatura confere, o link não expirou e foi emitido para exatamente este caminho. */
export function verifyStorageLinkToken(token: unknown, path: string, now = Date.now()): boolean {
  if (typeof token !== 'string') return false;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return false;

  const expected = Buffer.from(sign(payload));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return false;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { p?: unknown; e?: unknown };
    return data.p === path && typeof data.e === 'number' && data.e > now;
  } catch {
    return false;
  }
}
