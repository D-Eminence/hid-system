import { Body, Controller, Get, HttpCode, HttpException, Post, Req } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuditAction, AuditFailuresOnly, FacilityOptional, NoAudit } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import { type ActorContext, type HidRequest, requireStaffAccountContext } from '../common/request-context';
import { SaveStaffPreferencesDto, SaveStaffShortcutsDto } from './staff-preferences.dto';
import { StaffPreferencesService } from './staff-preferences.service';

/** The audit action of every preferences read, success or refusal (as SX-5's auth.staff-profile.read). */
export const STAFF_PREFERENCES_READ_ACTION = 'auth.staff-preferences.read';
/** The preferences save: its success row is 0206's (in the save's transaction), a refusal's is the route's. */
export const STAFF_PREFERENCES_UPDATE_ACTION = 'auth.staff-preferences.update';
/** The shortcuts save: its success row is 0206's; a refusal's is the audit interceptor's (api.<action>). */
export const STAFF_SHORTCUTS_UPDATE_ACTION = 'identity.staff-shortcuts.update';

type Outcome = 'success' | 'denied' | 'failure';

/**
 * SX-7 (0206): a staff member's own language and Home shortcuts. Staff
 * sessions only (a patient is refused by the guard, 403
 * PATIENT_SCOPE_DENIED; an account-only outreach session, 403
 * NO_ACTIVE_FACILITY_MEMBERSHIP). No permission: these are the caller's own
 * settings. While STAFF_PREFERENCES_ENABLED is false every route answers 404
 * (StaffPreferencesOffMiddleware).
 *
 * The two preferences routes are facility-optional, so a platform
 * administrator with no membership reads and saves their own language; an
 * X-Facility-ID, when sent, must be one of the caller's facilities (403
 * FACILITY_ACCESS_DENIED) and adds that membership's shortcuts to the
 * answer. They are not audited by the global interceptor (its staff 'api.'
 * row on 'http-request' needs a facility, as SX-5 explains), but write
 * auth.* rows on 'session', which the audit CHECKs admit with no facility.
 * The shortcuts route needs the X-Facility-ID facility (the guard answers
 * FACILITY_REQUIRED and FACILITY_ACCESS_DENIED), so the interceptor records
 * its refusals.
 */
@Controller('identity')
export class StaffPreferencesController {
  constructor(private readonly preferences: StaffPreferencesService, private readonly audit: AuditService) {}

  @Get('me/preferences')
  @FacilityOptional()
  @NoAudit()
  async read(@Req() request: HidRequest) {
    const actor = this.staff(request);
    try {
      this.facilityAsSent(request);
      const answer = await this.preferences.read(requireStaffAccountContext(request));
      await this.record(request, actor, STAFF_PREFERENCES_READ_ACTION, 'success', 'identity/me/preferences');
      return answer;
    } catch (error) {
      await this.record(request, actor, STAFF_PREFERENCES_READ_ACTION, this.outcome(error), 'identity/me/preferences', error);
      throw error;
    }
  }

  @Post('me/preferences')
  @HttpCode(200)
  @FacilityOptional()
  @NoAudit()
  async savePreferences(@Body() input: SaveStaffPreferencesDto, @Req() request: HidRequest) {
    const actor = this.staff(request);
    try {
      this.facilityAsSent(request);
      const key = requireIdempotencyKey(request.header('idempotency-key'));
      // The success row is 0206's, written in the save's transaction.
      return await this.preferences.savePreferences(requireStaffAccountContext(request),
        { language: input.language, expectedVersion: input.expectedVersion }, key);
    } catch (error) {
      await this.record(request, actor, STAFF_PREFERENCES_UPDATE_ACTION, this.outcome(error), 'identity/me/preferences', error);
      throw error;
    }
  }

  @Post('me/shortcuts')
  @HttpCode(200)
  @AuditAction(STAFF_SHORTCUTS_UPDATE_ACTION)
  @AuditFailuresOnly()
  async saveShortcuts(@Body() input: SaveStaffShortcutsDto, @Req() request: HidRequest) {
    this.staff(request);
    const key = requireIdempotencyKey(request.header('idempotency-key'));
    // The success row is 0206's, written in the save's transaction.
    return this.preferences.saveShortcuts(requireStaffAccountContext(request),
      { items: input.items, expectedVersion: input.expectedVersion }, key);
  }

  private staff(request: HidRequest): ActorContext {
    const actor = request.actor;
    if (!actor || actor.kind === 'patient') {
      throw new DomainProblem(403, 'PATIENT_SCOPE_DENIED', 'This operation requires workforce authorization');
    }
    return actor;
  }

  /**
   * The guard leaves request.facilityId unset for a facility-optional route
   * when the header names a facility the caller is not active at.
   */
  private facilityAsSent(request: HidRequest): void {
    const sent = request.header('x-facility-id');
    if (sent && sent !== request.facilityId) {
      throw new DomainProblem(403, 'FACILITY_ACCESS_DENIED', 'The actor is not active at this facility');
    }
  }

  private outcome(error: unknown): Outcome {
    return error instanceof HttpException && [401, 403].includes(error.getStatus()) ? 'denied' : 'failure';
  }

  /**
   * One row on 'session' (SX-5's form): the read's resource is the session,
   * an update's the account (as 0206's success row). The facility and
   * membership only when X-Facility-ID was resolved.
   */
  private record(request: HidRequest, actor: ActorContext, action: string, outcome: Outcome, route: string,
    error?: unknown) {
    const atFacility = request.facilityId ? actor.facility : undefined;
    return this.audit.record({
      correlationId: request.correlationId,
      actorType: 'staff',
      actorSubject: actor.subject,
      actorAccountId: actor.accountId,
      actorMembershipId: atFacility?.membershipId,
      organizationId: atFacility?.organizationId,
      facilityId: request.facilityId,
      action,
      resourceType: 'session',
      resourceId: action === STAFF_PREFERENCES_READ_ACTION ? actor.sessionId : actor.accountId,
      outcome,
      sourceIp: request.ip,
      userAgent: request.header('user-agent'),
      sourceSystem: 'identity-api',
      details: {
        method: request.method,
        route,
        ...(error instanceof DomainProblem ? { code: error.code } : {}),
      },
    });
  }
}
