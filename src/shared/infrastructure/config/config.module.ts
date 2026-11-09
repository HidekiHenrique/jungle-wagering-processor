import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, loadConfig } from './app-config';

/**
 * @Global: every module can inject APP_CONFIG without importing ConfigModule.
 * Config is the one dependency that is truly cross-cutting, so this is the exception, not the rule.
 */
@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig(process.env) }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
