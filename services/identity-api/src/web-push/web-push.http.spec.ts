jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import { createDecipheriv, createHash, randomUUID } from 'node:crypto';
import { Global, type INestApplication, Module, RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type { NextFunction, Response } from 'express';
import request from 'supertest';
import { syntheticBrowserKeys, syntheticVapidPublicKey } from '../../test/web-push.fixtures';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditService } from '../audit/audit.service';
import { NotificationOtpClient } from '../auth/notification-otp.client';
import { SecurityGuard } from '../auth/security.guard';
import { TokenService } from '../auth/token.service';
import { AUDIT_ACTION, AUDIT_FAILURES_ONLY, PATIENT_ONLY } from '../common/decorators';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { WebPushController } from './web-push.controller';
import { WebPushModule } from './web-push.module';
import { webPushKeyId } from './web-push-endpoint';

// R1 to R3 exactly as the website sends them: a cookie session, Origin and
// X-CSRF-Token on the PUT and the POST.
const origin = 'https://app.healthidentitydirectory.com';
const base = '/api/v1/identity/me/web-push';
const patient: ActorContext = { kind: 'patient', id: 'synthetic:patient', subject: 'synthetic:patient',
  accountId: '70000000-0000-4000-8000-000000000001', patientId: '50000000-0000-4000-8000-000000000001',
  sessionId: '80000000-0000-4000-8000-000000000001', roles: [], permissions: [], platformRoles: [],
  platformPermissions: [], facilityIds: [], facilities: [], authenticationMethod: 'local' } as ActorContext;
const staff: ActorContext = { kind: 'staff', id: 'staff:doctor', subject: 'staff:doctor',
  accountId: '20000000-0000-4000-8000-000000000001', roles: ['doctor'], permissions: [], platformRoles: [],
  platformPermissions: [], facilityIds: [], facilities: [], authenticationMethod: 'local' };
const publicKey = syntheticVapidPublicKey();
const keyId = webPushKeyId(Buffer.from(publicKey, 'base64url'));
const endpoint = 'https://fcm.googleapis.com/fcm/send/eXaMpLe:APA91bHxSynthetic';
const digest = createHash('sha256').update(endpoint).digest('hex');
const contactKey = Buffer.alloc(32, 3);

