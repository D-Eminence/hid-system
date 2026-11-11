import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { NotificationOtpClient, type OtpDeliveryOutcome } from '../auth/notification-otp.client';
import { assertPasswordLength, hashAccountPassword } from '../auth/password-hash';
import { consumeRateLimit } from '../auth/rate-limit';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { quotaNetwork } from '../identity/provider-enrollment.service';
import { emailFacilityName, shownInviterName } from '../identity/staff-names';
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

/** identity.create_outreach_invitation (0114). */
interface CreateRow extends QueryResultRow {
  result: string;
  invitation_id: string | null;
  expires_at: Date | string | null;
  /** False when the address already had 3 outreach invitation emails today: the invitation is made, not emailed. */
  dispatch: boolean | null;
}

/** identity.list_outreach_team (0114): the group's members, then its pending invitations. */
interface TeamRow extends QueryResultRow {
  entry_kind: 'member' | 'invitation';
  entry_id: string;
  full_name: string;
  email: string;
  role_code: string | null;
  status: string;
  created_at: Date | string;
  expires_at: Date | string | null;
}

/** identity.preview_outreach_invitation (0114). */
interface PreviewRow extends QueryResultRow {
  result: string;
  group_name: string | null;
  inviter_name: string | null;
  invitee_name: string | null;
  invitee_email: string | null;
  account_case: 'new' | 'existing' | 'patient_login' | null;
  expires_at: Date | string | null;
}

