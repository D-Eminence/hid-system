jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { Global, type INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Response } from 'express';
import request from 'supertest';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditService } from '../audit/audit.service';
import { SecurityGuard } from '../auth/security.guard';
import { TokenService } from '../auth/token.service';
import { requestDigest } from '../common/idempotency';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, FacilityAssignment, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { PatientMergesModule } from './patient-merges.module';
import { encodePatientMergeCursor, type PatientMergeItem } from './patient-merges.service';

// ID-8a (0207): the seven routes through the real PatientMergesModule (its
// controller, service, start-up check and its own wiring of
// PatientMergesOffMiddleware), SecurityGuard, AuditInterceptor and main.ts's
// pipe and filter. Only DatabaseService and AuditService, which AppModule's
// global modules provide, are stand-ins; the database's own decisions are the
// suites' (services/ehr-api/test/database/patient-merge-requests*.integration.sql).

const facilityId = '10000000-0000-4000-8000-000000000002';
const mergeId = '70000000-0000-4000-8000-000000000001';
const sourceId = '50000000-0000-4000-8000-000000000001';
const targetId = '50000000-0000-4000-8000-000000000009';
const matchRef = `psr_${'A'.repeat(43)}`;
const base = '/api/v1/identity/patient-merges';
const PERSONAL = /Musa|Bello|Unknown patient|1990-03-14|1991-07-01|QX7P|AB12|HID-/;

function item(overrides: Partial<PatientMergeItem> = {}): PatientMergeItem {
  return {
    mergeId, status: 'requested', version: 1, requestedAt: '2026-11-27T10:00:00.123456+00:00',
    reason: 'Identified by family at the bedside today', requestedByMe: true, decidedAt: null, decisionReason: null,
    cancelledAt: null, mergedAt: null, undoUntil: null, sourceStillAllowed: true,
    source: { patientId: sourceId, fullName: 'Unknown patient U-0007', sex: 'male', dateOfBirth: '1991-07-01',
      dateOfBirthEstimated: true, healthIdLast4: 'QX7P', ninStatus: 'not_verified', recordKind: 'unknown' },
    target: { fullName: 'Musa Bello', sex: 'male', dateOfBirth: '1990-03-14', healthIdLast4: 'AB12', ninStatus: 'verified',
      recordKind: 'standard' },
    targetPatientId: targetId,
    moves: { visits: 2, notes: 3, vitals: 5, diagnoses: 1, prescriptions: 2, labRequests: 1, documents: 0, allergies: 0 },
    ...overrides,
  };
}
function assignment(permissions: string[]): FacilityAssignment {
  return { id: facilityId, membershipId: '40000000-0000-4000-8000-000000000001',
    organizationId: '10000000-0000-4000-8000-000000000001', name: 'Fictional Hospital', roles: ['receptionist'],
    permissions, isPrimary: true };
}
function staff(permissions: string[]): ActorContext {
  const facility = assignment(permissions);
  return { kind: 'staff', id: 'staff:desk', subject: 'staff:desk', accountId: '20000000-0000-4000-8000-000000000001',
    email: 'desk@example.test', roles: facility.roles, permissions: facility.permissions, platformRoles: [],
    platformPermissions: [], facilityIds: [facility.id], facilities: [facility], authenticationMethod: 'local' };
}
const DESK = ['identity.registration.write'];
const APPROVER = ['identity.registration.write', 'identity.registration.approve'];
const databaseError = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { code, ...extra });

