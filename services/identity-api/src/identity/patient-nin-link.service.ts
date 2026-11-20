import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { requestDigest, requireIdempotencyKey } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import type { LinkPatientNinDto } from './dto/link-patient-nin.dto';
import { NinIdentifierProtector } from './nin-identifier-protector';
import { type NinLinkCheck, NinRegistrationService } from './nin-registration.service';
import type { NinClaimedDemographics } from './nin.types';

/**
 * ID-6 (0138, Akos P0-1): verify a NIN later and link it. The desk checks a
 * NIN for this facility's own patient registered without one (ID-2) and, when
 * the NIN record's name (either order) and date of birth are the patient's,
 * attaches it: ID-0's rule then reads "NIN Verified". Nothing else about the
 * patient changes.
 *
 * The order of checks (the planned contract's ID-6): the patient and the
 * facility's basis first, then the patient's own NIN, then the NIN check
 * (the desk's, with every gate: deferred or off, the seals, Q110's record,
 * the breaker, 0137's guard as path 'desk'), and only after a match the NIN
 * on another record. So a NIN that is not this patient's never says whether
 * anyone else holds it, and nothing is charged for a refusal the database
 * can give first. The database decides (identity.patient_nin_link_precheck
 * and identity.link_patient_nin); this service asks QoreID between them and
 * maps each answer to the contract's words.
 *
 * Each answer and each refusal writes one identity.patient.nin-link audit
 * row with the patient, the outcome or refusal kind and whether QoreID was
 * called: the link's own row is written by the database in the link's
 * transaction; every other here. Never the NIN or its HMAC.
 */

export const NIN_LINK_FAILED_MESSAGE = 'This NIN could not be verified. Check the number and try again.';

export interface LinkedPatientNin {
  patientId: string;
  outcome: 'nin_linked' | 'already_linked';
  ninStatus: 'verified';
  message: string;
  replayed: boolean;
}

type Decision = 'not_found' | 'not_permitted' | 'already_linked' | 'has_nin' | 'replay' | 'key_reused' | 'eligible';

interface PrecheckRow extends QueryResultRow {
  decision: Decision;
  first_name: string | null;
  last_name: string | null;
  date_of_birth: string | null;
}

interface LinkRow extends QueryResultRow {
  outcome: 'nin_linked' | 'not_found' | 'not_permitted' | 'already_linked' | 'has_nin' | 'on_another_record'
    | 'replay' | 'key_reused';
  other_patient_id: string | null;
}

/** The refusal kinds an audit row may name (never the NIN). */
type RefusalKind = 'not_found' | 'not_permitted' | 'already_has_nin' | 'no_record' | 'details_mismatch'
  | 'on_another_record' | 'key_reused';

const MESSAGES = {
  nin_linked: 'NIN Verified. It is now on this patient\'s record.',
  already_linked: 'NIN Verified. It is already on this patient\'s record.',
} as const;

