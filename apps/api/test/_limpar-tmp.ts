import { rmSync } from 'node:fs';

// Apaga uma pasta temporária de teste. No Windows um antivírus/indexador pode segurar um arquivo recém-criado por alguns
// instantes e o rmSync falha com EPERM/EBUSY: tenta de novo e, se ainda assim não der, deixa a pasta para o sistema
// limpar. Limpeza que falha NÃO pode reprovar o teste (o executor marcaria o arquivo inteiro como falho).
export function limparTmp(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } catch {
    /* pasta temporária fica para trás; inofensivo */
  }
}
