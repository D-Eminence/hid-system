import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { requirePatient } from '../auth/patient-self.service';
import { DomainProblem } from '../common/problem';
import { requireRequestContext, type HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { QoreIdVerificationAdapter } from './qoreid-verification.adapter';
import {
  QOREID_PROVIDER,
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

@Injectable()
export class QoreIdVerificationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly provider: QoreIdVerificationAdapter,
  ) {}

  async verifyPatientNin(request: HidRequest, nin: string): Promise<VerificationResponse> {
    const actor = requirePatient(request.actor);
    const persist = (result: EvidenceResult, reference?: string, failure?: VerificationFailureCategory) =>
      this.recordPatientEvidence(request, actor.subject, actor.sessionId, result, reference, failure);
    return this.verify(
      () => this.provider.verifyNin(nin),
      persist,
      'patient',
      'nin',
    );
  }

  async verifyOrganizationCac(
    request: HidRequest,
    organizationContext: OrganizationVerificationContext,
    regNumber: string,
  ): Promise<VerificationResponse> {
    const context = requireRequestContext(request, 'healthcare-operations');
    const persist = (result: EvidenceResult, reference?: string, failure?: VerificationFailureCategory) =>
      this.recordOrganizationEvidence(context, organizationContext, result, reference, failure);
    return this.verify(
      () => this.provider.verifyCac(regNumber),
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
      this.assertEnabled();
      providerResult = await execute();
    } catch (error) {
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
      recordedAt: evidence.recordedAt,
    };
  }

  private assertEnabled(): void {
    if (!getEnvironment().QOREID_ENABLED) {
      throw new DomainProblem(503, 'QOREID_DISABLED', 'External verification is not enabled');
    }
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
           from identity.record_my_nin_verification_evidence($1, $2, $3, $4, $5)`,
        [subject, sessionId, result, providerReference ?? null, failure ?? null],
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
    } catch {
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
      case 'QOREID_AUTHENTICATION_FAILED': return 'provider_authentication';
      case 'QOREID_PROVIDER_UNAVAILABLE': return 'provider_unavailable';
      case 'QOREID_TIMEOUT': return 'timeout';
      case 'QOREID_NETWORK_UNAVAILABLE': return 'network';
      case 'QOREID_PROVIDER_RESPONSE_INVALID': return 'malformed_response';
      default: return 'unexpected_response';
    }
  }
}
