import { Injectable, Logger, type NestMiddleware, NotFoundException, type OnModuleInit } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { getEnvironment } from '../config/environment';
import { DomainProblem } from '../common/problem';
import { DatabaseService } from '../database/database.service';
import { databaseMessage, isDatabaseError } from '../patient-safety/database-error';

/**
 * SX-6 (0205): change your own password while signed in (POST
 * /identity/me/password) and edit your own name (POST
 * /identity/me/staff-profile). Each is behind its own setting, off by
 * default; while off, its route answers 404 and SX-5 says it cannot be
 * changed.
 */

/** The audit actions of SX-6, success (written by 0205's functions) or refusal (written here). */
export const OWN_PASSWORD_AUDIT_ACTION = 'auth.password.change';
export const OWN_NAME_AUDIT_ACTION = 'auth.staff-profile.update';

/**
 * Whether the password change is on: STAFF_PASSWORD_CHANGE_ENABLED, and
 * Identity's own sessions (AUTH_MODE=local). With AUTH_MODE=oidc there is no
 * Identity session to renew, so the route does not exist (404). Read each
 * time, so tests can change it.
 */
export function ownPasswordChangeEnabled(): boolean {
  const environment = getEnvironment();
  return environment.STAFF_PASSWORD_CHANGE_ENABLED && environment.AUTH_MODE === 'local';
}

/**
 * Whether the name edit is on: STAFF_NAME_CHANGE_ENABLED, and Identity's own
 * sessions (AUTH_MODE=local), as the password change. With AUTH_MODE=oidc a
 * session carries no Identity session id, so 0205 could never find the
 * presented session and every edit would answer 401: the route does not
 * exist (404), and SX-5 sends no profileVersion and canChange.name false.
 * Read each time, so tests can change it.
 */
export function ownNameChangeEnabled(): boolean {
  const environment = getEnvironment();
  return environment.STAFF_NAME_CHANGE_ENABLED && environment.AUTH_MODE === 'local';
}

/** 0205's functions, as to_regprocedure names them. */
export const CHANGE_OWN_PASSWORD_FUNCTION =
  'auth.change_own_password(uuid,uuid,text,text,text,uuid,uuid,text,timestamp with time zone,inet,text)';
export const CHANGE_OWN_DISPLAY_NAME_FUNCTION = 'auth.change_own_display_name(text,bigint,text,uuid,inet,text)';
export const OWN_PROFILE_VERSION_FUNCTION = 'auth.own_profile_version()';

/**
 * The password change (0205 B4), in the request's transaction with the
 * account-only context: $1 the presented session, $2 its access token id, $3
 * the stored hash Node verified (compare-and-swap), $4 the new argon2id hash,
 * $5 the Idempotency-Key, $6-$9 the renewed session (id, access token id,
 * refresh token SHA-256, idle end asked for), $10 the source IP, $11 the user
 * agent.
 */
export const CHANGE_OWN_PASSWORD_SQL = `select result.change_id::text, result.token_version::text,
       result.password_changed_at, result.other_sign_ins_ended, result.session_id::text,
       result.session_expires_at, result.replayed
  from auth.change_own_password($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7::uuid, $8, $9::timestamptz,
                                $10::inet, $11) result`;

/** The same function's replay read alone (no new hash): the stored answer for the key, or no row. Changes nothing. */
export const OWN_PASSWORD_REPLAY_SQL = `select result.change_id::text, result.token_version::text,
       result.password_changed_at, result.other_sign_ins_ended, result.session_id::text,
       result.session_expires_at, result.replayed
  from auth.change_own_password(null, null, null, null, $1, null, null, null, null, null, null) result`;

/** The name edit (0205 B5): $1 the name, $2 the expected profile version, $3 the key, $4 the session, $5 IP, $6 agent. */
export const CHANGE_OWN_DISPLAY_NAME_SQL = `select result.profile_version::text, result.display_name, result.replayed
  from auth.change_own_display_name($1, $2::bigint, $3, $4::uuid, $5::inet, $6) result`;

/** The session's own profile version (0205 B6), in a transaction with the account-only context. */
export const OWN_PROFILE_VERSION_SQL = 'select auth.own_profile_version()::text as profile_version';

/**
 * What the password change reads before checking the current password: the
 * account by id and subject together, active and not disabled. The hash is
 * read only to verify it in this process and to hand it back to the
 * database as the compare-and-swap value; it is never logged, audited or
 * answered.
 */
export const OWN_PASSWORD_ACCOUNT_SQL = `select account.email, account.display_name, account.password_hash,
       account.password_algorithm
  from auth.accounts account
 where account.id = $1::uuid
   and account.subject = $2
   and account.status = 'active'
   and (account.disabled_until is null or account.disabled_until <= clock_timestamp())`;

