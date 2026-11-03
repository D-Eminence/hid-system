import { Global, type INestApplication, Module, type MiddlewareConsumer, type NestModule, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { IdentityActorContext } from '@hid/api-client';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AuditInterceptor } from '../../audit/audit.interceptor';
import { AuditService } from '../../audit/audit.service';
import { RemoteSecurityGuard } from '../../auth/remote-security.guard';
import { CorrelationMiddleware } from '../../common/correlation.middleware';
import { DomainProblem, ProblemDetailsFilter } from '../../common/problem';
import { resetEnvironmentForTests } from '../../config/environment';
import { DatabaseService } from '../../database/database.service';
import { IdentityApiService } from '../../integrations/identity-api.service';
import { PatientEntriesModule } from './patient-entries.module';

// The routes run here as AppModule, EhrModule and main.ts compose them: the
// correlation middleware, PatientEntriesModule's switch middleware, the real
// security guard, audit interceptor, problem filter and validation pipe, over
// stand-ins for Identity and the database. Synthetic values only.

const PATIENT_ID = '60000000-0000-4000-8000-000000000001';
const ENTRY_ID = '22222222-2222-4222-8222-222222222222';
const patientActor: IdentityActorContext = { kind: 'patient', patientId: PATIENT_ID, id: 'patient:p', subject: 'patient:p',
  accountId: '20000000-0000-4000-8000-0000000000c1', sessionId: '90000000-0000-4000-8000-000000000001', roles: [],
  permissions: [], facilityIds: [], facilities: [], authenticationMethod: 'local' } as IdentityActorContext;
const environment = { ...process.env };

let app: INestApplication;
let baseUrl: string;
let authenticate: jest.Mock;
let authorizeSelf: jest.Mock;
let poolQueries: string[];
let transactionRows: unknown[];
let transactions: number;

