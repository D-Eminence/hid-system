import { Controller, Get, HttpException, Req } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { FacilityOptional, NoAudit } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import { StaffProfileService } from './staff-profile.service';

/** The audit action of every SX-5 read, success or refusal. */
export const STAFF_PROFILE_AUDIT_ACTION = 'auth.staff-profile.read';

/**
 * GET /api/v1/identity/me/staff-profile (SX-5): the signed-in staff member's
 * own profile. Staff sessions only (a patient session is refused by the
 * guard, 403 PATIENT_SCOPE_DENIED); X-Facility-ID optional and, when sent,
 * must be one of the caller's own facilities (else 403
 * FACILITY_ACCESS_DENIED) and only marks the current facility. No permission
 * is needed: it reads the caller's own account.
 *
 * Audit: not through the global interceptor (NoAudit). Its row would be a
 * staff 'api.' action on 'http-request', which needs a facility
 * (AuditService.assertActorFacility and the audit.events check), so a call
 * with no X-Facility-ID, or from a platform administrator with no
 * membership, would answer 503 with nothing recorded. The route writes its
 * own row instead, auth.staff-profile.read on resource 'session' (the
 * session's own account, like auth.session.read), which both checks allow
 * with or without a facility: one row on success, one on refusal or
 * failure.
 */
@Controller('identity')
export class StaffProfileController {
  constructor(private readonly profiles: StaffProfileService, private readonly audit: AuditService) {}

  @Get('me/staff-profile')
  @FacilityOptional()
  @NoAudit()
  async read(@Req() request: HidRequest) {
    const actor = request.actor;
    if (!actor || actor.kind === 'patient') {
      throw new DomainProblem(403, 'PATIENT_SCOPE_DENIED', 'This operation requires workforce authorization');
    }
    try {
      // The guard leaves request.facilityId unset for a facility-optional
      // route when the header names a facility the caller is not active at.
      const sent = request.header('x-facility-id');
      if (sent && sent !== request.facilityId) {
        throw new DomainProblem(403, 'FACILITY_ACCESS_DENIED', 'The actor is not active at this facility');
      }
      const profile = await this.profiles.read(actor, request.facilityId);
      await this.record(request, actor, 'success');
      return profile;
    } catch (error) {
      const refused = error instanceof HttpException && [401, 403].includes(error.getStatus());
      await this.record(request, actor, refused ? 'denied' : 'failure', error);
      throw error;
    }
  }

  private record(request: HidRequest, actor: ActorContext, outcome: 'success' | 'denied' | 'failure', error?: unknown) {
    const atFacility = request.facilityId ? actor.facility : undefined;
    return this.audit.record({
      correlationId: request.correlationId,
      actorType: 'staff',
      actorSubject: actor.subject,
      actorAccountId: actor.accountId,
      actorMembershipId: atFacility?.membershipId,
      organizationId: atFacility?.organizationId,
      facilityId: request.facilityId,
      action: STAFF_PROFILE_AUDIT_ACTION,
      resourceType: 'session',
      resourceId: actor.sessionId,
      outcome,
      sourceIp: request.ip,
      userAgent: request.header('user-agent'),
      details: {
        method: request.method,
        route: 'identity/me/staff-profile',
        ...(error instanceof DomainProblem ? { code: error.code } : {}),
      },
    });
  }
}
