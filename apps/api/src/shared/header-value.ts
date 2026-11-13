/**
 * Valor seguro para cabeçalho HTTP. O Node só aceita no valor: tab, 0x20–0x7e e 0x80–0xff (Latin-1);
 * qualquer outro caractere (ex.: o "�" U+FFFD, ou quebra de linha) faz `setHeader` lançar
 * `ERR_INVALID_CHAR`, e a requisição inteira falha. Os caracteres inválidos viram "?".
 * Acentos do português (ç, ã, ú...) são Latin-1 e passam intactos.
 */
export function headerSafe(value: string): string {
  return value.replace(/[^\t\x20-\x7e\x80-\xff]/g, '?');
}
