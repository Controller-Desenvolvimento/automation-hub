import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DashboardController } from './dashboard.controller';
import { DashboardSchedulerService } from './dashboard-scheduler.service';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [DashboardController],
  providers: [DashboardService, DashboardSchedulerService],
  exports: [DashboardService],
})
export class DashboardModule {}
