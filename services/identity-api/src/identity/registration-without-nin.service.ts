import { randomUUID } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { requestDigest, requireIdempotencyKey } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { CollectedFieldProtector, registrationCaseContactLabel } from './collected-field-protector';
import { createContactLookupHmac, normalizePatientPhone, patientPhoneStoredForms } from './contact-lookup';
import { HidCodeGenerator } from './hid-code-generator.service';
import type { RegisterWithoutNinDto } from './dto/register-without-nin.dto';
import type { NinStatus } from './nin-status';

/**
 * 0130 (ID-2, owner Q106 of 18 November 2026, verbatim intent): the front
 * desk registers a patient without a NIN. "Phone required except for
 * children. The same desk person creates the record when there are no
 * possible duplicates. An approver decides when there are possible
 * duplicates, and always for link-existing."
 *
 * The decisions are the database's (identity.register_patient_without_nin
 * and identity.review_patient_without_nin): this service protects the phone
 * and address, computes the phone's lookup hashes, reserves a Health ID and
 * maps each refusal to a plain message. The desk is told only whether the
 * patient was registered or sent for review, never who might be the same
 * person.
 */

/**
 * There is no daily limit (owner Q109: no rate limit on a staff member or facility). At this many registrations without
 * a NIN in a day at one facility, an alert is logged (no identifiers).
 */
export const NO_NIN_FACILITY_DAILY_ALERT = 50;

export type WithoutNinDecision = 'create_new' | 'link_existing' | 'reject';

interface RegisterRow extends QueryResultRow {
  case_id: string;
  case_status: 'approved_new_identity' | 'review_required';
  case_version: string;
  subject_patient_id: string | null;
  subject_hid_code: string | null;
  candidate_count: number;
  facility_daily_count: number | null;
  replayed: boolean;
}

interface ReviewRow extends QueryResultRow {
  case_id: string;
  case_status: 'approved_new_identity' | 'linked_existing' | 'rejected';
  case_version: string;
  subject_patient_id: string | null;
  subject_hid_code: string | null;
  candidate_count: number;
  replayed: boolean;
}

/** The desk's answer: the outcome only. */
export interface RegisteredWithoutNin {
  caseId: string;
  status: 'approved_new_identity' | 'review_required';
  version: number;
  outcome: 'registered' | 'sent_for_review';
  /** Plain words for the desk. */
  message: string;
  identityEvidence: 'none';
  ninStatus: NinStatus;
  replayed: boolean;
  patient?: { patientId: string; hid: string };
}

export interface ReviewedWithoutNin {
  caseId: string;
  status: 'approved_new_identity' | 'linked_existing' | 'rejected';
  version: number;
  identityEvidence: 'none';
  ninStatus: NinStatus;
  replayed: boolean;
  patient?: { patientId: string; hid: string };
}

export const WITHOUT_NIN_MESSAGES = {
  registered: 'Patient registered. Their NIN is not verified yet.',
  sentForReview: 'This may be someone who is already registered. An approver will review it before a record is made.',
  phoneRequired: 'Enter the patient\'s phone number and address. Only a child can be registered without them.',
  notAChild: 'This date of birth makes the patient 18 or older. Choose another reason.',
  invalid: 'Some details are missing or not valid. Check them and try again.',
  statedHealthId: 'Give the Health ID only when the patient says they already have one.',
  denied: 'You cannot register patients at this facility.',
  sealed: 'Registration without a NIN is not available at a demonstration or test facility.',
  keyReused: 'This request was already sent with different details. Start a new registration.',
  reviewDenied: 'Only an approver at this facility can decide this registration.',
  secondPerson: 'Another approver must decide this registration, because you started it.',
  notFound: 'This registration was not found at this facility.',
  notAwaiting: 'This registration has already been decided.',
  versionConflict: 'This registration has changed. Reload it and try again.',
  notCandidate: 'Choose one of the people listed for this registration.',
  notWithoutNin: 'This registration has a NIN. Use the approve or link action instead.',
  statedUnknownRecord: 'This Health ID belongs to an unknown patient record at this facility. Identify that record instead.',
  linkUnknownRecord: 'This record is not identified yet, so it cannot be linked. Identify it first.',
} as const;

