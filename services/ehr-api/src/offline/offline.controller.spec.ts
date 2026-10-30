import { type INestApplication, Module, type MiddlewareConsumer, type NestModule, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { IdentityActorContext } from '@hid/api-client';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditService } from '../audit/audit.service';
import { RemoteSecurityGuard } from '../auth/remote-security.guard';
import { CorrelationMiddleware } from '../common/correlation.middleware';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { IdentityApiService } from '../integrations/identity-api.service';
import { OfflineController } from './offline.controller';
import { OfflineService } from './offline.service';

// The offline routes run here as AppModule and main.ts compose them: the real
// security guard, audit interceptor, problem filter and validation pipe, over
// a database stand-in that applies ehr.idempotency_keys' owner-only RLS from
// the transaction's context (not from the query's own predicates) and keeps
// audit.events' unique event_id and patient foreign key.

const FACILITY = { id: '30000000-0000-4000-8000-000000000001', membershipId: '40000000-0000-4000-8000-000000000001',
  organizationId: '50000000-0000-4000-8000-000000000001', name: 'Demo Hospital', roles: ['clinician'],
  permissions: ['ehr.encounter.read'], isPrimary: true };
const COLLEAGUE_FACILITY = { ...FACILITY, membershipId: '40000000-0000-4000-8000-000000000002' };
const SECOND_FACILITY = { ...FACILITY, id: '30000000-0000-4000-8000-000000000003',
  membershipId: '40000000-0000-4000-8000-000000000003', name: 'Demo Laboratory' };

const staffActor = (accountId: string, facility: typeof FACILITY, permissions = ['ehr.encounter.read'],
  facilities = [facility]): IdentityActorContext => ({
  kind: 'staff', id: `staff:${accountId}`, subject: `staff:${accountId}`, accountId, roles: ['clinician'], permissions,
  platformRoles: [], platformPermissions: [], facilityIds: facilities.map((item) => item.id),
  facilities: facilities.map((item) => ({ ...item, permissions })), facility: { ...facility, permissions },
  role: 'clinician', authenticationMethod: 'local' });

const ME = '20000000-0000-4000-8000-0000000000a1';
const COLLEAGUE = '20000000-0000-4000-8000-0000000000a2';
const me = staffActor(ME, FACILITY, ['ehr.encounter.read'], [FACILITY, SECOND_FACILITY]);
const patientActor: IdentityActorContext = { kind: 'patient', patientId: '60000000-0000-4000-8000-000000000001',
  id: 'patient:p', subject: 'patient:p', accountId: '20000000-0000-4000-8000-0000000000c1', roles: [], permissions: [],
  facilityIds: [], facilities: [], authenticationMethod: 'local' };

const PATIENT = '60000000-0000-4000-8000-0000000000aa';
const UNKNOWN_PATIENT = '60000000-0000-4000-8000-0000000000ff';
/** Exists (the foreign key holds) but the caller has no consent grant for them at this facility. */
const UNRELATED_PATIENT = '60000000-0000-4000-8000-0000000000bb';
const VAULT = '70000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-10-29T10:42:00.123Z');
const key = (n: number) => `off1.0b5c0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const eventId = (n: number) => `80000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface KeyRow { facility_id: string; created_by: string; created_by_membership_id: string; patient_id: string;
  idempotency_key: string; operation: string; state: string; result_resource_type: string | null;
  result_resource_id: string | null; response_status: number | null; created_at: Date; updated_at: Date }
interface StoredEvent { eventId: string; occurredAt: string; actorAccountId: string; actorMembershipId: string;
  facilityId: string; patientId: string | null; action: string; resourceType: string; resourceId: string | null;
  outcome: string; purposeOfUse: string; details: Record<string, unknown>; provenance: string; sourceSystem: string;
  sourceEventId: string }
interface Semantic { action: string; resourceType: string | null; patientId: string | null; details: Record<string, unknown>;
  outcome: string; facilityId: string | null }

