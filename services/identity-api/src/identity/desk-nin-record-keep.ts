import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { NIN_RECORD_ANSWER_SECONDS } from './nin-check-once';
import { NinIdentifierProtector } from './nin-identifier-protector';

/** 0137's commands, as NinCheckOnce sends them. */
export const KEEP_BEGIN_SQL = 'select * from identity.begin_qoreid_nin_check($1,$2,$3,$4,$5,$6)';
export const KEEP_FINISH_SQL = 'select identity.finish_qoreid_nin_check($1,$2,$3,$4,$5,$6,$7,$8) as recorded';

/**
 * The key version the keep asks with to be handed the NIN's row: never a
 * NIN_KEY_VERSION in use, so 0137's begin takes the row over for this attempt
 * ("another key version is taken over"), and the finish puts the same answer
 * back under the real key version.
 */
export const KEEP_TAKE_OVER_KEY_VERSION = 'desk-keep-matched-record';

/** How long the keep's lease would last, were its transaction not to end first (0137 allows 5-300). */
const KEEP_LEASE_SECONDS = 30;

interface BeginRow {
  decision: string;
  outcome: string | null;
  record_complete: boolean | null;
  answer_ciphertext: Buffer | null;
}

/** Nothing to keep: the transaction is rolled back and nothing has changed. */
class NothingToKeep extends Error {}

/**
 * D2 (Q110, the coordinator's "keep a matched, unattached record for 90
 * days"): the registration desk found that the record 0137's guard keeps for
 * a NIN matches the name and date of birth it entered. That record is kept
 * for 90 days from now (NIN_RECORD_ANSWER_SECONDS), however long it was kept
 * before: a record first kept 24 hours because an earlier request's details
 * did not match it (a typo, or a profile check of other details) is not paid
 * for again once the corrected details have matched it.
 *
 * 0137 lets only the attempt holding a NIN's lease record an answer, and
 * never hands out a lease on a usable stored answer, so the keep takes one,
 * in a single transaction that holds the row's lock from the first statement
 * to the last (no other attempt sees anything between them):
 *   1. begin, as any check of the NIN: the stored record (its ciphertext,
 *      unread here, and whether it is complete), locking the row;
 *   2. begin with KEEP_TAKE_OVER_KEY_VERSION: 0137 hands this attempt the
 *      row's lease;
 *   3. finish: the same ciphertext under the real key version, kept
 *      NIN_RECORD_ANSWER_SECONDS.
 * Anything else (no stored record, another outcome, a check running, a hold,
 * another key version, a NIN whose login was deleted) rolls back: nothing
 * changes. The answer is not decrypted, re-encrypted or read here; nothing is
 * sent to QoreID. A keep that cannot be made is logged without an identifier
 * and the desk's answer stands.
 */
@Injectable()
export class DeskNinRecordKeep {
  private readonly logger = new Logger(DeskNinRecordKeep.name);

  constructor(private readonly database: DatabaseService,
    private readonly ninProtector: NinIdentifierProtector) {}

  /** True when the stored record is now kept 90 days from now; false when there was none to keep. */
  async keepMatchedRecord(nin: string, correlationId: string): Promise<boolean> {
    try {
      const lookup = this.ninProtector.lookup(nin);
      const keyVersion = getEnvironment().NIN_KEY_VERSION;
      await this.database.withSystemTransaction(correlationId, async (client) => {
        const stored = (await client.query<BeginRow>(KEEP_BEGIN_SQL,
          [lookup, null, false, keyVersion, randomUUID(), KEEP_LEASE_SECONDS])).rows[0];
        if (stored?.decision !== 'stored' || stored.outcome !== 'record'
          || typeof stored.record_complete !== 'boolean' || !Buffer.isBuffer(stored.answer_ciphertext)) {
          throw new NothingToKeep();
        }
        const attempt = randomUUID();
        const taken = (await client.query<BeginRow>(KEEP_BEGIN_SQL,
          [lookup, null, false, KEEP_TAKE_OVER_KEY_VERSION, attempt, KEEP_LEASE_SECONDS])).rows[0];
        if (taken?.decision !== 'call') throw new NothingToKeep();
        const finished = (await client.query<{ recorded: boolean }>(KEEP_FINISH_SQL,
          [lookup, attempt, 'record', null, stored.record_complete, stored.answer_ciphertext, keyVersion,
            NIN_RECORD_ANSWER_SECONDS])).rows[0];
        if (finished?.recorded !== true) throw new NothingToKeep();
      });
      return true;
    } catch (error) {
      if (!(error instanceof NothingToKeep)) {
        // No NIN, HMAC or SQL text.
        this.logger.warn({ event: 'identity.nin.record_keep_failed', correlationId,
          code: typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
            ? error.code : 'unknown' });
      }
      return false;
    }
  }
}
