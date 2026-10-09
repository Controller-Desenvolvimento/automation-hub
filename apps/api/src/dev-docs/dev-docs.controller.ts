import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { DevDocsService } from './dev-docs.service';

@ApiTags('Dev Docs')
@ApiBearerAuth()
@Controller('dev-docs')
export class DevDocsController {
  constructor(
    private readonly service: DevDocsService,
    private readonly authService: AuthService,
  ) {}

  @Get()
  async findAll(@Req() req: Request) {
    await this.authService.requireUser(req);
    return this.service.findAll();
  }

  @Post()
  async create(
    @Req() req: Request,
    @Body()
    body: {
      title: string;
      category: string;
      summary: string;
      howToUse: string;
      codeExample?: string;
      language?: string;
      endpoint?: string;
      tags?: string[];
      order?: number;
    },
  ) {
    const user = await this.authService.requireUser(req);
    this.authService.ensureAdmin(user);
    return this.service.create(body);
  }

  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body()
    body: {
      title?: string;
      category?: string;
      summary?: string;
      howToUse?: string;
      codeExample?: string | null;
      language?: string | null;
      endpoint?: string | null;
      tags?: string[];
      order?: number;
    },
  ) {
    const user = await this.authService.requireUser(req);
    this.authService.ensureAdmin(user);
    return this.service.update(id, body);
  }

  @Delete(':id')
  async delete(@Req() req: Request, @Param('id') id: string) {
    const user = await this.authService.requireUser(req);
    this.authService.ensureAdmin(user);
    return this.service.delete(id);
  }
}