let app: INestApplication;
let baseUrl: string;
let liveActor: IdentityActorContext | undefined;
let authenticate: jest.Mock;
let keys: KeyRow[];
let events: StoredEvent[];
let semantic: Semantic[];
/** ehr.offline_audit_patient_allowed (the coordinator's next migration): installed, missing, or not executable. */
let auditFunction: 'present' | 'absent' | 'no-execute';
let functionCalls: string[];
const environment = { ...process.env };

function database() {
  const recordSemantic = (values: unknown[]) => semantic.push({ action: values[8] as string,
    resourceType: values[9] as string | null, patientId: values[7] as string | null, outcome: values[11] as string,
    facilityId: values[6] as string | null, details: JSON.parse(values[15] as string) as Record<string, unknown> });
  const client = (context: DataAccessContext) => ({
    query: jest.fn(async (sql: string, values: unknown[] = []) => {
      if (/^\s*(savepoint|release savepoint|rollback to savepoint)/.test(sql)) return { rows: [], rowCount: 0 };
      if (sql.trim() === 'select now() as now') return { rows: [{ now: NOW }], rowCount: 1 };
      if (sql.includes("to_regprocedure('ehr.offline_audit_patient_allowed(uuid)')")) {
        return { rows: [{ present: auditFunction !== 'absent' }], rowCount: 1 };
      }
      if (sql.includes('ehr.offline_audit_patient_allowed($1)')) {
        functionCalls.push(values[0] as string);
        if (auditFunction === 'absent') throw Object.assign(new Error('function does not exist'), { code: '42883' });
        if (auditFunction === 'no-execute') throw Object.assign(new Error('permission denied for function'), { code: '42501' });
        // Allowed only for a patient this account holds a grant for at this facility.
        return { rows: [{ allowed: values[0] === PATIENT && context.actor.accountId === ME }], rowCount: 1 };
      }
      if (sql.includes('from ehr.idempotency_keys')) {
        // Owner-only RLS (0005 idempotency_keys_owner_all) from the session context.
        const visible = keys.filter((row) => row.created_by === context.actor.accountId
          && row.created_by_membership_id === context.membershipId && row.facility_id === context.facilityId);
        const [wanted, facilityId, accountId, membershipId] = values as [string[], string, string, string];
        const rows = visible.filter((row) => wanted.includes(row.idempotency_key) && row.facility_id === facilityId
          && row.created_by === accountId && row.created_by_membership_id === membershipId);
        return { rows: rows.map((row) => ({ key: row.idempotency_key, operation: row.operation, state: row.state,
          resourceType: row.result_resource_type, resourceId: row.result_resource_id,
          responseStatus: row.response_status, createdAt: row.created_at, updatedAt: row.updated_at })),
        rowCount: rows.length };
      }
      if (sql.includes('insert into audit.events') && sql.includes('event_id, occurred_at')) {
        expect(sql).toMatch(/on conflict do nothing\s*$/);
        const [id, occurredAt, , subject, accountId, membershipId, , facilityId, patientId, action, resourceType,
          resourceId, details, sourceSystem, sourceEventId] = values as string[];
        expect(subject).toBe(`staff:${accountId}`);
        if (Date.parse(occurredAt as string) > NOW.getTime()) throw Object.assign(new Error('recorded_at check'), { code: '23514' });
        if (events.some((row) => row.eventId === id)) return { rows: [], rowCount: 0 };
        // A uuid foreign key compares case-insensitively, as Postgres does.
        const patientKey = patientId ? String(patientId).toLowerCase() : null;
        if (patientKey && patientKey !== PATIENT && patientKey !== UNRELATED_PATIENT) {
          throw Object.assign(new Error('patient foreign key'), { code: '23503' });
        }
        events.push({ eventId: id as string, occurredAt: occurredAt as string, actorAccountId: accountId as string,
          actorMembershipId: membershipId as string, facilityId: facilityId as string, patientId: patientId ?? null,
          action: action as string, resourceType: resourceType as string, resourceId: resourceId ?? null,
          outcome: /'success'/.test(sql) ? 'success' : 'unknown', purposeOfUse: /'direct-care'/.test(sql) ? 'direct-care' : 'unknown',
          details: JSON.parse(details as string) as Record<string, unknown>,
          provenance: /'application'/.test(sql) ? 'application' : 'unknown',
          sourceSystem: sourceSystem as string, sourceEventId: sourceEventId as string });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('insert into audit.events')) { recordSemantic(values); return { rows: [], rowCount: 1 }; }
      throw new Error(`unexpected query: ${sql}`);
    }),
  });
  return {
    query: jest.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.includes('platform.control_enabled')) {
        return { rows: [{ enabled: values[0] !== 'maintenance_mode' }], rowCount: 1 };
      }
      if (sql.includes('insert into audit.events')) { recordSemantic(values); return { rows: [], rowCount: 1 }; }
      throw new Error(`unexpected pool query: ${sql}`);
    }),
    withTransaction: jest.fn(async (context: DataAccessContext, operation: (client: unknown) => Promise<unknown>) =>
      operation(client(context))),
  } as unknown as DatabaseService;
}

