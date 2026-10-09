import {
  Body, Controller, Delete, ForbiddenException, Get, NotFoundException,
  Param, Patch, Post, Req, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { memoryStorage } from 'multer';
import { AuthService } from '../auth/auth.service';
import { canAccessDashboard, isAdmin, normalizeDepartments } from '../shared/access';
import { DashboardService } from './dashboard.service';
import { DashboardType, UserRole } from '@prisma/client';

type UploadedFile = {
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
};

const uploadConfig = { storage: memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } };

function parseWarmupMode(value: unknown): 'disabled' | 'manual' | 'auto' {
  return value === 'disabled' || value === 'auto' ? value : 'manual';
}

@ApiTags('Painéis (Dashboards)')
@ApiBearerAuth()
@Controller('dashboards')
export class DashboardController {
  constructor(
    private readonly svc: DashboardService,
    private readonly authService: AuthService,
  ) {}

  @Get()
  async list(@Req() req: Request) {
    const user = await this.authService.requireUser(req);
    const all = await (isAdmin(user) ? this.svc.findAll() : this.svc.findAllActive());
    return all.filter((d) => canAccessDashboard(user, d)).map((d) => ({
      ...d,
      streamlitRunning: (d.type === DashboardType.streamlit || d.type === DashboardType.server)
        ? this.svc.isRunning(d.id)
        : null,
    }));
  }

