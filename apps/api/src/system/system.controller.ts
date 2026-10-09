import { Body, Controller, ForbiddenException, Get, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { AuthService } from '../auth/auth.service';
import { RetentionService } from '../maintenance/retention.service';
import { isAdmin } from '../shared/access';
import { storageRoot } from '../shared/storage';
import { SystemService } from './system.service';

@ApiTags('Sistema')
@ApiBearerAuth()
@Controller('system')
export class SystemController {
  constructor(
    private readonly systemService: SystemService,
    private readonly authService: AuthService,
    private readonly retentionService: RetentionService,
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
