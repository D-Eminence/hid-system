import { Injectable, Logger } from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { consumeRateLimit, type RateLimitWindow } from '../auth/rate-limit';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { createContactLookupHmac, normalizePatientPhone, patientPhoneStoredForms } from '../identity/contact-lookup';
import { ninStatusOf, type NinStatus } from '../identity/nin-status';
import { isDatabaseError, databaseMessage } from '../patient-safety/database-error';
import type { EmergencyPatientSearchDto, PatientSearchDto } from './patient-search.dto';
import {
  normalizeSearchName, patientSearchKeyKinds, patientSearchReach,
  type PatientSearchKeyKind, type PatientSearchKeys, type PatientSearchMode, type PatientSearchReach,
} from './patient-search-keys';

/** 30 standard searches per member in 10 minutes (plan ID-3a). */
export const PATIENT_SEARCH_MEMBER_WINDOW: RateLimitWindow = { windowSeconds: 600, maxRequests: 30 };
/** 300 standard searches per facility in an hour, with an alert (plan ID-3a). */
export const PATIENT_SEARCH_FACILITY_WINDOW: RateLimitWindow = { windowSeconds: 3600, maxRequests: 300 };
/** 5 emergency searches per member in an hour, with an alert (plan ID-3b). */
export const EMERGENCY_SEARCH_MEMBER_WINDOW: RateLimitWindow = { windowSeconds: 3600, maxRequests: 5 };

/** The warning log line a search limit writes (the alert): never a name, date of birth, Health ID or phone. */
export const PATIENT_SEARCH_LIMITED_EVENT = 'identity.patient_search.limited';

// 0145 (ID-7) adds record_kind at the end of the answer; it is read by name,
// so this also works on a database without 0145 (standard).
export const PATIENT_SEARCH_SQL = `select outcome, reach, match_ref, full_name, sex, date_of_birth::text as date_of_birth,
       health_id_last4, nin_verified, match_ref_expires_at, to_jsonb(answer) ->> 'record_kind' as record_kind
  from identity.staff_patient_search($1, $2, $3, $4::date, $5, $6::text[], $7, $8) answer`;

export type PatientSearchOutcome = 'found' | 'no_match' | 'no_such_patient' | 'too_many';

/** One card. Never a Health ID or a patient id: the matchRef stands for the patient for 10 minutes. */
export interface PatientSearchCard {
  matchRef: string;
  matchRefExpiresAt: string;
  fullName: string;
  sex: string | null;
  dateOfBirth: string | null;
  healthIdLast4: string | null;
  ninStatus: NinStatus;
  /** 0145 (ID-7): an unknown patient record is found only by its Health ID alone, at its facility. */
  recordKind: 'standard' | 'unknown';
}

export interface PatientSearchAnswer {
  mode: PatientSearchMode;
  outcome: PatientSearchOutcome;
  reach: PatientSearchReach;
  message: string | null;
  patients: PatientSearchCard[];
}

interface SearchRow {
  outcome: string;
  reach: string | null;
  match_ref: string | null;
  full_name: string | null;
  sex: string | null;
  date_of_birth: string | null;
  health_id_last4: string | null;
  nin_verified: boolean | null;
  match_ref_expires_at: Date | string | null;
  record_kind?: string | null;
}

const localKey = randomBytes(32);

export const PATIENT_SEARCH_MESSAGES = {
  noMatchEverywhere: 'No patient matches these details.',
  noMatchHere: 'No patient of this facility matches. To search every facility, add the full name and date of birth.',
  noSuchPatient: 'No patient has this Health ID.',
  tooMany: 'Too many matches. Add the date of birth or phone.',
  tooManyEmergency: 'More than 5 people match. Ask for a phone number or the Health ID.',
  tooBroad: 'Add more details. Search with the full name and date of birth, the Health ID with the last name or '
    + 'date of birth, or the phone with the last name. The Health ID, the phone, or the last name with the date of '
    + 'birth on their own find only this facility\'s patients.',
  limited: 'Too many searches. Please wait a few minutes and try again.',
  unavailable: 'Patient search is not available right now. Please try again in a minute.',
  notPermitted: 'You do not have permission to search for patients here.',
  phoneInvalid: 'Enter the phone number with its country code, or a Nigerian number starting with 0.',
  dateInvalid: 'Enter the date of birth as year-month-day, not in the future.',
  reasonRequired: 'Say why you need an emergency search (8 to 500 characters).',
  breakGlassDisabled: 'Emergency access is not enabled on this platform',
} as const;

