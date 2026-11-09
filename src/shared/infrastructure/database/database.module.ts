import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { buildOrmOptions } from './mikro-orm.config';

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      driver: PostgreSqlDriver,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        ...buildOrmOptions(config),
        // Registers middleware that forks the EntityManager per HTTP request.
        registerRequestContext: true,
        // Each module registers its own records with MikroOrmModule.forFeature().
        autoLoadEntities: true,
      }),
    }),
  ],
})
export class DatabaseModule {}
