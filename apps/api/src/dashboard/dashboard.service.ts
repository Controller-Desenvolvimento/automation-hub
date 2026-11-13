import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Dashboard, DashboardType, UserRole } from '@prisma/client';
import AdmZip from 'adm-zip';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { ChildProcess, execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent, fetch as undiciFetch } from 'undici';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { resolveHubBaseUrl } from '../mail/scheduled-execution-alert';
import { describeUpdateError, getRetryDelayMs } from './update-policy';
import { headerSafe } from '../shared/header-value';
import { panelProcessEnv } from '../shared/panel-env';
import { WINDOWS_HIDE } from '../shared/process-options';
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

// Pastas que o "Reiniciar" não percorre ao limpar o cache do Python (grandes e sem __pycache__ do painel).
const PYCACHE_SKIP_DIRS = new Set(['node_modules', '.git', 'venv', '.venv', 'env', 'site-packages', 'data', 'dados']);
const PYCACHE_MAX_DEPTH = 6;
const PYCACHE_MAX_DIRS = 5000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Já existe uma atualização em andamento para este painel (clique duplo, agendador junto com o botão...).
export class UpdateInProgressError extends Error {
  constructor() {
    super('Já existe uma atualização em andamento para este painel.');
    this.name = 'UpdateInProgressError';
  }
}

interface ProxyUpdateTracker {
  readonly done: boolean;
  finish(statusCode: number | undefined, errorText?: string): Promise<void>;
  abort(): Promise<void>;
}

// Rede de segurança: se nem o fim nem o erro do "Atualizar" de dentro do painel forem vistos pelo proxy,
// a marca de "atualizando" é solta depois disso (o proxy já corta a conexão em 20 min).
const PROXY_UPDATE_SAFETY_MS = 35 * 60 * 1000;

