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
 * Every lookup that does not open a patient (no such patient, not available,
 * or not authorized) is counted for the member in an `account` bucket of
 * auth.otp_rate_limits keyed by an HMAC of the membership (as Order
 * destinations count searches): 30 in 10 minutes. The 31st answers 429
 * PATIENT_LOOKUP_LIMITED for 10 minutes, before anything is said about the
 * Health ID. A lookup that opens a patient is not counted.
 *
 * Whether a Health ID was ever issued is read with
 * identity.support_health_id_matches (0109): it reads past the patients'
 * row-level security as the table's owner and answers only the candidate it
 * was given, nothing else about any patient, for every status (a Health ID
 * stays personal once issued). No migration and no new setting: the HMAC key
 * is the existing OTP_HMAC_KEY_B64 (required in production).
 *
 * Fails closed to today's answer: when the member cannot be counted or the
 * check cannot be read, the answer is today's 404, never "No such patient".
 */
export const PATIENT_LOOKUP_MISS_WINDOW: RateLimitWindow = { windowSeconds: 600, maxRequests: 30 };

export const PATIENT_NOT_FOUND_CODE = 'PATIENT_NOT_FOUND';
export const PATIENT_NOT_FOUND_MESSAGE = 'No patient has this Health ID.';
export const PATIENT_LOOKUP_LIMITED_CODE = 'PATIENT_LOOKUP_LIMITED';
export const PATIENT_LOOKUP_LIMITED_MESSAGE =
  'Too many Health IDs could not be opened. Wait 10 minutes, then try again.';

export const patientNotFound = () => new DomainProblem(404, PATIENT_NOT_FOUND_CODE, PATIENT_NOT_FOUND_MESSAGE);
export const patientLookupLimited = () => new DomainProblem(429, PATIENT_LOOKUP_LIMITED_CODE,
  PATIENT_LOOKUP_LIMITED_MESSAGE);

/** A Health ID as identity.patients' CHECK (0002) and the lookup body require it. */
const HEALTH_ID = /^HID-[A-HJ-NP-Z2-9]{6,32}$/;

const localKey = randomBytes(32);

@Injectable()
export class PatientLookupMissService {
  private readonly logger = new Logger(PatientLookupMissService.name);
  private readonly environment = getEnvironment();
  private readonly key: Buffer | null = this.environment.OTP_HMAC_KEY_B64
    ? Buffer.from(this.environment.OTP_HMAC_KEY_B64, 'base64')
    : this.environment.NODE_ENV === 'production' ? null : localKey;

  constructor(private readonly database: DatabaseService) {}

  /** The member's bucket: HMAC-SHA-256 with the OTP key over 'patient-lookup-miss\0' + membership id. */
  bucket(membershipId: string): string | null {
    if (!this.key || !membershipId) return null;
    return createHmac('sha256', this.key).update('patient-lookup-miss\0').update(membershipId).digest('hex');
  }

  /**
   * Counts one lookup that did not open a patient. True when the member is
   * (now) limited, false when not, undefined when it could not be counted.
   */
  async countMiss(context: DataAccessContext): Promise<boolean | undefined> {
    const bucket = this.bucket(context.membershipId);
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
   * Whether any patient record, of any status, has this Health ID: true or
   * false, or undefined when that cannot be told (the answer is then today's).
   * Logs no Health ID.
   */
  async issued(hid: string): Promise<boolean | undefined> {
    const candidate = hid.trim().toUpperCase();
    if (!HEALTH_ID.test(candidate)) return undefined;
    try {
      const result = await this.database.query<{ health_id: string }>(
        'select health_id from identity.support_health_id_matches($1::text[])', [[candidate]]);
      // The function answers the candidate or nothing; anything else means the database is not as 0109 made it.
      if (result.rows.length > 1 || result.rows.some((row) => row.health_id !== candidate)) return undefined;
      return result.rows.length === 1;
    } catch {
      this.logger.warn({ message: 'Health ID issued check is unavailable' });
      return undefined;
    }
  }
}
