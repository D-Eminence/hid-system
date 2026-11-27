import { BeforeApplicationShutdown, HttpException, Injectable, Logger } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { AuthSessionAuditService } from '../auth/auth-session-audit.service';
import type { LoginResult } from '../auth/auth.types';
import { staffEmailFirstName } from '../auth/email-first-name';
import { LocalAuthProvider } from '../auth/local-auth.provider';
import { NotificationOtpClient } from '../auth/notification-otp.client';
import { hashAccountPassword } from '../auth/password-hash';
import { TokenService } from '../auth/token.service';
import { AFTER_RESPONSE_SHUTDOWN_GRACE_MS, AfterResponseTasks } from '../common/after-response-tasks';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext, HidRequest } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { acceptableStaffPersonName } from '../identity/staff-names';
import type { ChangeOwnNameDto, ChangeOwnPasswordDto } from './staff-profile-changes.dto';
import {
  CHANGE_OWN_DISPLAY_NAME_SQL, CHANGE_OWN_PASSWORD_SQL, CLEAR_LOGIN_ATTEMPTS_SQL, OWN_PASSWORD_ACCOUNT_SQL,
  OWN_PASSWORD_REPLAY_SQL, OWN_PROFILE_MESSAGES, ownProfileProblem,
} from './staff-profile-changes';

interface PasswordChangeRow extends QueryResultRow {
  change_id: string;
  token_version: string | null;
  password_changed_at: Date | string;
  other_sign_ins_ended: number;
  session_id: string;
  session_expires_at: Date | string | null;
  replayed: boolean;
}

interface OwnAccountRow extends QueryResultRow {
  email: string | null;
  display_name: string | null;
  password_hash: string | null;
  password_algorithm: string | null;
}

interface NameChangeRow extends QueryResultRow {
  profile_version: string;
  display_name: string;
  replayed: boolean;
}

/** What POST /identity/me/password answers (and the renewed sign-in, for the cookies, when not a replay). */
export interface OwnPasswordChange {
  answer: { changed: true; otherSignInsEnded: number; passwordChangedAt: string; replayed: boolean };
  changeId: string;
  session?: LoginResult;
}

/**
 * The account-only context of SX-6's database calls, as the signed-in
 * invitation routes use it (accountOnlyContext): no facility and no
 * membership, purpose healthcare-operations; 0205's functions take the account
 * from the session's subject.
 */
