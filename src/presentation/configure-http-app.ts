import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { HttpErrorFilter } from './http-error.filter';

/** HTTP pipeline shared by main.ts and the e2e tests, so tests exercise the real configuration. */
export function configureHttpApp(app: INestApplication): INestApplication {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true, // unknown fields are an error, not silently dropped
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpErrorFilter());
  return app;
}
