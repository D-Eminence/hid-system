import { requestDigest } from '../common/idempotency';
import type { DataAccessContext } from '../common/request-context';
import { OutreachService } from './outreach.service';

const ids = {
  facility: '123e4567-e89b-42d3-a456-426614174001',
  account: '123e4567-e89b-42d3-a456-426614174002',
  membership: '123e4567-e89b-42d3-a456-426614174003',
  case: '123e4567-e89b-42d3-a456-426614174004',
  patient: '123e4567-e89b-42d3-a456-426614174005',
  command: '123e4567-e89b-42d3-a456-426614174006',
};
const context: DataAccessContext = {
  correlationId: 'correlation-12345678', facilityId: ids.facility, membershipId: ids.membership,
  purposeOfUse: 'direct-care', userCookie: 'hid_session=opaque', csrfToken: 'csrf',
  origin: 'http://localhost:3000', actor: {
    id: 'staff:test', subject: 'staff:test', accountId: ids.account, authenticationMethod: 'local',
    roles: ['nurse'], permissions: ['outreach.registration.write'], facilityIds: [ids.facility],
    facilities: [], facility: { id: ids.facility, membershipId: ids.membership,
      organizationId: ids.facility, name: 'Test', roles: ['nurse'],
      permissions: ['outreach.registration.write'], isPrimary: true },
  },
};
const input = { localCommandId: ids.command,
  temporaryPatientId: 'tmp_123e4567-e89b-42d3-a456-426614174007',
  fullName: 'Ada Person', sex: 'female' as const, ageYears: 32 };
const row = { id: ids.case, facility_id: ids.facility, local_command_id: ids.command,
  temporary_patient_id: input.temporaryPatientId, status: 'identity_resolution_pending' as const,
  full_name: input.fullName, sex: input.sex, age_years: 32, phone: null,
  operational_notes: null, resolved_patient_id: null, resolution_kind: null,
  row_version: '1', created_at: new Date(), updated_at: new Date() };

describe('OutreachService', () => {
  const audit = { recordWithClient: jest.fn() };
  const identity = { authorizeExistingPatient: jest.fn() };
  beforeEach(() => jest.clearAllMocks());

  it('atomically creates pending intake, history, idempotency, outbox, and semantic audit', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const database = { withTransaction: jest.fn(async (_context, operation) => operation({ query })) };
    const service = new OutreachService(database as never, audit as never, identity as never);
    await expect(service.create(input, 'idempotency-key-1234', context)).resolves.toMatchObject({
      id: ids.case, temporaryPatientId: input.temporaryPatientId, resolvedPatientId: null,
      status: 'identity_resolution_pending',
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('registration_case_events'))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('command_idempotency'))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('outbox_events'))).toBe(true);
    expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
  });

  it('returns the same case for an identical idempotent replay without duplicate evidence', async () => {
    const digest = requestDigest('outreach.registration-case.create', { ...input,
      fullName: input.fullName, phone: null, operationalNotes: null });
    const query = jest.fn().mockResolvedValueOnce({ rows: [{ request_sha256: digest,
      registration_case_id: ids.case }] }).mockResolvedValueOnce({ rows: [row] });
    const database = { withTransaction: jest.fn(async (_context, operation) => operation({ query })) };
    await expect(new OutreachService(database as never, audit as never, identity as never)
      .create(input, 'idempotency-key-1234', context)).resolves.toMatchObject({ id: ids.case });
    expect(query).toHaveBeenCalledTimes(2);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('requires Identity authorization before opening a patient-link transaction', async () => {
    identity.authorizeExistingPatient.mockRejectedValueOnce(new Error('Identity denied'));
    const database = { withTransaction: jest.fn() };
    await expect(new OutreachService(database as never, audit as never, identity as never)
      .linkExisting(ids.case, { canonicalPatientId: ids.patient, expectedVersion: 1,
        reason: 'Reviewed exact Identity match' }, 'link-key-1234', context)).rejects.toThrow('Identity denied');
    expect(database.withTransaction).not.toHaveBeenCalled();
  });
});
