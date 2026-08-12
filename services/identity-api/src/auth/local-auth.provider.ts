import { createHmac, randomBytes } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import bcrypt from 'bcryptjs';
import { DatabaseService } from '../database/database.service';
import { getEnvironment } from '../config/environment';
import type { CredentialIdentity } from './auth.types';

interface AccountRow {
  id: string;
  subject: string;
  email: string;
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

  async authenticate(email: string, password: string): Promise<CredentialIdentity> {
    const principalHash = this.principalHash(email);
    const attempt = await this.database.query<{ locked: boolean }>(
      `select locked_until is not null and locked_until > clock_timestamp() as locked
         from auth.login_attempts
        where principal_hmac = $1 and pepper_version = $2`,
      [principalHash, this.environment.AUTH_LOGIN_PEPPER_VERSION],
    );
    if (attempt.rows[0]?.locked) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const accountResult = await this.database.query<AccountRow>(
      `select id::text, subject, email, display_name, password_hash, password_algorithm,
              row_version::text
         from auth.accounts
        where lower(email) = lower($1)
          and status = 'active'
          and (disabled_until is null or disabled_until <= clock_timestamp())
        limit 1`,
      [email],
    );
    const account = accountResult.rows[0];
    const hash = account?.password_hash ?? await this.dummyHash;
    let passwordValid: boolean;
    if (account?.password_algorithm === 'bcrypt_legacy') {
      passwordValid = await bcrypt.compare(password, hash).catch(() => false);
      if (!passwordValid) await argon2.verify(await this.dummyHash, password).catch(() => false);
    } else {
      passwordValid = await argon2.verify(hash, password).catch(() => false);
    }
    if (!account || !passwordValid || !['argon2id', 'bcrypt_legacy'].includes(account.password_algorithm ?? '')) {
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
      email: account.email,
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
