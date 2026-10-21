// Falas do João (balão de dica) quando há um painel ou BI aberto em tela cheia com o chat de IA dele ligado
// (`biScope` em contexts/chat-scope-context.tsx). Nesse modo o chat responde com os dados do painel, então as dicas
// falam do painel, e não do hub.
//
// Painel aberto direto: o hub lê página e filtros da tela e manda junto com a pergunta.
// BI vinculado (Power BI): o hub NÃO enxerga os filtros escolhidos dentro do Power BI — por isso a dica pede
// o período/empresa na própria pergunta em vez de prometer que ele "vê a tela".

export type PanelHintKind = 'painel' | 'BI';

const HINTS_PAINEL = [
  'Dúvidas sobre este painel? Fale comigo, eu consulto os dados dele 👋',
  'Quer entender algum número ou gráfico? Me pergunta que o João explica',
  'Escolha os filtros: eu vejo o que está na tela e respondo em cima disso',
  'Procurando um valor neste painel? É só me perguntar, eu busco pra você',
  'Quer comparar períodos ou ver um ranking? Pergunta pro João 📊',
  'Dúvida sobre o Hub? Feche o painel e fale comigo por lá 😉',
];

const HINTS_BI = [
  'Dúvidas sobre este BI? Fale comigo, eu consulto os dados do painel dele 👋',
  'Quer entender algum número? Me pergunta que o João explica',
  'Não vejo os filtros do Power BI: diga o período ou a empresa na pergunta',
  'Procurando um valor específico? É só me perguntar, eu busco pra você',
  'Quer comparar períodos ou ver um ranking? Pergunta pro João 📊',
  'Dúvida sobre o Hub? Feche o BI e fale comigo por lá 😉',
];

export function panelHintPool(kind: PanelHintKind): string[] {
  return kind === 'BI' ? HINTS_BI : HINTS_PAINEL;
}

/**
 * Escolhe a fala. A primeira (`first`) é sempre a que apresenta o chat do painel; as demais são sorteadas, sem repetir a
 * `previous` (a anterior) quando há outra opção.
 */
export function pickPanelHint(kind: PanelHintKind, options: { first?: boolean; previous?: string | null; random?: () => number } = {}): string {
  const pool = panelHintPool(kind);
  if (options.first) return pool[0];
  const candidates = pool.length > 1 ? pool.filter((message) => message !== options.previous) : pool;
  const random = options.random ?? Math.random;
  return candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))];
}
