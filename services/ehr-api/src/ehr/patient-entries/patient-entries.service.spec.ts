import 'reflect-metadata';
import { GUARDS_METADATA, HEADERS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA }
  from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AUDIT_FAILURES_ONLY, FACILITY_OPTIONAL, PATIENT_ALLOWED, REQUIRED_PERMISSIONS } from '../../common/decorators';
import { requestDigest } from '../../common/idempotency';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import type { AuditService } from '../../audit/audit.service';
import type { DatabaseService } from '../../database/database.service';
import type { ClinicalRepository } from '../shared/clinical.repository';
import type { IdentityApiService } from '../../integrations/identity-api.service';
import { PatientEntriesController } from './patient-entries.controller';
import { PATIENT_ENTRY_KINDS, type CreatePatientEntryDto } from './patient-entries.dto';
import { PatientEntriesEnabledGuard } from './patient-entries-enabled.guard';
import { decodePatientEntryCursor, readPatientEntries } from './patient-entries.query';
import { PatientEntriesService, lagosToday, normalizePatientEntry } from './patient-entries.service';

// Records patients add themselves, text only (0116; Akos handover step 6).
// Synthetic values only.
const actor = { kind: 'patient', patientId: 'patient-id', accountId: 'account-id', subject: 'subject', sessionId: 'session-id' };
const request = { actor, correlationId: 'patient-entries-test', header: () => undefined } as unknown as HidRequest;
const ENTRY_ID = '22222222-2222-4222-8222-222222222222';
const CREATED_AT = new Date('2026-11-02T09:15:00.000Z');
const body = (overrides: Partial<CreatePatientEntryDto> = {}): CreatePatientEntryDto => ({
  kind: 'visit', title: 'Malaria check-up', facilityName: 'Sunrise Clinic Ikeja', occurredOn: '2026-10-30',
  notes: 'Fever for three days.', ...overrides });
const row = (outcome: string, overrides: Record<string, unknown> = {}) => ({ outcome, entry_id: ENTRY_ID,
  entry_kind: 'visit', entry_title: 'Malaria check-up', entry_facility_name: 'Sunrise Clinic Ikeja',
  entry_occurred_on: '2026-10-30', entry_notes: 'Fever for three days.', entry_created_at: CREATED_AT, ...overrides });
const ITEM = { id: ENTRY_ID, source: 'patient', kind: 'visit', title: 'Malaria check-up', facilityName: 'Sunrise Clinic Ikeja',
  occurredOn: '2026-10-30', notes: 'Fever for three days.', createdAt: '2026-11-02T09:15:00.000Z', documents: [] };

function setup(rows: unknown[] = [row('created')]) {
  const authorization = { ...actor, expiresAt: new Date(Date.now() + 30_000).toISOString(), allowed: true };
  const authorizeSelf = jest.fn().mockResolvedValue(authorization);
  const query = jest.fn().mockResolvedValue({ rows });
  const client = { query } as unknown as PoolClient;
  const transaction = jest.fn(async (_auth: unknown, _correlation: string, work: (c: PoolClient) => Promise<unknown>) => work(client));
  const run = jest.fn(async (_context: unknown, _patient: string, _access: string, _event: unknown,
    operation: (c: PoolClient) => Promise<{ value: unknown; details?: unknown }>) => (await operation(client)).value);
  const recordWithClient = jest.fn().mockResolvedValue(undefined);
  const service = new PatientEntriesService({ withPatientTransaction: transaction } as unknown as DatabaseService,
    { authorizeSelf } as unknown as IdentityApiService, { run } as unknown as ClinicalRepository,
    { recordWithClient } as unknown as AuditService);
  return { service, authorizeSelf, query, transaction, run, client, recordWithClient };
}

async function problem(promise: Promise<unknown>): Promise<DomainProblem> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainProblem) return error;
    throw error;
  }
  throw new Error('No problem was raised');
}

function invalid(fields: Partial<CreatePatientEntryDto>, now = new Date('2026-11-02T12:00:00Z')): DomainProblem {
  try {
    normalizePatientEntry(body(fields), now);
  } catch (error) {
    if (error instanceof DomainProblem) return error;
    throw error;
  }
  throw new Error('No problem was raised');
}