/** identity.accept_outreach_invitation_with_password / _for_account (0114). */
interface AcceptRow extends QueryResultRow {
  result: string;
  account_id?: string | null;
  membership_id: string | null;
  facility_id: string | null;
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

/** The answer for a link `result` other than 'ready', in plain English (0114's answers). */
export function invitationResultProblem(result: string | undefined): DomainProblem {
  switch (result) {
    case 'invalid': return new DomainProblem(400, 'OUTREACH_INVITATION_INVALID',
      'That invitation link is not right. Open it again from the email.');
    case 'expired': return new DomainProblem(410, 'OUTREACH_INVITATION_EXPIRED',
      'This invitation has expired or was cancelled. Ask the organiser to invite you again.');
    case 'used': return new DomainProblem(409, 'OUTREACH_INVITATION_ALREADY_ACCEPTED',
      'This invitation has already been accepted. Sign in to continue.');
    case 'group_unavailable': return new DomainProblem(423, 'OUTREACH_ORGANISER_SUSPENDED',
      'This outreach group has been paused by Health ID, so its invitations cannot be accepted just now.');
    case 'sign_in_required': return new DomainProblem(409, 'OUTREACH_INVITATION_SIGN_IN_REQUIRED',
      'This email already has a Health ID account. Sign in first, then open the invitation again.');
    case 'email_mismatch': return new DomainProblem(403, 'OUTREACH_INVITATION_WRONG_ACCOUNT',
      'This invitation was sent to a different email. Sign in with the email it was sent to.');
    case 'already_member': return new DomainProblem(409, 'OUTREACH_INVITEE_ALREADY_MEMBER',
      'You are already in this outreach group. Choose it in the facility picker.');
    case 'patient_login': return new DomainProblem(409, 'OUTREACH_INVITATION_PATIENT_LOGIN',
      'This email is used for a Health ID patient account, which cannot help an outreach group yet. '
      + 'Ask the organiser to invite a different email.');
    case 'not_eligible': return new DomainProblem(403, 'OUTREACH_INVITATION_NOT_ELIGIBLE',
      'This account cannot join an outreach group. Contact Health ID support.');
    default: return unavailable();
  }
}

/** The refusal codes 0114's invitation commands raise, in plain English. */
export const OUTREACH_INVITATION_REFUSALS: ReadonlyArray<readonly [string, () => DomainProblem]> = [
  ['OUTREACH_ORGANISER_PERMISSION_DENIED', organiserRequired],
  ['OUTREACH_ORGANISER_ACCOUNT_REQUIRED', () => new DomainProblem(401, 'OUTREACH_ORGANISER_ACCOUNT_REQUIRED',
    'Sign in again, then open the invitation.')],
  ['OUTREACH_INVITATION_INVALID', () => new DomainProblem(400, 'OUTREACH_INVITATION_INVALID',
    'Check the helper\'s name and email, then try again.')],
  ['OUTREACH_INVITATION_PASSWORD_INVALID', () => new DomainProblem(400, 'OUTREACH_INVITATION_PASSWORD_INVALID',
    'That password could not be used. Choose another password of at least 12 characters.')],
  ['OUTREACH_ORGANISER_SUSPENDED', () => new DomainProblem(423, 'OUTREACH_ORGANISER_SUSPENDED',
    'This outreach group has been paused by Health ID. Contact Health ID support.')],
  ['OUTREACH_ROLE_ONLY_AT_OUTREACH_GROUP', () => new DomainProblem(409, 'OUTREACH_ROLE_ONLY_AT_OUTREACH_GROUP',
    'Outreach roles can only be given at an outreach group, never at a hospital.')],
  ['OUTREACH_GROUP_ROLE_INVALID', () => new DomainProblem(409, 'OUTREACH_GROUP_ROLE_INVALID',
    'An outreach group can only have organisers and helpers, never clinical roles.')],
  ['OUTREACH_ORGANISER_SIGNUP_DENIED', unavailable],
];

/** The database's command refusals in plain English. */
export function outreachInvitationProblem(error: unknown): DomainProblem {
  if (error instanceof DomainProblem) return error;
  for (const [refusal, problem] of OUTREACH_INVITATION_REFUSALS) {
    if (hasRefusal(error, refusal)) return problem();
  }
  const code = databaseCode(error);
  if (code === '23505') {
    return new DomainProblem(409, 'OUTREACH_INVITATION_ALREADY_SENT', 'This person already has an invitation waiting.');
  }
  if (code === '42501') return organiserRequired();
  return unavailable();
}

function organiserRequired(): DomainProblem {
  return new DomainProblem(403, 'OUTREACH_ORGANISER_REQUIRED', 'Only the organiser of this outreach group can invite helpers.');
}

/**
 * Outreach invitations (plan PR-1/PR-3, migration 0114): an organiser invites
 * a helper by email as outreach_volunteer. They are separate commands from facility
 * staff invitations, which are unchanged. The helper opens the emailed link:
 * a new person sets a password and is signed in; someone with a Health ID
 * account accepts while signed in. Abuse guards, not business limits (the
 * email names the group, which the organiser chooses): at most 50
 * invitations wait at once and 30 are made a day, cancelled ones included;
 * sending pauses for the day after 10 undeliverable emails; and one address
 * gets at most 3 outreach invitation emails a day from all groups (past that
 * the invitation is made but not emailed).
 */
@Injectable()
export class OutreachInvitationsService {
  private readonly logger = new Logger(OutreachInvitationsService.name);

  constructor(private readonly database: DatabaseService, private readonly notification: NotificationOtpClient) {}