beforeEach(async () => {
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://synthetic:test@localhost/hid',
    CORS_ORIGINS: 'http://localhost', STORAGE_MODE: 'disabled' });
  delete process.env.OFFLINE_ESCROW_ENABLED;
  delete process.env.OFFLINE_ESCROW_KEYS;
  resetEnvironmentForTests();
  keys = [];
  events = [];
  auditFunction = 'present';
  functionCalls = [];
  semantic = [];
  liveActor = me;
  authenticate = jest.fn(async () => {
    if (!liveActor) throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required');
    return liveActor;
  });

  @Module({
    controllers: [OfflineController],
    providers: [
      OfflineService,
      AuditService,
      { provide: DatabaseService, useValue: database() },
      { provide: IdentityApiService, useValue: { authenticateRequest: authenticate } },
      { provide: APP_GUARD, useClass: RemoteSecurityGuard },
      { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    ],
  })
  class OfflineTestModule implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
      consumer.apply(CorrelationMiddleware).forRoutes('{*path}');
    }
  }

  const module = await Test.createTestingModule({ imports: [OfflineTestModule] }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
    transform: true, transformOptions: { enableImplicitConversion: false },
    exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
      errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});

afterEach(async () => {
  await app.close();
  for (const name of Object.keys(process.env)) if (!(name in environment)) delete process.env[name];
  Object.assign(process.env, environment);
  resetEnvironmentForTests();
});

interface Answer { status: number; body: Record<string, unknown>; headers: Record<string, unknown> }

function call(method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = staffHeaders()): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const outgoing = httpRequest(`${baseUrl}/api/v1/ehr/offline/${path}`, { method,
      headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...headers } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0,
        body: text ? JSON.parse(text) as Record<string, unknown> : {}, headers: response.headers }));
    });
    outgoing.on('error', reject);
    outgoing.end(payload);
  });
}

function staffHeaders(facilityId = FACILITY.id): Record<string, string> {
  return { 'X-Facility-ID': facilityId, 'X-Purpose-Of-Use': 'direct-care', 'X-CSRF-Token': 'synthetic-csrf' };
}

function storedKey(owner: string, membershipId: string, facilityId: string, idempotencyKey: string,
  overrides: Partial<KeyRow> = {}): KeyRow {
  const row: KeyRow = { facility_id: facilityId, created_by: owner, created_by_membership_id: membershipId,
    patient_id: PATIENT, idempotency_key: idempotencyKey, operation: 'encounter.create', state: 'completed',
    result_resource_type: 'encounter', result_resource_id: '90000000-0000-4000-8000-000000000001',
    response_status: 201, created_at: new Date('2026-10-29T09:00:00.000Z'), updated_at: new Date('2026-10-29T09:00:00.250Z'),
    ...overrides };
  keys.push(row);
  return row;
}

function readEvent(n: number, overrides: Record<string, unknown> = {}) {
  return { eventId: eventId(n), seq: n, action: 'ehr.record.read', patientId: PATIENT, section: 'encounters',
    resourceId: null, occurredAt: '2026-10-29T09:12:03.120Z', clock: 'anchored', grantExpiresAt: '2026-10-29T17:00:00Z',
    ...overrides };
}

