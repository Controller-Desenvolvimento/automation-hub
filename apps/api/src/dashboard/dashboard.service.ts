import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Dashboard, DashboardType, UserRole } from '@prisma/client';
import AdmZip from 'adm-zip';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent, fetch as undiciFetch } from 'undici';
import { PrismaService } from '../prisma/prisma.service';
import { dashboardRoot, dashboardsRoot } from '../shared/storage';

const PORT_START = 8500;
const PORT_END = 8599;
const WARMUP_STAGGER_MS = 300;
// Painéis com muitas seções (ex: BI Indicadores Fiscal) podem legitimamente
// demorar mais que alguns minutos pra atualizar todos os dados — 3min já
// estourou pra esse aqui numa noite real, sem nada de errado no painel.
const UPDATE_TIMEOUT_MS = 30 * 60 * 1000;

// O fetch nativo do Node (undici) tem um headersTimeout/bodyTimeout PADRÃO de
// 5 minutos que roda por baixo do AbortSignal acima e vence primeiro — ou
// seja, aumentar UPDATE_TIMEOUT_MS sozinho não adianta nada pros painéis que
// passam de 5min pra atualizar (ex: bi-indicadores-fiscal, que o próprio
// código do painel diz que pode levar 15-30min pras fontes pesadas). Esse
// dispatcher dedicado estende os dois timeouts do undici pra acompanhar o
// AbortSignal.
//
// Usamos o fetch/Agent do pacote `undici` (não o fetch global do Node) de
// propósito: o Node 22+ já embute sua própria cópia interna do undici, e
// passar um Agent do pacote npm como `dispatcher` pro fetch global quebra
// com "InvalidArgumentError: invalid onError method" por divergência de
// versão entre as duas cópias. Usando o fetch do próprio pacote undici,
// tudo fica na mesma versão e o dispatch funciona.
const updateDispatcher = new Agent({
  headersTimeout: UPDATE_TIMEOUT_MS,
  bodyTimeout: UPDATE_TIMEOUT_MS,
});

