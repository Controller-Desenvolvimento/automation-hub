import { BadRequestException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { User } from '@prisma/client';
import type { Response } from 'express';
import { Readable } from 'node:stream';
import { PrismaService } from '../prisma/prisma.service';
import { canAccessDashboard } from '../shared/access';
import { createStorageLinkToken, verifyStorageLinkToken } from '../shared/storage-links';

// Arquivos (Excel/CSV) que o chat de IA de um painel gera a pedido da pessoa. O texto da resposta do painel traz um link
// markdown relativo do tipo `[Baixar Excel (nome.xlsx)](../chatkit-download/<32hex>__<nome>.xlsx)`; o arquivo fica no PRÓPRIO
// painel (por 24 h) e é servido por GET {painel}/chatkit-download/<arquivo>.
//
// O chat do hub mora em outra página, então esse link relativo não funciona lá. Aqui o hub:
// 1. confere, a pedido da pessoa logada, se ela tem acesso ao painel e emite um link curto assinado (1 minuto);
// 2. ao abrir o link, busca o arquivo no painel (127.0.0.1:<porta>) e repassa o binário em fluxo — sem guardar no hub, sem
//    cache, sem buffering, mantendo o Content-Disposition do painel.
// O link assinado serve para o navegador baixar direto (barra de progresso própria) sem depender de cookie de painel nem do
// cabeçalho Authorization (um clique normal não manda cabeçalho).

// O painel serve o download no mesmo prefixo do chat: a maioria na raiz; alguns (ex.: BI DRE Contábil, com /api/chatkit) em /api.
export const PANEL_DOWNLOAD_PATHS = ['/chatkit-download', '/api/chatkit-download'];

const HEADERS_TIMEOUT_MS = 30_000;
const MSG_EXPIRED = 'Este arquivo não está mais disponível (os arquivos gerados pelo painel ficam 24 horas). Peça para gerar de novo.';
const MSG_UNAVAILABLE = 'O painel não respondeu agora. Tente novamente em instantes.';
const MSG_FAILED = 'Não foi possível baixar o arquivo do painel agora.';

const DASHBOARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// <32 caracteres hex>__<nome do arquivo>. O nome não pode ter separador de pasta nem caractere proibido no Windows.
const PANEL_FILE_RE = /^[0-9a-f]{32}__[^\\/:*?"<>|\u0000-\u001f]{1,200}$/i;

export function isValidPanelFile(file: unknown): file is string {
  return typeof file === 'string' && PANEL_FILE_RE.test(file);
}

/** "<32hex>__Balancete setembro.xlsx" -> "Balancete setembro.xlsx" (o nome que a pessoa deve ver). */
export function panelFileDisplayName(file: string): string {
  return file.replace(/^[0-9a-f]{32}__/i, '');
}

function linkKey(dashboardId: string, file: string) {
  return `panel:${dashboardId}:${file}`;
}

@Injectable()
export class PanelDownloadService {
  private readonly logger = new Logger(PanelDownloadService.name);
  private readonly knownPaths = new Map<string, string>();   // dashboardId -> prefixo que funcionou

  constructor(private readonly prisma: PrismaService) {}

  private async findPanel(dashboardId: string) {
    if (!DASHBOARD_ID_RE.test(dashboardId)) throw new BadRequestException('Painel inválido.');
    const dashboard = await this.prisma.dashboard.findUnique({
      where: { id: dashboardId },
      select: {
        id: true, slug: true, type: true, isActive: true, streamlitPort: true,
        allowedDepartments: true, minRole: true, allowedUserIds: true,
      },
    });
    if (!dashboard || !dashboard.isActive || dashboard.type !== 'server' || !dashboard.streamlitPort) {
      throw new NotFoundException('Painel não encontrado.');
    }
    return dashboard;
  }

  /** Emite o link de download (1 min) se a pessoa tem acesso ao painel. */
  async createLink(user: User, dashboardId: string, file: string): Promise<{ url: string; name: string }> {
    if (!isValidPanelFile(file)) throw new BadRequestException('Arquivo inválido.');
    const dashboard = await this.findPanel(dashboardId);
    if (!canAccessDashboard(user, dashboard)) throw new NotFoundException('Painel não encontrado.');

    const token = createStorageLinkToken(linkKey(dashboard.id, file), user.id);
    return {
      url: `/api/site-chat/panel-download?d=${encodeURIComponent(dashboard.id)}&f=${encodeURIComponent(file)}&dl=${token}`,
      name: panelFileDisplayName(file),
    };
  }

  /** Abre o link emitido por `createLink`: busca o arquivo no painel e repassa em fluxo para `res`. */
  async stream(params: { dashboardId: string; file: string; token: unknown; res: Response; signal?: AbortSignal }): Promise<void> {
    const { dashboardId, file, token, res } = params;
    if (!isValidPanelFile(file) || !DASHBOARD_ID_RE.test(dashboardId) || !verifyStorageLinkToken(token, linkKey(dashboardId, file))) {
      throw new HttpException('Link de download inválido ou expirado. Clique em baixar de novo.', HttpStatus.UNAUTHORIZED);
    }
    const dashboard = await this.findPanel(dashboardId);

    const controller = new AbortController();
    const abort = () => controller.abort();
    params.signal?.addEventListener('abort', abort, { once: true });
    let headerTimer: NodeJS.Timeout | undefined = setTimeout(abort, HEADERS_TIMEOUT_MS);

    try {
      const known = this.knownPaths.get(dashboard.id);
      const candidates = known ? [known] : PANEL_DOWNLOAD_PATHS;
      let upstream: globalThis.Response | null = null;

      for (let i = 0; i < candidates.length; i++) {
        let response: globalThis.Response;
        try {
          response = await fetch(`http://127.0.0.1:${dashboard.streamlitPort}${candidates[i]}/${encodeURIComponent(file)}`, {
            headers: { Accept: '*/*' },
            signal: controller.signal,
          });
        } catch (error) {
          if (params.signal?.aborted) throw error;
          this.logger.warn(`Painel ${dashboard.slug} inacessível na porta ${dashboard.streamlitPort}: ${error instanceof Error ? error.message : String(error)}`);
          throw new HttpException(MSG_UNAVAILABLE, HttpStatus.SERVICE_UNAVAILABLE);
        }
        if ((response.status === 404 || response.status === 405) && i < candidates.length - 1) {
          await response.body?.cancel().catch(() => undefined);   // tenta o outro prefixo
          continue;
        }
        upstream = response;
        if (response.ok) this.knownPaths.set(dashboard.id, candidates[i]);
        else if (known && (response.status === 404 || response.status === 405)) this.knownPaths.delete(dashboard.id);
        break;
      }

      if (!upstream || upstream.status === 404 || upstream.status === 410) {
        await upstream?.body?.cancel().catch(() => undefined);
        throw new HttpException(MSG_EXPIRED, HttpStatus.NOT_FOUND);
      }
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel().catch(() => undefined);
        this.logger.warn(`Painel ${dashboard.slug} respondeu HTTP ${upstream.status} no download de ${file}.`);
        throw new HttpException(MSG_FAILED, HttpStatus.BAD_GATEWAY);
      }

      clearTimeout(headerTimer);
      headerTimer = undefined;

      // Binário como veio: tipo, tamanho e Content-Disposition do painel. Sem cache e sem buffering no caminho
      // (IIS/ARR e outros proxies à frente).
      res.status(200);
      const contentType = upstream.headers.get('content-type');
      const contentLength = upstream.headers.get('content-length');
      const disposition = upstream.headers.get('content-disposition');
      res.setHeader('Content-Type', contentType ?? 'application/octet-stream');
      if (contentLength) res.setHeader('Content-Length', contentLength);
      res.setHeader('Content-Disposition', disposition ?? `attachment; filename*=UTF-8''${encodeURIComponent(panelFileDisplayName(file))}`);
      res.setHeader('Cache-Control', 'no-store, no-cache, no-transform, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.flushHeaders();

      const body = Readable.fromWeb(upstream.body as never);
      await new Promise<void>((resolve) => {
        const finish = () => { body.destroy(); controller.abort(); resolve(); };   // cliente desistiu: para de puxar do painel
        res.on('close', finish);
        body.on('error', (error) => {
          this.logger.warn(`Download de ${file} do painel ${dashboard.slug} interrompido: ${error.message}`);
          res.destroy();
          finish();
        });
        body.on('end', resolve);
        body.pipe(res);
      });
    } finally {
      if (headerTimer) clearTimeout(headerTimer);
      params.signal?.removeEventListener('abort', abort);
    }
  }
}
