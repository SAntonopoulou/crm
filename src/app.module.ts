import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { HealthController } from './health.controller';
import { DatabaseModule } from './shared/database/database.module';
import { KernelModule } from './shared/kernel.module';
import { AuthModule } from './shared/auth/auth.module';
import { PiiAccessInterceptor } from './shared/audit/pii-access.interceptor';
import { VersionGateMiddleware } from './shared/auth/version-gate.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    KernelModule,
    AuthModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: PiiAccessInterceptor }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(VersionGateMiddleware).forRoutes('{*path}');
  }
}
