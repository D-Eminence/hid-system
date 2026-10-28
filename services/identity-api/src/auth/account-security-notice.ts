import type { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';

/** The security notices Identity writes into a patient's inbox (0093; owner decision of 2026-10-28). */
export type AccountSecurityNoticeCode =
  | 'SECURITY_PASSWORD_RESET_REQUESTED'
  | 'SECURITY_PASSWORD_CHANGED'
  | 'SECURITY_GOOGLE_LINKED';

/**
 * Writes a security notice in the caller's transaction through 0093's
 * auth.record_account_security_notice (system:auth), which writes it only for
 * the account's active patient, only with its evidence (a recovery challenge,
 * a changed password, a Google link), once per evidence and a reset request
 * at most once an hour, with no PHI and no secret (resource type 'account',
 * empty metadata). It runs under a savepoint and never fails the sign-in,
 * reset or link it belongs to: a refusal is rolled back to the savepoint and
 * logged with the correlation id only.
 */
export async function recordAccountSecurityNotice(client: PoolClient, accountId: string,
  code: AccountSecurityNoticeCode, logger: Pick<Logger, 'warn'>, correlationId: string): Promise<void> {
  await client.query('savepoint account_security_notice');
  try {
    await client.query('select auth.record_account_security_notice($1, $2)', [accountId, code]);
    await client.query('release savepoint account_security_notice');
  } catch {
    await client.query('rollback to savepoint account_security_notice');
    logger.warn(`Account security notice ${code} was not written (correlation ${correlationId})`);
  }
}
