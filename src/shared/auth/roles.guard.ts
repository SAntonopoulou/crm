import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthedRequest } from './auth.guard';

export const ROLES_KEY = 'required_roles';
/** Any of the given realm roles grants access. */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      ROLES_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!required?.length) return true;
    const { auth } = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!auth) return false; // AuthGuard runs first; belt and braces
    if (required.some((role) => auth.roles.includes(role))) return true;
    throw new ForbiddenException({ code: 'insufficient_role' });
  }
}
