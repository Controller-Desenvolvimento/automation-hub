import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { SiteCategory, type User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { canAccessDashboard, canAccessSite } from '../shared/access';
import { PROGRESS_QUERYING, SseJsonParser, applyChatKitEvent, finalText, newTurn, type ChatKitTurn } from './chatkit-events';
import type { ScreenContext } from './screen-context';

// Ponte entre o chat do hub e o chat de IA de um painel (Dashboard tipo
// "server", ex.: BI PERFORMANCE PESSOAL), usada quando o usuário está olhando
// um BI vinculado (Site.linkedDashboardId) pelo botão "Ver". A pergunta é
// repassada ao POST /chatkit do próprio painel — o modelo e as ferramentas de
// dados continuam todos lá — e a resposta volta em streaming. Nenhum modelo do
// hub entra no caminho, então o custo de tokens é o mesmo do chat do painel.
//
// Desligar sem deploy: desvincular o BI nas configurações, ou
// BI_CHAT_BRIDGE_ENABLED=false no .env (e reiniciar).

const THREAD_TTL_MS = 30 * 60 * 1000;
const MAX_THREADS = 500;
// O painel manda um sinal de vida a cada 15s; 2 min sem NENHUM byte = travou.
const IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const TOTAL_TIMEOUT_MS = 10 * 60 * 1000;

const MSG_UNAVAILABLE =
  'O João não conseguiu falar com este painel agora (o servidor do painel parece estar parado). Tente novamente em instantes ou avise a equipe de Inovação.';
const MSG_FAILED = 'O João não conseguiu responder sobre este painel agora. Tente novamente em instantes.';
const MSG_TIMEOUT = 'O João demorou demais para responder sobre este painel. Tente uma pergunta mais específica.';
const MSG_NO_CHAT =
  'Este painel ainda não tem o chat de IA ligado. Para dúvidas sobre o Hub, feche o painel e pergunte ao João por aqui.';

// Onde o painel serve o ChatKit: a maioria em /chatkit; alguns (ex.: BI DRE Contábil) em /api/chatkit.
// Tenta nessa ordem quando o primeiro não existe (404/405) e guarda o que funcionou por painel.
export const CHAT_PATHS = ['/chatkit', '/api/chatkit'];

export type BiLink = {
  // null quando o painel é aberto direto (sem BI no meio).
  siteId: string | null;
  siteName: string;
  dashboardId: string;
  dashboardSlug: string;
  dashboardName: string;
  port: number;
};

type AskHandlers = {
  onDelta: (text: string) => void;
  onProgress?: (text: string) => void;
  signal?: AbortSignal;
};

// Erro HTTP do painel (ex.: conversa desconhecida depois de um reinício dele).
class PanelHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

@Injectable()
export class BiChatBridgeService {
  private readonly logger = new Logger(BiChatBridgeService.name);
  private readonly threads = new Map<string, { threadId: string; lastUsedAt: number }>();
  private readonly chatPaths = new Map<string, string>();   // dashboardId -> caminho do ChatKit que funcionou

  constructor(private readonly prisma: PrismaService) {}

  private isEnabled() {
    return process.env.BI_CHAT_BRIDGE_ENABLED !== 'false';
  }

  // null = não usar a ponte (BI sem vínculo, painel inativo/sem porta ou sem
  // permissão) — o chat segue normal, sem erro e sem revelar que o vínculo existe.
  async resolveLink(user: User, siteId: string): Promise<BiLink | null> {
    if (!this.isEnabled()) return null;

    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { id: true, name: true, category: true, allowedDepartments: true, minRole: true, linkedDashboardId: true },
    });
    if (!site || site.category !== SiteCategory.bi || !site.linkedDashboardId || !canAccessSite(user, site)) return null;

    return this.linkForDashboard(user, site.linkedDashboardId, { id: site.id, name: site.name });
  }

  // Painel aberto direto (botão "Ver" na aba Painéis), sem BI no meio.
  async resolveDashboardLink(user: User, dashboardId: string): Promise<BiLink | null> {
    if (!this.isEnabled()) return null;
    return this.linkForDashboard(user, dashboardId, null);
  }

  private async linkForDashboard(user: User, dashboardId: string, site: { id: string; name: string } | null): Promise<BiLink | null> {
    const dashboard = await this.prisma.dashboard.findUnique({
      where: { id: dashboardId },
      select: {
        id: true,
        slug: true,
        name: true,
        type: true,
        isActive: true,
        streamlitPort: true,
        allowedDepartments: true,
        minRole: true,
        allowedUserIds: true,
      },
    });
    if (!dashboard || !dashboard.isActive || dashboard.type !== 'server' || !dashboard.streamlitPort) return null;
    if (!canAccessDashboard(user, dashboard)) return null;

    return {
      siteId: site?.id ?? null,
      siteName: site?.name ?? dashboard.name,
      dashboardId: dashboard.id,
      dashboardSlug: dashboard.slug,
      dashboardName: dashboard.name,
      port: dashboard.streamlitPort,
    };
  }

  // Esquece a conversa do usuário com UM painel (ex.: "Limpar conversa" dele).
  forgetThread(userId: string, dashboardId: string) {
    this.threads.delete(`${userId}:${dashboardId}`);
  }

  async ask(params: { user: User; link: BiLink; question: string; screen?: ScreenContext | null } & AskHandlers): Promise<string> {
    const { user, link, question, screen, ...handlers } = params;
    const key = `${user.id}:${link.dashboardId}`;
    const known = this.threads.get(key);
    const reuse = known && Date.now() - known.lastUsedAt < THREAD_TTL_MS ? known.threadId : null;
    const input = { content: [{ type: 'input_text', text: question }], attachments: [], inference_options: {} };
    const startedAt = Date.now();

    const attempt = (threadId: string | null) =>
      this.runChatKit(
        link,
        threadId ? { type: 'threads.add_user_message', params: { thread_id: threadId, input } } : { type: 'threads.create', params: { input } },
        handlers,
        screen ?? null,
      );

    let turn: ChatKitTurn;
    let threadId: string | null = reuse;
    try {
      try {
        turn = await attempt(reuse);
      } catch (error) {
        // Conversa antiga que o painel não conhece mais (ele reiniciou): recomeça
        // uma nova, uma única vez — o painel recusa antes de enviar qualquer
        // evento, então o usuário ainda não viu nada.
        if (reuse && error instanceof PanelHttpError) {
          this.threads.delete(key);
          this.logger.warn(`Painel ${link.dashboardSlug} recusou a conversa ${reuse} (HTTP ${error.status}); abrindo uma nova.`);
          threadId = null;
          turn = await attempt(null);
        } else {
          throw error;
        }
      }
    } catch (error) {
      throw this.toHttpException(error, link);
    }

    const text = finalText(turn);
    if (!text) {
      this.logger.warn(`Painel ${link.dashboardSlug} respondeu sem texto.`);
      throw new HttpException(MSG_FAILED, HttpStatus.BAD_GATEWAY);
    }

    this.remember(key, threadId ?? turn.threadId);
    this.logger.log(`Chat do painel ${link.dashboardSlug}: ${Math.round((Date.now() - startedAt) / 1000)}s, ${text.length} caracteres.`);
    return text;
  }

  private remember(key: string, threadId: string | undefined | null) {
    if (!threadId) return;
    const now = Date.now();
    this.threads.set(key, { threadId, lastUsedAt: now });
    if (this.threads.size <= MAX_THREADS) return;
    for (const [k, v] of this.threads) {
      if (now - v.lastUsedAt >= THREAD_TTL_MS) this.threads.delete(k);
    }
    while (this.threads.size > MAX_THREADS) {
      const oldest = this.threads.keys().next().value;
      if (oldest === undefined) break;
      this.threads.delete(oldest);
    }
  }

  private toHttpException(error: unknown, link: BiLink): HttpException {
    if (error instanceof HttpException) return error;
    if (error instanceof PanelHttpError && (error.status === 404 || error.status === 405)) {
      this.logger.warn(`Painel ${link.dashboardSlug} não tem rota de chat (HTTP ${error.status} em ${CHAT_PATHS.join(' e ')}).`);
      return new HttpException(MSG_NO_CHAT, HttpStatus.BAD_GATEWAY);
    }
    this.logger.warn(`Falha ao falar com o painel ${link.dashboardSlug}: ${error instanceof Error ? error.message : String(error)}`);
    return new HttpException(MSG_FAILED, HttpStatus.BAD_GATEWAY);
  }

  private async runChatKit(link: BiLink, body: unknown, handlers: AskHandlers, screen: ScreenContext | null): Promise<ChatKitTurn> {
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (handlers.signal?.aborted) controller.abort();
    handlers.signal?.addEventListener('abort', onExternalAbort, { once: true });
    const totalTimer = setTimeout(() => controller.abort(new Error('timeout-total')), TOTAL_TIMEOUT_MS);

    let idleTimer: NodeJS.Timeout | undefined;
    let idleExpired = false;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleExpired = true;
        controller.abort();
      }, IDLE_TIMEOUT_MS);
    };

    const turn = newTurn();
    try {
      armIdle();
      const query = screen ? `?contexto=${encodeURIComponent(JSON.stringify(screen))}` : '';
      const known = this.chatPaths.get(link.dashboardId);
      const candidates = known ? [known] : CHAT_PATHS;
      let response!: Response;
      for (let i = 0; i < candidates.length; i++) {
        try {
          response = await fetch(`http://127.0.0.1:${link.port}${candidates[i]}${query}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (error) {
          if (handlers.signal?.aborted) throw error;
          if (idleExpired) throw new HttpException(MSG_TIMEOUT, HttpStatus.GATEWAY_TIMEOUT);
          this.logger.warn(`Painel ${link.dashboardSlug} inacessível na porta ${link.port}: ${error instanceof Error ? error.message : String(error)}`);
          throw new HttpException(MSG_UNAVAILABLE, HttpStatus.SERVICE_UNAVAILABLE);
        }
        const missing = response.status === 404 || response.status === 405;
        if (missing && i < candidates.length - 1) continue;      // tenta o outro caminho
        if (response.ok) this.chatPaths.set(link.dashboardId, candidates[i]);
        else if (missing && known) this.chatPaths.delete(link.dashboardId);   // o painel mudou de rota: redescobre na próxima
        break;
      }

      if (!response.ok || !response.body) {
        throw new PanelHttpError(response.status);
      }

      // O painel só emite o primeiro aviso depois de "pensar" (pode levar
      // vários segundos); mostra algo ao usuário assim que a pergunta é aceita.
      handlers.onProgress?.(PROGRESS_QUERYING);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseJsonParser();
      const handle = (events: Record<string, unknown>[]) => {
        for (const event of events) {
          const effect = applyChatKitEvent(turn, event);
          if (effect.progress) handlers.onProgress?.(effect.progress);
          if (effect.delta) handlers.onDelta(effect.delta);
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          armIdle();
          handle(parser.push(decoder.decode(value, { stream: true })));
        }
        handle(parser.push(decoder.decode()));
        handle(parser.flush());
      } catch (error) {
        if (handlers.signal?.aborted) throw error;
        if (idleExpired || controller.signal.aborted) throw new HttpException(MSG_TIMEOUT, HttpStatus.GATEWAY_TIMEOUT);
        this.logger.warn(`Conexão com o painel ${link.dashboardSlug} caiu no meio da resposta: ${error instanceof Error ? error.message : String(error)}`);
        throw new HttpException(MSG_FAILED, HttpStatus.BAD_GATEWAY);
      }

      if (turn.error) {
        this.logger.warn(`Painel ${link.dashboardSlug} devolveu erro no chat: ${turn.error}`);
        throw new HttpException(MSG_FAILED, HttpStatus.BAD_GATEWAY);
      }
      return turn;
    } finally {
      clearTimeout(totalTimer);
      if (idleTimer) clearTimeout(idleTimer);
      handlers.signal?.removeEventListener('abort', onExternalAbort);
      controller.abort();
    }
  }
}
