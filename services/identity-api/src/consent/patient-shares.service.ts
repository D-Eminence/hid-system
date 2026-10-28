import { createHmac, randomBytes } from 'node:crypto';
import { type BeforeApplicationShutdown, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { NotificationOtpClient } from '../auth/notification-otp.client';
import { requirePatient } from '../auth/patient-self.service';
import { consumeRateLimit, type RateLimitWindow } from '../auth/rate-limit';
import { requireNoRecentRecoveryHold, requireRecentPatientAuthentication } from '../auth/recent-authentication';
import { AFTER_RESPONSE_SHUTDOWN_GRACE_MS, AfterResponseTasks } from '../common/after-response-tasks';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext, HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { acceptableStaffPersonName, emailFacilityName } from '../identity/staff-names';
import { databaseMessage, isDatabaseError } from '../patient-safety/database-error';
import { alertFacilityName } from '../patient-safety/emergency-contact-notification.dispatcher';
import type { CreateShareDto, CreateShareInvitationDto, ShareDuration, ShareLevel } from './dto/patient-share.dto';

/** P1: 30 searches an hour per patient account (D4). */
export const SHARE_SEARCH_WINDOW: RateLimitWindow = { windowSeconds: 3600, maxRequests: 30 };
/** P1: the SQL answers at most 25 candidates; the answer keeps 10 whose name is a person's name. */
export const SHARE_SEARCH_RESULTS = 10;

/** The patient-written details (the website shows `detail` as it is). */
export const SHARE_DETAIL = {
  queryInvalid: 'Enter at least 3 characters of a name or facility.',
  searchLimited: 'Too many searches. Try again in an hour.',
  unavailable: 'Sharing is not available right now. Try again later.',
  providerUnavailable: 'This provider can\'t receive access through Health ID right now. Search again.',
  providerUnavailableOffer: 'This provider can\'t receive access through Health ID right now.',
  recentAuth: 'For your security, sign out, sign in again, and share within 10 minutes.',
  createLimited: 'You have shared your records many times today. Try again tomorrow.',
  keyReused: 'This request was already used for a different share. Start again.',
  emailInvalid: 'Enter a valid email address.',
  alreadyOpen: 'You already invited this address. Cancel that invitation to send a new one.',
  tooManyOpen: 'You have 20 open invitations. Cancel one to send another.',
  invitationLimited: 'You can send 5 invitations a day. Try again tomorrow.',
  invitationNotFound: 'This invitation is not available. Reload the page to see your invitations.',
  notCancellable: 'This invitation has already ended. To end access you gave, revoke it in Access and consent.',
  notAccepted: 'The provider has not accepted this invitation yet.',
  sessionRequired: 'An active patient session is required',
  staffNotFound: 'This invitation is not available.',
  staffNotEligible: 'Your role at this facility cannot receive patient records through Health ID.',
  staffNotPending: 'This invitation has already been accepted, cancelled or has ended.',
  staffDenied: 'Sharing is not available for your account at this facility.',
} as const;

const SHARE_EMAIL = /^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+$/u;
const localSearchKey = randomBytes(32);

type ShareRow = {
  consent_grant_id: string; membership_id: string; scope: 'read_records' | 'write_records'; level: ShareLevel;
  duration_preset: ShareDuration; starts_at: Date; expires_at: Date; clinician_name: string | null; facility_name: string;
  replaced_consent_grant_id: string | null; replayed: boolean; notify_email: string | null;
};

export interface ShareCreated {
  consentGrantId: string;
  membershipId: string;
  scope: 'read_records' | 'write_records';
  level: ShareLevel;
  duration: ShareDuration;
  startsAt: Date;
  expiresAt: Date;
  clinicianName: string | null;
  facilityName: string;
  replacedConsentGrantId: string | null;
  replayed: boolean;
}

/** A clinician's name as the patient and the clinician see it: a person's name, or null. */
export function shownClinicianName(name: string | null | undefined): string | null {
  const trimmed = name?.trim() ?? '';
  return trimmed && acceptableStaffPersonName(trimmed) ? trimmed : null;
}

/** The address as stored and compared: trimmed and lower case, or null when it is not one. */
export function normalizeShareEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return email.length >= 3 && email.length <= 254 && SHARE_EMAIL.test(email) ? email : null;
}

