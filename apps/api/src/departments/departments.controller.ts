import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { DepartmentsService } from './departments.service';

@ApiTags('Departamentos')
@ApiBearerAuth()
@Controller('departments')
export class DepartmentsController {
  constructor(
    private readonly service: DepartmentsService,
    private readonly authService: AuthService,
  ) {}

  @Get()
  async findAll(@Req() req: Request) {
    await this.authService.requireUser(req);
    return this.service.findAll();
  }

  @Post()
  async create(@Req() req: Request, @Body() body: { name: string; slug?: string }) {
    const user = await this.authService.requireUser(req);
    this.authService.ensureAdmin(user);
    return this.service.create(body);
  }

  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { name?: string; isActive?: boolean; order?: number },
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
