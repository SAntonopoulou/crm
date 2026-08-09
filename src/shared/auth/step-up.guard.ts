import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Clock } from '../jobs/clock';
import { AuthedRequest } from './auth.guard';

export const STEP_UP_KEY = 'step_up_action';
/** Marks a handler as requiring step-up auth for the named action. */
export const StepUp = (action: StepUpAction) => SetMetadata(STEP_UP_KEY, action);

export type StepUpAction =
  | 'payout_change'
  | 'contract_accept'
  | 'bulk_export'
  | 'first_claim';

export interface StepUpRequirement {
  /** ACR values accepted as "stepped up" (Keycloak LoA mapping). */
  acceptedAcr: string[];
  /** Max seconds since auth_time; older sessions must re-authenticate. */
  maxAgeSeconds: number;
}

/**
 * Defaults per docs/api-specification.md §2; the step_up_policy table
 * (migration group 090) will override these at runtime once it ships.
 */
export const DEFAULT_STEP_UP_POLICY: Record<StepUpAction, StepUpRequirement> = {
  payout_change: { acceptedAcr: ['mfa', 'loa2'], maxAgeSeconds: 300 },
  contract_accept: { acceptedAcr: ['mfa', 'loa2'], maxAgeSeconds: 900 },
  bulk_export: { acceptedAcr: ['mfa', 'loa2'], maxAgeSeconds: 300 },
  first_claim: { acceptedAcr: ['mfa', 'loa2'], maxAgeSeconds: 900 },
};

@Injectable()
export class StepUpGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly clock: Clock,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const action = this.reflector.getAllAndOverride<StepUpAction | undefined>(
      STEP_UP_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!action) return true;

    const requirement = DEFAULT_STEP_UP_POLICY[action];
    const { auth } = ctx.switchToHttp().getRequest<AuthedRequest>();
    const acrOk = !!auth?.acr && requirement.acceptedAcr.includes(auth.acr);
    const freshOk =
      auth?.authTime !== undefined &&
      this.clock.now().getTime() / 1000 - auth.authTime <=
        requirement.maxAgeSeconds;

    if (acrOk && freshOk) return true;
    throw new ForbiddenException({
      code: 'step_up_required',
      action,
      acr: requirement.acceptedAcr,
      max_age_seconds: requirement.maxAgeSeconds,
    });
  }
}