describe('Web push routes (B6, R1-R3)', () => {
  const originalEnvironment = { ...process.env };
  let app: INestApplication;
  let commandAnswer: (sql: string, values: unknown[]) => unknown;
  let rateLimitRow: unknown[];
  const calls: { sql: string; values: unknown[] }[] = [];
  const respond = jest.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.includes('platform.control_enabled($1)')) return { rows: [{ enabled: values[0] !== 'maintenance_mode' }] };
    if (sql.includes('from auth.otp_rate_limits')) return { rows: rateLimitRow };
    if (sql.includes('web_push')) return commandAnswer(sql, values);
    return { rows: [] };
  });
  const database = {
    query: respond,
    withTransaction: jest.fn(async (_context: unknown, work: (client: unknown) => Promise<unknown>) => work({ query: respond })),
    withSystemTransaction: jest.fn(async (_correlation: unknown, work: (client: unknown) => Promise<unknown>) => work({ query: respond })),
  };
  const tokens = { verify: jest.fn(), verifyCsrf: jest.fn() };
  const audit = { record: jest.fn() };
  const commandCalls = (name: string) => calls.filter((call) => call.sql.includes(name));
  const send = (method: 'get' | 'put' | 'post', path: string, body?: unknown) => {
    const pending = request(app.getHttpServer())[method](`${base}${path}`)
      .set('Cookie', 'hid_access=session; hid_access_csrf=token').set('Origin', origin).set('X-CSRF-Token', 'token');
    return body === undefined ? pending : pending.send(body as object);
  };
  const subscription = (overrides: Record<string, unknown> = {}) => ({
    endpoint, expirationTime: null, keys: syntheticBrowserKeys(), keyId, ...overrides,
  });

  async function start(environment: Record<string, string | undefined>): Promise<void> {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid', CORS_ORIGINS: origin,
      AUTH_MODE: 'local', AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456', AUTH_COOKIE_SECURE: 'true',
      NIN_ENCRYPTION_KEY_B64: contactKey.toString('base64'), NIN_KEY_VERSION: 'test-v1',
      OTP_HMAC_KEY_B64: Buffer.alloc(32, 5).toString('base64'),
      WEB_PUSH_VAPID_PUBLIC_KEY: publicKey, WEB_PUSH_SUBJECT: 'mailto:support@healthidentitydirectory.com',
    });
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    resetEnvironmentForTests();
    // The global modules' services, as AppModule provides them to WebPushModule.
    @Global()
    @Module({
      providers: [
        { provide: DatabaseService, useValue: database },
        { provide: TokenService, useValue: tokens },
        { provide: AuditService, useValue: audit },
        { provide: NotificationOtpClient, useValue: {} },
      ],
      exports: [DatabaseService, TokenService, AuditService, NotificationOtpClient],
    })
    class GlobalStubs {}
    const moduleRef = await Test.createTestingModule({
      // WebPushModule itself, so its off middleware is wired as in AppModule.
      imports: [GlobalStubs, WebPushModule],
      providers: [
        { provide: APP_GUARD, useFactory: (reflector: Reflector) => new SecurityGuard(reflector,
          tokens as unknown as TokenService, audit as unknown as AuditService, database as unknown as DatabaseService),
        inject: [Reflector] },
        { provide: APP_INTERCEPTOR, useFactory: (reflector: Reflector) => new AuditInterceptor(reflector,
          audit as unknown as AuditService), inject: [Reflector] },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.use((incoming: HidRequest, _response: Response, next: NextFunction) => { incoming.correlationId = randomUUID(); next(); });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
      transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
      exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
        errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
  }

  beforeEach(() => {
    jest.clearAllMocks();
    calls.length = 0;
    rateLimitRow = [];
    commandAnswer = (sql) => {
      if (sql.includes('list_my_web_push_subscriptions')) return { rows: [] };
      if (sql.includes('unsubscribe_my_web_push')) return { rows: [{ removed: true }] };
      if (sql.includes('subscribe_my_web_push')) return { rows: [{ subscription_id: '6a1e0000-0000-4000-8000-000000000001', created: true }] };
      return { rows: [] };
    };
    tokens.verify.mockResolvedValue({ actor: patient, claims: {} });
    tokens.verifyCsrf.mockReturnValue(true);
    audit.record.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await app?.close();
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    resetEnvironmentForTests();
  });

  it('declares the three routes, patient-only, failures audited, with the contract\'s actions', () => {
    const handlers = ['state', 'subscribe', 'unsubscribe'].map((name) => {
      const handler = (WebPushController.prototype as unknown as Record<string, object>)[name]!;
      return [Reflect.getMetadata(METHOD_METADATA, handler), Reflect.getMetadata(PATH_METADATA, handler),
        Reflect.getMetadata(AUDIT_ACTION, handler) ?? null];
    });
    expect(Reflect.getMetadata(PATH_METADATA, WebPushController)).toBe('identity/me/web-push');
    expect(handlers).toEqual([
      [RequestMethod.GET, '/', null],
      [RequestMethod.PUT, 'subscription', 'identity.patient.web-push.subscribe.command'],
      [RequestMethod.POST, 'subscription/remove', 'identity.patient.web-push.unsubscribe.command'],
    ]);
    expect(Reflect.getMetadata(PATIENT_ONLY, WebPushController)).toBe(true);
    expect(Reflect.getMetadata(AUDIT_FAILURES_ONLY, WebPushController)).toBe(true);
  });

  describe.each([
    ['no keys', { WEB_PUSH_VAPID_PUBLIC_KEY: undefined, WEB_PUSH_SUBJECT: undefined }],
    ['no subject', { WEB_PUSH_SUBJECT: undefined }],
    ['an invalid public key', { WEB_PUSH_VAPID_PUBLIC_KEY: 'B'.repeat(87) }],
    ['an invalid subject', { WEB_PUSH_SUBJECT: 'support@healthidentitydirectory.com' }],
  ])('while push is off (%s)', (_label, environment) => {
    beforeEach(() => start(environment));

    it('answers every route a plain 404, a malformed body too, and touches nothing', async () => {
      for (const [method, path, body] of [['get', '', undefined], ['put', '/subscription', subscription()],
        ['put', '/subscription', { nonsense: true }], ['post', '/subscription/remove', { endpoint }],
        ['post', '/subscription/remove', 'not json']] as const) {
        const answer = await send(method, path, body);
        expect([method, path, answer.status]).toEqual([method, path, 404]);
        expect(JSON.stringify(answer.body)).not.toMatch(/web.?push|vapid/i);
      }
      expect(calls.filter((call) => /web_push|otp_rate_limits/.test(call.sql))).toEqual([]);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('answers 404 before authentication and CSRF: no session check, control read or audit row', async () => {
      // As the real TokenService: only the live cookie verifies, and only with a CSRF header.
      tokens.verify.mockImplementation(async (token: string) => {
        if (token !== 'session') throw new Error('expired');
        return { actor: patient, claims: {} };
      });
      tokens.verifyCsrf.mockImplementation((_claims: unknown, cookie?: string, header?: string) =>
        cookie !== undefined && cookie === header);
      const server = app.getHttpServer();
      const answers = [
        await request(server).get(base),
        await request(server).get(base).set('Cookie', 'hid_access=expired').set('Origin', origin),
        await request(server).put(`${base}/subscription`).set('Cookie', 'hid_access=session; hid_access_csrf=token')
          .set('Origin', origin).send(subscription()),
        await request(server).put(`${base}/subscription`).set('Cookie', 'hid_access=session; hid_access_csrf=token')
          .set('Origin', 'https://evil.example').set('X-CSRF-Token', 'token').send(subscription()),
        await request(server).post(`${base}/subscription/remove`).send({ endpoint }),
        await request(server).head(base),
      ];
      expect(answers.map((answer) => answer.status)).toEqual([404, 404, 404, 404, 404, 404]);
      for (const answer of answers.slice(0, 5)) {
        expect([answer.body.status, answer.body.code]).toEqual([404, 'NOT_FOUND']);
        expect(JSON.stringify(answer.body)).not.toMatch(/web.?push|vapid/i);
      }
      expect(calls).toEqual([]);
      expect(tokens.verify).not.toHaveBeenCalled();
      expect(tokens.verifyCsrf).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('while push is on', () => {
    beforeEach(() => start({}));

    it('R1: answers the public key, its id and this account\'s subscriptions, never an endpoint or session', async () => {
      commandAnswer = () => ({ rows: [
        { subscription_id: 's1', endpoint_sha256: digest, push_service: 'fcm', this_sign_in: true, vapid_key_id: keyId,
          created_at: new Date('2026-10-28T10:00:00Z'), bound_at: new Date('2026-10-28T10:05:00Z'), last_delivered_at: null },
        { subscription_id: 's2', endpoint_sha256: 'b'.repeat(64), push_service: 'apple', this_sign_in: false,
          vapid_key_id: 'aaaaaaaaaaaaaaaa', created_at: new Date('2026-10-27T10:00:00Z'),
          bound_at: new Date('2026-10-27T10:00:00Z'), last_delivered_at: new Date('2026-10-28T09:00:00Z') },
      ] });
      const answer = await send('get', '');
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ applicationServerKey: publicKey, keyId, limit: 10, subscriptions: [
        { id: 's1', endpointDigest: digest, pushService: 'fcm', thisSignIn: true, keyCurrent: true,
          createdAt: '2026-10-28T10:00:00.000Z', boundAt: '2026-10-28T10:05:00.000Z', lastDeliveredAt: null },
        { id: 's2', endpointDigest: 'b'.repeat(64), pushService: 'apple', thisSignIn: false, keyCurrent: false,
          createdAt: '2026-10-27T10:00:00.000Z', boundAt: '2026-10-27T10:00:00.000Z', lastDeliveredAt: '2026-10-28T09:00:00.000Z' },
      ] });
      expect(commandCalls('list_my_web_push_subscriptions').map((call) => call.values)).toEqual([[patient.subject, patient.sessionId]]);
      expect(calls.some((call) => call.sql.includes("set_config('app.actor_subject', $1, true)")
        && call.values[0] === patient.subject)).toBe(true);
    });

    it('R2: subscribes with the digest, the encrypted endpoint bound to its id, the push service and the key id', async () => {
      const answer = await send('put', '/subscription', subscription());
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ id: '6a1e0000-0000-4000-8000-000000000001', created: true, endpointDigest: digest, pushService: 'fcm' });
      const [values] = commandCalls('identity.subscribe_my_web_push').map((call) => call.values);
      expect(values).toHaveLength(8);
      const [subject, session, subscriptionId, sentDigest, ciphertext, keyVersion, pushService, sentKeyId] = values!;
      expect([subject, session, sentDigest, keyVersion, pushService, sentKeyId])
        .toEqual([patient.subject, patient.sessionId, digest, 'test-v1', 'fcm', keyId]);
      expect(subscriptionId).toMatch(/^[0-9a-f-]{36}$/);
      const value = ciphertext as Buffer;
      const decipher = createDecipheriv('aes-256-gcm', contactKey, value.subarray(1, 13));
      decipher.setAAD(Buffer.from(`identity:web-push-subscription:${String(subscriptionId)}:endpoint`));
      decipher.setAuthTag(value.subarray(value.length - 16));
      expect(Buffer.concat([decipher.update(value.subarray(13, value.length - 16)), decipher.final()]).toString()).toBe(endpoint);
      // The keys are never sent to the database.
      expect(JSON.stringify(calls.map((call) => call.values))).not.toContain(syntheticBrowserKeys().auth);
      // Counted in the account's hourly bucket (30), keyed by an HMAC, never the account id.
      const bucket = calls.find((call) => call.sql.includes('from auth.otp_rate_limits'))!;
      expect(bucket.values[0]).toBe('account');
      expect(bucket.values[1]).toMatch(/^[0-9a-f]{64}$/);
      expect(bucket.values[1]).not.toContain(patient.accountId!);
    });

    it('R2: a re-subscribe answers created false', async () => {
      commandAnswer = () => ({ rows: [{ subscription_id: '6a1e0000-0000-4000-8000-000000000009', created: false }] });
      const answer = await send('put', '/subscription', subscription({ expirationTime: 1767225600000 }));
      expect([answer.status, answer.body.created, answer.body.id]).toEqual([200, false, '6a1e0000-0000-4000-8000-000000000009']);
    });

    it.each([
      ['an extra field', subscription({ extra: 1 })],
      ['no keys', { endpoint, keyId }],
      ['an extra key', subscription({ keys: { ...syntheticBrowserKeys(), other: 'x' } })],
      ['a key id that is not 16 hex', subscription({ keyId: 'ABCDEF0123456789' })],
      ['an expirationTime string', subscription({ expirationTime: 'soon' })],
      ['a numeric endpoint', subscription({ endpoint: 42 })],
    ])('R2: refuses %s with the ValidationPipe\'s 400', async (_label, body) => {
      const answer = await send('put', '/subscription', body);
      expect([answer.status, answer.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      expect(commandCalls('subscribe_my_web_push')).toHaveLength(0);
    });

    it.each([
      ['a short p256dh', { p256dh: Buffer.alloc(64, 4).toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') }],
      ['a p256dh not starting 0x04', { p256dh: Buffer.alloc(65, 3).toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') }],
      ['a 15-byte auth', { p256dh: syntheticBrowserKeys().p256dh, auth: Buffer.alloc(15, 1).toString('base64url') }],
    ])('R2: refuses %s with 400 WEB_PUSH_SUBSCRIPTION_INVALID', async (_label, keys) => {
      const answer = await send('put', '/subscription', subscription({ keys }));
      expect([answer.status, answer.body.code]).toEqual([400, 'WEB_PUSH_SUBSCRIPTION_INVALID']);
      expect(commandCalls('subscribe_my_web_push')).toHaveLength(0);
    });

    it('R2: accepts padded keys', async () => {
      const keys = { p256dh: `${syntheticBrowserKeys().p256dh}=`, auth: `${Buffer.alloc(16, 1).toString('base64url')}==` };
      expect((await send('put', '/subscription', subscription({ keys }))).status).toBe(200);
    });

    it.each([
      ['http:', 'http://fcm.googleapis.com/fcm/send/x', 'WEB_PUSH_SUBSCRIPTION_INVALID'],
      ['a port', 'https://fcm.googleapis.com:8443/fcm/send/x', 'WEB_PUSH_SUBSCRIPTION_INVALID'],
      ['an empty fragment', `${endpoint}#`, 'WEB_PUSH_SUBSCRIPTION_INVALID'],
      ['an upper-case host', 'https://FCM.googleapis.com/fcm/send/x', 'WEB_PUSH_SUBSCRIPTION_INVALID'],
      ['a lookalike host', 'https://fcm.googleapis.com.evil.example/fcm/send/x', 'WEB_PUSH_SERVICE_UNSUPPORTED'],
      ['the metadata address', 'https://169.254.169.254/latest', 'WEB_PUSH_SERVICE_UNSUPPORTED'],
    ])('R2: refuses an endpoint with %s', async (_label, value, code) => {
      const answer = await send('put', '/subscription', subscription({ endpoint: value }));
      expect([answer.status, answer.body.code]).toEqual([400, code]);
      expect(commandCalls('subscribe_my_web_push')).toHaveLength(0);
    });

    it('R2: 409 WEB_PUSH_KEY_CHANGED for another key id, before counting', async () => {
      const answer = await send('put', '/subscription', subscription({ keyId: 'aaaaaaaaaaaaaaaa' }));
      expect([answer.status, answer.body.code]).toEqual([409, 'WEB_PUSH_KEY_CHANGED']);
      expect(calls.some((call) => call.sql.includes('otp_rate_limits'))).toBe(false);
    });

    it('R2: 429 WEB_PUSH_RATE_LIMITED once the account\'s hour is used up', async () => {
      rateLimitRow = [{ request_count: 31, window_started_at: new Date(), blocked_until: new Date(Date.now() + 3_600_000) }];
      const answer = await send('put', '/subscription', subscription());
      expect([answer.status, answer.body.code]).toEqual([429, 'WEB_PUSH_RATE_LIMITED']);
      expect(commandCalls('subscribe_my_web_push')).toHaveLength(0);
    });

    it.each([
      ['42501', 403, 'PATIENT_SESSION_REQUIRED'],
      ['22023', 400, 'WEB_PUSH_SUBSCRIPTION_INVALID'],
      ['23505', 503, 'WEB_PUSH_UNAVAILABLE'],
      ['40P01', 503, 'WEB_PUSH_UNAVAILABLE'],
    ])('R2: maps SQL %s to %i %s, never the driver\'s message', async (code, status, problem) => {
      commandAnswer = () => { throw Object.assign(new Error(`relation secret ${endpoint}`), { code }); };
      const answer = await send('put', '/subscription', subscription());
      expect([answer.status, answer.body.code]).toEqual([status, problem]);
      expect(JSON.stringify(answer.body)).not.toContain('secret');
      expect(JSON.stringify(answer.body)).not.toContain('fcm.googleapis.com');
    });

    it('R3: removes by digest, idempotently, and is never rate limited', async () => {
      let answer = await send('post', '/subscription/remove', { endpoint });
      expect([answer.status, answer.body]).toEqual([200, { removed: true }]);
      commandAnswer = () => ({ rows: [{ removed: false }] });
      answer = await send('post', '/subscription/remove', { endpoint: 'https://example.com/not-a-push-service' });
      expect([answer.status, answer.body]).toEqual([200, { removed: false }]);
      expect(commandCalls('unsubscribe_my_web_push').map((call) => call.values)).toEqual([
        [patient.subject, patient.sessionId, digest],
        [patient.subject, patient.sessionId, createHash('sha256').update('https://example.com/not-a-push-service').digest('hex')],
      ]);
      expect(calls.some((call) => call.sql.includes('otp_rate_limits'))).toBe(false);
    });

    it.each([['http://fcm.googleapis.com/x'], ['https://FCM.googleapis.com/x'], ['nope']])(
      'R3: refuses %s with 400 WEB_PUSH_SUBSCRIPTION_INVALID', async (value) => {
        const answer = await send('post', '/subscription/remove', { endpoint: value });
        expect([answer.status, answer.body.code]).toEqual([400, 'WEB_PUSH_SUBSCRIPTION_INVALID']);
      });

    it('refuses a staff session in the guard with 403 PATIENT_SESSION_REQUIRED', async () => {
      tokens.verify.mockResolvedValue({ actor: staff, claims: {} });
      const answer = await send('get', '');
      expect([answer.status, answer.body.code]).toEqual([403, 'PATIENT_SESSION_REQUIRED']);
      expect(commandCalls('web_push')).toHaveLength(0);
    });

    it('audits a failure, never a success, through the interceptor', async () => {
      await send('put', '/subscription', subscription());
      expect(audit.record.mock.calls.map(([event]) => (event as { outcome: string }).outcome)).not.toContain('success');
      await send('put', '/subscription', subscription({ keyId: 'aaaaaaaaaaaaaaaa' }));
      expect(audit.record.mock.calls.map(([event]) => (event as { action: string }).action))
        .toContain('api.identity.patient.web-push.subscribe.command');
    });
  });

  describe('while push is on but the contact key is missing', () => {
    beforeEach(() => start({ NIN_ENCRYPTION_KEY_B64: undefined }));

    it('R2: 503 WEB_PUSH_UNAVAILABLE after the checks, nothing stored', async () => {
      const answer = await send('put', '/subscription', subscription());
      expect([answer.status, answer.body.code]).toEqual([503, 'WEB_PUSH_UNAVAILABLE']);
      expect(commandCalls('subscribe_my_web_push')).toHaveLength(0);
    });
  });
});