/**
 * Patient sharing (B4, migration 0095): find a verified clinician and share
 * the record with them at a level for a duration (P1, P2); invite a provider
 * by email, an offer the invitee accepts and the patient then confirms (P4-P7,
 * D7); and the clinician's side (S1-S3). Every command runs in a session-bound
 * SECURITY DEFINER function; the patient ones in a system transaction with the
 * verified subject bound, the staff ones in the staff request context.
 * PATIENT_SHARES_ENABLED=false answers 404 everywhere, as an older Identity.
 * Emails go after commit and never change the answer, except an invitation's
 * deliveryOutcome when its send finishes within the request.
 */
@Injectable()
export class PatientSharesService implements BeforeApplicationShutdown {
  private readonly environment = getEnvironment();
  private readonly logger = new Logger(PatientSharesService.name);
  private readonly emails = new AfterResponseTasks(this.logger, 'Sharing email could not be sent');
  private readonly key: Buffer | null = this.environment.OTP_HMAC_KEY_B64
    ? Buffer.from(this.environment.OTP_HMAC_KEY_B64, 'base64')
    : this.environment.NODE_ENV === 'production' ? null : localSearchKey;

  constructor(private readonly database: DatabaseService, private readonly notification: NotificationOtpClient,
    private readonly audit: AuditService) {}

  /** Waits for the emails started so far (tests). */
  settleEmails(): Promise<void> {
    return this.emails.settle();
  }

  beforeApplicationShutdown(): Promise<void> {
    return this.emails.settle(AFTER_RESPONSE_SHUTDOWN_GRACE_MS);
  }

  /** 404 while PATIENT_SHARES_ENABLED is false: the route reads as not served. */
  assertServed(): void {
    if (!this.environment.PATIENT_SHARES_ENABLED) throw new NotFoundException();
  }

  /** The patient's search bucket: HMAC-SHA-256 with the OTP key over 'share-provider-search\0' + account id. */
  searchBucket(accountId: string): string {
    if (!this.key) throw unavailable();
    return createHmac('sha256', this.key).update('share-provider-search\0').update(accountId).digest('hex');
  }

  /** P1. */
  async search(request: HidRequest, query: unknown) {
    this.assertServed();
    const actor = requirePatient(request.actor);
    if (typeof query !== 'string' || query.trim().length < 3 || query.trim().length > 80) {
      throw new DomainProblem(400, 'SHARE_SEARCH_QUERY_INVALID', SHARE_DETAIL.queryInvalid);
    }
    const bucket = this.searchBucket(actor.accountId);
    let limited: boolean;
    try {
      limited = await this.database.withSystemTransaction(request.correlationId,
        (client) => consumeRateLimit(client, 'account', bucket, SHARE_SEARCH_WINDOW));
    } catch {
      throw unavailable();
    }
    if (limited) throw new DomainProblem(429, 'SHARE_SEARCH_LIMITED', SHARE_DETAIL.searchLimited);
    let rows: Array<{ membership_id: string; clinician_name: string | null; role_code: string; facility_name: string;
      organization_name: string; new_on_health_id: boolean | null }>;
    try {
      rows = await this.asPatient(request, actor, async (client) => (await client.query(
        `select membership_id::text, clinician_name, role_code, facility_name, organization_name, new_on_health_id
           from identity.search_share_providers($1, $2, $3)`, [actor.subject, actor.sessionId, query.trim()])).rows);
    } catch (error) {
      throw this.problem(error, { '22023': () => new DomainProblem(400, 'SHARE_SEARCH_QUERY_INVALID', SHARE_DETAIL.queryInvalid) });
    }
    const items = rows
      .filter((row) => shownClinicianName(row.clinician_name) !== null
        && ['doctor', 'clinician', 'nurse'].includes(row.role_code))
      .slice(0, SHARE_SEARCH_RESULTS)
      .map((row) => ({ membershipId: row.membership_id, clinicianName: shownClinicianName(row.clinician_name)!,
        role: row.role_code as 'doctor' | 'clinician' | 'nurse', facilityName: row.facility_name,
        organizationName: row.organization_name, newOnHealthId: row.new_on_health_id === true }));
    return { items };
  }

