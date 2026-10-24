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
}

interface ReviewRow extends QueryResultRow {
  application_id: string;
  reviewed_at: Date | string;
  row_version: string | number;
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/**
 * Support's daily review of facilities that signed themselves up (owner
 * decision "alert + daily review", 2026-10-24). Sign-up stays instant; every
 * activated self-service application is listed here until support marks it
 * reviewed. Suspending the facility and disabling its administrator use the
 * existing admin commands. Built as the admin organization-application
 * commands are: platform transaction, the same permissions and audit.
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

  private mapDatabaseError(error: unknown): DomainProblem {
    if (error instanceof DomainProblem) return error;
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === '42501') return new DomainProblem(403, 'PERMISSION_DENIED', 'Facility sign-up review is not permitted');
    if (code === 'P0002') return new DomainProblem(404, 'SELF_SERVICE_FACILITY_NOT_FOUND',
      'Self-signed-up facility was not found');
    if (code === '40001') return new DomainProblem(409, 'VERSION_CONFLICT', 'Application changed; reload before retrying');
    // Already reviewed: identity.admin_review_self_service_facility raises
    // 23505 SELF_SERVICE_FACILITY_ALREADY_REVIEWED (0086), before it compares
    // the version. Nothing else in these commands raises 23505; any other
    // integrity refusal (23514) is not an answer about the review.
    if (code === '23505') return new DomainProblem(409, 'SELF_SERVICE_FACILITY_ALREADY_REVIEWED',
      'This facility sign-up was already reviewed');
    if (code === '22023') return new DomainProblem(400, 'SELF_SERVICE_FACILITY_REQUEST_INVALID',
      'Facility sign-up review request is invalid');
    return new DomainProblem(503, 'SELF_SERVICE_FACILITY_UNAVAILABLE', 'Facility sign-up review is unavailable');
  }
}