export function ownAccountContext(request: HidRequest): DataAccessContext {
  if (!request.actor || !request.correlationId) {
    throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required');
  }
  request.purposeOfUse = 'healthcare-operations';
  return { actor: request.actor, facilityId: '', membershipId: '', correlationId: request.correlationId,
    purposeOfUse: 'healthcare-operations', authorization: request.header('authorization') };
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/**
 * SX-6 (0205): the signed-in staff member changes their own password, or
 * their own name. The database decides and writes each success and its audit
 * row (0205's functions); the controller writes the refusals' rows.
 */
@Injectable()
export class StaffProfileChangesService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(StaffProfileChangesService.name);
  /** "Your Health ID password was updated": sent after the change answers, never waited for. */
  private readonly confirmations = new AfterResponseTasks(this.logger, 'Password-updated email could not be sent');

  constructor(
    private readonly database: DatabaseService,
    private readonly tokens: TokenService,
    private readonly local: LocalAuthProvider,
    private readonly sessionAudit: AuthSessionAuditService,
    private readonly notification: NotificationOtpClient,
  ) {}

  /** Waits for the emails started so far (tests). */
  async settleConfirmations(): Promise<void> {
    await this.confirmations.settle();
  }

  /** Runs before DatabaseService ends the pool. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.confirmations.settle(AFTER_RESPONSE_SHUTDOWN_GRACE_MS);
  }

  /**
   * POST /identity/me/password, in the design note's order:
   *  1. a replay of the Idempotency-Key answers the stored change (no new
   *     cookies: the renewed ones went with the first answer), before any
   *     password is checked, so a retry never counts towards the lockout;
   *  2. an account with no password: 409 PASSWORD_NOT_SET, before any check;
   *  3. a locked sign-in: 429 STAFF_REAUTHENTICATION_LOCKED, counting nothing;
   *  4. the current password, checked against the stored hash as a sign-in
   *     checks it (LocalAuthProvider); a wrong one counts towards the lockout
   *     (AuthSessionAuditService.recordLoginFailure) and answers 403
   *     STAFF_REAUTHENTICATION_FAILED. An account with no email has no
   *     lockout key and cannot be checked: the same 403;
   *  5. a new password under 12 characters: 400 PASSWORD_TOO_SHORT; the same
   *     as the current one: 400 PASSWORD_SAME_AS_CURRENT;
   *  6. the new argon2id hash, outside any transaction;
   *  7. one transaction: 0205's auth.change_own_password (with the verified
   *     hash as its compare-and-swap value and the renewed session's digest)
   *     and the lockout cleared; the access token of the renewed session is
   *     signed after it commits (TokenService.renewSignIn);
   *  8. after the answer, the password-updated email, keyed by the change.
   * A database or other failure in any step answers 503
   * DEPENDENCY_UNAVAILABLE (ownProfileProblem), never a 500.
   */
  async changePassword(request: HidRequest, input: ChangeOwnPasswordDto, idempotencyKey: string):
    Promise<OwnPasswordChange> {
    const actor = request.actor;
    const context = ownAccountContext(request);
    if (!actor?.sessionId || !request.accessTokenId) {
      throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required');
    }
    const sessionId = actor.sessionId;
    const accessTokenId = request.accessTokenId;
    try {
      const replay = await this.database.withTransaction(context, async (client) =>
        (await client.query<PasswordChangeRow>(OWN_PASSWORD_REPLAY_SQL, [idempotencyKey])).rows[0]);
      if (replay) return { answer: this.answer(replay, true), changeId: replay.change_id };
    } catch (error) {
      throw ownProfileProblem(error);
    }

    let account: OwnAccountRow;
    let email: string;
    let newHash: string;
    let lockout: { principalHmac: string; pepperVersion: number };
    try {
      ({ account, email, newHash, lockout } = await this.checkCurrentPassword(request, actor, input));
    } catch (error) {
      // Each refusal is a DomainProblem; a failed read, lockout write or hash is 503 DEPENDENCY_UNAVAILABLE.
      throw ownProfileProblem(error);
    }

    let changed: PasswordChangeRow | undefined;
    let session: LoginResult;
    try {
      session = await this.tokens.renewSignIn({
        subject: actor.subject, authenticationMethod: actor.authenticationMethod, product: request.sessionProduct,
        origin: request.header('origin'),
      }, async (renewal) => {
        changed = await this.database.withTransaction(context, async (client) => {
          const row = (await client.query<PasswordChangeRow>(CHANGE_OWN_PASSWORD_SQL, [
            sessionId, accessTokenId, account.password_hash, newHash, idempotencyKey, renewal.sessionId,
            renewal.accessJti, renewal.refreshTokenSha256, renewal.refreshExpiresAt, request.ip ?? null,
            request.header('user-agent') ?? null,
          ])).rows[0];
          if (!row) throw new Error('The password change answered no row');
          if (row.replayed !== true) {
            await client.query(CLEAR_LOGIN_ATTEMPTS_SQL, [lockout.principalHmac, lockout.pepperVersion]);
          }
          return row;
        });
        // A concurrent request with the same key committed first: its row is answered (no renewal here).
        if (changed.replayed === true) throw new ReplayedMeanwhile();
        return { tokenVersion: Number(changed.token_version),
          refreshExpiresAt: new Date(changed.session_expires_at ?? renewal.refreshExpiresAt) };
      });
    } catch (error) {
      if (error instanceof ReplayedMeanwhile && changed) {
        return { answer: this.answer(changed, true), changeId: changed.change_id };
      }
      if (error instanceof DomainProblem) throw error;
      // The session no longer fits its site, or its account changed (TokenService): a sign-in that has ended.
      if (error instanceof HttpException && error.getStatus() === 401) {
        throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required');
      }
      throw ownProfileProblem(error);
    }
    const row = changed!;
    this.confirmPasswordUpdated(row.change_id, email, account.display_name, request.correlationId);
    return { answer: this.answer(row, false), changeId: row.change_id, session };
  }

  /**
   * Steps 2-6 of changePassword: the account read, PASSWORD_NOT_SET, the
   * lockout, the current password (a wrong one counted), the new password's
   * own checks and its hash. Throws a DomainProblem for each refusal; any
   * other error is the caller's to map.
   */
  private async checkCurrentPassword(request: HidRequest, actor: NonNullable<HidRequest['actor']>,
    input: ChangeOwnPasswordDto): Promise<{ account: OwnAccountRow; email: string; newHash: string;
      lockout: { principalHmac: string; pepperVersion: number } }> {
    const account = (await this.database.query<OwnAccountRow>(OWN_PASSWORD_ACCOUNT_SQL,
      [actor.accountId, actor.subject])).rows[0];
    if (!account) throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required');
    if (!account.password_hash) {
      throw new DomainProblem(409, 'PASSWORD_NOT_SET', OWN_PROFILE_MESSAGES.passwordNotSet);
    }
    const email = account.email?.trim();
    if (!email) {
      throw new DomainProblem(403, 'STAFF_REAUTHENTICATION_FAILED', OWN_PROFILE_MESSAGES.reauthenticationFailed);
    }
    if (await this.local.isLockedOut(email, 'staff')) {
      throw new DomainProblem(429, 'STAFF_REAUTHENTICATION_LOCKED', OWN_PROFILE_MESSAGES.reauthenticationLocked);
    }
    if (!(await this.local.verifyStoredPassword(input.currentPassword, account.password_hash,
      account.password_algorithm))) {
      await this.sessionAudit.recordLoginFailure(email, {
        correlationId: request.correlationId, actorSubject: actor.subject, sourceIp: request.ip,
        userAgent: request.header('user-agent'),
      });
      throw new DomainProblem(403, 'STAFF_REAUTHENTICATION_FAILED', OWN_PROFILE_MESSAGES.reauthenticationFailed);
    }
    if (input.newPassword.length < 12) {
      throw new DomainProblem(400, 'PASSWORD_TOO_SHORT', OWN_PROFILE_MESSAGES.passwordTooShort);
    }
    if (input.newPassword === input.currentPassword) {
      throw new DomainProblem(400, 'PASSWORD_SAME_AS_CURRENT', OWN_PROFILE_MESSAGES.passwordSame);
    }
    const newHash = await hashAccountPassword(input.newPassword);
    return { account, email, newHash, lockout: this.local.lockoutKey(email, 'staff') };
  }

  /**
   * POST /identity/me/staff-profile: the name, trimmed, must be a person's
   * name by the invitee rule (400 STAFF_NAME_INVALID, before the database,
   * which checks it again); then 0205's auth.change_own_display_name in one
   * transaction. Answers whether it was a replay; the controller answers the
   * SX-5 profile read after it.
   */
  async changeName(request: HidRequest, input: ChangeOwnNameDto, idempotencyKey: string): Promise<{ replayed: boolean;
    profileVersion: number }> {
    const actor = request.actor;
    const context = ownAccountContext(request);
    if (!actor?.sessionId) throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required');
    const sessionId = actor.sessionId;
    const name = input.name.trim();
    if (!acceptableStaffPersonName(name)) {
      throw new DomainProblem(400, 'STAFF_NAME_INVALID', OWN_PROFILE_MESSAGES.nameInvalid);
    }
    try {
      const row = await this.database.withTransaction(context, async (client) =>
        (await client.query<NameChangeRow>(CHANGE_OWN_DISPLAY_NAME_SQL, [name, input.expectedVersion, idempotencyKey,
          sessionId, request.ip ?? null, request.header('user-agent') ?? null])).rows[0]);
      if (!row) throw new Error('The name change answered no row');
      return { replayed: row.replayed === true, profileVersion: Number(row.profile_version) };
    } catch (error) {
      throw ownProfileProblem(error);
    }
  }

  private answer(row: PasswordChangeRow, replayed: boolean): OwnPasswordChange['answer'] {
    return { changed: true, otherSignInsEnded: Number(row.other_sign_ins_ended),
      passwordChangedAt: iso(row.password_changed_at), replayed };
  }

  /**
   * "Your Health ID password was updated", to the account's email, keyed
   * password-updated:<change id> (notification-api's existing route), greeting
   * the staff member by the first name of their display name. Best-effort:
   * the change has answered and never fails because of it; a failure is
   * logged with the correlation id and the outcome only.
   */
  private confirmPasswordUpdated(changeId: string, recipient: string, displayName: string | null,
    correlationId: string): void {
    const firstName = staffEmailFirstName(displayName);
    this.confirmations.run(correlationId, async () => {
      const delivery = await this.notification.deliverPasswordUpdated({
        challengeId: changeId, recipient, ...(firstName ? { firstName } : {}), correlationId,
      });
      if (delivery.outcome !== 'accepted') {
        this.logger.warn(`Password-updated email was not accepted (correlation ${correlationId}, `
          + `outcome ${delivery.outcome}${delivery.safeCode ? `, code ${delivery.safeCode}` : ''})`);
      }
    });
  }
}

/** The change's transaction found the key already used by a request that committed first. */
class ReplayedMeanwhile extends Error {}
