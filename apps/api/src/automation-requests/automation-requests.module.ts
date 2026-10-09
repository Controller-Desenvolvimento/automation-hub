import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AutomationRequestsController } from './automation-requests.controller';
import { AutomationRequestsService } from './automation-requests.service';

@Module({
  imports: [PrismaModule, AuthModule, NotificationsModule],
  controllers: [AutomationRequestsController],
  providers: [AutomationRequestsService],
  exports: [AutomationRequestsService],
})
export class AutomationRequestsModule {}
