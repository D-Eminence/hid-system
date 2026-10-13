import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../database/database.service';
import { FACILITY_OPTIONAL, PATIENT_ALLOWED, PATIENT_ONLY, PUBLIC_ROUTE, REQUIRED_PERMISSIONS } from '../common/decorators';
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
      // A patient-only route refuses any other session here, before a facility
      // is bound or a handler runs, so the refusal is audited as one before a
      // facility is bound. Refused in the handler, it became a staff
      // http-request row with no facility, which the audit layer refuses, and
      // the answer became 503 (A9-EHR).
      if (actor.kind !== 'patient' && this.metadata<boolean>(PATIENT_ONLY, context)) {
        throw new DomainProblem(403, 'PATIENT_SESSION_REQUIRED', 'An active patient session is required');
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
      // A fault with no status of its own is not a refusal of the credential:
      // the guard could not decide. It answers 503, which clients retry, never
      // the 401 that ends the browser's sign-in (A4, ADR-059).
      const refusal = error instanceof DomainProblem
        ? error
        : new DomainProblem(503, 'AUTHENTICATION_UNAVAILABLE', 'Authentication is temporarily unavailable');
      await this.recordDenied(request, refusal);
      throw refusal;
    }
  }

  private async enforceRuntimeControls(request: HidRequest): Promise<void> {
    const actor = request.actor;
    if (!actor) throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required');
    // No EHR request is exempt: platform sessions never authenticate here, and
    // a platform grant does not exempt its holder's clinical session (A16).

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
      if (isDatabaseError(error) && error.code === '55000'
        && String((error as { message?: unknown }).message ?? '').startsWith('PLATFORM_CONTROL_DISABLED:')) return false;
      // Any other fault (a timeout, a lost connection, a missing grant) leaves
      // the control unknown. Answer it as such, not as the caller's 401.
      throw new DomainProblem(503, 'PLATFORM_CONTROL_UNAVAILABLE', 'Platform runtime controls are unavailable');
    }
  }

  private async recordDenied(request: HidRequest, refusal: DomainProblem): Promise<void> {
    // The status and code answered, so a refusal can be told apart in access review (A17-EHR-AUDIT).
    const details = { method: request.method, route: typeof request.route?.path === 'string' ? request.route.path : 'unresolved',
      status: refusal.getStatus(), code: refusal.code };
    if (request.actor && !request.facilityId) {
      // Refused before a facility was bound (no or malformed X-Facility-ID, a
      // facility the actor is not active at, a runtime control). Recorded as
      // Identity's SecurityGuard records it: an auth event with no membership
      // or organization. A staff row without a facility is accepted only as
      // an auth event (AuditService, the 0067 CHECKs); an http-request row
      // carrying the default membership was refused, and the refusal then
      // answered 503 instead of its own status.
      await this.audit.record({
        correlationId: request.correlationId,
        actorType: request.actor.kind === 'patient' ? 'patient' : 'staff',
        actorSubject: request.actor.subject,
        actorAccountId: request.actor.accountId,
        action: 'auth.authorization.denied',
        resourceType: 'authentication',
        outcome: 'denied',
        sourceIp: request.ip,
        userAgent: request.header('user-agent'),
        details,
      });
      return;
    }
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
      details,
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
