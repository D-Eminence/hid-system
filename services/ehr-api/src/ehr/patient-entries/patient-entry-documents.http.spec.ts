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
import { STORAGE_PROVIDER } from '../../storage/storage.types';
import { PatientEntriesModule } from './patient-entries.module';

// The files' routes (0117) as AppModule, EhrModule and main.ts compose them:
// the correlation middleware, PatientEntriesModule's two switch middlewares,
// the real security guard, audit interceptor, problem filter and validation
// pipe, over stand-ins for Identity, the database and S3. Synthetic values.

const PATIENT_ID = '60000000-0000-4000-8000-000000000001';
const ENTRY_ID = '22222222-2222-4222-8222-222222222222';
const DOCUMENT_ID = '44444444-4444-4444-8444-444444444444';
const KEY = 'clinical/objects/55555555-5555-4555-8555-555555555555';
const BUCKET = 'hid-staging-documents';
const SHA = 'ab'.repeat(32);
const patientActor: IdentityActorContext = { kind: 'patient', patientId: PATIENT_ID, id: 'patient:p', subject: 'patient:p',
  accountId: '20000000-0000-4000-8000-0000000000c1', sessionId: '90000000-0000-4000-8000-000000000001', roles: [],
  permissions: [], facilityIds: [], facilities: [], authenticationMethod: 'local' } as IdentityActorContext;
const environment = { ...process.env };
const file = { fileName: 'malaria-test.jpg', mediaType: 'image/jpeg', sizeBytes: 2048, sha256Hex: SHA };
const intentRow = (outcome: string, overrides: Record<string, unknown> = {}) => ({ outcome, document_id: DOCUMENT_ID,
  document_status: 'initiated', document_scan_status: 'pending', document_storage_bucket: BUCKET, document_storage_key: KEY,
  document_media_type: 'image/jpeg', document_size_bytes: '2048', document_sha256_hex: SHA, retry_after_seconds: null,
  ...overrides });

let app: INestApplication;
let baseUrl: string;
let authenticate: jest.Mock;
let authorizeSelf: jest.Mock;
let poolQueries: string[];
let transactionRows: unknown[][];
let transactions: number;
let storage: { bucket: jest.Mock; createUpload: jest.Mock; inspect: jest.Mock; readPrefix: jest.Mock; createDownload: jest.Mock };

