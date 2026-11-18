import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { supportUploadLimits } from '../shared/upload';
import { SupportService, type SupportUpload } from './support.service';

@ApiTags('Suporte')
@ApiBearerAuth()
@Controller('support')
export class SupportController {
  constructor(
    private readonly supportService: SupportService,
    private readonly authService: AuthService,
  ) {}

  @Get('options')
  async options(@Req() request: Request) {
    const user = await this.authService.requireUser(request);
    return this.supportService.options(user);
  }

  @Get('summary')
  async summary(@Req() request: Request) {
    const user = await this.authService.requireUser(request);
    return this.supportService.summary(user);
  }

  @Get('tickets')
  async list(@Req() request: Request) {
    const user = await this.authService.requireUser(request);
    return this.supportService.list(user);
  }

  // Rotas fixas ANTES das de ":id".
  @Post('tickets/merge')
  async merge(@Req() request: Request, @Body() body: Record<string, unknown>) {
    const user = await this.authService.requireUser(request);
    return this.supportService.merge(user, body);
  }

  @Post('tickets')
  @UseInterceptors(FilesInterceptor('files', 5, supportUploadLimits))
  async create(
    @Req() request: Request,
    @Body() body: Record<string, unknown>,
    @UploadedFiles() files: SupportUpload[] = [],
  ) {
    const user = await this.authService.requireUser(request);
    return this.supportService.create(user, body, files);
  }

  @Get('tickets/:id')
  async get(@Param('id') id: string, @Req() request: Request) {
    const user = await this.authService.requireUser(request);
    return this.supportService.get(id, user);
  }

  @Post('tickets/:id/messages')
  @UseInterceptors(FilesInterceptor('files', 5, supportUploadLimits))
  async addMessage(
    @Param('id') id: string,
    @Req() request: Request,
    @Body() body: Record<string, unknown>,
    @UploadedFiles() files: SupportUpload[] = [],
  ) {
    const user = await this.authService.requireUser(request);
    return this.supportService.addMessage(id, user, body, files);
  }

  @Patch('tickets/:id')
  async update(@Param('id') id: string, @Req() request: Request, @Body() body: Record<string, unknown>) {
    const user = await this.authService.requireUser(request);
    return this.supportService.update(id, user, body);
  }

  @Post('tickets/:id/confirm')
  async confirm(@Param('id') id: string, @Req() request: Request) {
    const user = await this.authService.requireUser(request);
    return this.supportService.confirm(id, user);
  }

  @Post('tickets/:id/reopen')
  async reopen(@Param('id') id: string, @Req() request: Request) {
    const user = await this.authService.requireUser(request);
    return this.supportService.reopen(id, user);
  }

  @Post('tickets/:id/unlink')
  async unlink(@Param('id') id: string, @Req() request: Request) {
    const user = await this.authService.requireUser(request);
    return this.supportService.unlink(id, user);
  }
}
