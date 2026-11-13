import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Dashboard, User } from '@prisma/client';
import { canAccessDashboard } from '../shared/access';

/**
 * Conexões websocket dos painéis (ex.: Streamlit, que trafega os dados por ali) chegam pelo evento "upgrade" do
 * servidor, e o guarda HTTP de `/d/<painel>/` (main.ts) NÃO roda para elas. Este módulo aplica a elas a mesma
 * regra: sessão válida (cookie `dauth` ou `?t=`) e `canAccessDashboard`.
 *
 * Desligar (voltar ao comportamento antigo, sem checagem): `PANEL_WS_AUTH=false` no `.env` + reiniciar o Hub.
 */

export type UpgradeUser = Pick<User, 'id' | 'role' | 'departments' | 'isActive'>;
export type UpgradeDashboard = Pick<Dashboard, 'id' | 'isActive' | 'allowedDepartments' | 'minRole' | 'allowedUserIds'>;
type UpgradeProxy = { upgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void };

export interface UpgradeDeps {
  findSession(tokenHash: string): Promise<{ user: UpgradeUser } | null>;
  findDashboardBySlug(slug: string): Promise<UpgradeDashboard | null>;
  getProxy(dashboardId: string): UpgradeProxy | undefined;
  log?(message: string): void;
}

export type UpgradeDecision =
  | { ok: true; dashboardId: string }
  | { ok: false; status: 401 | 403 | 404; reason: string };

export function isPanelWsAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PANEL_WS_AUTH ?? '').trim().toLowerCase() !== 'false';
}

/** Slug (`/d/<slug>/...`) e token de sessão (`?t=` tem precedência sobre o cookie, como no guarda HTTP). */
export function parseUpgradeRequest(req: Pick<IncomingMessage, 'url' | 'headers'>): { slug: string; token: string | null } | null {
  const url = req.url ?? '';
  const match = url.match(/^\/d\/([^/?#]+)/);
  if (!match) return null;
  const query = url.includes('?') ? new URLSearchParams(url.slice(url.indexOf('?') + 1).split('#')[0]) : null;
  const queryToken = query?.get('t') || null;
  const cookieMatch = String(req.headers.cookie ?? '').match(/(?:^|;\s*)dauth=([^;]+)/);
  let cookieToken: string | null = null;
  if (cookieMatch) {
    try { cookieToken = decodeURIComponent(cookieMatch[1]); } catch { cookieToken = null; }
  }
  return { slug: match[1], token: queryToken ?? cookieToken };
}

export async function authorizeUpgrade(
  req: Pick<IncomingMessage, 'url' | 'headers'>,
  deps: Pick<UpgradeDeps, 'findSession' | 'findDashboardBySlug'>,
): Promise<UpgradeDecision & { slug?: string }> {
  const parsed = parseUpgradeRequest(req);
  if (!parsed) return { ok: false, status: 404, reason: 'endereço sem painel' };
  const { slug, token } = parsed;
  if (!token) return { ok: false, status: 401, reason: 'sem sessão', slug };

  const session = await deps.findSession(createHash('sha256').update(token).digest('hex'));
  if (!session?.user.isActive) return { ok: false, status: 401, reason: 'sessão inválida ou expirada', slug };

  const dashboard = await deps.findDashboardBySlug(slug);
  if (!dashboard?.isActive) return { ok: false, status: 404, reason: 'painel inexistente ou inativo', slug };

  if (!canAccessDashboard(session.user, dashboard)) return { ok: false, status: 403, reason: 'usuário sem acesso ao painel', slug };
  return { ok: true, dashboardId: dashboard.id, slug };
}

const STATUS_TEXT: Record<number, string> = {
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

export function rejectUpgrade(socket: Duplex, status: number) {
  try {
    socket.write(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    // socket já fechado
  }
  socket.destroy();
}

/** O tratador do evento "upgrade" do servidor HTTP. Nunca lança. */
export function createUpgradeHandler(deps: UpgradeDeps, options: { authEnabled?: () => boolean } = {}) {
  const authEnabled = options.authEnabled ?? isPanelWsAuthEnabled;
  return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    void (async () => {
      const parsed = parseUpgradeRequest(req);
      if (!parsed) return; // não é um painel (/d/...): fora do escopo deste tratador

      if (!authEnabled()) {
        // Válvula de segurança (PANEL_WS_AUTH=false): comportamento antigo, sem checagem de sessão.
        const dashboard = await deps.findDashboardBySlug(parsed.slug);
        const proxy = dashboard ? deps.getProxy(dashboard.id) : undefined;
        if (proxy?.upgrade) proxy.upgrade(req, socket, head);
        else rejectUpgrade(socket, 503);
        return;
      }

      const decision = await authorizeUpgrade(req, deps);
      if (!decision.ok) {
        deps.log?.(`websocket recusado em /d/${parsed.slug}: ${decision.reason} (${decision.status})`);
        rejectUpgrade(socket, decision.status);
        return;
      }
      const proxy = deps.getProxy(decision.dashboardId);
      if (!proxy?.upgrade) { rejectUpgrade(socket, 503); return; }
      proxy.upgrade(req, socket, head);
    })().catch((err) => {
      deps.log?.(`falha ao tratar websocket: ${err instanceof Error ? err.message : String(err)}`);
      rejectUpgrade(socket, 500);
    });
  };
}
