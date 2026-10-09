import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MaintenanceModule } from '../maintenance/maintenance.module';
import { SystemController } from './system.controller';
import { SystemService } from './system.service';

@Module({
  imports: [AuthModule, MaintenanceModule],
  controllers: [SystemController],
  providers: [SystemService],
})
export class SystemModule {}
