import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { AuditLog, PiiAction } from './audit-log.service';

export const PII_ACCESS_KEY = 'pii_access';
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export interface PiiAccessSpec {
  /** Fields the handler exposes, e.g. ['contact_channel.value'] */
  fields: string[];
  action?: PiiAction;
  /** Route param naming the subject contact id, e.g. 'contactId' */
  subjectParam?: string;
}

/** Declares that a handler exposes PII; the interceptor logs the access. */
export const PiiAccess = (spec: PiiAccessSpec) =>
  SetMetadata(PII_ACCESS_KEY, spec);

@Injectable()
export class PiiAccessInterceptor implements NestInterceptor {
  private readonly logger = new Logger(PiiAccessInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditLog,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const spec = this.reflector.get<PiiAccessSpec | undefined>(
      PII_ACCESS_KEY,
      ctx.getHandler(),
    );
    if (!spec) return next.handle();

    const req = ctx
      .switchToHttp()
      .getRequest<{
        auth?: { sub?: string };
        params?: Record<string, string>;
        originalUrl?: string;
        method?: string;
      }>();
    const actorId = req.auth?.sub ?? NIL_UUID;
    const subjectContactId = spec.subjectParam
      ? req.params?.[spec.subjectParam]
      : undefined;

    return next.handle().pipe(
      tap(() => {
        // A failed audit write must be loud but must not corrupt the response
        // that already streamed; the alert on this log line is the backstop.
        void this.audit
          .recordAll(
            spec.fields.map((field) => ({
              actorId,
              subjectContactId,
              entityField: field,
              action: spec.action ?? 'read',
              context: { route: req.originalUrl, method: req.method },
            })),
          )
          .catch((err: unknown) =>
            this.logger.error(`PII access audit write failed: ${String(err)}`),
          );
      }),
    );
  }
}
