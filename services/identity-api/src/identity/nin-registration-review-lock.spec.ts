import { requestDigest } from '../common/idempotency';
import type { DataAccessContext } from '../common/request-context';
import { NinRegistrationService } from './nin-registration.service';

/**
 * A review locks only the registration case, then reads it in a new
 * statement (Phase 4 Stage 9). PostgreSQL refuses FOR UPDATE on the nullable
 * side of the patient join for every role (0A000), and under READ COMMITTED a
 * review that waited for a concurrent one must read that review's patient.
 * verify-registration-review-runtime.mjs runs both reviews against PostgreSQL.
 */
describe('NIN registration review case lock', () => {
  const caseId = '7d3b6a52-6f1e-4a8e-9b0c-1d2e3f4a5b6c';
  const patientId = '0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f';
  const input = { patientId, expectedVersion: 1, reason: 'Synthetic duplicate review', purpose: 'healthcare-operations' as const };
  const context = { actor: { subject: 'synthetic:registrar', accountId: 'account' }, facilityId: 'facility',
    membershipId: 'membership', correlationId: 'correlation', purposeOfUse: 'healthcare-operations' } as unknown as DataAccessContext;

  function service(lockedRows: unknown[]) {
    const statements: string[] = [];
    const client = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql.replace(/\s+/g, ' ').trim());
        if (/for update/i.test(sql)) return { rows: lockedRows, rowCount: lockedRows.length };
        return { rows: [{ id: caseId, status: 'linked_existing', row_version: '2', resolved_patient_id: patientId,
          resolved_hid_code: 'HID-ABCDEFGH', candidate_count: '1', review_idempotency_key: 'review-key-0000000001',
          review_request_sha256: requestDigest('identity.registration-case.link-existing', { caseId, input }) }], rowCount: 1 };
      }),
    };
    const database = { withTransaction: jest.fn(async (_context: unknown, operation: (c: unknown) => unknown) => operation(client)) };
    const audit = { recordWithClient: jest.fn(async () => undefined), record: jest.fn(async () => undefined) };
    const registrations = new NinRegistrationService(database as never, audit as never, {} as never, {} as never, {} as never);
    return { registrations, statements };
  }

  it('locks the case row alone, then reads the case and its patient after the lock', async () => {
    const { registrations, statements } = service([{ id: caseId }]);
    await expect(registrations.linkExisting(caseId, input, 'review-key-0000000001', context)).resolves.toMatchObject({
      status: 'linked_existing', patient: { patientId, hid: 'HID-ABCDEFGH' } });
    const [lock, read] = statements;
    expect(lock).toMatch(/^select registration\.id from identity\.registration_cases registration where .* for update$/);
    expect(lock).not.toMatch(/join/i);
    expect(read).toMatch(/left join identity\.patients patient/);
    expect(read).not.toMatch(/for (update|share)/i);
  });

  it('answers 404 without reading when the case is not visible to lock', async () => {
    const { registrations, statements } = service([]);
    await expect(registrations.linkExisting(caseId, input, 'review-key-0000000001', context))
      .rejects.toMatchObject({ code: 'REGISTRATION_CASE_NOT_FOUND' });
    expect(statements).toHaveLength(1);
  });
});
