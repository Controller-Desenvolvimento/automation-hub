import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SupportModule } from '../support/support.module';
import { RetentionService } from './retention.service';

@Module({
  imports: [PrismaModule, SupportModule],
  providers: [RetentionService],
  exports: [RetentionService],
})
export class MaintenanceModule {}
