import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext, HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { QoreIdVerificationAdapter } from './qoreid-verification.adapter';
import type { VerificationFailureCategory } from './qoreid-verification.types';
import type { ApproveOrganizationApplicationDto, SubmitOrganizationApplicationDto } from './dto/organization-application.dto';

type VerificationOutcome = 'verified' | 'not_verified' | 'incomplete' | 'provider_error' | 'disabled';
interface ApplicationRow extends QueryResultRow {
  application_id: string;
  product_code: string;
  organization_name: string;
  organization_type: string;
  cac_hint: string;
  administrator_name: string;
  administrator_email: string;
  application_status: string;
  verification_result: string | null;
  row_version: string;
  created_at: Date;
  verified_at: Date | null;
  reviewed_at: Date | null;
}
interface ApplicationSecretRow extends QueryResultRow {
  application_id: string;
  product_code: string;
  cac_registration_number: string;
  application_status: string;
  row_version: string;
}

@Injectable()
export class OrganizationApplicationsService {
  constructor(private readonly database: DatabaseService, private readonly qoreid: QoreIdVerificationAdapter) {}

  async submit(input: SubmitOrganizationApplicationDto, request: HidRequest): Promise<{ accepted: true }> {
    try {
      await this.database.withSystemTransaction(request.correlationId, async (client) => {
        await client.query('select identity.submit_organization_application($1,$2,$3,$4,$5,$6)', [
          input.productCode, input.organizationName, input.organizationType, input.cacRegistrationNumber,
          input.administratorName, input.administratorEmail,
        ]);
      });
    } catch (error) {
      throw this.mapDatabaseError(error);
    }
    // No application ID, existence signal, or CAC value crosses the public boundary.
    return { accepted: true };
  }

  async list(context: DataAccessContext, status?: string) {
    try {
      const result = await this.database.withTransaction(context, (client) =>
        client.query<ApplicationRow>('select * from identity.admin_list_organization_applications($1)', [status ?? null]),
        { readOnly: true });
      return { items: result.rows.map((row) => ({
        applicationId: row.application_id, productCode: row.product_code,
        organizationName: row.organization_name, organizationType: row.organization_type,
        cacHint: row.cac_hint,
        administratorName: row.administrator_name, administratorEmail: row.administrator_email,
        status: row.application_status, verificationResult: row.verification_result,
        version: Number(row.row_version), createdAt: row.created_at.toISOString(),
        verifiedAt: row.verified_at?.toISOString() ?? null,
        reviewedAt: row.reviewed_at?.toISOString() ?? null,
      })) };
    } catch (error) {
      throw this.mapDatabaseError(error);
    }
  }

  async verify(context: DataAccessContext, applicationId: string, expectedVersion: number) {
    let secret: ApplicationSecretRow;
    try {
      const result = await this.database.withTransaction(context, (client) =>
        client.query<ApplicationSecretRow>('select * from identity.admin_get_organization_application($1)', [applicationId]),
        { readOnly: true });
      const row = result.rows[0];
      if (!row) throw new DomainProblem(404, 'ORGANIZATION_APPLICATION_NOT_FOUND', 'Application was not found');
      if (Number(row.row_version) !== expectedVersion) {
        throw new DomainProblem(409, 'VERSION_CONFLICT', 'Application changed; reload before retrying');
      }
      if (row.application_status !== 'pending_verification' && row.application_status !== 'ready_for_review') {
        throw new DomainProblem(409, 'APPLICATION_CLOSED', 'Application is closed');
      }
      secret = row;
    } catch (error) {
      throw this.mapDatabaseError(error);
    }

    let outcome: VerificationOutcome;
    let failure: VerificationFailureCategory | null = null;
    let reference: string | null = null;
    let providerError: unknown;
    try {
      if (!getEnvironment().QOREID_ENABLED) {
        throw new DomainProblem(503, 'QOREID_DISABLED', 'External verification is not enabled');
      }
      const result = await this.qoreid.verifyCac(secret.cac_registration_number);
      outcome = result.state;
      reference = result.providerReference ?? null;
      if (result.state !== 'verified') failure = result.state;
    } catch (error) {
      providerError = error;
      failure = this.failureCategory(error);
      outcome = failure === 'disabled' ? 'disabled' : 'provider_error';
    }

    try {
      const recorded = await this.database.withTransaction(context, (client) =>
        client.query<{ application_status: string; row_version: string }>(
          'select * from identity.admin_record_organization_cac_result($1,$2,$3,$4,$5)',
          [applicationId, expectedVersion, outcome, reference, failure]),
      );
      const row = recorded.rows[0];
      if (!row) throw new DomainProblem(503, 'VERIFICATION_EVIDENCE_UNAVAILABLE', 'Verification evidence is unavailable');
      if (providerError) throw providerError;
      return { status: row.application_status, version: Number(row.row_version), state: outcome,
        ...(reference ? { providerReference: reference } : {}) };
    } catch (error) {
      if (providerError && error === providerError) throw error;
      throw this.mapDatabaseError(error);
    }
  }