/**
 * Staff patient search (0132; owner decisions of 18 November 2026): the
 * strong and weak key rule, Health ID included, and emergency search by
 * exact name and date of birth with a typed reason.
 *
 * Each search is counted first, in its own committed transaction
 * (auth.otp_rate_limits, buckets keyed by an HMAC of the membership or the
 * facility with the existing OTP key, as the order-destination directory
 * does): 30 standard searches per member in 10 minutes and 300 per facility
 * in an hour; 5 emergency searches per member in an hour. A limit answers
 * 429, is audited and writes a warning log line (the alert). Then
 * identity.staff_patient_search runs as the member and writes the search's
 * audit rows itself (key kinds and a keyed hash of the values, never the
 * values; the outcome; one row per patient shown). Refusals before or from
 * the database are audited here as denied identity.patient.search (or
 * identity.patient.emergency-search) rows with the refusal kind.
 */
@Injectable()
export class PatientSearchService {
  private readonly logger = new Logger(PatientSearchService.name);
  private readonly environment = getEnvironment();
  private readonly key: Buffer | null = this.environment.OTP_HMAC_KEY_B64
    ? Buffer.from(this.environment.OTP_HMAC_KEY_B64, 'base64')
    : this.environment.NODE_ENV === 'production' ? null : localKey;

  constructor(private readonly database: DatabaseService, private readonly audit: AuditService) {}

  async search(context: DataAccessContext, input: PatientSearchDto): Promise<PatientSearchAnswer> {
    const keys: PatientSearchKeys = {
      firstName: normalizeSearchName(input.firstName),
      lastName: normalizeSearchName(input.lastName),
      dateOfBirth: input.dateOfBirth,
      healthId: input.healthId,
    };
    const kinds = patientSearchKeyKinds({ ...keys, phone: input.phone ? 'phone' : undefined });
    if (keys.dateOfBirth !== undefined && !validDateOfBirth(keys.dateOfBirth)) {
      await this.refused(context, 'standard', kinds, 'date_invalid');
      throw new DomainProblem(400, 'PATIENT_SEARCH_DATE_INVALID', PATIENT_SEARCH_MESSAGES.dateInvalid);
    }
    if (input.phone !== undefined) {
      const phone = normalizePatientPhone(input.phone);
      if (!phone) {
        await this.refused(context, 'standard', kinds, 'phone_invalid');
        throw new DomainProblem(400, 'PATIENT_SEARCH_PHONE_INVALID', PATIENT_SEARCH_MESSAGES.phoneInvalid);
      }
      keys.phone = phone;
    }
    if (!patientSearchReach(keys)) {
      await this.refused(context, 'standard', kinds, 'too_broad');
      throw new DomainProblem(400, 'PATIENT_SEARCH_TOO_BROAD', PATIENT_SEARCH_MESSAGES.tooBroad);
    }
    return this.run(context, 'standard', keys, kinds, null);
  }

