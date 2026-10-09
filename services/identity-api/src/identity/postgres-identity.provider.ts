import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type {
  AuthorizationDecision,
  AuthorizationRequest,
  ConsentStatus,
  IdentityPatient,
  IdentityProvider,
} from './identity.types';
import type { DataAccessContext, PurposeOfUse } from '../common/request-context';

interface PatientRow {
  id: string;
  hid_code: string;
  first_name: string;
  last_name: string;
  full_name: string;
  dob: string | null;
  gender: string | null;
  row_version: string;
}

interface GrantRow {
  id: string;
  scope: 'read_records' | 'write_records' | 'break_glass';
  expires_at: Date;
  break_glass: boolean;
}

@Injectable()
export class PostgresIdentityProvider implements IdentityProvider {
  constructor(private readonly database: DatabaseService) {}

  async lookupExactHid(hid: string, context: DataAccessContext): Promise<IdentityPatient | null> {
    return this.database.withTransaction(context, async (client) => {
      const result = await client.query<PatientRow>(
        `select id::text, hid_code, first_name, last_name, full_name,
                dob::text, gender, row_version::text
           from identity.patients
          where upper(hid_code) = upper($1)
            and status = 'active'
          limit 1`,
        [hid],
      );
      const row = result.rows[0];
      return row ? this.patient(row) : null;
    }, { readOnly: true });
  }

  async authorize(request: AuthorizationRequest): Promise<AuthorizationDecision> {
    return this.database.withTransaction(request.context, async (client) => {
      const policyResult = await client.query<{ allowed: boolean }>(
        `select identity.has_active_consent_grant($1, $2, $3, $4, $5, $6, clock_timestamp()) as allowed`,
        [
          request.patientId,
          request.context.actor.subject,
          request.context.membershipId,
          request.context.facilityId,
          request.scope,
          request.purpose,
        ],
      );
      const allowed = policyResult.rows[0]?.allowed === true;
      const grants = await client.query<GrantRow>(
        `select grant_row.id::text, grant_row.scope, grant_row.expires_at, grant_row.break_glass
           from identity.consent_grants grant_row
          where grant_row.patient_id = $1
            and grant_row.membership_id = $2
            and grant_row.facility_id = $3
            and grant_row.account_id = $4
            and grant_row.status = 'active'
            and grant_row.migration_hold_reason is null
            and grant_row.purpose_of_use = $6
            and grant_row.starts_at <= clock_timestamp()
            and grant_row.expires_at > clock_timestamp()
            and (
              grant_row.scope = 'break_glass'
              or grant_row.scope = $5
              or ($5 = 'read_records' and grant_row.scope = 'write_records')
            )
          order by grant_row.break_glass asc, grant_row.expires_at desc
          limit 1`,
        [
          request.patientId,
          request.context.membershipId,
          request.context.facilityId,
          request.context.actor.accountId,
          request.scope,
          request.purpose,
        ],
      );
      const grant = allowed ? grants.rows[0] : undefined;
      const effectiveAllowed = allowed && Boolean(grant);
      return {
        allowed: effectiveAllowed,
        patientId: request.patientId,
        facilityId: request.context.facilityId,
        membershipId: request.context.membershipId,
        scope: request.scope,
        purpose: request.purpose,
        ...(grant ? { consentGrantId: grant.id, expiresAt: grant.expires_at.toISOString() } : {}),
        breakGlass: grant?.break_glass ?? false,
      };
    }, { readOnly: true, isolationLevel: 'REPEATABLE READ' });
  }

  async consentStatus(patientId: string, purpose: PurposeOfUse, context: DataAccessContext): Promise<ConsentStatus> {
    const read = await this.authorize({ patientId, scope: 'read_records', purpose, context });
    const write = await this.authorize({ patientId, scope: 'write_records', purpose, context });
    const expirations = [read.expiresAt, write.expiresAt].filter((value): value is string => Boolean(value)).sort();
    return {
      patientId,
      facilityId: context.facilityId,
      purpose,
      readAllowed: read.allowed,
      writeAllowed: write.allowed,
      ...(expirations[0] ? { expiresAt: expirations[0] } : {}),
    };
  }

  private patient(row: PatientRow): IdentityPatient {
    return {
      id: row.id,
      hidCode: row.hid_code,
      firstName: row.first_name,
      lastName: row.last_name,
      fullName: row.full_name,
      dateOfBirth: row.dob,
      gender: row.gender,
      rowVersion: Number(row.row_version),
    };
  }
}
