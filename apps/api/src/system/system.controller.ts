import { Body, Controller, ForbiddenException, Get, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { AuthService } from '../auth/auth.service';
import { ExecutionRunnerService } from '../executions/execution-runner.service';
import { ExecutionsService } from '../executions/executions.service';
import { RetentionService } from '../maintenance/retention.service';
import { isAdmin } from '../shared/access';
import { storageRoot } from '../shared/storage';
import { readDeployLast, readDeployPendingSync, writeDeployPending } from './deploy-state';
import { SystemService } from './system.service';

@ApiTags('Sistema')
@ApiBearerAuth()
@Controller('system')
export class SystemController {
  constructor(
    private readonly systemService: SystemService,
    private readonly authService: AuthService,
    private readonly retentionService: RetentionService,
    private readonly executionsService: ExecutionsService,
    private readonly executionRunnerService: ExecutionRunnerService,
  ) {}

  @Get('settings')
  async getSettings(@Req() req: Request) {
    const user = await this.authService.requireUser(req);
    if (!isAdmin(user)) throw new ForbiddenException();
    return this.systemService.getSettings();
  }

  @Patch('settings')
  async updateSettings(@Req() req: Request, @Body() body: Record<string, number>) {
    const user = await this.authService.requireUser(req);
    if (!isAdmin(user)) throw new ForbiddenException();
    return this.systemService.updateSettings(body);
  }

  @Get('storage-size')
  async getStorageSize(@Req() req: Request) {
    const user = await this.authService.requireUser(req);
    if (!isAdmin(user)) throw new ForbiddenException();
    const bytes = await getFolderSize(storageRoot);
    return { bytes, mb: Math.round(bytes / 1024 / 1024) };
  }

  @Get('browse-dir')
  async browseDir(@Req() req: Request, @Query('path') path?: string) {
    const user = await this.authService.requireUser(req);
    if (!isAdmin(user)) throw new ForbiddenException();
    return this.systemService.browseDir(path || undefined);
  }

  // Auto deploy: atualização da API esperando as execuções terminarem (ver deploy-state.ts).
  @Get('deploy')
  async getDeploy(@Req() req: Request) {
    const user = await this.authService.requireUser(req);
    if (!isAdmin(user)) throw new ForbiddenException();
    const pending = readDeployPendingSync();
    const last = await readDeployLast();
    if (!pending) return { pending: null, running: [], queued: 0, last };
    const [running, queued] = await Promise.all([
      this.executionsService.listRunningExecutions(),
      this.executionsService.listQueuedExecutions(200),
    ]);
    return {
      pending,
      running: running.map((e) => ({ id: e.id, robotName: e.robot.name, startedAt: e.startedAt })),
      queued: queued.length,
      last,
    };
  }

  // "Atualizar agora": cancela o que está rodando e libera o servidor pra reiniciar já.
  @Post('deploy/force')
  async forceDeploy(@Req() req: Request) {
    const user = await this.authService.requireUser(req);
    if (!isAdmin(user)) throw new ForbiddenException();
    const pending = readDeployPendingSync();
    if (!pending) return { forced: false, cancelled: 0 };
    const running = await this.executionsService.listRunningExecutions();
    let cancelled = 0;
    for (const execution of running) {
      try {
        await this.executionsService.cancel(execution.id, user);
        await this.executionRunnerService.stopExecution(execution.id);
        await this.executionsService.log(execution.id, 'warn', 'Execução cancelada: o administrador pediu para atualizar o servidor agora.');
        cancelled += 1;
      } catch {
        // uma execução que acabou de terminar não impede as outras
      }
    }
    await writeDeployPending({ ...pending, force: true, forcedBy: user.name });
    return { forced: true, cancelled };
  }

  @Post('sweep')
  async triggerSweep(@Req() req: Request) {
    const user = await this.authService.requireUser(req);
    if (!isAdmin(user)) throw new ForbiddenException();
    void this.retentionService.sweep();
    return { triggered: true };
  }
}

async function getFolderSize(dir: string): Promise<number> {
  const { readdir } = await import('node:fs/promises');
  let total = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          total += await getFolderSize(full);
        } else {
          const s = await stat(full).catch(() => null);
          if (s) total += s.size;
        }
      }),
    );
  } catch { /* pasta não existe */ }
  return total;
}
