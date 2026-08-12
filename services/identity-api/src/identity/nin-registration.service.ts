import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { requestDigest, requireIdempotencyKey } from '../common/idempotency';
import { DatabaseService } from '../database/database.service';
import { HidCodeGenerator } from './hid-code-generator.service';
import { NinIdentifierProtector, type ProtectedNin } from './nin-identifier-protector';
import { assertSafeNinVerificationResult } from './nin-verification.provider';
import { NIN_VERIFICATION_PROVIDER, type NinClaimedDemographics, type NinVerificationProvider } from './nin.types';
import type { ApproveRegistrationCaseDto } from './dto/approve-registration-case.dto';
import type { LinkRegistrationCaseDto } from './dto/link-registration-case.dto';
import type { ResolveNinDto } from './dto/resolve-nin.dto';

type RegistrationStatus =
  | 'pending_new_identity_approval'
  | 'review_required'
  | 'resolved_existing_identity'
  | 'linked_existing'
  | 'approved_new_identity'
  | 'rejected'
  | 'cancelled';

interface RegistrationCaseRow extends QueryResultRow {
  id: string;
  status: RegistrationStatus;
  row_version: string;
  resolved_patient_id: string | null;
  resolved_hid_code: string | null;
  candidate_count: string;
}

export interface CandidateRow extends QueryResultRow {
  id: string;
  first_name: string;
  last_name: string;
  full_name: string;
  dob: string | null;
}

interface CaseDataRow extends RegistrationCaseRow {
  facility_id: string;
  first_name: string;
  last_name: string;
  full_name: string;
  dob: string;
  gender: string | null;
  nin_ciphertext: Buffer;
  nin_lookup_hmac: string;
  nin_last4: string;
  nin_key_version: string;
  verification_provider: string;
  verification_reference: string;
  verified_at: Date;
  review_idempotency_key: string | null;
  review_request_sha256: string | null;
}

export interface RegistrationCaseResult {
  caseId: string;
  status: RegistrationStatus;
  version: number;
  candidateCount: number;
  patient?: { patientId: string; hid: string };
}

const CASE_SELECT = `
  select
    registration.id::text,
    registration.status,
    registration.row_version::text,
    registration.resolved_patient_id::text,
    patient.hid_code as resolved_hid_code,
    (select count(*)::text from identity.registration_case_candidates candidate where candidate.case_id = registration.id) as candidate_count
  from identity.registration_cases registration
  left join identity.patients patient on patient.id = registration.resolved_patient_id
`;