  async emergencySearch(context: DataAccessContext, input: EmergencyPatientSearchDto): Promise<PatientSearchAnswer> {
    const keys: PatientSearchKeys = {
      firstName: normalizeSearchName(input.firstName),
      lastName: normalizeSearchName(input.lastName),
      dateOfBirth: input.dateOfBirth,
    };
    const kinds = patientSearchKeyKinds(keys);
    if (!keys.firstName || !keys.lastName || !validDateOfBirth(input.dateOfBirth)) {
      await this.refused(context, 'emergency', kinds, 'date_invalid');
      throw new DomainProblem(400, 'PATIENT_SEARCH_DATE_INVALID', PATIENT_SEARCH_MESSAGES.dateInvalid);
    }
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length < 8 || reason.length > 500) {
      await this.refused(context, 'emergency', kinds, 'reason_required');
      throw new DomainProblem(400, 'EMERGENCY_SEARCH_REASON_REQUIRED', PATIENT_SEARCH_MESSAGES.reasonRequired);
    }
    return this.run(context, 'emergency', keys, kinds, reason);
  }

  private async run(context: DataAccessContext, mode: PatientSearchMode, keys: PatientSearchKeys,
    kinds: PatientSearchKeyKind[], reason: string | null): Promise<PatientSearchAnswer> {
    let phoneHmacs: string[] | null;
    let criteriaHash: string;
    try {
      phoneHmacs = keys.phone
        ? patientPhoneStoredForms(keys.phone).map((form) => createContactLookupHmac('phone', form)) : null;
      criteriaHash = this.criteriaHash(mode, keys);
    } catch {
      await this.refused(context, mode, kinds, 'unavailable', 'failure');
      throw new DomainProblem(503, 'PATIENT_SEARCH_UNAVAILABLE', PATIENT_SEARCH_MESSAGES.unavailable);
    }
    await this.count(context, mode, kinds);

    let rows: SearchRow[];
    try {
      rows = await this.database.withTransaction(context, async (client) =>
        (await client.query<SearchRow>(PATIENT_SEARCH_SQL, [mode, keys.firstName ?? null, keys.lastName ?? null,
          keys.dateOfBirth ?? null, keys.healthId ?? null, phoneHmacs, reason, criteriaHash])).rows);
    } catch (error) {
      const problem = searchProblem(error);
      await this.refused(context, mode, kinds, problem.code === 'PATIENT_SEARCH_UNAVAILABLE' ? 'unavailable'
        : problem.code.toLowerCase(), problem.code === 'PATIENT_SEARCH_UNAVAILABLE' ? 'failure' : 'denied');
      throw problem;
    }
    return this.answer(mode, rows);
  }

  /** The rows the database answered, as the route publishes them. */
  private answer(mode: PatientSearchMode, rows: SearchRow[]): PatientSearchAnswer {
    const first = rows[0];
    const reach: PatientSearchReach = first?.reach === 'here' ? 'here' : 'everywhere';
    switch (first?.outcome) {
      case 'found':
        return { mode, outcome: 'found', reach, message: null, patients: rows.map((row) => ({
          matchRef: String(row.match_ref),
          matchRefExpiresAt: new Date(row.match_ref_expires_at as string).toISOString(),
          fullName: String(row.full_name),
          sex: row.sex ?? null,
          dateOfBirth: row.date_of_birth ?? null,
          healthIdLast4: row.health_id_last4 ?? null,
          ninStatus: ninStatusOf(row.nin_verified),
          recordKind: row.record_kind === 'unknown' ? 'unknown' as const : 'standard' as const,
        })) };
      case 'no_match':
        return { mode, outcome: 'no_match', reach, patients: [],
          message: reach === 'here' ? PATIENT_SEARCH_MESSAGES.noMatchHere : PATIENT_SEARCH_MESSAGES.noMatchEverywhere };
      case 'no_such_health_id':
        return { mode, outcome: 'no_such_patient', reach, patients: [], message: PATIENT_SEARCH_MESSAGES.noSuchPatient };
      case 'too_many':
        return { mode, outcome: 'too_many', reach, patients: [],
          message: mode === 'emergency' ? PATIENT_SEARCH_MESSAGES.tooManyEmergency : PATIENT_SEARCH_MESSAGES.tooMany };
      case 'too_broad':
        // The database's own rule refused it (Identity checks the same rule first).
        throw new DomainProblem(400, 'PATIENT_SEARCH_TOO_BROAD', PATIENT_SEARCH_MESSAGES.tooBroad);
      default:
        throw new DomainProblem(503, 'PATIENT_SEARCH_UNAVAILABLE', PATIENT_SEARCH_MESSAGES.unavailable);
    }
  }

  /** Counts the search for the member (and, for a standard search, the facility); 429 when limited. */
  private async count(context: DataAccessContext, mode: PatientSearchMode, kinds: PatientSearchKeyKind[]): Promise<void> {
    let limited: 'member' | 'facility' | null;
    try {
      limited = await this.database.withTransaction(context, async (client) => {
        if (mode === 'emergency') {
          return await consumeRateLimit(client, 'account', this.bucket('patient-emergency-search-member', context.membershipId),
            EMERGENCY_SEARCH_MEMBER_WINDOW) ? 'member' : null;
        }
        const member = await consumeRateLimit(client, 'account',
          this.bucket('patient-search-member', context.membershipId), PATIENT_SEARCH_MEMBER_WINDOW);
        const facility = await consumeRateLimit(client, 'account',
          this.bucket('patient-search-facility', context.facilityId), PATIENT_SEARCH_FACILITY_WINDOW);
        return member ? 'member' : facility ? 'facility' : null;
      });
    } catch {
      await this.refused(context, mode, kinds, 'unavailable', 'failure');
      throw new DomainProblem(503, 'PATIENT_SEARCH_UNAVAILABLE', PATIENT_SEARCH_MESSAGES.unavailable);
    }
    if (!limited) return;
    // The alert: a warning log line with the limit, never what was searched for.
    this.logger.warn({ event: PATIENT_SEARCH_LIMITED_EVENT, mode, limit: limited,
      correlationId: context.correlationId, facilityId: context.facilityId });
    await this.refused(context, mode, kinds, `limited_${limited}`);
    throw new DomainProblem(429, 'PATIENT_SEARCH_LIMITED', PATIENT_SEARCH_MESSAGES.limited);
  }

  /** A bucket for auth.otp_rate_limits: HMAC-SHA-256 with the OTP key over the label and the id, never the id itself. */
  bucket(label: string, id: string): string {
    if (!this.key) throw new DomainProblem(503, 'PATIENT_SEARCH_UNAVAILABLE', PATIENT_SEARCH_MESSAGES.unavailable);
    return createHmac('sha256', this.key).update(`${label}\0`).update(id).digest('hex');
  }

  /**
   * The keyed hash of what was searched for, for the audit row (the same
   * search gives the same hash, so repeats can be seen without the values):
   * HMAC-SHA-256 with the OTP key. Never the values themselves.
   */
  criteriaHash(mode: PatientSearchMode, keys: PatientSearchKeys): string {
    if (!this.key) throw new DomainProblem(503, 'PATIENT_SEARCH_UNAVAILABLE', PATIENT_SEARCH_MESSAGES.unavailable);
    return createHmac('sha256', this.key).update('patient-search-criteria\0').update(JSON.stringify([mode,
      keys.firstName ?? null, keys.lastName ?? null, keys.dateOfBirth ?? null, keys.healthId ?? null,
      keys.phone ?? null])).digest('hex');
  }

  /** A denied (or failed) search's audit row: the refusal and the key kinds, never the values. */
  private refused(context: DataAccessContext, mode: PatientSearchMode, kinds: PatientSearchKeyKind[], refusal: string,
    outcome: 'denied' | 'failure' = 'denied'): Promise<void> {
    return this.audit.record({
      correlationId: context.correlationId,
      actorType: 'staff',
      actorSubject: context.actor.subject,
      actorAccountId: context.actor.accountId,
      actorMembershipId: context.membershipId,
      organizationId: context.actor.facility?.organizationId,
      facilityId: context.facilityId,
      action: mode === 'emergency' ? 'identity.patient.emergency-search' : 'identity.patient.search',
      resourceType: 'patient-search',
      outcome,
      purposeOfUse: context.purposeOfUse,
      details: { mode, criteria: kinds, refusal },
    });
  }
}

