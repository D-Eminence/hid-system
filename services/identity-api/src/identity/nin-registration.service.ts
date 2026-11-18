import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, Optional } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { requestDigest, requireIdempotencyKey } from '../common/idempotency';
import { DatabaseService } from '../database/database.service';
import { CollectedFieldProtector, registrationCaseContactLabel } from './collected-field-protector';
import { HidCodeGenerator } from './hid-code-generator.service';
import { NinIdentifierProtector, type ProtectedNin } from './nin-identifier-protector';
import { assertSafeNinVerificationResult, implausibleClaimedDemographics, isNinCheckNotStarted,
  isNinCheckRefusedUnsent, isNinNotConfigured, ninCheckNotStarted, ninNotConfigured } from './nin-verification.provider';
import { NIN_VERIFICATION_PROVIDER, type NinCheckReservation, type NinCheckReservationResult,
  type NinClaimedDemographics, type NinVerificationProvider } from './nin.types';
import { NinProviderBreaker } from './nin-provider-breaker';
import { ninStatusOf, patientHasVerifiedNinSql, type NinStatus } from './nin-status';
import type { ApproveRegistrationCaseDto } from './dto/approve-registration-case.dto';
import type { LinkRegistrationCaseDto } from './dto/link-registration-case.dto';
import type { EnrollPatientDto } from './dto/enroll-patient.dto';
import type { ResolveNinDto } from './dto/resolve-nin.dto';
import type { ListRegistrationCasesDto, RegistrationCaseListView } from './dto/list-registration-cases.dto';

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
  contact_recorded?: boolean;
  /** ID-0: see CASE_NIN_VERIFIED. */
  nin_verified?: boolean;
}

/**
 * D13: how the Health ID the patient stated compares with what matching found.
 * 'no_match' covers both "no such Health ID" and "someone else", so nothing
 * recorded tells staff whether a Health ID exists.
 */
type StatedHealthIdOutcome = 'none' | 'matches' | 'no_match';

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
  has_contact: boolean;
}

export interface RegistrationCaseResult {
  caseId: string;
  status: RegistrationStatus;
  version: number;
  candidateCount: number;
  /** 0114: the desk recorded the patient's phone and address (never returned). */
  contactRecorded: boolean;
  /** ID-0: "NIN Verified" or "NIN Not Verified" on screen; never the stored verification value. */
  ninStatus: NinStatus;
  candidates?: Array<{ patientId: string; fullName: string; dateOfBirth: string | null }>;
  patient?: { patientId: string; hid: string };
}

/**
 * ID-0: the case's NIN was checked, and, once the case points at a patient,
 * that patient still holds a checked NIN that has not been revoked.
 */
const CASE_NIN_VERIFIED = `case
      when registration.verified_at is null then false
      when registration.resolved_patient_id is null then true
      else ${patientHasVerifiedNinSql('registration.resolved_patient_id')}
    end as nin_verified`;

/** SX-10: one row of the registration-case list (never NIN digits). */
interface CaseListRow extends RegistrationCaseRow {
  full_name: string;
  dob: string;
  created_at: Date;
  updated_at: Date;
  created_at_cursor: string;
  created_by_me: boolean;
}

export interface RegistrationCaseListItem extends RegistrationCaseResult {
  fullName: string;
  dateOfBirth: string;
  createdAt: string;
  updatedAt: string;
  /** This member started the case. */
  createdByMe: boolean;
}

export interface RegistrationCaseList {
  view: RegistrationCaseListView;
  cases: RegistrationCaseListItem[];
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

const CASE_SELECT = `
  select
    registration.id::text,
    registration.status,
    registration.row_version::text,
    registration.resolved_patient_id::text,
    patient.hid_code as resolved_hid_code,
    (select count(*)::text from identity.registration_case_candidates candidate where candidate.case_id = registration.id) as candidate_count,
    exists (select 1 from identity.registration_case_contacts contact
             where contact.registration_case_id = registration.id and contact.erased_at is null) as contact_recorded,
    ${CASE_NIN_VERIFIED}
  from identity.registration_cases registration
  left join identity.patients patient on patient.id = registration.resolved_patient_id
`;

@Injectable()
export class NinRegistrationService {
  private readonly fieldProtector = new CollectedFieldProtector();

  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly protector: NinIdentifierProtector,
    private readonly hidGenerator: HidCodeGenerator,
    @Inject(NIN_VERIFICATION_PROVIDER) private readonly provider: NinVerificationProvider,
    @Optional() private readonly ninBreaker: NinProviderBreaker = new NinProviderBreaker(),
  ) {}

