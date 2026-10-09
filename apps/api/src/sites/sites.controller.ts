import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Post, Req, Res, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SiteCategory, UserRole } from '@prisma/client';
import type { Request, Response } from 'express';
import { normalizeDepartments } from '../shared/access';
import { AuthService } from '../auth/auth.service';
import { uploadLimits } from '../shared/upload';
import { PowerBIService } from './powerbi.service';
import { SitesService } from './sites.service';

type UploadedFile = {
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
};

@ApiTags('Sites e BI')
@ApiBearerAuth()
@Controller('sites')
export class SitesController {
  constructor(
    private readonly sitesService: SitesService,
    private readonly authService: AuthService,
    private readonly powerbiService: PowerBIService,
  ) {}

  @Get()
  async findAll(@Req() request: Request) {
    const user = await this.authService.requireUser(request);
    return this.sitesService.findAll(user);
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @Req() request: Request) {
    await this.authService.requireUser(request);
    const site = await this.sitesService.findOne(id);
    if (!site) {
      throw new NotFoundException('Site não encontrado.');
    }

    return site;
  }

  @Post()
  async saveSite(@Body() body: Record<string, unknown>, @Req() request: Request) {
    const user = await this.authService.requireUser(request);
    this.authService.ensureAdmin(user);

    return this.sitesService.saveSite({
      id: typeof body.id === 'string' ? body.id : undefined,
      name: typeof body.name === 'string' ? body.name : undefined,
      url: typeof body.url === 'string' ? body.url : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      category: body.category === 'bi' ? SiteCategory.bi : SiteCategory.sistema,
      maintenanceOverride: typeof body.maintenanceOverride === 'boolean' ? body.maintenanceOverride : undefined,
      order:
        typeof body.order === 'number'
          ? body.order
          : typeof body.order === 'string' && body.order
            ? Number(body.order)
            : undefined,
      allowedDepartments: normalizeDepartments(body.allowedDepartments),
      minRole: body.minRole === 'manager' ? UserRole.manager : UserRole.employee,
      powerbiGroupId: typeof body.powerbiGroupId === 'string' ? body.powerbiGroupId : null,
      powerbiDatasetId: typeof body.powerbiDatasetId === 'string' ? body.powerbiDatasetId : null,
      powerbiScheduledTimes: Array.isArray(body.powerbiScheduledTimes)
        ? (body.powerbiScheduledTimes as unknown[]).filter((t): t is string => typeof t === 'string')
        : [],
      powerbiShowRefresh: body.powerbiShowRefresh !== false && body.powerbiShowRefresh !== 'false',
      ssoEnabled: body.ssoEnabled === true || body.ssoEnabled === 'true',
      // undefined = não veio no corpo: o vínculo existente é preservado.
      linkedDashboardId:
        typeof body.linkedDashboardId === 'string'
          ? body.linkedDashboardId.trim() || null
          : body.linkedDashboardId === null
            ? null
            : undefined,
    });
  }

  @Delete(':id')
  async deleteSite(@Param('id') id: string, @Req() request: Request) {
    const user = await this.authService.requireUser(request);
    this.authService.ensureAdmin(user);
    return this.sitesService.deleteSite(id);
  }

  @Get('powerbi-refresh-logs')
  async getRefreshLogs(@Req() request: Request) {
    await this.authService.requireUser(request);
    return this.sitesService.findRefreshLogs();
  }

  @Post(':id/powerbi-refresh')
  async powerbiRefresh(@Param('id') id: string, @Req() request: Request) {
    const user = await this.authService.requireUser(request);
    const site = await this.sitesService.findOne(id);
    if (!site) throw new NotFoundException('Site não encontrado.');
    if (!site.powerbiDatasetId || !site.powerbiGroupId) {
      throw new BadRequestException('Este site não tem um dataset Power BI configurado.');
    }
    const requestId = await this.powerbiService.requestRefresh(site.powerbiGroupId, site.powerbiDatasetId);
    await this.sitesService.updatePowerBIStatus(id, 'Unknown', requestId);
    await this.sitesService.createRefreshLog(id, { name: user.name, email: user.email });
    return { success: true };
  }

  @Post(':id/check')
  async checkSite(@Param('id') id: string, @Req() request: Request) {
    const user = await this.authService.requireUser(request);
    this.authService.ensureAdmin(user);
    return this.sitesService.recheckSite(id);
  }

  @Get(':id/favicon')
  async getFavicon(@Param('id') id: string, @Req() request: Request, @Res() response: Response) {
    await this.authService.requireUser(request);
    const favicon = await this.sitesService.getFavicon(id);

    if (!favicon) {
      response.status(404).end();
      return;
    }

    response.setHeader('Content-Type', favicon.contentType);
    response.setHeader('Cache-Control', 'public, max-age=86400');
    response.send(favicon.buffer);
  }

  @Post(':id/favicon')
  @UseInterceptors(AnyFilesInterceptor(uploadLimits))
  async uploadFavicon(
    @Param('id') id: string,
    @Req() request: Request,
    @UploadedFiles() files: UploadedFile[] = [],
  ) {
    const user = await this.authService.requireUser(request);
    this.authService.ensureAdmin(user);
    return this.sitesService.saveFavicon(id, files[0]);
  }

  @Delete(':id/favicon')
  async deleteFavicon(@Param('id') id: string, @Req() request: Request) {
    const user = await this.authService.requireUser(request);
    this.authService.ensureAdmin(user);
    return this.sitesService.removeFavicon(id);
  }
}