describe('C0 GET /api/v1/ehr/offline/ping', () => {
  it('answers without a session, cookie or facility, and writes no audit', async () => {
    liveActor = undefined;
    const answer = await call('GET', 'ping', undefined, {});
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ service: 'ehr-api', serverTime: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) });
    expect(authenticate).not.toHaveBeenCalled();
    expect(semantic).toEqual([]);
  });
});

describe.each([
  ['receipts/lookup', { keys: [key(1)] }],
  ['audit-events', { vaultId: VAULT, events: [readEvent(1)] }],
  ['escrow-key', { vaultId: VAULT, keyVersion: null }],
])('POST %s refusals', (path, body) => {
  it('answers 401 without a session', async () => {
    liveActor = undefined;
    expect((await call('POST', path, body)).body).toMatchObject({ status: 401, code: 'AUTHENTICATION_REQUIRED' });
  });

  it('answers 403 to a patient session', async () => {
    liveActor = patientActor;
    expect((await call('POST', path, body)).body).toMatchObject({ status: 403, code: 'PATIENT_SCOPE_DENIED' });
  });

  it('answers 400 without a facility and 403 at a facility the actor does not work at', async () => {
    expect((await call('POST', path, body, { 'X-Purpose-Of-Use': 'direct-care' })).body)
      .toMatchObject({ status: 400, code: 'FACILITY_REQUIRED' });
    expect((await call('POST', path, body, staffHeaders('30000000-0000-4000-8000-000000000099'))).body)
      .toMatchObject({ status: 403, code: 'FACILITY_ACCESS_DENIED' });
  });

  it('answers 403 PERMISSION_DENIED with neither ehr.encounter.read nor ehr.document.write', async () => {
    liveActor = staffActor(ME, FACILITY, ['ehr.vital.read']);
    expect((await call('POST', path, body)).body).toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(semantic.map((row) => row.action)).toContain('security.authorization.denied');
  });

  it('answers 400 PURPOSE_OF_USE_REQUIRED unless the purpose is direct-care', async () => {
    const headers = { ...staffHeaders(), 'X-Purpose-Of-Use': 'healthcare-operations' };
    expect((await call('POST', path, body, headers)).body).toMatchObject({ status: 400, code: 'PURPOSE_OF_USE_REQUIRED' });
  });
});

