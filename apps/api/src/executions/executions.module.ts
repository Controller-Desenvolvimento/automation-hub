import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MailModule } from '../mail/mail.module';
import { ExecutionsController } from './executions.controller';
import { ExecutionRunnerService } from './execution-runner.service';
import { ExecutionsService } from './executions.service';

@Module({
  imports: [PrismaModule, AuthModule, NotificationsModule, MailModule],
  controllers: [ExecutionsController],
  providers: [ExecutionsService, ExecutionRunnerService],
  exports: [ExecutionsService, ExecutionRunnerService],
})
export class ExecutionsModule {}
