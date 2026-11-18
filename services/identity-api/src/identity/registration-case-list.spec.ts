import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { DataAccessContext } from '../common/request-context';
import { ListRegistrationCasesDto } from './dto/list-registration-cases.dto';
import { NinRegistrationController } from './nin-registration.controller';
import { decodeCaseCursor, encodeCaseCursor, NinRegistrationService } from './nin-registration.service';

/**
 * SX-10: GET identity/registration-cases?view=mine|facility.
 * Fictional people and identifiers only.
 */
const facilityA = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const facilityB = '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a';
const deskAccount = 'f0e1d2c3-b4a5-4968-8776-655443322110';
const otherAccount = 'a1a2a3a4-b5b6-4c7c-8d8d-e9e9f0f0a1a1';
const patientId = '6b1f0d2e-3c4a-4b5d-8e6f-7a8b9c0d1e2f';

function contextFor(facilityId: string, permissions: string[]): DataAccessContext {
  return {
    actor: { kind: 'staff', subject: 'synthetic:desk', accountId: deskAccount, permissions,
      facility: { organizationId: 'org-synthetic' } },
    facilityId, membershipId: 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f',
    correlationId: 'correlation-list-0001', purposeOfUse: 'healthcare-operations',
  } as unknown as DataAccessContext;
}
const desk = contextFor(facilityA, ['identity.registration.write']);
const approver = contextFor(facilityA, ['identity.registration.write', 'identity.registration.approve']);

interface StoredCase {
  facility: string;
  createdBy: string;
  row: Record<string, unknown>;
}

function stored(facility: string, createdBy: string, index: number, extra: Record<string, unknown> = {}): StoredCase {
  const second = String(59 - index).padStart(2, '0');
  return {
    facility,
    createdBy,
    row: {
      id: `1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c${String(index).padStart(2, '0')}`,
      status: 'pending_new_identity_approval', row_version: '1', resolved_patient_id: null, resolved_hid_code: null,
      candidate_count: '0', contact_recorded: true, nin_verified: true,
      full_name: `Ada Fictional${index}`, dob: '1991-04-05',
      created_at: new Date(`2026-11-18T10:00:${second}.000Z`), updated_at: new Date(`2026-11-18T10:05:${second}.000Z`),
      created_at_cursor: `2026-11-18 10:00:${second}.123456+00`,
      created_by_me: createdBy === deskAccount,
      // Present in the fake table only, to prove it is never projected.
      nin_last4: '8901',
      ...extra,
    },
  };
}

/**
 * A fake database that applies the list's own filters: the facility the
 * transaction runs for (platform.current_facility_id()), the view and the
 * status. It refuses a query without the facility filter.
 */
function fakeDatabase(table: StoredCase[]) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  let currentFacility = '';
  const client = {
    query: jest.fn(async (sql: string, values: unknown[] = []) => {
      statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
      if (!sql.includes('registration.facility_id = platform.current_facility_id()')) throw new Error('No facility filter');
      const [view, account, status, , , limit] = values as [string, string, string | null, unknown, unknown, number];
      const rows = table
        .filter((item) => item.facility === currentFacility)
        .filter((item) => view === 'facility' || item.createdBy === account)
        .filter((item) => status === null || item.row.status === status)
        .map((item) => item.row)
        .slice(0, limit);
      return { rows, rowCount: rows.length };
    }),
  };
  const database = {
    withTransaction: jest.fn(async (context: DataAccessContext, work: (c: unknown) => unknown) => {
      currentFacility = context.facilityId;
      return work(client);
    }),
  };
  const audit = { recordWithClient: jest.fn(async () => undefined), record: jest.fn(async () => undefined) };
  const service = new NinRegistrationService(database as never, audit as never, {} as never, {} as never, {} as never);
  return { service, statements, audit, database };
}

const query = (input: Record<string, unknown> = {}) => plainToInstance(ListRegistrationCasesDto, input);

