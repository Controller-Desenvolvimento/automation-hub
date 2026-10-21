import { BadRequestException, Body, Controller, NotFoundException, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { stat } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { storageRoot } from '../shared/storage';
import { canAccessStoragePath } from '../shared/storage-access';
import { createStorageLinkToken } from '../shared/storage-links';

const MSG_ARQUIVO_REMOVIDO =
  'Este arquivo não está mais no servidor (os arquivos de execuções antigas são removidos depois de um tempo).';

@ApiTags('Armazenamento')
@ApiBearerAuth()
@Controller('storage')
export class StorageController {
  constructor(
    private readonly authService: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  // Devolve um link curto (1 min) para o navegador baixar o arquivo direto, sem passar tudo pela memória do JavaScript.
  // Quem não tem acesso ao arquivo recebe 404, igual ao /storage.
  @Post('link')
  async createLink(@Req() req: Request, @Body() body: { path?: unknown }) {
    const user = await this.authService.requireUser(req);

    // O frontend manda o endereço como o conhece: "/storage/executions/<id>/output/arquivo.zip".
    const raw = typeof body?.path === 'string' ? body.path : '';
    if (!raw.startsWith('/storage/')) {
      throw new BadRequestException('Caminho de arquivo inválido.');
    }
    const relative = raw.slice('/storage'.length);                   // "/executions/<id>/output/arquivo.zip"

    const allowed = await canAccessStoragePath(this.prisma as never, user, encodeURI(relative));
    if (!allowed) {
      throw new NotFoundException('Arquivo não encontrado.');
    }

    // Confere no disco (e que o caminho não escapa da pasta de armazenamento): arquivo apagado pela retenção vira uma
    // mensagem clara em vez de um download que "não acontece nada".
    const absolute = normalize(join(storageRoot, relative));
    if (!absolute.startsWith(storageRoot + sep)) {
      throw new NotFoundException('Arquivo não encontrado.');
    }
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile()) {
      throw new NotFoundException(MSG_ARQUIVO_REMOVIDO);
    }

    const token = createStorageLinkToken(relative, user.id);
    return { url: `/storage${encodeURI(relative)}?dl=${token}`, size: info.size };
  }
}
