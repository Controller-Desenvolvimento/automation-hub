import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ExecutionsModule } from '../executions/executions.module';
import { MailModule } from '../mail/mail.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ScheduleChecksService } from './schedule-checks.service';
import { ScheduledTasksController } from './scheduled-tasks.controller';
import { ScheduledTasksSchedulerService } from './scheduled-tasks.scheduler';
import { ScheduledTasksService } from './scheduled-tasks.service';

@Module({
  imports: [PrismaModule, AuthModule, ExecutionsModule, MailModule],
  controllers: [ScheduledTasksController],
  providers: [ScheduledTasksService, ScheduledTasksSchedulerService, ScheduleChecksService],
  exports: [ScheduledTasksService],
})
export class ScheduledTasksModule {}
