// Página do painel em que a pessoa está (ex.: "static/tarefas.html"), guardada na
// URL do hub (?pagina=) para o F5 reabrir na mesma aba interna. O valor vem da URL
// (entrada não confiável) e vira parte de um caminho do próprio hub: só aceita
// caminho relativo simples, sem "..", sem barra dupla e sem sair de /d/<slug>/.
const SAFE_PANEL_PATH = /^[A-Za-z0-9_\-./]+$/;

export function parsePanelPath(value: string | null | undefined): string | null {
  if (!value || value.length > 200) return null;
  if (!SAFE_PANEL_PATH.test(value)) return null;
  if (value.startsWith('/') || value.includes('..') || value.includes('//')) return null;
  return value;
}

// "/d/<slug>/static/tarefas.html" -> "static/tarefas.html" (ou null se estiver fora do painel).
export function panelPathFromLocation(pathname: string, slug: string): string | null {
  const prefix = `/d/${slug}/`;
  if (!pathname.startsWith(prefix)) return null;
  return parsePanelPath(pathname.slice(prefix.length));
}