describe('merge requests over HTTP (ID-8a, 0207)', () => {
  const original = { ...process.env };
  let app: INestApplication | undefined;
  const handlers: Record<string, (values: unknown[]) => unknown> = {};
  const calls: { sql: string; values: unknown[]; purpose?: string }[] = [];
  let transactionPurpose: string | undefined;
  const respond = jest.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values, purpose: transactionPurpose });
    for (const [needle, handler] of Object.entries(handlers)) if (sql.includes(needle)) return handler(values);
    if (sql.includes('platform.control_enabled($1)')) return { rows: [{ enabled: values[0] !== 'maintenance_mode' }] };
    return { rows: [] };
  });
  const database = {
    query: respond,
    withTransaction: jest.fn(async (context: { purposeOfUse: string }, work: (client: unknown) => Promise<unknown>) => {
      transactionPurpose = context.purposeOfUse;
      try {
        return await work({ query: respond });
      } finally {
        transactionPurpose = undefined;
      }
    }),
    withSystemTransaction: jest.fn(),
    withPlatformTransaction: jest.fn(),
  };
  const audit = { record: jest.fn(), recordWithClient: jest.fn() };
  const tokens = { verify: jest.fn(), verifyCsrf: jest.fn() };
  const sqlCalls = (needle: string) => calls.filter((call) => call.sql.includes(needle)
    && !call.sql.includes('has_function_privilege'));
  type AuditRow = { action: string; outcome: string; patientId?: string; resourceId?: string; reason?: string;
    details?: Record<string, unknown> };
  const rows = (action: string) => audit.record.mock.calls.map(([event]) => event as AuditRow)
    .filter((event) => event.action === action);
  const listRows = () => audit.recordWithClient.mock.calls.map(([, event]) => event as AuditRow);

  async function boot(enabled: string | null = 'true'): Promise<void> {
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://app.healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
      AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters' });
    if (enabled === null) delete process.env.PATIENT_MERGE_REQUESTS_ENABLED;
    else process.env.PATIENT_MERGE_REQUESTS_ENABLED = enabled;
    resetEnvironmentForTests();
    handlers['has_function_privilege'] = () => ({ rows: [{ function_0: true, function_1: true, function_2: true,
      function_3: true, function_4: true }] });
    @Global()
    @Module({ providers: [{ provide: DatabaseService, useValue: database }, { provide: AuditService, useValue: audit }],
      exports: [DatabaseService, AuditService] })
    class GlobalStandIns {}
    const module = await Test.createTestingModule({ imports: [GlobalStandIns, PatientMergesModule] }).compile();
    app = module.createNestApplication({ logger: false });
    app.use((incoming: HidRequest, _response: Response, next: NextFunction) => {
      incoming.correlationId = 'id8a-http-correlation';
      next();
    });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
      transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
      exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
        errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
    app.useGlobalFilters(new ProblemDetailsFilter());
    app.useGlobalGuards(new SecurityGuard(module.get(Reflector), tokens as unknown as TokenService,
      audit as unknown as AuditService, database as unknown as DatabaseService));
    app.useGlobalInterceptors(new AuditInterceptor(module.get(Reflector), audit as unknown as AuditService));
    await app.init();
  }

  beforeEach(() => {
    jest.clearAllMocks();
    calls.length = 0;
    for (const key of Object.keys(handlers)) delete handlers[key];
    tokens.verify.mockResolvedValue({ actor: staff(DESK), claims: {} });
    tokens.verifyCsrf.mockReturnValue(true);
    audit.record.mockResolvedValue(undefined);
    audit.recordWithClient.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  const as = (permissions: string[]) => tokens.verify.mockResolvedValue({ actor: staff(permissions), claims: {} });
  const post = (path: string, key: string | null = 'id8a-http-key-00000001') => {
    const call = request(app!.getHttpServer()).post(`${base}${path}`).set('Authorization', 'Bearer synthetic')
      .set('X-Facility-ID', facilityId);
    return key ? call.set('Idempotency-Key', key) : call;
  };
  const get = (path: string, purpose: string | null = 'healthcare-operations') => {
    const call = request(app!.getHttpServer()).get(`${base}${path}`).set('Authorization', 'Bearer synthetic')
      .set('X-Facility-ID', facilityId);
    return purpose ? call.set('X-Purpose-Of-Use', purpose) : call;
  };
  const requestBody = { sourcePatientId: sourceId, targetMatchRef: matchRef,
    reason: 'Identified by family at the bedside today', purpose: 'healthcare-operations' };

  describe('PATIENT_MERGE_REQUESTS_ENABLED', () => {
    it.each([['unset', null], ['false', 'false']] as const)('%s: every route answers a plain 404 and reads nothing',
      async (_label, value) => {
        await boot(value);
        for (const answer of [await post('').send(requestBody), await get(''), await get(`/${mergeId}`),
          await post(`/${mergeId}/refuse`).send({}), await post(`/${mergeId}/cancel`).send({}),
          await post(`/${mergeId}/approve`).send({}), await post(`/${mergeId}/undo`).send({})]) {
          expect([answer.status, answer.body.code]).toEqual([404, 'NOT_FOUND']);
        }
        expect(calls).toEqual([]);
        expect(tokens.verify).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
      });
  });

  describe('POST (ask to merge)', () => {
    it('answers 201 with the contract\'s shape; the target card has no patient id; the matchRef goes to the database under healthcare-operations',
      async () => {
        await boot();
        handlers['identity.request_patient_merge'] = () => ({ rows: [{ merge: item(), replayed: false }] });
        const answer = await post('').send(requestBody);
        expect(answer.status).toBe(201);
        expect(answer.body).toEqual({ mergeId, status: 'requested', version: 1, requestedAt: '2026-11-27T10:00:00.123Z',
          reason: 'Identified by family at the bedside today', requestedByMe: true, sourceStillAllowed: true,
          decidedAt: null, decisionReason: null, cancelledAt: null,
          source: { patientId: sourceId, fullName: 'Unknown patient U-0007', sex: 'male', dateOfBirth: '1991-07-01',
            dateOfBirthEstimated: true, healthIdLast4: 'QX7P', ninStatus: 'not_verified', recordKind: 'unknown' },
          target: { fullName: 'Musa Bello', sex: 'male', dateOfBirth: '1990-03-14', healthIdLast4: 'AB12',
            ninStatus: 'verified', recordKind: 'standard' },
          moves: { visits: 2, notes: 3, vitals: 5, diagnoses: 1, prescriptions: 2, labRequests: 1, documents: 0,
            allergies: 0 },
          replayed: false });
        expect(JSON.stringify(answer.body)).not.toContain(targetId);
        const [call] = sqlCalls('identity.request_patient_merge');
        expect(call?.values).toEqual([sourceId, matchRef, 'Identified by family at the bedside today',
          'id8a-http-key-00000001', requestDigest('identity.patient-merge.request', { sourcePatientId: sourceId,
            targetMatchRef: matchRef, reason: 'Identified by family at the bedside today',
            purpose: 'healthcare-operations' })]);
        // The pairing (contract: a direct-care search's matchRef, resolved whatever the request's own purpose): the
        // request runs under healthcare-operations and hands the ref to 0207, which reads it as direct-care; Identity
        // never asks 0132's resolver, which answers only a ref of the session's purpose.
        expect(call?.purpose).toBe('healthcare-operations');
        expect(sqlCalls('resolve_patient_search_ref')).toEqual([]);
        // The database wrote the request's row; Identity's are the interceptor's only, with no personal data.
        expect(rows('identity.patient-merge.request')).toEqual([]);
        expect(JSON.stringify(audit.record.mock.calls)).not.toMatch(PERSONAL);
      });

    it('answers a replay 200 with replayed: true', async () => {
      await boot();
      handlers['identity.request_patient_merge'] = () => ({ rows: [{ merge: item(), replayed: true }] });
      const answer = await post('').send(requestBody);
      expect([answer.status, answer.body.replayed, answer.body.mergeId]).toEqual([200, true, mergeId]);
    });

    it('needs identity.registration.write, an Idempotency-Key, the body purpose healthcare-operations and a reason of 8-500',
      async () => {
        await boot();
        as([]);
        expect((await post('').send(requestBody)).body.code).toBe('PERMISSION_DENIED');
        as(DESK);
        const noKey = await post('', null).send(requestBody);
        expect([noKey.status, noKey.body.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
        for (const body of [{ ...requestBody, reason: 'Too shr' }, { ...requestBody, reason: 'x'.repeat(501) },
          { ...requestBody, sourcePatientId: 'not-a-uuid' }, { ...requestBody, purpose: 'direct-care' },
          { ...requestBody, targetMatchRef: '' }, { ...requestBody, targetPatientId: targetId },
          { ...requestBody, targetHealthId: 'HID-ABCDEF' }]) {
          const invalid = await post('').send(body);
          expect([invalid.status, invalid.body.code]).toEqual([400, 'VALIDATION_FAILED']);
        }
        expect(sqlCalls('request_patient_merge')).toEqual([]);
      });

    it('maps every refusal of the request and writes one denied row with the ids the database gave, and no personal data',
      async () => {
        await boot();
        const both = JSON.stringify({ mergeId, sourcePatientId: sourceId, targetPatientId: targetId });
        const cases: [unknown, number, string][] = [
          [databaseError('42501', 'MERGE_DENIED', { detail: '{}' }), 403, 'PERMISSION_DENIED'],
          [databaseError('22023', 'MERGE_INVALID'), 400, 'VALIDATION_FAILED'],
          [databaseError('23505', 'IDEMPOTENCY_KEY_REUSED'), 409, 'IDEMPOTENCY_KEY_REUSED'],
          [databaseError('P0001', 'PATIENT_NOT_FOUND', { detail: '{}' }), 404, 'PATIENT_NOT_FOUND'],
          [databaseError('P0001', 'MERGE_SOURCE_NOT_ALLOWED', { detail: JSON.stringify({ sourcePatientId: sourceId }) }),
            409, 'MERGE_SOURCE_NOT_ALLOWED'],
          [databaseError('P0001', 'MERGE_ALREADY_OPEN', { detail: JSON.stringify({ mergeId, sourcePatientId: sourceId }) }),
            409, 'MERGE_ALREADY_OPEN'],
          [databaseError('23505', 'duplicate key', { constraint: 'patient_merges_one_open_per_source_ux' }), 409,
            'MERGE_ALREADY_OPEN'],
          [databaseError('42501', 'MERGE_SEARCH_FIRST', { detail: JSON.stringify({ sourcePatientId: sourceId }) }), 403,
            'MERGE_SEARCH_FIRST'],
          [databaseError('P0001', 'MERGE_SAME_RECORD', { detail: JSON.stringify({ sourcePatientId: sourceId }) }), 409,
            'MERGE_SAME_RECORD'],
          [databaseError('P0001', 'MERGE_TARGET_NOT_ALLOWED', { detail: both }), 409, 'MERGE_TARGET_NOT_ALLOWED'],
        ];
        for (const [error, status, code] of cases) {
          handlers['identity.request_patient_merge'] = () => { throw error; };
          const answer = await post('').send(requestBody);
          expect([answer.status, answer.body.code]).toEqual([status, code]);
          expect(answer.body.detail).not.toContain(sourceId);
        }
        const denied = rows('identity.patient-merge.request');
        expect(denied.map((row) => [row.outcome, row.details?.refusal])).toEqual(cases.map(([, , code]) => ['denied', code]));
        // The source is the row's patient only when the database named it; the target's id is in details.
        expect(denied[3]).toMatchObject({ details: { refusal: 'PATIENT_NOT_FOUND', requestedSourcePatientId: sourceId } });
        expect(denied[3]).not.toHaveProperty('patientId');
        expect(denied[4]).toMatchObject({ patientId: sourceId, details: { refusal: 'MERGE_SOURCE_NOT_ALLOWED' } });
        expect(denied[9]).toMatchObject({ patientId: sourceId, resourceId: mergeId,
          details: { refusal: 'MERGE_TARGET_NOT_ALLOWED', targetPatientId: targetId, mergeId } });
        expect(denied.every((row) => row.reason === 'Identified by family at the bedside today')).toBe(true);
        expect(JSON.stringify(audit.record.mock.calls)).not.toMatch(PERSONAL);
      });

    it('answers a database without 0207 503 MERGE_UNAVAILABLE and writes no refusal row', async () => {
      await boot();
      handlers['identity.request_patient_merge'] = () => { throw databaseError('42883', 'function does not exist'); };
      const answer = await post('').send(requestBody);
      expect([answer.status, answer.body.code]).toEqual([503, 'MERGE_UNAVAILABLE']);
      expect(rows('identity.patient-merge.request')).toEqual([]);
    });
  });

  describe('GET (the list)', () => {
    it('lists by view with X-Purpose-Of-Use healthcare-operations, pages by cursor, and writes .list and one .list.shown per patient shown',
      async () => {
        await boot();
        as(APPROVER);
        handlers['identity.list_patient_merges'] = () => ({ rows: [{ merge: item(), has_more: true }] });
        const listed = await get('?view=facility&status=requested&limit=1');
        expect(listed.status).toBe(200);
        expect(listed.headers['cache-control']).toBe('no-store');
        expect(listed.body.items).toHaveLength(1);
        expect(listed.body.items[0].target).not.toHaveProperty('patientId');
        expect(JSON.stringify(listed.body)).not.toContain(targetId);
        expect(listed.body.nextCursor).toBe(encodePatientMergeCursor('2026-11-27T10:00:00.123456+00:00', mergeId));
        expect(sqlCalls('identity.list_patient_merges')[0]?.values).toEqual(['facility', 'requested', 1, null, null]);
        await get(`?view=facility&cursor=${listed.body.nextCursor}`);
        expect(sqlCalls('identity.list_patient_merges')[1]?.values).toEqual(['facility', null, 25,
          '2026-11-27T10:00:00.123456+00:00', mergeId]);
        const written = listRows().slice(0, 3);
        expect(written.map((row) => [row.action, row.patientId ?? null])).toEqual([
          ['identity.patient-merge.list', null], ['identity.patient-merge.list.shown', sourceId],
          ['identity.patient-merge.list.shown', targetId]]);
        expect(written[0]?.details).toEqual({ view: 'facility', status: 'requested', resultCount: 1, hasMore: true,
          mergeIds: [mergeId] });
        expect(written[1]?.details).toEqual({ mergeId, shownAs: 'source', targetPatientId: targetId, status: 'requested' });
        expect(written[2]?.details).toEqual({ mergeId, shownAs: 'target', sourcePatientId: sourceId, status: 'requested' });
        expect(JSON.stringify(audit.recordWithClient.mock.calls)).not.toMatch(PERSONAL);
      });

    it('needs the view and healthcare operations; a refusal of the view is 403 with a denied row', async () => {
      await boot();
      expect((await get('')).body.code).toBe('VALIDATION_FAILED');
      expect((await get('?view=all')).body.code).toBe('VALIDATION_FAILED');
      expect((await get('?view=mine&limit=101')).body.code).toBe('VALIDATION_FAILED');
      expect((await get('?view=mine&cursor=not-a-real-cursor-at-all')).body.code).toBe('VALIDATION_FAILED');
      // Forged cursors that pass Date.parse or a loose id test but PostgreSQL would refuse: 400, never the database.
      const forged = (c: string, m: string) => Buffer.from(JSON.stringify({ c, m }), 'utf8').toString('base64url');
      for (const cursor of [forged('2026', mergeId), forged('Nov 27 2026', mergeId), forged('2026-11-27T10:00:00', mergeId),
        forged('2026-11-27T10:00:00.1234567+00:00', mergeId), forged('2026-02-30T10:00:00+00:00', mergeId),
        forged('2026-13-01T10:00:00+00:00', mergeId), forged('2026-11-27T10:00:00+16:00', mergeId),
        forged('2026-11-27T10:00:00+00:00', '------------------------------------'),
        forged('2026-11-27T10:00:00+00:00', `${mergeId.slice(0, 35)}g`)]) {
        const answer = await get(`?view=mine&cursor=${cursor}`);
        expect([answer.status, answer.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      }
      expect((await get('?view=mine', 'direct-care')).body.code).toBe('PURPOSE_OF_USE_REQUIRED');
      expect((await get('?view=mine', null)).body.code).toBe('PURPOSE_OF_USE_REQUIRED');
      expect(sqlCalls('list_patient_merges')).toEqual([]);
      handlers['identity.list_patient_merges'] = () => { throw databaseError('42501', 'MERGE_DENIED'); };
      const denied = await get('?view=facility');
      expect([denied.status, denied.body.code]).toEqual([403, 'PERMISSION_DENIED']);
      expect(rows('identity.patient-merge.list').map((row) => [row.outcome, row.details?.refusal]))
        .toEqual([['denied', 'PERMISSION_DENIED']]);
      expect(listRows()).toEqual([]);
    });
  });

  describe('GET :mergeId (one request)', () => {
    it('reads one; a request this member may not see is 404 MERGE_NOT_FOUND with a denied row naming only the merge',
      async () => {
        await boot();
        handlers['identity.read_patient_merge'] = () => ({ rows: [{ merge: item({ requestedByMe: false }) }] });
        const found = await get(`/${mergeId}`);
        expect([found.status, found.body.mergeId, found.body.requestedByMe]).toEqual([200, mergeId, false]);
        expect(found.body.target).not.toHaveProperty('patientId');
        expect(JSON.stringify(found.body)).not.toContain(targetId);
        expect(sqlCalls('identity.read_patient_merge')[0]?.values).toEqual([mergeId]);
        handlers['identity.read_patient_merge'] = () => { throw databaseError('P0001', 'MERGE_NOT_FOUND', { detail: '{}' }); };
        const missing = await get(`/${mergeId}`);
        expect([missing.status, missing.body.code, missing.body.detail]).toEqual([404, 'MERGE_NOT_FOUND',
          'No merge request of this facility matches.']);
        expect(rows('identity.patient-merge.read')).toEqual([expect.objectContaining({ outcome: 'denied',
          resourceId: mergeId, details: { refusal: 'MERGE_NOT_FOUND', mergeId } })]);
        expect(rows('identity.patient-merge.read')[0]).not.toHaveProperty('patientId');
        expect((await get('/not-a-uuid')).status).toBe(400);
        expect((await get(`/${mergeId}`, null)).body.code).toBe('PURPOSE_OF_USE_REQUIRED');
      });

    it('a member the database refuses (neither permission) is 403 PERMISSION_DENIED with a denied .read row', async () => {
      await boot();
      as([]);
      handlers['identity.read_patient_merge'] = () => { throw databaseError('42501', 'MERGE_DENIED'); };
      const denied = await get(`/${mergeId}`);
      expect([denied.status, denied.body.code]).toEqual([403, 'PERMISSION_DENIED']);
      expect(rows('identity.patient-merge.read')).toEqual([expect.objectContaining({ outcome: 'denied', resourceId: mergeId,
        details: { refusal: 'PERMISSION_DENIED', mergeId } })]);
      expect(rows('identity.patient-merge.read')[0]).not.toHaveProperty('patientId');
    });
  });

  describe('POST :mergeId/refuse and :mergeId/cancel', () => {
    const refuseBody = { expectedVersion: 1, reason: 'Not the same person at all', purpose: 'healthcare-operations' };

    it('refuse needs identity.registration.approve, the reason and the version; maps Q127 A, decided and the version',
      async () => {
        await boot();
        const denied = await post(`/${mergeId}/refuse`).send(refuseBody);
        expect([denied.status, denied.body.code]).toEqual([403, 'PERMISSION_DENIED']);
        expect(sqlCalls('refuse_patient_merge')).toEqual([]);
        as(APPROVER);
        handlers['identity.refuse_patient_merge'] = () => ({ rows: [{ merge: item({ status: 'refused', version: 2,
          decidedAt: '2026-11-27T11:00:00+00:00', decisionReason: 'Not the same person at all', sourceStillAllowed: null }),
          replayed: false }] });
        const refused = await post(`/${mergeId}/refuse`).send(refuseBody);
        expect(refused.status).toBe(200);
        expect(refused.body).toMatchObject({ status: 'refused', version: 2, decidedAt: '2026-11-27T11:00:00.000Z',
          decisionReason: 'Not the same person at all', sourceStillAllowed: null, replayed: false });
        expect(refused.body.target).not.toHaveProperty('patientId');
        expect(JSON.stringify(refused.body)).not.toContain(targetId);
        expect(sqlCalls('identity.refuse_patient_merge')[0]?.values).toEqual([mergeId, 1, 'Not the same person at all',
          'id8a-http-key-00000001', requestDigest('identity.patient-merge.refuse', { mergeId, expectedVersion: 1,
            reason: 'Not the same person at all', purpose: 'healthcare-operations' })]);
        const ids = { detail: JSON.stringify({ mergeId, sourcePatientId: sourceId, targetPatientId: targetId }) };
        for (const [error, status, code] of [
          [databaseError('42501', 'MERGE_SECOND_PERSON_REQUIRED', ids), 403, 'MERGE_SECOND_PERSON_REQUIRED'],
          [databaseError('P0001', 'MERGE_ALREADY_DECIDED', ids), 409, 'MERGE_ALREADY_DECIDED'],
          [databaseError('40001', 'VERSION_CONFLICT', ids), 412, 'VERSION_CONFLICT'],
          [databaseError('23505', 'IDEMPOTENCY_KEY_REUSED'), 409, 'IDEMPOTENCY_KEY_REUSED'],
          [databaseError('P0001', 'MERGE_NOT_FOUND', { detail: '{}' }), 404, 'MERGE_NOT_FOUND'],
        ] as [unknown, number, string][]) {
          handlers['identity.refuse_patient_merge'] = () => { throw error; };
          const answer = await post(`/${mergeId}/refuse`).send(refuseBody);
          expect([answer.status, answer.body.code]).toEqual([status, code]);
        }
        const deniedRows = rows('identity.patient-merge.refuse');
        expect(deniedRows).toHaveLength(5);
        expect(deniedRows[0]).toMatchObject({ outcome: 'denied', patientId: sourceId, resourceId: mergeId,
          reason: 'Not the same person at all',
          details: { refusal: 'MERGE_SECOND_PERSON_REQUIRED', mergeId, targetPatientId: targetId } });
        for (const body of [{ ...refuseBody, reason: 'short' }, { ...refuseBody, expectedVersion: 0 },
          { ...refuseBody, purpose: 'direct-care' }]) {
          const invalid = await post(`/${mergeId}/refuse`).send(body);
          expect([invalid.status, invalid.body.code]).toEqual([400, 'VALIDATION_FAILED']);
        }
        expect((await post(`/${mergeId}/refuse`, null).send(refuseBody)).body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      });

    it('cancel needs identity.registration.write and the version; answers the cancel and its replay', async () => {
      await boot();
      as([]);
      expect((await post(`/${mergeId}/cancel`).send({ expectedVersion: 1, purpose: 'healthcare-operations' })).body.code)
        .toBe('PERMISSION_DENIED');
      as(DESK);
      handlers['identity.cancel_patient_merge'] = () => ({ rows: [{ merge: item({ status: 'cancelled', version: 2,
        cancelledAt: '2026-11-27T11:00:00+00:00', sourceStillAllowed: null }), replayed: true }] });
      const cancelled = await post(`/${mergeId}/cancel`).send({ expectedVersion: 1, purpose: 'healthcare-operations' });
      expect([cancelled.status, cancelled.body.status, cancelled.body.cancelledAt, cancelled.body.replayed])
        .toEqual([200, 'cancelled', '2026-11-27T11:00:00.000Z', true]);
      expect(cancelled.body.target).not.toHaveProperty('patientId');
      expect(JSON.stringify(cancelled.body)).not.toContain(targetId);
      expect(sqlCalls('identity.cancel_patient_merge')[0]?.values).toEqual([mergeId, 1, 'id8a-http-key-00000001',
        requestDigest('identity.patient-merge.cancel', { mergeId, expectedVersion: 1, purpose: 'healthcare-operations' })]);
      handlers['identity.cancel_patient_merge'] = () => { throw databaseError('42501', 'MERGE_DENIED',
        { detail: JSON.stringify({ mergeId, sourcePatientId: sourceId, targetPatientId: targetId }) }); };
      const notAsker = await post(`/${mergeId}/cancel`).send({ expectedVersion: 1, purpose: 'healthcare-operations' });
      expect([notAsker.status, notAsker.body.code]).toEqual([403, 'PERMISSION_DENIED']);
      expect(rows('identity.patient-merge.cancel')).toEqual([expect.objectContaining({ outcome: 'denied', patientId: sourceId,
        details: { refusal: 'PERMISSION_DENIED', mergeId, targetPatientId: targetId } })]);
      const invalid = await post(`/${mergeId}/cancel`).send({ expectedVersion: 1, reason: 'Not wanted', purpose: 'healthcare-operations' });
      expect([invalid.status, invalid.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    });

    it('cancel maps decided, the version, not found and key reuse, each with one denied row; needs the key', async () => {
      await boot();
      const cancelBody = { expectedVersion: 1, purpose: 'healthcare-operations' };
      const ids = { detail: JSON.stringify({ mergeId, sourcePatientId: sourceId, targetPatientId: targetId }) };
      const cases: [unknown, number, string][] = [
        [databaseError('P0001', 'MERGE_ALREADY_DECIDED', ids), 409, 'MERGE_ALREADY_DECIDED'],
        [databaseError('40001', 'VERSION_CONFLICT', ids), 412, 'VERSION_CONFLICT'],
        [databaseError('P0001', 'MERGE_NOT_FOUND', { detail: '{}' }), 404, 'MERGE_NOT_FOUND'],
        [databaseError('23505', 'IDEMPOTENCY_KEY_REUSED'), 409, 'IDEMPOTENCY_KEY_REUSED'],
      ];
      for (const [error, status, code] of cases) {
        handlers['identity.cancel_patient_merge'] = () => { throw error; };
        const answer = await post(`/${mergeId}/cancel`).send(cancelBody);
        expect([answer.status, answer.body.code]).toEqual([status, code]);
        expect(answer.body.detail).not.toContain(sourceId);
      }
      const deniedRows = rows('identity.patient-merge.cancel');
      expect(deniedRows.map((row) => [row.outcome, row.details?.refusal])).toEqual(cases.map(([, , code]) => ['denied', code]));
      expect(deniedRows[0]).toMatchObject({ patientId: sourceId, resourceId: mergeId,
        details: { refusal: 'MERGE_ALREADY_DECIDED', mergeId, targetPatientId: targetId } });
      // Not found: the row names only the merge the caller sent.
      expect(deniedRows[2]).toEqual(expect.objectContaining({ resourceId: mergeId,
        details: { refusal: 'MERGE_NOT_FOUND', mergeId } }));
      expect(deniedRows[2]).not.toHaveProperty('patientId');
      expect(JSON.stringify(audit.record.mock.calls)).not.toMatch(PERSONAL);
      const calls = sqlCalls('identity.cancel_patient_merge').length;
      const noKey = await post(`/${mergeId}/cancel`, null).send(cancelBody);
      expect([noKey.status, noKey.body.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
      expect(sqlCalls('identity.cancel_patient_merge')).toHaveLength(calls);
    });
  });

  describe('POST :mergeId/approve and :mergeId/undo (ID-8b)', () => {
    it('answer 503 MERGE_UNAVAILABLE while 0208 is absent, with a denied row; nothing is called', async () => {
      await boot();
      as(APPROVER);
      handlers['proc.proname = $1'] = () => ({ rows: [{ present: false }] });
      const approve = await post(`/${mergeId}/approve`).send({ expectedVersion: 1, purpose: 'healthcare-operations' });
      expect([approve.status, approve.body.code]).toEqual([503, 'MERGE_UNAVAILABLE']);
      const undo = await post(`/${mergeId}/undo`).send({ expectedVersion: 2, reason: 'Merged the wrong record',
        purpose: 'healthcare-operations' });
      expect([undo.status, undo.body.code]).toEqual([503, 'MERGE_UNAVAILABLE']);
      expect(sqlCalls('proc.proname = $1').map((call) => call.values)).toEqual([['approve_patient_merge'],
        ['undo_patient_merge']]);
      expect(rows('identity.patient-merge.approve')).toEqual([expect.objectContaining({ outcome: 'denied', resourceId: mergeId,
        details: { refusal: 'MERGE_UNAVAILABLE', id8b: 'absent' } })]);
      expect(rows('identity.patient-merge.undo')).toEqual([expect.objectContaining({ outcome: 'denied',
        details: { refusal: 'MERGE_UNAVAILABLE', id8b: 'absent' } })]);
      expect(database.withTransaction).not.toHaveBeenCalled();
    });

    it('still answer 503 when 0208 is there (this image does not call it), and need the approver, the key and the body', async () => {
      await boot();
      handlers['proc.proname = $1'] = () => ({ rows: [{ present: true }] });
      const desk = await post(`/${mergeId}/approve`).send({ expectedVersion: 1, purpose: 'healthcare-operations' });
      expect([desk.status, desk.body.code]).toEqual([403, 'PERMISSION_DENIED']);
      as(APPROVER);
      const approve = await post(`/${mergeId}/approve`).send({ expectedVersion: 1, purpose: 'healthcare-operations' });
      expect([approve.status, approve.body.code]).toEqual([503, 'MERGE_UNAVAILABLE']);
      expect(rows('identity.patient-merge.approve')[0]?.details).toEqual({ refusal: 'MERGE_UNAVAILABLE', id8b: 'present' });
      expect((await post(`/${mergeId}/approve`, null).send({ expectedVersion: 1, purpose: 'healthcare-operations' }))
        .body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      expect((await post(`/${mergeId}/undo`).send({ expectedVersion: 1, purpose: 'healthcare-operations' })).body.code)
        .toBe('VALIDATION_FAILED');
      const undoNoKey = await post(`/${mergeId}/undo`, null).send({ expectedVersion: 1, reason: 'Merged the wrong record',
        purpose: 'healthcare-operations' });
      expect([undoNoKey.status, undoNoKey.body.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
    });
  });

  describe('the last page', () => {
    it('answers nextCursor null when the database says there is no more', async () => {
      await boot();
      as(APPROVER);
      handlers['identity.list_patient_merges'] = () => ({ rows: [{ merge: item(), has_more: false }] });
      const listed = await get('?view=facility');
      expect([listed.status, listed.body.items.length, listed.body.nextCursor]).toEqual([200, 1, null]);
      handlers['identity.list_patient_merges'] = () => ({ rows: [] });
      const empty = await get('?view=facility');
      expect([empty.status, empty.body.items, empty.body.nextCursor]).toEqual([200, [], null]);
    });
  });
});