function pathOnly(path: string | undefined): string {
  return (path ?? '').split('?')[0].replace(/\/+$/, '');
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

  // A saída de um processo que já foi parado ou substituído (Parar, Reiniciar, Iniciar por cima) chega
  // DEPOIS, de forma assíncrona. Se ela mexesse no estado, apagaria o processo/proxy do processo novo e
  // gravaria "erro" no banco por cima do "rodando". Quem parou/substituiu já cuidou do estado.
  private isSupersededExit(id: string, proc: ChildProcess): boolean {
    if (this.processes.get(id) === proc) return false;
    this.intentionalStops.delete(id);
    return true;
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

  // Painéis com atualização em curso (programada, botão do Hub ou "Atualizar" de dentro do painel).
  private readonly updating = new Set<string>();
  // updatePath de cada painel, para o proxy reconhecer o "Atualizar" de dentro do painel sem ir ao banco a cada POST.
  private readonly updatePaths = new Map<string, string | null>();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly mailService?: MailService,
  ) {}

  isUpdating(id: string): boolean {
    return this.updating.has(id);
  }

  async onModuleInit() {
    await mkdir(dashboardsRoot, { recursive: true });
    try {
      const all = await this.prisma.dashboard.findMany({ select: { id: true, updatePath: true } });
      for (const d of all) this.updatePaths.set(d.id, d.updatePath ?? null);
      // Uma atualização que estava rodando quando o Hub reiniciou nunca termina: sem isto o selo ficaria em
      // "Atualizando..." para sempre. Como não conta como concluída, a atualização programada a retoma.
      await this.prisma.dashboard.updateMany({
        where: { lastUpdateStatus: 'running' },
        data: { lastUpdateStatus: 'error', lastUpdateError: 'Atualização interrompida: o Hub foi reiniciado enquanto ela rodava.' },
      });
    } catch (err) {
      this.logger.warn(`Preparação das atualizações de painel falhou: ${String(err)}`);
    }
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
    aiTracing?: boolean;
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
        aiTracing: dto.aiTracing ?? false,
      },
    });
    this.updatePaths.set(dashboard.id, dashboard.updatePath ?? null);
    await mkdir(dashboardRoot(dashboard.id), { recursive: true });
    return dashboard;
  }

  update(id: string, dto: Partial<Pick<Dashboard, 'name' | 'description' | 'isActive' | 'allowedDepartments' | 'minRole' | 'allowedUserIds' | 'mainFile' | 'serverCommand' | 'serverWorkingDirectory' | 'updatePath' | 'warmupPaths' | 'warmupMode' | 'updateFrequency' | 'updateTimesOfDay' | 'updateDayOfWeek' | 'updateDayOfMonth' | 'aiTracing'>>): Promise<Dashboard> {
    return this.prisma.dashboard.update({ where: { id }, data: dto }).then((updated) => {
      this.updatePaths.set(id, updated.updatePath ?? null);
      return updated;
    });
  }

  async triggerUpdate(id: string): Promise<{ ok: true; updatedAt: Date }> {
    const dashboard = await this.prisma.dashboard.findUniqueOrThrow({ where: { id } });

    if (!dashboard.updatePath) {
      throw new Error('updatePath is not configured for this dashboard');
    }
    if (this.updating.has(id)) throw new UpdateInProgressError();
    this.updating.add(id);

    // "Atualizado há..." conta a partir do FIM da atualização (antes contava do início, e uma atualização longa
    // já nascia "velha"). Falhas também gravam o horário, que é o do último ponto em que o painel foi tentado.
    await this.prisma.dashboard.update({ where: { id }, data: { lastUpdateStatus: 'running' } });

    let bodySnippet: string | undefined;
    try {
      if (!dashboard.streamlitPort) {
        throw new Error('O painel não está em execução (sem porta); inicie-o em Configurações → Painéis.');
      }
      const updateUrl = `http://localhost:${dashboard.streamlitPort}${dashboard.updatePath}`;
      const response = await undiciFetch(updateUrl, {
        method: 'POST',
        signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
        dispatcher: updateDispatcher,
      });

      if (!response.ok) {
        // O corpo costuma dizer a causa (ex.: {"detail": "..."}); lê só um pedaço, sem derrubar nada se falhar.
        bodySnippet = await response.text().then((t) => t.slice(0, 600)).catch(() => undefined);
        throw new Error(`Update endpoint responded with status ${response.status}`);
      }

      // Aquecimento roda em segundo plano — não atrasa a resposta desse endpoint
      void this.runWarmup(dashboard.streamlitPort, dashboard.warmupMode, dashboard.warmupPaths ?? []);

      const updatedAt = new Date();
      await this.prisma.dashboard.update({
        where: { id },
        data: { lastUpdateStatus: 'ok', lastUpdateAt: updatedAt, lastUpdateError: null, updateRetryAt: null },
      });

      return { ok: true, updatedAt };
    } catch (err) {
      await this.prisma.dashboard.update({
        where: { id },
        data: { lastUpdateStatus: 'error', lastUpdateAt: new Date(), lastUpdateError: describeUpdateError(err, bodySnippet) },
      }).catch(() => {});
      throw err;
    } finally {
      this.updating.delete(id);
    }
  }

  // Atualização PROGRAMADA (chamada pelo agendador). Tentativa 1 que falha agenda a tentativa 2 (padrão: 5 min
  // depois, gravada no banco para sobreviver a reinício). Tentativa 2 que falha manda UM e-mail à Inovação.
  // Atualização manual (botão do Hub ou "Atualizar" de dentro do painel) nunca passa por aqui: sem retry nem e-mail.
  async runScheduledUpdate(id: string, attempt: 1 | 2): Promise<'ok' | 'retry-scheduled' | 'failed' | 'skipped'> {
    if (this.updating.has(id)) return 'skipped';
    const before = await this.prisma.dashboard.findUnique({
      where: { id },
      select: { name: true, slug: true, lastUpdateAt: true, lastUpdateError: true },
    });
    if (!before) return 'skipped';
    // Já registra que a repetição está sendo feita agora, para o próximo ciclo do agendador não repeti-la.
    if (attempt === 2) await this.prisma.dashboard.update({ where: { id }, data: { updateRetryAt: null } });

    try {
      await this.triggerUpdate(id);
      return 'ok';
    } catch (err) {
      if (err instanceof UpdateInProgressError) return 'skipped';
      const after = await this.prisma.dashboard.findUnique({ where: { id }, select: { lastUpdateAt: true, lastUpdateError: true } });

      if (attempt === 1) {
        const retryAt = new Date(Date.now() + getRetryDelayMs());
        await this.prisma.dashboard.update({ where: { id }, data: { updateRetryAt: retryAt } });
        this.logger.warn(`Atualização programada de ${before.slug} falhou (${after?.lastUpdateError ?? String(err)}); nova tentativa às ${retryAt.toISOString()}.`);
        return 'retry-scheduled';
      }

      this.logger.warn(`Atualização programada de ${before.slug} falhou nas 2 tentativas: ${after?.lastUpdateError ?? String(err)}`);
      void this.mailService
        ?.sendPanelUpdateFailure({
          panelName: before.name,
          slug: before.slug,
          attempts: [
            { at: before.lastUpdateAt, error: before.lastUpdateError },
            { at: after?.lastUpdateAt ?? new Date(), error: after?.lastUpdateError ?? describeUpdateError(err) },
          ],
          baseUrl: resolveHubBaseUrl(),
        })
        .catch((mailErr: unknown) => this.logger.warn(`Alerta de e-mail do painel ${before.slug} falhou: ${String(mailErr)}`));
      return 'failed';
    }
  }

  // "Atualizar" de DENTRO do painel (POST no updatePath, pelo proxy /d/<slug>): não passa por triggerUpdate, então
  // antes o selo nunca mudava. O proxy chama isto ao ver o POST e finish()/abort() ao ver o fim da resposta.
  private trackProxyUpdate(id: string): ProxyUpdateTracker | null {
    if (this.updating.has(id)) return null; // já há outra atualização em curso: deixa passar sem mexer no estado
    this.updating.add(id);
    let done = false;
    const previous = this.prisma.dashboard.findUnique({ where: { id }, select: { lastUpdateStatus: true } }).catch(() => null);
    // O fim (finish/abort) espera esta gravação, para nunca chegar ao banco antes dela.
    const started = previous
      .then(() => this.prisma.dashboard.update({ where: { id }, data: { lastUpdateStatus: 'running' } }))
      .catch(() => undefined);

    const release = () => {
      done = true;
      this.updating.delete(id);
      clearTimeout(safety);
    };
    const safety = setTimeout(() => { if (!done) void tracker.abort(); }, PROXY_UPDATE_SAFETY_MS);
    safety.unref?.();

    const tracker: ProxyUpdateTracker = {
      get done() { return done; },
      // Resposta completa do painel: 2xx = atualizou; outro status = falhou (o motivo é o próprio código HTTP).
      finish: async (statusCode: number | undefined, errorText?: string) => {
        if (done) return;
        release();
        await started;
        const ok = typeof statusCode === 'number' && statusCode >= 200 && statusCode < 300;
        await this.prisma.dashboard.update({
          where: { id },
          data: ok
            ? { lastUpdateStatus: 'ok', lastUpdateAt: new Date(), lastUpdateError: null, updateRetryAt: null }
            : { lastUpdateStatus: 'error', lastUpdateAt: new Date(), lastUpdateError: errorText ?? `O painel respondeu ao "Atualizar" com o status ${statusCode ?? 'desconhecido'}.` },
        }).catch((err: unknown) => this.logger.warn(`Registro do "Atualizar" do painel ${id} falhou: ${String(err)}`));
      },
      // O navegador fechou antes do fim: não dá para saber o resultado, então volta o estado de antes.
      abort: async () => {
        if (done) return;
        release();
        await started;
        const prev = await previous;
        await this.prisma.dashboard.update({
          where: { id },
          data: { lastUpdateStatus: prev?.lastUpdateStatus ?? null },
        }).catch(() => undefined);
      },
    };
    return tracker;
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
      try { require('node:child_process').execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', windowsHide: WINDOWS_HIDE }); } catch { /* ignore */ }
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
        proxyReq: (proxyReq, req, res) => {
          const user =(req as unknown as Record<string, unknown>).hubUser as { name?: string; email?: string } | undefined;
          // headerSafe: um nome com "�" (acento perdido no Athenas) fazia setHeader lançar ERR_INVALID_CHAR
          // e derrubava TODO acesso do usuário aos painéis.
          if (user?.name) proxyReq.setHeader('X-Hub-User-Name', headerSafe(user.name));
          if (user?.email) proxyReq.setHeader('X-Hub-User-Email', headerSafe(user.email));
          // "Atualizar" de dentro do painel: POST no updatePath do painel → o selo do Hub passa a acompanhá-lo.
          const configuredPath = this.updatePaths.get(dashboardId);
          if (configuredPath && proxyReq.method === 'POST' && pathOnly(proxyReq.path) === pathOnly(configuredPath)) {
            const tracker = this.trackProxyUpdate(dashboardId);
            if (tracker) {
              (req as unknown as Record<string, unknown>).panelUpdateTracker = tracker;
              // Navegador que fecha antes de a resposta chegar: a biblioteca de proxy nem chama o tratador de erro
              // nesse caso, então é aqui, desde o começo, que se observa o fechamento. Se a resposta já terminou
              // (finish marcou "done"), isto não faz nada.
              (res as import('node:http').ServerResponse).on('close', () => { if (!tracker.done) void tracker.abort(); });
            }
          }
          fixRequestBody(proxyReq, req);
        },
        proxyRes: (proxyRes, req) => {
          const tracker = (req as unknown as Record<string, unknown>).panelUpdateTracker as ProxyUpdateTracker | undefined;
          if (tracker) {
            proxyRes.on('end', () => void tracker.finish(proxyRes.statusCode));
            // resposta cortada no meio, ou navegador que fechou antes do fim: resultado desconhecido
            proxyRes.on('close', () => { if (!proxyRes.complete) void tracker.abort(); });
          }
          // Respostas SSE (ex.: POST /chatkit dos BIs, que mandam sinal de vida
          // a cada 15s): sem esses cabeçalhos, proxies à frente do hub (IIS/ARR,
          // nginx etc.) podem reter a resposta até o fim e o navegador desiste
          // por falta de eventos. O BI em si não manda esses cabeçalhos.
          if (String(proxyRes.headers['content-type'] ?? '').toLowerCase().includes('text/event-stream')) {
            proxyRes.headers['cache-control'] = 'no-cache, no-store, no-transform';
            proxyRes.headers['x-accel-buffering'] = 'no';
          }
          // Os painéis servem os arquivos estáticos só com Last-Modified/ETag, sem Cache-Control. Nesse caso o
          // navegador "adivinha" quanto tempo reaproveitar (uma fração do tempo desde a última alteração: dias,
          // para um theme.js antigo) e nem Ctrl+F5 resolve, pois o painel vive num iframe criado por script.
          // `no-cache` = pode guardar, mas pergunta ao servidor se mudou (304 barato via ETag). Quem já manda
          // Cache-Control próprio continua valendo.
          if (!proxyRes.headers['cache-control']) proxyRes.headers['cache-control'] = 'no-cache';
          if (!slug) return;
          const loc = proxyRes.headers['location'];
          if (typeof loc === 'string' && loc.startsWith('/') && !loc.startsWith(`/d/${slug}`)) {
            proxyRes.headers['location'] = `/d/${slug}${loc}`;
          }
        },
        error: (err, req, res) => {
          this.logger.warn(`Proxy error [${dashboardId}]: ${(err as Error).message}`);
          const sr = res as import('node:http').ServerResponse;
          const tracker = (req as unknown as Record<string, unknown>).panelUpdateTracker as ProxyUpdateTracker | undefined;
          if (tracker) {
            // navegador que desistiu: resultado desconhecido; painel que não respondeu/caiu: falha de verdade
            if (sr.destroyed) void tracker.abort();
            else void tracker.finish(undefined, `Falha ao falar com o painel: ${(err as Error).message}`);
          }
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
    ], { cwd: dir, shell: false, windowsHide: WINDOWS_HIDE, env: panelProcessEnv(dashboard.aiTracing) });

    proc.stdout?.on('data', (d) => this.logger.log(`[streamlit:${slug}] ${String(d).trim()}`));
    proc.stderr?.on('data', (d) => {
      const line = String(d).trim();
      this.logger.warn(`[streamlit:${slug}] ${line}`);
      this.appendError(id, line);
    });
    proc.on('exit', (code) => {
      this.logger.log(`[streamlit:${slug}] exit ${code}`);
      if (this.isSupersededExit(id, proc)) return;
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
      windowsHide: WINDOWS_HIDE,   // sem isso cada painel abria uma janela de prompt na tela do servidor
      env: panelProcessEnv(dashboard.aiTracing),   // rastreamento da OpenAI desligado, salvo opção do painel
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
      if (this.isSupersededExit(id, proc)) return;
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

  /**
   * Reinício completo (botão "Reiniciar"): para o processo, garante que a porta ficou livre (matando
   * sobrevivente, se houver), limpa o cache do Python e sobe um processo NOVO — nunca reaproveita o antigo,
   * como o "Iniciar" faz quando a porta ainda está ocupada. O cache do navegador é tratado pelo controller
   * (Clear-Site-Data) e pelo proxy (Cache-Control: no-cache).
   */
  async restart(id: string): Promise<{ dashboard: Dashboard; pycacheRemovido: number; processoAntigoEncerrado: boolean }> {
    const dashboard = await this.prisma.dashboard.findUniqueOrThrow({ where: { id } });
    if (dashboard.type !== DashboardType.server && dashboard.type !== DashboardType.streamlit) {
      throw new Error('Só painéis de servidor/Streamlit têm processo para reiniciar.');
    }
    if (dashboard.type === DashboardType.server) {
      if (!dashboard.serverCommand) throw new Error('serverCommand não configurado.');
      if (!dashboard.serverWorkingDirectory) throw new Error('serverWorkingDirectory não configurado.');
    }

    await this.stopStreamlit(id);
    this.clearLastError(id);

    const port = dashboard.streamlitPort;
    const processoAntigoEncerrado = port ? await this.freePort(port) : false;

    const dir = dashboard.serverWorkingDirectory ?? dashboardRoot(id);
    const pycacheRemovido = await this.clearPyCache(dir);
    this.logger.log(`[restart:${dashboard.slug}] porta ${port ?? '-'} livre; ${pycacheRemovido} pasta(s) __pycache__ removida(s)`);

    const started = dashboard.type === DashboardType.server ? await this.startServer(id) : await this.startStreamlit(id);
    return { dashboard: started, pycacheRemovido, processoAntigoEncerrado };
  }

  /** Espera a porta liberar; se um processo antigo sobreviveu ao "parar", encerra quem a segura. true = precisou matar. */
  private async freePort(port: number): Promise<boolean> {
    for (let i = 0; i < 8; i++) {   // ~2,4s: o sistema leva um instante para soltar a porta de um processo recém-morto
      if (await isPortFree(port)) return false;
      await sleep(300);
    }
    if (port < PORT_START || port > PORT_END) {
      throw new Error(`A porta ${port} está ocupada e fora da faixa dos painéis (${PORT_START}–${PORT_END}); não vou encerrar quem a usa.`);
    }
    const pids = this.pidsListeningOn(port).filter((pid) => pid !== process.pid);
    for (const pid of pids) {
      this.logger.warn(`[restart] porta ${port} ainda ocupada pelo processo antigo ${pid} — encerrando`);
      try {
        if (process.platform === 'win32') execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', windowsHide: WINDOWS_HIDE });
        else process.kill(pid, 'SIGKILL');
      } catch { /* já morreu */ }
    }
    for (let i = 0; i < 20; i++) {
      if (await isPortFree(port)) return pids.length > 0;
      await sleep(300);
    }
    throw new Error(`A porta ${port} continua ocupada depois de encerrar o processo antigo. Veja quem a usa e tente de novo.`);
  }

  private pidsListeningOn(port: number): number[] {
    try {
      if (process.platform === 'win32') {
        const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: WINDOWS_HIDE });
        const pids = new Set<number>();
        for (const line of out.split(/\r?\n/)) {
          const cols = line.trim().split(/\s+/);
          // TCP  <local>  <remoto>  <estado>  <pid> — "escutando" = remoto zerado (o texto do estado muda com o idioma)
          if (cols.length < 5 || cols[0] !== 'TCP') continue;
          const remoto = cols[2];
          if (!cols[1].endsWith(`:${port}`) || !(remoto.endsWith(':0') && (remoto.startsWith('0.0.0.0') || remoto.startsWith('[::]')))) continue;
          const pid = Number(cols[cols.length - 1]);
          if (Number.isInteger(pid) && pid > 0) pids.add(pid);
        }
        return [...pids];
      }
      const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: WINDOWS_HIDE });
      return out.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    } catch {
      return [];
    }
  }

  /** Apaga as pastas __pycache__ do projeto do painel (o Python recompila tudo do código atual). */
  private async clearPyCache(root: string): Promise<number> {
    let removidas = 0;
    let visitadas = 0;
    const percorrer = async (dir: string, nivel: number): Promise<void> => {
      if (nivel > PYCACHE_MAX_DEPTH || visitadas > PYCACHE_MAX_DIRS) return;
      let entradas;
      try {
        entradas = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entradas) {
        if (!e.isDirectory()) continue;
        const caminho = join(dir, e.name);
        if (e.name === '__pycache__') {
          await rm(caminho, { recursive: true, force: true }).then(() => { removidas++; }).catch(() => {});
          continue;
        }
        if (PYCACHE_SKIP_DIRS.has(e.name.toLowerCase())) continue;
        visitadas++;
        await percorrer(caminho, nivel + 1);
      }
    };
    await percorrer(root, 0);
    return removidas;
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