@Injectable()
export class NinRegistrationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly protector: NinIdentifierProtector,
    private readonly hidGenerator: HidCodeGenerator,
    @Inject(NIN_VERIFICATION_PROVIDER) private readonly provider: NinVerificationProvider,
  ) {}

  async resolve(input: ResolveNinDto, idempotencyHeader: string | undefined, context: DataAccessContext): Promise<RegistrationCaseResult> {
    const idempotencyKey = requireIdempotencyKey(idempotencyHeader);
    let ninLookupHmac: string;
    try {
      ninLookupHmac = this.protector.lookup(input.nin);
    } catch (error) {
      await this.auditFailure(context, 'identity.nin.protect', error);
      throw error;
    }
    const requestSha256 = ninResolutionRequestDigest(input, ninLookupHmac);
    const replay = await this.database.withTransaction(context, async (client) => {
      const row = await this.findByIdempotency(client, context, idempotencyKey, requestSha256);
      return row ? this.auditAndProject(client, context, row, 'identity.nin.resolve.replay') : null;
    });
    if (replay) return replay;
    const claimedDemographics: NinClaimedDemographics = {
      firstName: input.firstName,
      lastName: input.lastName,
      dateOfBirth: input.dateOfBirth,
      ...(input.gender ? { gender: input.gender } : {}),
    };

    let verification;
    try {
      verification = await this.provider.verify({
        nin: input.nin,
        claimedDemographics,
        correlationId: context.correlationId,
      });
      assertSafeNinVerificationResult(verification, this.provider.name, input.nin);
    } catch (error) {
      await this.auditFailure(context, 'identity.nin.verify', error);
      throw error;
    }
    if (!verification.verified) {
      await this.audit.record({
        correlationId: context.correlationId,
        actorType: 'staff',
        actorSubject: context.actor.subject,
        actorAccountId: context.actor.accountId,
        actorMembershipId: context.membershipId,
        organizationId: context.actor.facility?.organizationId,
        facilityId: context.facilityId,
        action: 'identity.nin.verify',
        resourceType: 'registration-case',
        outcome: 'denied',
        purposeOfUse: context.purposeOfUse,
        details: { provider: verification.provider },
      });
      throw new DomainProblem(422, 'NIN_VERIFICATION_FAILED', 'The NIN could not be verified');
    }

    const caseId = randomUUID();
    let protectedNin: ProtectedNin;
    try {
      protectedNin = this.protector.protect(input.nin, caseId);
    } catch (error) {
      await this.auditFailure(context, 'identity.nin.protect', error);
      throw error;
    }
    if (protectedNin.lookupHmac !== ninLookupHmac) {
      throw new DomainProblem(503, 'NIN_PROTECTION_UNAVAILABLE', 'NIN protection lookup is inconsistent');
    }
    try {
      return await this.database.withTransaction(context, async (client) => {
      const replay = await this.findByIdempotency(client, context, idempotencyKey, requestSha256);
      if (replay) return this.auditAndProject(client, context, replay, 'identity.nin.resolve.replay');

      const existing = await client.query<{
        patient_id: string;
        hid_code: string;
      }>(
        `select patient.id::text as patient_id, patient.hid_code
           from identity.patient_identifiers identifier
           join identity.patients patient on patient.id = identifier.patient_id
          where identifier.identifier_type = 'nin'
            and identifier.lookup_hmac = $1
            and identifier.verified
            and identifier.revoked_at is null
            and patient.status = 'active'
          limit 1`,
        [protectedNin.lookupHmac],
      );
      const existingPatient = existing.rows[0];
      const candidates = existingPatient ? [] : await this.findCandidates(client, verification.demographics);
      const status: RegistrationStatus = existingPatient
        ? 'resolved_existing_identity'
        : candidates.length > 0 ? 'review_required' : 'pending_new_identity_approval';
      const inserted = await client.query<{ id: string }>(
        `insert into identity.registration_cases (
           id, facility_id, created_by_account_id, created_by_membership_id,
           status, first_name, last_name, full_name, dob, gender,
           nin_ciphertext, nin_lookup_hmac, nin_last4, nin_key_version,
           verification_provider, verification_reference, verified_at,
           idempotency_key, request_sha256, resolved_patient_id
         ) values (
           $1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10,
           $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
         ) returning id::text`,
        [
          caseId,
          context.facilityId,
          context.actor.accountId,
          context.membershipId,
          status,
          verification.demographics.firstName,
          verification.demographics.lastName,
          `${verification.demographics.firstName} ${verification.demographics.lastName}`.trim(),
          verification.demographics.dateOfBirth,
          verification.demographics.gender ?? null,
          protectedNin.ciphertext,
          protectedNin.lookupHmac,
          protectedNin.last4,
          protectedNin.keyVersion,
          verification.provider,
          verification.reference,
          verification.verifiedAt,
          idempotencyKey,
          requestSha256,
          existingPatient?.patient_id ?? null,
        ],
      );
      if (!inserted.rows[0]) throw new DomainProblem(503, 'REGISTRATION_CASE_NOT_CREATED', 'The registration case could not be created');
      for (const candidate of candidates) {
        await client.query(
          `insert into identity.registration_case_candidates (case_id, patient_id, match_score, match_reasons)
           values ($1, $2, $3, $4::jsonb)`,
          [caseId, candidate.patientId, candidate.score, JSON.stringify(candidate.reasons)],
        );
      }
      await client.query(
        `insert into identity.registration_case_events (
           case_id, event_type, actor_account_id, actor_membership_id,
           facility_id, patient_id, details
         ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          caseId,
          existingPatient ? 'verified_existing' : status,
          context.actor.accountId,
          context.membershipId,
          context.facilityId,
          existingPatient?.patient_id ?? null,
          JSON.stringify({ provider: verification.provider, candidateCount: candidates.length }),
        ],
      );
      if (existingPatient) {
        await this.outbox(client, 'PatientIdentityResolved', caseId, 1,
          existingPatient.patient_id, context, { resolution: 'verified-existing' });
      }
      await this.audit.recordWithClient(client, {
        correlationId: context.correlationId,
        actorType: 'staff',
        actorSubject: context.actor.subject,
        actorAccountId: context.actor.accountId,
        actorMembershipId: context.membershipId,
        organizationId: context.actor.facility?.organizationId,
        facilityId: context.facilityId,
        patientId: existingPatient?.patient_id,
        action: 'identity.nin.resolve',
        resourceType: 'registration-case',
        resourceId: caseId,
        outcome: 'success',
        purposeOfUse: context.purposeOfUse,
        details: {
          provider: verification.provider,
          status,
          candidateCount: candidates.length,
          matchedExistingIdentity: Boolean(existingPatient),
        },
      });
      const row = await this.loadCase(client, caseId);
      return this.project(row);
      });
    } catch (error) {
      if (isConstraintViolation(error, 'registration_cases_facility_id_created_by_account_id_idempotency_key_key')) {
        return this.database.withTransaction(context, async (client) => {
          const concurrentReplay = await this.findByIdempotency(client, context, idempotencyKey, requestSha256);
          if (!concurrentReplay) throw error;
          return this.auditAndProject(client, context, concurrentReplay, 'identity.nin.resolve.replay');
        });
      }
      if (isConstraintViolation(error, 'registration_cases_active_nin_uq')) {
        throw new DomainProblem(409, 'NIN_REGISTRATION_IN_PROGRESS', 'This verified identity is already in a governed registration workflow');
      }
      throw error;
    }
  }

  async getCase(caseId: string, context: DataAccessContext): Promise<RegistrationCaseResult> {
    return this.database.withTransaction(context, async (client) => {
      const row = await this.loadCase(client, caseId);
      await this.audit.recordWithClient(client, {
        correlationId: context.correlationId,
        actorType: 'staff',
        actorSubject: context.actor.subject,
        actorAccountId: context.actor.accountId,
        actorMembershipId: context.membershipId,
        organizationId: context.actor.facility?.organizationId,
        facilityId: context.facilityId,
        action: 'identity.registration-case.read',
        resourceType: 'registration-case',
        resourceId: caseId,
        outcome: 'success',
        purposeOfUse: context.purposeOfUse,
        details: { status: row.status },
      });
      return this.project(row);
    });
  }

  async approveNew(caseId: string, input: ApproveRegistrationCaseDto, idempotencyHeader: string | undefined, context: DataAccessContext): Promise<RegistrationCaseResult> {
    const idempotencyKey = requireIdempotencyKey(idempotencyHeader);
    const requestSha256 = requestDigest('identity.registration-case.approve-new', { caseId, input });
    return this.hidGenerator.reserve<RegistrationCaseResult>(async (candidateHid) => {
      try {
        const result: RegistrationCaseResult = await this.database.withTransaction(context, async (client) => {
          const row = await this.loadCaseForUpdate(client, caseId);
          if (row.status === 'approved_new_identity') {
            this.assertReviewReplay(row, idempotencyKey, requestSha256, 'approved_new_identity');
            return this.auditAndProject(client, context, row, 'identity.registration-case.approve-new.replay');
          }
          this.assertCaseVersion(row, input.expectedVersion);
          if (row.status !== 'pending_new_identity_approval') {
            throw new ConflictException('This registration case is not awaiting new-identity approval');
          }
          const existing = await client.query('select 1 from identity.patient_identifiers where identifier_type = \'nin\' and lookup_hmac = $1 and verified and revoked_at is null limit 1', [row.nin_lookup_hmac]);
          if ((existing.rowCount ?? 0) > 0) throw new ConflictException('This NIN is already linked to a canonical patient');
          const patientId = randomUUID();
          await client.query(
            `insert into identity.patients (id, hid_code, first_name, last_name, full_name, dob, gender, status, source_system)
             values ($1, $2, $3, $4, $5, $6::date, $7, 'active', 'hid-nin-registration')`,
            [patientId, candidateHid, row.first_name, row.last_name, row.full_name, row.dob, row.gender],
          );
          await client.query(
            `insert into identity.patient_identifiers (
               id, patient_id, identifier_type, value_ciphertext, lookup_hmac,
               encryption_key_version, display_hint, verified, verified_at,
               verification_provider, verification_reference, registration_case_id
             ) values ($1, $2, 'nin', $3, $4, $5, $6, true, $7, $8, $9, $10)`,
            [randomUUID(), patientId, row.nin_ciphertext, row.nin_lookup_hmac, row.nin_key_version, `****${row.nin_last4}`, row.verified_at, row.verification_provider, row.verification_reference, caseId],
          );
          await client.query(
            `update identity.registration_cases
                set status = 'approved_new_identity', resolved_patient_id = $1,
                    reviewed_by_account_id = $2, reviewed_by_membership_id = $3,
                    review_reason = $4, review_idempotency_key = $5, review_request_sha256 = $6,
                    row_version = row_version + 1, updated_at = clock_timestamp()
              where id = $7`,
            [patientId, context.actor.accountId, context.membershipId, input.reason, idempotencyKey, requestSha256, caseId],
          );
          await client.query(
            `insert into identity.registration_case_events (
               case_id, event_type, actor_account_id, actor_membership_id,
               facility_id, patient_id, reason
             ) values ($1, 'approved_new_identity', $2, $3, $4, $5, $6)`,
            [caseId, context.actor.accountId, context.membershipId, context.facilityId, patientId, input.reason],
          );
          await this.outbox(client, 'PatientRegistered', caseId, 2, patientId, context,
            { source: 'governed-nin-registration' });
          await this.outbox(client, 'PatientIdentifierAdded', caseId, 2, patientId, context,
            { identifierType: 'nin', verified: true });
          await this.audit.recordWithClient(client, {
            correlationId: context.correlationId,
            actorType: 'staff',
            actorSubject: context.actor.subject,
            actorAccountId: context.actor.accountId,
            actorMembershipId: context.membershipId,
            organizationId: context.actor.facility?.organizationId,
            facilityId: context.facilityId,
            patientId,
            action: 'identity.registration-case.approve-new',
            resourceType: 'registration-case',
            resourceId: caseId,
            outcome: 'success',
            purposeOfUse: context.purposeOfUse,
            details: { status: 'approved_new_identity' },
          });
          return this.project(await this.loadCase(client, caseId));
        });
        return { reserved: true as const, result };
      } catch (error) {
        if (isHidCollision(error)) return { reserved: false as const };
        if (isConstraintViolation(error, 'patient_identifiers_lookup_uq')) {
          throw new DomainProblem(409, 'NIN_ALREADY_LINKED', 'This verified identity is already linked to a canonical patient');
        }
        throw error;
      }
    });
  }

  async linkExisting(caseId: string, input: LinkRegistrationCaseDto, idempotencyHeader: string | undefined, context: DataAccessContext): Promise<RegistrationCaseResult> {
    const idempotencyKey = requireIdempotencyKey(idempotencyHeader);
    const requestSha256 = requestDigest('identity.registration-case.link-existing', { caseId, input });
    try {
      return await this.database.withTransaction(context, async (client) => {
        const row = await this.loadCaseForUpdate(client, caseId);
        if (row.status === 'linked_existing') {
          this.assertReviewReplay(row, idempotencyKey, requestSha256, 'linked_existing');
          return this.auditAndProject(client, context, row, 'identity.registration-case.link-existing.replay');
        }
        this.assertCaseVersion(row, input.expectedVersion);
        if (row.status !== 'review_required') throw new ConflictException('This registration case is not awaiting duplicate review');
        const candidate = await client.query(
          `select 1 from identity.registration_case_candidates where case_id = $1 and patient_id = $2 limit 1`,
          [caseId, input.patientId],
        );
        if ((candidate.rowCount ?? 0) === 0) throw new DomainProblem(409, 'PATIENT_NOT_A_REVIEW_CANDIDATE', 'The selected patient was not a reviewed candidate');
        const existing = await client.query('select 1 from identity.patient_identifiers where identifier_type = \'nin\' and lookup_hmac = $1 and verified and revoked_at is null limit 1', [row.nin_lookup_hmac]);
        if ((existing.rowCount ?? 0) > 0) throw new ConflictException('This NIN is already linked to a canonical patient');
        await client.query(
          `insert into identity.patient_identifiers (
             id, patient_id, identifier_type, value_ciphertext, lookup_hmac,
             encryption_key_version, display_hint, verified, verified_at,
             verification_provider, verification_reference, registration_case_id
           ) values ($1, $2, 'nin', $3, $4, $5, $6, true, $7, $8, $9, $10)`,
          [randomUUID(), input.patientId, row.nin_ciphertext, row.nin_lookup_hmac, row.nin_key_version, `****${row.nin_last4}`, row.verified_at, row.verification_provider, row.verification_reference, caseId],
        );
        await client.query(
          `update identity.registration_cases
              set status = 'linked_existing', resolved_patient_id = $1,
                  reviewed_by_account_id = $2, reviewed_by_membership_id = $3,
                  review_reason = $4, review_idempotency_key = $5, review_request_sha256 = $6,
                  row_version = row_version + 1, updated_at = clock_timestamp()
            where id = $7`,
          [input.patientId, context.actor.accountId, context.membershipId, input.reason, idempotencyKey, requestSha256, caseId],
        );
        await client.query(
          `insert into identity.registration_case_events (
             case_id, event_type, actor_account_id, actor_membership_id,
             facility_id, patient_id, reason
           ) values ($1, 'linked_existing', $2, $3, $4, $5, $6)`,
          [caseId, context.actor.accountId, context.membershipId, context.facilityId, input.patientId, input.reason],
        );
        await this.outbox(client, 'PatientIdentifierAdded', caseId, 2, input.patientId, context,
          { identifierType: 'nin', verified: true });
        await this.outbox(client, 'PatientIdentityResolved', caseId, 2, input.patientId, context,
          { resolution: 'reviewed-existing' });
        await this.audit.recordWithClient(client, {
          correlationId: context.correlationId,
          actorType: 'staff',
          actorSubject: context.actor.subject,
          actorAccountId: context.actor.accountId,
          actorMembershipId: context.membershipId,
          organizationId: context.actor.facility?.organizationId,
          facilityId: context.facilityId,
          patientId: input.patientId,
          action: 'identity.registration-case.link-existing',
          resourceType: 'registration-case',
          resourceId: caseId,
          outcome: 'success',
          purposeOfUse: context.purposeOfUse,
          details: { status: 'linked_existing' },
        });
        return this.project(await this.loadCase(client, caseId));
      });
    } catch (error) {
      if (isConstraintViolation(error, 'patient_identifiers_lookup_uq')) {
        throw new DomainProblem(409, 'NIN_ALREADY_LINKED', 'This verified identity is already linked to a canonical patient');
      }
      throw error;
    }
  }

  private outbox(
    client: PoolClient,
    eventType: 'PatientRegistered' | 'PatientIdentifierAdded' | 'PatientIdentityResolved',
    aggregateId: string,
    aggregateVersion: number,
    patientId: string,
    context: DataAccessContext,
    payload: Readonly<Record<string, unknown>>,
  ) {
    return client.query(
      `insert into identity.outbox_events (
         event_type, aggregate_id, aggregate_version, facility_id,
         patient_id, correlation_id, payload
       ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [eventType, aggregateId, aggregateVersion, context.facilityId,
        patientId, context.correlationId, JSON.stringify(payload)],
    );
  }

  private async findCandidates(client: PoolClient, demographics: NinClaimedDemographics) {
    const result = await client.query<CandidateRow>(
      `select id::text, first_name, last_name, full_name, dob::text
         from identity.patients
        where status = 'active'
          and (dob = $1::date or lower(first_name) = lower($2) or lower(last_name) = lower($3))
        order by created_at asc
        limit 100`,
      [demographics.dateOfBirth, demographics.firstName, demographics.lastName],
    );
    return rankCandidates(result.rows, demographics);
  }

  private async findByIdempotency(client: PoolClient, context: DataAccessContext, key: string, digest: string) {
    const result = await client.query<RegistrationCaseRow>(
      `${CASE_SELECT}
       where registration.facility_id = $1
         and registration.created_by_account_id = $2
         and registration.idempotency_key = $3
       limit 1`,
      [context.facilityId, context.actor.accountId, key],
    );
    const row = result.rows[0];
    if (!row) return null;
    const digestResult = await client.query<{ request_sha256: string }>(
      `select request_sha256 from identity.registration_cases where id = $1`,
      [row.id],
    );
    if (digestResult.rows[0]?.request_sha256 !== digest) {
      throw new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request');
    }
    return row;
  }

  private async loadCase(client: PoolClient, caseId: string): Promise<RegistrationCaseRow> {
    const result = await client.query<RegistrationCaseRow>(
      `${CASE_SELECT}
       where registration.id = $1 and registration.facility_id = platform.current_facility_id()
       limit 1`,
      [caseId],
    );
    const row = result.rows[0];
    if (!row) throw new DomainProblem(404, 'REGISTRATION_CASE_NOT_FOUND', 'The registration case was not found');
    return row;
  }

  private async loadCaseForUpdate(client: PoolClient, caseId: string): Promise<CaseDataRow> {
    const result = await client.query<CaseDataRow>(
      `select registration.id::text, registration.status, registration.row_version::text,
              registration.resolved_patient_id::text, patient.hid_code as resolved_hid_code,
              registration.facility_id::text, registration.first_name, registration.last_name,
              registration.full_name, registration.dob::text, registration.gender,
              registration.nin_ciphertext, registration.nin_lookup_hmac, registration.nin_last4,
              registration.nin_key_version, registration.verification_provider,
              registration.verification_reference, registration.verified_at,
              registration.review_idempotency_key, registration.review_request_sha256,
              (select count(*)::text from identity.registration_case_candidates candidate where candidate.case_id = registration.id) as candidate_count
         from identity.registration_cases registration
         left join identity.patients patient on patient.id = registration.resolved_patient_id
        where registration.id = $1 and registration.facility_id = platform.current_facility_id()
        for update`,
      [caseId],
    );
    const row = result.rows[0];
    if (!row) throw new DomainProblem(404, 'REGISTRATION_CASE_NOT_FOUND', 'The registration case was not found');
    return row;
  }

  private assertCaseVersion(row: CaseDataRow, expectedVersion: number) {
    if (Number(row.row_version) !== expectedVersion) {
      throw new DomainProblem(412, 'VERSION_CONFLICT', 'The registration case has changed; reload before reviewing it');
    }
  }

  private assertReviewReplay(
    row: CaseDataRow,
    idempotencyKey: string,
    requestSha256: string,
    expectedStatus: 'approved_new_identity' | 'linked_existing',
  ) {
    if (row.status !== expectedStatus) {
      throw new ConflictException('This registration case has already completed a different transition');
    }
    if (row.review_idempotency_key !== idempotencyKey) {
      throw new ConflictException('This registration case has already completed; use a new workflow');
    }
    if (row.review_request_sha256 !== requestSha256) {
      throw new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request');
    }
  }

  private project(row: RegistrationCaseRow): RegistrationCaseResult {
    return {
      caseId: row.id,
      status: row.status,
      version: Number(row.row_version),
      candidateCount: Number(row.candidate_count),
      ...(row.resolved_patient_id && row.resolved_hid_code
        ? { patient: { patientId: row.resolved_patient_id, hid: row.resolved_hid_code } }
        : {}),
    };
  }

  private auditAndProject(client: PoolClient, context: DataAccessContext, row: RegistrationCaseRow, action: string) {
    return this.audit.recordWithClient(client, {
      correlationId: context.correlationId,
      actorType: 'staff',
      actorSubject: context.actor.subject,
      actorAccountId: context.actor.accountId,
      actorMembershipId: context.membershipId,
      organizationId: context.actor.facility?.organizationId,
      facilityId: context.facilityId,
      patientId: row.resolved_patient_id ?? undefined,
      action,
      resourceType: 'registration-case',
      resourceId: row.id,
      outcome: 'success',
      purposeOfUse: context.purposeOfUse,
      details: { status: row.status, candidateCount: Number(row.candidate_count) },
    }).then(() => this.project(row));
  }

  private async auditFailure(context: DataAccessContext, action: string, error: unknown) {
    await this.audit.record({
      correlationId: context.correlationId,
      actorType: 'staff',
      actorSubject: context.actor.subject,
      actorAccountId: context.actor.accountId,
      actorMembershipId: context.membershipId,
      organizationId: context.actor.facility?.organizationId,
      facilityId: context.facilityId,
      action,
      resourceType: 'registration-case',
      outcome: 'failure',
      purposeOfUse: context.purposeOfUse,
      details: {
        provider: this.provider.name,
        errorType: error instanceof Error ? error.constructor.name : 'UnknownError',
      },
    });
  }
}

function rankCandidates(rows: readonly CandidateRow[], demographics: NinClaimedDemographics) {
  return rows.map((row) => scoreRegistrationCandidate(row, demographics))
    .filter((candidate) => candidate.score >= 65)
    .sort((left, right) => right.score - left.score)
    .slice(0, 20);
}

export function scoreRegistrationCandidate(row: CandidateRow, demographics: NinClaimedDemographics) {
    const first = similarity(normalizeName(row.first_name), normalizeName(demographics.firstName));
    const last = similarity(normalizeName(row.last_name), normalizeName(demographics.lastName));
    const dob = row.dob === demographics.dateOfBirth;
    const score = Math.round(first * 25 + last * 35 + (dob ? 40 : 0));
    const reasons = [
      ...(dob ? ['date_of_birth'] : []),
      ...(first >= 0.8 ? ['first_name'] : []),
      ...(last >= 0.8 ? ['last_name'] : []),
    ];
    return { patientId: row.id, score, reasons };
}

export function normalizeName(value: string): string {
  return value.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function ninResolutionRequestDigest(input: ResolveNinDto, ninLookupHmac: string): string {
  return requestDigest('identity.nin.resolve', {
    ninLookupHmac,
    firstName: input.firstName,
    lastName: input.lastName,
    dateOfBirth: input.dateOfBirth,
    gender: input.gender ?? null,
    purpose: input.purpose,
  });
}

export function similarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const leftBigrams = new Set<string>();
  for (let index = 0; index < left.length - 1; index += 1) leftBigrams.add(left.slice(index, index + 2));
  const rightBigrams = new Set<string>();
  for (let index = 0; index < right.length - 1; index += 1) rightBigrams.add(right.slice(index, index + 2));
  let intersection = 0;
  for (const value of leftBigrams) if (rightBigrams.has(value)) intersection += 1;
  return (2 * intersection) / (leftBigrams.size + rightBigrams.size || 1);
}

function isHidCollision(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === '23505'
    && (error as { constraint?: unknown }).constraint === 'patients_hid_code_ci_uq';
}

function isConstraintViolation(error: unknown, constraint: string): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === '23505'
    && (error as { constraint?: unknown }).constraint === constraint;
}
