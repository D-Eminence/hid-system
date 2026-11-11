import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { NotificationOtpClient, type OtpDeliveryOutcome } from '../auth/notification-otp.client';
import { assertPasswordLength, hashAccountPassword } from '../auth/password-hash';
import { consumeRateLimit } from '../auth/rate-limit';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { quotaNetwork } from '../identity/provider-enrollment.service';
import { emailFacilityName } from '../identity/staff-names';
import type { AcceptOutreachInvitationDto, CreateOutreachInvitationDto,
  SignedInOutreachInvitationDto } from './dto/outreach-organiser.dto';
import { databaseCode, domainHmac, hasRefusal, outreachKey } from './outreach-organiser-crypto';

/** The only role an outreach invitation grants. */
export const OUTREACH_VOLUNTEER_ROLE = 'outreach_volunteer';
/** The roles that mark a facility as an outreach organisation (the database's fence keeps them there). */
export const OUTREACH_TENANT_ROLES: ReadonlySet<string> = new Set(['outreach_organiser', 'outreach_volunteer']);
/** Public acceptances per client network an hour. */
export const OUTREACH_INVITATION_ACCEPT_WINDOW = { windowSeconds: 3600, maxRequests: 20 } as const;

const HMAC_DOMAIN = 'outreach-invitation';

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
  delivery_outcome?: string | null;
}

interface ListRow extends QueryResultRow {
  invitation_id: string;
  invitee_name: string;
  invitee_email: string;
  status: string;
  expires_at: Date | string;
  created_at: Date | string;
  accepted_at: Date | string | null;
}

interface AcceptRow extends QueryResultRow {
  result: string;
  account_id?: string | null;
  membership_id: string | null;
  facility_id: string | null;
  facility_name: string | null;
  role_code: string | null;
  email?: string | null;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function unavailable(): DomainProblem {
  return new DomainProblem(503, 'OUTREACH_INVITATION_UNAVAILABLE',
    'Invitations are not working right now. Please try again in a few minutes.');
}

/** A facility the signed-in organiser works at is an outreach organisation and they organise it. */
export function isOutreachOrganiserAt(context: DataAccessContext): boolean {
  return context.actor.facility?.roles.includes('outreach_organiser') === true;
}

/** The answer for an acceptance `result` other than 'ready', in plain English. */
export function invitationResultProblem(result: string | undefined): DomainProblem {
  switch (result) {
    case 'invalid': return new DomainProblem(400, 'OUTREACH_INVITATION_INVALID',
      'That invitation link or code is not right. Check the email and try again.');
    case 'expired': return new DomainProblem(410, 'OUTREACH_INVITATION_EXPIRED',
      'This invitation has expired. Ask the organiser to invite you again.');
    case 'superseded': return new DomainProblem(410, 'OUTREACH_INVITATION_SUPERSEDED',
      'A newer invitation was sent. Use the most recent email.');
    case 'revoked': return new DomainProblem(410, 'OUTREACH_INVITATION_REVOKED',
      'The organiser has cancelled this invitation.');
    case 'accepted': return new DomainProblem(409, 'OUTREACH_INVITATION_ALREADY_ACCEPTED',
      'This invitation has already been accepted. Sign in to continue.');
    case 'account_exists': return new DomainProblem(409, 'OUTREACH_INVITATION_SIGN_IN_REQUIRED',
      'This email already has a Health ID account. Sign in first, then open the invitation again.');
    case 'wrong_account': return new DomainProblem(403, 'OUTREACH_INVITATION_WRONG_ACCOUNT',
      'This invitation was sent to a different email. Sign in with the email it was sent to.');
    case 'locked': return new DomainProblem(429, 'OUTREACH_INVITATION_LOCKED',
      'Too many wrong attempts. Ask the organiser to send a new invitation.');
    default: return unavailable();
  }
}

/** The database's command refusals in plain English. */
export function outreachInvitationProblem(error: unknown): DomainProblem {
  if (error instanceof DomainProblem) return error;
  if (hasRefusal(error, 'OUTREACH_ORGANISER_REQUIRED')) return organiserRequired();
  if (hasRefusal(error, 'OUTREACH_INVITATION_PENDING_LIMIT')) {
    return new DomainProblem(429, 'OUTREACH_INVITATION_PENDING_LIMIT',
      'You have many invitations still waiting. Wait for some to be accepted, or let them expire, before inviting more.');
  }
  if (hasRefusal(error, 'OUTREACH_INVITATION_DAILY_LIMIT')) {
    return new DomainProblem(429, 'OUTREACH_INVITATION_DAILY_LIMIT',
      'You have sent a lot of invitations today. Please try again tomorrow.');
  }
  if (hasRefusal(error, 'OUTREACH_ORGANISATION_SUSPENDED')) {
    return new DomainProblem(423, 'OUTREACH_ORGANISATION_SUSPENDED',
      'This outreach group has been paused by Health ID. Contact Health ID support.');
  }
  if (hasRefusal(error, 'OUTREACH_INVITEE_ALREADY_MEMBER')) {
    return new DomainProblem(409, 'OUTREACH_INVITEE_ALREADY_MEMBER', 'This person is already in your team.');
  }
  const code = databaseCode(error);
  if (code === '23505') {
    return new DomainProblem(409, 'IDEMPOTENCY_CONFLICT', 'This invitation was already sent. Reload the page.');
  }
  if (code === '42501') return organiserRequired();
  return unavailable();
}

function organiserRequired(): DomainProblem {
  return new DomainProblem(403, 'OUTREACH_ORGANISER_REQUIRED', 'Only the organiser of this outreach group can invite helpers.');
}

/**
 * Outreach invitations (plan PR-1/PR-3): an organiser invites a helper by
 * email as outreach_volunteer, before or after Health ID's check, so a team
 * can set up and practise. They are separate commands from facility staff
 * invitations, which are unchanged. The helper accepts with the emailed link
 * or with their email and the 6-digit code: a new person sets a password and
 * is signed in; someone with a Health ID account accepts while signed in.
 */
@Injectable()
export class OutreachInvitationsService {
  private readonly environment = getEnvironment();
  private readonly logger = new Logger(OutreachInvitationsService.name);

