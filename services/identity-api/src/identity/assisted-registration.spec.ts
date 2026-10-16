jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import { createHmac } from 'node:crypto';
import { RequestMethod, type ArgumentsHost, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Response } from 'express';
import type { PoolClient } from 'pg';
import { AUDIT_ACTION, NO_AUDIT, PUBLIC_ROUTE, REQUIRED_PERMISSIONS } from '../common/decorators';
import { DomainProblem, ProblemDetailsFilter, PublicDetailProblem, RetryAfterProblem } from '../common/problem';
import type { DataAccessContext, HidRequest } from '../common/request-context';
import { globalValidationPipe } from '../common/validation-problem';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { matchDocument, normalizeDocumentName } from './assisted-match';
import { AssistedRegistrationEnabledGuard } from './assisted-registration.guard';
import { AssistedVerificationController } from './assisted-verification.controller';
import { AssistedVerificationService } from './assisted-verification.service';
import { DESK_CODE_ALPHABET, deskCodeFromDigest, normalizeDeskCode } from './desk-code';
import { AssistedVerificationDto } from './dto/assisted-verification.dto';
import type { PatientEnrollmentService } from './patient-enrollment.service';

/** Facility-assisted registration (ADR-063): desk codes, the blind compare, the staff route. */
const originalEnvironment = { ...process.env };
const correlationId = 'assisted-verification-test';
const enrollmentId = '7b0d64e4-1d39-4e3a-9a52-6f0c2a7e1001';
const verificationId = '7b0d64e4-1d39-4e3a-9a52-6f0c2a7e2001';
const facilityId = '7b0d64e4-1d39-4e3a-9a52-6f0c2a7e3001';
const membershipId = '7b0d64e4-1d39-4e3a-9a52-6f0c2a7e4001';
const ninDigest = 'c'.repeat(64);
const deskHmac = 'd'.repeat(64);
const context: DataAccessContext = {
  correlationId, facilityId, membershipId, purposeOfUse: 'healthcare-operations',
  actor: { id: 'synthetic:nurse', subject: 'synthetic:nurse', accountId: '7b0d64e4-1d39-4e3a-9a52-6f0c2a7e5001',
    sessionId: '7b0d64e4-1d39-4e3a-9a52-6f0c2a7e6001', roles: ['nurse'],
    permissions: ['identity.patient.assisted_registration'], facilityIds: [facilityId], facilities: [],
    authenticationMethod: 'local', kind: 'staff' },
};
const attestations = { patientPresent: true, originalDocumentSeen: true, photoMatchesPerson: true,
  codeShownOnPatientsOwnDevice: true, patientConsents: true };
const body = (overrides: Record<string, unknown> = {}) => ({ deskCode: '7KQ2M-9XBTR', method: 'government_photo_id_in_person',
  documentType: 'national_id_card', document: { firstName: 'Ada', lastName: 'Okafor', dateOfBirth: '1990-01-02' },
  attestations: { ...attestations }, ...overrides });

function answered(error: unknown) {
  const response = { status: jest.fn().mockReturnThis(), type: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const host = { switchToHttp: () => ({
    getRequest: () => ({ correlationId, method: 'POST', route: { path: '/identity/assisted-verifications' } } as unknown as HidRequest),
    getResponse: () => response as unknown as Response,
  }) } as unknown as ArgumentsHost;
  new ProblemDetailsFilter().catch(error, host);
  return response.json.mock.calls[0]?.[0];
}

async function problem(promise: Promise<unknown>): Promise<DomainProblem> {
  const error = await promise.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(DomainProblem);
  return error as DomainProblem;
}

function environment(values: Record<string, string> = {}) {
  Object.assign(process.env, {
    NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
    CORS_ORIGINS: 'https://www.healthidentitydirectory.com', AUTH_MODE: 'local',
    AUTH_SIGNING_SECRET: '01234567890123456789012345678901', AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
    ASSISTED_REGISTRATION_ENABLED: 'true', ...values,
  });
  resetEnvironmentForTests();
}

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
  resetEnvironmentForTests();
});

