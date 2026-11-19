import { createHmac, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { consumeRateLimit, type RateLimitWindow } from '../auth/rate-limit';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';

/**
 * Q100 B (owner decision of 18 Nov 2026): a staff Health ID lookup for a
 * Health ID that no patient record has at all answers "No such patient"
 * distinctly (404 PATIENT_NOT_FOUND). A patient that exists but is not
 * available to this facility keeps today's answer.
 *
 * Every lookup answered 404 (no such patient, or not available) is counted
 * for the person, in an `account` bucket of auth.otp_rate_limits keyed by an
 * HMAC of the staff account: 30 in 10 minutes, whichever of the account's
 * facilities X-Facility-ID names, so a member of several facilities gets no
 * fresh 30 by changing facility. From the 31st, a lookup that finds no
 * patient is answered with today's 404 NOT_FOUND for 10 minutes, never "No
 * such patient", before anything is said about the Health ID. It is never a
 * 429: every client closes an open record on 403 or 404. A lookup that opens
 * a patient is not counted, and neither is today's 403 for a patient this
 * lookup may see but not open: the issued check is never asked there, so it
 * says nothing new, and counting it would limit a desk working through
 * patients who have not yet given consent.
 *
 * Whether a Health ID was ever issued is read with
 * identity.support_health_id_matches (0109): it reads past the patients'
 * row-level security as the table's owner and answers only the candidate it
 * was given, nothing else about any patient, for every status (a Health ID
 * stays personal once issued). No migration and no new setting: the HMAC key
 * is the existing OTP_HMAC_KEY_B64 (required in production).
 *
 * The seals (0098 demo, 0123 QA): nothing in a sealed tenant ever finds a real
 * patient, and nothing real finds a sealed one. Because the check reads past
 * row-level security, it is asked only when the Health ID and the member's
 * facility are on the same side: a real facility for a real Health ID (any
 * Health ID not starting ZDEM or ZQA), the demo tenant for HID-ZDEM and four
 * more characters, the QA tenant for HID-ZQA and five more (the sealed Health
 * IDs have 8 characters, which Identity's generator has never issued; since
 * Q60 it never starts one with ZDEM or ZQA either). Any other pairing, and
 * any other Health ID starting ZDEM or ZQA (a real one issued before Q60
 * included), gets today's 404, so no side learns whether another side's
 * Health ID exists. The side of the facility is read with
 * identity.sealed_demo_facility (0098) and identity.sealed_qa_facility (0123),
 * which identity-api's runtime may already execute: a facility neither marks
 * is real; one both mark, or one they cannot answer for, has no side.
 *
 * Fails closed to today's answer: when the member cannot be counted, the side
 * of the facility cannot be told, or the check cannot be read, the answer is
 * today's 404, never "No such patient".
 */
export const PATIENT_LOOKUP_MISS_WINDOW: RateLimitWindow = { windowSeconds: 600, maxRequests: 30 };

export const PATIENT_NOT_FOUND_CODE = 'PATIENT_NOT_FOUND';
export const PATIENT_NOT_FOUND_MESSAGE = 'No patient has this Health ID.';

export const patientNotFound = () => new DomainProblem(404, PATIENT_NOT_FOUND_CODE, PATIENT_NOT_FOUND_MESSAGE);

/** A Health ID as identity.patients' CHECK (0002) and the lookup body require it. */
const HEALTH_ID = /^HID-[A-HJ-NP-Z2-9]{6,32}$/;
/** The sealed tenants' Health IDs (0098 D7, 0123 D7): 8 characters, ZDEM or ZQA first. */
const DEMO_HEALTH_ID = /^HID-ZDEM[A-HJ-NP-Z2-9]{4}$/;
const QA_HEALTH_ID = /^HID-ZQA[A-HJ-NP-Z2-9]{5}$/;
const SEALED_PREFIX = /^HID-(ZDEM|ZQA)/;

export type LookupSide = 'real' | 'demo' | 'qa';

/**
 * Which side a Health ID belongs to, or undefined for one starting ZDEM or
 * ZQA that is not a sealed tenant's 8-character Health ID (never answered
 * "No such patient" for anyone).
 */
export function healthIdSide(candidate: string): LookupSide | undefined {
  if (DEMO_HEALTH_ID.test(candidate)) return 'demo';
  if (QA_HEALTH_ID.test(candidate)) return 'qa';
  return SEALED_PREFIX.test(candidate) ? undefined : 'real';
}

const localKey = randomBytes(32);

@Injectable()
export class PatientLookupMissService {
  private readonly logger = new Logger(PatientLookupMissService.name);
  private readonly environment = getEnvironment();
  private readonly key: Buffer | null = this.environment.OTP_HMAC_KEY_B64
    ? Buffer.from(this.environment.OTP_HMAC_KEY_B64, 'base64')
    : this.environment.NODE_ENV === 'production' ? null : localKey;

  constructor(private readonly database: DatabaseService) {}

  /**
   * The person's bucket: HMAC-SHA-256 with the OTP key over
   * 'patient-lookup-miss-account\0' + staff account id. One bucket per
   * account, not per membership: the security guard takes the membership from
   * whichever of the account's facilities X-Facility-ID names.
   */
  bucket(accountId: string): string | null {
    if (!this.key || !accountId) return null;
    return createHmac('sha256', this.key).update('patient-lookup-miss-account\0').update(accountId).digest('hex');
  }

  /**
   * Counts one lookup answered 404 (no patient found), for the staff account;
   * a 403 is never counted. True
   * when the account is (now) limited, false when not, undefined when it could
   * not be counted (no account, no membership, or the database failed).
   */
  async countMiss(context: DataAccessContext): Promise<boolean | undefined> {
    const bucket = context.membershipId ? this.bucket(context.actor.accountId) : null;
    if (!bucket) return undefined;
    try {
      return await this.database.withTransaction(context, (client) =>
        consumeRateLimit(client, 'account', bucket, PATIENT_LOOKUP_MISS_WINDOW));
    } catch {
      this.logger.warn({ message: 'Patient lookup miss could not be counted', correlationId: context.correlationId });
      return undefined;
    }
  }

  /**
   * The side of the member's facility: real, the sealed demo tenant or the
   * sealed QA tenant; undefined when that cannot be told (no facility, the
   * functions cannot be read, or they do not answer one boolean each, or both
   * say yes).
   */
  async facilitySide(facilityId: string, correlationId?: string): Promise<LookupSide | undefined> {
    if (!facilityId) return undefined;
    try {
      const result = await this.database.query<{ demo: unknown; qa: unknown }>(
        'select identity.sealed_demo_facility($1::uuid) as demo, identity.sealed_qa_facility($1::uuid) as qa',
        [facilityId]);
      const row = result.rows.length === 1 ? result.rows[0] : undefined;
      if (!row || typeof row.demo !== 'boolean' || typeof row.qa !== 'boolean' || (row.demo && row.qa)) {
        return undefined;
      }
      return row.demo ? 'demo' : row.qa ? 'qa' : 'real';
    } catch {
      this.logger.warn({ message: 'Facility side is unavailable for the Health ID issued check', correlationId });
      return undefined;
    }
  }

  /**
   * Whether any patient record, of any status, has this Health ID: true or
   * false, or undefined when that cannot be told (the answer is then today's).
   * Asked only when the Health ID is on the member's facility's side (the
   * seals): for a Health ID of another side, or one starting ZDEM or ZQA that
   * is not a sealed tenant's, nothing is asked and the answer is undefined.
   * Logs no Health ID.
   */
  async issued(hid: string, context: DataAccessContext): Promise<boolean | undefined> {
    const candidate = hid.trim().toUpperCase();
    if (!HEALTH_ID.test(candidate)) return undefined;
    const side = healthIdSide(candidate);
    if (!side) return undefined;
    if (await this.facilitySide(context.facilityId, context.correlationId) !== side) return undefined;
    try {
      const result = await this.database.query<{ health_id: string }>(
        'select health_id from identity.support_health_id_matches($1::text[])', [[candidate]]);
      // The function answers the candidate or nothing; anything else means the database is not as 0109 made it.
      if (result.rows.length > 1 || result.rows.some((row) => row.health_id !== candidate)) return undefined;
      return result.rows.length === 1;
    } catch {
      this.logger.warn({ message: 'Health ID issued check is unavailable', correlationId: context.correlationId });
      return undefined;
    }
  }
}
