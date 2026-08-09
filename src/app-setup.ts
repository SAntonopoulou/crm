import { INestApplication, ValidationPipe } from '@nestjs/common';

/** Shared between main.ts and e2e tests so both run the identical app shape. */
export function configureApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix('v1', { exclude: ['health'] });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );
  app.enableShutdownHooks();
  return app;
}
