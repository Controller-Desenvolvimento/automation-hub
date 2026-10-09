import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { UsersService } from './users.service';

@ApiTags('Usuários')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly authService: AuthService,
  ) {}

  @Get()
  async listUsers(@Req() request: Request) {
    const user = await this.authService.requireUser(request);
    this.authService.ensureAdmin(user);
    return this.usersService.listUsers();
  }

  @Get('unlinked-identities')
  async listUnlinkedIdentities(@Req() request: Request) {
    const user = await this.authService.requireUser(request);
    this.authService.ensureAdmin(user);
    return this.usersService.listUnlinkedIdentities();
  }

  @Post('unlinked-identities/link')
  async linkUnlinkedIdentity(
    @Body() body: { login?: unknown; userId?: unknown },
    @Req() request: Request,
  ) {
    const user = await this.authService.requireUser(request);
    this.authService.ensureAdmin(user);
    return this.usersService.linkUnlinkedIdentity(body);
  }

  @Post('unlinked-identities/ignore')
  async ignoreUnlinkedIdentity(
    @Body() body: { login?: unknown; name?: unknown },
    @Req() request: Request,
  ) {
    const user = await this.authService.requireUser(request);
    this.authService.ensureAdmin(user);
    return this.usersService.ignoreUnlinkedIdentity(body);
  }

  @Get('ignored-identities')
  async listIgnoredIdentities(@Req() request: Request) {
    const user = await this.authService.requireUser(request);
    this.authService.ensureAdmin(user);
    return this.usersService.listIgnoredIdentities();
  }

  @Post('ignored-identities/unignore')
  async unignoreIdentity(
    @Body() body: { login?: unknown },
    @Req() request: Request,
  ) {
    const user = await this.authService.requireUser(request);
    this.authService.ensureAdmin(user);
    return this.usersService.unignoreIdentity(body);
  }

  @Post()
  async createUser(
    @Body()
    body: { name?: unknown; email?: unknown; password?: unknown; role?: unknown; departments?: unknown },
    @Req() request: Request,
  ) {
    const user = await this.authService.requireUser(request);
    this.authService.ensureAdmin(user);
    return this.usersService.createUser(body);
  }

  @Patch(':id')
  async updateUser(
    @Param('id') id: string,
    @Body()
    body: {
      name?: unknown;
      password?: unknown;
      role?: unknown;
      departments?: unknown;
      isActive?: unknown;
    },
    @Req() request: Request,
  ) {
    const user = await this.authService.requireUser(request);
    this.authService.ensureAdmin(user);
    return this.usersService.updateUser(id, body);
  }
}
