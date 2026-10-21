import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { canAccessStoragePath } from './storage-access';
import { verifyStorageLinkToken } from './storage-links';

// Protege /storage/*: exige sessão válida E acesso ao recurso. Dois jeitos de entrar:
// 1. Cabeçalho `Authorization: Bearer <token>` (o frontend usa em chamadas fetch).
// 2. `?dl=<link assinado>` emitido por POST /api/storage/link, para o navegador baixar direto para o disco (ver
//    `shared/storage-links.ts`). A autorização já foi conferida na emissão; o link vale para um único caminho e expira.
export function createStorageAccessMiddleware(prisma: PrismaClient) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (typeof req.query.dl === 'string') {
      let decodedPath = '';
      try {
        decodedPath = decodeURIComponent(req.path);
      } catch {
        // caminho inválido: cai na recusa abaixo
      }
      if (!verifyStorageLinkToken(req.query.dl, decodedPath)) {
        res.status(401).json({ message: 'Link de download inválido ou expirado. Clique em baixar de novo.' });
        return;
      }
      // `attachment`: o navegador baixa em vez de tentar abrir o arquivo (o nome vem do atributo `download` do link).
      res.setHeader('Content-Disposition', 'attachment');
      next();
      return;
    }

    const authHeader = req.headers['authorization'] ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    if (!token) {
      res.status(401).json({ message: 'Não autorizado.' });
      return;
    }
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const session = await prisma.session.findFirst({
      where: { tokenHash, expiresAt: { gt: new Date() } },
      include: { user: true },
    });
    if (!session || !session.user.isActive) {
      res.status(401).json({ message: 'Sessão inválida ou expirada.' });
      return;
    }

    try {
      const allowed = await canAccessStoragePath(prisma, session.user, req.path);
      if (!allowed) {
        res.status(404).json({ message: 'Arquivo não encontrado.' });
        return;
      }
    } catch {
      res.status(500).json({ message: 'Falha ao validar acesso ao arquivo.' });
      return;
    }

    next();
  };
}
