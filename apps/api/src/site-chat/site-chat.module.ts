import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AutomationRequestsModule } from '../automation-requests/automation-requests.module';
import { ControllerIntelligenceModule } from '../controller-intelligence/controller-intelligence.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ScheduledTasksModule } from '../scheduled-tasks/scheduled-tasks.module';
import { BiChatBridgeService } from './bi-chat-bridge.service';
import { SiteChatController } from './site-chat.controller';
import { SiteChatService } from './site-chat.service';

@Module({
  imports: [PrismaModule, AuthModule, ScheduledTasksModule, AutomationRequestsModule, ControllerIntelligenceModule],
  controllers: [SiteChatController],
  providers: [SiteChatService, BiChatBridgeService],
})
export class SiteChatModule {}
