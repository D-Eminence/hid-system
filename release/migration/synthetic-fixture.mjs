// Public synthetic test values only. No production export or credential belongs here.
export const ids = {
  account: 'a0000000-0000-4000-8000-000000000001',
  staffAccount: 'a0000000-0000-4000-8000-000000000002',
  organization: 'a1000000-0000-4000-8000-000000000001',
  facility: 'a2000000-0000-4000-8000-000000000001',
  patient: 'a3000000-0000-4000-8000-000000000001',
  identifier: 'a4000000-0000-4000-8000-000000000001',
  staff: 'a5000000-0000-4000-8000-000000000001',
  membership: 'a6000000-0000-4000-8000-000000000001',
  request: 'a7000000-0000-4000-8000-000000000001',
  consent: 'a8000000-0000-4000-8000-000000000001',
  audit: 'a9000000-0000-4000-8000-000000000001',
};

const created = '2025-01-01T00:00:00.000Z';
const updated = '2026-01-01T00:00:00.000Z';
const row = (payload, key = 'id') => ({
  source_pk: payload[key], source_updated_at: updated,
  payload: { created_at: created, updated_at: updated, ...payload },
});

export function syntheticFixture() {
  return {
    accounts: [ids.account, ids.staffAccount].map((id, index) => row({
      id, email: `synthetic-${index}@example.invalid`, encrypted_password: null,
      email_confirmed_at: created,
    })),
    user_profiles: [],
    organizations: [row({ id: ids.organization, name: 'Synthetic Organisation', slug: 'synthetic-rehearsal', active: true })],
    facilities: [row({ id: ids.facility, organization_id: ids.organization, name: 'Synthetic Facility', code: 'TUF-TEST', active: true })],
    patients: [row({
      id: ids.patient, auth_user_id: ids.account, hid_code: 'HID-JKLMNPQR',
      first_name: 'Àdá', last_name: 'Synthetic', full_name: 'Àdá Synthetic 患者',
      email: 'SYNTHETIC-PATIENT@EXAMPLE.INVALID', phone_e164: '+234 000 000 0000',
      gender: null, dob: '2000-02-29', blood_group: 'synthetic-only',
      medical_notes: 'SYNTHETIC clinical quarantine — not patient data',
    })],
    patient_identifiers: [row({
      id: ids.identifier, patient_id: ids.patient, identifier_type: 'hid_code',
      raw_value: 'hid-jklmnpqr', normalized_value: 'hid-jklmnpqr', verified: true,
    })],
    staff: [row({
      id: ids.staff, auth_user_id: ids.staffAccount, full_name: 'Synthetic Clinician',
      email: 'synthetic-1@example.invalid', verification_status: 'verified', role: 'doctor', active: true,
    })],
    memberships: [row({
      id: ids.membership, staff_account_id: ids.staff, organization_id: ids.organization,
      facility_id: ids.facility, membership_role: 'doctor', app_role: 'doctor', is_primary: true, active: true,
    })],
    access_requests: [row({
      id: ids.request, patient_id: ids.patient, requester_staff_account_id: ids.staff,
      requester_membership_id: ids.membership, scope: 'read_records', status: 'pending',
      reason: 'Synthetic legacy request', requested_duration_minutes: 30, break_glass: false,
    })],
    consent_grants: [row({
      id: ids.consent, patient_id: ids.patient, staff_account_id: ids.staff, membership_id: ids.membership,
      request_id: ids.request, scope: 'read_records', status: 'active',
      reason: 'Synthetic legacy consent', starts_at: created, expires_at: '2030-01-01T00:00:00.000Z',
      granted_by_patient_id: ids.patient,
    })],
    audit_events: [row({
      event_id: ids.audit, actor_user_id: ids.staffAccount, organization_id: ids.organization,
      patient_id: ids.patient, action: 'patient.records.read', resource_type: 'patient', resource_id: ids.patient,
      metadata: { outcome: 'deny', facility_id: ids.facility, correlation_id: 'synthetic-migration-01' },
    }, 'event_id')],
  };
}

// Persist a separate canonical patient and related record before the backup.
// IDs differ from both the legacy fixture and the rollback-only schema suite.
export const baselineSql = `
begin;
insert into auth.accounts (id, subject, status) values
 ('b0000000-0000-4000-8000-000000000001', 'synthetic:baseline', 'active');
insert into identity.organizations (id, name, slug) values
 ('b1000000-0000-4000-8000-000000000001', 'Synthetic baseline', 'synthetic-baseline');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
 ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'Synthetic baseline', 'BASELINE', 'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
 ('b5000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'Synthetic baseline staff', 'baseline-staff@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id, membership_role, app_role, is_primary, active) values
 ('b6000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'doctor', 'doctor', true, true);
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name) values
 ('b3000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'HID-STUVWXYZ', 'Baseline', 'Synthetic', 'Baseline Synthetic');
select set_config('app.actor_subject', 'synthetic:baseline', true);
select set_config('app.membership_id', 'b6000000-0000-4000-8000-000000000001', true);
select set_config('app.facility_id', 'b2000000-0000-4000-8000-000000000001', true);
select set_config('app.correlation_id', 'synthetic-baseline-01', true);
select set_config('app.purpose_of_use', 'direct-care', true);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status, started_at) values
 ('b7000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'b6000000-0000-4000-8000-000000000001', 'ambulatory', 'in_progress', '2026-01-01T00:00:00Z');
insert into ehr.clinical_notes (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id, note_type, title) values
 ('b8000000-0000-4000-8000-000000000001', 'b7000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'b6000000-0000-4000-8000-000000000001', 'synthetic', 'Synthetic restore baseline');
insert into ehr.clinical_note_revisions (id, clinical_note_id, patient_id, facility_id, revision_no, content, change_reason, created_by, created_by_membership_id) values
 ('b9000000-0000-4000-8000-000000000001', 'b8000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 1, 'SYNTHETIC restore content — Àdá 患者', 'Synthetic rehearsal', 'b0000000-0000-4000-8000-000000000001', 'b6000000-0000-4000-8000-000000000001');
insert into audit.events (event_id, correlation_id, actor_type, patient_id, action, outcome, provenance) values
 ('ba000000-0000-4000-8000-000000000001', 'synthetic-baseline-01', 'system', 'b3000000-0000-4000-8000-000000000001', 'migration.synthetic.baseline', 'success', 'system');
commit;
`;
