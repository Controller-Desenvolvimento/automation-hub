import { Module } from '@nestjs/common';
import { ExternalMetricsController } from './external-metrics.controller';
import { ExternalMetricsService } from './external-metrics.service';

@Module({
  controllers: [ExternalMetricsController],
  providers: [ExternalMetricsService],
  exports: [ExternalMetricsService],
})
export class ExternalMetricsModule {}
