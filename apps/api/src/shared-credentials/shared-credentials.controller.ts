import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { isAdmin } from '../shared/access';
import { SharedCredentialsService } from './shared-credentials.service';

@ApiTags('Credenciais Compartilhadas')
@ApiBearerAuth()
@Controller('shared-credentials')
export class SharedCredentialsController {
  constructor(
    private readonly service: SharedCredentialsService,
    private readonly authService: AuthService,
  ) {}

  @Get()
  async findAll(@Req() request: Request) {
    const user = await this.authService.requireUser(request);
    return this.service.findAll(user);
  }

  @Post()
  async create(@Req() request: Request, @Body() body: Record<string, unknown>) {
    const user = await this.authService.requireUser(request);
    if (!isAdmin(user)) throw new ForbiddenException();
    return this.service.create({
      name: String(body.name ?? ''),
      url: body.url ? String(body.url) : undefined,
      login: String(body.login ?? ''),
      password: String(body.password ?? ''),
      notes: body.notes ? String(body.notes) : undefined,
      allowedDepartments: Array.isArray(body.allowedDepartments) ? (body.allowedDepartments as string[]) : [],
      minRole: body.minRole === 'manager' ? 'manager' : 'employee',
      order: typeof body.order === 'number' ? body.order : 0,
    });
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Req() request: Request,
    @Body() body: Record<string, unknown>,
  ) {
    const user = await this.authService.requireUser(request);
    if (!isAdmin(user)) throw new ForbiddenException();
    return this.service.update(id, {
      ...(body.name !== undefined && { name: String(body.name) }),
      ...(body.url !== undefined && { url: body.url ? String(body.url) : null }),
      ...(body.login !== undefined && { login: String(body.login) }),
      ...(body.password !== undefined && { password: String(body.password) }),
      ...(body.notes !== undefined && { notes: body.notes ? String(body.notes) : null }),
      ...(Array.isArray(body.allowedDepartments) && { allowedDepartments: body.allowedDepartments as string[] }),
      ...(body.minRole !== undefined && { minRole: body.minRole === 'manager' ? 'manager' : 'employee' }),
      ...(typeof body.order === 'number' && { order: body.order }),
    });
  }

  @Delete(':id')
  async delete(@Param('id') id: string, @Req() request: Request) {
    const user = await this.authService.requireUser(request);
    if (!isAdmin(user)) throw new ForbiddenException();
    return this.service.delete(id);
  }
}
