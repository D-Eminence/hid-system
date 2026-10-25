import * as argon2 from 'argon2';
import { DomainProblem } from '../common/problem';

/**
 * The password hash of an account created by a public flow (provider
 * activation, clinician self sign-up): argon2id with 64 MiB, three passes and
 * one lane, the parameters the database commands require
 * ('$argon2id$v=19$m=65536,t=3,p=1$').
 */
export const ACCOUNT_PASSWORD_HASH = { type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 } as const;

/** A password of 12 to 256 characters, else 400 PASSWORD_INVALID. */
export function assertPasswordLength(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    throw new DomainProblem(400, 'PASSWORD_INVALID', 'Password must be 12–256 characters');
  }
}

export function hashAccountPassword(password: string): Promise<string> {
  return argon2.hash(password, ACCOUNT_PASSWORD_HASH);
}