  async resolve(input: ResolveNinDto, idempotencyHeader: string | undefined, context: DataAccessContext): Promise<RegistrationCaseResult> {
    const idempotencyKey = requireIdempotencyKey(idempotencyHeader);
    if (this.provider.name === 'deferred') {
      const error = new DomainProblem(503, 'NIN_PROVIDER_DEFERRED', 'NIN verification is deferred for this staging environment');
      await this.auditFailure(context, 'identity.nin.verify', error, { providerCalled: false });
      throw error;
    }
    // 0114: the desk's phone and address are stored encrypted; without the
    // key nothing is verified (charged) or written. A body in the old shape
    // (no desk fields, contract 43.0) needs no key.
    const deskFields = deskFieldsOf(input);
    if (deskFields) this.fieldProtector.assertConfigured();
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

    // Q108: details that cannot be anyone's (a date of birth in the future,
    // a name with a control character) are refused before anything is sent
    // or counted. The request body is checked the same way; this covers any
    // other caller. Otherwise a (charged) check would be made, and its
    // answer read as a bad provider answer that trips the breaker.
    if (implausibleClaimedDemographics(claimedDemographics)) {
      const error = new DomainProblem(400, 'NIN_DETAILS_INVALID',
        'Check the name and the date of birth. The date of birth cannot be in the future or before 1900.');
      await this.auditFailure(context, 'identity.nin.verify', error, { providerCalled: false });
      throw error;
    }

    // Q108: a live provider (QoreID) asks its switch for every check: the
    // admin control and its settings, never a cached answer.
    let switchedOn = this.provider.name !== 'unavailable';
    if (switchedOn && this.provider.isEnabled) {
      try {
        switchedOn = await this.provider.isEnabled();
      } catch (error) {
        // The switch could not be read: nothing was sent, the breaker is not
        // touched (this is not the NIN service failing).
        await this.auditFailure(context, 'identity.nin.verify', error, { providerCalled: false });
        throw ninCheckNotStarted();
      }
    }
    if (!switchedOn) {
      // ID-0: NIN checks are switched off here (NIN_PROVIDER_MODE=unavailable,
      // or, Q108, QoreID's switch is off). That is a setting, not an outage:
      // the breaker is not touched, nothing is logged as a failure, and the
      // desk keeps the true message ("NIN verification is not configured").
      // Nothing is sent anywhere.
      const error = ninNotConfigured();
      await this.auditFailure(context, 'identity.nin.verify', error, { providerCalled: false });
      throw error;
    }

    let verification;
    try {
      // ID-0: while the NIN service breaker is tripped, no check is sent.
      this.ninBreaker.assertAvailable();
    } catch (error) {
      // The NIN was not sent to the NIN service; the audit row says so.
      await this.auditFailure(context, 'identity.nin.verify', error, { providerCalled: false, breaker: 'open' });
      throw error;
    }
    const reservation: NinCheckReservation = { correlationId: context.correlationId,
      accountId: context.actor.accountId, facilityId: context.facilityId, idempotencyKey, requestSha256 };
    if (this.provider.reserve) {
      let reserved: NinCheckReservationResult;
      try {
        // Q108: each live check is charged. The same request (Idempotency-Key
        // and body) is checked at most once at a time, and a resend of one
        // already answered gets that answer again, before anything is sent.
        // Q109: no limit per staff account, per facility or across Health ID.
        reserved = await this.provider.reserve(reservation);
      } catch (error) {
        // Not sent: free the breaker's place without counting a failure.
        this.ninBreaker.release();
        await this.auditFailure(context, 'identity.nin.verify', error, { providerCalled: false });
        throw error;
      }
      if (reserved.stored) {
        // Already answered for this request: no new check, nothing charged.
        this.ninBreaker.release();
        throw await this.ninNotVerified(context, this.provider.name, reserved.stored, { providerCalled: false,
          replay: true });
      }
    }
    try {
      verification = await this.provider.verify({
        nin: input.nin,
        claimedDemographics,
        correlationId: context.correlationId,
      });
      assertSafeNinVerificationResult(verification, this.provider.name, input.nin);
    } catch (error) {
      await this.provider.settle?.(reservation, 'not_answered');
      if (isNinNotConfigured(error) || isNinCheckNotStarted(error) || isNinCheckRefusedUnsent(error)) {
        // Q108: switched off, or the switch could not be read, between the
        // switch check and the check; 0137: the once-per-NIN guard refused
        // it (this NIN is being checked or is held, or the guard's store or
        // keys are unavailable). Nothing was sent for this request: not an
        // outage, and the breaker's retry place is freed.
        this.ninBreaker.release();
        await this.auditFailure(context, 'identity.nin.verify', error, { providerCalled: false });
        throw error;
      }
      this.ninBreaker.recordFailure(error, { correlationId: context.correlationId, provider: this.provider.name });
      await this.auditFailure(context, 'identity.nin.verify', error, { providerCalled: true, ninCheck: 'provider_error' });
      throw error;
    }
    this.ninBreaker.recordSuccess();
    if (!verification.verified) {
      const ninCheck = verification.outcome === 'name_mismatch' ? 'name_mismatch' : 'no_match';
      await this.provider.settle?.(reservation, ninCheck);
      throw await this.ninNotVerified(context, verification.provider, ninCheck);
    }
    await this.provider.settle?.(reservation, 'match');
    // Q108: every NIN check is audited on its own, before the case is
    // written, so a charged check that matched is on record even when the
    // case then cannot be created (for example, already in a workflow).
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
      outcome: 'success',
      purposeOfUse: context.purposeOfUse,
      details: { provider: verification.provider, ninCheck: 'match' },
    });

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
    const contact = deskFields ? this.protectContact(caseId, deskFields) : null;
    const statedHid = deskFields?.hasExistingHealthId && input.existingHealthId ? input.existingHealthId : null;
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
      // D13: the stated Health ID is a hint only. It never adds a candidate
      // (that would show staff a patient who gave this facility no consent,
      // and make a typo linkable): it only marks a patient who is already a
      // candidate by name and date of birth, or the verified NIN match.
      let statedOutcome: StatedHealthIdOutcome = 'none';
      if (statedHid) {
        const stated = await this.findStatedPatient(client, statedHid);
        const listed = stated ? candidates.find((candidate) => candidate.patientId === stated) : undefined;
        if (listed) listed.reasons = [...listed.reasons, 'stated_hid'];
        statedOutcome = stated && (listed || stated === existingPatient?.patient_id) ? 'matches' : 'no_match';
      }
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
      if (contact) {
        await client.query(
          `insert into identity.registration_case_contacts (
             registration_case_id, facility_id, phone_ciphertext, address_ciphertext, key_version,
             stated_hid_code, created_by_account_id, created_by_membership_id
           ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [caseId, context.facilityId, contact.phone, contact.address, contact.keyVersion, statedHid,
            context.actor.accountId, context.membershipId],
        );
      }
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
          JSON.stringify({ provider: verification.provider, candidateCount: candidates.length,
            contactRecorded: Boolean(contact), statedHealthId: statedOutcome }),
        ],
      );
      if (existingPatient) {
        if (contact) await this.copyContact(client, caseId, existingPatient.patient_id, context);
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
          ninCheck: 'match',
          status,
          candidateCount: candidates.length,
          matchedExistingIdentity: Boolean(existingPatient),
          contactRecorded: Boolean(contact),
          statedHealthId: statedOutcome,
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
      const candidates = row.status === 'review_required' ? (await client.query<{
        patientId: string; fullName: string; dateOfBirth: string | null;
      }>(`select patient.id::text as "patientId", patient.full_name as "fullName", patient.dob::text as "dateOfBirth"
           from identity.registration_case_candidates candidate
           join identity.patients patient on patient.id = candidate.patient_id
          where candidate.case_id = $1 order by candidate.match_score desc, patient.id limit 50`, [caseId])).rows : [];
      return { ...this.project(row), candidates };
    });
  }

  /**
   * SX-10: the registration cases of this facility, newest first. 'mine' is
   * the cases this member started; 'facility' is every case here and needs
   * identity.registration.approve. No NIN digits are read or returned. The
   * read is audited with the cases and patients shown.
   */
  async listCases(input: ListRegistrationCasesDto, context: DataAccessContext): Promise<RegistrationCaseList> {
    const view: RegistrationCaseListView = input.view ?? 'mine';
    const limit = input.limit ?? 50;
    const auditBase = {
      correlationId: context.correlationId,
      actorType: 'staff' as const,
      actorSubject: context.actor.subject,
      actorAccountId: context.actor.accountId,
      actorMembershipId: context.membershipId,
      organizationId: context.actor.facility?.organizationId,
      facilityId: context.facilityId,
      action: 'identity.registration-case.list',
      resourceType: 'registration-case',
      purposeOfUse: context.purposeOfUse,
    };
    if (view === 'facility' && !context.actor.permissions.includes('identity.registration.approve')) {
      await this.audit.record({ ...auditBase, outcome: 'denied', details: { view } });
      throw new DomainProblem(403, 'REGISTRATION_CASE_LIST_DENIED',
        'Only staff who approve registrations can see every case at this facility.');
    }
    const cursor = input.cursor === undefined ? null : decodeCaseCursor(input.cursor);
    return this.database.withTransaction(context, async (client) => {
      const result = await client.query<CaseListRow>(
        `select
           registration.id::text,
           registration.status,
           registration.row_version::text,
           registration.resolved_patient_id::text,
           patient.hid_code as resolved_hid_code,
           (select count(*)::text from identity.registration_case_candidates candidate
             where candidate.case_id = registration.id) as candidate_count,
           exists (select 1 from identity.registration_case_contacts contact
                    where contact.registration_case_id = registration.id and contact.erased_at is null) as contact_recorded,
           ${CASE_NIN_VERIFIED},
           registration.full_name,
           registration.dob::text as dob,
           registration.created_at,
           registration.updated_at,
           registration.created_at::text as created_at_cursor,
           (registration.created_by_account_id = $2::uuid) as created_by_me
         from identity.registration_cases registration
         left join identity.patients patient on patient.id = registration.resolved_patient_id
        where registration.facility_id = platform.current_facility_id()
          and ($1::text = 'facility' or registration.created_by_account_id = $2::uuid)
          and ($3::text is null or registration.status = $3::text)
          and ($4::timestamptz is null or (registration.created_at, registration.id) < ($4::timestamptz, $5::uuid))
        order by registration.created_at desc, registration.id desc
        limit $6`,
        [view, context.actor.accountId, input.status ?? null, cursor?.createdAt ?? null, cursor?.caseId ?? null, limit + 1],
      );
      const rows = result.rows.slice(0, limit);
      const last = rows[rows.length - 1];
      const nextCursor = result.rows.length > limit && last ? encodeCaseCursor(last.created_at_cursor, last.id) : null;
      const cases = rows.map((row): RegistrationCaseListItem => ({
        ...this.project(row),
        fullName: row.full_name,
        dateOfBirth: row.dob,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
        createdByMe: row.created_by_me === true,
      }));
      await this.audit.recordWithClient(client, {
        ...auditBase,
        outcome: 'success',
        details: {
          view,
          status: input.status ?? null,
          page: cursor ? 'next' : 'first',
          count: cases.length,
          caseIds: cases.map((item) => item.caseId),
          patientIds: [...new Set(cases.flatMap((item) => item.patient ? [item.patient.patientId] : []))],
        },
      });
      return { view, cases, nextCursor };
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
          if (row.has_contact) await this.copyContact(client, caseId, patientId, context);
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

  async enroll(caseId: string, input: EnrollPatientDto, header: string | undefined, context: DataAccessContext) {
    const key = requireIdempotencyKey(header);
    const digest = requestDigest('identity.patient.enroll', { caseId, input });
    try {
      return await this.database.withTransaction(context, async (client) => {
        const row = (await client.query<{ patient_id: string; hid: string; account_id: string; replayed: boolean }>(
          'select * from identity.enroll_registered_patient($1::uuid, $2::bigint, $3, $4, $5, $6::char(64))',
          [caseId, input.expectedVersion, input.email, input.reason, key, digest],
        )).rows[0];
        if (!row) throw new DomainProblem(503, 'PATIENT_ENROLLMENT_UNAVAILABLE', 'Patient enrollment is unavailable');
        return { patientId: row.patient_id, hid: row.hid, contactVerificationRequired: true, replayed: row.replayed };
      });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      if (code === '23505' || code === '23514' || code === '40001') {
        throw new DomainProblem(409, 'PATIENT_ENROLLMENT_CONFLICT', 'Registration or account state changed; review this case before retrying');
      }
      if (code === '42501') throw new DomainProblem(403, 'PATIENT_ENROLLMENT_DENIED', 'Patient enrollment is not authorized');
      if (code === 'P0002') throw new DomainProblem(404, 'REGISTRATION_CASE_NOT_FOUND', 'Registration case was not found');
      throw error;
    }
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
        // A candidate whose only reason is the stated Health ID never passed
        // the name and date-of-birth match, so it is not linkable (D13).
        const candidate = await client.query(
          `select 1 from identity.registration_case_candidates
            where case_id = $1 and patient_id = $2
              and match_reasons <> '["stated_hid"]'::jsonb
            limit 1`,
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
        if (row.has_contact) await this.copyContact(client, caseId, input.patientId, context);
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

  /**
   * 0114 (D10): the phone and the address (addressLine, city, stateCode, lga
   * as JSON) encrypted for this case. Only ciphertext leaves this method; no
   * value goes to an event, the outbox or the audit.
   */
  private protectContact(caseId: string, input: DeskFields) {
    return {
      phone: this.fieldProtector.encrypt(registrationCaseContactLabel(caseId, 'phone'), input.phone),
      address: this.fieldProtector.encrypt(registrationCaseContactLabel(caseId, 'address'), JSON.stringify({
        addressLine: input.addressLine, city: input.city, stateCode: input.stateCode, lga: input.lga,
      })),
      keyVersion: this.fieldProtector.keyVersion,
    };
  }

  /** The active patient with this Health ID, if any (D13). */
  private async findStatedPatient(client: PoolClient, hid: string): Promise<string | null> {
    const found = await client.query<{ id: string }>(
      `select id::text from identity.patients where upper(hid_code) = $1 and status = 'active' limit 1`, [hid]);
    return found.rows[0]?.id ?? null;
  }

  /**
   * 0114: the facility-held, unverified copy of the case's phone and address
   * for the patient the case resolved to (the database checks it is the
   * case's own ciphertext, patient and facility). Same transaction as the
   * resolution.
   */
  private copyContact(client: PoolClient, caseId: string, patientId: string, context: DataAccessContext) {
    return client.query(
      `insert into identity.patient_facility_contacts (
         patient_id, facility_id, registration_case_id, phone_ciphertext, address_ciphertext, key_version,
         created_by_account_id, created_by_membership_id)
       select $1::uuid, contact.facility_id, contact.registration_case_id, contact.phone_ciphertext,
              contact.address_ciphertext, contact.key_version, $3::uuid, $4::uuid
         from identity.registration_case_contacts contact
        where contact.registration_case_id = $2::uuid and contact.erased_at is null`,
      [patientId, caseId, context.actor.accountId, context.membershipId],
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

  /** Audits a NIN that was not verified (denied) and returns the desk's 422. */
  private async ninNotVerified(context: DataAccessContext, provider: string, ninCheck: 'no_match' | 'name_mismatch',
    extra: Record<string, unknown> = {}): Promise<DomainProblem> {
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
      details: { provider, ninCheck, ...extra },
    });
    return new DomainProblem(422, 'NIN_VERIFICATION_FAILED', ninCheck === 'name_mismatch'
      ? 'The name or date of birth does not match the NIN record. Check the spelling and the date of birth.'
      : 'The NIN could not be verified');
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

  /**
   * Locks the case row, then reads it. PostgreSQL refuses FOR UPDATE on the
   * nullable side of the patient join, and the patient row is not changed
   * here, so only the case is locked. The read is a separate statement: under
   * READ COMMITTED it sees a review that committed while this one waited for
   * the lock, including the patient that review created.
   */
  private async loadCaseForUpdate(client: PoolClient, caseId: string): Promise<CaseDataRow> {
    const locked = await client.query(
      `select registration.id from identity.registration_cases registration
        where registration.id = $1 and registration.facility_id = platform.current_facility_id()
        for update`,
      [caseId],
    );
    if (!locked.rows[0]) throw new DomainProblem(404, 'REGISTRATION_CASE_NOT_FOUND', 'The registration case was not found');
    const result = await client.query<CaseDataRow>(
      `select registration.id::text, registration.status, registration.row_version::text,
              registration.resolved_patient_id::text, patient.hid_code as resolved_hid_code,
              registration.facility_id::text, registration.first_name, registration.last_name,
              registration.full_name, registration.dob::text, registration.gender,
              registration.nin_ciphertext, registration.nin_lookup_hmac, registration.nin_last4,
              registration.nin_key_version, registration.verification_provider,
              registration.verification_reference, registration.verified_at,
              registration.review_idempotency_key, registration.review_request_sha256,
              exists (select 1 from identity.registration_case_contacts contact
                       where contact.registration_case_id = registration.id
                         and contact.erased_at is null) as has_contact,
              ${CASE_NIN_VERIFIED},
              (select count(*)::text from identity.registration_case_candidates candidate where candidate.case_id = registration.id) as candidate_count
         from identity.registration_cases registration
         left join identity.patients patient on patient.id = registration.resolved_patient_id
        where registration.id = $1 and registration.facility_id = platform.current_facility_id()`,
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
      contactRecorded: row.contact_recorded === true,
      ninStatus: ninStatusOf(row.nin_verified),
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

  /**
   * `extra.providerCalled` (identity.nin.verify only) answers "was this NIN
   * sent to the NIN service?": false for a refusal before any check was sent
   * (deferred, switched off, or the breaker is tripped), true when the
   * service was asked and the check failed.
   */
  private async auditFailure(context: DataAccessContext, action: string, error: unknown,
    extra: { providerCalled?: boolean; breaker?: 'open'; ninCheck?: 'provider_error' } = {}) {
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
        ...(error instanceof DomainProblem ? { code: error.code } : {}),
        ...extra,
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
    // 0114: the desk's fields, so a retry with other values is a new request.
    // Only when sent, so an old-shape body keeps its digest (contract 43.0).
    ...(deskFieldsOf(input) ? {
      phone: input.phone,
      addressLine: input.addressLine,
      city: input.city,
      stateCode: input.stateCode,
      lga: input.lga,
      hasExistingHealthId: input.hasExistingHealthId,
      existingHealthId: input.hasExistingHealthId ? input.existingHealthId ?? null : null,
    } : {}),
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

const CURSOR_CREATED_AT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;
const CURSOR_CASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** SX-10: the list position after a case, opaque to callers. */
export function encodeCaseCursor(createdAt: string, caseId: string): string {
  return Buffer.from(JSON.stringify([createdAt, caseId]), 'utf8').toString('base64url');
}

export function decodeCaseCursor(cursor: string): { createdAt: string; caseId: string } {
  const invalid = () => new DomainProblem(400, 'REGISTRATION_CASE_CURSOR_INVALID',
    'This page link is not valid. Start again from the first page.');
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (!Array.isArray(decoded) || decoded.length !== 2) throw invalid();
  const [createdAt, caseId] = decoded as unknown[];
  if (typeof createdAt !== 'string' || !CURSOR_CREATED_AT.test(createdAt)
    || typeof caseId !== 'string' || !CURSOR_CASE_ID.test(caseId)) throw invalid();
  return { createdAt, caseId };
}

/** 0114: the desk fields, all present (the DTO refuses a partial set), or null for an old-shape body. */
interface DeskFields {
  phone: string;
  addressLine: string;
  city: string;
  stateCode: string;
  lga: string;
  hasExistingHealthId: boolean;
}

function deskFieldsOf(input: ResolveNinDto): DeskFields | null {
  const { phone, addressLine, city, stateCode, lga, hasExistingHealthId } = input;
  if (phone == null || addressLine == null || city == null || stateCode == null
    || lga == null || hasExistingHealthId == null) return null;
  return { phone, addressLine, city, stateCode, lga, hasExistingHealthId };
}
