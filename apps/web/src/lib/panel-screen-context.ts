// Lê, na página de um painel aberto em iframe (mesma origem do hub), o que a
// pessoa está vendo: título da página e filtros selecionados AGORA. Segue a
// mesma lógica de coletarContextoTela() do theme.js dos painéis (varre os
// campos ".campo-filtro": rótulo no <label>, valor em ".multi-select-btn" ou
// <select>), pra o chat do hub enxergar exatamente o que o chat do painel vê.
//
// Ordem: (1) a função coletarContextoTela() da própria página, quando existe (o painel
// sabe melhor que ninguém o que está selecionado — ex.: BI DRE Contábil, que não usa
// ".campo-filtro"); (2) a leitura por marcação (BI_DEPES e irmãos). Se nenhuma achar
// filtros, devolve filtros vazios — nunca quebra o chat.

export type PanelScreenContext = { pagina: string; filtros: Record<string, string> };

type SelectableButton = Element & {
  _obterSelecionados?: () => string[];
  _obterSelecionado?: () => string;
};

// Normaliza o que a página devolve: valores podem vir como texto, número ou lista.
function normalizePageContext(raw: unknown): PanelScreenContext | null {
  if (!raw || typeof raw !== 'object') return null;
  const { pagina, filtros } = raw as { pagina?: unknown; filtros?: unknown };
  if (!filtros || typeof filtros !== 'object' || Array.isArray(filtros)) return null;
  const out: Record<string, string> = {};
  for (const [chave, valor] of Object.entries(filtros as Record<string, unknown>)) {
    const texto = Array.isArray(valor) ? valor.map(String).join(', ') : valor == null ? '' : String(valor);
    if (texto.trim()) out[chave] = texto.trim();
  }
  return { pagina: typeof pagina === 'string' && pagina.trim() ? pagina.trim() : '(desconhecida)', filtros: out };
}

export function readPanelScreenContext(doc: Document | null | undefined): PanelScreenContext | null {
  if (!doc) return null;
  try {
    const fromPage = (doc.defaultView as (Window & { coletarContextoTela?: () => unknown }) | null)?.coletarContextoTela;
    if (typeof fromPage === 'function') {
      try {
        const ctx = normalizePageContext(fromPage.call(doc.defaultView));
        if (ctx && Object.keys(ctx.filtros).length > 0) return ctx;
      } catch {
        // a função da página falhou: cai na leitura por marcação
      }
    }
    const filtros: Record<string, string> = {};
    doc.querySelectorAll('.campo-filtro').forEach((campo) => {
      const label = campo.querySelector('label');
      const rotulo = label?.textContent?.trim();
      if (!rotulo) return;

      const botao = campo.querySelector('.multi-select-btn') as SelectableButton | null;
      const select = campo.querySelector('select');

      if (botao) {
        // Prefere o estado real da seleção ao texto exibido: o texto de "nada
        // selecionado" pode ser personalizado (ex.: "Mês") e viraria um filtro falso.
        if (typeof botao._obterSelecionados === 'function') {
          const selecionados = botao._obterSelecionados();
          if (selecionados.length > 0) filtros[rotulo] = selecionados.join(', ');
        } else if (typeof botao._obterSelecionado === 'function') {
          const selecionado = botao._obterSelecionado();
          if (selecionado) filtros[rotulo] = selecionado;
        } else {
          const texto = botao.textContent?.trim();
          if (texto) filtros[rotulo] = texto;
        }
      } else if (select) {
        const option = select.options[select.selectedIndex];
        const valor = option ? option.text.trim() : select.value;
        if (valor) filtros[rotulo] = valor;
      }
    });
    return { pagina: doc.title || '(desconhecida)', filtros };
  } catch {
    // Iframe de outra origem ou documento ainda carregando.
    return null;
  }
}
