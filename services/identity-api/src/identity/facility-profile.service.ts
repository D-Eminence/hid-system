import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { type FacilityProfileDto, type FacilityProfileView, facilityProfileForDatabase,
  facilityProfileFromDatabase } from './dto/facility-profile.dto';

interface ProfileReadRow extends QueryResultRow {
  facility_id: string;
  facility_name: string;
  review_state: string;
  profile_data: Record<string, unknown> | null;
}

interface ProfileSaveRow extends QueryResultRow {
  facility_id: string;
  row_version: string | number;
  changed_fields: string[] | null;
  replayed: boolean;
}

export interface FacilityProfileAnswer {
  facility: { id: string; name: string; reviewState: string };
  /** The profile's version for If-Match; 0 when the facility has no profile yet. */
  version: number;
  profile: FacilityProfileView | null;
}

export interface FacilityProfileSaveAnswer {
  facilityId: string;
  version: number;
  /** The names of the fields that changed (API names); never their values. */
  changedFields: string[];
  replayed: boolean;
}

/** 0122's column names → the API's field names. */
const API_FIELD: Readonly<Record<string, string>> = Object.freeze({
  trading_name: 'tradingName', ownership: 'ownership', care_level: 'careLevel', address_line: 'addressLine',
  city: 'city', state_code: 'stateCode', lga: 'lga', gps_latitude: 'gpsLatitude', gps_longitude: 'gpsLongitude',
  phone_e164: 'phone', email: 'email', bed_count: 'bedCount', operating_hours: 'operatingHours',
  emergency_24h: 'emergency24h', departments: 'departments', services_offered: 'servicesOffered',
  smoh_licence_number: 'smohLicenceNumber', has_registry_id: 'hasRegistryId', registry_id: 'registryId',
  has_nhia_accreditation: 'hasNhiaAccreditation', nhia_accreditation_number: 'nhiaAccreditationNumber',
  medical_director_name: 'medicalDirectorName', medical_director_mdcn: 'medicalDirectorMdcn',
  expected_staff: 'expectedStaff', migrating_records: 'migratingRecords',
  needs_interoperability: 'needsInteroperability',
});

/**
 * The facility administrator's read and save of the facility profile (0122,
 * decisions D8 and D9): workforce.manage at the X-Facility-ID facility, a
 * self-service facility only (governed and legacy facilities are refused with
 * 403 STAFF_MANAGEMENT_NOT_AVAILABLE; their profile is kept by Health ID
 * support), and never a sealed demo facility (409 FACILITY_PROFILE_SEALED).
 * The database's audit row names the changed fields only, never a value.
 */
@Injectable()
export class FacilityProfileService {
  constructor(private readonly database: DatabaseService) {}

  async read(context: DataAccessContext): Promise<FacilityProfileAnswer> {
    let row: ProfileReadRow | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) =>
        (await client.query<ProfileReadRow>('select * from identity.read_facility_profile()')).rows[0],
      { readOnly: true });
    } catch (error) {
      throw facilityProfileProblem(error);
    }
    if (!row) throw unavailable();
    const profile = row.profile_data ? facilityProfileFromDatabase(row.profile_data) : null;
    return {
      facility: { id: row.facility_id, name: row.facility_name, reviewState: row.review_state },
      version: profile?.version ?? 0,
      profile,
    };
  }

  async save(context: DataAccessContext, expectedVersion: number, input: FacilityProfileDto,
    idempotencyKey: string): Promise<FacilityProfileSaveAnswer> {
    const profile = facilityProfileForDatabase(input);
    const digest = requestDigest('identity.facility-profile.set', { expectedVersion, profile });
    let row: ProfileSaveRow | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) =>
        (await client.query<ProfileSaveRow>(
          'select * from identity.set_facility_profile($1::bigint, $2::jsonb, $3, $4::char(64))',
          [expectedVersion, JSON.stringify(profile), idempotencyKey, digest])).rows[0]);
    } catch (error) {
      throw facilityProfileProblem(error);
    }
    if (!row) throw unavailable();
    return {
      facilityId: row.facility_id,
      version: Number(row.row_version),
      changedFields: (row.changed_fields ?? []).map((field) => API_FIELD[field] ?? field),
      replayed: row.replayed === true,
    };
  }
}

/** If-Match for a save: the profile's version, 0 for a facility with no profile yet. */
export function facilityProfileVersion(value: string | undefined): number {
  const normalized = value?.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  const version = normalized && /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new DomainProblem(428, 'IF_MATCH_REQUIRED', 'If-Match must contain the profile version you loaded');
  }
  return version;
}

function unavailable(): DomainProblem {
  return new DomainProblem(503, 'FACILITY_PROFILE_UNAVAILABLE', 'Facility details are unavailable right now');
}

export function facilityProfileProblem(error: unknown): DomainProblem {
  if (error instanceof DomainProblem) return error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  const message = typeof error === 'object' && error !== null && 'message' in error ? error.message : undefined;
  if (code === '42501' && message === 'STAFF_MANAGEMENT_NOT_AVAILABLE') {
    return new DomainProblem(403, 'STAFF_MANAGEMENT_NOT_AVAILABLE',
      'Health ID support keeps the details of this facility; contact them to change them');
  }
  if (code === '42501') {
    return new DomainProblem(403, 'PERMISSION_DENIED', 'Only the facility administrator can change these details');
  }
  if (code === 'P0001' && message === 'FACILITY_PROFILE_SEALED') {
    return new DomainProblem(409, 'FACILITY_PROFILE_SEALED', 'The demo facility\'s details cannot be changed');
  }
  if (code === '22023') {
    return new DomainProblem(400, 'FACILITY_PROFILE_INVALID', 'Check the facility details and try again');
  }
  if (code === '23505' && message === 'FACILITY_PROFILE_IDEMPOTENCY_CONFLICT') {
    return new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED', 'The Idempotency-Key was already used for other details');
  }
  // 40001, or a concurrent first save of the same facility (its unique row).
  if (code === '40001' || code === '23505') {
    return new DomainProblem(412, 'VERSION_CONFLICT',
      'Someone changed these details meanwhile; reload them before saving');
  }
  return unavailable();
}
