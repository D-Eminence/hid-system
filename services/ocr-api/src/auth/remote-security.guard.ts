import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuditService } from '../audit/audit.service';
import { FACILITY_OPTIONAL, PUBLIC_ROUTE, REQUIRED_PERMISSIONS } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { IdentityApiService } from '../integrations/identity-api.service';

@Injectable()
export class RemoteSecurityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly identity: IdentityApiService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<HidRequest>();
    if (this.metadata<boolean>(PUBLIC_ROUTE, context)) return true;
    try {
      const actor = await this.identity.authenticateRequest(request);
      request.actor = actor;
      request.authTransport = request.header('authorization') ? 'bearer' : 'cookie';
      const facilityOptional = this.metadata<boolean>(FACILITY_OPTIONAL, context);
      const facilityId = request.header('x-facility-id');
      if (!facilityOptional) {
        if (!facilityId || !this.uuid(facilityId)) {
          throw new DomainProblem(400, 'FACILITY_REQUIRED', 'A valid X-Facility-ID header is required');
        }
        const assignment = actor.facilities.find((candidate) => candidate.id === facilityId);
        if (!assignment) throw new DomainProblem(403, 'FACILITY_ACCESS_DENIED', 'The actor is not active at this facility');
        request.facilityId = facilityId;
        request.actor = { ...actor, facility: assignment, roles: assignment.roles, role: assignment.roles[0], permissions: assignment.permissions };
      } else if (facilityId && actor.facilityIds.includes(facilityId)) {
        const assignment = actor.facilities.find((candidate) => candidate.id === facilityId);
        request.facilityId = facilityId;
        if (assignment) request.actor = { ...actor, facility: assignment, roles: assignment.roles, role: assignment.roles[0], permissions: assignment.permissions };
      }
      const required = this.metadata<readonly string[]>(REQUIRED_PERMISSIONS, context) ?? [];
      if (required.some((permission) => !request.actor?.permissions.includes(permission))) {
        throw new DomainProblem(403, 'PERMISSION_DENIED', 'Required permission is missing');
      }
      return true;
    } catch (error) {
      await this.recordDenied(request);
      if (error instanceof DomainProblem) throw error;
      throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required');
    }
  }

  private async recordDenied(request: HidRequest): Promise<void> {
    await this.audit.record({
      correlationId: request.correlationId,
      actorType: request.actor ? 'staff' : 'system',
      actorSubject: request.actor?.subject,
      actorAccountId: request.actor?.accountId,
      actorMembershipId: request.actor?.facility?.membershipId,
      organizationId: request.actor?.facility?.organizationId,
      facilityId: request.facilityId,
      action: 'security.authorization.denied',
      resourceType: request.actor ? 'http-request' : 'authentication',
      outcome: 'denied',
      sourceIp: request.ip,
      userAgent: request.header('user-agent'),
      details: { method: request.method, route: typeof request.route?.path === 'string' ? request.route.path : 'unresolved' },
      provenance: request.actor ? 'application' : 'system',
    });
  }

  private metadata<Value>(key: symbol, context: ExecutionContext): Value | undefined {
    return this.reflector.getAllAndOverride<Value>(key, [context.getHandler(), context.getClass()]);
  }

  private uuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }
}

