import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AutomationRequestsModule } from './automation-requests/automation-requests.module';
import { DevDocsModule } from './dev-docs/dev-docs.module';
import { AuthModule } from './auth/auth.module';
import { ExternalMetricsModule } from './external-metrics/external-metrics.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DepartmentsModule } from './departments/departments.module';
import { ExecutionsModule } from './executions/executions.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PrismaModule } from './prisma/prisma.module';
import { ReportsModule } from './reports/reports.module';
import { RobotsModule } from './robots/robots.module';
import { ScheduledTasksModule } from './scheduled-tasks/scheduled-tasks.module';
import { SeedService } from './seed.service';
import { SharedCredentialsModule } from './shared-credentials/shared-credentials.module';
import { SiteChatModule } from './site-chat/site-chat.module';
import { SitesModule } from './sites/sites.module';
import { SystemModule } from './system/system.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [PrismaModule, AuthModule, RobotsModule, ExecutionsModule, UsersModule, ScheduledTasksModule, ReportsModule, NotificationsModule, MaintenanceModule, SitesModule, DepartmentsModule, SharedCredentialsModule, IntegrationsModule, AutomationRequestsModule, SystemModule, DashboardModule, ExternalMetricsModule, DevDocsModule, SiteChatModule],
  controllers: [AppController],
  providers: [SeedService],
})
export class AppModule {}
