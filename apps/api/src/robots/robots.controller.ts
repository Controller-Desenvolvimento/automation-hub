import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { uploadLimits } from '../shared/upload';
import { RobotsSyncService } from './robots-sync.service';
import { RobotsService } from './robots.service';

type UploadedFile = {
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
};

@Controller('robots')
export class RobotsController {
  constructor(
    private readonly robotsService: RobotsService,
    private readonly authService: AuthService,
    private readonly robotsSyncService: RobotsSyncService,
  ) {}

  @Get('hub')
  async getHubOverview(@Req() request: Request) {
    const user = await this.authService.requireUser(request);
    return this.robotsService.getHubOverview(user);
  }

  @Get()
  async findAll(@Req() request: Request) {
    const user = await this.authService.requireUser(request);
    return this.robotsService.findAll(user);
  }

  @Get('sync/status')
  async getSyncStatus(@Req() request: Request) {
    const user = await this.authService.requireUser(request);
    this.authService.ensureAdmin(user);
    return this.robotsSyncService.getStatus();
  }

  @Post('sync')
  async triggerSync(@Req() request: Request) {
    const user = await this.authService.requireUser(request);
    this.authService.ensureAdmin(user);
    return this.robotsSyncService.sync();
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @Req() request: Request) {
    const user = await this.authService.requireUser(request);
    const robot = await this.robotsService.findOne(id, user);
    if (!robot) {
      throw new NotFoundException('Automação não encontrada.');
    }

    return robot;
  }

  @Post()
  async saveRobot(
    @Body() body: Record<string, unknown>,
    @Req() request: Request,
  ) {
    const user = await this.authService.requireUser(request);
    this.authService.ensureAdmin(user);

    return this.robotsService.saveRobot({
      id: typeof body.id === 'string' ? body.id : undefined,
      slug: typeof body.slug === 'string' ? body.slug : undefined,
      name: typeof body.name === 'string' ? body.name : undefined,
      summary: typeof body.summary === 'string' ? body.summary : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      category: typeof body.category === 'string' ? body.category : undefined,
      icon: typeof body.icon === 'string' ? body.icon : undefined,
      isActive: typeof body.isActive === 'boolean' ? body.isActive : true,
      version: typeof body.version === 'string' ? body.version : undefined,
      estimatedMinutes:
        typeof body.estimatedMinutes === 'number'
          ? body.estimatedMinutes
          : typeof body.estimatedMinutes === 'string' && body.estimatedMinutes
            ? Number(body.estimatedMinutes)
            : null,
      maxConcurrency:
        typeof body.maxConcurrency === 'number'
          ? body.maxConcurrency
          : typeof body.maxConcurrency === 'string' && body.maxConcurrency
            ? Number(body.maxConcurrency)
            : null,
      manualSecondsPerUnit:
        typeof body.manualSecondsPerUnit === 'number'
          ? body.manualSecondsPerUnit
          : typeof body.manualSecondsPerUnit === 'string' &&
              body.manualSecondsPerUnit
            ? Number(body.manualSecondsPerUnit)
            : null,
      unitLabel:
        typeof body.unitLabel === 'string' ? body.unitLabel : undefined,
      unitMetricKey:
        typeof body.unitMetricKey === 'string' ? body.unitMetricKey : undefined,
      conflictKeys:
        typeof body.conflictKeys === 'string' ? body.conflictKeys : undefined,
      isExternal: typeof body.isExternal === 'boolean' ? body.isExternal : body.isExternal === 'true',
      command: typeof body.command === 'string' ? body.command : undefined,
      workingDirectory:
        typeof body.workingDirectory === 'string'
          ? body.workingDirectory
          : undefined,
      allowedDepartments: body.allowedDepartments,
      schema:
        body.schema && typeof body.schema === 'object'
          ? (body.schema as Record<string, unknown>)
          : undefined,
      documentationUrl:
        typeof body.documentationUrl === 'string'
          ? body.documentationUrl
          : undefined,
      documentationLabel:
        typeof body.documentationLabel === 'string'
          ? body.documentationLabel
          : undefined,
      supportLabel:
        typeof body.supportLabel === 'string' ? body.supportLabel : undefined,
      supportValue:
        typeof body.supportValue === 'string' ? body.supportValue : undefined,
      dataPolicy:
        typeof body.dataPolicy === 'string' ? body.dataPolicy : undefined,
    });
  }

  @Post(':id/examples')
  @UseInterceptors(AnyFilesInterceptor(uploadLimits))
  async uploadInputExample(
    @Param('id') id: string,
    @Req() request: Request,
    @Body() body: Record<string, unknown>,
    @UploadedFiles() files: UploadedFile[] = [],
  ) {
    const user = await this.authService.requireUser(request);
    this.authService.ensureAdmin(user);

    return this.robotsService.addInputExample(
      id,
      {
        fileInputName:
          typeof body.fileInputName === 'string' ? body.fileInputName : undefined,
        title: typeof body.title === 'string' ? body.title : undefined,
        description:
          typeof body.description === 'string' ? body.description : undefined,
      },
      files[0],
    );
  }

  @Post(':id/scripts')
  @UseInterceptors(AnyFilesInterceptor(uploadLimits))
  async uploadScript(
    @Param('id') id: string,
    @Req() request: Request,
    @Body() body: Record<string, unknown>,
    @UploadedFiles() files: UploadedFile[] = [],
  ) {
    const user = await this.authService.requireUser(request);
    this.authService.ensureAdmin(user);

    return this.robotsService.uploadScript(
      id,
      typeof body.entryScript === 'string' ? body.entryScript : '',
      files[0],
    );
  }

  @Post(':id/api-key')
  async generateApiKey(@Param('id') id: string, @Req() request: Request) {
    const user = await this.authService.requireUser(request);
    this.authService.ensureAdmin(user);
    return this.robotsService.generateApiKey(id);
  }

  @Post(':id/favorite')
  async favoriteRobot(@Param('id') id: string, @Req() request: Request) {
    const user = await this.authService.requireUser(request);
    return this.robotsService.favoriteRobot(id, user);
  }

  @Delete(':id/favorite')
  async unfavoriteRobot(@Param('id') id: string, @Req() request: Request) {
    const user = await this.authService.requireUser(request);
    return this.robotsService.unfavoriteRobot(id, user);
  }

  @Delete(':id/api-key')
  async revokeApiKey(@Param('id') id: string, @Req() request: Request) {
    const user = await this.authService.requireUser(request);
    this.authService.ensureAdmin(user);
    return this.robotsService.revokeApiKey(id);
  }

  @Get(':id/pip-status')
  async getPipStatus(@Param('id') id: string, @Req() request: Request) {
    const user = await this.authService.requireUser(request);
    this.authService.ensureAdmin(user);
    return { status: this.robotsService.getPipStatus(id) };
  }

  @Delete(':id/examples/:exampleId')
  async deleteInputExample(
    @Param('id') id: string,
    @Param('exampleId') exampleId: string,
    @Req() request: Request,
  ) {
    const user = await this.authService.requireUser(request);
    this.authService.ensureAdmin(user);
    return this.robotsService.removeInputExample(id, exampleId);
  }

  @Delete(':id')
  async deleteRobot(@Param('id') id: string, @Req() request: Request) {
    const user = await this.authService.requireUser(request);
    this.authService.ensureAdmin(user);
    return this.robotsService.deleteRobot(id);
  }
}