describe('C1 POST /api/v1/ehr/offline/receipts/lookup', () => {
  it('reports the caller\'s completed key without a patient id and audits the lookup', async () => {
    storedKey(ME, FACILITY.membershipId, FACILITY.id, key(1));
    const answer = await call('POST', 'receipts/lookup', { keys: [key(1), key(2)] });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      receipts: [{ key: key(1), operation: 'encounter.create', state: 'completed', resourceType: 'encounter',
        resourceId: '90000000-0000-4000-8000-000000000001', responseStatus: 201,
        createdAt: '2026-10-29T09:00:00.000Z', completedAt: '2026-10-29T09:00:00.250Z' }],
      unknown: [key(2)],
    });
    expect(JSON.stringify(answer.body)).not.toContain(PATIENT);
    expect(semantic).toContainEqual({ action: 'ehr.offline.receipts.lookup', resourceType: 'offline-receipts',
      patientId: null, outcome: 'success', facilityId: FACILITY.id, details: { requested: 2, found: 1 } });
  });

  it('answers another account\'s key, and the caller\'s own key at another facility, as unknown', async () => {
    storedKey(COLLEAGUE, COLLEAGUE_FACILITY.membershipId, FACILITY.id, key(3));
    storedKey(ME, SECOND_FACILITY.membershipId, SECOND_FACILITY.id, key(4));
    const answer = await call('POST', 'receipts/lookup', { keys: [key(3), key(4)] });
    expect(answer.body).toEqual({ receipts: [], unknown: [key(3), key(4)] });
    expect(semantic).toContainEqual(expect.objectContaining({ action: 'ehr.offline.receipts.lookup',
      details: { requested: 2, found: 0 } }));
  });

  it('accepts ehr.document.write alone and needs no consent', async () => {
    liveActor = staffActor(ME, FACILITY, ['ehr.document.write']);
    storedKey(ME, FACILITY.membershipId, FACILITY.id, key(5), { operation: 'document.upload-intent',
      result_resource_type: 'document' });
    const answer = await call('POST', 'receipts/lookup', { keys: [key(5)] });
    expect(answer.status).toBe(200);
    expect(answer.body.receipts).toEqual([expect.objectContaining({ operation: 'document.upload-intent', state: 'completed' })]);
  });

  it('reports a key still processing without a resource', async () => {
    storedKey(ME, FACILITY.membershipId, FACILITY.id, key(6), { state: 'processing', result_resource_type: null,
      result_resource_id: null, response_status: null });
    const answer = await call('POST', 'receipts/lookup', { keys: [key(6)] });
    expect(answer.body.receipts).toEqual([expect.objectContaining({ key: key(6), state: 'processing', resourceType: null,
      resourceId: null, responseStatus: null, completedAt: null })]);
  });

  it('looks a repeated key up once', async () => {
    const answer = await call('POST', 'receipts/lookup', { keys: [key(7), key(7)] });
    expect(answer.body).toEqual({ receipts: [], unknown: [key(7)] });
  });

  it.each([
    ['no body fields', {}],
    ['an empty list', { keys: [] }],
    ['51 keys', { keys: Array.from({ length: 51 }, (_, n) => key(n)) }],
    ['a short key', { keys: ['off1.short'] }],
    ['a key with a space', { keys: ['off1.0b5c 0000-0000-4000'] }],
    ['a non-string key', { keys: [42] }],
    ['keys that are not a list', { keys: key(1) }],
    ['an extra field', { keys: [key(1)], patientId: PATIENT }],
    ['a list body', [key(1)]],
  ])('answers 400 INVALID_KEYS for %s', async (_case, body) => {
    expect((await call('POST', 'receipts/lookup', body)).body).toMatchObject({ status: 400, code: 'INVALID_KEYS' });
  });
});