@Injectable()
export class RegistrationWithoutNinService {
  private readonly logger = new Logger(RegistrationWithoutNinService.name);
  private readonly fieldProtector = new CollectedFieldProtector();

  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly hidGenerator: HidCodeGenerator,
    @Optional() fieldProtector?: CollectedFieldProtector,
  ) {
    if (fieldProtector) this.fieldProtector = fieldProtector;
  }

  async register(input: RegisterWithoutNinDto, idempotencyHeader: string | undefined,
    context: DataAccessContext): Promise<RegisteredWithoutNin> {
    const idempotencyKey = requireIdempotencyKey(idempotencyHeader);
    if (!input.hasExistingHealthId && input.existingHealthId) {
      await this.auditRefusal(context, 'identity.registration.without-nin', 'STATED_HEALTH_ID_UNEXPECTED');
      throw new DomainProblem(400, 'REGISTRATION_WITHOUT_NIN_INVALID', WITHOUT_NIN_MESSAGES.statedHealthId);
    }
    const contact = input.phone ? {
      phone: normalizePatientPhone(input.phone) ?? input.phone,
      address: JSON.stringify({ addressLine: input.addressLine, city: input.city, stateCode: input.stateCode, lga: input.lga }),
    } : null;
    if (contact) this.fieldProtector.assertConfigured();
    const phoneLookups = contact
      ? patientPhoneStoredForms(contact.phone).map((form) => createContactLookupHmac('phone', form)).join(',')
      : null;
    // The digest names the phone by its lookup hash, never the number.
    const requestSha256 = requestDigest('identity.registration.without-nin', {
      firstName: input.firstName, lastName: input.lastName, dateOfBirth: input.dateOfBirth,
      gender: input.gender ?? null, noNinReason: input.noNinReason, purpose: input.purpose,
      phoneLookup: phoneLookups, address: contact ? contact.address : null,
      existingHealthId: input.hasExistingHealthId ? input.existingHealthId ?? null : null,
    });
    const caseId = randomUUID();
    const protectedContact = contact ? {
      phone: this.fieldProtector.encrypt(registrationCaseContactLabel(caseId, 'phone'), contact.phone),
      address: this.fieldProtector.encrypt(registrationCaseContactLabel(caseId, 'address'), contact.address),
      keyVersion: this.fieldProtector.keyVersion,
    } : null;
    let row: RegisterRow;
    try {
      row = await this.hidGenerator.reserve<RegisterRow>(async (candidateHid) => {
        try {
          const result = await this.database.withTransaction(context, async (client) => (await client.query<RegisterRow>(
            `select case_id::text, case_status, case_version::text, subject_patient_id::text, subject_hid_code,
                    candidate_count, facility_daily_count, replayed
               from identity.register_patient_without_nin($1::uuid, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $11,
                 $12, $13, $14)`,
            [caseId, input.firstName, input.lastName, input.dateOfBirth, input.gender ?? null, input.noNinReason,
              phoneLookups, protectedContact?.phone ?? null, protectedContact?.address ?? null,
              protectedContact?.keyVersion ?? null, input.hasExistingHealthId ? input.existingHealthId ?? null : null,
              idempotencyKey, requestSha256, candidateHid],
          )).rows[0]);
          if (!result) throw new DomainProblem(503, 'REGISTRATION_WITHOUT_NIN_UNAVAILABLE', 'Registration is not available right now. Try again.');
          return { reserved: true as const, result };
        } catch (error) {
          if (isHidCollision(error)) return { reserved: false as const };
          throw error;
        }
      });
    } catch (error) {
      const problem = this.translateRegister(error);
      if (problem instanceof DomainProblem) {
        await this.auditRefusal(context, 'identity.registration.without-nin', problem.code);
      }
      throw problem;
    }
    if (!row.replayed && row.facility_daily_count !== null && row.facility_daily_count >= NO_NIN_FACILITY_DAILY_ALERT) {
      // An alert for operations; never a name, phone or Health ID.
      this.logger.warn(`identity.registration.without_nin.facility_daily_high facility=${context.facilityId} `
        + `count=${row.facility_daily_count} correlation=${context.correlationId}`);
    }
    const registered = row.case_status === 'approved_new_identity';
    return {
      caseId: row.case_id,
      status: row.case_status,
      version: Number(row.case_version),
      outcome: registered ? 'registered' : 'sent_for_review',
      message: registered ? WITHOUT_NIN_MESSAGES.registered : WITHOUT_NIN_MESSAGES.sentForReview,
      identityEvidence: 'none',
      ninStatus: 'not_verified',
      replayed: row.replayed === true,
      ...(registered && row.subject_patient_id && row.subject_hid_code
        ? { patient: { patientId: row.subject_patient_id, hid: row.subject_hid_code } } : {}),
    };
  }

  /** Whether the case at this facility was registered without a NIN (null when there is no such case here). */
  async evidenceOf(caseId: string, context: DataAccessContext): Promise<'none' | 'nin_verified' | null> {
    return this.database.withTransaction(context, async (client) => {
      const result = await client.query<{ identity_evidence: 'none' | 'nin_verified' }>(
        `select registration.identity_evidence from identity.registration_cases registration
          where registration.id = $1 and registration.facility_id = platform.current_facility_id()`,
        [caseId]);
      return result.rows[0]?.identity_evidence ?? null;
    }, { readOnly: true });
  }

  async review(caseId: string, decision: WithoutNinDecision, input: { expectedVersion: number; reason: string; patientId?: string },
    idempotencyHeader: string | undefined, context: DataAccessContext): Promise<ReviewedWithoutNin> {
    const idempotencyKey = requireIdempotencyKey(idempotencyHeader);
    const requestSha256 = requestDigest('identity.registration.without-nin.review', {
      caseId, decision, expectedVersion: input.expectedVersion, reason: input.reason, patientId: input.patientId ?? null,
    });
    let row: ReviewRow;
    try {
      row = await this.hidGenerator.reserve<ReviewRow>(async (candidateHid) => {
        try {
          const result = await this.database.withTransaction(context, async (client) => (await client.query<ReviewRow>(
            `select case_id::text, case_status, case_version::text, subject_patient_id::text, subject_hid_code,
                    candidate_count, replayed
               from identity.review_patient_without_nin($1::uuid, $2::bigint, $3, $4::uuid, $5, $6, $7, $8)`,
            [caseId, input.expectedVersion, decision, input.patientId ?? null, input.reason, idempotencyKey,
              requestSha256, decision === 'create_new' ? candidateHid : null],
          )).rows[0]);
          if (!result) throw new DomainProblem(503, 'REGISTRATION_WITHOUT_NIN_UNAVAILABLE', 'Registration is not available right now. Try again.');
          return { reserved: true as const, result };
        } catch (error) {
          if (isHidCollision(error)) return { reserved: false as const };
          throw error;
        }
      });
    } catch (error) {
      const problem = this.translateReview(error);
      if (problem instanceof DomainProblem) {
        await this.auditRefusal(context, 'identity.registration.without-nin.review', problem.code, caseId);
      }
      throw problem;
    }
    return {
      caseId: row.case_id,
      status: row.case_status,
      version: Number(row.case_version),
      identityEvidence: 'none',
      ninStatus: 'not_verified',
      replayed: row.replayed === true,
      ...(row.subject_patient_id && row.subject_hid_code
        ? { patient: { patientId: row.subject_patient_id, hid: row.subject_hid_code } } : {}),
    };
  }

  private translateRegister(error: unknown): unknown {
    if (error instanceof DomainProblem || !isDatabaseError(error)) return error;
    switch (error.message) {
      case 'NO_NIN_REGISTRATION_DENIED':
        return new DomainProblem(403, 'REGISTRATION_WITHOUT_NIN_DENIED', WITHOUT_NIN_MESSAGES.denied);
      case 'NO_NIN_REGISTRATION_SEALED_FACILITY':
        return new DomainProblem(403, 'REGISTRATION_WITHOUT_NIN_NOT_AVAILABLE', WITHOUT_NIN_MESSAGES.sealed);
      case 'NO_NIN_REGISTRATION_PHONE_REQUIRED':
        return new DomainProblem(400, 'PHONE_REQUIRED', WITHOUT_NIN_MESSAGES.phoneRequired);
      case 'NO_NIN_REGISTRATION_NOT_A_CHILD':
        return new DomainProblem(400, 'NOT_A_CHILD', WITHOUT_NIN_MESSAGES.notAChild);
      case 'NO_NIN_REGISTRATION_INVALID':
        return new DomainProblem(400, 'REGISTRATION_WITHOUT_NIN_INVALID', WITHOUT_NIN_MESSAGES.invalid);
      case 'IDEMPOTENCY_KEY_REUSED':
        return new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED', WITHOUT_NIN_MESSAGES.keyReused);
      case 'PATIENT_RECORD_UNKNOWN':
        return new DomainProblem(409, 'PATIENT_RECORD_UNKNOWN', WITHOUT_NIN_MESSAGES.statedUnknownRecord);
      default:
        return error;
    }
  }

  private translateReview(error: unknown): unknown {
    if (error instanceof DomainProblem || !isDatabaseError(error)) return error;
    switch (error.message) {
      case 'NO_NIN_REVIEW_DENIED':
        return new DomainProblem(403, 'REGISTRATION_REVIEW_DENIED', WITHOUT_NIN_MESSAGES.reviewDenied);
      case 'NO_NIN_REVIEW_SECOND_PERSON':
        return new DomainProblem(403, 'REGISTRATION_REVIEW_SECOND_PERSON_REQUIRED', WITHOUT_NIN_MESSAGES.secondPerson);
      case 'NO_NIN_REVIEW_INVALID':
        return new DomainProblem(400, 'REGISTRATION_REVIEW_INVALID', WITHOUT_NIN_MESSAGES.invalid);
      case 'REGISTRATION_CASE_NOT_FOUND':
        return new DomainProblem(404, 'REGISTRATION_CASE_NOT_FOUND', WITHOUT_NIN_MESSAGES.notFound);
      case 'NO_NIN_REVIEW_NOT_AWAITING':
        return new DomainProblem(409, 'REGISTRATION_CASE_ALREADY_DECIDED', WITHOUT_NIN_MESSAGES.notAwaiting);
      case 'NO_NIN_REVIEW_NOT_WITHOUT_NIN':
        return new DomainProblem(409, 'REGISTRATION_CASE_HAS_NIN', WITHOUT_NIN_MESSAGES.notWithoutNin);
      case 'VERSION_CONFLICT':
        return new DomainProblem(412, 'VERSION_CONFLICT', WITHOUT_NIN_MESSAGES.versionConflict);
      case 'PATIENT_NOT_A_REVIEW_CANDIDATE':
        return new DomainProblem(409, 'PATIENT_NOT_A_REVIEW_CANDIDATE', WITHOUT_NIN_MESSAGES.notCandidate);
      case 'PATIENT_RECORD_UNKNOWN':
        return new DomainProblem(409, 'PATIENT_RECORD_UNKNOWN', WITHOUT_NIN_MESSAGES.linkUnknownRecord);
      case 'IDEMPOTENCY_KEY_REUSED':
        return new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED', WITHOUT_NIN_MESSAGES.keyReused);
      default:
        return error;
    }
  }

  /** A refusal answered before or by the database (whose own audit row rolled back with it). */
  private auditRefusal(context: DataAccessContext, action: string, code: string, caseId?: string): Promise<void> {
    return this.audit.record({
      correlationId: context.correlationId,
      actorType: 'staff',
      actorSubject: context.actor.subject,
      actorAccountId: context.actor.accountId,
      actorMembershipId: context.membershipId,
      organizationId: context.actor.facility?.organizationId,
      facilityId: context.facilityId,
      action,
      resourceType: 'registration-case',
      ...(caseId ? { resourceId: caseId } : {}),
      outcome: 'denied',
      purposeOfUse: context.purposeOfUse,
      details: { code },
    });
  }
}

function isDatabaseError(value: unknown): value is { code: string; message: string } {
  return typeof value === 'object' && value !== null
    && typeof (value as { code?: unknown }).code === 'string'
    && typeof (value as { message?: unknown }).message === 'string';
}

function isHidCollision(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === '23505'
    && (error as { constraint?: unknown }).constraint === 'patients_hid_code_ci_uq';
}
