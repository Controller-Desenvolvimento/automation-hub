import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DevDocsController } from './dev-docs.controller';
import { DevDocsService } from './dev-docs.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [DevDocsController],
  providers: [DevDocsService],
})
export class DevDocsModule {}
