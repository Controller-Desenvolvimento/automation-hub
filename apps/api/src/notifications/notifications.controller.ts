import { Controller, Get, Param, Patch, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { NotificationsService } from './notifications.service';

@ApiTags('Notificações')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly authService: AuthService,
  ) {}

  @Get()
  async list(@Req() request: Request) {
    const user = await this.authService.requireUser(request);
    return this.notificationsService.listForUser(user.id);
  }

  @Get('unread-count')
  async unreadCount(@Req() request: Request) {
    const user = await this.authService.requireUser(request);
    const count = await this.notificationsService.countUnread(user.id);
    return { count };
  }

  @Patch('read-all')
  async markAllRead(@Req() request: Request) {
    const user = await this.authService.requireUser(request);
    await this.notificationsService.markAllRead(user.id);
    return { success: true };
  }

  @Patch(':id/read')
  async markRead(@Req() request: Request, @Param('id') id: string) {
    const user = await this.authService.requireUser(request);
    await this.notificationsService.markRead(user.id, id);
    return { success: true };
  }
}