  constructor(private readonly database: DatabaseService, private readonly notification: NotificationOtpClient) {}

  /** 201 { invitationId, expiresAt, deliveryOutcome, replayed: false }, or 200 with replayed: true. */
  async create(context: DataAccessContext, input: CreateOutreachInvitationDto, idempotencyKey: string) {
    if (!isOutreachOrganiserAt(context)) throw organiserRequired();
    const key = this.requireKey();
    const invitationId = randomUUID();
    const sendId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const email = input.email.trim().toLowerCase();
    const requestSha256 = requestDigest('outreach-invitation.create', {
      facilityId: context.facilityId, name: input.name, email,
    });
    let row: CreateRow | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) => (await client.query<CreateRow>(
        'select * from identity.create_outreach_invitation($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [invitationId, sendId, input.name, email, idempotencyKey, requestSha256,
          domainHmac(key, HMAC_DOMAIN, 'link', invitationId, token),
          domainHmac(key, HMAC_DOMAIN, 'email-code', email, code), this.environment.OTP_HMAC_KEY_VERSION])).rows[0]);
    } catch (error) {
      throw outreachInvitationProblem(error);
    }
    if (!row) throw unavailable();
    if (row.replayed === true) {
      const outcome = row.delivery_outcome === 'accepted' || row.delivery_outcome === 'definitive_failure'
        ? row.delivery_outcome : 'unknown';
      return { status: 200 as const, body: { invitationId: row.invitation_id, expiresAt: iso(row.expires_at),
        deliveryOutcome: outcome, replayed: true } };
    }
    const deliveryOutcome = row.dispatch === true ? await this.send(context, row, token, code) : 'unknown' as const;
    return { status: 201 as const, body: { invitationId: row.invitation_id, expiresAt: iso(row.expires_at),
      deliveryOutcome, replayed: false } };
  }

  /** The organiser's team invitations, newest first: { invitations: [...] }. */
  async list(context: DataAccessContext) {
    if (!isOutreachOrganiserAt(context)) throw organiserRequired();
    let rows: ListRow[];
    try {
      rows = await this.database.withTransaction(context, async (client) =>
        (await client.query<ListRow>('select * from identity.list_outreach_invitations()')).rows, { readOnly: true });
    } catch (error) {
      throw outreachInvitationProblem(error);
    }
    return { invitations: rows.map((row) => ({ invitationId: row.invitation_id, name: row.invitee_name,
      email: row.invitee_email, status: row.status, expiresAt: iso(row.expires_at), createdAt: iso(row.created_at),
      acceptedAt: iso(row.accepted_at) })) };
  }

  /**
   * A helper without an account accepts and sets a password (the controller
   * then signs them in). The network's 20 an hour are charged first, in their
   * own committed transaction. The command answers a `result` so its failure
   * counters commit.
   */
  async acceptWithPassword(input: AcceptOutreachInvitationDto, remoteIp: string | undefined, correlationId: string) {
    assertPasswordLength(input.password);
    const key = this.requireKey();
    const network = quotaNetwork(remoteIp);
    if (!network) throw unavailable();
    let limited: boolean;
    try {
      limited = await this.database.withSystemTransaction(correlationId, (client) =>
        consumeRateLimit(client, 'ip', domainHmac(key, HMAC_DOMAIN, 'network', network),
          OUTREACH_INVITATION_ACCEPT_WINDOW));
    } catch {
      throw unavailable();
    }
    if (limited) {
      throw new DomainProblem(429, 'OUTREACH_INVITATION_RATE_LIMITED',
        'Too many invitations were opened from this network. Please try again in an hour.');
    }
    const linkMode = typeof input.invitationId === 'string';
    const email = linkMode ? null : (input.email ?? '').trim().toLowerCase();
    const passwordHash = await hashAccountPassword(input.password);
    let row: AcceptRow | undefined;
    try {
      row = await this.database.withSystemTransaction(correlationId, async (client) => (await client.query<AcceptRow>(
        'select * from identity.accept_outreach_invitation_with_password($1,$2,$3,$4,$5)',
        [linkMode ? input.invitationId : null,
          linkMode ? domainHmac(key, HMAC_DOMAIN, 'link', input.invitationId as string, input.token as string) : null,
          email, email === null ? null : domainHmac(key, HMAC_DOMAIN, 'email-code', email, input.code as string),
          passwordHash])).rows[0]);
    } catch (error) {
      throw outreachInvitationProblem(error);
    }
    if (!row || row.result !== 'ready' || !row.email) throw invitationResultProblem(row?.result);
    return { email: row.email, facilityId: row.facility_id, facilityName: row.facility_name,
      roleCode: row.role_code ?? OUTREACH_VOLUNTEER_ROLE };
  }

  /** A signed-in account accepts (owner decision 5: it may also hold hospital roles elsewhere). */
  async acceptForAccount(context: DataAccessContext, input: SignedInOutreachInvitationDto) {
    const key = this.requireKey();
    const args = typeof input.invitationId === 'string' && typeof input.token === 'string'
      ? [input.invitationId, domainHmac(key, HMAC_DOMAIN, 'link', input.invitationId, input.token), null]
      : [null, null, domainHmac(key, HMAC_DOMAIN, 'email-code', (context.actor.email ?? '').trim().toLowerCase(),
        input.code ?? '')];
    let row: AcceptRow | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) => (await client.query<AcceptRow>(
        'select * from identity.accept_outreach_invitation_for_account($1,$2,$3)', args)).rows[0]);
    } catch (error) {
      throw outreachInvitationProblem(error);
    }
    if (!row || row.result !== 'ready') throw invitationResultProblem(row?.result);
    return { accepted: true as const, facilityId: row.facility_id, membershipId: row.membership_id,
      facilityName: row.facility_name, roleCode: row.role_code ?? OUTREACH_VOLUNTEER_ROLE };
  }

  private requireKey(): Buffer {
    const key = outreachKey();
    if (!key) throw unavailable();
    return key;
  }

  /** Sends the email after commit and records its outcome; a failure to record leaves it "not confirmed". */
  private async send(context: DataAccessContext, row: CreateRow, token: string, code: string): Promise<OtpDeliveryOutcome> {
    const facilityName = emailFacilityName(row.facility_name);
    const delivered = await this.notification.deliverStaffInvitation({
      sendId: row.send_id, invitationId: row.invitation_id, recipient: row.invitee_email,
      ...(facilityName ? { facilityName } : {}), roleCode: OUTREACH_VOLUNTEER_ROLE, token, code,
      expiresAt: new Date(iso(row.expires_at) as string), correlationId: context.correlationId,
    }).catch(() => ({ outcome: 'unknown' as const }));
    try {
      await this.database.withTransaction(context, (client) =>
        client.query('select identity.record_outreach_invitation_delivery($1,$2)', [row.send_id, delivered.outcome]));
    } catch {
      this.logger.warn('Outreach invitation delivery outcome could not be recorded (event=outreach_invitation_delivery_record_failed)');
    }
    return delivered.outcome;
  }
}