async function start(settings: { entries?: string; files?: string } = {}): Promise<void> {
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://synthetic:test@localhost/hid',
    CORS_ORIGINS: 'http://localhost', STORAGE_MODE: 'disabled' });
  for (const [name, value] of [['PATIENT_ENTRIES_ENABLED', settings.entries], ['PATIENT_ENTRY_FILES_ENABLED', settings.files]]) {
    if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
  }
  resetEnvironmentForTests();
  poolQueries = [];
  transactions = 0;
  transactionRows = [[intentRow('created')]];
  authenticate = jest.fn(async () => patientActor);
  authorizeSelf = jest.fn(async () => ({ patientId: PATIENT_ID, accountId: patientActor.accountId,
    subject: patientActor.subject, sessionId: patientActor.sessionId, expiresAt: new Date(Date.now() + 30_000).toISOString() }));
  storage = {
    bucket: jest.fn(() => BUCKET),
    createUpload: jest.fn(async () => ({ method: 'PUT', url: `https://s3.example/${KEY}?X-Amz-Signature=synthetic`,
      expiresInSeconds: 300, requiredHeaders: { 'content-type': 'image/jpeg' } })),
    inspect: jest.fn(async () => ({ versionId: 'version-1', sizeBytes: 2048, mediaType: 'image/jpeg', sha256Hex: SHA })),
    readPrefix: jest.fn(async () => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])),
    createDownload: jest.fn(),
  };
  const database = {
    query: jest.fn(async (sql: string, values: unknown[] = []) => {
      poolQueries.push(sql);
      if (sql.includes('platform.control_enabled')) return { rows: [{ enabled: values[0] !== 'maintenance_mode' }], rowCount: 1 };
      if (sql.includes('insert into audit.events')) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected pool query: ${sql}`);
    }),
    withPatientTransaction: jest.fn(async (_auth: unknown, _correlation: string, work: (client: unknown) => Promise<unknown>) => {
      transactions += 1;
      return work({ query: jest.fn(async () => {
        const rows = transactionRows.shift() ?? [];
        return { rows, rowCount: rows.length };
      }) });
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

  const module = await Test.createTestingModule({ imports: [TestApplication] })
    .overrideProvider(STORAGE_PROVIDER).useValue(storage).compile();
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
      headers: { ...(payload ? { 'content-type': 'application/json' } : {}), 'x-correlation-id': 'patient-files-http-0001',
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

const intentPath = `me/patient-entries/${ENTRY_ID}/documents/upload-intents`;
const completePath = `me/patient-entries/${ENTRY_ID}/documents/${DOCUMENT_ID}/complete`;
const key = { 'idempotency-key': 'web-file-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' };

describe('The files\' routes while switched off', () => {
  it.each([
    [{ files: 'false' }, 'POST', intentPath, file],
    [{ files: 'false' }, 'POST', intentPath, { colour: 'blue' }],
    [{ files: 'false' }, 'POST', completePath, undefined],
    [{ files: 'false' }, 'POST', 'me/patient-entries/not-a-uuid/documents/upload-intents', file],
    [{ files: 'false' }, 'GET', `patients/${PATIENT_ID}/patient-entries/${ENTRY_ID}/documents/${DOCUMENT_ID}/download`, undefined],
    [{ entries: 'false' }, 'POST', intentPath, file],
    [{ entries: 'false', files: 'true' }, 'POST', completePath, undefined],
  ] as const)('with %j answer %s %s exactly as if not built: 404 NOT_FOUND before authentication, validation or audit',
    async (settings, method, path, body) => {
      await start(settings);
      const answer = await call(method, path, body, key);
      expect(answer.status).toBe(404);
      expect(String(answer.headers['content-type'])).toMatch(/^application\/problem\+json/);
      expect(answer.body).toMatchObject({ status: 404, code: 'NOT_FOUND', correlationId: 'patient-files-http-0001' });
      expect(authenticate).not.toHaveBeenCalled();
      expect(authorizeSelf).not.toHaveBeenCalled();
      expect(poolQueries).toEqual([]);
      expect(transactions).toBe(0);
      expect(storage.createUpload).not.toHaveBeenCalled();
    });

  it('leaves the text records\' routes served (PATIENT_ENTRY_FILES_ENABLED does not touch them)', async () => {
    await start({ files: 'false' });
    transactionRows = [[{ outcome: 'withdrawn', entry_id: ENTRY_ID, entry_withdrawn_at: new Date('2026-11-02T10:00:00.000Z') }]];
    const removed = await call('POST', `me/patient-entries/${ENTRY_ID}/withdraw`);
    expect(removed.status).toBe(200);
  });
});

describe('The files\' routes while on (the default)', () => {
  it('answers a new upload link 201 with the staff shape, never cached', async () => {
    await start();
    const answer = await call('POST', intentPath, file, key);
    expect(answer.status).toBe(201);
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(answer.body).toEqual({ document: { id: DOCUMENT_ID, status: 'initiated', scanStatus: 'pending' },
      upload: { method: 'PUT', url: `https://s3.example/${KEY}?X-Amz-Signature=synthetic`, expiresInSeconds: 300,
        requiredHeaders: { 'content-type': 'image/jpeg' } } });
  });

  it('answers a replay before the confirm 201 again (not 200), with a fresh link', async () => {
    await start();
    transactionRows = [[intentRow('replayed')]];
    const answer = await call('POST', intentPath, file, key);
    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({ document: { id: DOCUMENT_ID, status: 'initiated', scanStatus: 'pending' },
      upload: { method: 'PUT' } });
    expect(storage.createUpload).toHaveBeenCalledTimes(1);
  });

  it('answers a replay after the confirm 409 PATIENT_DOCUMENT_ALREADY_UPLOADED with the document', async () => {
    await start();
    transactionRows = [[intentRow('already_uploaded', { document_status: 'uploaded', document_scan_status: 'scan_started' })]];
    const answer = await call('POST', intentPath, file, key);
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ status: 409, code: 'PATIENT_DOCUMENT_ALREADY_UPLOADED',
      document: { id: DOCUMENT_ID, status: 'uploaded', scanStatus: 'pending' } });
    expect(storage.createUpload).not.toHaveBeenCalled();
  });

  it('answers the 11th of the day 429 PATIENT_DOCUMENT_DAILY_LIMIT, the usual problem with Retry-After', async () => {
    await start();
    transactionRows = [[intentRow('daily_limit', { document_id: null, retry_after_seconds: 7322 })]];
    const answer = await call('POST', intentPath, file, key);
    expect(answer.status).toBe(429);
    expect(answer.headers['retry-after']).toBe('7322');
    expect(String(answer.headers['content-type'])).toMatch(/^application\/problem\+json/);
    expect(answer.body).toMatchObject({ status: 429, code: 'PATIENT_DOCUMENT_DAILY_LIMIT' });
    expect(answer.body).not.toHaveProperty('document');
  });

  it('answers the 6th on a record 409 PATIENT_DOCUMENT_ENTRY_LIMIT and a removed record 404 PATIENT_ENTRY_NOT_FOUND', async () => {
    await start();
    transactionRows = [[intentRow('entry_full', { document_id: null })], [intentRow('entry_not_found', { document_id: null })]];
    expect((await call('POST', intentPath, file, key)).body).toMatchObject({ status: 409, code: 'PATIENT_DOCUMENT_ENTRY_LIMIT' });
    expect((await call('POST', intentPath, file, key)).body).toMatchObject({ status: 404, code: 'PATIENT_ENTRY_NOT_FOUND' });
  });

  it('refuses a member the server sets (the patient, classification, retention) with 400 before Identity', async () => {
    await start();
    for (const extra of [{ patientId: PATIENT_ID }, { classification: 'phi' }, { retentionClass: 'clinical-record' }]) {
      const answer = await call('POST', intentPath, { ...file, ...extra }, key);
      expect([answer.status, answer.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    }
    const noKey = await call('POST', intentPath, file);
    expect([noKey.status, noKey.body.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
    expect(authorizeSelf).not.toHaveBeenCalled();
    expect(transactions).toBe(0);
  });

  it('confirms with no body and answers 200 with the document; a type mismatch 409 PATIENT_DOCUMENT_TYPE_MISMATCH', async () => {
    await start();
    const stored = { id: DOCUMENT_ID, status: 'initiated', scan_status: 'pending', storage_bucket: BUCKET, storage_key: KEY,
      object_version_id: null, declared_media_type: 'image/jpeg', detected_media_type: null, size_bytes: '2048',
      sha256_hex: SHA, original_file_name: 'malaria-test.jpg' };
    transactionRows = [[stored], [{ outcome: 'uploaded', document_id: DOCUMENT_ID, document_status: 'uploaded',
      document_scan_status: 'pending' }], [stored]];
    const confirmed = await call('POST', completePath);
    expect([confirmed.status, confirmed.body]).toEqual([200, { document: { id: DOCUMENT_ID, status: 'uploaded',
      scanStatus: 'pending' } }]);
    storage.readPrefix.mockResolvedValueOnce(Uint8Array.from(Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'latin1')));
    const mismatch = await call('POST', completePath);
    expect([mismatch.status, mismatch.body.code]).toEqual([409, 'PATIENT_DOCUMENT_TYPE_MISMATCH']);
  });

  it('keeps the staff download from a patient session', async () => {
    await start();
    const staff = await call('GET', `patients/${PATIENT_ID}/patient-entries/${ENTRY_ID}/documents/${DOCUMENT_ID}/download`,
      undefined, { 'x-facility-id': '30000000-0000-4000-8000-000000000001', 'x-purpose-of-use': 'direct-care' });
    expect(staff.status).toBe(403);
    expect(storage.createDownload).not.toHaveBeenCalled();
  });
});
