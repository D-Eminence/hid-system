import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { catchError, from, mergeMap, type Observable, throwError } from 'rxjs';
import { AUDIT_ACTION, AUDIT_FAILURES_ONLY, NO_AUDIT } from '../common/decorators';
import { problemStatusAndCode, refusalOutcome } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { AuditService, type AuditEventInput } from './audit.service';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const noAudit = this.reflector.getAllAndOverride<boolean>(NO_AUDIT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (noAudit) return next.handle();
    const failuresOnly = this.reflector.getAllAndOverride<boolean>(AUDIT_FAILURES_ONLY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<HidRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    const action = this.reflector.getAllAndOverride<string>(AUDIT_ACTION, [
      context.getHandler(),
      context.getClass(),
    ]) ?? `${request.method.toLowerCase()}.${request.route?.path ?? 'unresolved'}`;
    const startedAt = Date.now();

    const responseStream = next.handle();
    const successAudited = failuresOnly ? responseStream : responseStream.pipe(
      mergeMap((result) => from(this.audit.record({
        correlationId: request.correlationId,
        actorType: request.actor?.kind === 'patient' ? 'patient' : undefined,
        actorSubject: request.actor?.subject,
        actorAccountId: request.actor?.accountId,
        actorMembershipId: request.actor?.facility?.membershipId,
        organizationId: request.actor?.facility?.organizationId,
        facilityId: request.facilityId,
        patientId: this.patientId(request),
        action: `api.${action}`,
        resourceType: 'http-request',
        outcome: 'success',
        purposeOfUse: this.purpose(request),
        sourceIp: request.ip,
        userAgent: request.header('user-agent'),
        details: { method: request.method, route: request.route?.path, status: response.statusCode, durationMs: Date.now() - startedAt },
      })).pipe(mergeMap(() => [result]))),
    );
    return successAudited.pipe(
      catchError((error: unknown) => from(this.audit.record(this.failureEvent(request, action, error, startedAt)))
        .pipe(mergeMap(() => throwError(() => error)))),
    );
  }

  /**
   * The failure row: the status and code answered, `denied` for a refusal
   * (A17-EHR-AUDIT). A staff actor with no bound facility, which only a
   * facility-optional route lets through, is recorded as the guard records
   * such a refusal: an auth event on authentication with no facility,
   * membership or organization. As an http-request row it would be refused by
   * the audit layer (a staff row needs a facility, 0067) and the request
   * would answer 503 instead of its own status (A9-EHR).
   */
  private failureEvent(request: HidRequest, action: string, error: unknown, startedAt: number): AuditEventInput {
    const { status, code } = problemStatusAndCode(error);
    const outcome = refusalOutcome(status);
    const details = { method: request.method, route: request.route?.path, durationMs: Date.now() - startedAt, status, code };
    const evidence = { correlationId: request.correlationId, actorSubject: request.actor?.subject,
      actorAccountId: request.actor?.accountId, outcome, purposeOfUse: this.purpose(request), sourceIp: request.ip,
      userAgent: request.header('user-agent'), details };
    if (request.actor && request.actor.kind !== 'patient' && !request.facilityId) {
      return { ...evidence, actorType: 'staff', resourceType: 'authentication',
        action: outcome === 'denied' ? 'auth.authorization.denied' : 'auth.request.failed' };
    }
    return {
      ...evidence,
      actorType: request.actor?.kind === 'patient' ? 'patient' : undefined,
      actorMembershipId: request.actor?.facility?.membershipId,
      organizationId: request.actor?.facility?.organizationId,
      facilityId: request.facilityId,
      patientId: this.patientId(request),
      action: `api.${action}`,
      resourceType: 'http-request',
    };
  }

  private patientId(request: HidRequest): string | undefined {
    const value = request.params?.patientId;
    return typeof value === 'string' ? value : undefined;
  }

  private purpose(request: HidRequest): string | undefined {
    const value = request.query?.purpose;
    return typeof value === 'string' ? value : request.header('x-purpose-of-use');
  }
}
