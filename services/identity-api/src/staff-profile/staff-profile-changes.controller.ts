import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { setSessionCookies } from '../auth/session-cookies';
import { requireIdempotencyKey } from '../common/idempotency';
import { FacilityOptional, NoAudit } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { ChangeOwnNameDto, ChangeOwnPasswordDto } from './staff-profile-changes.dto';
import {
  OWN_NAME_AUDIT_ACTION, OWN_PASSWORD_AUDIT_ACTION, OWN_PROFILE_MESSAGES, ownProfileProblem,
} from './staff-profile-changes';
import { StaffProfileChangesService } from './staff-profile-changes.service';
import { StaffProfileService } from './staff-profile.service';

/**
 * SX-6 (0205): the signed-in staff member changes their own password, or
 * their own name. Staff sessions only (a patient session is refused by the
 * guard, 403 PATIENT_SCOPE_DENIED), including a platform administrator with
 * no membership; X-Facility-ID optional and, when sent, must be one of the
 * caller's own facilities (else 403 FACILITY_ACCESS_DENIED), as SX-5. No
 * permission is needed: the caller's own account. Each route answers 404
 * while its setting is off (OwnPasswordChangeOffMiddleware,
 * OwnNameChangeOffMiddleware).
 *
 * Audit: not through the global interceptor (NoAudit), as SX-5: a staff
 * 'api.' row needs a facility. A success's row is written by 0205's function
 * in the change's own transaction (auth.password.change or
 * auth.staff-profile.update, resource 'session', no facility); a replay's and
 * a refusal's (outcome denied for 4xx, failure otherwise) are written here,
 * the same action and resource, with the problem code only. Refusals before
 * the handler have no row of this action: the guard's (401, 403) record
 * their own auth.authorization.denied row, and a 400 VALIDATION_FAILED from
 * the body's validation has none. A name edit that has committed but whose
 * profile read then fails answers 503 DEPENDENCY_UNAVAILABLE with no refusal
 * row (0205 wrote its success row; a retry with the same key is answered as
 * a replay). No row, log or digest ever holds a password.
 */
@Controller('identity')
export class StaffProfileChangesController {
  private readonly environment = getEnvironment();

  constructor(private readonly changes: StaffProfileChangesService, private readonly profiles: StaffProfileService,
    private readonly audit: AuditService) {}

  /**
   * POST /identity/me/password: 200 {changed, otherSignInsEnded,
   * passwordChangedAt, replayed}, with the renewed sign-in's three cookies and
   * its x-csrf-token header (not on a replay). Cookie sessions only: a bearer
   * caller's token ends with the change and cannot be renewed in a cookie, so
   * it is refused (403 COOKIE_SESSION_REQUIRED) first, before X-Facility-ID,
   * the Idempotency-Key or anything else is read.
   */
  @Post('me/password')
  @HttpCode(200)
  @FacilityOptional()
  @NoAudit()
  async changePassword(@Body() input: ChangeOwnPasswordDto, @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response) {
    const actor = this.staff(request);
    response.setHeader('Cache-Control', 'no-store');
    try {
      if (request.authTransport !== 'cookie') {
        throw new DomainProblem(403, 'COOKIE_SESSION_REQUIRED', OWN_PROFILE_MESSAGES.cookieRequired);
      }
      this.assertOwnFacility(request);
      const key = requireIdempotencyKey(request.header('idempotency-key'));
      const changed = await this.changes.changePassword(request, input, key);
      if (changed.session) {
        setSessionCookies(response, changed.session, this.environment);
        response.setHeader('x-csrf-token', changed.session.csrfToken);
      } else {
        await this.record(request, actor, OWN_PASSWORD_AUDIT_ACTION, 'success', 'identity/me/password', undefined,
          { replayed: true, changeId: changed.changeId });
      }
      return changed.answer;
    } catch (error) {
      await this.refused(request, actor, OWN_PASSWORD_AUDIT_ACTION, 'identity/me/password', error);
      throw error;
    }
  }

  /**
   * POST /identity/me/staff-profile: 200 with the SX-5 profile, its new name
   * and profileVersion. A replay of the same key and name answers the
   * profile as it is now.
   */
  @Post('me/staff-profile')
  @HttpCode(200)
  @FacilityOptional()
  @NoAudit()
  async changeName(@Body() input: ChangeOwnNameDto, @Req() request: HidRequest) {
    const actor = this.staff(request);
    try {
      this.assertOwnFacility(request);
      const key = requireIdempotencyKey(request.header('idempotency-key'));
      const changed = await this.changes.changeName(request, input, key);
      if (changed.replayed) {
        await this.record(request, actor, OWN_NAME_AUDIT_ACTION, 'success', 'identity/me/staff-profile', undefined,
          { replayed: true, profileVersion: changed.profileVersion });
      }
    } catch (error) {
      await this.refused(request, actor, OWN_NAME_AUDIT_ACTION, 'identity/me/staff-profile', error);
      throw error;
    }
    // The change has committed (or was a replay): a failed read is 503 with no refusal row, never a 500.
    try {
      return await this.profiles.read(actor, request.facilityId, request.correlationId);
    } catch (error) {
      throw ownProfileProblem(error);
    }
  }

  private staff(request: HidRequest): ActorContext {
    const actor = request.actor;
    if (!actor || actor.kind === 'patient') {
      throw new DomainProblem(403, 'PATIENT_SCOPE_DENIED', 'This operation requires workforce authorization');
    }
    return actor;
  }

  /** The guard leaves request.facilityId unset for a facility-optional route whose header is not the caller's. */
  private assertOwnFacility(request: HidRequest): void {
    const sent = request.header('x-facility-id');
    if (sent && sent !== request.facilityId) {
      throw new DomainProblem(403, 'FACILITY_ACCESS_DENIED', 'The actor is not active at this facility');
    }
  }

  private refused(request: HidRequest, actor: ActorContext, action: string, route: string, error: unknown) {
    const status = error instanceof DomainProblem ? error.getStatus() : 500;
    return this.record(request, actor, action, status >= 400 && status < 500 ? 'denied' : 'failure', route,
      error instanceof DomainProblem ? error.code : undefined);
  }

  private record(request: HidRequest, actor: ActorContext, action: string, outcome: 'success' | 'denied' | 'failure',
    route: string, code?: string, extra?: Readonly<Record<string, unknown>>) {
    return this.audit.record({
      correlationId: request.correlationId,
      actorType: 'staff',
      actorSubject: actor.subject,
      actorAccountId: actor.accountId,
      action,
      resourceType: 'session',
      resourceId: actor.sessionId,
      outcome,
      purposeOfUse: 'healthcare-operations',
      sourceIp: request.ip,
      userAgent: request.header('user-agent'),
      sourceSystem: 'identity-api',
      details: { method: request.method, route, ...(code ? { code } : {}), ...(extra ?? {}) },
    });
  }
}
