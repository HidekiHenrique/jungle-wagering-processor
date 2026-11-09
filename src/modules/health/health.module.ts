import { Module } from '@nestjs/common';
import { SharedModule } from '../../shared/infrastructure/shared.module';
import { MessagingModule } from '../messaging/messaging.module';
import { HealthController } from './health.controller';

@Module({
  imports: [SharedModule, MessagingModule],
  controllers: [HealthController],
})
export class HealthModule {}
