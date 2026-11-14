import type { RegistrationHealthId } from './registration-health-ids';

export interface OutreachRegistrationCase {
  id: string;
  facilityId: string;
  campaignId: string | null;
  localCommandId: string;
  temporaryPatientId: string;
  status: 'identity_resolution_pending' | 'identity_resolved';
  fullName: string;
  sex: 'female' | 'male' | 'other' | 'unknown';
  ageYears: number;
  phone: string | null;
  operationalNotes: string | null;
  /** The person's area, town or LGA as given at registration (0118), or null. */
  area: string | null;
  /** Whether the registration has a screening this session can see (0118). */
  hasScreening: boolean;
  /**
   * Whether that screening holds at least one health check (since 0122's
   * change): false for no screening, and for a form saved with nothing filled
   * in. The slip and the export say "recorded" only then. No health value is
   * answered here.
   */
  hasRecordedChecks: boolean;
  resolvedPatientId: string | null;
  resolutionKind: 'linked_existing' | null;
  /** The Health ID created for this person at the outreach (0119), or null. */
  healthId: string | null;
  /** Whether a Health ID was created from this registration at the outreach (0119). */
  healthIdCreatedByOutreach: boolean;
  /**
   * How it was created (0120): 'verified' (the person proved an email, 0119),
   * 'unclaimed' (no contact; nobody can sign in until it is claimed), or null.
   */
  healthIdStatus: 'verified' | 'unclaimed' | null;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
  /**
   * Set on a new registration in a campaign: another registration in the same
   * campaign has the same phone, or the same name and age. A hint to check,
   * never a refusal.
   */
  possibleDuplicate?: boolean;
}

export interface RegistrationRow {
  id: string;
  facility_id: string;
  campaign_id: string | null;
  local_command_id: string;
  temporary_patient_id: string;
  status: OutreachRegistrationCase['status'];
  full_name: string;
  sex: OutreachRegistrationCase['sex'];
  age_years: number;
  phone: string | null;
  operational_notes: string | null;
  area?: string | null;
  /** How many health checks the visible screening holds, or null when there is none (outreach.service HAS_SCREENING). */
  screening_values?: number | string | null;
  resolved_patient_id: string | null;
  resolution_kind: 'linked_existing' | null;
  row_version: string | number;
  created_at: Date | string;
  updated_at: Date | string;
}

/** A registration as answered; `healthId` is the one created for it at the outreach (0119, 0120), if any. */
export function registrationCase(row: RegistrationRow,
  healthId: RegistrationHealthId | null = null): OutreachRegistrationCase {
  return {
    id: row.id,
    facilityId: row.facility_id,
    campaignId: row.campaign_id,
    localCommandId: row.local_command_id,
    temporaryPatientId: row.temporary_patient_id,
    status: row.status,
    fullName: row.full_name,
    sex: row.sex,
    ageYears: Number(row.age_years),
    phone: row.phone,
    operationalNotes: row.operational_notes,
    area: row.area ?? null,
    hasScreening: row.screening_values !== undefined && row.screening_values !== null,
    hasRecordedChecks: row.screening_values !== undefined && row.screening_values !== null
      && Number(row.screening_values) > 0,
    resolvedPatientId: row.resolved_patient_id,
    resolutionKind: row.resolution_kind,
    healthId: healthId?.healthId ?? null,
    healthIdCreatedByOutreach: healthId !== null,
    healthIdStatus: healthId?.status ?? null,
    rowVersion: Number(row.row_version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