describe('Records patients add: routes', () => {
  it('serves the contract\'s four routes with their decorators, behind the setting', () => {
    const prototype = PatientEntriesController.prototype as unknown as Record<string, () => unknown>;
    const routes = Object.getOwnPropertyNames(PatientEntriesController.prototype).filter((name) => name !== 'constructor')
      .map((name) => {
        const handler = prototype[name]!;
        return [name, Reflect.getMetadata(METHOD_METADATA, handler), Reflect.getMetadata(PATH_METADATA, handler),
          Reflect.getMetadata(HTTP_CODE_METADATA, handler) ?? null,
          Reflect.getMetadata(PATIENT_ALLOWED, handler) ?? false, Reflect.getMetadata(FACILITY_OPTIONAL, handler) ?? false,
          Reflect.getMetadata(REQUIRED_PERMISSIONS, handler) ?? null];
      });
    expect(Reflect.getMetadata(PATH_METADATA, PatientEntriesController)).toBe('ehr');
    expect(Reflect.getMetadata(AUDIT_FAILURES_ONLY, PatientEntriesController)).toBe(true);
    expect(Reflect.getMetadata(GUARDS_METADATA, PatientEntriesController)).toEqual([PatientEntriesEnabledGuard]);
    expect(routes).toEqual([
      ['create', RequestMethod.POST, 'me/patient-entries', 201, true, true, null],
      ['withdraw', RequestMethod.POST, 'me/patient-entries/:entryId/withdraw', 200, true, true, null],
      ['list', RequestMethod.GET, 'me/patient-entries', null, true, true, null],
      ['staffList', RequestMethod.GET, 'patients/:patientId/patient-entries', null, false, false, ['ehr.note.read']],
    ]);
    // Every answer is private and never cached.
    for (const name of ['create', 'withdraw', 'list', 'staffList']) {
      expect(Reflect.getMetadata(HEADERS_METADATA, prototype[name]!)).toEqual([{ name: 'Cache-Control', value: 'no-store' }]);
    }
    // The create handler reads the Idempotency-Key header.
    const args = Object.values(Reflect.getMetadata(ROUTE_ARGS_METADATA, PatientEntriesController, 'create') as
      Record<string, { data?: unknown }>).map((arg) => arg.data);
    expect(args).toContain('idempotency-key');
  });

  it('answers a staff read only for direct care', () => {
    const list = jest.fn();
    const controller = new PatientEntriesController({ staffList: list } as unknown as PatientEntriesService);
    const staffRequest = { actor: { kind: 'staff', facility: { membershipId: 'membership-id' } }, facilityId: 'facility-id',
      correlationId: 'patient-entries-staff', header: (name: string) => (name === 'x-purpose-of-use' ? 'healthcare-operations' : undefined) } as unknown as HidRequest;
    expect(() => controller.staffList('patient-id', {}, staffRequest)).toThrow('X-Purpose-Of-Use must be direct-care for clinical access');
    expect(list).not.toHaveBeenCalled();
  });
});

