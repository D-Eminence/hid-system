jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import { randomUUID } from 'node:crypto';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Response } from 'express';
import request from 'supertest';
import { AuditService } from '../audit/audit.service';
import { WorkloadAuthService } from '../auth/workload-auth.service';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { DataAccessContext, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';
import { IDENTITY_PROVIDER, type AuthorizationDecision, type IdentityPatient, type IdentityProvider } from './identity.types';
import {
  PATIENT_LOOKUP_MISS_WINDOW,
  PATIENT_NOT_FOUND_MESSAGE,
  PatientLookupMissService,
} from './patient-lookup-miss.service';

/**
 * Q100 B (owner decision of 18 Nov 2026): a Health ID that no patient record
 * has answers 404 PATIENT_NOT_FOUND "No patient has this Health ID."; a
 * patient that exists but is not available here keeps today's answer. Both
 * are counted (30 in 10 minutes per member) and audited without the Health
 * ID. Fictional people and Health IDs only.
 */
const patientId = '7c1f0d2e-3c4a-4b5d-8e6f-7a8b9c0d1e2f';
const membershipId = 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f';
const facilityId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const KNOWN = 'HID-QX7K2M';
const NOBODY = 'HID-NEWPAT';
const context = {
  actor: { kind: 'staff', subject: 'synthetic:desk', accountId: 'f0e1d2c3-b4a5-4968-8776-655443322110',
    permissions: ['identity.patient.read'], facility: { organizationId: 'org', membershipId } },
  facilityId, membershipId, correlationId: 'correlation-q100', purposeOfUse: 'direct-care',
} as unknown as DataAccessContext;
const patient: IdentityPatient = { id: patientId, hidCode: KNOWN, firstName: 'Ada', lastName: 'Fictional',
  fullName: 'Ada Fictional', dateOfBirth: '1991-04-05', gender: 'female', rowVersion: 3, ninVerified: false };
const allow: AuthorizationDecision = { allowed: true, patientId, facilityId, membershipId, scope: 'read_records',
  purpose: 'direct-care', consentGrantId: 'grant', breakGlass: false };
const deny: AuthorizationDecision = { ...allow, allowed: false, consentGrantId: undefined };

const UNVERIFIED = /unverified/i;

function setup(found: IdentityPatient | null, decision: AuthorizationDecision = allow,
  misses: { countMiss: jest.Mock; issued: jest.Mock } | null = {
    countMiss: jest.fn(async () => false), issued: jest.fn(async () => false) }) {
  const provider: IdentityProvider = {
    lookupExactHid: jest.fn(async () => found),
    authorize: jest.fn(async () => decision),
    consentStatus: jest.fn(),
  };
  const audit = { record: jest.fn(async () => undefined) };
  const service = new IdentityService(provider, audit as never, undefined, (misses ?? undefined) as never);
  return { service, audit, provider, misses: misses ?? undefined };
}

describe('Q100 B: staff Health ID lookup (IdentityService.lookupPatient)', () => {
  it('answers 404 PATIENT_NOT_FOUND in plain words when no patient record has the Health ID', async () => {
    const { service, audit, misses } = setup(null);
    const failure = await service.lookupPatient(NOBODY, 'direct-care', context).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DomainProblem);
    expect(failure).toMatchObject({ status: 404, code: 'PATIENT_NOT_FOUND', message: 'No patient has this Health ID.' });
    expect(misses?.countMiss).toHaveBeenCalledWith(context);
    expect(misses?.issued).toHaveBeenCalledWith(NOBODY);
    // Audited, denied, with the result and never the Health ID.
    expect(audit.record).toHaveBeenCalledTimes(1);
    const row = (audit.record.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(row).toMatchObject({ action: 'identity.patient.lookup', outcome: 'denied', patientId: undefined,
      details: { lookupResult: 'no_such_patient' } });
    expect(JSON.stringify(row)).not.toContain(NOBODY);
  });

  it('keeps today\'s 404 for a patient that exists but is not available here (any status, sealed, or hidden)', async () => {
    const { service, audit } = setup(null, allow, { countMiss: jest.fn(async () => false), issued: jest.fn(async () => true) });
    const failure = await service.lookupPatient(KNOWN, 'direct-care', context).catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(DomainProblem);
    expect(failure).toMatchObject({ status: 404, message: 'Patient was not found or is not available' });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied',
      details: { lookupResult: 'not_available' } }));
  });

  it('keeps today\'s 403 for a patient this lookup may see but not open, and counts it', async () => {
    const { service, audit, misses } = setup(patient, deny);
    await expect(service.lookupPatient(KNOWN, 'direct-care', context))
      .rejects.toMatchObject({ status: 403, message: 'Patient access is not authorized' });
    expect(misses?.countMiss).toHaveBeenCalledTimes(1);
    expect(misses?.issued).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied', patientId,
      details: { lookupResult: 'not_authorized' } }));
  });

  it('gives a limited member today\'s 404 for a missing Health ID: never 429, never "No such patient"', async () => {
    const { service, audit, misses } = setup(null, allow,
      { countMiss: jest.fn(async () => true), issued: jest.fn(async () => false) });
    const failure = await service.lookupPatient(NOBODY, 'direct-care', context).catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(DomainProblem);
    expect(failure).toMatchObject({ status: 404, message: 'Patient was not found or is not available' });
    expect(misses?.issued).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied', patientId: undefined,
      details: { lookupResult: 'limited' } }));
  });

  it('gives a limited member today\'s 403 for a patient this lookup may not open (a closed record still closes)',
    async () => {
      const { service, audit, misses } = setup(patient, deny,
        { countMiss: jest.fn(async () => true), issued: jest.fn(async () => false) });
      const failure = await service.lookupPatient(KNOWN, 'direct-care', context).catch((error: unknown) => error);
      expect(failure).not.toBeInstanceOf(DomainProblem);
      expect(failure).toMatchObject({ status: 403, message: 'Patient access is not authorized' });
      expect(misses?.issued).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied', patientId,
        details: { lookupResult: 'limited' } }));
    });

  it.each([
    ['the member cannot be counted', undefined, false],
    ['the issued check cannot be read', false, undefined],
  ] as const)('fails closed to today\'s 404 when %s', async (_label, limited, issued) => {
    const { service, audit } = setup(null, allow,
      { countMiss: jest.fn(async () => limited), issued: jest.fn(async () => issued) });
    const failure = await service.lookupPatient(NOBODY, 'direct-care', context).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 404, message: 'Patient was not found or is not available' });
    expect(failure).not.toBeInstanceOf(DomainProblem);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ details: { lookupResult: 'not_available' } }));
  });

  it('answers today\'s 404 when the service is built without the check (as before Q100)', async () => {
    const { service } = setup(null, allow, null);
    await expect(service.lookupPatient(NOBODY, 'direct-care', context))
      .rejects.toMatchObject({ status: 404, message: 'Patient was not found or is not available' });
  });

  it('opens an allowed patient as before, counting nothing and checking nothing', async () => {
    const { service, audit, misses } = setup(patient, allow);
    const answer = await service.lookupPatient(KNOWN, 'direct-care', context);
    expect(answer.patient).toMatchObject({ patientId, hid: KNOWN, ninStatus: 'not_verified' });
    expect(misses?.countMiss).not.toHaveBeenCalled();
    expect(misses?.issued).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'success', patientId,
      details: { consentGrantId: 'grant', breakGlass: false } }));
    expect(JSON.stringify(answer)).not.toMatch(UNVERIFIED);
  });

  it('never says "unverified" in any answer', () => {
    expect(`${PATIENT_NOT_FOUND_MESSAGE}`).not.toMatch(UNVERIFIED);
  });
});

