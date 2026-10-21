import 'dotenv/config';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Request, Response, NextFunction } from 'express';
import { AppModule } from './app.module';
import { DashboardService } from './dashboard/dashboard.service';
import { PrismaService } from './prisma/prisma.service';
import { dashboardRoot } from './shared/storage';
import { createStorageAccessMiddleware } from './shared/storage-middleware';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const rootDir = process.cwd();
  const webDistDir = join(rootDir, '..', 'web', 'dist');
  const legacyPublicDir = join(rootDir, 'public');
  const frontendDir = existsSync(join(webDistDir, 'index.html')) ? webDistDir : legacyPublicDir;

  // Atrás do IIS como reverse proxy, request.ip deve refletir o cliente real
  // (senão o rate limit de login vale para a empresa inteira somada)
  app.set('trust proxy', 'loopback');

  app.enableCors({
    origin: process.env.ALLOWED_ORIGIN ?? 'http://localhost:5173',
  });
  app.setGlobalPrefix('api', { exclude: ['/'] });
  app.useStaticAssets(frontendDir);

  // Swagger — referência exploratória das rotas da API. A maioria exige um token
  // (obtido em POST /api/auth/login) colado no botão "Authorize" para o "Try it out" funcionar.
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Automation Hub API')
    .setDescription(
      'Referência das rotas HTTP do hub. Faça login em POST /api/auth/login para obter um token, ' +
      'depois clique em "Authorize" acima e cole o token para testar as rotas protegidas. ' +
      'Para o "porquê" de cada integração (com exemplos e contexto), veja Configurações → Dev Docs.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, swaggerDocument);

  // Protect storage files: require a valid session AND access to the resource
  const prisma = app.get(PrismaService);
  app.use('/storage', createStorageAccessMiddleware(prisma));

  app.useStaticAssets(join(rootDir, 'storage'), { prefix: '/storage/' });

  // Dashboard serving: /d/<slug>/... — auth via session cookie (set on first visit via ?t=)
  const dashboardService = app.get(DashboardService);
  const expressApp = app.getHttpAdapter().getInstance();

  expressApp.use(async (req: Request, res: Response, next: NextFunction) => {
    const path: string = req.path;
    if (!path.startsWith('/d/') && path !== '/d') return next();

    // Auth: cookie OR ?t= query param
    const cookieHeader = (req.headers.cookie as string | undefined) ?? '';
    const cookieMatch = cookieHeader.match(/(?:^|;\s*)dauth=([^;]+)/);
    const cookieToken = cookieMatch ? decodeURIComponent(cookieMatch[1]) : null;
    const queryToken = req.query.t as string | undefined;
    // Query token (?t=) takes precedence over cookie: the frontend always passes the
    // current session token, while the cookie may be from a previous session that was
    // invalidated by logout. Without this, logging out and back in still fails because
    // the old dauth cookie is preferred over the fresh token.
    const rawToken = queryToken ?? cookieToken ?? null;

    // For sub-paths that are clearly API calls (not page navigation), a missing/invalid
    // session should return 401 JSON — not redirect to /. A redirect causes the browser
    // to follow it with GET /, which returns the SPA HTML, making r.json() throw
    // "Unexpected token '<'" instead of a meaningful error.
    const isApiSubpath = path.includes('/api/') || (req.method !== 'GET' && req.method !== 'HEAD');

    if (!rawToken) {
      if (isApiSubpath) { res.status(401).json({ statusCode: 401, message: 'Sessão expirada. Recarregue o dashboard.' }); return; }
      res.redirect('/'); return;
    }

    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const session = await prisma.session.findFirst({
      where: { tokenHash, expiresAt: { gt: new Date() } },
      include: { user: true },
    });
    if (!session?.user.isActive) {
      if (isApiSubpath) { res.status(401).json({ statusCode: 401, message: 'Sessão expirada. Recarregue o dashboard.' }); return; }
      res.redirect('/'); return;
    }

    // Inject hub user info so the proxy can forward it as request headers to the dashboard backend
    (req as unknown as Record<string, unknown>).hubUser = session.user;

    // If token came from query param, set cookie and redirect (strip ?t= from URL)
    // Max-Age=604800 = 7 days, matching the hub session lifetime
    if (queryToken) {
      res.setHeader('Set-Cookie',
        `dauth=${encodeURIComponent(rawToken)}; HttpOnly; Path=/d; SameSite=Lax; Max-Age=604800`);
      const afterD = req.path.slice('/d'.length) || '/';
      const afterDWithSlash = afterD.endsWith('/') ? afterD : `${afterD}/`;
      res.redirect(`/d${afterDWithSlash}`);
      return;
    }

    // Extract slug: path is like /d/slug, /d/slug/, /d/slug/file.js
    const remaining = path.slice(3); // remove '/d/'
    const slashIdx = remaining.indexOf('/');
    const slug = slashIdx === -1 ? remaining : remaining.slice(0, slashIdx);
    const relPath = slashIdx === -1 ? '' : remaining.slice(slashIdx + 1);

    if (!slug) { res.status(404).send('Not found'); return; }

    const dashboard = await dashboardService.findBySlug(slug);
    if (!dashboard?.isActive) { res.status(404).send('Dashboard não encontrado.'); return; }

    if (dashboard.allowedDepartments.length > 0 && session.user.role !== 'admin') {
      if (!session.user.departments.some((d) => dashboard.allowedDepartments.includes(d))) {
        res.status(403).send('Acesso negado.'); return;
      }
    }

    if (dashboard.type === 'html') {
      const root = dashboard.serverWorkingDirectory ?? dashboardRoot(dashboard.id);
      const file = relPath || (dashboard.mainFile ?? 'index.html');
      res.sendFile(file, { root }, (err) => {
        if (err && !res.headersSent) res.status(404).send('Arquivo não encontrado.');
      });
      return;
    }

    if (dashboard.type === 'streamlit' || dashboard.type === 'server') {
      if (!dashboardService.isRunning(dashboard.id)) {
        const label = dashboard.type === 'server' ? 'Servidor' : 'Streamlit';
        res.status(503).send(`<h2>${label} não está rodando.</h2><p>Um administrador precisa iniciá-lo nas configurações do hub.</p>`);
        return;
      }
      const proxy = dashboardService.getProxy(dashboard.id);
      if (!proxy) { res.status(503).send('Proxy não configurado.'); return; }
      proxy(req, res, next);
      return;
    }

    next();
  });

  if (frontendDir === webDistDir) {
    expressApp.get(/^(?!\/api|\/storage|\/d\/).*/, (_req: Request, res: Response) => {
      res.sendFile(join(webDistDir, 'index.html'));
    });
  }

  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');

  // WebSocket upgrade for Streamlit proxy
  const httpServer = app.getHttpServer();
  httpServer.on('upgrade', (req, socket, head) => {
    dashboardService.handleUpgrade(req, socket, head);
  });
}

void bootstrap();
