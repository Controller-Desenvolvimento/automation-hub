import { Body, Controller, Delete, Get, NotFoundException, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { join } from 'node:path';
import { AuthService } from '../auth/auth.service';
import { storageRoot } from '../shared/storage';
import { parseScope } from './conversation-scope';
import { PanelDownloadService } from './panel-download.service';
import { SiteChatService } from './site-chat.service';

@ApiTags('Chat do site')
@ApiBearerAuth()
@Controller('site-chat')
export class SiteChatController {
  constructor(
    private readonly siteChatService: SiteChatService,
    private readonly authService: AuthService,
    private readonly panelDownloadService: PanelDownloadService,
  ) {}

  @Get('messages')
  async listMessages(@Req() request: Request, @Query('scope') scope?: string) {
    const user = await this.authService.requireUser(request);
    return this.siteChatService.listMessages(user.id, parseScope(scope));
  }

  @Post('messages')
  async sendMessage(@Req() request: Request, @Body() body: { content?: string }) {
    const user = await this.authService.requireUser(request);
    return this.siteChatService.sendMessage(user, body?.content ?? '');
  }

  // SSE via POST (não GET/EventSource) porque a autenticação é por Bearer
  // token em header, e EventSource nativo do browser não permite headers
  // customizados. O frontend lê a resposta com fetch + ReadableStream.
  @Post('messages/stream')
  async streamMessage(
    @Req() request: Request,
    @Res() response: Response,
    @Body() body: { content?: string; context?: { siteId?: unknown; dashboardId?: unknown; screen?: unknown } },
  ) {
    const user = await this.authService.requireUser(request);

    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders();

    // Se o navegador desconectar no meio (fechou a aba/o chat), cancela a
    // consulta ao painel pra não gastar tokens com uma resposta que ninguém vai ver.
    const abort = new AbortController();
    response.on('close', () => {
      if (!response.writableEnded) abort.abort();
    });

    try {
      const { userMessage, assistantMessage } = await this.siteChatService.streamMessage(
        user,
        body?.content ?? '',
        (delta) => {
          response.write(`data: ${JSON.stringify({ delta })}\n\n`);
        },
        {
          siteId: typeof body?.context?.siteId === 'string' ? body.context.siteId : undefined,
          dashboardId: typeof body?.context?.dashboardId === 'string' ? body.context.dashboardId : undefined,
          screen: body?.context?.screen,
          onProgress: (progress) => {
            response.write(`data: ${JSON.stringify({ progress })}\n\n`);
          },
          signal: abort.signal,
        },
      );
      response.write(`data: ${JSON.stringify({ done: true, userMessage, assistantMessage })}\n\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro inesperado no João.';
      response.write(`data: ${JSON.stringify({ error: message })}\n\n`);
    } finally {
      response.end();
    }
  }

  @Delete('messages')
  async clearMessages(@Req() request: Request, @Query('scope') scope?: string) {
    const user = await this.authService.requireUser(request);
    return this.siteChatService.clearMessages(user.id, parseScope(scope));
  }

  // Arquivo (Excel/CSV) gerado pelo chat de IA de um painel: o frontend pede o link (com a sessão) e o navegador baixa direto.
  @Post('panel-download')
  async panelDownloadLink(@Req() request: Request, @Body() body: { dashboardId?: unknown; file?: unknown }) {
    const user = await this.authService.requireUser(request);
    return this.panelDownloadService.createLink(user, typeof body?.dashboardId === 'string' ? body.dashboardId : '', typeof body?.file === 'string' ? body.file : '');
  }

  // Sem cabeçalho Authorization de propósito: é aberto pelo navegador (clique no link). A autorização é o link assinado de
  // 1 minuto emitido acima, válido só para este painel e este arquivo.
  @Get('panel-download')
  async panelDownload(
    @Req() request: Request,
    @Res() response: Response,
    @Query('d') dashboardId?: string,
    @Query('f') file?: string,
    @Query('dl') token?: string,
  ) {
    const abort = new AbortController();
    response.on('close', () => {
      if (!response.writableEnded) abort.abort();
    });
    await this.panelDownloadService.stream({ dashboardId: dashboardId ?? '', file: file ?? '', token, res: response, signal: abort.signal });
  }

  @Get('messages/:id/attachment')
  async downloadAttachment(@Req() request: Request, @Res() response: Response, @Param('id') id: string) {
    const user = await this.authService.requireUser(request);
    const attachment = await this.siteChatService.getAttachment(user.id, id);
    if (!attachment) throw new NotFoundException('Arquivo não encontrado.');
    response.download(join(storageRoot, attachment.path), attachment.name);
  }
}