describe('C2 POST /api/v1/ehr/offline/audit-events', () => {
  it('inserts with the caller\'s event_id and the offline source, then answers a resend as duplicate', async () => {
    const first = await call('POST', 'audit-events', { vaultId: VAULT, events: [readEvent(41)] });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ accepted: [eventId(41)], duplicate: [], rejected: [] });
    expect(events).toEqual([{
      eventId: eventId(41), occurredAt: '2026-10-29T09:12:03.120Z', actorAccountId: ME,
      actorMembershipId: FACILITY.membershipId, facilityId: FACILITY.id, patientId: PATIENT, action: 'ehr.record.read',
      resourceType: 'offline-chart-section', resourceId: null, outcome: 'success', purposeOfUse: 'direct-care',
      provenance: 'application', sourceSystem: 'health-id-offline', sourceEventId: `${VAULT}:41`,
      details: { offline: true, vaultId: VAULT, seq: 41, section: 'encounters', clock: 'anchored',
        deviceOccurredAt: '2026-10-29T09:12:03.120Z', clamped: false, grantExpiresAt: '2026-10-29T17:00:00Z' },
    }]);
    const again = await call('POST', 'audit-events', { vaultId: VAULT, events: [readEvent(41), readEvent(42)] });
    expect(again.body).toEqual({ accepted: [eventId(42)], duplicate: [eventId(41)], rejected: [] });
    expect(events).toHaveLength(2);
  });

  it('clamps a future occurredAt to now and one older than 26 hours to now - 26 h, keeping the device time', async () => {
    const answer = await call('POST', 'audit-events', { vaultId: VAULT, events: [
      readEvent(1, { occurredAt: '2026-10-29T11:00:00.000Z' }),
      readEvent(2, { occurredAt: '2026-10-27T00:00:00.000Z', clock: 'suspect' }),
      readEvent(3, { occurredAt: '2026-10-28T08:43:00.000Z' }),
    ] });
    expect(answer.body).toEqual({ accepted: [eventId(1), eventId(2), eventId(3)], duplicate: [], rejected: [] });
    expect(events.map((row) => [row.occurredAt, row.details.deviceOccurredAt, row.details.clamped])).toEqual([
      ['2026-10-29T10:42:00.123Z', '2026-10-29T11:00:00.000Z', true],
      ['2026-10-28T08:42:00.123Z', '2026-10-27T00:00:00.000Z', true],
      ['2026-10-28T08:43:00.000Z', '2026-10-28T08:43:00.000Z', false],
    ]);
  });

  it('records session events without a patient, and a discard with its details', async () => {
    const answer = await call('POST', 'audit-events', { vaultId: VAULT, events: [
      readEvent(1, { action: 'ehr.offline.unlock', patientId: null, section: null }),
      readEvent(2, { action: 'ehr.offline.wipe', patientId: null, section: 'lease' }),
      readEvent(3, { action: 'ehr.offline.command.discarded', section: null, details: { op: 'ehr.vital.create',
        reason: 'Entered for the wrong visit', bodySha256: 'a'.repeat(64), capturedAt: '2026-10-29T09:00:00.000Z' } }),
    ] });
    expect(answer.body).toEqual({ accepted: [eventId(1), eventId(2), eventId(3)], duplicate: [], rejected: [] });
    expect(events.map((row) => [row.action, row.patientId, row.resourceType])).toEqual([
      ['ehr.offline.unlock', null, 'offline-session'],
      ['ehr.offline.wipe', null, 'offline-session'],
      ['ehr.offline.command.discarded', PATIENT, 'offline-chart-section'],
    ]);
    expect(events[1]?.details.section).toBe('lease');
    expect(events[2]?.details).toMatchObject({ op: 'ehr.vital.create', reason: 'Entered for the wrong visit',
      bodySha256: 'a'.repeat(64), capturedAt: '2026-10-29T09:00:00.000Z' });
  });

  it('rejects events one by one with the contract\'s codes and writes the rest', async () => {
    const answer = await call('POST', 'audit-events', { vaultId: VAULT, events: [
      readEvent(1, { action: 'ehr.record.write' }),
      readEvent(2, { section: 'billing' }),
      readEvent(3, { patientId: null }),
      readEvent(4, { action: 'ehr.offline.unlock', section: null }),
      readEvent(5, { patientId: UNKNOWN_PATIENT }),
      readEvent(6, { occurredAt: 'yesterday' }),
      readEvent(7, { clock: 'atomic' }),
      readEvent(8, { seq: -1 }),
      readEvent(9, { action: 'ehr.offline.wipe', patientId: null, section: 'stolen' }),
      readEvent(10, { action: 'ehr.offline.command.discarded', details: { op: 'ehr.vital.create' } }),
      readEvent(11, { diagnosis: 'malaria' }),
      readEvent(13, { details: { reasonTruncated: true } }),
      readEvent(12),
    ] });
    expect(answer.body).toEqual({
      accepted: [eventId(12)],
      duplicate: [],
      rejected: [
        { eventId: eventId(1), code: 'INVALID_ACTION' },
        { eventId: eventId(2), code: 'INVALID_EVENT' },
        { eventId: eventId(3), code: 'INVALID_EVENT' },
        { eventId: eventId(4), code: 'INVALID_EVENT' },
        { eventId: eventId(6), code: 'INVALID_EVENT' },
        { eventId: eventId(7), code: 'INVALID_EVENT' },
        { eventId: eventId(8), code: 'INVALID_EVENT' },
        { eventId: eventId(9), code: 'INVALID_EVENT' },
        { eventId: eventId(10), code: 'INVALID_EVENT' },
        { eventId: eventId(11), code: 'INVALID_EVENT' },
        { eventId: eventId(13), code: 'INVALID_EVENT' },
        { eventId: eventId(5), code: 'PATIENT_NOT_FOUND' },
      ],
    });
    expect(events.map((row) => row.eventId)).toEqual([eventId(12)]);
  });

  it.each([
    ['no vault', { events: [readEvent(1)] }],
    ['a vault that is not a UUID', { vaultId: 'vault-1', events: [readEvent(1)] }],
    ['no events', { vaultId: VAULT, events: [] }],
    ['21 events', { vaultId: VAULT, events: Array.from({ length: 21 }, (_, n) => readEvent(n)) }],
    ['an event without a UUID eventId', { vaultId: VAULT, events: [{ ...readEvent(1), eventId: 'e1' }] }],
    ['an extra field', { vaultId: VAULT, events: [readEvent(1)], facilityId: FACILITY.id }],
  ])('answers 400 VALIDATION_FAILED for %s', async (_case, body) => {
    expect((await call('POST', 'audit-events', body)).body).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(events).toEqual([]);
  });
});