/** YYYY-MM-DD, a real calendar day, not in the future and not before 1880. */
export function validDateOfBirth(value: string | undefined): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return false;
  return value >= '1880-01-01' && date.getTime() <= Date.now();
}

/** The database's refusals as the route answers them: never the database's text. */
export function searchProblem(error: unknown): DomainProblem {
  if (error instanceof DomainProblem) return error;
  if (isDatabaseError(error)) {
    const message = databaseMessage(error);
    if (error.code === '42501') {
      return new DomainProblem(403, 'PATIENT_SEARCH_NOT_PERMITTED', PATIENT_SEARCH_MESSAGES.notPermitted);
    }
    if (error.code === '55000' && message === 'PLATFORM_CONTROL_DISABLED:break_glass_enabled') {
      return new DomainProblem(423, 'BREAK_GLASS_DISABLED', PATIENT_SEARCH_MESSAGES.breakGlassDisabled);
    }
    if (error.code === '22023') {
      if (message === 'PATIENT_SEARCH_REASON_REQUIRED') {
        return new DomainProblem(400, 'EMERGENCY_SEARCH_REASON_REQUIRED', PATIENT_SEARCH_MESSAGES.reasonRequired);
      }
      if (message === 'PATIENT_SEARCH_PURPOSE') {
        return new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED',
          'X-Purpose-Of-Use must be direct-care for a search, or emergency for an emergency search');
      }
      return new DomainProblem(400, 'PATIENT_SEARCH_INVALID', PATIENT_SEARCH_MESSAGES.tooBroad);
    }
  }
  return new DomainProblem(503, 'PATIENT_SEARCH_UNAVAILABLE', PATIENT_SEARCH_MESSAGES.unavailable);
}