  /** P2: 201 a new share, 200 a replay. */
  async create(request: HidRequest, input: CreateShareDto, idempotencyKey: string): Promise<ShareCreated> {
    this.assertServed();
    const actor = requirePatient(request.actor);
    const body = { membershipId: input.membershipId.toLowerCase(), level: input.level, duration: input.duration };
    let row: ShareRow | undefined;
    try {
      row = await this.asPatient(request, actor, async (client) => {
        await requireNoRecentRecoveryHold(client, actor.accountId, 'new shares');
        await requireRecentPatientAuthentication(client, actor, SHARE_DETAIL.recentAuth);
        return (await client.query<ShareRow>(
          `select consent_grant_id::text, membership_id::text, scope, level, duration_preset, starts_at, expires_at,
             clinician_name, facility_name, replaced_consent_grant_id::text, replayed, notify_email
           from identity.create_my_consent_share($1, $2, $3, $4, $5, $6, $7)`,
          [actor.subject, actor.sessionId, body.membershipId, body.level, body.duration, idempotencyKey,
            requestDigest('identity.share.create', body)])).rows[0];
      });
    } catch (error) {
      if (isDatabaseError(error) && (error.code === 'P0002' || error.code === 'P0001')) {
        await this.recordRefusal(request, actor, error.code === 'P0002' ? 'provider_unavailable' : 'rate_limited');
      }
      throw this.problem(error, {
        P0002: () => new DomainProblem(404, 'SHARE_PROVIDER_UNAVAILABLE', SHARE_DETAIL.providerUnavailable),
        P0001: () => new DomainProblem(429, 'SHARE_CREATE_LIMITED', SHARE_DETAIL.createLimited),
      });
    }
    if (!row) throw unavailable();
    this.announceShare(request.correlationId, row);
    return this.shareView(row);
  }

