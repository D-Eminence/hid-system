import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { requestDigest } from '../common/idempotency';
import type { DataAccessContext, HidRequest } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { CreateRegistrationCaseDto } from './dto/create-registration-case.dto';
import { SaveRegistrationScreeningDto } from './dto/registration-screening.dto';
import { ExportRegistrationsDto } from './dto/export-registrations.dto';
import { ifMatchVersion, OutreachController } from './outreach.controller';
import { OutreachService } from './outreach.service';
import { assertScreeningPlausible, normalizeScreening, screeningRefusal } from './registration-screening';

// Synthetic identifiers and values only.
const ids = {
  facility: '123e4567-e89b-42d3-a456-426614174001',
  account: '123e4567-e89b-42d3-a456-426614174002',
  membership: '123e4567-e89b-42d3-a456-426614174003',
  case: '123e4567-e89b-42d3-a456-426614174004',
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
const key = 'screening-key-00000001';
const body = { bpSystolic: 128, bpDiastolic: 84, pulseBpm: 72, temperatureC: 36.8, weightKg: 70.5,
  glucoseValue: 5.6, glucoseUnit: 'mmol/L' as const, glucoseTiming: 'fasting' as const, malariaRdt: 'negative' as const,
  mainComplaint: '  Headache  for two days ', medicinesGiven: [{ name: 'Paracetamol', dose: '500 mg twice daily' }],
  referred: true, referredTo: 'General hospital' };
const fields = normalizeScreening(body);
const digest = requestDigest('registration_screening_save', { caseId: ids.case, ...fields });

function screeningRow(overrides: Record<string, unknown> = {}) {
  return { registration_case_id: ids.case, facility_id: ids.facility, bp_systolic: 128, bp_diastolic: 84,
    pulse_bpm: 72, temperature_c: '36.8', weight_kg: '70.5', height_cm: null, glucose_value: '5.6',
    glucose_unit: 'mmol/L', glucose_timing: 'fasting', malaria_rdt: 'negative', hearing_left: null, hearing_right: null,
    main_complaint: 'Headache for two days', seen_by_clinician: null, clinician_name: null, outcome: null,
    medicines_given: [{ name: 'Paracetamol', dose: '500 mg twice daily' }], referred: true,
    referred_to: 'General hospital', version: 1, recorded_at: new Date('2026-11-14T09:00:00.000Z'),
    recorded_by_membership_id: ids.membership, updated_at: new Date('2026-11-14T09:00:00.000Z'),
    idempotency_key: key, request_sha256: digest, ...overrides };
}

const caseVisible = { rows: [{ id: ids.case }] };
const audit = { recordWithClient: jest.fn() };
const identity = { authorizeExistingPatient: jest.fn() };
function service(query: jest.Mock) {
  const database = { withTransaction: jest.fn(async (_context: unknown, operation: (client: unknown) => unknown,
    _options?: unknown) => operation({ query })) };
  return { database, outreach: new OutreachService(database as never, audit as never, identity as never) };
}

describe('Outreach screening service (0118)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reads null when no screening was recorded, with one read audit row', async () => {
    const query = jest.fn().mockResolvedValueOnce(caseVisible).mockResolvedValueOnce({ rows: [] });
    await expect(service(query).outreach.getScreening(ids.case, context)).resolves.toBeNull();
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), context,
      'outreach.registration-screening.read', ids.case);
  });

  it('reads a screening as the API answers it', async () => {
    const query = jest.fn().mockResolvedValueOnce(caseVisible).mockResolvedValueOnce({ rows: [screeningRow()] });
    await expect(service(query).outreach.getScreening(ids.case, context)).resolves.toEqual({
      caseId: ids.case, bpSystolic: 128, bpDiastolic: 84, pulseBpm: 72, temperatureC: 36.8, weightKg: 70.5,
      heightCm: null, glucoseValue: 5.6, glucoseUnit: 'mmol/L', glucoseTiming: 'fasting', malariaRdt: 'negative',
      hearingLeft: null, hearingRight: null, mainComplaint: 'Headache for two days', seenByClinician: null,
      clinicianName: null, outcome: null, medicinesGiven: [{ name: 'Paracetamol', dose: '500 mg twice daily' }],
      referred: true, referredTo: 'General hospital', version: 1, recordedAt: '2026-11-14T09:00:00.000Z',
      recordedByMembershipId: ids.membership, updatedAt: '2026-11-14T09:00:00.000Z' });
  });

  it('answers 404 for a registration the session cannot see, without an audit row', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] });
    await expect(service(query).outreach.getScreening(ids.case, context))
      .rejects.toMatchObject({ status: 404, code: 'OUTREACH_REGISTRATION_NOT_FOUND' });
    await expect(service(jest.fn().mockResolvedValueOnce({ rows: [] })).outreach
      .saveScreening(ids.case, body, undefined, key, context))
      .rejects.toMatchObject({ status: 404, code: 'OUTREACH_REGISTRATION_NOT_FOUND' });
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('records the first save as version 1 (201) with the actor, digest and an audit row', async () => {
    const query = jest.fn().mockResolvedValueOnce(caseVisible).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [screeningRow()] });
    const { database, outreach } = service(query);
    await expect(outreach.saveScreening(ids.case, body, undefined, key, context))
      .resolves.toMatchObject({ status: 201, screening: { caseId: ids.case, version: 1, temperatureC: 36.8 } });
    expect(database.withTransaction.mock.calls[0]?.[2]).toEqual({ isolationLevel: 'SERIALIZABLE' });
    expect(query.mock.calls[1][0]).toContain('for update');
    const [sql, values] = query.mock.calls[2];
    expect(sql).toContain('insert into outreach.registration_screenings');
    expect(values).toEqual([ids.case, ids.facility, 128, 84, 72, 36.8, 70.5, null, 5.6, 'mmol/L', 'fasting', 'negative',
      null, null, 'Headache for two days', null, null, null,
      JSON.stringify([{ name: 'Paracetamol', dose: '500 mg twice daily' }]), true, 'General hospital',
      ids.account, ids.membership, key, digest]);
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), context,
      'outreach.registration-screening.recorded', ids.case);
  });

  it('replaces the whole screening as the next version (200) when If-Match is current', async () => {
    const query = jest.fn().mockResolvedValueOnce(caseVisible)
      .mockResolvedValueOnce({ rows: [screeningRow({ version: 2, idempotency_key: 'another-key-000000001' })] })
      .mockResolvedValueOnce({ rows: [screeningRow({ version: 3, bp_systolic: null, bp_diastolic: null })] });
    await expect(service(query).outreach.saveScreening(ids.case, { pulseBpm: 80 }, 2, key, context))
      .resolves.toMatchObject({ status: 200, screening: { version: 3, bpSystolic: null } });
    const [sql, values] = query.mock.calls[2];
    expect(sql).toContain('version=version+1');
    expect(values[1]).toBeNull();
    expect(values[3]).toBe(80);
    expect(values[17]).toBe('[]');
    expect(values.at(-1)).toBe(2);
  });

  it('replays the same key and body as the current screening, and refuses the key with another body', async () => {
    const replay = jest.fn().mockResolvedValueOnce(caseVisible).mockResolvedValueOnce({ rows: [screeningRow()] });
    await expect(service(replay).outreach.saveScreening(ids.case, body, undefined, key, context))
      .resolves.toMatchObject({ status: 200, screening: { version: 1 } });
    expect(replay).toHaveBeenCalledTimes(2);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
    const conflict = jest.fn().mockResolvedValueOnce(caseVisible).mockResolvedValueOnce({ rows: [screeningRow()] });
    await expect(service(conflict).outreach.saveScreening(ids.case, { ...body, pulseBpm: 90 }, 1, key, context))
      .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('refuses a save without If-Match once a screening exists, and a stale version', async () => {
    const other = screeningRow({ version: 2, idempotency_key: 'another-key-000000001' });
    const exists = jest.fn().mockResolvedValueOnce(caseVisible).mockResolvedValueOnce({ rows: [other] });
    await expect(service(exists).outreach.saveScreening(ids.case, body, undefined, key, context))
      .rejects.toMatchObject({ status: 409, code: 'OUTREACH_SCREENING_EXISTS' });
    const stale = jest.fn().mockResolvedValueOnce(caseVisible).mockResolvedValueOnce({ rows: [other] });
    await expect(service(stale).outreach.saveScreening(ids.case, body, 1, key, context))
      .rejects.toMatchObject({ status: 412, code: 'VERSION_CONFLICT' });
    const none = jest.fn().mockResolvedValueOnce(caseVisible).mockResolvedValueOnce({ rows: [] });
    await expect(service(none).outreach.saveScreening(ids.case, body, 1, key, context))
      .rejects.toMatchObject({ status: 412, code: 'VERSION_CONFLICT' });
    expect(stale).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ bpSystolic: 120 }, 'OUTREACH_SCREENING_INCOMPLETE'],
    [{ bpDiastolic: 80 }, 'OUTREACH_SCREENING_INCOMPLETE'],
    [{ glucoseValue: 5.5, glucoseUnit: 'mmol/L' as const }, 'OUTREACH_SCREENING_INCOMPLETE'],
    [{ glucoseUnit: 'mg/dL' as const }, 'OUTREACH_SCREENING_INCOMPLETE'],
    [{ referredTo: 'Clinic' }, 'OUTREACH_SCREENING_INCOMPLETE'],
    [{ referred: false, referredTo: 'Clinic' }, 'OUTREACH_SCREENING_INCOMPLETE'],
    [{ bpSystolic: 400, bpDiastolic: 80 }, 'OUTREACH_SCREENING_OUT_OF_RANGE'],
    [{ bpSystolic: 120, bpDiastolic: 10 }, 'OUTREACH_SCREENING_OUT_OF_RANGE'],
    [{ bpSystolic: 80, bpDiastolic: 120 }, 'OUTREACH_SCREENING_OUT_OF_RANGE'],
    [{ pulseBpm: 300 }, 'OUTREACH_SCREENING_OUT_OF_RANGE'],
    [{ temperatureC: 29.9 }, 'OUTREACH_SCREENING_OUT_OF_RANGE'],
    [{ weightKg: 0.4 }, 'OUTREACH_SCREENING_OUT_OF_RANGE'],
    [{ heightCm: 251 }, 'OUTREACH_SCREENING_OUT_OF_RANGE'],
    [{ glucoseValue: 41, glucoseUnit: 'mmol/L' as const, glucoseTiming: 'random' as const }, 'OUTREACH_SCREENING_OUT_OF_RANGE'],
    [{ glucoseValue: 17, glucoseUnit: 'mg/dL' as const, glucoseTiming: 'random' as const }, 'OUTREACH_SCREENING_OUT_OF_RANGE'],
  ])('refuses %j with 422 %s before the database', async (input, code) => {
    const { database, outreach } = service(jest.fn());
    await expect(outreach.saveScreening(ids.case, input, undefined, key, context))
      .rejects.toMatchObject({ status: 422, code });
    expect(database.withTransaction).not.toHaveBeenCalled();
  });

  it('names the field in plain words', () => {
    expect(() => assertScreeningPlausible(normalizeScreening({ bpSystolic: 20, bpDiastolic: 10 })))
      .toThrow('Check the blood pressure: systolic must be 50–300 mmHg.');
    expect(() => assertScreeningPlausible(normalizeScreening({ glucoseValue: 100, glucoseUnit: 'mg/dL',
      glucoseTiming: 'fasting', bpSystolic: 300, bpDiastolic: 200, pulseBpm: 20, temperatureC: 45,
      weightKg: 400, heightCm: 30 }))).not.toThrow();
  });

  it('answers the database refusals: redacted 409, case gone 404, check violations 422', async () => {
    for (const [error, status, code] of [
      [{ code: '55000', message: 'OUTREACH_REGISTRATION_REDACTED' }, 409, 'OUTREACH_REGISTRATION_REDACTED'],
      [{ code: '23514', message: 'OUTREACH_REGISTRATION_NOT_FOUND' }, 404, 'OUTREACH_REGISTRATION_NOT_FOUND'],
      [{ code: '23514', message: 'OUTREACH_SCREENING_MEDICINES_INVALID' }, 422, 'OUTREACH_SCREENING_OUT_OF_RANGE'],
      [{ code: '23514', message: 'new row violates check constraint',
        constraint: 'registration_screenings_glucose_ck' }, 422, 'OUTREACH_SCREENING_OUT_OF_RANGE'],
    ] as const) {
      const query = jest.fn().mockResolvedValueOnce(caseVisible).mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(Object.assign(new Error(error.message), error));
      await expect(service(query).outreach.saveScreening(ids.case, body, undefined, key, context))
        .rejects.toMatchObject({ status, code });
    }
    expect(screeningRefusal({ code: '23514', message: 'other', constraint: 'registration_cases_area_ck' })).toBeUndefined();
    const other = Object.assign(new Error('OUTREACH_SCREENING_ACTOR_MISMATCH'), { code: '42501' });
    const query = jest.fn().mockResolvedValueOnce(caseVisible).mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(other);
    await expect(service(query).outreach.saveScreening(ids.case, body, undefined, key, context)).rejects.toBe(other);
  });

  it('replays a concurrent first save with the same key after the retry, and answers 409 for another key', async () => {
    const database = Object.create(DatabaseService.prototype) as DatabaseService;
    const statements = jest.fn();
    const pool = { connect: async () => ({ release: () => undefined,
      query: async (sql: string, values?: unknown[]) => (/^(BEGIN|COMMIT|ROLLBACK|SET )/.test(sql)
        || sql.includes('set_config(') ? { rows: [] } : statements(sql, values)) }) };
    Object.assign(database, { pool, pauseBeforeRetry: async () => undefined });
    const duplicate = () => Object.assign(new Error('duplicate key value'), { code: '23505' });
    statements.mockResolvedValueOnce(caseVisible).mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(duplicate())
      .mockResolvedValueOnce(caseVisible).mockResolvedValueOnce({ rows: [screeningRow()] });
    const outreach = new OutreachService(database, audit as never, identity as never);
    await expect(outreach.saveScreening(ids.case, body, undefined, key, context))
      .resolves.toMatchObject({ status: 200, screening: { version: 1 } });
    statements.mockReset();
    statements.mockResolvedValueOnce(caseVisible).mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(duplicate())
      .mockResolvedValueOnce(caseVisible).mockResolvedValueOnce({ rows: [screeningRow({ idempotency_key: 'another-key-000000001' })] });
    await expect(outreach.saveScreening(ids.case, body, undefined, key, context))
      .rejects.toMatchObject({ status: 409, code: 'OUTREACH_SCREENING_EXISTS' });
  });
});