/** A successful change clears the sign-in lockout of the account's email, as a successful sign-in does. */
export const CLEAR_LOGIN_ATTEMPTS_SQL = 'delete from auth.login_attempts where principal_hmac = $1 and pepper_version = $2';

/** The answers of SX-6's refusals (docs/INTERFACE_CONTRACT.md, SX-6). */
export const OWN_PROFILE_MESSAGES = {
  cookieRequired: 'Change your password on the Health ID website.',
  reauthenticationFailed: 'That password isn\'t right',
  reauthenticationLocked: 'Too many wrong passwords. Try again in 15 minutes.',
  passwordTooShort: 'Use at least 12 characters.',
  passwordSame: 'Choose a new password that is different from your current one.',
  passwordNotSet: 'This account signs in with Google and has no password. Use "Forgot password" on the sign-in page to '
    + 'set one.',
  passwordChangedMeanwhile: 'Your password was changed meanwhile. Sign in again.',
  notAllowed: 'This shared test login can\'t be changed.',
  nameInvalid: 'Enter your full name: 2 to 6 words of letters (2 to 80 characters in all), joined by single spaces, '
    + 'apostrophes or hyphens, without digits or the words Health ID, HID, support, admin, administrator or ministry.',
  nameUnchanged: 'That\'s already your name.',
  nameLimited: 'You have changed your name 3 times today. Try again tomorrow.',
  versionConflict: 'This changed meanwhile; reload before retrying.',
  keyReused: 'This request was already used for a different change. Please reload and try again.',
  unavailable: 'Something went wrong on our side. Please try again.',
} as const;

/**
 * 0205's refusals (SQLSTATE and message key) as the route answers them.
 * Anything else from the database is 503 DEPENDENCY_UNAVAILABLE, with nothing
 * of the database's message in the answer.
 */
