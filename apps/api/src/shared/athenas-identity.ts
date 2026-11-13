const ATHENAS_SUFFIX_TO_DEPARTMENTS: Record<string, string[]> = {
  DEFIS: ['fiscal'],
  DECON: ['contabil'],
  DEPES: ['pessoal'],
  DEAUD: ['auditoria'],
  DERH: ['rh'],
  RH: ['rh'],
  INOV: ['inovacao'],
  DELEG: ['legalizacao'],
  DETEC: ['tecnologia'],
  SUPORTE: ['tecnologia'],
};

export function departmentsForAthenasLogin(login: string) {
  const normalized = login.trim().toUpperCase();
  const suffix = normalized.split('.').pop() ?? '';
  return ATHENAS_SUFFIX_TO_DEPARTMENTS[suffix] ?? [];
}

/**
 * Como pedir o NOME ao Athenas. A coluna é VARCHAR com charset NONE e os bytes gravados são, em geral,
 * Windows-1252 de 1 byte (Ú = 0xDA). Pedindo o texto, o driver os lê como UTF-8 e o byte inválido vira
 * "�" (a letra se perde). Pedindo os bytes crus (OCTETS), o driver não interpreta nada e quem decodifica
 * é `decodeAthenasBuffer`. 255 > tamanho da coluna (115); o alias mantém a chave `NOME` na linha.
 */
export const ATHENAS_NAME_SELECT = 'CAST(NOME AS VARCHAR(255) CHARACTER SET OCTETS) AS NOME';

/**
 * Bytes crus do nome → texto. UTF-8 estrito primeiro (há cadastros gravados assim); se não for UTF-8
 * válido, Windows-1252, em que todo byte é uma letra (nunca produz "�").
 */
export function decodeAthenasBuffer(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/**
 * Quando o driver devolve texto já decodificado em vez de Buffer, tenta desfazer o mojibake:
 * bytes UTF-8 lidos como latin1 viram "ARAÃšJO" → "ARAÚJO" (re-codifica cada char como byte latin1 e relê como UTF-8).
 */
export function fixAthenasName(name: string): string {
  if (!name || !name.split('').some((c) => c.charCodeAt(0) > 0x7f)) return name;
  const utf8 = Buffer.from(name, 'latin1').toString('utf8');
  return utf8.includes('�') ? name : utf8;
}

export function readAthenasName(value: unknown): string | undefined {
  return Buffer.isBuffer(value)
    ? decodeAthenasBuffer(value).trim() || undefined
    : fixAthenasName(String(value ?? '')).trim() || undefined;
}

/** O nome chegou com o "�" (U+FFFD): sinal de que o acento se perdeu entre o Athenas e o Hub. */
export function hasBrokenNameChars(name: string | null | undefined): boolean {
  return !!name && name.includes('�');
}

/**
 * Nome a gravar no login (o Athenas é a fonte de verdade, mas só quando o que ele manda é confiável):
 * se o nome que chegou está corrompido e o que já está salvo não está, mantém o salvo. Assim um acento
 * perdido numa leitura não estraga um nome bom, e um reparo manual no banco não é desfeito no login seguinte.
 */
export function chooseSyncedName(current: string | null | undefined, incoming: string): string {
  if (hasBrokenNameChars(incoming) && current && !hasBrokenNameChars(current)) return current;
  return incoming;
}

/**
 * Descreve o valor cru que o driver entregou, sem expor o nome: tipo (Buffer/string) e só os bytes
 * (ou caracteres) fora do ASCII. Serve para descobrir de onde vem o "�".
 */
export function describeRawName(raw: unknown): string {
  if (Buffer.isBuffer(raw)) {
    const bytes = [...raw].filter((b) => b > 0x7f).map((b) => b.toString(16).padStart(2, '0'));
    return `Buffer de ${raw.length} bytes, bytes fora do ASCII: [${bytes.join(' ')}]`;
  }
  const chars = [...String(raw ?? '')]
    .filter((c) => c.charCodeAt(0) > 0x7f)
    .map((c) => 'U+' + (c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0'));
  return `string, caracteres fora do ASCII: [${chars.join(' ')}]`;
}

export function formatAthenasPersonName(name: string) {
  const lowercaseParticles = new Set(['da', 'das', 'de', 'do', 'dos', 'e']);
  return name
    .trim()
    .toLocaleLowerCase('pt-BR')
    .split(/\s+/)
    .map((word, index) =>
      index > 0 && lowercaseParticles.has(word)
        ? word
        : word.charAt(0).toLocaleUpperCase('pt-BR') + word.slice(1),
    )
    .join(' ');
}
