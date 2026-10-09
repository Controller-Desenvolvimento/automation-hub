import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ExecutionsModule } from '../executions/executions.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ScheduledTasksController } from './scheduled-tasks.controller';
import { ScheduledTasksSchedulerService } from './scheduled-tasks.scheduler';
import { ScheduledTasksService } from './scheduled-tasks.service';

@Module({
  imports: [PrismaModule, AuthModule, ExecutionsModule],
  controllers: [ScheduledTasksController],
  providers: [ScheduledTasksService, ScheduledTasksSchedulerService],
  exports: [ScheduledTasksService],
})
export class ScheduledTasksModule {}
