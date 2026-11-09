import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { HealthModule } from './modules/health/health.module';
import { WageringModule } from './modules/wagering/wagering.module';
import { ConfigModule } from './shared/infrastructure/config/config.module';
import { DatabaseModule } from './shared/infrastructure/database/database.module';
import { CorrelationIdMiddleware } from './shared/presentation/http/correlation-id.middleware';

@Module({
  imports: [ConfigModule, DatabaseModule, WageringModule, HealthModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