@Injectable()
export class PatientNinLinkService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly protector: NinIdentifierProtector,
    private readonly registrations: NinRegistrationService,
  ) {}

  async link(patientId: string, input: LinkPatientNinDto, idempotencyHeader: string | undefined,
    context: DataAccessContext): Promise<LinkedPatientNin> {
    const idempotencyKey = requireIdempotencyKey(idempotencyHeader);
    let lookupHmac: string;
    try {
      lookupHmac = this.protector.lookup(input.nin);
    } catch (error) {
      await this.auditRow(context, patientId, 'failure', { refusal: 'protection_unavailable', qoreidCalled: false });
      throw error;
    }
    const requestSha256 = patientNinLinkDigest(patientId, lookupHmac);
    const precheck = await this.database.withTransaction(context, async (client) => {
      const result = await client.query<PrecheckRow>(
        `select decision, first_name, last_name, date_of_birth::text as date_of_birth
           from identity.patient_nin_link_precheck($1, $2, $3, $4)`,
        [patientId, lookupHmac, idempotencyKey, requestSha256]);
      return result.rows[0];
    });
    if (!precheck) throw new DomainProblem(503, 'DEPENDENCY_UNAVAILABLE', 'Something went wrong on our side. Please try again.');
    switch (precheck.decision) {
      case 'replay':
        return this.answer(patientId, 'nin_linked', true);
      case 'key_reused':
        await this.refuse(context, patientId, 'key_reused', false);
        throw keyReused();
      case 'not_found':
        // Q100 B: one answer for an unknown, inactive or merged patient and
        // one across the seals; the audit row names no patient.
        await this.refuse(context, null, 'not_found', false, patientId);
        throw patientNotFound();
      case 'not_permitted':
        await this.refuse(context, patientId, 'not_permitted', false);
        throw notPermitted();
      case 'has_nin':
        await this.refuse(context, patientId, 'already_has_nin', false);
        throw alreadyHasNin();
      case 'already_linked':
        await this.auditRow(context, patientId, 'success', { outcome: 'already_linked', qoreidCalled: false });
        return this.answer(patientId, 'already_linked', false);
      case 'eligible':
        break;
      default:
        throw new DomainProblem(503, 'DEPENDENCY_UNAVAILABLE', 'Something went wrong on our side. Please try again.');
    }
    if (!precheck.first_name || !precheck.last_name || !precheck.date_of_birth) {
      throw new DomainProblem(503, 'DEPENDENCY_UNAVAILABLE', 'Something went wrong on our side. Please try again.');
    }
    const record: NinClaimedDemographics = {
      firstName: precheck.first_name, lastName: precheck.last_name, dateOfBirth: precheck.date_of_birth,
    };
    // The NIN record's names in the record's order, else (as the patient's
    // own check compares a profile's) the other way round: the second check
    // is answered by what the first kept, never charged again.
    let check: NinLinkCheck = await this.registrations.checkNinForLink(input.nin, lookupHmac, record, context);
    let qoreidCalled = check.providerCalled;
    if (!check.verified && check.outcome === 'name_mismatch'
      && normalizedName(record.firstName) !== normalizedName(record.lastName)) {
      check = await this.registrations.checkNinForLink(input.nin, lookupHmac,
        { firstName: record.lastName, lastName: record.firstName, dateOfBirth: record.dateOfBirth }, context);
      qoreidCalled ||= check.providerCalled;
    }
    if (!check.verified) {
      // Q117: "no record" and "does not match" are one answer, and an
      // answer, not a failure: the breaker has counted it as one.
      await this.refuse(context, patientId, check.outcome === 'name_mismatch' ? 'details_mismatch' : 'no_record',
        qoreidCalled);
      throw ninVerificationFailed();
    }
    if (check.healthIdRecord) {
      // Q110: the NIN is on another Health ID, whose record matched: the two
      // records are probably the same person.
      await this.refuse(context, patientId, 'on_another_record', false, undefined, check.holderPatientId);
      throw onAnotherRecord();
    }
    const reference = check.reference;
    if (!reference) throw new DomainProblem(502, 'QOREID_PROVIDER_RESPONSE_INVALID', 'External verification returned an invalid response');
    const linkId = randomUUID();
    const protectedNin = this.protector.protectLink(input.nin, linkId);
    if (protectedNin.lookupHmac !== lookupHmac) {
      throw new DomainProblem(503, 'NIN_PROTECTION_UNAVAILABLE', 'NIN protection lookup is inconsistent');
    }
    const linked = await this.database.withTransaction(context, async (client) => {
      const result = await client.query<LinkRow>(
        `select outcome, other_patient_id::text as other_patient_id
           from identity.link_patient_nin($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [patientId, linkId, lookupHmac, protectedNin.ciphertext, protectedNin.keyVersion, protectedNin.last4,
          reference, qoreidCalled, idempotencyKey, requestSha256]);
      return result.rows[0];
    });
    switch (linked?.outcome) {
      case 'nin_linked':
        return this.answer(patientId, 'nin_linked', false);
      case 'replay':
        return this.answer(patientId, 'nin_linked', true);
      case 'already_linked':
        await this.auditRow(context, patientId, 'success', { outcome: 'already_linked', qoreidCalled });
        return this.answer(patientId, 'already_linked', false);
      case 'on_another_record':
        await this.refuse(context, patientId, 'on_another_record', qoreidCalled, undefined,
          linked.other_patient_id ?? undefined);
        throw onAnotherRecord();
      case 'key_reused':
        await this.refuse(context, patientId, 'key_reused', qoreidCalled);
        throw keyReused();
      case 'not_found':
        await this.refuse(context, null, 'not_found', qoreidCalled, patientId);
        throw patientNotFound();
      case 'not_permitted':
        await this.refuse(context, patientId, 'not_permitted', qoreidCalled);
        throw notPermitted();
      case 'has_nin':
        await this.refuse(context, patientId, 'already_has_nin', qoreidCalled);
        throw alreadyHasNin();
      default:
        throw new DomainProblem(503, 'DEPENDENCY_UNAVAILABLE', 'Something went wrong on our side. Please try again.');
    }
  }

  private answer(patientId: string, outcome: 'nin_linked' | 'already_linked', replayed: boolean): LinkedPatientNin {
    return { patientId, outcome, ninStatus: 'verified', message: MESSAGES[outcome], replayed };
  }

  private refuse(context: DataAccessContext, patientId: string | null, refusal: RefusalKind, qoreidCalled: boolean,
    requestedPatientId?: string, otherPatientId?: string): Promise<void> {
    return this.auditRow(context, patientId, 'denied', {
      refusal, qoreidCalled, ...(otherPatientId ? { otherPatientId } : {}),
    }, requestedPatientId);
  }

  private async auditRow(context: DataAccessContext, patientId: string | null, outcome: 'success' | 'denied' | 'failure',
    details: Readonly<Record<string, unknown>>, requestedPatientId?: string): Promise<void> {
    await this.audit.record({
      correlationId: context.correlationId,
      actorType: 'staff',
      actorSubject: context.actor.subject,
      actorAccountId: context.actor.accountId,
      actorMembershipId: context.membershipId,
      organizationId: context.actor.facility?.organizationId,
      facilityId: context.facilityId,
      ...(patientId ? { patientId } : {}),
      action: 'identity.patient.nin-link',
      resourceType: 'patient',
      resourceId: patientId ?? requestedPatientId,
      outcome,
      purposeOfUse: context.purposeOfUse,
      details,
    });
  }
}

/** The request's digest: the patient and the NIN's lookup HMAC (never the NIN), and the purpose. */
export function patientNinLinkDigest(patientId: string, ninLookupHmac: string): string {
  return requestDigest('identity.patient.nin-link', { patientId, ninLookupHmac, purpose: 'healthcare-operations' });
}

function normalizedName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleUpperCase('en-NG');
}

function patientNotFound(): DomainProblem {
  return new DomainProblem(404, 'PATIENT_NOT_FOUND', 'No such patient.');
}

function notPermitted(): DomainProblem {
  return new DomainProblem(403, 'NIN_LINK_NOT_PERMITTED', 'You can add a NIN only for this facility\'s own patients.');
}

function alreadyHasNin(): DomainProblem {
  return new DomainProblem(409, 'PATIENT_ALREADY_HAS_NIN', 'This patient already has a verified NIN.');
}

function ninVerificationFailed(): DomainProblem {
  return new DomainProblem(422, 'NIN_VERIFICATION_FAILED', NIN_LINK_FAILED_MESSAGE);
}

function onAnotherRecord(): DomainProblem {
  return new DomainProblem(409, 'NIN_ON_ANOTHER_RECORD',
    'This NIN is already on another patient record. Ask an approver to review the two records.');
}

function keyReused(): DomainProblem {
  return new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different request.');
}
