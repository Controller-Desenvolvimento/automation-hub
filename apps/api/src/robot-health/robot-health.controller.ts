import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { RobotHealthService } from './robot-health.service';

@ApiTags('Saúde dos robôs')
@ApiBearerAuth()
@Controller('robot-health')
export class RobotHealthController {
  constructor(
    private readonly robotHealthService: RobotHealthService,
    private readonly authService: AuthService,
  ) {}

  // Só administradores (inclui a Inovação); os demais recebem 404.
  @Get()
  async overview(@Req() request: Request, @Query() query: Record<string, unknown>) {
    const user = await this.authService.requireUser(request);
    return this.robotHealthService.overview(user, query);
  }
}