describe('Records patients add: what is accepted', () => {
  it('trims, keeps one-line titles of 2 to 160 characters, and makes a blank place or note none', () => {
    expect(normalizePatientEntry(body({ title: '  Malaria check-up  ', facilityName: '   ', notes: ' \r\n ' }),
      new Date('2026-11-02T12:00:00Z'))).toEqual({ kind: 'visit', title: 'Malaria check-up', facilityName: null,
      occurredOn: '2026-10-30', notes: null });
    expect(normalizePatientEntry(body({ facilityName: null, notes: undefined }), new Date('2026-11-02T12:00:00Z')))
      .toMatchObject({ facilityName: null, notes: null });
    expect(normalizePatientEntry(body({ title: 'Ok' })).title).toBe('Ok');
    expect(normalizePatientEntry(body({ title: 'é'.repeat(160) })).title).toHaveLength(160);
    // At most 160 UTF-16 units, as the website's form and reader count them (an emoji is two), and at least two
    // characters as the database counts them (code points), so that whatever is accepted is also shown.
    expect(normalizePatientEntry(body({ title: '\u{1F48A}'.repeat(80) })).title).toBe('\u{1F48A}'.repeat(80));
    expect(normalizePatientEntry(body({ title: '\u{1F48A}\u{1F48A}' })).title).toBe('\u{1F48A}\u{1F48A}');
    for (const title of ['X', ' X ', 'x'.repeat(161), 'Two\nlines', 'Tab\there', 'Bell\u0007', 'C1\u0085x', '', '   ',
      '\u{1F48A}', '\u{1F48A}'.repeat(81), '\u{1F48A}'.repeat(160)]) {
      const refused = invalid({ title });
      expect([refused.getStatus(), refused.code, refused.errors]).toEqual([400, 'VALIDATION_FAILED',
        [{ field: 'title', messages: ['Use 2 to 160 characters, on one line.'] }]]);
    }
  });

  it('keeps line breaks in notes (CRLF as a newline) up to 1000 characters, and nothing else unusual', () => {
    expect(normalizePatientEntry(body({ notes: 'Line one\r\nLine two\rLine three\n' })).notes)
      .toBe('Line one\nLine two\nLine three');
    expect(normalizePatientEntry(body({ notes: 'n'.repeat(1000) })).notes).toHaveLength(1000);
    expect(normalizePatientEntry(body({ notes: '\u{1F600}'.repeat(500) })).notes).toBe('\u{1F600}'.repeat(500));
    for (const notes of ['n'.repeat(1001), 'n'.repeat(2000), '\u{1F600}'.repeat(501), 'tab\there', 'nul\u0000x', 'del\u007fx']) {
      expect(invalid({ notes }).errors).toEqual([{ field: 'notes', messages: ['Use at most 1000 characters of plain text.'] }]);
    }
  });

  it('takes a place of at most 160 characters on one line', () => {
    expect(normalizePatientEntry(body({ facilityName: ' H ' })).facilityName).toBe('H');
    expect(normalizePatientEntry(body({ facilityName: 'h'.repeat(160) })).facilityName).toHaveLength(160);
    expect(normalizePatientEntry(body({ facilityName: '\u{1F3E5}'.repeat(80) })).facilityName).toHaveLength(160);
    for (const facilityName of ['h'.repeat(161), 'Line\nbreak', 'Tab\there', '\u{1F3E5}'.repeat(81)]) {
      expect(invalid({ facilityName }).errors).toEqual([{ field: 'facilityName',
        messages: ['Use at most 160 characters, on one line.'] }]);
    }
  });

  it('takes a real date from 1 January 1900 to today in Lagos', () => {
    // 23:30 UTC on 2 November is 00:30 on 3 November in Lagos.
    const lateNight = new Date('2026-11-02T23:30:00Z');
    expect(lagosToday(lateNight)).toBe('2026-11-03');
    expect(normalizePatientEntry(body({ occurredOn: '2026-11-03' }), lateNight).occurredOn).toBe('2026-11-03');
    expect(normalizePatientEntry(body({ occurredOn: '1900-01-01' }), lateNight).occurredOn).toBe('1900-01-01');
    expect(normalizePatientEntry(body({ occurredOn: '2024-02-29' }), lateNight).occurredOn).toBe('2024-02-29');
    for (const occurredOn of ['2026-11-04', '1899-12-31', '2026-02-30', '2026-13-01', '2026-00-10', '26-11-01', '2026-11-1', '']) {
      expect(invalid({ occurredOn }, lateNight).errors).toEqual([{ field: 'occurredOn',
        messages: ['Use a real date from 1 January 1900 to today.'] }]);
    }
    // 22:30 UTC is still 2 November in Lagos.
    expect(lagosToday(new Date('2026-11-02T22:30:00Z'))).toBe('2026-11-02');
    expect(invalid({ occurredOn: '2026-11-03' }, new Date('2026-11-02T22:30:00Z')).code).toBe('VALIDATION_FAILED');
  });

  it('takes the six kinds, and reports every invalid field at once', () => {
    expect(PATIENT_ENTRY_KINDS).toEqual(['visit', 'test', 'medicine', 'diagnosis', 'vaccination', 'other']);
    for (const kind of PATIENT_ENTRY_KINDS) expect(normalizePatientEntry(body({ kind })).kind).toBe(kind);
    const refused = invalid({ kind: 'vaccine' as never, title: 'X', occurredOn: '2099-01-01' });
    expect(refused.errors).toEqual([
      { field: 'kind', messages: ['Choose visit, test, medicine, diagnosis, vaccination or other.'] },
      { field: 'title', messages: ['Use 2 to 160 characters, on one line.'] },
      { field: 'occurredOn', messages: ['Use a real date from 1 January 1900 to today.'] },
    ]);
    expect(refused.message).toBe('One or more request fields are invalid.');
  });
});

