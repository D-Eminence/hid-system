import { createHmac, randomBytes } from 'node:crypto';
import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import bcrypt from 'bcryptjs';
import { DatabaseService } from '../database/database.service';
import { getEnvironment } from '../config/environment';
import type { CredentialIdentity } from './auth.types';
import { accountLoginBucket, RECORD_LOGIN_FAILURE_SQL } from './login-attempts';

interface AccountRow {
  id: string;
  subject: string;
  email: string | null;
  display_name: string;
  password_hash: string | null;
  password_algorithm: string | null;
  row_version: string;
}

@Injectable()
export class LocalAuthProvider {
  private readonly environment = getEnvironment();
  private readonly dummyHash = argon2.hash(randomBytes(32), {
    type: argon2.argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
  });

  constructor(private readonly database: DatabaseService) {}

  async authenticate(principal: string, password: string,
    actorKind: 'staff' | 'patient' = 'staff', correlationId?: string): Promise<CredentialIdentity> {
    const hidLogin = actorKind === 'patient' && /^HID-[A-HJ-NP-Z2-9]{6,32}$/i.test(principal);
    const principalHash = this.principalHash(principal);
    const attempt = await this.database.query<{ locked: boolean }>(
      `select locked_until is not null and locked_until > clock_timestamp() as locked
         from auth.login_attempts
        where principal_hmac = $1 and pepper_version = $2`,
      [principalHash, this.environment.AUTH_LOGIN_PEPPER_VERSION],
    );
    if (attempt.rows[0]?.locked) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const accountSql = `select account.id::text, account.subject, account.email,
            account.display_name, account.password_hash, account.password_algorithm,
            account.row_version::text
       from auth.accounts account
      where ${hidLogin
        ? `exists (select 1 from identity.patients patient
             where patient.account_id=account.id and upper(patient.hid_code)=upper($1)
               and patient.status='active')`
        : 'lower(account.email) = lower($1)'}
        and account.status = 'active'
        and (account.disabled_until is null or account.disabled_until <= clock_timestamp())
      limit 1`;
    const accountResult = hidLogin
      ? await this.database.withSystemTransaction(correlationId ?? 'auth-hid-login-lookup', (client) =>
          client.query<AccountRow>(accountSql, [principal]))
      : await this.database.query<AccountRow>(accountSql, [principal]);
    const account = accountResult.rows[0];
    const hash = account?.password_hash ?? await this.dummyHash;
    let passwordValid: boolean;
    if (account?.password_algorithm === 'bcrypt_legacy') {
      passwordValid = await bcrypt.compare(password, hash).catch(() => false);
      if (!passwordValid) await argon2.verify(await this.dummyHash, password).catch(() => false);
    } else {
      passwordValid = await argon2.verify(hash, password).catch(() => false);
    }
    if (!account) throw new UnauthorizedException('Invalid credentials');
    // One failure budget per resolved account as well as per identifier, so the
    // email and the HID of an account share it (SIGNIN-LOCKOUT). Read after the
    // password check, so a locked account costs what any sign-in does. While it
    // is locked even the correct password is refused, with the same 401.
    const accountBucket = this.accountHash(account.id);
    const accountAttempt = await this.database.query<{ locked: boolean }>(
      `select locked_until is not null and locked_until > clock_timestamp() as locked
         from auth.login_attempts
        where principal_hmac = $1 and pepper_version = $2`,
      [accountBucket, this.environment.AUTH_LOGIN_PEPPER_VERSION],
    );
    if (accountAttempt.rows[0]?.locked
      || !passwordValid || !['argon2id', 'bcrypt_legacy'].includes(account.password_algorithm ?? '')) {
      await this.recordAccountFailure(accountBucket);
      throw new UnauthorizedException('Invalid credentials');
    }
    if (accountAttempt.rows[0]) {
      // A correct password ends the account's failure window, as a session
      // issue ends the identifier's.
      await this.database.query('delete from auth.login_attempts where principal_hmac = $1 and pepper_version = $2',
        [accountBucket, this.environment.AUTH_LOGIN_PEPPER_VERSION]);
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

  private accountHash(accountId: string): string {
    const pepper = this.environment.AUTH_LOGIN_PEPPER;
    if (!pepper) throw new Error('Login-attempt pepper is unavailable');
    return accountLoginBucket(pepper, accountId);
  }

  private async recordAccountFailure(accountBucket: string): Promise<void> {
    try {
      await this.database.query(RECORD_LOGIN_FAILURE_SQL, [accountBucket, this.environment.AUTH_LOGIN_PEPPER_VERSION]);
    } catch {
      throw new ServiceUnavailableException('Authentication audit persistence is unavailable');
    }
  }

  principalHash(email: string): string {
    const pepper = this.environment.AUTH_LOGIN_PEPPER;
    if (!pepper) throw new Error('Login-attempt pepper is unavailable');
    return createHmac('sha256', pepper).update(email.trim().toLowerCase(), 'utf8').digest('hex');
  }
}