describe('SX-10 registration-case list', () => {
  const table = [
    stored(facilityA, deskAccount, 1),
    stored(facilityA, otherAccount, 2),
    stored(facilityA, deskAccount, 3, { status: 'approved_new_identity', row_version: '2',
      resolved_patient_id: patientId, resolved_hid_code: 'HID-QX7K2M' }),
    stored(facilityB, deskAccount, 4),
  ];

  it('answers the desk its own cases at this facility, with no NIN digits', async () => {
    const { service, statements } = fakeDatabase(table);
    const answer = await service.listCases(query(), desk);
    expect(answer.view).toBe('mine');
    expect(answer.cases.map((item) => item.fullName)).toEqual(['Ada Fictional1', 'Ada Fictional3']);
    expect(answer.nextCursor).toBeNull();
    expect(answer.cases[0]).toEqual({
      caseId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c01', status: 'pending_new_identity_approval', version: 1,
      candidateCount: 0, contactRecorded: true, ninStatus: 'verified', fullName: 'Ada Fictional1',
      dateOfBirth: '1991-04-05', createdAt: '2026-11-18T10:00:58.000Z', updatedAt: '2026-11-18T10:05:58.000Z',
      createdByMe: true,
    });
    expect(answer.cases[1]).toMatchObject({ status: 'approved_new_identity',
      patient: { patientId, hid: 'HID-QX7K2M' } });
    const body = JSON.stringify(answer);
    expect(body).not.toContain('8901');
    expect(body).not.toMatch(/nin_|last4|unverified/i);
    const [{ sql, values }] = statements as [{ sql: string; values: unknown[] }];
    expect(sql).not.toMatch(/nin_last4|nin_ciphertext|nin_lookup_hmac|verification_reference/);
    expect(sql).toContain('order by registration.created_at desc, registration.id desc');
    expect(values).toEqual(['mine', deskAccount, null, null, null, 51]);
  });

  it('shows another facility nothing', async () => {
    const { service } = fakeDatabase(table);
    const elsewhere = contextFor(facilityB, ['identity.registration.write', 'identity.registration.approve']);
    const answer = await service.listCases(query({ view: 'facility' }), elsewhere);
    expect(answer.cases.map((item) => item.fullName)).toEqual(['Ada Fictional4']);
    const nowhere = contextFor('77777777-7777-4777-8777-777777777777', ['identity.registration.write',
      'identity.registration.approve']);
    await expect(service.listCases(query({ view: 'facility' }), nowhere)).resolves.toMatchObject({ cases: [] });
  });

  it('answers an approver every case at this facility', async () => {
    const { service } = fakeDatabase(table);
    const answer = await service.listCases(query({ view: 'facility' }), approver);
    expect(answer.cases.map((item) => [item.fullName, item.createdByMe])).toEqual([
      ['Ada Fictional1', true], ['Ada Fictional2', false], ['Ada Fictional3', true]]);
  });

  it('refuses view=facility to a member who does not approve registrations, and audits it', async () => {
    const { service, database, audit } = fakeDatabase(table);
    await expect(service.listCases(query({ view: 'facility' }), desk)).rejects.toMatchObject({
      status: 403, code: 'REGISTRATION_CASE_LIST_DENIED',
      message: 'Only staff who approve registrations can see every case at this facility.' });
    expect(database.withTransaction).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'identity.registration-case.list', outcome: 'denied', details: { view: 'facility' } }));
  });

  it('audits every list with the cases and patients shown', async () => {
    const { service, audit } = fakeDatabase(table);
    await service.listCases(query({ status: 'approved_new_identity' }), desk);
    expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'identity.registration-case.list', outcome: 'success', resourceType: 'registration-case',
      actorAccountId: deskAccount, facilityId: facilityA,
      details: { view: 'mine', status: 'approved_new_identity', page: 'first', count: 1,
        caseIds: ['1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c03'], patientIds: [patientId] },
    }));
    expect(JSON.stringify(audit.recordWithClient.mock.calls)).not.toContain('Ada Fictional');
  });

  it('pages with an opaque cursor', async () => {
    const { service, statements } = fakeDatabase(table);
    const first = await service.listCases(query({ view: 'facility', limit: '2' }), approver);
    expect(first.cases).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]+$/));
    expect(decodeCaseCursor(first.nextCursor!)).toEqual({
      createdAt: '2026-11-18 10:00:57.123456+00', caseId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c02' });
    await service.listCases(query({ view: 'facility', limit: '2', cursor: first.nextCursor }), approver);
    expect(statements[1]!.values).toEqual(['facility', deskAccount, null,
      '2026-11-18 10:00:57.123456+00', '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c02', 3]);
  });

  it.each([
    ['not base64 JSON', 'bm90LWpzb24'],
    ['a wrong shape', encodeCaseCursor('yesterday', 'not-a-uuid')],
    ['SQL in the date', Buffer.from(JSON.stringify(["2026-11-18'; drop table x; --", patientId])).toString('base64url')],
  ])('refuses a cursor that is %s', async (_label, cursor) => {
    const { service, database } = fakeDatabase(table);
    await expect(service.listCases(query({ cursor }), desk)).rejects.toMatchObject({
      status: 400, code: 'REGISTRATION_CASE_CURSOR_INVALID' });
    expect(database.withTransaction).not.toHaveBeenCalled();
  });

  describe('query parameters', () => {
    const errorsFor = async (input: Record<string, unknown>) => validate(query(input), {
      whitelist: true, forbidNonWhitelisted: true });

    it('defaults to view=mine and 50 cases', () => {
      expect(query()).toMatchObject({ view: 'mine', limit: 50 });
    });

    it.each([
      [{ view: 'everyone' }],
      [{ status: 'unknown' }],
      [{ limit: '0' }],
      [{ limit: '101' }],
      [{ cursor: 'has spaces' }],
      // Health IDs are never taken in a URL.
      [{ hid: 'HID-QX7K2M' }],
      [{ healthId: 'HID-QX7K2M' }],
    ])('refuses %p', async (input) => {
      expect((await errorsFor(input)).length).toBeGreaterThan(0);
    });

    it('accepts view, status, limit and cursor', async () => {
      expect(await errorsFor({ view: 'facility', status: 'review_required', limit: '10', cursor: 'abc_DEF-123' }))
        .toEqual([]);
    });
  });

  it('is routed through the controller with the request context', async () => {
    const registrations = { listCases: jest.fn(async () => ({ view: 'mine', cases: [], nextCursor: null })) };
    const routes = new NinRegistrationController(registrations as never);
    const request = {
      actor: { kind: 'staff', subject: 'synthetic:desk', accountId: deskAccount, permissions: [] },
      facilityId: facilityA, correlationId: 'correlation-list-0002',
      header: (name: string) => (name === 'x-purpose-of-use' ? 'healthcare-operations' : undefined),
    };
    await routes.listCases(query(), request as never);
    expect(registrations.listCases).toHaveBeenCalledWith(expect.objectContaining({ view: 'mine' }),
      expect.objectContaining({ facilityId: facilityA, purposeOfUse: 'healthcare-operations' }));
  });
});
