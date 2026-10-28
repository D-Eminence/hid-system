import { createHmac, randomBytes } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import bcrypt from 'bcryptjs';
import { DatabaseService } from '../database/database.service';
import { getEnvironment } from '../config/environment';
import type { CredentialIdentity } from './auth.types';
import { AccountSuspendedProblem } from './account-suspended';
import { patientPhoneLookupValue } from '../identity/contact-lookup';
import { loginPrincipalKey, patientPrincipal } from './patient-principal';

interface AccountRow {
  id: string;
  subject: string;
  email: string | null;
  display_name: string;
  password_hash: string | null;
  password_algorithm: string | null;
  row_version: string;
  status: string;
  /** disabled_until is in the future: how hid-1.0 bans were migrated. */
  disabled_now: boolean;
  /**
   * The account has (or had) a role, a staff record or a facility membership:
   * a clinician or platform administrator. Selected for patient sign-in only.
   */
  workforce?: boolean;
}

/** The account states a patient is told about once the password is right. */
const SUSPENDED_STATUSES = new Set(['disabled', 'locked']);

@Injectable()
export class LocalAuthProvider {
  private readonly environment = getEnvironment();
  private readonly dummyHash = argon2.hash(randomBytes(32), {
    type: argon2.argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
  });
  /**
   * A bcrypt hash at cost 10, hid-1.0's (Supabase's) cost, verified on every
   * attempt whose account holds no bcrypt hash (see authenticate).
   */
  private readonly dummyBcryptHash = bcrypt.hash(randomBytes(32).toString('base64'), 10);

  constructor(private readonly database: DatabaseService) {}