describe('Q100 B: PatientLookupMissService', () => {
  const env = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid', DATABASE_SSL: 'false',
    CORS_ORIGINS: 'https://healthidentitydirectory.com', AUTH_MODE: 'local',
    AUTH_SIGNING_SECRET: '01234567890123456789012345678901', AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
    STORAGE_MODE: 'disabled' };
  beforeAll(() => { Object.assign(process.env, env); resetEnvironmentForTests(); });
  afterAll(() => { resetEnvironmentForTests(); });

  function missService(answer: { rows: unknown[] } | Error) {
    const queries: { sql: string; values: unknown[] }[] = [];
    const query = jest.fn(async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const database = { query, withTransaction: jest.fn(async (_c: unknown, work: (client: unknown) => unknown) =>
      work({ query })) };
    return { service: new PatientLookupMissService(database as unknown as DatabaseService), queries, database };
  }

  it('asks 0109\'s issued check with the one Health ID, upper case', async () => {
    const { service, queries } = missService({ rows: [] });
    await expect(service.issued(' hid-newpat ')).resolves.toBe(false);
    expect(queries).toEqual([{ sql: 'select health_id from identity.support_health_id_matches($1::text[])',
      values: [[NOBODY]] }]);
  });

  it('says issued when the check names the Health ID (any status: the function reads every patient)', async () => {
    const { service } = missService({ rows: [{ health_id: KNOWN }] });
    await expect(service.issued(KNOWN)).resolves.toBe(true);
  });

  it.each([
    ['another Health ID', { rows: [{ health_id: 'HID-OTHER2' }] }],
    ['two rows', { rows: [{ health_id: KNOWN }, { health_id: KNOWN }] }],
    ['a database failure', new Error('connection reset')],
  ])('cannot tell (undefined) on %s', async (_label, answer) => {
    const { service } = missService(answer);
    await expect(service.issued(KNOWN)).resolves.toBeUndefined();
  });

  it('cannot tell for a malformed Health ID, without asking the database', async () => {
    const { service, queries } = missService({ rows: [] });
    await expect(service.issued('HID-OOOO11')).resolves.toBeUndefined();
    expect(queries).toEqual([]);
  });

  it('counts a miss in the member\'s HMAC bucket: 30 in 10 minutes', async () => {
    const { service, queries } = missService({ rows: [] });
    await expect(service.countMiss(context)).resolves.toBe(false);
    const bucket = service.bucket(membershipId);
    expect(bucket).toMatch(/^[0-9a-f]{64}$/);
    expect(bucket).not.toContain(membershipId);
    const insert = queries.find((query) => /insert into auth\.otp_rate_limits/.test(query.sql));
    expect(insert?.values.slice(0, 2)).toEqual(['account', bucket]);
    expect(PATIENT_LOOKUP_MISS_WINDOW).toEqual({ windowSeconds: 600, maxRequests: 30 });
  });

  it('cannot count (undefined) when the database fails or there is no membership', async () => {
    await expect(missService(new Error('down')).service.countMiss(context)).resolves.toBeUndefined();
    const { service, database } = missService({ rows: [] });
    await expect(service.countMiss({ ...context, membershipId: '' })).resolves.toBeUndefined();
    expect(database.withTransaction).not.toHaveBeenCalled();
  });
});

