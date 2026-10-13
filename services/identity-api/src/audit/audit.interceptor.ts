import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { catchError, from, mergeMap, type Observable, throwError } from 'rxjs';
import { AUDIT_ACTION, AUDIT_FAILURES_ONLY, AUDIT_SESSION_EVENT, NO_AUDIT } from '../common/decorators';
import type { HidRequest } from '../common/request-context';
import { AuditService } from './audit.service';

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
    const sessionEvent = this.reflector.getAllAndOverride<string>(AUDIT_SESSION_EVENT, [
      context.getHandler(),
      context.getClass(),
    ]);
    // A session route is recorded as its auth.* session event, on the session it
    // acts on. Read when the request ends: sign-out resolves its actor itself.
    const recorded = () => sessionEvent
      ? { action: sessionEvent, resourceType: 'session', resourceId: request.actor?.sessionId }
      : { action: `api.${action}`, resourceType: 'http-request' };
    const startedAt = Date.now();

    const responseStream = next.handle();
    const successAudited = failuresOnly ? responseStream : responseStream.pipe(
      mergeMap((result) => from(this.audit.record({
        correlationId: request.correlationId,
        ...this.actorFields(request, Boolean(sessionEvent)),
        patientId: this.patientId(request),
        ...recorded(),
        outcome: 'success',
        purposeOfUse: this.purpose(request),
        sourceIp: request.ip,
        userAgent: request.header('user-agent'),
        details: { method: request.method, route: request.route?.path, status: response.statusCode, durationMs: Date.now() - startedAt },
      })).pipe(mergeMap(() => [result]))),
    );
    return successAudited.pipe(
      catchError((error: unknown) => from(this.audit.record(this.unboundStaffFailure(request, error, action,
        Boolean(sessionEvent), startedAt) ?? {
        correlationId: request.correlationId,
        ...this.actorFields(request, Boolean(sessionEvent)),
        patientId: this.patientId(request),
        ...recorded(),
        outcome: 'failure',
        purposeOfUse: this.purpose(request),
        sourceIp: request.ip,
        userAgent: request.header('user-agent'),
        details: { method: request.method, route: request.route?.path, durationMs: Date.now() - startedAt },
      })).pipe(mergeMap(() => throwError(() => error)))),
    );
  }

  /**
   * A failed request of a staff actor with no facility bound, on a route that
   * is neither a session event nor platform administration. A staff row
   * without a facility is accepted only as an auth.* event (AuditService, the
   * 0067 CHECKs), so recorded as its api.* request the refusal's own audit
   * failed and the answer became 503 with nothing recorded (A9). It is
   * recorded as an auth event of the authentication, with no membership or
   * organization, and the request's action kept in its details.
   */
  private unboundStaffFailure(request: HidRequest, error: unknown, action: string, sessionEvent: boolean,
    startedAt: number) {
    const actor = request.actor;
    if (!actor || actor.kind === 'patient' || sessionEvent || request.accessScope === 'platform' || request.facilityId) {
      return undefined;
    }
    const status = error instanceof HttpException ? error.getStatus() : 500;
    return {
      correlationId: request.correlationId,
      actorType: 'staff' as const,
      actorSubject: actor.subject,
      actorAccountId: actor.accountId,
      action: status < 500 ? 'auth.authorization.denied' : 'auth.request.failed',
      resourceType: 'authentication',
      outcome: status < 500 ? 'denied' as const : 'failure' as const,
      sourceIp: request.ip,
      userAgent: request.header('user-agent'),
      details: { method: request.method, route: request.route?.path, status, requestAction: `api.${action}`,
        durationMs: Date.now() - startedAt },
    };
  }

  // Platform administration is recorded as platform scope with no facility;
  // every other request keeps the facility the guard bound to it. A session
  // event names its actor's kind, as AuthController's own session events do, and
  // records a membership and organization only with the facility bound to the
  // request. Sign-out binds none; the other session routes bind one only when
  // the request names one of the actor's facilities in X-Facility-ID. Otherwise
  // the row carries no facility, membership or organization.
  private actorFields(request: HidRequest, sessionEvent = false) {
    if (request.accessScope === 'platform' && request.actor && request.actor.kind !== 'patient') {
      return {
        actorType: 'staff' as const,
        actorSubject: request.actor.subject,
        actorAccountId: request.actor.accountId,
        accessScope: 'platform' as const,
      };
    }
    if (sessionEvent && request.actor) {
      const bound = request.facilityId !== undefined && request.actor.facility?.id === request.facilityId;
      return {
        actorType: request.actor.kind === 'patient' ? 'patient' as const : 'staff' as const,
        actorSubject: request.actor.subject,
        actorAccountId: request.actor.accountId,
        actorMembershipId: bound ? request.actor.facility?.membershipId : undefined,
        organizationId: bound ? request.actor.facility?.organizationId : undefined,
        facilityId: bound ? request.facilityId : undefined,
      };
    }
    return {
      actorType: request.actor?.kind === 'patient' ? 'patient' as const : undefined,
      actorSubject: request.actor?.subject,
      actorAccountId: request.actor?.accountId,
      actorMembershipId: request.actor?.facility?.membershipId,
      organizationId: request.actor?.facility?.organizationId,
      facilityId: request.facilityId,
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