describe('C4 POST /api/v1/ehr/offline/escrow-key', () => {
  it('answers 503 OFFLINE_ESCROW_UNAVAILABLE while OFFLINE_ESCROW_ENABLED is not true', async () => {
    const answer = await call('POST', 'escrow-key', { vaultId: VAULT, keyVersion: null });
    expect(answer.body).toMatchObject({ status: 503, code: 'OFFLINE_ESCROW_UNAVAILABLE' });
    expect(semantic.map((row) => row.action)).not.toContain('ehr.offline.escrow-key.issue');
  });

  it('answers 503 while OFFLINE_ESCROW_ENABLED is false even with keys present', async () => {
    process.env.OFFLINE_ESCROW_ENABLED = 'false';
    process.env.OFFLINE_ESCROW_KEYS = JSON.stringify({ 1: Buffer.alloc(32, 7).toString('base64url') });
    resetEnvironmentForTests();
    expect((await call('POST', 'escrow-key', { vaultId: VAULT })).body)
      .toMatchObject({ status: 503, code: 'OFFLINE_ESCROW_UNAVAILABLE' });
  });

  it('issues a key when enabled and audits the issue without the key', async () => {
    process.env.OFFLINE_ESCROW_ENABLED = 'true';
    process.env.OFFLINE_ESCROW_KEYS = JSON.stringify({ 1: Buffer.alloc(32, 7).toString('base64url') });
    resetEnvironmentForTests();
    const answer = await call('POST', 'escrow-key', { vaultId: VAULT, keyVersion: null });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ keyVersion: 1, key: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), algorithm: 'HKDF-SHA256' });
    const issued = semantic.find((row) => row.action === 'ehr.offline.escrow-key.issue');
    expect(issued).toEqual({ action: 'ehr.offline.escrow-key.issue', resourceType: 'offline-escrow-key', patientId: null,
      outcome: 'success', facilityId: FACILITY.id, details: { vaultId: VAULT, keyVersion: 1 } });
    expect(JSON.stringify(semantic)).not.toContain(answer.body.key as string);
  });

  it.each([
    ['a vault that is not a UUID', { vaultId: 'vault-1' }],
    ['a zero key version', { vaultId: VAULT, keyVersion: 0 }],
    ['a key version as text', { vaultId: VAULT, keyVersion: '1' }],
    ['an extra field', { vaultId: VAULT, accountId: ME }],
  ])('answers 400 VALIDATION_FAILED for %s', async (_case, body) => {
    expect((await call('POST', 'escrow-key', body)).body).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });
});

