// Leitura leve de markdown para as mensagens do chat do João: negrito (**assim**) e links ([texto](endereço)).
// Devolve "peças" que o componente transforma em elementos React — nunca HTML —, então o texto que vem do modelo ou do
// painel não consegue injetar nada na página.
//
// Links aceitos:
// - http(s)://...                -> link externo (abre em outra aba);
// - /caminho (do próprio hub)    -> link interno;
// - ../chatkit-download/<arquivo> (e variações) -> arquivo gerado pelo chat de IA de um painel (Excel/CSV). O endereço
//   relativo só faz sentido dentro do painel; no chat do hub o frontend pede ao servidor um link de download (ver
//   `downloadPanelFile` em lib/api.ts), por isso aqui vira uma peça própria;
// - qualquer outra coisa (javascript:, data:, caminhos relativos soltos...) -> só o texto do link, sem clique.

export type ChatToken =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'link'; label: string; href: string; external: boolean }
  | { type: 'panel-download'; label: string; file: string };

// "../chatkit-download/<arq>", "./chatkit-download/<arq>", "/chatkit-download/<arq>", "chatkit-download/<arq>" e a variação
// "/api/chatkit-download/<arq>" (painéis que servem o chat em /api/chatkit) e o mesmo caminho já pelo prefixo do hub,
// "/d/<slug>/chatkit-download/<arq>". Query e âncora são ignoradas.
const PANEL_DOWNLOAD_RE = /^(?:\.{1,2}\/)*\/?(?:d\/[^/?#]+\/)?(?:api\/)?chatkit-download\/([^?#]+)(?:[?#].*)?$/i;

/** Nome do arquivo gerado pelo painel se o endereço for um `chatkit-download`; senão null. */
export function panelDownloadFile(href: string): string | null {
  const match = PANEL_DOWNLOAD_RE.exec(href.trim());
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

type ParsedLink = { label: string; url: string; end: number };

// `[texto](url)` começando em `start`. O texto pode ter parênteses ("Baixar Excel (nome.xlsx)") e o endereço também
// ("Balancete (set).xlsx"): o endereço vai até o ')' que fecha, contando os de dentro.
function parseLinkAt(line: string, start: number): ParsedLink | null {
  let close = start + 1;
  for (; close < line.length; close += 1) {
    if (line[close] === '[') return null;
    if (line[close] === ']') break;
  }
  if (close >= line.length || line[close + 1] !== '(') return null;

  let depth = 1;
  let end = close + 2;
  for (; end < line.length; end += 1) {
    if (line[end] === '(') depth += 1;
    else if (line[end] === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return null;

  const label = line.slice(start + 1, close).trim();
  const url = line.slice(close + 2, end).trim();
  return label && url ? { label, url, end: end + 1 } : null;
}

function classify(label: string, url: string): ChatToken {
  const file = panelDownloadFile(url);
  if (file) return { type: 'panel-download', label, file };
  if (/^https?:\/\//i.test(url)) return { type: 'link', label, href: url, external: true };
  if (url.startsWith('/') && !url.startsWith('//')) return { type: 'link', label, href: url, external: false };
  return { type: 'text', text: label };
}

/** Quebra UMA linha de texto em peças (texto, negrito, link). */
export function tokenizeChatLine(line: string): ChatToken[] {
  const tokens: ChatToken[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer) tokens.push({ type: 'text', text: buffer });
    buffer = '';
  };

  let i = 0;
  while (i < line.length) {
    if (line.startsWith('**', i)) {
      const end = line.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        tokens.push({ type: 'bold', text: line.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    if (line[i] === '[') {
      const link = parseLinkAt(line, i);
      if (link) {
        flush();
        tokens.push(classify(link.label, link.url));
        i = link.end;
        continue;
      }
    }
    buffer += line[i];
    i += 1;
  }
  flush();
  return tokens;
}