describe('Outreach registration area and hasScreening (0118)', () => {
  beforeEach(() => jest.clearAllMocks());
  const input = { localCommandId: ids.command, temporaryPatientId: 'tmp_123e4567-e89b-42d3-a456-426614174007',
    fullName: 'Ada Person', sex: 'female' as const, ageYears: 32 };
  const caseRow = { id: ids.case, facility_id: ids.facility, campaign_id: null, local_command_id: ids.command,
    temporary_patient_id: input.temporaryPatientId, status: 'identity_resolution_pending' as const,
    full_name: input.fullName, sex: input.sex, age_years: 32, phone: null, operational_notes: null,
    resolved_patient_id: null, resolution_kind: null, row_version: '1', created_at: new Date(), updated_at: new Date() };

  it('stores a trimmed area and answers it, and leaves the digest of a request without one unchanged', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...caseRow, area: 'Ikeja LGA' }] })
      .mockResolvedValue({ rows: [] });
    await expect(service(query).outreach.create({ ...input, area: '  Ikeja   LGA ' }, key, context))
      .resolves.toMatchObject({ area: 'Ikeja LGA', hasScreening: false });
    expect(query.mock.calls[1][1][11]).toBe('Ikeja LGA');
    const plain = jest.fn().mockResolvedValueOnce({ rows: [{ request_sha256: requestDigest(
      'outreach.registration-case.create', { ...input, phone: null, operationalNotes: null }),
    registration_case_id: ids.case }] }).mockResolvedValueOnce({ rows: [caseRow] }).mockResolvedValueOnce({ rows: [] });
    await expect(service(plain).outreach.create({ ...input, area: undefined }, key, context))
      .resolves.toMatchObject({ id: ids.case, area: null });
  });

  it('answers hasScreening on a read and the list', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [{ ...caseRow, area: null, has_screening: true }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(service(query).outreach.get(ids.case, context)).resolves.toMatchObject({ hasScreening: true, area: null });
    expect(query.mock.calls[0][0]).toContain('outreach.registration_screenings');
    const list = jest.fn().mockResolvedValueOnce({ rows: [{ ...caseRow, has_screening: false }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(service(list).outreach.list(context)).resolves.toMatchObject([{ hasScreening: false }]);
    expect(list.mock.calls[0][0]).toContain('has_screening');
  });

  it('validates the area: up to 100 characters, empty treated as not given', async () => {
    const base = { ...input, localCommandId: '123e4567-e89b-42d3-a456-426614174000' };
    const empty = plainToInstance(CreateRegistrationCaseDto, { ...base, area: '   ' });
    expect(await validate(empty)).toEqual([]);
    expect(empty.area).toBeUndefined();
    expect((await validate(plainToInstance(CreateRegistrationCaseDto, { ...base, area: 'x'.repeat(101) })))
      .map((error) => error.property)).toEqual(['area']);
    expect((await validate(plainToInstance(CreateRegistrationCaseDto, { ...base, area: 12 })))
      .map((error) => error.property)).toEqual(['area']);
  });
});

describe('SaveRegistrationScreeningDto', () => {
  const check = async (value: Record<string, unknown>) => (await validate(
    plainToInstance(SaveRegistrationScreeningDto, value), { whitelist: true, forbidNonWhitelisted: true }))
    .map((error) => error.property).sort();

  it('accepts an empty body, nulls and a full screening', async () => {
    expect(await check({})).toEqual([]);
    expect(await check({ bpSystolic: null, medicinesGiven: null, referredTo: null })).toEqual([]);
    expect(await check({ ...body, hearingLeft: 'pass', hearingRight: 'refer', seenByClinician: true,
      clinicianName: 'Nurse on duty', outcome: 'Advised rest and fluids', heightCm: 170 })).toEqual([]);
  });

  it('refuses wrong types, one-decimal overflow, unknown values and fields, long texts and more than 10 medicines', async () => {
    expect(await check({ bpSystolic: '120', pulseBpm: 72.5, temperatureC: 36.85, weightKg: '70',
      glucoseUnit: 'mmol', glucoseTiming: 'after food', malariaRdt: 'unknown', hearingLeft: 'fail',
      seenByClinician: 'yes', referred: 1, diagnosis: 'not screening data' })).toEqual([
      'bpSystolic', 'diagnosis', 'glucoseTiming', 'glucoseUnit', 'hearingLeft', 'malariaRdt', 'pulseBpm', 'referred',
      'seenByClinician', 'temperatureC', 'weightKg']);
    expect(await check({ mainComplaint: 'x'.repeat(201), clinicianName: 'x'.repeat(101), outcome: 'x'.repeat(501),
      referredTo: 'x'.repeat(201) })).toEqual(['clinicianName', 'mainComplaint', 'outcome', 'referredTo']);
    expect(await check({ medicinesGiven: Array.from({ length: 11 }, () => ({ name: 'Vitamin C' })) }))
      .toEqual(['medicinesGiven']);
    expect(await check({ medicinesGiven: [{ name: '   ' }] })).toEqual(['medicinesGiven']);
    expect(await check({ medicinesGiven: [{ name: 'x'.repeat(101) }] })).toEqual(['medicinesGiven']);
    expect(await check({ medicinesGiven: [{ name: 'ORS', dose: 'x'.repeat(201) }] })).toEqual(['medicinesGiven']);
    expect(await check({ medicinesGiven: [{ name: 'ORS', strength: 'high' }] })).toEqual(['medicinesGiven']);
    expect(await check({ medicinesGiven: 'Paracetamol' })).toEqual(['medicinesGiven']);
  });
});

describe('The screening routes', () => {
  const request = (headers: Record<string, string>) => ({ header: (name: string) => headers[name],
    actor: context.actor, facilityId: ids.facility, correlationId: context.correlationId } as unknown as HidRequest);
  const routed = expect.objectContaining({ facilityId: ids.facility, membershipId: ids.membership });
  const response = () => ({ status: jest.fn(), setHeader: jest.fn() });

  it('reads If-Match as a positive version, absent as undefined, anything else 428', () => {
    expect(ifMatchVersion(undefined)).toBeUndefined();
    expect(ifMatchVersion('"3"')).toBe(3);
    expect(ifMatchVersion('W/"4"')).toBe(4);
    expect(ifMatchVersion('5')).toBe(5);
    for (const bad of ['"0"', '"abc"', '*', '"1.5"', '"-1"']) {
      expect(() => ifMatchVersion(bad)).toThrow(expect.objectContaining({ code: 'IF_MATCH_REQUIRED' }));
    }
  });

  it('answers a screening with its ETag, and null without one', async () => {
    const screening = { version: 2 };
    const outreach = { getScreening: jest.fn().mockResolvedValueOnce(screening).mockResolvedValueOnce(null) };
    const controller = new OutreachController(outreach as never);
    const first = response();
    await expect(controller.getScreening(ids.case, request({}), first as never)).resolves.toEqual({ screening });
    expect(first.setHeader).toHaveBeenCalledWith('ETag', '"2"');
    const second = response();
    await expect(controller.getScreening(ids.case, request({}), second as never)).resolves.toEqual({ screening: null });
    expect(second.setHeader).not.toHaveBeenCalled();
  });

  it('saves with the Idempotency-Key and If-Match, answering the status and ETag', async () => {
    const outreach = { saveScreening: jest.fn(async () => ({ status: 201, screening: { version: 1 } })) };
    const controller = new OutreachController(outreach as never);
    const answer = response();
    await expect(controller.saveScreening(ids.case, {}, request({ 'idempotency-key': key }), answer as never))
      .resolves.toEqual({ screening: { version: 1 } });
    expect(outreach.saveScreening).toHaveBeenCalledWith(ids.case, {}, undefined, key, routed);
    expect(answer.status).toHaveBeenCalledWith(201);
    expect(answer.setHeader).toHaveBeenCalledWith('ETag', '"1"');
    await controller.saveScreening(ids.case, {}, request({ 'idempotency-key': key, 'if-match': '"1"' }), response() as never);
    expect(outreach.saveScreening).toHaveBeenLastCalledWith(ids.case, {}, 1, key, routed);
    await expect(controller.saveScreening(ids.case, {}, request({}), response() as never))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    await expect(controller.saveScreening(ids.case, {}, request({ 'idempotency-key': key, 'if-match': 'x' }),
      response() as never)).rejects.toMatchObject({ status: 428, code: 'IF_MATCH_REQUIRED' });
  });
});

describe('The screening codes match migration 0118', () => {
  const migration = join(__dirname, '../../../ehr-api/database/migrations/0118_outreach_screening.sql');
  (existsSync(migration) ? it : it.skip)('maps the messages and constraints the migration raises', () => {
    const sql = readFileSync(migration, 'utf8');
    for (const message of ['OUTREACH_REGISTRATION_REDACTED', 'OUTREACH_REGISTRATION_NOT_FOUND',
      'OUTREACH_SCREENING_MEDICINES_INVALID']) expect(sql).toContain(`message = '${message}'`);
    for (const constraint of ['registration_screenings_bp_ck', 'registration_screenings_glucose_ck',
      'registration_screenings_referral_ck']) expect(sql).toContain(`constraint ${constraint}`);
    expect(sql).toContain("idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'");
  });
});

describe('Recording an export of the registration list (0118 follow-up)', () => {
  it('validates the format, the count and the campaign', async () => {
    const errors = async (input: Record<string, unknown>) => (await validate(plainToInstance(ExportRegistrationsDto, input),
      { whitelist: true, forbidNonWhitelisted: true })).map((error) => error.property);
    expect(await errors({ format: 'xlsx', count: 12 })).toEqual([]);
    expect(await errors({ format: 'docx', count: 0, campaignId: ids.case })).toEqual([]);
    expect(await errors({ format: 'zip', count: 12 })).toEqual(['format']);
    expect(await errors({ format: 'csv', count: -1 })).toEqual(['count']);
    expect(await errors({ format: 'csv', count: 1.5 })).toEqual(['count']);
    expect(await errors({ format: 'csv', count: 3, campaignId: 'not-a-uuid' })).toEqual(['campaignId']);
    expect(await errors({ format: 'csv', count: 3, rows: [] })).toEqual(['rows']);
  });

  it('writes one audit row with the format, count and campaign only', async () => {
    const query = jest.fn(async () => ({ rows: [{ '?column?': 1 }], rowCount: 1 }));
    const recordExportWithClient = jest.fn();
    const database = { withTransaction: jest.fn(async (_context: unknown, operation: (client: unknown) => unknown) =>
      operation({ query })) };
    const outreach = new OutreachService(database as never, { recordExportWithClient } as never, identity as never);
    await outreach.recordExport({ format: 'pdf', count: 40, campaignId: ids.case }, context);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('from outreach.campaigns'), [ids.case, ids.facility]);
    expect(recordExportWithClient).toHaveBeenCalledWith(expect.anything(), context,
      { format: 'pdf', count: 40, campaignId: ids.case });
    await outreach.recordExport({ format: 'csv', count: 3 }, context);
    expect(recordExportWithClient).toHaveBeenLastCalledWith(expect.anything(), context,
      { format: 'csv', count: 3, campaignId: null });
  });

  it('refuses a campaign of another facility (404) without an audit row', async () => {
    const query = jest.fn(async () => ({ rows: [], rowCount: 0 }));
    const recordExportWithClient = jest.fn();
    const database = { withTransaction: jest.fn(async (_context: unknown, operation: (client: unknown) => unknown) =>
      operation({ query })) };
    const outreach = new OutreachService(database as never, { recordExportWithClient } as never, identity as never);
    await expect(outreach.recordExport({ format: 'pdf', count: 1, campaignId: ids.case }, context))
      .rejects.toMatchObject({ status: 404, code: 'OUTREACH_CAMPAIGN_NOT_FOUND' });
    expect(recordExportWithClient).not.toHaveBeenCalled();
  });

  it('is a 204 route needing outreach.registration.read', async () => {
    const outreach = { recordExport: jest.fn(async () => undefined) };
    const controller = new OutreachController(outreach as never);
    const request = { header: () => undefined, actor: context.actor, facilityId: ids.facility,
      correlationId: context.correlationId } as unknown as HidRequest;
    await expect(controller.recordExport({ format: 'csv', count: 2 }, request)).resolves.toBeUndefined();
    expect(outreach.recordExport).toHaveBeenCalledWith({ format: 'csv', count: 2 },
      expect.objectContaining({ facilityId: ids.facility }));
    expect(Reflect.getMetadata('__httpCode__', OutreachController.prototype.recordExport)).toBe(204);
    expect(Reflect.getMetadata('path', OutreachController.prototype.recordExport)).toBe('/exports');
  });
});
