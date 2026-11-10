import { createHash } from 'node:crypto';
import { Global, type INestApplication, Module, type MiddlewareConsumer, type NestModule, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
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
import { CardShareModule } from './card-share.module';

// GET /api/v1/card-share/records, as main.ts composes it: cookie parser,
// correlation middleware, the module's switch middleware, the real security
// guard, audit interceptor and problem filter, over a database stand-in.
// Synthetic values only.

const VIEW_ID = '7e300000-0000-4000-8000-000000000001';
const PATIENT_ID = 'e8b10000-0000-4000-8000-000000000001';
const SECRET = 'U3ludGhldGljVmlld1NlY3JldDAxMjM0NTY3ODlBQkM';
const COOKIE = `hid_cv_${VIEW_ID.replace(/-/g, '')}=${SECRET}`;
const environment = { ...process.env };

let app: INestApplication;
let baseUrl: string;
let authenticate: jest.Mock;
let settings: Array<[string, unknown[]]>;
let scope: 'card' | 'card_and_records';
let viewContext: () => unknown;
let transactions: number;

const profileRow = { blood_group: 'O+', genotype: 'AA', allergies: 'Synthetic allergy', current_medications: 'Synthetic medicine',
  chronic_conditions: 'Synthetic condition', medical_notes: 'Synthetic note' };

async function start(enabled: string | undefined, entries?: string): Promise<void> {
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://synthetic:test@localhost/hid',
    CORS_ORIGINS: 'http://localhost', STORAGE_MODE: 'disabled' });
  if (enabled === undefined) delete process.env.CARD_LINKS_ENABLED; else process.env.CARD_LINKS_ENABLED = enabled;
  if (entries === undefined) delete process.env.PATIENT_ENTRIES_ENABLED; else process.env.PATIENT_ENTRIES_ENABLED = entries;
  resetEnvironmentForTests();
  settings = [];
  transactions = 0;
  scope = 'card_and_records';
  viewContext = () => ({ rows: [{ patient_id: PATIENT_ID, share_id: '5e100000-0000-4000-8000-000000000001',
    view_id: VIEW_ID, scope }] });
  authenticate = jest.fn();
  const client = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('ehr.card_share_view_context')) return viewContext();
      if (sql.includes('from ehr.encounters')) return { rows: [{ id: 'e1', status: 'completed' }] };
      if (sql.includes('from ehr.clinical_notes')) return { rows: [{ id: 'n1', content: 'Synthetic note' }] };
      if (sql.includes('from ehr.imported_medical_records')) {
        return { rows: [{ id: 'r1', files: [{ id: 'f1', fileName: 'synthetic.pdf', mediaType: 'application/pdf',
          sizeBytes: 10, accessStatus: 'available', downloadUrl: 'https://should-never-appear.example' }] }] };
      }
      if (sql.includes('from ehr.imported_patient_health_profiles')) return { rows: [] };
      if (sql.includes('from ehr.patient_reported_health_profiles')) return { rows: [profileRow] };
      if (sql.includes('from ehr.patient_entries')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    }),
  };
  const database = {
    query: jest.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.includes('platform.control_enabled')) return { rows: [{ enabled: values[0] !== 'maintenance_mode' }], rowCount: 1 };
      throw new Error(`unexpected pool query: ${sql}`);
    }),
    // As DatabaseService.withCardShareTransaction: the view context first, then the reads with it.
    withCardShareTransaction: jest.fn(async (digest: string, correlation: string,
      work: (c: unknown, view: unknown) => Promise<unknown>) => {
      transactions += 1;
      settings.push(['card', [digest, correlation]]);
      const view = (await client.query('select patient_id::text, share_id::text, view_id::text, scope from ehr.card_share_view_context()') as { rows: unknown[] }).rows[0];
      if (!view) throw Object.assign(new Error('CARD_SHARE_VIEW_ENDED'), { code: '55000' });
      return work(client, view);
    }),
    withPatientTransaction: jest.fn(async () => { throw new Error('no patient transaction expected'); }),
    withTransaction: jest.fn(async () => { throw new Error('no staff transaction expected'); }),
  };

  @Global()
  @Module({
    providers: [AuditService, { provide: DatabaseService, useValue: database },
      { provide: IdentityApiService, useValue: { authenticateRequest: authenticate, authorizeSelf: jest.fn() } }],
    exports: [AuditService, DatabaseService, IdentityApiService],
  })
  class TestGlobals {}

  @Module({
    imports: [TestGlobals, CardShareModule],
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
  app.use(cookieParser());
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true,
    exceptionFactory: () => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.') }));
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

function get(headers: Record<string, string>): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(`${baseUrl}/api/v1/card-share/records`, { method: 'GET',
      headers: { 'x-correlation-id': 'card-share-http-0001', ...headers } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0,
        body: text ? JSON.parse(text) as Record<string, unknown> : {}, headers: response.headers }));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

const RECORD_KEYS = ['diagnoses', 'documents', 'encounters', 'healthProfile', 'importedHealthProfile', 'importedRecords',
  'labRequests', 'limit', 'notes', 'patientEntries', 'patientEntriesMore', 'prescriptions', 'scope', 'vitals'];

describe('The card-link records read (0118) while CARD_LINKS_ENABLED is false (switched off)', () => {
  it('answers the plain 404, before any guard or database', async () => {
    await start('false');
    const answer = await get({ cookie: COOKIE, 'x-card-view': VIEW_ID });
    expect(answer.status).toBe(404);
    expect(answer.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(transactions).toBe(0);
    expect(authenticate).not.toHaveBeenCalled();
  });
});

describe('The card-link records read (0118) while CARD_LINKS_ENABLED is unset (on by default since 4 Nov 2026)', () => {
  it('reads in a card-share transaction', async () => {
    await start(undefined);
    const answer = await get({ cookie: COOKIE, 'x-card-view': VIEW_ID });
    expect(answer.status).toBe(200);
    expect(transactions).toBe(1);
    expect(authenticate).not.toHaveBeenCalled();
  });
});

describe('The card-link records read (0118) while on', () => {
  it('reads in a card-share transaction keyed by the SHA-256 of the view cookie, never a patient or staff session', async () => {
    await start('true');
    const answer = await get({ cookie: `${COOKIE}; hid_access=patient-session; hid_access_csrf=x`, 'x-card-view': VIEW_ID,
      authorization: 'Bearer patient-token' });
    expect(answer.status).toBe(200);
    expect(settings).toEqual([['card', [createHash('sha256').update(SECRET).digest('hex'), 'card-share-http-0001']]]);
    expect(authenticate).not.toHaveBeenCalled();
    expect(String(answer.headers['cache-control'])).toContain('no-store');
    expect(Object.keys(answer.body).sort()).toEqual(RECORD_KEYS);
    expect(answer.body).toMatchObject({ scope: 'card_and_records', encounters: [{ id: 'e1' }], notes: [{ id: 'n1' }],
      healthProfile: { bloodGroup: 'O+', genotype: 'AA', allergies: 'Synthetic allergy',
        chronicConditions: 'Synthetic condition', medications: 'Synthetic medicine', notes: 'Synthetic note' },
      importedHealthProfile: null, diagnoses: [], prescriptions: [], labRequests: [], vitals: [], documents: [], limit: 50 });
    // Files carry a name and a type only: nothing to download in v1.
    expect((answer.body.importedRecords as Array<{ files: unknown[] }>)[0]?.files).toEqual([
      { id: 'f1', fileName: 'synthetic.pdf', mediaType: 'application/pdf' }]);
    expect(JSON.stringify(answer.body)).not.toMatch(/download|url/i);
  });

  it('keeps patientEntries [] while PATIENT_ENTRIES_ENABLED is off, and reads them while on', async () => {
    await start('true');
    let answer = await get({ cookie: COOKIE, 'x-card-view': VIEW_ID });
    expect(answer.body).toMatchObject({ patientEntries: [], patientEntriesMore: false });
    await app.close();
    await start('true', 'true');
    answer = await get({ cookie: COOKIE, 'x-card-view': VIEW_ID });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ patientEntries: [], patientEntriesMore: false });
  });

  it('answers "Card only" with the card part of the health information and every other key empty', async () => {
    await start('true');
    scope = 'card';
    const answer = await get({ cookie: COOKIE, 'x-card-view': VIEW_ID });
    expect(answer.status).toBe(200);
    expect(Object.keys(answer.body).sort()).toEqual(RECORD_KEYS);
    expect(answer.body).toEqual({ scope: 'card', encounters: [], notes: [], importedRecords: [], importedHealthProfile: null,
      healthProfile: { bloodGroup: 'O+', genotype: 'AA', allergies: 'Synthetic allergy' }, patientEntries: [],
      patientEntriesMore: false, diagnoses: [], prescriptions: [], labRequests: [], vitals: [], documents: [], limit: 50 });
  });

  it.each([
    ['no cookie', {}],
    ['no view header', { cookie: COOKIE }],
    ['a malformed view header', { cookie: COOKIE, 'x-card-view': 'not-a-uuid' }],
    ['the cookie of another view', { cookie: COOKIE, 'x-card-view': '7e300000-0000-4000-8000-000000000002' }],
  ])('answers 410 CARD_SHARE_VIEW_ENDED for %s, never 401, without reading', async (_label, headers) => {
    await start('true');
    const answer = await get(headers as Record<string, string>);
    expect(answer.status).toBe(410);
    expect(answer.body).toMatchObject({ code: 'CARD_SHARE_VIEW_ENDED', detail: 'This card is no longer shared with you.' });
    expect(transactions).toBe(0);
  });

  it('answers 410 when the view has ended, or names another view (two links in one browser)', async () => {
    await start('true');
    viewContext = () => { throw Object.assign(new Error('CARD_SHARE_VIEW_ENDED'), { code: '55000' }); };
    let answer = await get({ cookie: COOKIE, 'x-card-view': VIEW_ID });
    expect(answer.status).toBe(410);
    expect(answer.body).toMatchObject({ code: 'CARD_SHARE_VIEW_ENDED' });
    viewContext = () => ({ rows: [{ patient_id: PATIENT_ID, share_id: '5e1', view_id: '7e300000-0000-4000-8000-000000000009',
      scope: 'card' }] });
    answer = await get({ cookie: COOKIE, 'x-card-view': VIEW_ID });
    expect(answer.status).toBe(410);
  });
});
