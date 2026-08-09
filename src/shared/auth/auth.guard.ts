import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthContext, InvalidTokenError, TokenVerifier } from './token-verifier';

export const IS_PUBLIC_KEY = 'is_public';
/** Marks a route as unauthenticated (health, well-known files). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export interface AuthedRequest {
  headers: Record<string, string | string[] | undefined>;
  auth?: AuthContext;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers['authorization'];
    const value = Array.isArray(header) ? header[0] : header;
    if (!value?.startsWith('Bearer ')) {
      throw new UnauthorizedException({ code: 'missing_token' });
    }
    try {
      req.auth = await this.verifier.verify(value.slice('Bearer '.length));
      return true;
    } catch (err) {
      if (err instanceof InvalidTokenError) {
        throw new UnauthorizedException({ code: 'invalid_token' });
      }
      throw err;
    }
  }
}
