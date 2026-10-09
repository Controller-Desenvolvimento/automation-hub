import { Module } from '@nestjs/common';
import { ControllerIntelligenceService } from './controller-intelligence.service';

@Module({
  providers: [ControllerIntelligenceService],
  exports: [ControllerIntelligenceService],
})
export class ControllerIntelligenceModule {}