describe('desk codes', () => {
  it('derives ten Crockford base32 characters (50 bits) from a digest', () => {
    const code = deskCodeFromDigest(createHmac('sha256', 'k').update('a').digest());
    expect(code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$/);
    expect(DESK_CODE_ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
    // Fifty bits: only the first 50 bits of the digest decide the code.
    const digest = Buffer.alloc(32, 0);
    expect(deskCodeFromDigest(digest)).toBe('0000000000');
    digest[6] = 0x3f;
    expect(deskCodeFromDigest(digest)).toBe('0000000000');
    digest[6] = 0x40;
    expect(deskCodeFromDigest(digest)).toBe('0000000001');
    expect(deskCodeFromDigest(Buffer.alloc(32, 0xff))).toBe('ZZZZZZZZZZ');
  });

  it('normalizes what staff type: case, spaces, hyphens and the Crockford look-alikes', () => {
    expect(normalizeDeskCode('7kq2m-9xbtr')).toBe('7KQ2M9XBTR');
    expect(normalizeDeskCode(' 7KQ2M 9XBTR ')).toBe('7KQ2M9XBTR');
    expect(normalizeDeskCode('OIL2M9XBTR')).toBe('0112M9XBTR');
    for (const invalid of ['7KQ2M9XBT', '7KQ2M9XBTRR', '7KQ2M9XBTU', '7KQ2M9XB!R', '', null, 12345, undefined]) {
      expect(normalizeDeskCode(invalid)).toBeNull();
    }
  });
});

describe('the blind compare of the document with the NIN record', () => {
  const record = { firstName: 'Adaeze', lastName: 'Okafor-Nwosu', dateOfBirth: '1990-01-02' };

  it('normalizes names: NFKD, no combining marks, upper case, A-Z and single spaces', () => {
    expect(normalizeDocumentName('  Adéṣọlá   Ògún ')).toBe('ADESOLA OGUN');
    expect(normalizeDocumentName("O'Brien-Okafor")).toBe('OBRIENOKAFOR');
    expect(normalizeDocumentName('Ａｄａ')).toBe('ADA');
    expect(normalizeDocumentName('李')).toBe('');
    expect(normalizeDocumentName(undefined)).toBe('');
  });

  it('matches the names in either order and the date of birth when the record has one', () => {
    expect(matchDocument({ firstName: 'adaeze', lastName: 'Okafor Nwosu', dateOfBirth: '1990-01-02' },
      { ...record, lastName: 'Okafor Nwosu' })).toEqual({ matched: true, firstName: 'match', lastName: 'match',
      dateOfBirth: 'match' });
    expect(matchDocument({ firstName: 'Okafor Nwosu', lastName: 'ADAEZE', dateOfBirth: '1990-01-02' },
      { ...record, lastName: 'Okafor Nwosu' })).toMatchObject({ matched: true, firstName: 'match', lastName: 'match' });
    expect(matchDocument({ firstName: 'Adaeze', lastName: 'Okafor-Nwosu' }, { firstName: 'Adaeze', lastName: 'Okafor-Nwosu' }))
      .toEqual({ matched: true, firstName: 'match', lastName: 'match', dateOfBirth: 'not_in_record' });
  });

  it('reports which field differs without any registry value', () => {
    expect(matchDocument({ firstName: 'Adaeze', lastName: 'Okafor', dateOfBirth: '1990-01-02' }, record))
      .toEqual({ matched: false, firstName: 'match', lastName: 'no_match', dateOfBirth: 'match' });
    expect(matchDocument({ firstName: 'Adaeze', lastName: 'Okafor-Nwosu', dateOfBirth: '1990-02-01' }, record))
      .toEqual({ matched: false, firstName: 'match', lastName: 'match', dateOfBirth: 'no_match' });
    // A date of birth the record has must be typed.
    expect(matchDocument({ firstName: 'Adaeze', lastName: 'Okafor-Nwosu' }, record))
      .toEqual({ matched: false, firstName: 'match', lastName: 'match', dateOfBirth: 'no_match' });
    // The same name twice is not the record's two names.
    expect(matchDocument({ firstName: 'Adaeze', lastName: 'Adaeze', dateOfBirth: '1990-01-02' }, record))
      .toMatchObject({ matched: false });
    // An unreadable name never matches, even an unreadable record name.
    expect(matchDocument({ firstName: '李', lastName: '王' }, { firstName: '李', lastName: '王' }))
      .toEqual({ matched: false, firstName: 'no_match', lastName: 'no_match', dateOfBirth: 'not_in_record' });
  });
});

describe('the in-person check request', () => {
  const valid = async (input: Record<string, unknown>) =>
    validate(plainToInstance(AssistedVerificationDto, input), { whitelist: true, forbidNonWhitelisted: true,
      forbidUnknownValues: true });

  it('accepts the approved procedure: one method, four photo IDs, five attestations all true', async () => {
    for (const documentType of ['national_id_card', 'international_passport', 'drivers_licence', 'voters_card']) {
      expect(await valid(body({ documentType }))).toEqual([]);
    }
    expect(await valid(body({ document: { firstName: 'Ada', lastName: 'Okafor' } }))).toEqual([]);
  });

  it.each([
    ['a NIN slip', { documentType: 'nin_slip' }],
    ['another method', { method: 'registry_phone_otp' }],
    ['an attestation not given', { attestations: { ...attestations, codeShownOnPatientsOwnDevice: false } }],
    ['an attestation missing', { attestations: { patientPresent: true, originalDocumentSeen: true,
      photoMatchesPerson: true, patientConsents: true } }],
    ['an attestation as text', { attestations: { ...attestations, patientConsents: 'true' } }],
    ['a document number', { document: { firstName: 'Ada', lastName: 'Okafor', documentNumber: 'A1234567' } }],
    ['a NIN', { nin: '12345678901' }],
    ['a date of birth in another format', { document: { firstName: 'Ada', lastName: 'Okafor', dateOfBirth: '02/01/1990' } }],
    ['an empty name', { document: { firstName: '', lastName: 'Okafor' } }],
    ['a desk code too long', { deskCode: 'X'.repeat(30) }],
  ])('refuses %s', async (_label, overrides) => {
    expect((await valid(body(overrides))).length).toBeGreaterThan(0);
  });

  // A23: Identity's one nested body names a refused document or attestation
  // field by its dotted path through main.ts's pipe, never its parent alone.
  it('names a refused document or attestation field by its dotted path, without the typed value', async () => {
    const refused = await globalValidationPipe().transform(body({
      document: { firstName: 'Ada', lastName: 'Okafor', dateOfBirth: '02/01/1990' },
      attestations: { ...attestations, codeShownOnPatientsOwnDevice: false, extra: true } }),
    { type: 'body', metatype: AssistedVerificationDto }).then(() => undefined, (error: unknown) => error);
    expect(refused).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    const errors = (refused as DomainProblem).errors ?? [];
    expect(errors.map(({ field }) => field).sort()).toEqual(['attestations.codeShownOnPatientsOwnDevice',
      'attestations.extra', 'document.dateOfBirth']);
    expect(errors.every(({ messages }) => messages.length > 0)).toBe(true);
    expect(JSON.stringify(errors)).not.toContain('02/01/1990');
  });
});

describe('AssistedVerificationController', () => {
  it('is a staff route: the permission, the enabled guard, audited, never public', () => {
    const route = AssistedVerificationController.prototype.verify;
    expect(Reflect.getMetadata(PATH_METADATA, AssistedVerificationController)).toBe('identity/assisted-verifications');
    expect(Reflect.getMetadata(PUBLIC_ROUTE, AssistedVerificationController)).toBeUndefined();
    expect(Reflect.getMetadata(PUBLIC_ROUTE, route)).toBeUndefined();
    expect(Reflect.getMetadata(METHOD_METADATA, route)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, route)).toBe(200);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, route)).toEqual(['identity.patient.assisted_registration']);
    expect(Reflect.getMetadata(GUARDS_METADATA, route)).toEqual([AssistedRegistrationEnabledGuard]);
    expect(Reflect.getMetadata(NO_AUDIT, route)).toBeUndefined();
    expect(Reflect.getMetadata(AUDIT_ACTION, route)).toBe('identity.assisted-verification.request');
  });

  it('answers 503 ASSISTED_REGISTRATION_DISABLED from its guard, before the body is read, while the route is off', () => {
    environment({ ASSISTED_REGISTRATION_ENABLED: 'false' });
    const guard = new AssistedRegistrationEnabledGuard();
    let refused: unknown;
    try { guard.canActivate({} as ExecutionContext); } catch (error) { refused = error; }
    expect(refused).toBeInstanceOf(PublicDetailProblem);
    expect(answered(refused)).toMatchObject({ status: 503, code: 'ASSISTED_REGISTRATION_DISABLED',
      detail: 'Registration at a facility is not available.' });
    environment();
    expect(guard.canActivate({} as ExecutionContext)).toBe(true);
  });

  it('requires an idempotency key and passes the bound staff context', async () => {
    environment();
    const assisted = { verify: jest.fn().mockResolvedValue({ outcome: 'verified' }) };
    const controller = new AssistedVerificationController(assisted as unknown as AssistedVerificationService);
    const request = { correlationId, facilityId, actor: context.actor, header: jest.fn(() => undefined) } as unknown as HidRequest;
    const input = plainToInstance(AssistedVerificationDto, body());
    await expect(controller.verify(input, undefined, request)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    await expect(controller.verify(input, 'assisted-check-key-0001', request)).resolves.toEqual({ outcome: 'verified' });
    expect(assisted.verify).toHaveBeenCalledWith(input, 'assisted-check-key-0001',
      expect.objectContaining({ facilityId, correlationId, purposeOfUse: 'healthcare-operations' }));
  });
});

