import assert from 'node:assert/strict';
import test from 'node:test';
// Código do frontend (puro, sem React) testado aqui junto com os testes do hub, que é onde roda `tsx --test`.
import { panelDownloadFile, tokenizeChatLine } from '../../web/src/lib/chat-markdown';

const HEX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

test('o link que os painéis devolvem vira um download do painel (texto do link com parênteses)', () => {
  const t = tokenizeChatLine(`Segue o balancete: [Baixar Excel (balancete.xlsx)](../chatkit-download/${HEX}__balancete.xlsx)`);
  assert.deepEqual(t, [
    { type: 'text', text: 'Segue o balancete: ' },
    { type: 'panel-download', label: 'Baixar Excel (balancete.xlsx)', file: `${HEX}__balancete.xlsx` },
  ]);
});

test('nome do arquivo com parênteses, acento e espaço, e nome codificado na URL', () => {
  assert.deepEqual(tokenizeChatLine(`[Baixar Excel (Balancete (set) çãõ.xlsx)](../chatkit-download/${HEX}__Balancete (set) çãõ.xlsx)`), [
    { type: 'panel-download', label: 'Baixar Excel (Balancete (set) çãõ.xlsx)', file: `${HEX}__Balancete (set) çãõ.xlsx` },
  ]);
  assert.deepEqual(tokenizeChatLine(`[CSV](../chatkit-download/${HEX}__dados%20do%20m%C3%AAs.csv)`), [
    { type: 'panel-download', label: 'CSV', file: `${HEX}__dados do mês.csv` },
  ]);
});

test('variações do endereço do download do painel são reconhecidas; o resto não', () => {
  for (const v of ['../chatkit-download/x', './chatkit-download/x', '/chatkit-download/x', 'chatkit-download/x', '../../chatkit-download/x', '/api/chatkit-download/x', '../chatkit-download/x?v=1#a', '/d/financeiro/chatkit-download/x', '/d/financeiro/api/chatkit-download/x']) {
    assert.equal(panelDownloadFile(v), 'x', v);
  }
  for (const v of ['https://x.com/chatkit-download/x', '../outra/coisa/x', '../chatkit-download/', 'chatkit-download', '../chatkit-downloads/x']) {
    assert.equal(panelDownloadFile(v), null, v);
  }
});

test('links comuns: externo abre fora, interno é do hub', () => {
  const t = tokenizeChatLine('Veja [o site](https://exemplo.com/pagina?a=1) e [robôs](/robots).');
  assert.deepEqual(t.map((x) => x.type), ['text', 'link', 'text', 'link', 'text']);
  assert.deepEqual(t[1], { type: 'link', label: 'o site', href: 'https://exemplo.com/pagina?a=1', external: true });
  assert.deepEqual(t[3], { type: 'link', label: 'robôs', href: '/robots', external: false });
});

test('segurança: javascript:, data:, // e caminhos relativos soltos viram só texto, sem clique', () => {
  for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>', 'vbscript:x', '//evil.com/x', '../etc/passwd', 'ftp://x', 'file:///c:/x']) {
    assert.deepEqual(tokenizeChatLine(`[clique](${url})`), [{ type: 'text', text: 'clique' }], url);
  }
});

test('negrito junto com link, e texto quebrado ou sem markdown não explode', () => {
  assert.deepEqual(tokenizeChatLine('Total: **R$ 1.234,56** em [link](https://a.com)').map((x) => x.type), ['text', 'bold', 'text', 'link']);
  for (const quebrado of ['[sem fecha](https://a.com', '[sem url]()', '[](https://a.com)', '**negrito aberto', 'texto com [colchetes] e (parênteses)', '']) {
    const r = tokenizeChatLine(quebrado);
    assert.ok(r.every((x) => x.type !== 'panel-download' && x.type !== 'link'), quebrado);
  }
  // colchete aberto antes de um link válido: o '[a ' fica como texto e o '[b](...)' é um link
  assert.deepEqual(tokenizeChatLine('[a [b](https://c.com)'), [
    { type: 'text', text: '[a ' },
    { type: 'link', label: 'b', href: 'https://c.com', external: true },
  ]);
  assert.deepEqual(tokenizeChatLine('Olá, tudo bem? 100% (ok)'), [{ type: 'text', text: 'Olá, tudo bem? 100% (ok)' }]);
});
