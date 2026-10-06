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
    const startedAt = Date.now();

    const responseStream = next.handle();
    const successAudited = failuresOnly ? responseStream : responseStream.pipe(
      mergeMap((result) => from(this.audit.record({
        correlationId: request.correlationId,
        actorType: this.actorType(request, action),
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
      catchError((error: unknown) => from(this.audit.record({
        correlationId: request.correlationId,
        actorType: this.actorType(request, action),
        actorSubject: request.actor?.subject,
        actorAccountId: request.actor?.accountId,
        actorMembershipId: request.actor?.facility?.membershipId,
        organizationId: request.actor?.facility?.organizationId,
        facilityId: request.facilityId,
        patientId: this.patientId(request),
        action: `api.${action}`,
        resourceType: 'http-request',
        outcome: 'failure',
        purposeOfUse: this.purpose(request),
        sourceIp: request.ip,
        userAgent: request.header('user-agent'),
        details: { method: request.method, route: request.route?.path, durationMs: Date.now() - startedAt },
      })).pipe(mergeMap(() => throwError(() => error)))),
    );
  }

  private patientId(request: HidRequest): string | undefined {
    const value = request.params?.patientId;
    return typeof value === 'string' ? value : undefined;
  }

  private purpose(request: HidRequest): string | undefined {
    if (request.actor?.platformPermissions?.includes('platform.admin.access') && !request.actor.facility) {
      return 'healthcare-operations';
    }
    const value = request.query?.purpose;
    return typeof value === 'string' ? value : request.header('x-purpose-of-use');
  }

  private actorType(request: HidRequest, action: string): 'staff' | 'platform' | 'patient' | undefined {
    if (!request.actor) return undefined;
    if (request.actor.kind === 'patient') return 'patient';
    if (!request.actor.facility && request.actor.platformPermissions?.includes('platform.admin.access')
        && action.startsWith('admin.')) return 'platform';
    return 'staff';
  }
}
