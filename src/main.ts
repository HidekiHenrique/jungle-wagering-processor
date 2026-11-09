import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureHttpApp } from './presentation/configure-http-app';
import { loadConfig } from './shared/infrastructure/config/app-config';
import { JsonLogger } from './shared/infrastructure/logger/json-logger';

async function bootstrap(): Promise<void> {
  // Loaded here too (pure function) so the logger level is known before Nest starts.
  const config = loadConfig(process.env);

  const app = configureHttpApp(
    await NestFactory.create(AppModule, { logger: new JsonLogger(config.log.level) }),
  );

  // Runs onModuleDestroy / beforeApplicationShutdown hooks on SIGTERM and SIGINT.
  app.enableShutdownHooks();

  await app.listen(config.http.port);
  new Logger('Bootstrap').log({ msg: 'HTTP server listening', port: config.http.port });
}

bootstrap().catch((error: unknown) => {
  // The Nest logger may not exist yet (e.g. invalid config): write a JSON line directly.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', message, timestamp: new Date().toISOString() })}\n`,
  );
  process.exit(1);
});