// Quando um painel (streamlit/server) cai sozinho, sem ninguém ter pedido
// pra parar, tenta religar automaticamente em vez de ficar fora do ar até
// alguém notar — mas com um limite, pra não ficar num loop de reinícios se
// o app em si estiver quebrado de verdade.
const CRASH_RESTART_DELAY_MS = 10 * 1000;
const CRASH_LOOP_WINDOW_MS = 10 * 60 * 1000;
const CRASH_LOOP_MAX_RESTARTS = 5;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class DashboardService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DashboardService.name);
  private readonly processes = new Map<string, ChildProcess>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly proxies = new Map<string, any>();
  private readonly lastErrors = new Map<string, string[]>();
  // Marca um dashboard como "essa saída foi pedida por alguém" — sem isso,
  // parar o processo de propósito (ou substituí-lo por um novo antes de
  // iniciar) pareceria uma queda inesperada e disparava um reinício automático
  // duplicado/desnecessário.
  private readonly intentionalStops = new Set<string>();
  private readonly crashHistory = new Map<string, number[]>();

  private shouldAutoRestart(id: string): boolean {
    const now = Date.now();
    const recent = (this.crashHistory.get(id) ?? []).filter(
      (t) => now - t < CRASH_LOOP_WINDOW_MS,
    );
    recent.push(now);
    this.crashHistory.set(id, recent);
    return recent.length <= CRASH_LOOP_MAX_RESTARTS;
  }

  private handleUnexpectedExit(id: string, slug: string, type: DashboardType) {
    if (this.intentionalStops.delete(id)) return;

    if (!this.shouldAutoRestart(id)) {
      this.logger.error(
        `[${type}:${slug}] caiu ${CRASH_LOOP_MAX_RESTARTS}+ vezes em ${CRASH_LOOP_WINDOW_MS / 60000}min — parando de reiniciar automaticamente, precisa de intervenção manual.`,
      );
      return;
    }

    this.logger.warn(
      `[${type}:${slug}] caiu sozinho — tentando religar em ${CRASH_RESTART_DELAY_MS / 1000}s`,
    );
    setTimeout(() => {
      const starter = type === DashboardType.server ? this.startServer(id) : this.startStreamlit(id);
      starter.catch((err) =>
        this.logger.error(`[${type}:${slug}] falha ao religar automaticamente: ${String(err)}`),
      );
    }, CRASH_RESTART_DELAY_MS);
  }

  private appendError(id: string, line: string) {
    const buf = this.lastErrors.get(id) ?? [];
    buf.push(line);
    if (buf.length > 50) buf.shift();
    this.lastErrors.set(id, buf);
  }

  getLastError(id: string): string[] {
    return this.lastErrors.get(id) ?? [];
  }

  clearLastError(id: string) {
    this.lastErrors.delete(id);
  }

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await mkdir(dashboardsRoot, { recursive: true });
    const active = await this.prisma.dashboard.findMany({
      where: { type: { in: [DashboardType.streamlit, DashboardType.server] }, isActive: true },
    });
    for (const d of active) {
      if (d.streamlitPort) {
        this.setupProxy(d.id, d.streamlitPort, d.slug ?? undefined);
      }
      const starter = d.type === DashboardType.server
        ? this.startServer(d.id)
        : this.startStreamlit(d.id);
      await starter.catch((err) =>
        this.logger.warn(`Auto-start ${d.type} ${d.slug}: ${String(err)}`),
      );
    }
  }

  onModuleDestroy() {
    for (const [id, proc] of this.processes) {
      this.intentionalStops.add(id);
      this.killProcess(proc);
    }
  }

  findAll(): Promise<Dashboard[]> {
    return this.prisma.dashboard.findMany({ orderBy: { name: 'asc' } });
  }

  findAllActive(): Promise<Dashboard[]> {
    return this.prisma.dashboard.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  findById(id: string): Promise<Dashboard | null> {
    return this.prisma.dashboard.findUnique({ where: { id } });
  }

  findBySlug(slug: string): Promise<Dashboard | null> {
    return this.prisma.dashboard.findUnique({ where: { slug } });
  }

  async create(dto: {
    slug: string;
    name: string;
    description?: string;
    type: DashboardType;
    isActive?: boolean;
    allowedDepartments?: string[];
    minRole?: UserRole;
    allowedUserIds?: string[];
    mainFile?: string;
    serverCommand?: string;
    serverWorkingDirectory?: string;
    updatePath?: string;
    warmupPaths?: string[];
    warmupMode?: string;
    updateFrequency?: string;
    updateTimesOfDay?: string[];
    updateDayOfWeek?: number;
    updateDayOfMonth?: number;
  }): Promise<Dashboard> {
    const defaultMain = dto.type === DashboardType.html ? 'index.html' : 'app.py';
    const isProcess = dto.type === DashboardType.streamlit || dto.type === DashboardType.server;
    const dashboard = await this.prisma.dashboard.create({
      data: {
        slug: dto.slug,
        name: dto.name,
        description: dto.description ?? null,
        type: dto.type,
        isActive: dto.isActive !== undefined ? dto.isActive : true,
        allowedDepartments: dto.allowedDepartments ?? [],
        minRole: dto.minRole ?? UserRole.employee,
        allowedUserIds: dto.allowedUserIds ?? [],
        mainFile: dto.mainFile ?? defaultMain,
        streamlitStatus: isProcess ? 'stopped' : null,
        serverCommand: dto.serverCommand ?? null,
        serverWorkingDirectory: dto.serverWorkingDirectory ?? null,
        updatePath: dto.updatePath ?? null,
        warmupPaths: dto.warmupPaths ?? [],
        warmupMode: dto.warmupMode ?? 'manual',
        updateFrequency: dto.updateFrequency ?? null,
        updateTimesOfDay: dto.updateTimesOfDay ?? [],
        updateDayOfWeek: dto.updateDayOfWeek ?? null,
        updateDayOfMonth: dto.updateDayOfMonth ?? null,
      },
    });
    await mkdir(dashboardRoot(dashboard.id), { recursive: true });
    return dashboard;
  }

  update(id: string, dto: Partial<Pick<Dashboard, 'name' | 'description' | 'isActive' | 'allowedDepartments' | 'minRole' | 'allowedUserIds' | 'mainFile' | 'serverCommand' | 'serverWorkingDirectory' | 'updatePath' | 'warmupPaths' | 'warmupMode' | 'updateFrequency' | 'updateTimesOfDay' | 'updateDayOfWeek' | 'updateDayOfMonth'>>): Promise<Dashboard> {
    return this.prisma.dashboard.update({ where: { id }, data: dto });
  }

  async triggerUpdate(id: string): Promise<{ ok: true; updatedAt: Date }> {
    const dashboard = await this.prisma.dashboard.findUniqueOrThrow({ where: { id } });

    if (!dashboard.updatePath) {
      throw new Error('updatePath is not configured for this dashboard');
    }
    if (!dashboard.streamlitPort) {
      throw new Error('streamlitPort is not available for this dashboard');
    }

    const updatedAt = new Date();
    await this.prisma.dashboard.update({
      where: { id },
      data: { lastUpdateStatus: 'running', lastUpdateAt: updatedAt },
    });

    try {
      const updateUrl = `http://localhost:${dashboard.streamlitPort}${dashboard.updatePath}`;
      const response = await undiciFetch(updateUrl, {
        method: 'POST',
        signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
        dispatcher: updateDispatcher,
      });

      if (!response.ok) {
        throw new Error(`Update endpoint responded with status ${response.status}`);
      }

      // Aquecimento roda em segundo plano — não atrasa a resposta desse endpoint
      void this.runWarmup(dashboard.streamlitPort, dashboard.warmupMode, dashboard.warmupPaths ?? []);

      await this.prisma.dashboard.update({
        where: { id },
        data: { lastUpdateStatus: 'ok' },
      });

      return { ok: true, updatedAt };
    } catch (err) {
      await this.prisma.dashboard.update({
        where: { id },
        data: { lastUpdateStatus: 'error' },
      }).catch(() => {});
      throw err;
    }
  }

  private async runWarmup(port: number, mode: string, manualPaths: string[]) {
    if (mode === 'disabled') return;

    let paths = manualPaths;
    if (mode === 'auto') {
      try {
        const discovered = await this.discoverWarmablePaths(port);
        if (discovered.length > 0) paths = discovered;
      } catch (err) {
        this.logger.warn(`Descoberta automática de rotas falhou, usando lista manual: ${err}`);
      }
    }

    // Uma de cada vez, com intervalo — evita metralhar o app com dezenas de
    // requisições simultâneas numa VM com RAM limitada.
    for (const path of paths) {
      const warmupUrl = `http://localhost:${port}${path}`;
      await fetch(warmupUrl, { signal: AbortSignal.timeout(30 * 1000) }).catch(() => {});
      await sleep(WARMUP_STAGGER_MS);
    }
  }

  private async discoverWarmablePaths(port: number): Promise<string[]> {
    const response = await fetch(`http://localhost:${port}/openapi.json`, {
      signal: AbortSignal.timeout(10 * 1000),
    });
    if (!response.ok) {
      throw new Error(`openapi.json respondeu ${response.status}`);
    }

    const spec = (await response.json()) as { paths?: Record<string, Record<string, unknown>> };
    const paths = spec.paths ?? {};

    return Object.entries(paths)
      .filter(([path, methods]) => !path.includes('{') && Object.keys(methods).some((m) => m.toLowerCase() === 'get'))
      .map(([path]) => path);
  }

  async delete(id: string): Promise<void> {
    await this.stopStreamlit(id).catch(() => {});
    await rm(dashboardRoot(id), { recursive: true, force: true });
    await this.prisma.dashboard.delete({ where: { id } });
  }

  async saveFile(dashboardId: string, filename: string, buffer: Buffer): Promise<void> {
    const dir = dashboardRoot(dashboardId);
    await mkdir(dir, { recursive: true });
    if (filename.endsWith('.zip')) {
      const zip = new AdmZip(buffer);
      zip.extractAllTo(dir, true);
    } else {
      await writeFile(join(dir, filename), buffer);
    }
  }

  private async allocatePort(): Promise<number | null> {
    const used = await this.prisma.dashboard.findMany({
      where: { streamlitPort: { not: null } },
      select: { streamlitPort: true },
    });
    const usedPorts = new Set(used.map((d) => d.streamlitPort));
    for (let p = PORT_START; p <= PORT_END; p++) {
      if (!usedPorts.has(p) && await isPortFree(p)) return p;
    }
    return null;
  }

  private killProcess(proc: ChildProcess) {
    const pid = proc.pid;
    if (pid && process.platform === 'win32') {
      try { require('node:child_process').execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' }); } catch { /* ignore */ }
    } else {
      try { proc.kill(); } catch { /* ignore */ }
    }
  }

  private setupProxy(dashboardId: string, port: number, slug?: string) {
    const proxy = createProxyMiddleware({
      target: `http://localhost:${port}`,
      changeOrigin: true,
      ws: true,
      proxyTimeout: 20 * 60 * 1000,
      ...(slug ? { pathRewrite: { [`^/d/${slug}`]: '' } } : {}),
      on: {
        proxyReq: (proxyReq, req) => {
          const user = (req as unknown as Record<string, unknown>).hubUser as { name?: string; email?: string } | undefined;
          if (user?.name) proxyReq.setHeader('X-Hub-User-Name', user.name);
          if (user?.email) proxyReq.setHeader('X-Hub-User-Email', user.email);
          fixRequestBody(proxyReq, req);
        },
        proxyRes: (proxyRes) => {
          // Respostas SSE (ex.: POST /chatkit dos BIs, que mandam sinal de vida
          // a cada 15s): sem esses cabeçalhos, proxies à frente do hub (IIS/ARR,
          // nginx etc.) podem reter a resposta até o fim e o navegador desiste
          // por falta de eventos. O BI em si não manda esses cabeçalhos.
          if (String(proxyRes.headers['content-type'] ?? '').toLowerCase().includes('text/event-stream')) {
            proxyRes.headers['cache-control'] = 'no-cache, no-store, no-transform';
            proxyRes.headers['x-accel-buffering'] = 'no';
          }
          if (!slug) return;
          const loc = proxyRes.headers['location'];
          if (typeof loc === 'string' && loc.startsWith('/') && !loc.startsWith(`/d/${slug}`)) {
            proxyRes.headers['location'] = `/d/${slug}${loc}`;
          }
        },
        error: (err, _req, res) => {
          this.logger.warn(`Proxy error [${dashboardId}]: ${(err as Error).message}`);
          const sr = res as import('node:http').ServerResponse;
          if (!sr.headersSent) {
            sr.writeHead(502, { 'Content-Type': 'application/json' });
            sr.end(JSON.stringify({ statusCode: 502, message: 'Dashboard indisponível.' }));
          }
        },
      },
    });
    this.proxies.set(dashboardId, proxy);
    return proxy;
  }

  async startStreamlit(id: string): Promise<Dashboard> {
    const dashboard = await this.prisma.dashboard.findUniqueOrThrow({ where: { id } });
    if (dashboard.type !== DashboardType.streamlit) throw new Error('Not a Streamlit dashboard');

    // Kill existing process
    const existing = this.processes.get(id);
    if (existing) {
      this.intentionalStops.add(id);
      this.killProcess(existing);
      this.processes.delete(id);
    }

    let port = dashboard.streamlitPort;
    if (!port) {
      port = await this.allocatePort();
      if (!port) throw new Error('No ports available (8500–8599 all in use)');
    }

    const dir = dashboard.serverWorkingDirectory ?? dashboardRoot(id);
    const mainFile = dashboard.mainFile ?? 'app.py';

    if (!dashboard.serverWorkingDirectory && !existsSync(join(dir, mainFile))) {
      throw new Error(`Arquivo principal "${mainFile}" não encontrado. Faça o upload primeiro ou informe o diretório do projeto.`);
    }

    const slug = dashboard.slug;
    const proc = spawn('python', [
      '-m', 'streamlit', 'run', mainFile,
      '--server.port', String(port),
      '--server.headless', 'true',
      '--server.enableCORS', 'false',
      '--server.enableXsrfProtection', 'false',
      '--server.baseUrlPath', `/d/${slug}`,
    ], { cwd: dir, shell: false });

    proc.stdout?.on('data', (d) => this.logger.log(`[streamlit:${slug}] ${String(d).trim()}`));
    proc.stderr?.on('data', (d) => {
      const line = String(d).trim();
      this.logger.warn(`[streamlit:${slug}] ${line}`);
      this.appendError(id, line);
    });
    proc.on('exit', (code) => {
      this.logger.log(`[streamlit:${slug}] exit ${code}`);
      this.processes.delete(id);
      this.proxies.delete(id);
      void this.prisma.dashboard.update({
        where: { id },
        data: { streamlitStatus: code === 0 ? 'stopped' : 'error' },
      }).catch(() => {});
      if (code !== 0) this.handleUnexpectedExit(id, slug, DashboardType.streamlit);
    });

    this.processes.set(id, proc);
    this.setupProxy(id, port);

    return this.prisma.dashboard.update({
      where: { id },
      data: { streamlitPort: port, streamlitStatus: 'running' },
    });
  }

  async startServer(id: string): Promise<Dashboard> {
    const dashboard = await this.prisma.dashboard.findUniqueOrThrow({ where: { id } });
    if (dashboard.type !== DashboardType.server) throw new Error('Not a server dashboard');
    if (!dashboard.serverCommand) throw new Error('serverCommand não configurado.');
    if (!dashboard.serverWorkingDirectory) throw new Error('serverWorkingDirectory não configurado.');

    const existing = this.processes.get(id);
    if (existing) {
      this.intentionalStops.add(id);
      this.killProcess(existing);
      this.processes.delete(id);
      await new Promise((r) => setTimeout(r, 500));
    }

    let port = dashboard.streamlitPort;
    if (!port) {
      port = await this.allocatePort();
      if (!port) throw new Error('No ports available (8500–8599 all in use)');
    }

    const command = dashboard.serverCommand.replace(/\{PORT\}/g, String(port));
    const slug = dashboard.slug;

    // If port is already bound (e.g. old process survived a hub restart), reconnect
    // instead of spawning a duplicate — the old process keeps running on that port.
    if (!(await isPortFree(port)) && !this.processes.has(id)) {
      this.logger.log(`[server:${slug}] Port ${port} already bound — reconnecting to existing process`);
      this.setupProxy(id, port, slug);
      return this.prisma.dashboard.update({
        where: { id },
        data: { streamlitPort: port, streamlitStatus: 'running' },
      });
    }

    const proc = spawn(command, [], {
      cwd: dashboard.serverWorkingDirectory,
      shell: true,
    });

    this.clearLastError(id);
    proc.stdout?.on('data', (d) => {
      const line = String(d).trim();
      this.logger.log(`[server:${slug}] ${line}`);
      this.appendError(id, line);
    });
    proc.stderr?.on('data', (d) => {
      const line = String(d).trim();
      this.logger.warn(`[server:${slug}] ${line}`);
      this.appendError(id, line);
    });
    proc.on('exit', (code) => {
      this.logger.log(`[server:${slug}] exit ${code}`);
      this.processes.delete(id);
      this.proxies.delete(id);
      void this.prisma.dashboard.update({
        where: { id },
        data: { streamlitStatus: code === 0 ? 'stopped' : 'error' },
      }).catch(() => {});
      if (code !== 0) this.handleUnexpectedExit(id, slug, DashboardType.server);
    });

    this.processes.set(id, proc);
    this.setupProxy(id, port, slug);

    return this.prisma.dashboard.update({
      where: { id },
      data: { streamlitPort: port, streamlitStatus: 'running' },
    });
  }

  async stopServer(id: string): Promise<Dashboard> {
    return this.stopStreamlit(id);
  }

  async stopStreamlit(id: string): Promise<Dashboard> {
    const proc = this.processes.get(id);
    if (proc) {
      this.intentionalStops.add(id);
      this.killProcess(proc);
      this.processes.delete(id);
    }
    this.proxies.delete(id);
    return this.prisma.dashboard.update({
      where: { id },
      data: { streamlitStatus: 'stopped' },
    });
  }

  isRunning(id: string): boolean {
    return this.processes.has(id) || this.proxies.has(id);
  }

  getProxy(id: string) {
    return this.proxies.get(id) as (ReturnType<typeof createProxyMiddleware>) | undefined;
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = req.url ?? '';
    // Extract slug from /d/<slug>/...
    const match = url.match(/^\/d\/([^/]+)/);
    if (!match) return;
    const slug = match[1];
    // Find running dashboard by slug (sync lookup in process map)
    for (const [id, proxy] of this.proxies) {
      void this.prisma.dashboard.findUnique({ where: { id } }).then((d) => {
        if (d?.slug === slug) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (proxy as any).upgrade?.(req, socket, head);
        }
      });
    }
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}
