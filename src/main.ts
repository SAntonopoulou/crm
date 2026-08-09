import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app-setup';

async function bootstrap(): Promise<void> {
  const app = configureApp(await NestFactory.create(AppModule));
  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
