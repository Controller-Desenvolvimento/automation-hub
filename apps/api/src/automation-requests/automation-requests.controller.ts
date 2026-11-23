import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { AutomationRequestsService } from './automation-requests.service';

@ApiTags('Solicitações de Automação')
@ApiBearerAuth()
@Controller('automation-requests')
export class AutomationRequestsController {
  constructor(
    private readonly automationRequestsService: AutomationRequestsService,
    private readonly authService: AuthService,
  ) {}

  @Get()
  async list(@Req() request: Request) {
    const user = await this.authService.requireUser(request);
    return this.automationRequestsService.listForUser(user);
  }

  // Rota fixa ANTES das de ":id".
  @Get('summary')
  async summary(@Req() request: Request) {
    const user = await this.authService.requireUser(request);
    return this.automationRequestsService.summary(user);
  }

  @Post()
  async create(@Req() request: Request, @Body() body: Record<string, unknown>) {
    const user = await this.authService.requireUser(request);
    return this.automationRequestsService.create(user, body);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Req() request: Request,
    @Body() body: Record<string, unknown>,
  ) {
    const user = await this.authService.requireUser(request);
    return this.automationRequestsService.update(id, user, body);
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() request: Request) {
    const user = await this.authService.requireUser(request);
    return this.automationRequestsService.remove(id, user);
  }
}
