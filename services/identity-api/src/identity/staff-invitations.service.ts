import { Injectable, Logger } from '@nestjs/common';
import { createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { NotificationOtpClient, type OtpDeliveryOutcome } from '../auth/notification-otp.client';
import { assertPasswordLength, hashAccountPassword } from '../auth/password-hash';
import { consumeRateLimit } from '../auth/rate-limit';
import { requireNoRecentRecoveryHold } from '../auth/recent-authentication';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext, FacilityAssignment, HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import type { CreateStaffInvitationDto, OpenStaffInvitationDto, SignedInInvitationDto } from './dto/staff-invitation.dto';
import { quotaNetwork } from './provider-enrollment.service';
import { assertStaffInvitationsOpen } from './staff-invitation-gate';
import { acceptancePreCheckProblem, invitationResultProblem, staffCommandProblem, staffRefusal,
  unavailableFor, type StaffCommandScope } from './staff-invitation-problems';
import { normalizeLicenceNumber } from './staff-licence';
import { emailFacilityName, shownInviterName } from './staff-names';
import { StaffReauthenticationService } from './staff-reauthentication.service';

const localInvitationKey = randomBytes(32);

/** Opens per client network an hour (SPEC 4.3). */
export const STAFF_INVITATION_OPEN_WINDOW = { windowSeconds: 3600, maxRequests: 20 } as const;
/** How long the accountless acceptance session lasts (SPEC 4.7). */
export const STAFF_INVITATION_SESSION_SECONDS = 3600;

/**
 * The attestation the administrator ticks when inviting or changing a role
 * (SPEC 4.2): its text is seeded in identity.staff_attestation_texts and served
 * by the state read; the database stores this version, never the filled text.
 */
export const STAFF_ATTESTATION_VERSION = 'facility-staff-attestation-v1';

/** What an administrator's own facility must be for a staff command (SPEC 3.9 I3). */
export type SelfServiceRequirement = 'reviewed' | 'pending' | 'any';

interface CreateRow extends QueryResultRow {
  invitation_id: string;
  row_version: string | number;
  send_id: string;
  expires_at: Date | string;
  replayed: boolean;
  dispatch: boolean;
  facility_name: string | null;
  role_code: string;
  invitee_email: string;
  /** Optional: the stored outcome, answered on a replay. Absent reads 'unknown'. */
  delivery_outcome?: string | null;
}

interface ResendRow extends QueryResultRow {
  row_version: string | number;
  expires_at: Date | string;
  send_id: string;
  dispatch: boolean;
  facility_name: string | null;
  role_code: string;
  invitee_email: string;
}

interface RevokeRow extends QueryResultRow {
  row_version: string | number;
  revoked_at: Date | string;
}

interface OpenRow extends QueryResultRow {
  result: string;
  invitation_id: string | null;
  facility_name: string | null;
  role_code: string | null;
  inviter_name: string | null;
  invitee_name: string | null;
  invitee_email: string | null;
  expires_at: Date | string | null;
  account_case: string | null;
  link_required: boolean | null;
  session_expires_at: Date | string | null;
}

interface PrepareRow extends QueryResultRow {
  result: string;
  account_case: string | null;
}

interface AcceptRow extends QueryResultRow {
  account_id: string;
  membership_id: string;
  organization_id: string;
  facility_id: string;
  facility_name: string;
  role_code: string;
  account_case: string;
}

interface PreviewRow extends QueryResultRow {
  result: string;
  invitation_id: string | null;
  facility_id: string | null;
  facility_name: string | null;
  role_code: string | null;
  inviter_name: string | null;
  expires_at: Date | string | null;
}

interface SignedInAcceptRow extends QueryResultRow {
  result: string;
  membership_id: string | null;
  facility_id: string | null;
  facility_name: string | null;
  role_code: string | null;
}

export type StaffInvitationDeliveryOutcome = OtpDeliveryOutcome;

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function answeredOutcome(value: string | null | undefined): StaffInvitationDeliveryOutcome {
  return value === 'accepted' || value === 'definitive_failure' ? value : 'unknown';
}

/**
 * Facility staff invitations (P4b, SPEC 4.4-4.9). The administrator of a
 * reviewed self-signed-up facility invites a member of staff by email, vouching
 * for their licence; the invitee accepts with the emailed link (a 256-bit token
 * the administrator never sees) or, as a fallback, the email address and a
 * 6-digit code. Secrets travel only in request bodies and the link's fragment;
 * the database keeps only their HMACs. New and dormant accounts accept here,
 * accountless, and sign in on their role's host; existing staff accept while
 * signed in on their own host.
 *
 * Every refusal the database makes is answered by exact message
 * (staff-invitation-problems.ts); the database is authoritative for every
 * rule, and Identity's own checks only answer earlier.
 */
@Injectable()
export class StaffInvitationsService {
  private readonly environment = getEnvironment();
  private readonly logger = new Logger(StaffInvitationsService.name);
  private readonly key: Buffer | null = this.environment.OTP_HMAC_KEY_B64
    ? Buffer.from(this.environment.OTP_HMAC_KEY_B64, 'base64')
    : this.environment.NODE_ENV === 'production' ? null : localInvitationKey;

  constructor(
    private readonly database: DatabaseService,
    private readonly notification: NotificationOtpClient,
    private readonly reauthentication: StaffReauthenticationService,
  ) {}

  /**
   * The I3 fast check (SPEC 3.9): staff management exists only at a
   * self-signed-up facility (403 STAFF_MANAGEMENT_NOT_AVAILABLE otherwise);
   * every write but the administrator's own licence needs support's review
   * (409 FACILITY_REVIEW_PENDING), and that licence is recorded only before it
   * (409 FACILITY_ALREADY_REVIEWED). The database makes the same checks.
   */
  requireSelfService(facility: FacilityAssignment | undefined, requirement: SelfServiceRequirement): void {
    const review = facility?.selfService?.review;
    if (!review) throw staffRefusal('STAFF_MANAGEMENT_NOT_AVAILABLE');
    if (requirement === 'reviewed' && review !== 'reviewed') throw staffRefusal('FACILITY_REVIEW_PENDING');
    if (requirement === 'pending' && review !== 'pending') throw staffRefusal('FACILITY_ALREADY_REVIEWED');
  }

  /** The gate (staff-invitation-gate.ts): 423 STAFF_INVITATIONS_UNAVAILABLE while closed. */
  assertOpen(scope: StaffCommandScope): Promise<void> {
    return assertStaffInvitationsOpen(this.database, () => unavailableFor(scope));
  }

  /**
   * Invite (SPEC 4.4): the I3 check, the gate, password re-entry, then the
   * command with the recovery hold in its transaction; the email is sent
   * after commit, synchronously, only for a first, dispatched send, and its
   * outcome recorded in a second transaction. 201, or 200 with the stored
   * values for a replay of the same Idempotency-Key and request (nothing sent).
   */
  async create(context: DataAccessContext, request: HidRequest, input: CreateStaffInvitationDto, idempotencyKey: string) {
    this.requireSelfService(context.actor.facility, 'reviewed');
    await this.assertOpen('staff');
    const key = this.requireKey('staff');
    await this.reauthentication.confirm(context.actor, input.currentPassword, request);

    const invitationId = randomUUID();
    const sendId = randomUUID();
    const token = this.newToken();
    const code = this.newCode();
    const email = input.email.trim().toLowerCase();
    const licenceBody = input.licenceBody ?? null;
    const licenceNumber = typeof input.licenceNumber === 'string' ? normalizeLicenceNumber(input.licenceNumber) : null;
    // The canonical request (S16): the facility, the person, the role and the
    // licence; never the password.
    const requestSha256 = requestDigest('staff-invitation.create', {
      facilityId: context.facilityId, name: input.name, email, role: input.role, licenceBody, licenceNumber,
    });

    let row: CreateRow | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) => {
        await requireNoRecentRecoveryHold(client, context.actor.accountId, 'staff invitations and role changes',
          'STAFF_RECENT_RECOVERY_HOLD');
        const result = await client.query<CreateRow>(
          'select * from identity.create_staff_invitation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
          [invitationId, sendId, input.name, email, input.role, licenceBody, licenceNumber,
            STAFF_ATTESTATION_VERSION, idempotencyKey, requestSha256,
            this.hmac(key, 'link', invitationId, token), this.hmac(key, 'email-code', email, code),
            this.environment.OTP_HMAC_KEY_VERSION]);
        return result.rows[0];
      });
    } catch (error) {
      throw staffCommandProblem(error, 'create');
    }
    if (!row) throw unavailableFor('staff');
    if (row.replayed === true) {
      return { status: 200 as const, body: { invitationId: row.invitation_id, version: Number(row.row_version),
        expiresAt: iso(row.expires_at), deliveryOutcome: answeredOutcome(row.delivery_outcome), replayed: true } };
    }
    const deliveryOutcome = row.dispatch === true
      ? await this.send(context, row, row.invitation_id, token, code)
      : 'unknown' as const;
    return { status: 201 as const, body: { invitationId: row.invitation_id, version: Number(row.row_version),
      expiresAt: iso(row.expires_at), deliveryOutcome, replayed: false } };
  }

  /**
   * Resend (SPEC 4.5): new token and code (the old ones answer 410
   * superseded), expiry renewed, the typed counter reset; sent and recorded as
   * an invitation is. The emailed code is bound to the invitee's email, which
   * Identity reads from the facility's own invitation list in the same
   * transaction: an invitation that is not there (another facility's, or
   * none) answers 404 before the command.
   */
  async resend(context: DataAccessContext, invitationId: string, expectedVersion: number) {
    this.requireSelfService(context.actor.facility, 'reviewed');
    await this.assertOpen('staff');
    const key = this.requireKey('staff');
    const sendId = randomUUID();
    const token = this.newToken();
    const code = this.newCode();
    let row: ResendRow | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) => {
        await requireNoRecentRecoveryHold(client, context.actor.accountId, 'staff invitations and role changes',
          'STAFF_RECENT_RECOVERY_HOLD');
        const email = await this.inviteeEmail(client, invitationId);
        const result = await client.query<ResendRow>(
          'select * from identity.resend_staff_invitation($1,$2,$3,$4,$5,$6)',
          [invitationId, expectedVersion, sendId, this.hmac(key, 'link', invitationId, token),
            this.hmac(key, 'email-code', email, code), this.environment.OTP_HMAC_KEY_VERSION]);
        return result.rows[0];
      });
    } catch (error) {
      throw staffCommandProblem(error, 'invitation');
    }
    if (!row) throw unavailableFor('staff');
    const deliveryOutcome = row.dispatch === true
      ? await this.send(context, row, invitationId, token, code)
      : 'unknown' as const;
    return { version: Number(row.row_version), expiresAt: iso(row.expires_at), deliveryOutcome };
  }

  /** Revoke a waiting invitation (SPEC 4.5): not gated, not held. */
  async revoke(context: DataAccessContext, invitationId: string, expectedVersion: number) {
    this.requireSelfService(context.actor.facility, 'reviewed');
    let row: RevokeRow | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) => (await client.query<RevokeRow>(
        'select * from identity.revoke_staff_invitation($1,$2)', [invitationId, expectedVersion])).rows[0]);
    } catch (error) {
      throw staffCommandProblem(error, 'invitation');
    }
    if (!row) throw unavailableFor('staff');
    return { version: Number(row.row_version), revokedAt: iso(row.revoked_at) };
  }

  /**
   * Open an invitation (SPEC 4.7), after the controller's Origin, signed-in and
   * Turnstile checks: the gate, the network's 20 an hour (its own committed
   * transaction), then the command, which answers a `result` instead of
   * raising so its failure counters commit. For a new or dormant account in
   * link mode the command starts the acceptance session; its token is
   * returned for the cookie and only its HMAC is stored.
   */
  async open(input: OpenStaffInvitationDto, request: HidRequest) {
    await this.assertOpen('public');
    const key = this.requireKey('public');
    const network = quotaNetwork(request.ip);
    if (!network) throw unavailableFor('public');
    let limited: boolean;
    try {
      limited = await this.database.withSystemTransaction(request.correlationId, (client) =>
        consumeRateLimit(client, 'ip', this.hmac(key, 'network', network), STAFF_INVITATION_OPEN_WINDOW));
    } catch {
      throw unavailableFor('public');
    }
    if (limited) {
      throw new DomainProblem(429, 'STAFF_INVITATION_RATE_LIMITED', 'Too many invitations opened from this network; try again later');
    }
    const linkMode = typeof input.invitationId === 'string';
    const email = linkMode ? null : (input.email ?? '').trim().toLowerCase();
    const sessionToken = this.newToken();
    let row: OpenRow | undefined;
    try {
      row = await this.database.withSystemTransaction(request.correlationId, async (client) => (await client.query<OpenRow>(
        'select * from identity.open_staff_invitation($1,$2,$3,$4,$5)',
        [linkMode ? input.invitationId : null,
          linkMode ? this.hmac(key, 'link', input.invitationId as string, input.token as string) : null,
          email, email === null ? null : this.hmac(key, 'email-code', email, input.code as string),
          this.hmac(key, 'session', sessionToken)])).rows[0]);
    } catch (error) {
      throw staffCommandProblem(error, 'public');
    }
    if (!row || row.result !== 'ready') throw invitationResultProblem(row?.result, 'public');
    return {
      body: {
        invitationId: row.invitation_id,
        facilityName: row.facility_name,
        roleCode: row.role_code,
        inviterName: shownInviterName(row.inviter_name),
        inviteeName: row.invitee_name,
        email: row.invitee_email,
        expiresAt: iso(row.expires_at),
        accountCase: row.account_case,
        linkRequired: row.link_required === true,
      },
      // The command set a session only for a new or dormant account in link mode.
      sessionToken: row.session_expires_at ? sessionToken : undefined,
    };
  }

  /**
   * Accept as a new or dormant account (SPEC 4.8): the pre-check in its own
   * committed transaction charges one of the session's 5 attempts and answers
   * anything that cannot succeed before the 64 MiB argon2 hash (P4's R1); then
   * the command re-checks everything under its locks. No session is issued:
   * the person signs in on their role's host.
   */
  async accept(sessionToken: string | undefined, password: string, correlationId: string) {
    assertPasswordLength(password);
    const key = this.requireKey('public-accept');
    if (!sessionToken || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) throw staffRefusal('STAFF_INVITATION_SESSION_INVALID');
    const sessionHmac = this.hmac(key, 'session', sessionToken);
    let preCheck: PrepareRow | undefined;
    try {
      preCheck = await this.database.withSystemTransaction(correlationId, async (client) => (await client.query<PrepareRow>(
        'select * from identity.prepare_staff_invitation_acceptance($1)', [sessionHmac])).rows[0]);
    } catch (error) {
      throw staffCommandProblem(error, 'public-accept');
    }
    if (preCheck?.result !== 'ready') throw acceptancePreCheckProblem(preCheck?.result);
    const passwordHash = await hashAccountPassword(password);
    let row: AcceptRow | undefined;
    try {
      row = await this.database.withSystemTransaction(correlationId, async (client) => (await client.query<AcceptRow>(
        'select * from identity.accept_staff_invitation_with_password($1,$2)', [sessionHmac, passwordHash])).rows[0]);
    } catch (error) {
      throw staffCommandProblem(error, 'public-accept');
    }
    if (!row) throw unavailableFor('public-accept');
    return { accepted: true as const, facilityName: row.facility_name, roleCode: row.role_code };
  }

  /** A signed-in staff member's preview (SPEC 4.9): read-only apart from the failure counters. */
  async previewForAccount(context: DataAccessContext, input: SignedInInvitationDto) {
    await this.assertOpen('signed-in');
    const key = this.requireKey('signed-in');
    let row: PreviewRow | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) => (await client.query<PreviewRow>(
        'select * from identity.preview_staff_invitation_for_account($1,$2,$3)',
        this.signedInArguments(key, context, input))).rows[0]);
    } catch (error) {
      throw staffCommandProblem(error, 'signed-in');
    }
    if (!row || row.result !== 'ready') throw invitationResultProblem(row?.result, 'signed-in');
    return { invitationId: row.invitation_id, facilityId: row.facility_id, facilityName: row.facility_name,
      roleCode: row.role_code, inviterName: shownInviterName(row.inviter_name), expiresAt: iso(row.expires_at) };
  }

  /**
   * A signed-in staff member accepts on their own host (SPEC 4.9): the new
   * membership is listed by their session at its next request.
   */
  async acceptForAccount(context: DataAccessContext, input: SignedInInvitationDto) {
    await this.assertOpen('signed-in');
    const key = this.requireKey('signed-in');
    let row: SignedInAcceptRow | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) => (await client.query<SignedInAcceptRow>(
        'select * from identity.accept_staff_invitation_for_account($1,$2,$3)',
        this.signedInArguments(key, context, input))).rows[0]);
    } catch (error) {
      throw staffCommandProblem(error, 'signed-in');
    }
    if (!row || row.result !== 'ready') throw invitationResultProblem(row?.result, 'signed-in');
    return { accepted: true as const, facilityId: row.facility_id, membershipId: row.membership_id,
      facilityName: row.facility_name, roleCode: row.role_code };
  }

  /** The link token: 32 random bytes, base64url (43 characters). */
  newToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /** The typed fallback code: 6 digits. */
  newCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  /**
   * HMAC-SHA-256 with the OTP key over 'staff-invitation\0' + label and each
   * part after '\0' (the completion service's construction, its own domain).
   * Labels: link, email-code, session, network.
   */
  hmac(key: Buffer, label: 'link' | 'email-code' | 'session' | 'network', ...parts: string[]): string {
    const digest = createHmac('sha256', key).update('staff-invitation\0').update(label);
    for (const part of parts) digest.update('\0').update(part);
    return digest.digest('hex');
  }

  /** The HMAC key, or 503 when production has none (it cannot boot without one). */
  private requireKey(scope: StaffCommandScope): Buffer {
    if (!this.key) throw unavailableFor(scope);
    return this.key;
  }

  /** (invitation id, link HMAC, email-code HMAC): link mode, or typed mode bound to the session's own email. */
  private signedInArguments(key: Buffer, context: DataAccessContext, input: SignedInInvitationDto): unknown[] {
    if (typeof input.invitationId === 'string' && typeof input.token === 'string') {
      return [input.invitationId, this.hmac(key, 'link', input.invitationId, input.token), null];
    }
    const email = (context.actor.email ?? '').trim().toLowerCase();
    return [null, null, this.hmac(key, 'email-code', email, input.code ?? '')];
  }

  private async inviteeEmail(client: PoolClient, invitationId: string): Promise<string> {
    const result = await client.query<{ invitee_email: string }>(
      'select invitee_email from identity.list_facility_staff_invitations() where invitation_id = $1', [invitationId]);
    const email = result.rows[0]?.invitee_email;
    if (!email) throw new DomainProblem(404, 'STAFF_INVITATION_NOT_FOUND', 'Invitation was not found');
    return email;
  }

  /**
   * Sends the email after the command committed and records its outcome in a
   * second transaction. A failure to record is not the caller's: the send
   * stays pending and the list reads it as "delivery not confirmed".
   */
  private async send(context: DataAccessContext, row: CreateRow | ResendRow, invitationId: string, token: string,
    code: string): Promise<StaffInvitationDeliveryOutcome> {
    const facilityName = emailFacilityName(row.facility_name);
    const delivered = await this.notification.deliverStaffInvitation({
      sendId: row.send_id, invitationId, recipient: row.invitee_email,
      ...(facilityName ? { facilityName } : {}), roleCode: row.role_code, token, code,
      expiresAt: new Date(iso(row.expires_at) as string), correlationId: context.correlationId,
    }).catch(() => ({ outcome: 'unknown' as const }));
    try {
      await this.database.withTransaction(context, (client) =>
        client.query('select identity.record_staff_invitation_delivery($1,$2)', [row.send_id, delivered.outcome]));
    } catch {
      this.logger.warn('Staff invitation delivery outcome could not be recorded (event=staff_invitation_delivery_record_failed)');
    }
    return delivered.outcome;
  }
}
