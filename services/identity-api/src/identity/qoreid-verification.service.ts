import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { requirePatient } from '../auth/patient-self.service';
import { DomainProblem } from '../common/problem';
import { requireRequestContext, type HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { IntegrationRuntimeService } from '../integrations/integration-runtime.service';
import { NinCheckOnce, type NinCheckAnswer, qoreIdRejected, recordNames } from './nin-check-once';
import { NinIdentifierProtector } from './nin-identifier-protector';
import { QoreIdVerificationAdapter } from './qoreid-verification.adapter';
import { matchingCacIncompleteProfile, verifiedCacBinding } from './organization-applications.service';
import {
  QOREID_PROVIDER,
  type QoreIdNinClaims,
  type QoreIdNinBinding,
  type EvidenceResult,
  type OrganizationVerificationContext,
  type QoreIdVerificationResult,
  type VerificationFailureCategory,
  type VerificationResponse,
  type VerificationState,
} from './qoreid-verification.types';

interface EvidenceRow extends QueryResultRow {
  evidenceId: string;
  recordedAt: Date;
}

interface StoredEvidence {
  evidenceId: string;
  recordedAt: string;
}

interface PatientProfileRow extends QueryResultRow {
  profile: unknown;
}

type PatientNinEligibility = 'bound_exact' | 'legacy_unbound' | 'denied';

@Injectable()
export class QoreIdVerificationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly provider: QoreIdVerificationAdapter,
    private readonly integrations: IntegrationRuntimeService,
    private readonly ninProtector: NinIdentifierProtector,
    private readonly ninCheck: NinCheckOnce,
  ) {}

  async verifyPatientNin(request: HidRequest, nin: string, declaredDateOfBirth?: string): Promise<VerificationResponse> {
    const actor = requirePatient(request.actor);
    // This route binds a NIN on a name and date-of-birth match, with no proof
    // that the patient holds the NIN. Off unless configured on, and refused
    // before any lookup, quota charge or evidence write.
    if (!getEnvironment().QOREID_PATIENT_SELF_NIN_BINDING_ENABLED) {
      throw new DomainProblem(503, 'QOREID_PATIENT_NIN_BINDING_DISABLED',
        'Verifying a NIN from your account is not available');
    }
    let verifiedProfile: QoreIdNinBinding | undefined;
    // Set when the profile had no date of birth and the request supplied it:
    // recorded on the profile in the binding's transaction, once QoreID matched.
    let recordDateOfBirth: string | undefined;
    let declaredProfile = false;
    const persist = (result: EvidenceResult, reference?: string, failure?: VerificationFailureCategory) =>
      result === 'verified'
        ? this.bindVerifiedPatientNin(request, actor.subject, actor.sessionId, nin, verifiedProfile, reference,
          recordDateOfBirth)
        : this.recordPatientEvidence(request, actor.subject, actor.sessionId, result, reference, failure);
    const response = await this.verify(
      async () => {
        const profileClaims = await this.patientClaims(request, actor.subject, actor.sessionId, actor.patientId,
          declaredDateOfBirth);
        const claims = profileClaims.claims;
        declaredProfile = profileClaims.declaredDateOfBirth;
        const lookupHmac = this.ninProtector.lookup(nin);
        const eligibility = await this.patientNinEligibility(request, actor.subject, actor.sessionId, lookupHmac);
        if (eligibility === 'denied') {
          throw new DomainProblem(409, 'PATIENT_NIN_BINDING_CONFLICT',
            'This NIN requires identity review before it can be verified');
        }
        await this.integrations.consumePatientQuota(request.correlationId, actor.subject, actor.sessionId);
        // QoreID charges every check (Q109): asked once per NIN (NinCheckOnce,
        // 0137). A record QoreID already returned for this NIN (here, at
        // sign-up or at a desk) is compared with the profile here instead.
        const nameOrder = declaredProfile ? 'either' as const : 'exact' as const;
        const checked = await this.ninCheck.check({
          nin, correlationId: request.correlationId, path: 'profile', needsCompleteRecord: false,
          question: JSON.stringify([normalizedClaimName(claims.firstName), normalizedClaimName(claims.lastName),
            claims.dateOfBirth, nameOrder]),
          ask: async () => {
            const asked = await this.provider.verifyNin(nin, claims, nameOrder);
            return { answer: profileAnswer(asked), value: asked };
          },
        });
        const result = checked.source === 'qoreid' ? checked.value
          : storedProfileResult(checked.answer, nin, claims, nameOrder);
        if (result.state === 'verified') {
          const binding = result.ninBinding;
          const normalizeName = (name: string) => name.trim().replace(/\s+/g, ' ').toLocaleUpperCase('en-NG');
          const sameOrder = binding !== undefined
            && normalizeName(binding.firstName) === normalizeName(claims.firstName)
            && normalizeName(binding.lastName) === normalizeName(claims.lastName);
          const swapped = declaredProfile && binding !== undefined
            && normalizeName(binding.firstName) === normalizeName(claims.lastName)
            && normalizeName(binding.lastName) === normalizeName(claims.firstName);
          if (!binding || binding.nin !== nin || !result.providerReference
            || !(sameOrder || swapped) || binding.dateOfBirth !== claims.dateOfBirth) {
            throw new DomainProblem(502, 'QOREID_PROVIDER_RESPONSE_INVALID',
              'External verification returned an invalid response');
          }
          verifiedProfile = binding;
          // A profile without a date of birth keeps the record's once bound.
          recordDateOfBirth = declaredProfile ? binding.dateOfBirth : undefined;
        }
        return result;
      },
      persist,
      'patient',
      'nin',
    );
    // A sign-up patient's details (no date of birth on the profile) must match
    // the record; the not_verified evidence is already recorded.
    if (declaredProfile && response.state === 'not_verified') throw this.ninDetailsMismatch();
    return response;
  }

  private ninDetailsMismatch() {
    return new DomainProblem(409, 'PATIENT_NIN_DETAILS_MISMATCH', 'The NIN details do not match your profile.');
  }

  private async patientNinEligibility(request: HidRequest, subject: string,
    sessionId: string, lookupHmac: string): Promise<PatientNinEligibility> {
    let state: PatientNinEligibility;
    try {
      state = await this.database.withSystemTransaction(request.correlationId, async (client) => {
        await client.query("select set_config('app.actor_subject',$1,true)", [subject]);
        const result = await client.query<{ state: PatientNinEligibility }>(
          'select identity.patient_self_nin_eligibility($1,$2,$3) as state',
          [subject, sessionId, lookupHmac]);
        return result.rows[0]?.state ?? 'denied';
      });
    } catch {
      throw new DomainProblem(503, 'PATIENT_NIN_BINDING_UNAVAILABLE',
        'Patient NIN binding is temporarily unavailable');
    }
    return state;
  }

  private async bindVerifiedPatientNin(request: HidRequest, subject: string, sessionId: string,
    nin: string, profile: QoreIdNinBinding | undefined, providerReference?: string,
    recordDateOfBirth?: string): Promise<StoredEvidence> {
    if (!providerReference || !profile || profile.nin !== nin) throw new DomainProblem(502, 'QOREID_PROVIDER_RESPONSE_INVALID',
      'External verification returned an invalid response');
    const evidenceId = randomUUID();
    const protectedNin = this.ninProtector.protectPatientSelf(nin, evidenceId);
    const protectedProfile = this.ninProtector.protectPatientSelfProfile({
      firstName: profile.firstName, lastName: profile.lastName, dateOfBirth: profile.dateOfBirth,
    }, evidenceId);
    try {
      return await this.database.withSystemTransaction(request.correlationId, async (client) => {
        await client.query("select set_config('app.actor_subject',$1,true)", [subject]);
        const recorded = await client.query<EvidenceRow>(
          `select evidence_id as "evidenceId", recorded_at as "recordedAt"
             from identity.bind_my_verified_nin($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [subject, sessionId, evidenceId, protectedNin.lookupHmac, protectedNin.ciphertext,
            protectedNin.keyVersion, protectedNin.last4, providerReference,
            protectedProfile.ciphertext, protectedProfile.sha256],
        );
        if (recordDateOfBirth) {
          await client.query('select identity.record_my_verified_nin_date_of_birth($1,$2,$3,$4::date)',
            [subject, sessionId, evidenceId, recordDateOfBirth]);
        }
        return this.evidenceRow(recorded.rows[0]);
      });
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
      if (code === '23505' || code === '23514' || code === '42501') {
        throw new DomainProblem(409, 'PATIENT_NIN_BINDING_CONFLICT',
          'This NIN requires identity review before it can be verified');
      }
      throw error;
    }
  }

  /**
   * The profile's claims. A profile without a date of birth (a sign-up
   * without NIN) takes the request's `declaredDateOfBirth` (required); one with
   * a date of birth uses its own, and refuses a stated date that differs.
   */
  private async patientClaims(request: HidRequest, subject: string, sessionId: string,
    patientId: string, declaredDateOfBirth?: string): Promise<{ claims: QoreIdNinClaims; declaredDateOfBirth: boolean }> {
    const profile = await this.database.withSystemTransaction(request.correlationId, async (client) => {
      await client.query("select set_config('app.actor_subject',$1,true)", [subject]);
      const result = await client.query<PatientProfileRow>(
        'select identity.patient_self_profile($1,$2) as profile', [subject, sessionId]);
      return result.rows[0]?.profile;
    });
    const value = typeof profile === 'object' && profile !== null && !Array.isArray(profile)
      ? profile as Record<string, unknown> : undefined;
    const firstName = value?.firstName;
    const lastName = value?.lastName;
    // A profile without a date of birth (a sign-up without NIN, 0092) needs
    // the stated one; a profile with one keeps it, and a stated date that
    // differs from it is refused before any lookup.
    const declared = value !== undefined && (value.dateOfBirth === null || value.dateOfBirth === undefined);
    if (declared && declaredDateOfBirth === undefined) {
      throw new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
        [{ field: 'dateOfBirth', messages: ['Enter your date of birth (YYYY-MM-DD) as it is on your NIN record'] }]);
    }
    if (value !== undefined && !declared && declaredDateOfBirth !== undefined
      && declaredDateOfBirth !== value.dateOfBirth) {
      throw this.ninDetailsMismatch();
    }
    const dateOfBirth = declared ? declaredDateOfBirth : value?.dateOfBirth;
    const date = typeof dateOfBirth === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)
      ? new Date(`${dateOfBirth}T00:00:00Z`) : new Date(NaN);
    const validName = (name: unknown): name is string => typeof name === 'string'
      && name.trim().length >= 1 && name.trim().length <= 100 && !/[\x00-\x1f\x7f]/.test(name);
    if (value?.patientId !== patientId || !validName(firstName) || !validName(lastName)
      || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== dateOfBirth
      || date.getTime() > Date.now() || (declared && date.getUTCFullYear() < 1900)) {
      if (declared && value?.patientId === patientId && validName(firstName) && validName(lastName)) {
        throw new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
          [{ field: 'dateOfBirth', messages: ['Enter a valid date of birth (YYYY-MM-DD)'] }]);
      }
      throw new DomainProblem(422, 'PATIENT_IDENTITY_PROFILE_INCOMPLETE',
        'The patient profile cannot support NIN identity verification');
    }
    return { claims: { firstName: firstName.trim(), lastName: lastName.trim(), dateOfBirth }, declaredDateOfBirth: declared };
  }

  async verifyOrganizationCac(
    request: HidRequest,
    organizationContext: OrganizationVerificationContext,
    regNumber: string,
  ): Promise<VerificationResponse> {
    const context = requireRequestContext(request, 'healthcare-operations');
    const organizationId = context.actor.facility?.organizationId;
    if (!organizationId) {
      throw new DomainProblem(403, 'ORGANIZATION_CONTEXT_REQUIRED',
        'An active organization context is required');
    }
    const persist = (result: EvidenceResult, reference?: string, failure?: VerificationFailureCategory) =>
      this.recordOrganizationEvidence(context, organizationContext, result, reference, failure);
    return this.verify(
      async () => {
        await this.integrations.consumeQuota(context, 'existing_cac', organizationId);
        const result = await this.provider.verifyCac(regNumber);
        if (result.state !== 'verified') return result;
        if (!result.cacBinding) {
          if (!result.cacIncompleteProfile) {
            throw new DomainProblem(502, 'QOREID_PROVIDER_RESPONSE_INVALID',
              'External verification returned an invalid response');
          }
          return matchingCacIncompleteProfile(regNumber, result)
            ? { ...result, state: 'incomplete', providerVerification: 'verified' }
            : { ...result, state: 'not_verified' };
        }
        const binding = verifiedCacBinding(regNumber, result);
        if (!binding) return { ...result, state: 'not_verified' };
        const matched = await this.database.withTransaction(context, async (client) => {
          const query = await client.query<{ matched: boolean }>(
            'select identity.current_organization_cac_binding_matches($1,$2,$3,$4,$5,$6,$7) as matched',
            [organizationContext, binding.registrationNumber, binding.companyName,
              binding.entityType, binding.registrationDate, binding.address, binding.registryStatus]);
          return query.rows[0]?.matched === true;
        }, { readOnly: true });
        return matched ? { ...result, providerVerification: 'verified' as const }
          : { ...result, state: 'not_verified' };
      },
      persist,
      'organization',
      'cac',
    );
  }

  private async verify(
    execute: () => Promise<QoreIdVerificationResult>,
    persist: (result: EvidenceResult, reference?: string, failure?: VerificationFailureCategory) => Promise<StoredEvidence>,
    entityType: VerificationResponse['entityType'],
    verificationType: VerificationResponse['verificationType'],
  ): Promise<VerificationResponse> {
    let providerResult: QoreIdVerificationResult;
    try {
      await this.assertEnabled(verificationType === 'nin' ? 'patient_nin' : 'provider_cac');
      providerResult = await execute();
    } catch (error) {
      // Local policy, binding, and quota gates made no provider request. They
      // must not be recorded as QoreID outcomes or change assurance state.
      if (error instanceof DomainProblem && (
        (verificationType === 'cac' && ['QOREID_DISABLED', 'INTEGRATION_PAUSED'].includes(error.code))
        || [
          'VERIFICATION_QUOTA_EXCEEDED', 'VERIFICATION_QUOTA_UNAVAILABLE', 'PERMISSION_DENIED',
          'INTEGRATION_UNAVAILABLE', 'PATIENT_NIN_BINDING_CONFLICT', 'PATIENT_NIN_BINDING_UNAVAILABLE',
          'NIN_PROTECTION_UNAVAILABLE', 'PATIENT_IDENTITY_PROFILE_INCOMPLETE',
          'VALIDATION_FAILED', 'PATIENT_NIN_DETAILS_MISMATCH',
          // NinCheckOnce (0137): another check of the NIN is running or held,
          // or its store is unavailable; nothing was sent to QoreID.
          'NIN_CHECK_IN_PROGRESS', 'NIN_CHECK_UNAVAILABLE',
        ].includes(error.code))) throw error;
      const failure = this.failureCategory(error);
      await this.persistFailure(persist, failure);
      throw error;
    }

    const failure = providerResult.state === 'verified' ? undefined : providerResult.state;
    const evidence = await this.persistEvidence(
      persist,
      providerResult.state,
      providerResult.providerReference,
      failure,
    );
    return {
      entityType,
      verificationType,
      provider: QOREID_PROVIDER,
      state: providerResult.state,
      ...(providerResult.providerReference ? { providerReference: providerResult.providerReference } : {}),
      ...(providerResult.providerVerification ? { providerVerification: providerResult.providerVerification } : {}),
      recordedAt: evidence.recordedAt,
    };
  }

  private async assertEnabled(capability: 'patient_nin' | 'provider_cac'): Promise<void> {
    if (!getEnvironment().QOREID_ENABLED) {
      throw new DomainProblem(503, 'QOREID_DISABLED', 'External verification is not enabled');
    }
    await this.integrations.assertAvailable('qoreid', capability);
  }

  private async recordPatientEvidence(
    request: HidRequest,
    subject: string,
    sessionId: string,
    result: EvidenceResult,
    providerReference?: string,
    failure?: VerificationFailureCategory,
  ): Promise<StoredEvidence> {
    return this.database.withSystemTransaction(request.correlationId, async (client) => {
      // The database function validates this subject/session pair before it
      // associates evidence with an existing canonical patient.
      await client.query("select set_config('app.actor_subject',$1,true)", [subject]);
      const recorded = await client.query<EvidenceRow>(
        `select evidence_id as "evidenceId", recorded_at as "recordedAt"
           from identity.record_my_nin_verification_evidence($1, $2, $3, $4, $5, $6)`,
        [subject, sessionId, result, providerReference ?? null, failure ?? null, null],
      );
      return this.evidenceRow(recorded.rows[0]);
    });
  }

  private async recordOrganizationEvidence(
    context: ReturnType<typeof requireRequestContext>,
    organizationContext: OrganizationVerificationContext,
    result: EvidenceResult,
    providerReference?: string,
    failure?: VerificationFailureCategory,
  ): Promise<StoredEvidence> {
    return this.database.withTransaction(context, async (client) => {
      const recorded = await client.query<EvidenceRow>(
        `select evidence_id as "evidenceId", recorded_at as "recordedAt"
           from identity.record_organization_cac_verification_evidence($1, $2, $3, $4)`,
        [organizationContext, result, providerReference ?? null, failure ?? null],
      );
      return this.evidenceRow(recorded.rows[0]);
    });
  }

  private async persistFailure(
    persist: (result: EvidenceResult, reference?: string, failure?: VerificationFailureCategory) => Promise<StoredEvidence>,
    failure: VerificationFailureCategory,
  ): Promise<void> {
    await this.persistEvidence(persist, failure === 'disabled' ? 'disabled' : 'provider_error', undefined, failure);
  }

  private async persistEvidence(
    persist: (result: EvidenceResult, reference?: string, failure?: VerificationFailureCategory) => Promise<StoredEvidence>,
    result: EvidenceResult,
    reference?: string,
    failure?: VerificationFailureCategory,
  ): Promise<StoredEvidence> {
    try {
      return await persist(result, reference, failure);
    } catch (error) {
      if (error instanceof DomainProblem && ['PATIENT_NIN_BINDING_CONFLICT', 'NIN_PROTECTION_UNAVAILABLE'].includes(error.code)) {
        throw error;
      }
      // The command should not report a provider result if its minimum audit
      // evidence cannot be made durable. Do not expose database diagnostics.
      throw new DomainProblem(503, 'VERIFICATION_EVIDENCE_UNAVAILABLE', 'Verification evidence is unavailable');
    }
  }

  private evidenceRow(row: EvidenceRow | undefined): StoredEvidence {
    if (!row?.evidenceId || !(row.recordedAt instanceof Date) || !Number.isFinite(row.recordedAt.getTime())) {
      throw new DomainProblem(503, 'VERIFICATION_EVIDENCE_UNAVAILABLE', 'Verification evidence is unavailable');
    }
    return { evidenceId: row.evidenceId, recordedAt: row.recordedAt.toISOString() };
  }

  private failureCategory(error: unknown): VerificationFailureCategory {
    if (!(error instanceof DomainProblem)) return 'unexpected_response';
    switch (error.code) {
      case 'QOREID_DISABLED': return 'disabled';
      case 'INTEGRATION_PAUSED': return 'disabled';
      case 'INTEGRATION_UNAVAILABLE': return 'provider_unavailable';
      case 'QOREID_AUTHENTICATION_FAILED': return 'provider_authentication';
      case 'QOREID_PROVIDER_UNAVAILABLE': return 'provider_unavailable';
      case 'QOREID_TIMEOUT': return 'timeout';
      case 'QOREID_NETWORK_UNAVAILABLE': return 'network';
      case 'QOREID_PROVIDER_RESPONSE_INVALID': return 'malformed_response';
      default: return 'unexpected_response';
    }
  }
}

function normalizedClaimName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLocaleUpperCase('en-NG');
}

/** What a profile check keeps: the record QoreID returned, else its "no record". */
function profileAnswer(result: QoreIdVerificationResult): NinCheckAnswer {
  if (result.ninRecord && result.providerReference) {
    return { outcome: 'record', providerReference: result.providerReference, record: result.ninRecord };
  }
  return { outcome: 'no_record', state: result.state === 'incomplete' ? 'incomplete' : 'not_verified',
    ...(result.providerReference ? { providerReference: result.providerReference } : {}) };
}

/**
 * A stored answer, compared with the profile as the adapter compares a fresh
 * one (qoreid-verification.adapter.ts, normalizedNinVerification and
 * declaredNinVerification): the record's first and last name equal the
 * claims' (in either order for a sign-up profile) and its date of birth the
 * claimed one.
 */
function storedProfileResult(answer: NinCheckAnswer, nin: string, claims: QoreIdNinClaims,
  nameOrder: 'exact' | 'either'): QoreIdVerificationResult {
  if (answer.outcome === 'rejected') throw qoreIdRejected();
  const respondedAt = new Date().toISOString();
  if (answer.outcome === 'no_record') {
    return { provider: QOREID_PROVIDER, state: answer.state, respondedAt,
      ...(answer.providerReference ? { providerReference: answer.providerReference } : {}) };
  }
  const record = recordNames(answer.record);
  const [first, last] = [normalizedClaimName(record.firstName), normalizedClaimName(record.lastName)];
  const [claimedFirst, claimedLast] = [normalizedClaimName(claims.firstName), normalizedClaimName(claims.lastName)];
  const namesMatch = (first === claimedFirst && last === claimedLast)
    || (nameOrder === 'either' && first === claimedLast && last === claimedFirst);
  const base = { provider: QOREID_PROVIDER, providerReference: answer.providerReference, respondedAt };
  if (record.nin !== nin || !namesMatch || record.dateOfBirth !== claims.dateOfBirth) {
    return { ...base, state: 'not_verified' };
  }
  return { ...base, state: 'verified', ninBinding: record };
}