  @Post()
  @UseInterceptors(FileInterceptor('file', uploadConfig))
  async create(
    @Req() req: Request,
    @Body() body: { slug: string; name: string; description?: string; type?: string; isActive?: boolean | string; allowedDepartments?: string | string[]; minRole?: string; allowedUserIds?: string | string[]; mainFile?: string; serverCommand?: string; serverWorkingDirectory?: string; updatePath?: string; warmupPaths?: string | string[]; warmupMode?: string; updateFrequency?: string; updateTimesOfDay?: string | string[]; updateDayOfWeek?: string | number; updateDayOfMonth?: string | number },
    @UploadedFile() file?: UploadedFile,
  ) {
    const user = await this.authService.requireUser(req);
    if (!isAdmin(user)) throw new ForbiddenException();

    const type = body.type === 'streamlit' ? DashboardType.streamlit
               : body.type === 'server' ? DashboardType.server
               : DashboardType.html;
    const departments = body.allowedDepartments
      ? (Array.isArray(body.allowedDepartments) ? body.allowedDepartments : JSON.parse(body.allowedDepartments as string) as string[])
      : [];
    const allowedUserIds = normalizeDepartments(
      body.allowedUserIds
        ? (Array.isArray(body.allowedUserIds) ? body.allowedUserIds : JSON.parse(body.allowedUserIds as string))
        : [],
    );
    const isActive = body.isActive === undefined ? true : body.isActive === 'false' ? false : Boolean(body.isActive);
    const warmupPaths = body.warmupPaths
      ? (Array.isArray(body.warmupPaths) ? body.warmupPaths : JSON.parse(body.warmupPaths as string) as string[])
      : undefined;
    const updateTimesOfDay = body.updateTimesOfDay
      ? (Array.isArray(body.updateTimesOfDay) ? body.updateTimesOfDay : JSON.parse(body.updateTimesOfDay as string) as string[])
      : undefined;

    const dashboard = await this.svc.create({
      slug: body.slug,
      name: body.name,
      description: body.description,
      type,
      isActive,
      allowedDepartments: departments,
      minRole: body.minRole === 'manager' ? UserRole.manager : UserRole.employee,
      allowedUserIds,
      mainFile: body.mainFile,
      serverCommand: body.serverCommand,
      serverWorkingDirectory: body.serverWorkingDirectory,
      updatePath: body.updatePath,
      warmupPaths,
      warmupMode: parseWarmupMode(body.warmupMode),
      updateFrequency: body.updateFrequency,
      updateTimesOfDay,
      updateDayOfWeek: body.updateDayOfWeek !== undefined ? Number(body.updateDayOfWeek) : undefined,
      updateDayOfMonth: body.updateDayOfMonth !== undefined ? Number(body.updateDayOfMonth) : undefined,
    });

    if (file?.buffer) {
      const fname = file.originalname ?? 'upload';
      await this.svc.saveFile(dashboard.id, fname, file.buffer);
      if (!body.mainFile && !fname.endsWith('.zip')) {
        await this.svc.update(dashboard.id, { mainFile: fname });
      }
    }

    return dashboard;
  }

  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { name?: string; description?: string; isActive?: boolean; allowedDepartments?: string[]; minRole?: string; allowedUserIds?: string[]; mainFile?: string; serverCommand?: string; serverWorkingDirectory?: string; updatePath?: string; warmupPaths?: string[]; warmupMode?: string; updateFrequency?: string; updateTimesOfDay?: string[]; updateDayOfWeek?: number; updateDayOfMonth?: number },
  ) {
    const user = await this.authService.requireUser(req);
    if (!isAdmin(user)) throw new ForbiddenException();
    const d = await this.svc.findById(id);
    if (!d) throw new NotFoundException();
    return this.svc.update(id, {
      ...body,
      minRole: body.minRole === undefined ? undefined : body.minRole === 'manager' ? UserRole.manager : UserRole.employee,
      allowedUserIds: body.allowedUserIds === undefined ? undefined : normalizeDepartments(body.allowedUserIds),
      warmupMode: body.warmupMode === undefined ? undefined : parseWarmupMode(body.warmupMode),
    });
  }

  @Post(':id/update')
  async triggerUpdate(@Req() req: Request, @Param('id') id: string) {
    await this.authService.requireUser(req);
    const d = await this.svc.findById(id);
    if (!d) throw new NotFoundException();
    try {
      return await this.svc.triggerUpdate(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Update failed';
      const cause = err instanceof Error && err.cause ? ` (causa: ${String(err.cause)})` : '';
      throw new Error(`${message}${cause}`, { cause: err instanceof Error ? err.cause : undefined });
    }
  }

  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string) {
    const user = await this.authService.requireUser(req);
    if (!isAdmin(user)) throw new ForbiddenException();
    const d = await this.svc.findById(id);
    if (!d) throw new NotFoundException();
    await this.svc.delete(id);
    return { deleted: true };
  }

  @Post(':id/upload')
  @UseInterceptors(FileInterceptor('file', uploadConfig))
  async uploadFile(
    @Req() req: Request,
    @Param('id') id: string,
    @UploadedFile() file: UploadedFile,
  ) {
    const user = await this.authService.requireUser(req);
    if (!isAdmin(user)) throw new ForbiddenException();
    const d = await this.svc.findById(id);
    if (!d) throw new NotFoundException();
    if (!file?.buffer) throw new NotFoundException('No file uploaded.');
    const fname = file.originalname ?? 'upload';
    await this.svc.saveFile(id, fname, file.buffer);
    if (!fname.endsWith('.zip')) {
      await this.svc.update(id, { mainFile: fname });
    }
    return { uploaded: fname };
  }

  @Get(':id/status')
  async status(@Req() req: Request, @Param('id') id: string) {
    await this.authService.requireUser(req);
    const d = await this.svc.findById(id);
    if (!d) throw new NotFoundException();
    return {
      running: this.svc.isRunning(d.id),
      streamlitStatus: d.streamlitStatus,
      lastLog: this.svc.getLastError(d.id),
    };
  }

  @Post(':id/start')
  async start(@Req() req: Request, @Param('id') id: string) {
    const user = await this.authService.requireUser(req);
    if (!isAdmin(user)) throw new ForbiddenException();
    const d = await this.svc.findById(id);
    if (!d) throw new NotFoundException();
    if (d.type === DashboardType.server) return this.svc.startServer(id);
    return this.svc.startStreamlit(id);
  }

  @Post(':id/stop')
  async stop(@Req() req: Request, @Param('id') id: string) {
    const user = await this.authService.requireUser(req);
    if (!isAdmin(user)) throw new ForbiddenException();
    const d = await this.svc.findById(id);
    if (!d) throw new NotFoundException();
    if (d.type === DashboardType.server) return this.svc.stopServer(id);
    return this.svc.stopStreamlit(id);
  }
}