describe('C2 patient relationship (contract A10)', () => {
  it('answers 503 OFFLINE_AUDIT_UNAVAILABLE and writes nothing until the check function is installed', async () => {
    auditFunction = 'absent';
    const answer = await call('POST', 'audit-events', { vaultId: VAULT, events: [
      readEvent(1, { action: 'ehr.offline.unlock', patientId: null, section: null }), readEvent(2)] });
    expect(answer.body).toMatchObject({ status: 503, code: 'OFFLINE_AUDIT_UNAVAILABLE' });
    expect(events).toEqual([]);
  });

  it('answers 503 and writes nothing when the runtime may not execute the check', async () => {
    auditFunction = 'no-execute';
    const answer = await call('POST', 'audit-events', { vaultId: VAULT, events: [readEvent(1)] });
    expect(answer.body).toMatchObject({ status: 503, code: 'OFFLINE_AUDIT_UNAVAILABLE' });
    expect(events).toEqual([]);
  });

  it('rejects an existing patient the caller has no grant for exactly as a missing one', async () => {
    const answer = await call('POST', 'audit-events', { vaultId: VAULT, events: [
      readEvent(1, { patientId: UNRELATED_PATIENT }), readEvent(2, { patientId: UNKNOWN_PATIENT }), readEvent(3)] });
    expect(answer.body).toEqual({ accepted: [eventId(3)], duplicate: [], rejected: [
      { eventId: eventId(1), code: 'PATIENT_NOT_FOUND' }, { eventId: eventId(2), code: 'PATIENT_NOT_FOUND' }] });
    expect(events.map((row) => row.patientId)).toEqual([PATIENT]);
  });

  it('matches a patient id sent in upper case to the lower-case answer of the check', async () => {
    const answer = await call('POST', 'audit-events', { vaultId: VAULT, events: [readEvent(1, { patientId: PATIENT.toUpperCase() })] });
    expect(answer.body).toEqual({ accepted: [eventId(1)], duplicate: [], rejected: [] });
    expect(functionCalls).toEqual([PATIENT]);
  });

  it('checks a patient the caller holds a grant for and accepts the event', async () => {
    const answer = await call('POST', 'audit-events', { vaultId: VAULT, events: [readEvent(1), readEvent(2)] });
    expect(answer.body).toEqual({ accepted: [eventId(1), eventId(2)], duplicate: [], rejected: [] });
    expect(functionCalls).toContain(PATIENT);
  });

  it('accepts session-only batches without the check, even while the function is missing', async () => {
    auditFunction = 'absent';
    const answer = await call('POST', 'audit-events', { vaultId: VAULT, events: [
      readEvent(1, { action: 'ehr.offline.unlock', patientId: null, section: null }),
      readEvent(2, { action: 'ehr.offline.wipe', patientId: null, section: 'sign-out' })] });
    expect(answer.body).toEqual({ accepted: [eventId(1), eventId(2)], duplicate: [], rejected: [] });
    expect(functionCalls).toEqual([]);
  });
});

describe('C2 seq and calendar bounds (contract A10)', () => {
  it.each([[2147483648], [0]])('rejects seq %p as INVALID_EVENT', async (seq) => {
    const answer = await call('POST', 'audit-events', { vaultId: VAULT, events: [readEvent(1, { seq })] });
    expect(answer.body).toEqual({ accepted: [], duplicate: [], rejected: [{ eventId: eventId(1), code: 'INVALID_EVENT' }] });
  });

  it('accepts seq 2147483647', async () => {
    const answer = await call('POST', 'audit-events', { vaultId: VAULT, events: [readEvent(1, { seq: 2147483647 })] });
    expect(answer.body).toEqual({ accepted: [eventId(1)], duplicate: [], rejected: [] });
  });

  it.each(['2026-09-31T10:00:00Z', '2026-09-30T24:00:00+01:00'])('rejects the impossible occurredAt %s', async (occurredAt) => {
    const answer = await call('POST', 'audit-events', { vaultId: VAULT, events: [readEvent(1, { occurredAt })] });
    expect(answer.body).toEqual({ accepted: [], duplicate: [], rejected: [{ eventId: eventId(1), code: 'INVALID_EVENT' }] });
  });

  it('rejects an impossible grantExpiresAt or discard capturedAt', async () => {
    const answer = await call('POST', 'audit-events', { vaultId: VAULT, events: [
      readEvent(1, { grantExpiresAt: '2026-02-30T00:00:00Z' }),
      readEvent(2, { action: 'ehr.offline.command.discarded', section: null, details: { op: 'ehr.vital.create',
        reason: 'Entered for the wrong visit', bodySha256: 'a'.repeat(64), capturedAt: '2026-10-28T24:00:00.000Z' } })] });
    expect(answer.body).toMatchObject({ accepted: [], rejected: [
      { eventId: eventId(1), code: 'INVALID_EVENT' }, { eventId: eventId(2), code: 'INVALID_EVENT' }] });
  });
});