export function ownProfileProblem(error: unknown): DomainProblem {
  if (error instanceof DomainProblem) return error;
  if (!isDatabaseError(error)) {
    return new DomainProblem(503, 'DEPENDENCY_UNAVAILABLE', OWN_PROFILE_MESSAGES.unavailable);
  }
  switch (`${error.code} ${databaseMessage(error)}`) {
    case '42501 OWN_ACCOUNT_NOT_ACTIVE':
    case '42501 OWN_SESSION_NOT_CURRENT':
      return new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required');
    case '42501 STAFF_PROFILE_CHANGE_NOT_ALLOWED':
      return new DomainProblem(403, 'STAFF_PROFILE_CHANGE_NOT_ALLOWED', OWN_PROFILE_MESSAGES.notAllowed);
    case '55000 PASSWORD_NOT_SET':
      return new DomainProblem(409, 'PASSWORD_NOT_SET', OWN_PROFILE_MESSAGES.passwordNotSet);
    case '40001 PASSWORD_CHANGED_MEANWHILE':
      return new DomainProblem(409, 'PASSWORD_CHANGED_MEANWHILE', OWN_PROFILE_MESSAGES.passwordChangedMeanwhile);
    case '22023 IDEMPOTENCY_KEY_REQUIRED':
      return new DomainProblem(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key must contain 16 to 128 URL-safe characters');
    case '22023 STAFF_NAME_INVALID':
      return new DomainProblem(400, 'STAFF_NAME_INVALID', OWN_PROFILE_MESSAGES.nameInvalid);
    case '22023 STAFF_NAME_UNCHANGED':
      return new DomainProblem(400, 'STAFF_NAME_UNCHANGED', OWN_PROFILE_MESSAGES.nameUnchanged);
    case '40001 VERSION_CONFLICT':
      return new DomainProblem(412, 'VERSION_CONFLICT', OWN_PROFILE_MESSAGES.versionConflict);
    case '55000 STAFF_NAME_CHANGE_LIMITED':
      return new DomainProblem(429, 'STAFF_NAME_CHANGE_LIMITED', OWN_PROFILE_MESSAGES.nameLimited);
    case '23505 IDEMPOTENCY_KEY_REUSED':
      return new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED', OWN_PROFILE_MESSAGES.keyReused);
    default:
      return new DomainProblem(503, 'DEPENDENCY_UNAVAILABLE', OWN_PROFILE_MESSAGES.unavailable);
  }
}

/**
 * While the password change is off (or AUTH_MODE is not local), POST
 * /identity/me/password answers a plain 404, as an Identity before SX-6. A
 * middleware, so the 404 comes before the global SecurityGuard, the audit
 * interceptor, the ValidationPipe and the handler (as OpenPatientOffMiddleware).
 */
@Injectable()
export class OwnPasswordChangeOffMiddleware implements NestMiddleware {
  use(_request: Request, _response: Response, next: NextFunction): void {
    if (!ownPasswordChangeEnabled()) throw new NotFoundException();
    next();
  }
}

/**
 * The same for POST /identity/me/staff-profile while the name edit is off (or AUTH_MODE is not local; GET, SX-5,
 * is not affected).
 */
@Injectable()
export class OwnNameChangeOffMiddleware implements NestMiddleware {
  use(_request: Request, _response: Response, next: NextFunction): void {
    if (!ownNameChangeEnabled()) throw new NotFoundException();
    next();
  }
}

/**
 * The start-up check's one read: whether the Identity runtime may execute
 * each of 0205's functions. For a missing function the answer is null, never
 * an error.
 */
export const OWN_PROFILE_STARTUP_SQL = `select
       has_function_privilege(to_regprocedure('${CHANGE_OWN_PASSWORD_FUNCTION}')::oid, 'EXECUTE') as can_change_password,
       has_function_privilege(to_regprocedure('${CHANGE_OWN_DISPLAY_NAME_FUNCTION}')::oid, 'EXECUTE') as can_change_name,
       has_function_privilege(to_regprocedure('${OWN_PROFILE_VERSION_FUNCTION}')::oid, 'EXECUTE') as can_read_version`;

interface StartupRow {
  can_change_password: boolean | null;
  can_change_name: boolean | null;
  can_read_version: boolean | null;
}

/** How many times the start-up read is tried, and the pause between tries. */
export const OWN_PROFILE_STARTUP_ATTEMPTS = 5;
export const OWN_PROFILE_STARTUP_RETRY_MS = 2_000;

/**
 * With STAFF_PASSWORD_CHANGE_ENABLED or STAFF_NAME_CHANGE_ENABLED true,
 * Identity refuses to start unless it has a definite answer that the
 * runtime may execute 0205's functions that setting needs (the password
 * change; the name edit and the profile version): the deploy then fails its
 * health checks and rolls back, and the running tasks keep serving. A failed
 * read is tried again, OWN_PROFILE_STARTUP_ATTEMPTS times in all; a database
 * still unreachable after the last one also refuses. With both settings off
 * it reads nothing (OpenPatientStartupCheck's form).
 */
@Injectable()
export class StaffProfileChangeStartupCheck implements OnModuleInit {
  private readonly logger = new Logger(StaffProfileChangeStartupCheck.name);

  constructor(private readonly database: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    const environment = getEnvironment();
    const password = environment.STAFF_PASSWORD_CHANGE_ENABLED;
    const name = environment.STAFF_NAME_CHANGE_ENABLED;
    if (!password && !name) return;
    let row: StartupRow | undefined;
    for (let attempt = 1; row === undefined; attempt += 1) {
      try {
        row = (await this.database.query<StartupRow>(OWN_PROFILE_STARTUP_SQL)).rows[0];
        if (row === undefined) throw new Error('no answer');
      } catch {
        // No SQL diagnostics or identifiers may enter service logs.
        this.logger.warn({ event: 'auth.own_profile.startup_check_unavailable', attempt });
        if (attempt >= OWN_PROFILE_STARTUP_ATTEMPTS) {
          throw new Error('STAFF_PASSWORD_CHANGE_ENABLED or STAFF_NAME_CHANGE_ENABLED is true, but whether 0205\'s '
            + `functions are there could not be read after ${OWN_PROFILE_STARTUP_ATTEMPTS} attempts: Identity does not `
            + 'start without that answer');
        }
        await this.pause(OWN_PROFILE_STARTUP_RETRY_MS);
      }
    }
    if (password && row.can_change_password !== true) {
      throw new Error(`STAFF_PASSWORD_CHANGE_ENABLED is true, but the Identity runtime cannot execute `
        + `${CHANGE_OWN_PASSWORD_FUNCTION}: apply migration 0205 and its grants, or set STAFF_PASSWORD_CHANGE_ENABLED=false`);
    }
    if (name && (row.can_change_name !== true || row.can_read_version !== true)) {
      throw new Error(`STAFF_NAME_CHANGE_ENABLED is true, but the Identity runtime cannot execute `
        + `${CHANGE_OWN_DISPLAY_NAME_FUNCTION} and ${OWN_PROFILE_VERSION_FUNCTION}: apply migration 0205 and its `
        + 'grants, or set STAFF_NAME_CHANGE_ENABLED=false');
    }
  }

  /** The pause between tries (a method, so a test can make it immediate). */
  protected pause(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