  async authenticate(principal: string, password: string,
    actorKind: 'staff' | 'patient' = 'staff', correlationId?: string): Promise<CredentialIdentity> {
    // A patient signs in with an email, a Health ID or a phone number (owner
    // decision of 2026-10-28); staff with an email only.
    const patient = actorKind === 'patient' ? patientPrincipal(principal) : undefined;
    const principalHash = this.principalHash(loginPrincipalKey(principal, actorKind));
    const attempt = await this.database.query<{ locked: boolean }>(
      `select locked_until is not null and locked_until > clock_timestamp() as locked
         from auth.login_attempts
        where principal_hmac = $1 and pepper_version = $2`,
      [principalHash, this.environment.AUTH_LOGIN_PEPPER_VERSION],
    );
    if (attempt.rows[0]?.locked) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // A patient sign-in also finds a suspended account (any status but
    // 'deleted'; accounts_email_ci_uq allows one per email), so that, once the
    // password is proved right, it can say the account is suspended (owner
    // decision of 2026-10-28). A wrong password, an unknown principal and
    // every other state still get the one 'Invalid credentials'. Staff
    // sign-in finds active accounts only, as before.
    // The patient lookup also says whether the account is a workforce account:
    // any platform or facility role (revoked ones too), staff record or
    // facility membership, active or not. Email lookup is not limited to
    // patient accounts, and a departed clinician or administrator is disabled
    // with roles revoked and memberships ended, so all of them count. A
    // workforce account is never told it is suspended on this route, so the
    // patient route is no password oracle for staff or admin credentials.
    const workforceSql = actorKind === 'patient'
      ? `,
            (exists (select 1 from auth.account_roles role_assignment where role_assignment.account_id = account.id)
              or exists (select 1 from identity.staff staff_record where staff_record.account_id = account.id)
              or exists (select 1 from identity.staff_facility_memberships staff_membership where staff_membership.account_id = account.id)
            ) as workforce`
      : '';
    let account: AccountRow | undefined;
    if (patient?.kind === 'hid' || patient?.kind === 'phone') {
      // By Health ID or phone (its contact lookup HMAC) through 0093's
      // auth.find_patient_account: identity.patients' RLS lets this service
      // read public-enrollment patients only, so a direct query never found a
      // patient migrated from hid-1.0. It answers the one active patient's
      // account (any status but deleted, as the email lookup below) or
      // nothing, also when a phone matches more than one account. A Nigerian
      // number is looked up in both its stored forms (+234... and +2340...,
      // as hid-1.0 kept a trunk 0), still under the one lockout above.
      const lookup = patient.kind === 'phone' ? patientPhoneLookupValue(patient.value) : patient.value;
      account = (await this.database.withSystemTransaction(correlationId ?? 'auth-patient-login-lookup',
        (client) => client.query<AccountRow>(
          `select found.account_id::text as id, found.account_subject as subject, found.email,
                  found.display_name, found.password_hash, found.password_algorithm,
                  found.row_version::text, found.account_status as status, found.disabled_now, found.workforce
             from auth.find_patient_account($1, $2) found`,
          [patient.kind, lookup]))).rows[0];
    } else if (patient?.kind !== 'invalid') {
      const accountSql = `select account.id::text, account.subject, account.email,
            account.display_name, account.password_hash, account.password_algorithm,
            account.row_version::text, account.status,
            coalesce(account.disabled_until > clock_timestamp(), false) as disabled_now${workforceSql}
       from auth.accounts account
      where lower(account.email) = lower($1)
        and ${actorKind === 'patient'
          ? "account.status <> 'deleted'"
          : `account.status = 'active'
        and (account.disabled_until is null or account.disabled_until <= clock_timestamp())`}
      limit 1`;
      account = (await this.database.query<AccountRow>(accountSql, [principal.trim()])).rows[0];
    }
    // Every attempt runs one bcrypt and one argon2 verification, in that
    // order, the account's hash in its own algorithm and a dummy hash in the
    // other (both dummies without an account), so that timing tells neither
    // which accounts still hold a hid-1.0 bcrypt hash (by email, Health ID or
    // phone) nor whether a refused password was right.
    const legacy = account?.password_algorithm === 'bcrypt_legacy';
    const bcryptValid = await bcrypt.compare(password,
      legacy && account?.password_hash ? account.password_hash : await this.dummyBcryptHash).catch(() => false);
    const argonValid = await argon2.verify(
      !legacy && account?.password_hash ? account.password_hash : await this.dummyHash, password).catch(() => false);
    const passwordValid = legacy ? bcryptValid : argonValid;
    if (!account || !passwordValid || !['argon2id', 'bcrypt_legacy'].includes(account.password_algorithm ?? '')) {
      throw new UnauthorizedException('Invalid credentials');
    }
    // Only now, with the password proved right: a suspended, blocked or
    // disabled patient account is told so (403 ACCOUNT_SUSPENDED). Its hash
    // is never upgraded and no session is issued. A workforce account (or a
    // row without the flag) falls through to the uniform 401 below.
    if (actorKind === 'patient' && account.workforce === false
      && (SUSPENDED_STATUSES.has(account.status) || account.disabled_now === true)) {
      throw new AccountSuspendedProblem(account.subject);
    }
    if (account.status !== 'active' || account.disabled_now === true) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const expectedRowVersion = Number(account.row_version);
    if (!Number.isSafeInteger(expectedRowVersion) || expectedRowVersion < 1) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const passwordUpgrade = account.password_algorithm === 'bcrypt_legacy'
      ? {
          hash: await argon2.hash(password, {
            type: argon2.argon2id,
            memoryCost: 65_536,
            timeCost: 3,
            parallelism: 1,
          }),
          expectedRowVersion,
        }
      : undefined;

    return {
      subject: account.subject,
      accountId: account.id,
      ...(account.email ? { email: account.email } : {}),
      displayName: account.display_name,
      facilities: [],
      authenticationMethod: 'local',
      ...(passwordUpgrade ? { passwordUpgrade } : {}),
    };
  }

  principalHash(email: string): string {
    const pepper = this.environment.AUTH_LOGIN_PEPPER;
    if (!pepper) throw new Error('Login-attempt pepper is unavailable');
    return createHmac('sha256', pepper).update(email.trim().toLowerCase(), 'utf8').digest('hex');
  }
}
