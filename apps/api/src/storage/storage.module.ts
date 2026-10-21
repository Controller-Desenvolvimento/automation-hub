import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StorageController } from './storage.controller';

@Module({
  imports: [AuthModule],
  controllers: [StorageController],
})
export class StorageModule {}
