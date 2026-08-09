import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from './auth.guard';
import { RolesGuard } from './roles.guard';
import { StepUpGuard } from './step-up.guard';
import { JWT_KEY_SOURCE, TokenVerifier, keycloakKeySource } from './token-verifier';

@Global()
@Module({
  providers: [
    {
      provide: JWT_KEY_SOURCE,
      inject: [ConfigService],
      useFactory: keycloakKeySource,
    },
    TokenVerifier,
    // Order matters: authenticate, then authorize, then step-up.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: StepUpGuard },
  ],
  exports: [TokenVerifier],
})
export class AuthModule {}
