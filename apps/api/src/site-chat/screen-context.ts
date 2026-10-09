// Contexto da tela que o navegador manda junto com a pergunta (página + filtros
// selecionados) e que o hub repassa ao /chatkit do painel em "?contexto=".
// Vem do cliente, então é tratado como entrada não confiável: só texto, com
// limites de tamanho. Mesmo formato que o próprio painel manda hoje
// ({ pagina, filtros }, ver coletarContextoTela em theme.js).

export type ScreenContext = { pagina: string; filtros: Record<string, string> };

const MAX_PAGINA = 200;
const MAX_FILTROS = 30;
const MAX_CHAVE = 80;
const MAX_VALOR = 600;
const MAX_JSON = 6000;

function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  // Remove caracteres de controle (inclusive quebras de linha) e corta no limite.
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

export function sanitizeScreenContext(raw: unknown): ScreenContext | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;

  const pagina = clean(input.pagina, MAX_PAGINA) ?? '(desconhecida)';
  const filtros: Record<string, string> = {};

  if (input.filtros && typeof input.filtros === 'object' && !Array.isArray(input.filtros)) {
    for (const [key, value] of Object.entries(input.filtros as Record<string, unknown>)) {
      if (Object.keys(filtros).length >= MAX_FILTROS) break;
      const k = clean(key, MAX_CHAVE);
      const v = clean(value, MAX_VALOR);
      if (k && v) filtros[k] = v;
    }
  }

  const context: ScreenContext = { pagina, filtros };
  return JSON.stringify(context).length <= MAX_JSON ? context : { pagina, filtros: {} };
}
