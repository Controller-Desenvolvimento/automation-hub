// Cada conversa do chat tem um "escopo": o chat do hub ("hub") ou a conversa
// com o chat de IA de um painel/BI ("dash:<id do painel>"). Histórico, limpar
// conversa e o contexto enviado ao modelo do hub são separados por escopo.
export const HUB_SCOPE = 'hub';

export function dashboardScope(dashboardId: string): string {
  return `dash:${dashboardId}`;
}

// Valor vindo do cliente: qualquer coisa fora do formato cai no chat do hub.
export function parseScope(raw: unknown): string {
  return typeof raw === 'string' && /^dash:[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : HUB_SCOPE;
}

export function dashboardIdFromScope(scope: string): string | null {
  return scope.startsWith('dash:') ? scope.slice('dash:'.length) : null;
}