describe('Q100 B over HTTP: POST /api/v1/identity/patient-lookup', () => {
  let app: INestApplication;
  const provider = { lookupExactHid: jest.fn(), authorize: jest.fn(), consentStatus: jest.fn() };
  const audit = { record: jest.fn(async () => undefined), recordWithClient: jest.fn() };
  const issuedRows: { rows: { health_id: string }[] } = { rows: [] };
  // The member's bucket, as auth.otp_rate_limits holds it (blocked: limited for 10 minutes).
  const bucket: { blocked: boolean } = { blocked: false };
  const query = jest.fn(async (sql: string) => /support_health_id_matches/.test(sql) ? issuedRows
    : /from auth\.otp_rate_limits/.test(sql) && bucket.blocked
      ? { rows: [{ request_count: 31, window_started_at: new Date(), blocked_until: new Date(Date.now() + 600_000) }] }
      : { rows: [], rowCount: 0 });
  const database = { query, withTransaction: jest.fn(async (_c: unknown, work: (client: unknown) => unknown) =>
    work({ query })) };

  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      DATABASE_SSL: 'false', CORS_ORIGINS: 'https://healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901', AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      STORAGE_MODE: 'disabled' });
    resetEnvironmentForTests();
    const moduleRef = await Test.createTestingModule({
      controllers: [IdentityController],
      providers: [
        IdentityService,
        PatientLookupMissService,
        { provide: IDENTITY_PROVIDER, useValue: provider },
        { provide: WorkloadAuthService, useValue: {} },
        { provide: DatabaseService, useValue: database },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    // The security guard's request context, as a signed-in desk member has it.
    app.use((incoming: HidRequest, _response: Response, next: NextFunction) => {
      incoming.correlationId = randomUUID();
      incoming.facilityId = facilityId;
      (incoming as { actor?: unknown }).actor = context.actor;
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
  });
  afterAll(async () => { await app?.close(); resetEnvironmentForTests(); });
  beforeEach(() => { jest.clearAllMocks(); issuedRows.rows = []; bucket.blocked = false; });

  const lookup = (hid: string) => request(app.getHttpServer()).post('/api/v1/identity/patient-lookup')
    .send({ hid, purpose: 'direct-care' });

  it('answers 404 PATIENT_NOT_FOUND "No patient has this Health ID." with no Health ID in the answer', async () => {
    provider.lookupExactHid.mockResolvedValue(null);
    const response = await lookup(NOBODY);
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ status: 404, code: 'PATIENT_NOT_FOUND', detail: 'No patient has this Health ID.' });
    expect(JSON.stringify(response.body)).not.toContain(NOBODY);
    expect(JSON.stringify(response.body)).not.toMatch(UNVERIFIED);
    expect(query).toHaveBeenCalledWith('select health_id from identity.support_health_id_matches($1::text[])', [[NOBODY]]);
  });

  it('keeps today\'s answer, distinct from PATIENT_NOT_FOUND, for a Health ID that exists', async () => {
    provider.lookupExactHid.mockResolvedValue(null);
    issuedRows.rows = [{ health_id: KNOWN }];
    const response = await lookup(KNOWN);
    expect(response.status).toBe(404);
    expect(response.body.code).not.toBe('PATIENT_NOT_FOUND');
    expect(response.body.detail).toBe('Patient was not found or is not available');
  });

  it('answers a limited member with today\'s 404 and 403, never 429, so an open record still closes', async () => {
    bucket.blocked = true;
    provider.lookupExactHid.mockResolvedValue(null);
    const missing = await lookup(NOBODY);
    expect(missing.status).toBe(404);
    expect(missing.body.code).not.toBe('PATIENT_NOT_FOUND');
    expect(missing.body.detail).toBe('Patient was not found or is not available');
    expect(query).not.toHaveBeenCalledWith(expect.stringMatching(/support_health_id_matches/), expect.anything());

    provider.lookupExactHid.mockResolvedValue({ id: patientId, hidCode: KNOWN, firstName: 'Ada', lastName: 'Fictional',
      fullName: 'Ada Fictional', dateOfBirth: '1991-04-05', gender: 'female', rowVersion: 3, ninVerified: false });
    provider.authorize.mockResolvedValue({ allowed: false, patientId, facilityId, membershipId, scope: 'read_records',
      purpose: 'direct-care', breakGlass: false });
    const refused = await lookup(KNOWN);
    expect(refused.status).toBe(403);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied',
      details: { lookupResult: 'limited' } }));
  });
});