describe('Records patients add: saving', () => {
  beforeEach(() => { jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }); jest.setSystemTime(new Date('2026-11-02T12:00:00Z')); });
  afterEach(() => { jest.useRealTimers(); });

  it('saves through the session-bound command, with the normalized fields, the key and their digest', async () => {
    const s = setup();
    await expect(s.service.create(request, body({ title: ' Malaria check-up ', notes: 'Fever for three days.\r\n' }),
      'web-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d')).resolves.toEqual({ entry: ITEM, replayed: false });
    expect(s.authorizeSelf).toHaveBeenCalledWith(request);
    expect(s.transaction).toHaveBeenCalledWith(expect.objectContaining({ patientId: 'patient-id' }), 'patient-entries-test',
      expect.any(Function));
    const [sql, values] = s.query.mock.calls[0]!;
    expect(sql).toContain('from ehr.create_my_patient_entry($1, $2, $3, $4::date, $5, $6, $7)');
    expect(sql).toContain('entry_occurred_on::text');
    const digest = requestDigest('ehr.patient-entry.create', { kind: 'visit', title: 'Malaria check-up',
      facilityName: 'Sunrise Clinic Ikeja', occurredOn: '2026-10-30', notes: 'Fever for three days.' });
    expect(values).toEqual(['visit', 'Malaria check-up', 'Sunrise Clinic Ikeja', '2026-10-30', 'Fever for three days.',
      'web-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', digest]);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('sends no key when the header is absent, refuses a malformed one, and digests what is saved, not how it was typed', async () => {
    const s = setup();
    await s.service.create(request, body(), undefined);
    expect(s.query.mock.calls[0]![1][5]).toBeNull();
    await s.service.create(request, body({ title: '  Malaria check-up', notes: '  Fever for three days.  ' }), undefined);
    expect(s.query.mock.calls[1]![1][6]).toBe(s.query.mock.calls[0]![1][6]);
    await s.service.create(request, body({ notes: 'Fever for four days.' }), undefined);
    expect(s.query.mock.calls[2]![1][6]).not.toBe(s.query.mock.calls[0]![1][6]);
    for (const key of ['short', '', 'has space in the key 1234', '-starts-with-a-dash-0001']) {
      const refused = await problem(s.service.create(request, body(), key));
      expect([refused.getStatus(), refused.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
    }
    expect(s.query).toHaveBeenCalledTimes(3);
  });

  it('answers a replay, and a no-key double tap within 60 seconds, with the same entry', async () => {
    const s = setup([row('replayed')]);
    await expect(s.service.create(request, body(), 'web-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'))
      .resolves.toEqual({ entry: ITEM, replayed: true });
    await expect(s.service.create(request, body(), undefined)).resolves.toEqual({ entry: ITEM, replayed: true });
  });

  it('refuses photos and files until they are served (422), before Identity or the database', async () => {
    const s = setup();
    for (const extra of [{ attachments: ['data:image/png;base64,AAAA'] }, { fileIds: [ENTRY_ID] },
      { attachments: [{}], fileIds: [] }]) {
      const refused = await problem(s.service.create(request, body(extra as Partial<CreatePatientEntryDto>), undefined));
      expect([refused.getStatus(), refused.code, refused.message]).toEqual([422, 'PATIENT_ENTRY_FILES_NOT_READY',
        'Photos can\'t be added yet. Save the record without them.']);
    }
    expect(s.authorizeSelf).not.toHaveBeenCalled();
    expect(s.transaction).not.toHaveBeenCalled();
    await expect(s.service.create(request, body({ attachments: [], fileIds: [] } as Partial<CreatePatientEntryDto>), undefined))
      .resolves.toMatchObject({ replayed: false });
  });

  it('refuses invalid fields before Identity or the database', async () => {
    const s = setup();
    const refused = await problem(s.service.create(request, body({ occurredOn: '2026-11-03' }), undefined));
    expect([refused.getStatus(), refused.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(s.authorizeSelf).not.toHaveBeenCalled();
  });

  it.each([
    ['key_reused', 409, 'IDEMPOTENCY_KEY_REUSED', 'This request was already used for a different record. Please try again.'],
    ['limited', 429, 'PATIENT_ENTRY_LIMITED', 'You\'ve added a lot of records today. Try again tomorrow.'],
  ])('answers %s as %i %s, after the transaction (its audit row is kept)', async (outcome, status, code, message) => {
    const s = setup([row(outcome as string, { entry_id: null })]);
    let committed = false;
    s.transaction.mockImplementation(async (_auth, _correlation, work) => {
      const value = await work(s.client);
      committed = true;
      return value;
    });
    const refused = await problem(s.service.create(request, body(), 'web-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'));
    expect([refused.getStatus(), refused.code, refused.message]).toEqual([status, code, message]);
    expect(committed).toBe(true);
  });

  it.each([
    ['42501', 403, 'PATIENT_ACCESS_DENIED'], ['22023', 400, 'PATIENT_ENTRY_INVALID'], ['23514', 400, 'PATIENT_ENTRY_INVALID'],
    ['22001', 400, 'PATIENT_ENTRY_INVALID'], ['22007', 400, 'PATIENT_ENTRY_INVALID'], ['22008', 400, 'PATIENT_ENTRY_INVALID'],
    ['22P02', 400, 'PATIENT_ENTRY_INVALID'], ['23505', 409, 'REQUEST_IN_PROGRESS'],
  ])('maps the database\'s %s to %i %s', async (sqlstate, status, code) => {
    const s = setup();
    s.query.mockRejectedValue(Object.assign(new Error('synthetic database refusal'), { code: sqlstate }));
    const refused = await problem(s.service.create(request, body(), undefined));
    expect([refused.getStatus(), refused.code]).toEqual([status, code]);
    expect(refused.message).not.toMatch(/synthetic|database|ehr\.|PATIENT_ENTRY/);
  });

  it('passes on other database faults, and refuses an answer with no row or an unknown outcome', async () => {
    const fault = setup();
    fault.query.mockRejectedValue(Object.assign(new Error('connection lost'), { code: '08006' }));
    await expect(fault.service.create(request, body(), undefined)).rejects.toThrow('connection lost');
    const empty = setup([]);
    const denied = await problem(empty.service.create(request, body(), undefined));
    expect([denied.getStatus(), denied.code]).toEqual([403, 'PATIENT_ACCESS_DENIED']);
    const unknown = setup([row('something_else')]);
    await expect(unknown.service.create(request, body(), undefined)).rejects.toThrow();
  });

  it('needs a patient session, and refuses one Identity maps elsewhere, before the database', async () => {
    const s = setup();
    const staff = { ...request, actor: { kind: 'staff', accountId: 'account-id', subject: 'staff' } } as unknown as HidRequest;
    expect((await problem(s.service.create(staff, body(), undefined))).code).toBe('PATIENT_SESSION_REQUIRED');
    expect((await problem(s.service.withdraw(staff, ENTRY_ID))).code).toBe('PATIENT_SESSION_REQUIRED');
    expect(s.authorizeSelf).not.toHaveBeenCalled();
    s.authorizeSelf.mockResolvedValue({ ...actor, patientId: 'other-patient' });
    const changed = await problem(s.service.create(request, body(), undefined));
    expect([changed.getStatus(), changed.code]).toEqual([403, 'PATIENT_ACCESS_DENIED']);
    expect(s.transaction).not.toHaveBeenCalled();
  });
});

describe('Records patients add: removing', () => {
  const WITHDRAWN_AT = new Date('2026-11-02T10:00:00.000Z');
  it('withdraws through the session-bound command; a repeat answers the first time, replayed', async () => {
    const s = setup([{ outcome: 'withdrawn', entry_id: ENTRY_ID, entry_withdrawn_at: WITHDRAWN_AT }]);
    await expect(s.service.withdraw(request, ENTRY_ID)).resolves.toEqual({
      entry: { id: ENTRY_ID, status: 'withdrawn', withdrawnAt: '2026-11-02T10:00:00.000Z' }, replayed: false });
    expect(s.authorizeSelf).toHaveBeenCalledWith(request);
    expect(s.query.mock.calls[0]![0]).toContain('from ehr.withdraw_my_patient_entry($1)');
    expect(s.query.mock.calls[0]![1]).toEqual([ENTRY_ID]);
    s.query.mockResolvedValue({ rows: [{ outcome: 'already_withdrawn', entry_id: ENTRY_ID, entry_withdrawn_at: WITHDRAWN_AT }] });
    await expect(s.service.withdraw(request, ENTRY_ID)).resolves.toEqual({
      entry: { id: ENTRY_ID, status: 'withdrawn', withdrawnAt: '2026-11-02T10:00:00.000Z' }, replayed: true });
  });

  it('answers an entry that is not the patient\'s with its own 404, never the plain one', async () => {
    const s = setup([{ outcome: 'not_found', entry_id: ENTRY_ID, entry_withdrawn_at: null }]);
    const missing = await problem(s.service.withdraw(request, ENTRY_ID));
    expect([missing.getStatus(), missing.code, missing.message]).toEqual([404, 'PATIENT_ENTRY_NOT_FOUND',
      'This record could not be found.']);
    s.query.mockRejectedValue(Object.assign(new Error('Patient self context is required'), { code: '42501' }));
    expect((await problem(s.service.withdraw(request, ENTRY_ID))).code).toBe('PATIENT_ACCESS_DENIED');
    const empty = setup([]);
    expect((await problem(empty.service.withdraw(request, ENTRY_ID))).code).toBe('PATIENT_ACCESS_DENIED');
  });
});

describe('Records patients add: reading', () => {
  const PATIENT = '60000000-0000-4000-8000-000000000001';
  const stored = (n: number) => ({ id: `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`, kind: 'test',
    title: `Synthetic test ${n}`, facility_name: null, occurred_on: '2026-10-01', notes: null,
    created_at: new Date('2026-10-01T08:00:00.123Z'), cursor_at: `2026-10-01T08:00:00.${String(123000 + n).padStart(6, '0')}Z` });
  const item = (n: number) => ({ id: stored(n).id, source: 'patient', kind: 'test', title: `Synthetic test ${n}`,
    facilityName: null, occurredOn: '2026-10-01', notes: null, createdAt: '2026-10-01T08:00:00.123Z', documents: [] });

  it('lists active entries newest first, 50 a page, with the date as text, no documents yet, and the next page\'s cursor', async () => {
    const query = jest.fn().mockResolvedValue({ rows: Array.from({ length: 51 }, (_, i) => stored(i)) });
    const page = await readPatientEntries({ query } as unknown as PoolClient, PATIENT);
    expect(page.more).toBe(true);
    expect(page.items).toHaveLength(50);
    expect(page.items[0]).toEqual(item(0));
    expect(page.items[49]).toEqual(item(49));
    const [sql, values] = query.mock.calls[0]!;
    expect(values).toEqual([PATIENT, null, null, null]);
    expect(sql).toMatch(/from ehr\.patient_entries\s+where patient_id = \$1 and status = 'active'/);
    expect(sql).toContain('($2::date is null or (occurred_on, created_at, id) < ($2::date, $3::timestamptz, $4::uuid))');
    expect(sql).toMatch(/order by occurred_on desc, created_at desc, id desc\s+limit 51/);
    expect(sql).toContain('occurred_on::text');
    // The cursor names the last item at the microsecond, as Postgres stores it, never from the JavaScript date.
    expect(sql).toContain('to_char(created_at at time zone \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') as cursor_at');
    expect(page.nextBefore).toMatch(/^[A-Za-z0-9_-]{16,512}$/);
    expect(decodePatientEntryCursor(page.nextBefore!, PATIENT)).toEqual({ occurredOn: '2026-10-01',
      createdAt: '2026-10-01T08:00:00.123049Z', id: stored(49).id });
    // The next page starts after that item.
    query.mockResolvedValue({ rows: [stored(50)] });
    const next = await readPatientEntries({ query } as unknown as PoolClient, PATIENT,
      decodePatientEntryCursor(page.nextBefore!, PATIENT));
    expect(query.mock.calls[1]![1]).toEqual([PATIENT, '2026-10-01', '2026-10-01T08:00:00.123049Z', stored(49).id]);
    expect(next).toEqual({ items: [item(50)], more: false, nextBefore: null });
  });

  it('refuses a cursor that is not exactly one it issued for this patient\'s list (400 INVALID_CURSOR)', () => {
    const query = { occurredOn: '2026-10-01', createdAt: '2026-10-01T08:00:00.123049Z', id: stored(49).id };
    const issued = Buffer.from(JSON.stringify({ v: 1, l: 'ehr.patient-entries', f: 'x', d: query.occurredOn,
      t: query.createdAt, i: query.id })).toString('base64url');
    const refusals = [issued, 'not-a-cursor-at-all-0000', '%%%%', 'x'.repeat(600)];
    for (const value of refusals) {
      let refused: unknown;
      try { decodePatientEntryCursor(value, PATIENT); } catch (error) { refused = error; }
      expect(refused).toBeInstanceOf(DomainProblem);
      expect([(refused as DomainProblem).getStatus(), (refused as DomainProblem).code]).toEqual([400, 'INVALID_CURSOR']);
      expect((refused as DomainProblem).message).toBe('This list changed. Load it again from the start.');
    }
    expect(decodePatientEntryCursor(undefined, PATIENT)).toBeUndefined();
  });

  it('gives the patient their list page by page, audited as their own read', async () => {
    const s = setup(Array.from({ length: 51 }, (_, i) => stored(i)));
    const self = { ...request, actor: { ...actor, patientId: PATIENT } } as unknown as HidRequest;
    s.authorizeSelf.mockResolvedValue({ ...actor, patientId: PATIENT, expiresAt: new Date(Date.now() + 30_000).toISOString() });
    const first = await s.service.list(self, undefined);
    expect(first.items).toHaveLength(50);
    expect(first).not.toHaveProperty('more');
    expect(s.authorizeSelf).toHaveBeenCalledWith(self);
    expect(s.query.mock.calls[0]![1]).toEqual([PATIENT, null, null, null]);
    expect(s.recordWithClient).toHaveBeenCalledWith(s.client, { correlationId: 'patient-entries-test', actorType: 'patient',
      actorSubject: 'subject', actorAccountId: 'account-id', patientId: PATIENT, action: 'ehr.patient.self.records.read',
      resourceType: 'patient-entries', outcome: 'success', purposeOfUse: 'patient-self',
      details: { entryCount: 50, more: true, continued: false } });
    s.query.mockResolvedValue({ rows: [stored(50)] });
    const second = await s.service.list(self, first.nextBefore!);
    expect(second).toEqual({ items: [item(50)], nextBefore: null });
    expect(s.query.mock.calls[1]![1]).toEqual([PATIENT, '2026-10-01', '2026-10-01T08:00:00.123049Z', stored(49).id]);
    expect(s.recordWithClient.mock.calls[1]![1].details).toEqual({ entryCount: 1, more: false, continued: true });
    // A cursor of another patient's list is refused before the database.
    const other = await problem(s.service.list(self, (await readPatientEntries({ query: jest.fn().mockResolvedValue({
      rows: Array.from({ length: 51 }, (_, i) => stored(i)) }) } as unknown as PoolClient, 'patient-id')).nextBefore!));
    expect([other.getStatus(), other.code]).toEqual([400, 'INVALID_CURSOR']);
    expect(s.transaction).toHaveBeenCalledTimes(2);
    const staff = { ...request, actor: { kind: 'staff', accountId: 'account-id', subject: 'staff' } } as unknown as HidRequest;
    expect((await problem(s.service.list(staff, undefined))).code).toBe('PATIENT_SESSION_REQUIRED');
  });

  it('gives a clinician the same list through the chart\'s read authorization, audited as a record view', async () => {
    const s = setup([stored(1)]);
    const context = { purposeOfUse: 'direct-care', facilityId: 'facility' } as DataAccessContext;
    let details: unknown;
    s.run.mockImplementation(async (_context, _patient, _access, _event, operation) => {
      const result = await operation(s.client);
      details = result.details;
      return result.value;
    });
    await expect(s.service.staffList(PATIENT, context, undefined)).resolves.toEqual({
      items: [expect.objectContaining({ id: stored(1).id, source: 'patient' })], more: false, nextBefore: null });
    expect(s.run).toHaveBeenCalledWith(context, PATIENT, 'read_records', { action: 'ehr.record.read',
      resourceType: 'patient-entries', resourceId: PATIENT }, expect.any(Function));
    expect(details).toEqual({ entryCount: 1, more: false });
    // And pages on with the same cursor.
    s.query.mockResolvedValue({ rows: Array.from({ length: 51 }, (_, i) => stored(i)) });
    const first = await s.service.staffList(PATIENT, context, undefined);
    expect(first).toMatchObject({ more: true, nextBefore: expect.any(String) });
    s.query.mockResolvedValue({ rows: [] });
    await s.service.staffList(PATIENT, context, first.nextBefore!);
    expect(s.query.mock.calls.at(-1)![1]).toEqual([PATIENT, '2026-10-01', '2026-10-01T08:00:00.123049Z', stored(49).id]);
    const tampered = await problem(s.service.staffList(PATIENT, context, `${first.nextBefore!}x`));
    expect(tampered.code).toBe('INVALID_CURSOR');
  });
});