  /** 201 { invitationId, expiresAt, deliveryOutcome }. */
  async create(context: DataAccessContext, input: CreateOutreachInvitationDto) {
    if (!isOutreachOrganiserAt(context)) throw organiserRequired();
    const key = this.requireKey();
    const invitationId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const email = input.email.trim().toLowerCase();
    let row: CreateRow | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) => (await client.query<CreateRow>(
        'select * from identity.create_outreach_invitation($1,$2,$3,$4)',
        [invitationId, input.name, email, linkHmac(key, invitationId, token)])).rows[0]);
    } catch (error) {
      throw outreachInvitationProblem(error);
    }
    switch (row?.result) {
      case 'created': break;
      case 'already_member': throw new DomainProblem(409, 'OUTREACH_INVITEE_ALREADY_MEMBER', 'This person is already in your team.');
      case 'already_invited': throw new DomainProblem(409, 'OUTREACH_INVITATION_ALREADY_SENT',
        'This person already has an invitation waiting. Cancel it first if you want to send a new one.');
      case 'too_many_pending': throw new DomainProblem(429, 'OUTREACH_INVITATION_PENDING_LIMIT',
        'You have 50 invitations still waiting. Wait for some to be accepted, or cancel some, before inviting more.');
      case 'too_many_today': throw new DomainProblem(429, 'OUTREACH_INVITATION_DAILY_LIMIT',
        'Your group has sent 30 invitations today, counting any you cancelled. You can invite more tomorrow.');
      case 'sending_paused': throw new DomainProblem(429, 'OUTREACH_INVITATION_DELIVERY_PAUSED',
        'Invitations are paused for today because 10 of your group\'s invitation emails could not be delivered. '
        + 'Check the email addresses and try again tomorrow.');
      default: throw unavailable();
    }
    if (!row.invitation_id || !row.expires_at) throw unavailable();
    const expiresAt = new Date(iso(row.expires_at) as string);
    // Not emailed when the address already had 3 outreach invitation emails today (0114 answers dispatch false).
    const deliveryOutcome = row.dispatch === true
      ? await this.send(context, row.invitation_id, email, token, expiresAt)
      : 'unknown' as const;
    return { invitationId: row.invitation_id, expiresAt: expiresAt.toISOString(), deliveryOutcome, replayed: false };
  }

  /** The organiser's team: { members, invitations } (pending invitations only). */
  async list(context: DataAccessContext) {
    if (!isOutreachOrganiserAt(context)) throw organiserRequired();
    let rows: TeamRow[];
    try {
      rows = await this.database.withTransaction(context, async (client) =>
        (await client.query<TeamRow>('select * from identity.list_outreach_team()')).rows, { readOnly: true });
    } catch (error) {
      throw outreachInvitationProblem(error);
    }
    return {
      members: rows.filter((row) => row.entry_kind === 'member').map((row) => ({ membershipId: row.entry_id,
        name: row.full_name, email: row.email, roleCode: row.role_code, status: row.status, joinedAt: iso(row.created_at) })),
      invitations: rows.filter((row) => row.entry_kind === 'invitation').map((row) => ({ invitationId: row.entry_id,
        name: row.full_name, email: row.email, status: row.status, expiresAt: iso(row.expires_at),
        createdAt: iso(row.created_at), acceptedAt: null })),
    };
  }

  /** Cancels a pending invitation of the organiser's group. */
  async revoke(context: DataAccessContext, invitationId: string) {
    if (!isOutreachOrganiserAt(context)) throw organiserRequired();
    let result: string | undefined;
    try {
      result = await this.database.withTransaction(context, async (client) => (await client.query<{ result: string }>(
        'select identity.revoke_outreach_invitation($1) as result', [invitationId])).rows[0]?.result);
    } catch (error) {
      throw outreachInvitationProblem(error);
    }
    if (result === 'not_found') {
      throw new DomainProblem(404, 'OUTREACH_INVITATION_NOT_FOUND', 'That invitation is not waiting any more. Reload the list.');
    }
    if (result !== 'revoked') throw unavailable();
    return { revoked: true as const, invitationId };
  }

  /**
   * What the link shows before accepting: the group, who invited, the invitee,
   * and whether to set a password ('new') or sign in first ('existing'). A
   * wrong token counts against the invitation (10 wrong: it expires).
   */
  async preview(input: { invitationId: string; token: string }, remoteIp: string | undefined, correlationId: string) {
    const key = this.requireKey();
    await this.chargeNetwork(key, remoteIp, correlationId);
    let row: PreviewRow | undefined;
    try {
      row = await this.database.withSystemTransaction(correlationId, async (client) => (await client.query<PreviewRow>(
        'select * from identity.preview_outreach_invitation($1,$2)',
        [input.invitationId, linkHmac(key, input.invitationId, input.token)])).rows[0]);
    } catch (error) {
      throw outreachInvitationProblem(error);
    }
    if (!row || row.result !== 'ready') throw invitationResultProblem(row?.result);
    return { groupName: row.group_name, inviterName: shownInviterName(row.inviter_name), inviteeName: row.invitee_name,
      inviteeEmail: row.invitee_email, accountCase: row.account_case, expiresAt: iso(row.expires_at) };
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
    await this.chargeNetwork(key, remoteIp, correlationId);
    const passwordHash = await hashAccountPassword(input.password);
    let answer: { row?: AcceptRow; email?: string } = {};
    try {
      answer = await this.database.withSystemTransaction(correlationId, async (client) => {
        const row = (await client.query<AcceptRow>(
          'select * from identity.accept_outreach_invitation_with_password($1,$2,$3)',
          [input.invitationId, linkHmac(key, input.invitationId, input.token), passwordHash])).rows[0];
        if (row?.result !== 'ready' || !row.account_id) return { row };
        // The sign-in that follows needs the new login's email; the command does not answer it.
        const email = (await client.query<{ email: string }>(
          'select lower(account.email) as email from auth.accounts account where account.id = $1', [row.account_id]))
          .rows[0]?.email;
        return { row, email };
      });
    } catch (error) {
      throw outreachInvitationProblem(error);
    }
    const { row, email } = answer;
    if (!row || row.result !== 'ready') throw invitationResultProblem(row?.result);
    if (!email) throw unavailable();
    return { email, facilityId: row.facility_id, membershipId: row.membership_id, roleCode: OUTREACH_VOLUNTEER_ROLE };
  }

  /** A signed-in account accepts (owner decision 5: it may also hold hospital roles elsewhere). */
  async acceptForAccount(context: DataAccessContext, input: SignedInOutreachInvitationDto) {
    const key = this.requireKey();
    let row: AcceptRow | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) => (await client.query<AcceptRow>(
        'select * from identity.accept_outreach_invitation_for_account($1,$2)',
        [input.invitationId, linkHmac(key, input.invitationId, input.token)])).rows[0]);
    } catch (error) {
      throw outreachInvitationProblem(error);
    }
    if (!row || row.result !== 'ready') throw invitationResultProblem(row?.result);
    return { accepted: true as const, facilityId: row.facility_id, membershipId: row.membership_id,
      roleCode: OUTREACH_VOLUNTEER_ROLE };
  }

  private async chargeNetwork(key: Buffer, remoteIp: string | undefined, correlationId: string): Promise<void> {
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
  }

  private requireKey(): Buffer {
    const key = outreachKey();
    if (!key) throw unavailable();
    return key;
  }

  /**
   * Sends the email after commit and records the outcome with
   * identity.record_outreach_invitation_delivery (10 undeliverable emails in
   * a day pause the group's invitations); a failure to record is only
   * logged. The outreach email offers the
   * link only; the code field the shared staff-invitation route requires is
   * filled with an unused random value that the outreach email never shows.
   */
  private async send(context: DataAccessContext, invitationId: string, email: string, token: string,
    expiresAt: Date): Promise<OtpDeliveryOutcome> {
    const facilityName = emailFacilityName(context.actor.facility?.name);
    const delivered = await this.notification.deliverStaffInvitation({
      sendId: invitationId, invitationId, recipient: email,
      ...(facilityName ? { facilityName } : {}), roleCode: OUTREACH_VOLUNTEER_ROLE, token,
      code: randomInt(0, 1_000_000).toString().padStart(6, '0'), expiresAt, correlationId: context.correlationId,
    }).catch(() => ({ outcome: 'unknown' as const }));
    if (delivered.outcome !== 'accepted') {
      this.logger.warn(`Outreach invitation email not confirmed (event=outreach_invitation_delivery outcome=${delivered.outcome})`);
    }
    try {
      await this.database.withTransaction(context, (client) =>
        client.query('select identity.record_outreach_invitation_delivery($1,$2)', [invitationId, delivered.outcome]));
    } catch {
      this.logger.warn('Outreach invitation delivery could not be recorded (event=outreach_invitation_delivery_record_failed)');
    }
    return delivered.outcome;
  }
}

function linkHmac(key: Buffer, invitationId: string, token: string): string {
  return domainHmac(key, HMAC_DOMAIN, 'link', invitationId, token);
}
