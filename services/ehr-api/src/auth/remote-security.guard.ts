import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { FACILITY_OPTIONAL, PUBLIC_ROUTE, REQUIRED_PERMISSIONS, PATIENT_ALLOWED } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { IdentityApiService } from '../integrations/identity-api.service';

@Injectable()
export class RemoteSecurityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly identity: IdentityApiService,
    private readonly audit: AuditService,
    private readonly database: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<HidRequest>();
    if (this.metadata<boolean>(PUBLIC_ROUTE, context)) return true;
    try {
      const actor = await this.identity.authenticateRequest(request);
      request.actor = actor;
      await this.enforceRuntimeControls(request);
      if (actor.kind === 'patient' && !this.metadata<boolean>(PATIENT_ALLOWED, context)) {
        throw new DomainProblem(403, 'PATIENT_SCOPE_DENIED', 'This operation requires workforce authorization');
      }
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

  private async enforceRuntimeControls(request: HidRequest): Promise<void> {
    const actor = request.actor;
    if (!actor) throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required');
    const isPlatformAdmin = actor.platformPermissions?.includes('platform.admin.access') ?? false;
    if (isPlatformAdmin) return;

    const maintenance = await this.controlEnabled('maintenance_mode');
    if (maintenance) {
      throw new DomainProblem(503, 'PLATFORM_MAINTENANCE', 'HID is temporarily in maintenance mode');
    }

    const portalControl = actor.kind === 'patient'
      ? 'patient_portal_enabled'
      : 'provider_portal_enabled';
    if (!(await this.controlEnabled(portalControl))) {
      throw new DomainProblem(423, 'PLATFORM_PORTAL_DISABLED', 'This portal is temporarily disabled');
    }
  }

  private async controlEnabled(controlKey: string): Promise<boolean> {
    try {
      const result = await this.database.query<{ enabled: boolean }>(
        'select platform.control_enabled($1) as enabled',
        [controlKey],
      );
      return result.rows[0]?.enabled === true;
    } catch (error) {
      if (isDatabaseError(error) && error.code === '55000') {
        if (String((error as { message?: unknown }).message ?? '').startsWith('PLATFORM_CONTROL_DISABLED:')) return false;
        throw new DomainProblem(503, 'PLATFORM_CONTROL_UNAVAILABLE', 'Platform runtime controls are unavailable');
      }
      throw error;
    }
  }

  private async recordDenied(request: HidRequest): Promise<void> {
    await this.audit.record({
      correlationId: request.correlationId,
      actorType: request.actor?.kind === 'patient' ? 'patient' : request.actor ? 'staff' : 'system',
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

function isDatabaseError(value: unknown): value is { code: string; message?: string } {
  return typeof value === 'object'
    && value !== null
    && 'code' in value
    && typeof (value as { code?: unknown }).code === 'string';
}