  async approve(context: DataAccessContext, applicationId: string, expectedVersion: number,
    input: ApproveOrganizationApplicationDto) {
    if (Boolean(input.existingOrganizationId) !== Boolean(input.existingFacilityId)) {
      throw new DomainProblem(400, 'ORGANIZATION_LINK_INVALID', 'Both existing organization and facility IDs are required');
    }
    try {
      const result = await this.database.withTransaction(context, (client) =>
        client.query<{ organization_id: string; facility_id: string; first_admin_account_id: string;
          row_version: string; organization_reused: boolean }>(
          'select * from identity.admin_approve_organization_application($1,$2,$3,$4,$5)',
          [applicationId, expectedVersion, input.existingOrganizationId ?? null,
            input.existingFacilityId ?? null, input.reason],
        ));
      const row = result.rows[0];
      if (!row) throw new DomainProblem(503, 'ORGANIZATION_APPROVAL_UNAVAILABLE', 'Approval could not be completed');
      return { organizationId: row.organization_id, facilityId: row.facility_id,
        firstAdminAccountId: row.first_admin_account_id, version: Number(row.row_version),
        organizationReused: row.organization_reused };
    } catch (error) {
      throw this.mapDatabaseError(error);
    }
  }

  async reject(context: DataAccessContext, applicationId: string, expectedVersion: number, reason: string) {
    try {
      const result = await this.database.withTransaction(context, (client) =>
        client.query<{ application_status: string; row_version: string }>(
          'select * from identity.admin_reject_organization_application($1,$2,$3)',
          [applicationId, expectedVersion, reason]));
      const row = result.rows[0];
      if (!row) throw new DomainProblem(503, 'ORGANIZATION_REVIEW_UNAVAILABLE', 'Review could not be completed');
      return { status: row.application_status, version: Number(row.row_version) };
    } catch (error) {
      throw this.mapDatabaseError(error);
    }
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

  private mapDatabaseError(error: unknown): DomainProblem {
    if (error instanceof DomainProblem) return error;
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === '42501') return new DomainProblem(403, 'PERMISSION_DENIED', 'Organization review is not permitted');
    if (code === 'P0002') return new DomainProblem(404, 'ORGANIZATION_APPLICATION_NOT_FOUND', 'Application was not found');
    if (code === '40001') return new DomainProblem(409, 'VERSION_CONFLICT', 'Application changed; reload before retrying');
    if (code === '23505' || code === '23514') return new DomainProblem(409, 'ORGANIZATION_REVIEW_REQUIRED',
      'This application needs separate administrator resolution');
    if (code === '22023') return new DomainProblem(400, 'ORGANIZATION_APPLICATION_INVALID', 'Application command is invalid');
    return new DomainProblem(503, 'ORGANIZATION_APPLICATION_UNAVAILABLE', 'Organization application is unavailable');
  }
}