describe('AssistedVerificationService', () => {
  type Row = { verification_id: string; outcome: string; first_name_result: string | null;
    last_name_result: string | null; date_of_birth_result: string | null; enrollment_id: string | null;
    correlation_id: string; proof_outcome: string | null; replayed: boolean };
  function fixture(options: { lookup?: unknown; stored?: Partial<Row>; recordError?: unknown;
    proof?: string | Error } = {}) {
    const queries: { sql: string; values: unknown[] }[] = [];
    const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (options.recordError) throw options.recordError;
      const outcome = String(values[5]);
      const row: Row = { verification_id: verificationId, outcome, first_name_result: (values[6] as string) ?? null,
        last_name_result: (values[7] as string) ?? null, date_of_birth_result: (values[8] as string) ?? null,
        enrollment_id: (values[0] as string) ?? null, correlation_id: correlationId, proof_outcome: null,
        replayed: false, ...options.stored };
      return { rows: [row], rowCount: 1 };
    }) } as unknown as PoolClient;
    const database = { withTransaction: jest.fn(async (_context: unknown, work: (c: PoolClient) => Promise<unknown>) =>
      work(client)) } as unknown as DatabaseService;
    const enrollments = {
      deskLookup: jest.fn().mockResolvedValue(options.lookup === undefined ? { deskCodeHmac: deskHmac,
        enrollment: { id: enrollmentId, ninDigest, result: { matched: true, firstName: 'match', lastName: 'match',
          dateOfBirth: 'match' } } } : options.lookup),
      proveAtFacility: options.proof instanceof Error ? jest.fn().mockRejectedValue(options.proof)
        : jest.fn().mockResolvedValue(options.proof ?? 'verified'),
      assistedRequestDigests: jest.fn().mockReturnValue({ keyHmac: 'e'.repeat(64), requestHmac: 'f'.repeat(64) }),
    };
    const service = new AssistedVerificationService(database, enrollments as unknown as PatientEnrollmentService);
    return { service, queries, database, enrollments };
  }
  const input = () => plainToInstance(AssistedVerificationDto, body());
  beforeEach(() => environment());

  it('refuses while the route is off, before any read', async () => {
    environment({ ASSISTED_REGISTRATION_ENABLED: 'false' });
    const f = fixture();
    expect((await problem(f.service.verify(input(), 'assisted-check-key-0001', context))).code)
      .toBe('ASSISTED_REGISTRATION_DISABLED');
    expect(f.enrollments.deskLookup).not.toHaveBeenCalled();
    expect(f.database.withTransaction).not.toHaveBeenCalled();
  });

  it('refuses a desk code that is not ten Crockford characters, before any read', async () => {
    const f = fixture();
    const refused = await problem(f.service.verify(plainToInstance(AssistedVerificationDto, body({ deskCode: '7KQ2M9XBTU' })),
      'assisted-check-key-0001', context));
    expect([refused.getStatus(), refused.code]).toEqual([400, 'DESK_CODE_INVALID']);
    expect(f.enrollments.deskLookup).not.toHaveBeenCalled();
  });

  it('records a matched check in staff context, proves the holder in system context and answers verified', async () => {
    const f = fixture();
    await expect(f.service.verify(input(), 'assisted-check-key-0001', context)).resolves.toEqual({ outcome: 'verified' });
    expect(f.enrollments.deskLookup).toHaveBeenCalledWith('7KQ2M9XBTR',
      { firstName: 'Ada', lastName: 'Okafor', dateOfBirth: '1990-01-02' }, correlationId);
    expect(f.database.withTransaction).toHaveBeenCalledWith(context, expect.any(Function));
    const recorded = f.queries.find(({ sql }) => sql.includes('identity.record_assisted_verification'))!;
    expect(recorded.values).toEqual([enrollmentId, ninDigest, deskHmac, 'government_photo_id_in_person',
      'national_id_card', 'matched', 'match', 'match', 'match', 'e'.repeat(64), 'f'.repeat(64), 20, 100]);
    // Typed names, dates, desk code and attestations never reach the database.
    expect(JSON.stringify(f.queries)).not.toMatch(/Ada|Okafor|1990|7KQ2M/);
    expect(f.enrollments.proveAtFacility).toHaveBeenCalledWith(enrollmentId, verificationId, correlationId);
  });

  it('records an unknown desk code and answers 404 DESK_CODE_NOT_FOUND', async () => {
    const f = fixture({ lookup: { deskCodeHmac: deskHmac, enrollment: null } });
    const refused = await problem(f.service.verify(input(), 'assisted-check-key-0002', context));
    expect([refused.getStatus(), refused.code]).toEqual([404, 'DESK_CODE_NOT_FOUND']);
    const recorded = f.queries.find(({ sql }) => sql.includes('identity.record_assisted_verification'))!;
    expect(recorded.values.slice(0, 9)).toEqual([null, null, deskHmac, 'government_photo_id_in_person',
      'national_id_card', 'code_not_found', null, null, null]);
    expect(f.enrollments.proveAtFacility).not.toHaveBeenCalled();
  });

  it('records a mismatch and answers 422 with match, no_match or not_in_record per field', async () => {
    const f = fixture({ lookup: { deskCodeHmac: deskHmac, enrollment: { id: enrollmentId, ninDigest,
      result: { matched: false, firstName: 'match', lastName: 'no_match', dateOfBirth: 'not_in_record' } } } });
    const refused = await problem(f.service.verify(input(), 'assisted-check-key-0003', context));
    expect(answered(refused)).toMatchObject({ status: 422, code: 'ASSISTED_VERIFICATION_NOT_MATCHED',
      detail: 'The details on the document do not match the NIN record.',
      fields: { firstName: 'match', lastName: 'no_match', dateOfBirth: 'not_in_record' } });
    expect(JSON.stringify(answered(refused))).not.toMatch(/Ada|Okafor|1990/);
    expect(f.enrollments.proveAtFacility).not.toHaveBeenCalled();
  });

  it('answers an existing Health ID with the staff text and the check reference, and nothing about the identity', async () => {
    const f = fixture({ proof: 'existing_identity', stored: { correlation_id: 'original-correlation-0001' } });
    const refused = await problem(f.service.verify(input(), 'assisted-check-key-0004', context));
    expect(answered(refused)).toMatchObject({ status: 409, code: 'NIN_ALREADY_REGISTERED',
      detail: 'This person already has a Health ID. Direct them to account recovery. If they say they never '
        + 'registered, ask Health ID support to review, quoting reference original-correlation-0001.' });
  });

  it('replays the stored outcome under the same key without proving again', async () => {
    const proven = fixture({ stored: { replayed: true, proof_outcome: 'verified' } });
    await expect(proven.service.verify(input(), 'assisted-check-key-0005', context)).resolves.toEqual({ outcome: 'verified' });
    expect(proven.enrollments.proveAtFacility).not.toHaveBeenCalled();
    const bound = fixture({ stored: { replayed: true, proof_outcome: 'existing_identity' } });
    expect((await problem(bound.service.verify(input(), 'assisted-check-key-0006', context))).code)
      .toBe('NIN_ALREADY_REGISTERED');
    expect(bound.enrollments.proveAtFacility).not.toHaveBeenCalled();
    // A matched check whose proof did not finish is proved on the replay.
    const pending = fixture({ stored: { replayed: true, proof_outcome: null } });
    await expect(pending.service.verify(input(), 'assisted-check-key-0007', context)).resolves.toEqual({ outcome: 'verified' });
    expect(pending.enrollments.proveAtFacility).toHaveBeenCalledTimes(1);
    // A stored mismatch replays as a mismatch, whatever this request computed.
    const stored = fixture({ stored: { replayed: true, outcome: 'not_matched', first_name_result: 'no_match',
      last_name_result: 'match', date_of_birth_result: 'match' } });
    expect(answered(await problem(stored.service.verify(input(), 'assisted-check-key-0008', context))))
      .toMatchObject({ status: 422, fields: { firstName: 'no_match', lastName: 'match', dateOfBirth: 'match' } });
  });

  it.each([
    ['ASSISTED_REGISTRATION_NOT_AUTHORIZED', '42501', 403, 'ASSISTED_REGISTRATION_NOT_AUTHORIZED'],
    ['ASSISTED_VERIFICATION_LIMITED', '54000', 429, 'ASSISTED_VERIFICATION_LIMITED'],
    ['ASSISTED_VERIFICATION_KEY_REUSED', '23505', 409, 'IDEMPOTENCY_KEY_REUSED'],
    ['ASSISTED_VERIFICATION_INVALID', '22023', 503, 'ASSISTED_VERIFICATION_UNAVAILABLE'],
  ])('maps the staff command refusal %s', async (message, code, status, answer) => {
    const f = fixture({ recordError: Object.assign(new Error(message), { code }) });
    const refused = await problem(f.service.verify(input(), 'assisted-check-key-0009', context));
    expect([refused.getStatus(), refused.code]).toEqual([status, answer]);
    // No Retry-After (A21): the budgets are counted in SQL (0094), which
    // reports only that it refused (RETRY-AFTER-SQL).
    expect(refused).not.toBeInstanceOf(RetryAfterProblem);
    expect(f.enrollments.proveAtFacility).not.toHaveBeenCalled();
  });

  it('passes the proof refusals on', async () => {
    const stale = new DomainProblem(409, 'ASSISTED_VERIFICATION_STALE',
      'This check can no longer be used. Ask the patient for a new desk code and check again.');
    const f = fixture({ proof: stale });
    expect((await problem(f.service.verify(input(), 'assisted-check-key-0010', context))).code)
      .toBe('ASSISTED_VERIFICATION_STALE');
  });

  it('keys the request digest on the canonical request, so a changed request under one key is refused', async () => {
    const f = fixture();
    await f.service.verify(input(), 'assisted-check-key-0011', context);
    await f.service.verify(plainToInstance(AssistedVerificationDto, body({ deskCode: '7kq2m9xbtr' })),
      'assisted-check-key-0011', context);
    const [first, second] = f.enrollments.assistedRequestDigests.mock.calls;
    expect(first?.[0]).toBe('assisted-check-key-0011');
    // The typed spelling of the same desk code is the same request.
    expect(second?.[1]).toBe(first?.[1]);
    await f.service.verify(plainToInstance(AssistedVerificationDto, body({ documentType: 'voters_card' })),
      'assisted-check-key-0011', context);
    expect(f.enrollments.assistedRequestDigests.mock.calls[2]?.[1]).not.toBe(first?.[1]);
  });
});