  /** P4: the B4 served probe. */
  async invitations(request: HidRequest) {
    this.assertServed();
    const actor = requirePatient(request.actor);
    let listed: { items?: Array<Record<string, unknown>> } | null | undefined;
    try {
      listed = await this.asPatient(request, actor, async (client) => (await client.query<{ listed: typeof listed }>(
        'select identity.list_my_share_invitations($1, $2) as listed', [actor.subject, actor.sessionId])).rows[0]?.listed);
    } catch (error) {
      throw this.problem(error);
    }
    if (!listed || !Array.isArray(listed.items)) {
      throw new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'Patient access is unavailable');
    }
    return {
      ...listed,
      items: listed.items.map((item) => {
        const offer = item.offer as Record<string, unknown> | null | undefined;
        return offer ? { ...item, offer: { ...offer, clinicianName: shownClinicianName(offer.clinicianName as string | null) } }
          : { ...item, offer: null };
      }),
    };
  }

  /** P5: 201 a new invitation, 200 a replay; the same answer whether or not the address is registered (D7). */
  async invite(request: HidRequest, input: CreateShareInvitationDto, idempotencyKey: string) {
    this.assertServed();
    const actor = requirePatient(request.actor);
    const email = normalizeShareEmail(input.email);
    if (!email) throw new DomainProblem(400, 'SHARE_INVITATION_EMAIL_INVALID', SHARE_DETAIL.emailInvalid);
    const name = input.name?.trim() || null;
    const body = { email, name, level: input.level, duration: input.duration };
    let row: { invitation_id: string; reference: string; status: 'pending'; expires_at: Date; send_email: boolean;
      replayed: boolean; delivery?: string | null } | undefined;
    try {
      row = await this.asPatient(request, actor, async (client) => {
        await requireNoRecentRecoveryHold(client, actor.accountId, 'new invitations to share');
        const created = (await client.query<NonNullable<typeof row>>(
          `select invitation_id::text, reference, status, expires_at, send_email, replayed
             from identity.create_my_share_invitation($1, $2, $3, $4, $5, $6, $7, $8)`,
          [actor.subject, actor.sessionId, email, name, body.level, body.duration, idempotencyKey,
            requestDigest('identity.share-invitation.create', body)])).rows[0];
        if (created?.replayed) created.delivery = await this.storedDelivery(client, actor, created.invitation_id);
        return created;
      });
    } catch (error) {
      throw this.problem(error, {
        P0001: () => new DomainProblem(429, 'SHARE_INVITATION_LIMITED', SHARE_DETAIL.invitationLimited),
        '22023': (message) => message === 'SHARE_INVITATION_EMAIL_INVALID'
          ? new DomainProblem(400, 'SHARE_INVITATION_EMAIL_INVALID', SHARE_DETAIL.emailInvalid)
          : new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.'),
        '55000': (message) => message === 'SHARE_INVITATION_ALREADY_OPEN'
          ? new DomainProblem(409, 'SHARE_INVITATION_ALREADY_OPEN', SHARE_DETAIL.alreadyOpen)
          : message === 'SHARE_INVITATION_TOO_MANY_OPEN'
            ? new DomainProblem(409, 'SHARE_INVITATION_TOO_MANY_OPEN', SHARE_DETAIL.tooManyOpen)
            : undefined,
        '23505': () => new DomainProblem(409, 'SHARE_INVITATION_ALREADY_OPEN', SHARE_DETAIL.alreadyOpen),
      });
    }
    if (!row) throw unavailable();
    let deliveryOutcome: 'sent' | 'not_confirmed' = row.delivery === 'sent' ? 'sent' : 'not_confirmed';
    if (!row.replayed && row.send_email) {
      const delivery = await this.notification.deliverPatientShareInvitation({
        invitationId: row.invitation_id, recipient: email, reference: row.reference, level: body.level,
        duration: body.duration, expiresAt: new Date(row.expires_at), correlationId: request.correlationId,
      }).catch(() => ({ outcome: 'unknown' as const, safeCode: 'transport_error' }));
      deliveryOutcome = delivery.outcome === 'accepted' ? 'sent' : 'not_confirmed';
      try {
        await this.asPatient(request, actor, (client) => client.query(
          'select identity.record_my_share_invitation_delivery($1, $2, $3, $4, $5, $6)',
          [actor.subject, actor.sessionId, row!.invitation_id, delivery.outcome,
            'provider' in delivery && delivery.provider ? delivery.provider : null, delivery.safeCode ?? null]));
      } catch (error) {
        // The invitation exists and was sent (or not); the outcome is only not recorded.
        this.logger.warn(`Share invitation delivery outcome not recorded (correlation ${request.correlationId}, `
          + `code ${isDatabaseError(error) ? error.code : 'unknown'})`);
      }
    }
    return { invitationId: row.invitation_id, reference: row.reference, status: 'pending' as const,
      expiresAt: new Date(row.expires_at), deliveryOutcome, replayed: row.replayed };
  }

  /** P6: cancels a pending invitation or declines an accepted offer. */
  async cancel(request: HidRequest, invitationId: string) {
    this.assertServed();
    const actor = requirePatient(request.actor);
    try {
      const row = await this.asPatient(request, actor, async (client) => (await client.query<{
        invitation_id: string; status: 'cancelled'; replayed: boolean }>(
        'select invitation_id::text, status, replayed from identity.cancel_my_share_invitation($1, $2, $3)',
        [actor.subject, actor.sessionId, invitationId])).rows[0]);
      if (!row) throw unavailable();
      return { invitationId: row.invitation_id, status: row.status, replayed: row.replayed };
    } catch (error) {
      throw this.problem(error, {
        P0002: () => new DomainProblem(404, 'SHARE_INVITATION_NOT_FOUND', SHARE_DETAIL.invitationNotFound),
        '55000': () => new DomainProblem(409, 'SHARE_INVITATION_NOT_CANCELLABLE', SHARE_DETAIL.notCancellable),
      });
    }
  }

  /** P7: the patient confirms an accepted offer; 201 the grant, 200 a repeat. */
  async confirm(request: HidRequest, invitationId: string) {
    this.assertServed();
    const actor = requirePatient(request.actor);
    let row: (ShareRow & { invitation_id: string }) | undefined;
    try {
      row = await this.asPatient(request, actor, async (client) => {
        await requireNoRecentRecoveryHold(client, actor.accountId, 'new shares');
        await requireRecentPatientAuthentication(client, actor, SHARE_DETAIL.recentAuth);
        return (await client.query<ShareRow & { invitation_id: string }>(
          `select invitation_id::text, consent_grant_id::text, null::text as membership_id, scope, level, duration_preset,
             starts_at, expires_at, clinician_name, facility_name, replaced_consent_grant_id::text, replayed, notify_email
           from identity.confirm_my_share_invitation($1, $2, $3)`,
          [actor.subject, actor.sessionId, invitationId])).rows[0];
      });
    } catch (error) {
      throw this.problem(error, {
        P0002: () => new DomainProblem(404, 'SHARE_INVITATION_NOT_FOUND', SHARE_DETAIL.invitationNotFound),
        '55000': (message) => message === 'SHARE_PROVIDER_UNAVAILABLE'
          ? new DomainProblem(409, 'SHARE_PROVIDER_UNAVAILABLE', SHARE_DETAIL.providerUnavailableOffer)
          : new DomainProblem(409, 'SHARE_INVITATION_NOT_ACCEPTED', SHARE_DETAIL.notAccepted),
      });
    }
    if (!row) throw unavailable();
    this.announceShare(request.correlationId, row);
    const { membershipId: _membership, ...share } = this.shareView(row);
    return { invitationId: row.invitation_id, status: 'confirmed' as const, ...share };
  }

  /** S1: the active patient shares to the caller's membership. */
  async sharedWithMe(context: DataAccessContext) {
    this.assertServed();
    try {
      return await this.database.withTransaction(context, async (client) => {
        const rows = (await client.query<{ consent_grant_id: string; patient_id: string; hid: string; full_name: string;
          level: ShareLevel; duration_preset: ShareDuration; scope: string; starts_at: Date; expires_at: Date }>(
          `select consent_grant_id::text, patient_id::text, hid, full_name, level, duration_preset, scope, starts_at, expires_at
             from identity.list_shared_with_me()`)).rows;
        return { items: rows.map((row) => ({ consentGrantId: row.consent_grant_id, patientId: row.patient_id, hid: row.hid,
          fullName: row.full_name, level: row.level, duration: row.duration_preset, scope: row.scope,
          startsAt: row.starts_at, expiresAt: row.expires_at })) };
      });
    } catch (error) {
      throw this.staffProblem(error);
    }
  }

  /** S2: the invitations addressed to the caller's verified sign-in email; no patient identity. */
  async staffInvitations(context: DataAccessContext) {
    this.assertServed();
    try {
      return await this.database.withTransaction(context, async (client) => {
        const listed = (await client.query<{ listed: { eligible: boolean; items: unknown[] } | null }>(
          'select identity.list_share_invitations_for_me() as listed')).rows[0]?.listed;
        return { eligible: listed?.eligible === true, items: listed?.eligible === true ? listed.items ?? [] : [] };
      });
    } catch (error) {
      throw this.staffProblem(error);
    }
  }

  /** S3: the invitee accepts at their current membership. */
  async accept(context: DataAccessContext, invitationId: string) {
    this.assertServed();
    try {
      const row = await this.database.withTransaction(context, async (client) => (await client.query<{
        invitation_id: string; status: 'accepted'; accepted_at: Date; replayed: boolean }>(
        'select invitation_id::text, status, accepted_at, replayed from identity.accept_share_invitation($1)',
        [invitationId])).rows[0]);
      if (!row) throw unavailable();
      return { invitationId: row.invitation_id, status: row.status, acceptedAt: row.accepted_at, replayed: row.replayed };
    } catch (error) {
      throw this.staffProblem(error);
    }
  }

  private shareView(row: ShareRow): ShareCreated {
    return {
      consentGrantId: row.consent_grant_id, membershipId: row.membership_id, scope: row.scope, level: row.level,
      duration: row.duration_preset, startsAt: new Date(row.starts_at), expiresAt: new Date(row.expires_at),
      clinicianName: shownClinicianName(row.clinician_name), facilityName: row.facility_name,
      replacedConsentGrantId: row.replaced_consent_grant_id, replayed: row.replayed,
    };
  }

  /** E2 after commit, never on a replay: no patient name, Health ID or level; the outcome code only is logged. */
  private announceShare(correlationId: string, row: ShareRow): void {
    if (row.replayed || !row.notify_email) return;
    const recipient = row.notify_email;
    // The alert's character set (notification-api's DTO), and never text that reads like a domain.
    const cleaned = alertFacilityName(row.facility_name);
    const facilityName = cleaned ? emailFacilityName(cleaned) : undefined;
    this.emails.run(correlationId, async () => {
      const delivery = await this.notification.deliverShareReceived({ consentGrantId: row.consent_grant_id, recipient,
        ...(facilityName ? { facilityName } : {}), correlationId });
      if (delivery.outcome !== 'accepted') {
        this.logger.warn(`Share-received email was not accepted (correlation ${correlationId}, `
          + `outcome ${delivery.outcome}${delivery.safeCode ? `, code ${delivery.safeCode}` : ''})`);
      }
    });
  }

  private async storedDelivery(client: PoolClient, actor: ReturnType<typeof requirePatient>, invitationId: string) {
    const listed = (await client.query<{ listed: { items?: Array<{ invitationId?: string; deliveryOutcome?: string }> } | null }>(
      'select identity.list_my_share_invitations($1, $2) as listed', [actor.subject, actor.sessionId])).rows[0]?.listed;
    return listed?.items?.find((item) => item.invitationId === invitationId)?.deliveryOutcome ?? null;
  }

  /** P2's refusals, audited with the reason only (the SQL refusal rolls its transaction back). */
  private async recordRefusal(request: HidRequest, actor: ReturnType<typeof requirePatient>,
    reason: 'provider_unavailable' | 'rate_limited'): Promise<void> {
    await this.audit.record({ correlationId: request.correlationId, actorType: 'patient', actorSubject: actor.subject,
      actorAccountId: actor.accountId, patientId: actor.patientId, action: 'identity.consent-grant.patient-share',
      resourceType: 'consent-grant', outcome: 'denied', purposeOfUse: 'patient-self', details: { reason } })
      .catch(() => undefined);
  }

  private asPatient<T>(request: HidRequest, actor: ReturnType<typeof requirePatient>,
    work: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.database.withSystemTransaction(request.correlationId, async (client) => {
      await client.query("select set_config('app.actor_subject',$1,true)", [actor.subject]);
      return work(client);
    });
  }

  /** A patient command's database refusal: the given codes, then the shared ones; anything else 503. */
  private problem(error: unknown,
    mapped: Record<string, (message: string) => DomainProblem | undefined> = {}): unknown {
    if (error instanceof DomainProblem) return error;
    if (!isDatabaseError(error)) return unavailable();
    const message = databaseMessage(error);
    const special = mapped[error.code]?.(message);
    if (special) return special;
    if (error.code === '42501') return new DomainProblem(403, 'PATIENT_SESSION_REQUIRED', SHARE_DETAIL.sessionRequired);
    if (error.code === '55000' && message === 'IDEMPOTENCY_KEY_REUSED') {
      return new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED', SHARE_DETAIL.keyReused);
    }
    if (error.code === '22023' || error.code === '22P02') {
      return new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.');
    }
    return unavailable();
  }

  private staffProblem(error: unknown): unknown {
    if (error instanceof DomainProblem) return error;
    if (!isDatabaseError(error)) return unavailable();
    const message = databaseMessage(error);
    switch (error.code) {
      case 'P0002': return new DomainProblem(404, 'SHARE_INVITATION_NOT_FOUND', SHARE_DETAIL.staffNotFound);
      case '42501': return message === 'SHARE_PROVIDER_NOT_ELIGIBLE'
        ? new DomainProblem(403, 'SHARE_PROVIDER_NOT_ELIGIBLE', SHARE_DETAIL.staffNotEligible)
        : new DomainProblem(403, 'SHARE_PERMISSION_DENIED', SHARE_DETAIL.staffDenied);
      case '55000': return new DomainProblem(409, 'SHARE_INVITATION_NOT_PENDING', SHARE_DETAIL.staffNotPending);
      default: return unavailable();
    }
  }
}

function unavailable(): DomainProblem {
  return new DomainProblem(503, 'SHARE_UNAVAILABLE', SHARE_DETAIL.unavailable);
}
