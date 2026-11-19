import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RobotHealthController } from './robot-health.controller';
import { RobotHealthService } from './robot-health.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [RobotHealthController],
  providers: [RobotHealthService],
})
export class RobotHealthModule {}
