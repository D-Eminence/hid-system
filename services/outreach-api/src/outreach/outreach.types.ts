export interface OutreachRegistrationCase {
  id: string;
  facilityId: string;
  localCommandId: string;
  temporaryPatientId: string;
  status: 'identity_resolution_pending' | 'identity_resolved';
  fullName: string;
  sex: 'female' | 'male' | 'other' | 'unknown';
  ageYears: number;
  phone: string | null;
  operationalNotes: string | null;
  resolvedPatientId: string | null;
  resolutionKind: 'linked_existing' | null;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface RegistrationRow {
  id: string;
  facility_id: string;
  local_command_id: string;
  temporary_patient_id: string;
  status: OutreachRegistrationCase['status'];
  full_name: string;
  sex: OutreachRegistrationCase['sex'];
  age_years: number;
  phone: string | null;
  operational_notes: string | null;
  resolved_patient_id: string | null;
  resolution_kind: 'linked_existing' | null;
  row_version: string | number;
  created_at: Date | string;
  updated_at: Date | string;
}

export function registrationCase(row: RegistrationRow): OutreachRegistrationCase {
  return {
    id: row.id,
    facilityId: row.facility_id,
    localCommandId: row.local_command_id,
    temporaryPatientId: row.temporary_patient_id,
    status: row.status,
    fullName: row.full_name,
    sex: row.sex,
    ageYears: Number(row.age_years),
    phone: row.phone,
    operationalNotes: row.operational_notes,
    resolvedPatientId: row.resolved_patient_id,
    resolutionKind: row.resolution_kind,
    rowVersion: Number(row.row_version),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
