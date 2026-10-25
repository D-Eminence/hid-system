import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { DomainProblem } from '../common/problem';
import type { PlatformAdminContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import type { SelfServiceFacilityState } from './dto/self-service-facility.dto';

interface SelfServiceFacilityRow extends QueryResultRow {
  application_id: string;
  row_version: string | number;
  organization_id: string;
  organization_name: string;
  facility_id: string;
  facility_name: string;
  facility_lifecycle_status: string;
  product_code: string;
  organization_type: string;
  cac_hint: string;
  administrator_name: string;
  administrator_email: string;
  administrator_account_id: string | null;
  administrator_account_status: string | null;
  activated_at: Date | string | null;
  reviewed_at: Date | string | null;
  reviewed_by_account_id: string | null;
  review_note: string | null;
  released_at: Date | string | null;
  released_by_account_id: string | null;
  release_reason: string | null;
}

interface ReviewRow extends QueryResultRow {
  application_id: string;
  reviewed_at: Date | string;
  row_version: string | number;
}

interface ReleaseRow extends QueryResultRow {
  application_id: string;
  released_at: Date | string;
  row_version: string | number;
}

interface OpenApplicationRow extends QueryResultRow {
  application_id: string;
  row_version: string | number;
  product_code: string;
  organization_type: string;
  cac_hint: string;
  organization_name: string | null;
  administrator_name: string;
  administrator_email: string;
  application_status: string;
  verification_result: string | null;
  email_verified: boolean;
  submitted_at: Date | string;
  lapses_at: Date | string;
  holds_cac: boolean;
  total_count: string | number;
}

interface RejectRow extends QueryResultRow {
  application_id: string;
  rejected_at: Date | string;
  row_version: string | number;
}

interface WaiveRow extends QueryResultRow {
  application_id: string;
  waived_at: Date | string;
  row_version: string | number;
}

type DatabaseCommand = 'review' | 'release' | 'application' | 'waive';

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/**
 * Support's daily review of facilities that signed themselves up (owner
 * decision "alert + daily review", 2026-10-24). Sign-up stays instant; every
 * activated self-service application is listed here until support marks it
 * reviewed. Suspending the facility and disabling its administrator use the
 * existing admin commands; releasing a fraudulent sign-up afterwards frees its
 * CAC for the real company (review fix R2). Support also sees and can close
 * open self-service applications, which hold a CAC for 24 hours (R3), finds
 * the ones that hold a CAC now first or by CAC number (R16), and can let an
 * applicant retry or waive a 7-day refusal (R15). Built as the admin
 * organization-application commands are: platform transaction, the same
 * permissions and audit, and no facility membership needed.
 */
@Injectable()
export class SelfServiceFacilitiesService {
  constructor(private readonly database: DatabaseService) {}

  async list(context: PlatformAdminContext, state: SelfServiceFacilityState) {
    try {
      const result = await this.database.withPlatformTransaction(context, (client) =>
        client.query<SelfServiceFacilityRow>('select * from identity.admin_list_self_service_facilities($1)', [state]),
        { readOnly: true });
      return { items: result.rows.map((row) => ({
        applicationId: row.application_id,
        version: Number(row.row_version),
        organizationId: row.organization_id,
        organizationName: row.organization_name,
        facilityId: row.facility_id,
        facilityName: row.facility_name,
        facilityLifecycleStatus: row.facility_lifecycle_status,
        productCode: row.product_code,
        organizationType: row.organization_type,
        cacHint: row.cac_hint,
        administratorName: row.administrator_name,
        administratorEmail: row.administrator_email,
        administratorAccountId: row.administrator_account_id,
        administratorAccountStatus: row.administrator_account_status,
        activatedAt: isoOrNull(row.activated_at),
        reviewedAt: isoOrNull(row.reviewed_at),
        reviewedByAccountId: row.reviewed_by_account_id,
        reviewNote: row.review_note,
        releasedAt: isoOrNull(row.released_at),
        releasedByAccountId: row.released_by_account_id,
        releaseReason: row.release_reason,
      })) };
    } catch (error) {
      throw this.mapDatabaseError(error);
    }
  }

  async review(context: PlatformAdminContext, applicationId: string, expectedVersion: number, note: string) {
    try {
      const result = await this.database.withPlatformTransaction(context, (client) =>
        client.query<ReviewRow>('select * from identity.admin_review_self_service_facility($1,$2,$3)',
          [applicationId, expectedVersion, note]));
      const row = result.rows[0];
      if (!row) throw new DomainProblem(503, 'SELF_SERVICE_FACILITY_REVIEW_UNAVAILABLE', 'Review could not be completed');
      return { applicationId: row.application_id, reviewedAt: isoOrNull(row.reviewed_at),
        version: Number(row.row_version) };
    } catch (error) {
      throw this.mapDatabaseError(error);
    }
  }

  /**
   * Releases a fraudulent self sign-up (R2): closes the application, removes
   * the CAC binding, suspends the product and deactivates and renames the
   * organization, so the real company can sign up. The facility must already
   * be suspended and the administrator disabled (the existing commands);
   * otherwise 409 SELF_SERVICE_FACILITY_RELEASE_REQUIRES_SUSPENSION. Unless
   * allowRetry, its email and network are refused for 7 days (R15).
   */
  async release(context: PlatformAdminContext, applicationId: string, expectedVersion: number, reason: string,
    allowRetry = false) {
    try {
      const result = await this.database.withPlatformTransaction(context, (client) =>
        client.query<ReleaseRow>('select * from identity.admin_release_self_service_facility($1,$2,$3,$4)',
          [applicationId, expectedVersion, reason, allowRetry]));
      const row = result.rows[0];
      if (!row) throw new DomainProblem(503, 'SELF_SERVICE_FACILITY_UNAVAILABLE', 'Facility sign-up review is unavailable');
      return { applicationId: row.application_id, releasedAt: isoOrNull(row.released_at),
        version: Number(row.row_version) };
    } catch (error) {
      throw this.mapDatabaseError(error, 'release');
    }
  }

  /**
   * Open self-service applications (R3), those holding their CAC now first,
   * then verified ones, then the newest, at most 200, with the total that
   * match (R16); only one CAC number's when cacRegistrationNumber is given.
   */
  async listOpenApplications(context: PlatformAdminContext, cacRegistrationNumber?: string) {
    try {
      const result = await this.database.withPlatformTransaction(context, (client) =>
        client.query<OpenApplicationRow>('select * from identity.admin_list_open_self_service_applications($1)',
          [cacRegistrationNumber ?? null]),
        { readOnly: true });
      return { total: Number(result.rows[0]?.total_count ?? 0), items: result.rows.map((row) => ({
        applicationId: row.application_id,
        version: Number(row.row_version),
        productCode: row.product_code,
        organizationType: row.organization_type,
        cacHint: row.cac_hint,
        organizationName: row.organization_name,
        administratorName: row.administrator_name,
        administratorEmail: row.administrator_email,
        status: row.application_status,
        verificationResult: row.verification_result,
        emailVerified: row.email_verified === true,
        submittedAt: isoOrNull(row.submitted_at),
        lapsesAt: isoOrNull(row.lapses_at),
        holdsCac: row.holds_cac === true,
      })) };
    } catch (error) {
      throw this.mapDatabaseError(error, 'application');
    }
  }

  /**
   * Closes an open self-service application (R3). Unless allowRetry (R15),
   * its email and network are then refused for 7 days.
   */
  async rejectOpenApplication(context: PlatformAdminContext, applicationId: string, expectedVersion: number,
    reason: string, allowRetry = false) {
    try {
      const result = await this.database.withPlatformTransaction(context, (client) =>
        client.query<RejectRow>('select * from identity.admin_reject_self_service_application($1,$2,$3,$4)',
          [applicationId, expectedVersion, reason, allowRetry]));
      const row = result.rows[0];
      if (!row) throw new DomainProblem(503, 'SELF_SERVICE_FACILITY_UNAVAILABLE', 'Facility sign-up review is unavailable');
      return { applicationId: row.application_id, rejectedAt: isoOrNull(row.rejected_at),
        version: Number(row.row_version) };
    } catch (error) {
      throw this.mapDatabaseError(error, 'application');
    }
  }

  /**
   * Lifts every 7-day refusal a rejection or release set for this CAC number
   * and product (R15), answering each application it lifted; 404
   * SELF_SERVICE_REFUSAL_NOT_FOUND when none is in force.
   */
  async waiveRefusals(context: PlatformAdminContext, cacRegistrationNumber: string, productCode: string,
    reason: string) {
    try {
      const result = await this.database.withPlatformTransaction(context, (client) =>
        client.query<WaiveRow>('select * from identity.admin_waive_self_service_refusals($1,$2,$3)',
          [cacRegistrationNumber, productCode, reason]));
      if (result.rows.length === 0) {
        throw new DomainProblem(503, 'SELF_SERVICE_FACILITY_UNAVAILABLE', 'Facility sign-up review is unavailable');
      }
      return { waived: result.rows.map((row) => ({ applicationId: row.application_id,
        waivedAt: isoOrNull(row.waived_at), version: Number(row.row_version) })) };
    } catch (error) {
      throw this.mapDatabaseError(error, 'waive');
    }
  }

  private mapDatabaseError(error: unknown, command: DatabaseCommand = 'review'): DomainProblem {
    if (error instanceof DomainProblem) return error;
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === '42501') return new DomainProblem(403, 'PERMISSION_DENIED', 'Facility sign-up review is not permitted');
    if (code === 'P0002') {
      if (command === 'waive') {
        return new DomainProblem(404, 'SELF_SERVICE_REFUSAL_NOT_FOUND',
          'No refusal is in force for this CAC number and product');
      }
      return command === 'application'
        ? new DomainProblem(404, 'SELF_SERVICE_APPLICATION_NOT_FOUND', 'Open self-service application was not found')
        : new DomainProblem(404, 'SELF_SERVICE_FACILITY_NOT_FOUND', 'Self-signed-up facility was not found');
    }
    if (code === '40001') return new DomainProblem(409, 'VERSION_CONFLICT', 'Application changed; reload before retrying');
    // Already reviewed or released: identity.admin_review_self_service_facility
    // raises 23505 SELF_SERVICE_FACILITY_ALREADY_REVIEWED and
    // identity.admin_release_self_service_facility 23505
    // SELF_SERVICE_FACILITY_ALREADY_RELEASED (0086), each before it compares
    // the version. Nothing else in these commands raises 23505.
    if (code === '23505') {
      return command === 'release'
        ? new DomainProblem(409, 'SELF_SERVICE_FACILITY_ALREADY_RELEASED', 'This facility sign-up was already released')
        : new DomainProblem(409, 'SELF_SERVICE_FACILITY_ALREADY_REVIEWED', 'This facility sign-up was already reviewed');
    }
    // The release's only 23514 is its precondition; any other integrity
    // refusal (23514 in review or rejection) is not an answer about the request.
    if (code === '23514' && command === 'release' && typeof error === 'object' && error !== null
      && 'message' in error && error.message === 'SELF_SERVICE_FACILITY_RELEASE_REQUIRES_SUSPENSION') {
      return new DomainProblem(409, 'SELF_SERVICE_FACILITY_RELEASE_REQUIRES_SUSPENSION',
        'Suspend the facility and disable its administrator before releasing it');
    }
    if (code === '22023') return new DomainProblem(400, 'SELF_SERVICE_FACILITY_REQUEST_INVALID',
      'Facility sign-up review request is invalid');
    return new DomainProblem(503, 'SELF_SERVICE_FACILITY_UNAVAILABLE', 'Facility sign-up review is unavailable');
  }
}
