import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ExecutionsModule } from '../executions/executions.module';
import { MaintenanceModule } from '../maintenance/maintenance.module';
import { SystemController } from './system.controller';
import { SystemService } from './system.service';

@Module({
  imports: [AuthModule, ExecutionsModule, MaintenanceModule],
  controllers: [SystemController],
  providers: [SystemService],
})
export class SystemModule {}