async function start(enabled: string | undefined): Promise<void> {
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://synthetic:test@localhost/hid',
    CORS_ORIGINS: 'http://localhost', STORAGE_MODE: 'disabled' });
  if (enabled === undefined) delete process.env.PATIENT_ENTRIES_ENABLED;
  else process.env.PATIENT_ENTRIES_ENABLED = enabled;
  resetEnvironmentForTests();
  poolQueries = [];
  transactions = 0;
  transactionRows = [{ outcome: 'created', entry_id: ENTRY_ID, entry_kind: 'visit', entry_title: 'Malaria check-up',
    entry_facility_name: null, entry_occurred_on: '2026-10-30', entry_notes: null,
    entry_created_at: new Date('2026-11-02T09:15:00.000Z') }];
  authenticate = jest.fn(async () => patientActor);
  authorizeSelf = jest.fn(async () => ({ patientId: PATIENT_ID, accountId: patientActor.accountId,
    subject: patientActor.subject, sessionId: patientActor.sessionId, expiresAt: new Date(Date.now() + 30_000).toISOString() }));
  const database = {
    query: jest.fn(async (sql: string, values: unknown[] = []) => {
      poolQueries.push(sql);
      // Maintenance off, the patient portal on.
      if (sql.includes('platform.control_enabled')) return { rows: [{ enabled: values[0] !== 'maintenance_mode' }], rowCount: 1 };
      if (sql.includes('insert into audit.events')) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected pool query: ${sql}`);
    }),
    withPatientTransaction: jest.fn(async (_auth: unknown, _correlation: string, work: (client: unknown) => Promise<unknown>) => {
      transactions += 1;
      return work({ query: jest.fn(async () => ({ rows: transactionRows, rowCount: transactionRows.length })) });
    }),
    withTransaction: jest.fn(async () => { throw new Error('no staff transaction expected'); }),
  };

  @Global()
  @Module({
    providers: [AuditService, { provide: DatabaseService, useValue: database },
      { provide: IdentityApiService, useValue: { authenticateRequest: authenticate, authorizeSelf } }],
    exports: [AuditService, DatabaseService, IdentityApiService],
  })
  class TestGlobals {}

  @Module({
    imports: [TestGlobals, PatientEntriesModule],
    providers: [{ provide: APP_GUARD, useClass: RemoteSecurityGuard }, { provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
  })
  class TestApplication implements NestModule {
    configure(consumer: MiddlewareConsumer): void {
      consumer.apply(CorrelationMiddleware).forRoutes('{*path}');
    }
  }

  const module = await Test.createTestingModule({ imports: [TestApplication] }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
    transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
    exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
      errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
}

afterEach(async () => {
  await app?.close();
  for (const name of Object.keys(process.env)) if (!(name in environment)) delete process.env[name];
  Object.assign(process.env, environment);
  resetEnvironmentForTests();
});

interface Answer { status: number; body: Record<string, unknown>; headers: Record<string, unknown> }

function call(method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const outgoing = httpRequest(`${baseUrl}/api/v1/ehr/${path}`, { method,
      headers: { ...(payload ? { 'content-type': 'application/json' } : {}), 'x-correlation-id': 'patient-entries-http-0001',
        'x-csrf-token': 'synthetic-csrf', ...headers } }, (response) => {
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

const entry = { kind: 'visit', title: 'Malaria check-up', facilityName: null, occurredOn: '2026-10-30', notes: null };

describe('Records patients add while the setting is off (the default)', () => {
  it.each([
    ['POST', 'me/patient-entries', entry],
    ['POST', 'me/patient-entries', { kind: 'xray', unexpected: true, attachments: ['x'] }],
    ['POST', `me/patient-entries/${ENTRY_ID}/withdraw`, undefined],
    ['POST', 'me/patient-entries/not-a-uuid/withdraw', undefined],
    ['GET', 'me/patient-entries', undefined],
    ['GET', 'me/patient-entries?before=not-a-cursor', undefined],
    ['GET', `patients/${PATIENT_ID}/patient-entries`, undefined],
  ] as const)('answers %s %s with the plain 404, before authentication, validation or audit', async (method, path, body) => {
    await start(undefined);
    const answer = await call(method, path, body);
    expect(answer.status).toBe(404);
    expect(String(answer.headers['content-type'])).toMatch(/^application\/problem\+json/);
    expect(answer.body).toMatchObject({ status: 404, code: 'NOT_FOUND', correlationId: 'patient-entries-http-0001' });
    expect(authenticate).not.toHaveBeenCalled();
    expect(authorizeSelf).not.toHaveBeenCalled();
    expect(poolQueries).toEqual([]);
    expect(transactions).toBe(0);
  });

  it('is off for any value but true', async () => {
    await start('false');
    expect((await call('POST', 'me/patient-entries', entry)).body).toMatchObject({ code: 'NOT_FOUND' });
    expect(authenticate).not.toHaveBeenCalled();
  });
});

describe('Records patients add while the setting is on', () => {
  it('saves a record and answers 201 with the entry, never cached', async () => {
    await start('true');
    const answer = await call('POST', 'me/patient-entries', entry,
      { 'idempotency-key': 'web-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' });
    expect(answer.status).toBe(201);
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(answer.body).toEqual({ entry: { id: ENTRY_ID, source: 'patient', kind: 'visit', title: 'Malaria check-up',
      facilityName: null, occurredOn: '2026-10-30', notes: null, createdAt: '2026-11-02T09:15:00.000Z', documents: [] },
      replayed: false });
    expect(authenticate).toHaveBeenCalled();
    expect(authorizeSelf).toHaveBeenCalled();
  });

  it('answers a replayed save (the same key and values, or a double tap) 200, not 201, with the same entry', async () => {
    await start('true');
    transactionRows = [{ ...(transactionRows[0] as Record<string, unknown>), outcome: 'replayed' }];
    const replays: Record<string, string>[] = [{ 'idempotency-key': 'web-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' }, {}];
    for (const headers of replays) {
      const answer = await call('POST', 'me/patient-entries', entry, headers);
      expect(answer.status).toBe(200);
      expect(answer.headers['cache-control']).toBe('no-store');
      expect(answer.body).toMatchObject({ entry: { id: ENTRY_ID }, replayed: true });
    }
    transactionRows = [{ ...(transactionRows[0] as Record<string, unknown>), outcome: 'created' }];
    expect((await call('POST', 'me/patient-entries', entry)).status).toBe(201);
  });

  it('refuses a field it does not know with 400, and photos or files with 422, before Identity and the database', async () => {
    await start('true');
    const unknown = await call('POST', 'me/patient-entries', { ...entry, colour: 'blue' });
    expect([unknown.status, unknown.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    const notAList = await call('POST', 'me/patient-entries', { ...entry, attachments: 'photo.jpg' });
    expect([notAList.status, notAList.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    const photos = await call('POST', 'me/patient-entries', { ...entry, attachments: [{ name: 'photo.jpg' }] });
    expect([photos.status, photos.body.code, photos.body.detail]).toEqual([422, 'PATIENT_ENTRY_FILES_NOT_READY',
      'Photos can\'t be added yet. Save the record without them.']);
    const files = await call('POST', 'me/patient-entries', { ...entry, fileIds: [ENTRY_ID] });
    expect([files.status, files.body.code]).toEqual([422, 'PATIENT_ENTRY_FILES_NOT_READY']);
    expect(authorizeSelf).not.toHaveBeenCalled();
    expect(transactions).toBe(0);
    const empty = await call('POST', 'me/patient-entries', { ...entry, attachments: [], fileIds: [] });
    expect(empty.status).toBe(201);
  });

  it('answers a removal of an entry that is not the patient\'s with its own 404', async () => {
    await start('true');
    transactionRows = [{ outcome: 'not_found', entry_id: ENTRY_ID, entry_withdrawn_at: null }];
    const answer = await call('POST', `me/patient-entries/${ENTRY_ID}/withdraw`);
    expect([answer.status, answer.body.code]).toEqual([404, 'PATIENT_ENTRY_NOT_FOUND']);
    transactionRows = [{ outcome: 'withdrawn', entry_id: ENTRY_ID, entry_withdrawn_at: new Date('2026-11-02T10:00:00.000Z') }];
    const removed = await call('POST', `me/patient-entries/${ENTRY_ID}/withdraw`);
    expect([removed.status, removed.body]).toEqual([200, { entry: { id: ENTRY_ID, status: 'withdrawn',
      withdrawnAt: '2026-11-02T10:00:00.000Z' }, replayed: false }]);
  });

  it('lists the patient\'s own records 50 at a time, from a cursor, never cached', async () => {
    await start('true');
    transactionRows = [{ id: ENTRY_ID, kind: 'visit', title: 'Malaria check-up', facility_name: null,
      occurred_on: '2026-10-30', notes: null, created_at: new Date('2026-11-02T09:15:00.000Z'),
      cursor_at: '2026-11-02T09:15:00.000123Z' }];
    const list = await call('GET', 'me/patient-entries');
    expect(list.status).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body).toEqual({ items: [{ id: ENTRY_ID, source: 'patient', kind: 'visit', title: 'Malaria check-up',
      facilityName: null, occurredOn: '2026-10-30', notes: null, createdAt: '2026-11-02T09:15:00.000Z', documents: [] }],
      nextBefore: null });
    expect(authorizeSelf).toHaveBeenCalled();
    // A cursor of the wrong shape, or a parameter it does not know, is refused before Identity and the database.
    authorizeSelf.mockClear();
    const before = transactions;
    for (const path of ['me/patient-entries?before=short', 'me/patient-entries?limit=100']) {
      const refused = await call('GET', path);
      expect([refused.status, refused.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    }
    expect(authorizeSelf).not.toHaveBeenCalled();
    // A well-formed cursor it did not issue is its own 400.
    const forged = await call('GET', `me/patient-entries?before=${'A'.repeat(40)}`);
    expect([forged.status, forged.body.code]).toEqual([400, 'INVALID_CURSOR']);
    expect(transactions).toBe(before);
  });

  it('keeps the staff read from a patient session', async () => {
    await start('true');
    const staff = await call('GET', `patients/${PATIENT_ID}/patient-entries`, undefined,
      { 'x-facility-id': '30000000-0000-4000-8000-000000000001', 'x-purpose-of-use': 'direct-care' });
    expect([staff.status, staff.body.code]).toEqual([403, 'PATIENT_SCOPE_DENIED']);
  });
});
