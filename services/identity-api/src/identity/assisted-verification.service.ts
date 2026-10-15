import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { DomainProblem, PublicDetailProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { ASSISTED_REGISTRATION_DISABLED } from './assisted-registration.guard';
import { normalizeDeskCode } from './desk-code';
import type { AssistedVerificationDto } from './dto/assisted-verification.dto';
import { ASSISTED_REGISTRATION_NOT_AUTHORIZED, PatientEnrollmentService } from './patient-enrollment.service';

/** What identity.record_assisted_verification answers (0094). */
interface VerificationRow extends QueryResultRow {
  verification_id: string;
  outcome: 'matched' | 'not_matched' | 'code_not_found';
  first_name_result: string | null;
  last_name_result: string | null;
  date_of_birth_result: string | null;
  enrollment_id: string | null;
  correlation_id: string;
  proof_outcome: 'verified' | 'existing_identity' | null;
  replayed: boolean;
}

/**
 * The in-person check of facility-assisted registration (ADR-063), in this
 * order: the route switch (503), the desk code's form (400), the read of
 * the enrollment the code names and the blind compare (system context), the
 * staff command that records the check (staff context: MFA, permission,
 * attested grant, participating facility, budgets, audit), then, for a
 * match, the holder proof (system context). The typed names, date of birth,
 * desk code and attestations are never stored or logged; the database keeps
 * keyed digests and per-field outcomes only.
 */
@Injectable()
export class AssistedVerificationService {
  constructor(private readonly database: DatabaseService,
    private readonly enrollments: PatientEnrollmentService) {}

  async verify(input: AssistedVerificationDto, idempotencyKey: string, context: DataAccessContext) {
    const environment = getEnvironment();
    if (!environment.ASSISTED_REGISTRATION_ENABLED) {
      throw new PublicDetailProblem(503, 'ASSISTED_REGISTRATION_DISABLED', ASSISTED_REGISTRATION_DISABLED);
    }
    const deskCode = normalizeDeskCode(input.deskCode);
    if (!deskCode) {
      throw new DomainProblem(400, 'DESK_CODE_INVALID',
        'Enter the 10-character desk code shown on the patient\'s phone.');
    }
    const document = { firstName: input.document.firstName, lastName: input.document.lastName,
      ...(typeof input.document.dateOfBirth === 'string' ? { dateOfBirth: input.document.dateOfBirth } : {}) };
    // The canonical request: the normalized desk code and every field, in a fixed order.
    const canonical = JSON.stringify({ deskCode, method: input.method, documentType: input.documentType,
      document: { firstName: document.firstName, lastName: document.lastName, dateOfBirth: document.dateOfBirth ?? null },
      attestations: { patientPresent: input.attestations.patientPresent,
        originalDocumentSeen: input.attestations.originalDocumentSeen,
        photoMatchesPerson: input.attestations.photoMatchesPerson,
        codeShownOnPatientsOwnDevice: input.attestations.codeShownOnPatientsOwnDevice,
        patientConsents: input.attestations.patientConsents } });
    const digests = this.enrollments.assistedRequestDigests(idempotencyKey, canonical);
    const lookup = await this.enrollments.deskLookup(deskCode, document, context.correlationId);
    const enrollment = lookup.enrollment;
    const outcome = !enrollment ? 'code_not_found' : enrollment.result.matched ? 'matched' : 'not_matched';
    let row: VerificationRow;
    try {
      const recorded = await this.database.withTransaction(context, (client) => client.query<VerificationRow>(
        'select * from identity.record_assisted_verification($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
        [enrollment?.id ?? null, enrollment?.ninDigest ?? null, lookup.deskCodeHmac, input.method,
          input.documentType, outcome, enrollment?.result.firstName ?? null, enrollment?.result.lastName ?? null,
          enrollment?.result.dateOfBirth ?? null, digests.keyHmac, digests.requestHmac,
          environment.ASSISTED_VERIFICATION_STAFF_DAILY_MAX, environment.ASSISTED_VERIFICATION_FACILITY_DAILY_MAX]));
      const first = recorded.rows[0];
      if (!first) throw this.unavailable();
      row = first;
    } catch (error) {
      throw this.recordError(error);
    }
    // A replay answers what was stored, whatever this request computed.
    switch (row.outcome) {
      case 'code_not_found':
        throw new DomainProblem(404, 'DESK_CODE_NOT_FOUND',
          'No registration is waiting for this desk code. Ask the patient to show the code on their phone again.');
      case 'not_matched':
        throw new DomainProblem(422, 'ASSISTED_VERIFICATION_NOT_MATCHED',
          'The details on the document do not match the NIN record.', undefined, {
            firstName: row.first_name_result ?? 'no_match', lastName: row.last_name_result ?? 'no_match',
            dateOfBirth: row.date_of_birth_result ?? 'no_match' });
      case 'matched':
        break;
      default:
        throw this.unavailable();
    }
    // A matched check whose proof has not been recorded is proved now, a replay's too.
    const proved = row.proof_outcome
      ?? await this.enrollments.proveAtFacility(String(row.enrollment_id), row.verification_id, context.correlationId);
    if (proved === 'existing_identity') {
      throw new DomainProblem(409, 'NIN_ALREADY_REGISTERED',
        'This person already has a Health ID. Direct them to account recovery. If they say they never registered, '
        + `ask Health ID support to review, quoting reference ${row.correlation_id}.`);
    }
    if (proved !== 'verified') throw this.unavailable();
    return { outcome: 'verified' as const };
  }

  private recordError(error: unknown) {
    if (error instanceof DomainProblem) return error;
    const message = error instanceof Error ? error.message : '';
    switch (message) {
      case 'ASSISTED_REGISTRATION_NOT_AUTHORIZED':
        return new DomainProblem(403, 'ASSISTED_REGISTRATION_NOT_AUTHORIZED', ASSISTED_REGISTRATION_NOT_AUTHORIZED);
      case 'ASSISTED_VERIFICATION_LIMITED':
        return new DomainProblem(429, 'ASSISTED_VERIFICATION_LIMITED',
          'The daily limit of in-person checks is reached. Try again later.');
      case 'ASSISTED_VERIFICATION_KEY_REUSED':
        return new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED', 'This retry key belongs to a different request');
      default:
        return this.unavailable();
    }
  }

  private unavailable() {
    return new PublicDetailProblem(503, 'ASSISTED_VERIFICATION_UNAVAILABLE',
      'The in-person check could not be completed. Try again.');
  }
}
