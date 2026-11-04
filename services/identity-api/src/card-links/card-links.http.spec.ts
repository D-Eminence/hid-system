jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import { createHash, randomUUID } from 'node:crypto';
import { Global, type INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type { NextFunction, Response } from 'express';
import request from 'supertest';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditService } from '../audit/audit.service';
import { NotificationOtpClient } from '../auth/notification-otp.client';
import { SecurityGuard } from '../auth/security.guard';
import { TokenService } from '../auth/token.service';
import { TurnstileService } from '../auth/turnstile.service';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { CardLinksModule } from './card-links.module';
import { CardLinksProtector } from './card-links.protector';
import { CardLinksService } from './card-links.service';

// The card-link routes (0118) as the website calls them, over stand-ins for
// the database, Identity's tokens, Turnstile and notification-api. The
// patient's routes use a cookie session with Origin and CSRF; the receiver's
// routes are public and never read a session. Synthetic values only.
const origin = 'https://app.healthidentitydirectory.com';
const patient: ActorContext = { kind: 'patient', id: 'patient:ada', subject: 'patient:ada',
  accountId: '70000000-0000-4000-8000-000000000001', patientId: '50000000-0000-4000-8000-000000000001',
  sessionId: '80000000-0000-4000-8000-000000000001', roles: [], permissions: [], platformRoles: [],
  platformPermissions: [], facilityIds: [], facilities: [], authenticationMethod: 'local' } as ActorContext;
const SHARE_ID = '5e100000-0000-4000-8000-000000000001';
const VIEW_COOKIE = /^hid_cv_[0-9a-f]{32}=/;
const TOKEN = 'Q2FyZExpbmtUb2tlbjAxMjM0NTY3ODlBQkNERUZHSEk';
const card = { viewId: '7e300000-0000-4000-8000-000000000001', viewExpiresAt: '2026-11-04T10:30:00.000Z',
  fullName: 'Ada Cardlink', healthId: 'HID-E8ADAA', ninVerified: true, sharedByFirstName: 'Ada',
  recipientHint: 'k•••@example.com', reference: 'K7P2-QX9M', scope: 'card_and_records', expiresAt: '2026-11-05T10:00:00.000Z' };

describe('Card links (0118): routes', () => {
  const originalEnvironment = { ...process.env };
  let app: INestApplication;
  let protector: CardLinksProtector;
  let answers: Record<string, (values: unknown[]) => unknown>;
  const calls: { sql: string; values: unknown[] }[] = [];
  const respond = jest.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.includes('platform.control_enabled($1)')) return { rows: [{ enabled: values[0] !== 'maintenance_mode' }] };
    if (sql.includes('auth.otp_challenges')) return { rows: [{ held: false }] };
    if (sql.includes('join auth.sessions family')) return { rows: [{ recent: answers.recent ? answers.recent(values) : true }] };
    const name = Object.keys(answers).find((key) => sql.includes(key));
    if (name) return answers[name]!(values);
    return { rows: [] };
  });
  const database = {
    query: respond,
    withTransaction: jest.fn(async (_context: unknown, work: (client: unknown) => Promise<unknown>) => work({ query: respond })),
    withSystemTransaction: jest.fn(async (_correlation: unknown, work: (client: unknown) => Promise<unknown>) => work({ query: respond })),
  };
  const tokens = { verify: jest.fn(), verifyCsrf: jest.fn() };
  const audit = { record: jest.fn() };
  const turnstile = { verify: jest.fn() };
  const notification = {
    deliverCardShareLink: jest.fn(), deliverCardShareCode: jest.fn(), deliverCardShareOpened: jest.fn(),
    deliverCardShareCreated: jest.fn(),
  };
  const commandCalls = (name: string) => calls.filter((call) => call.sql.includes(name));
  const patientCall = (method: 'get' | 'post', path: string) => request(app.getHttpServer())[method](`/api/v1/identity/me/card-shares${path}`)
    .set('Cookie', 'hid_access=session; hid_access_csrf=token').set('Origin', origin).set('X-CSRF-Token', 'token');
  const publicCall = (method: 'get' | 'post', path: string) => request(app.getHttpServer())[method](`/api/v1/card-share/${path}`)
    .set('Origin', origin);

  async function start(enabled: string | undefined): Promise<void> {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid', CORS_ORIGINS: origin,
      AUTH_MODE: 'local', AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456', AUTH_COOKIE_SECURE: 'true',
      NIN_ENCRYPTION_KEY_B64: Buffer.alloc(32, 3).toString('base64'), NIN_KEY_VERSION: 'test-v1',
      OTP_HMAC_KEY_B64: Buffer.alloc(32, 5).toString('base64'),
    });
    if (enabled === undefined) delete process.env.CARD_LINKS_ENABLED; else process.env.CARD_LINKS_ENABLED = enabled;
    resetEnvironmentForTests();
    protector = new CardLinksProtector();
    @Global()
    @Module({
      providers: [
        { provide: DatabaseService, useValue: database }, { provide: TokenService, useValue: tokens },
        { provide: AuditService, useValue: audit }, { provide: NotificationOtpClient, useValue: notification },
        { provide: TurnstileService, useValue: turnstile },
      ],
      exports: [DatabaseService, TokenService, AuditService, NotificationOtpClient, TurnstileService],
    })
    class GlobalStubs {}
    const moduleRef = await Test.createTestingModule({
      imports: [GlobalStubs, CardLinksModule],
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

  const settle = () => app.get(CardLinksService).settleEmails();

  beforeEach(() => {
    jest.clearAllMocks();
    calls.length = 0;
    answers = {};
    tokens.verify.mockResolvedValue({ actor: patient, claims: {} });
    tokens.verifyCsrf.mockReturnValue(true);
    audit.record.mockResolvedValue(undefined);
    turnstile.verify.mockResolvedValue(undefined);
    for (const send of Object.values(notification)) send.mockResolvedValue({ outcome: 'accepted', provider: 'ses' });
  });

  afterEach(async () => {
    await app?.close();
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    resetEnvironmentForTests();
  });

  describe('while CARD_LINKS_ENABLED is off (the default)', () => {
    it.each([
      ['get', 'patient', ''], ['post', 'patient', ''], ['post', 'patient', `/${SHARE_ID}/end`],
      ['get', 'public', 'availability'], ['post', 'public', 'code'], ['post', 'public', 'verify'],
      ['get', 'public', 'view'], ['post', 'public', 'end-view'], ['post', 'public', 'stop'],
    ] as const)('%s %s %s answers the plain 404 before any guard, token, Turnstile or database', async (method, kind, path) => {
      await start(undefined);
      const answer = await (kind === 'patient' ? patientCall(method, path) : publicCall(method, path)).send({});
      expect(answer.status).toBe(404);
      expect(answer.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(tokens.verify).not.toHaveBeenCalled();
      expect(turnstile.verify).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    });
  });

  describe('the patient', () => {
    const create = { email: ' Kemi.Doctor@Example.com ', label: 'Dr Kemi', scope: 'card_and_records', duration: '24h' };
    const created = (values: unknown[]) => ({ rows: [{ outcome: 'created', share_id: values[2], reference: 'K7P2-QX9M',
      created_at: new Date('2026-11-04T10:00:00.000Z'), expires_at: new Date('2026-11-05T10:00:00.000Z'),
      replaced_share_id: null, send_email: true, address_cap_reached: false }] });

    it('lists the links with the address and label decrypted, null once ended; the limits are given', async () => {
      await start('true');
      const live = protector.encrypt(SHARE_ID, { email: 'kemi.doctor@example.com', label: 'Dr Kemi' });
      answers['identity.list_my_card_shares'] = () => ({ rows: [{ listed: { createdToday: 1, liveCount: 1, items: [
        { id: SHARE_ID, reference: 'K7P2-QX9M', scope: 'card', recipientCiphertext: live.toString('base64'),
          recipientKeyVersion: 'test-v1', recipientHint: 'k•••@example.com', duration: '24h', createdAt: 'c', expiresAt: 'e',
          status: 'active', endedAt: null, endedReason: null, lockedUntil: null, delivery: 'sent', openCount: 2,
          lastOpenedAt: 'l' },
        { id: '5e100000-0000-4000-8000-000000000002', reference: 'AAAA-BBBB', scope: 'card_and_records',
          recipientCiphertext: null, recipientKeyVersion: null, recipientHint: 'b•••@example.com', duration: '7d',
          createdAt: 'c', expiresAt: 'e', status: 'ended', endedAt: 'x', endedReason: 'patient_ended', lockedUntil: null,
          delivery: 'not_sent', openCount: 0, lastOpenedAt: null }] } }] });
      const answer = await patientCall('get', '');
      expect(answer.status).toBe(200);
      expect(answer.headers['cache-control']).toContain('no-store');
      expect(answer.body).toEqual({ createdToday: 1, dailyLimit: 5, liveCount: 1, liveLimit: 20, items: [
        { id: SHARE_ID, reference: 'K7P2-QX9M', scope: 'card', recipientEmail: 'kemi.doctor@example.com', label: 'Dr Kemi',
          recipientHint: 'k•••@example.com', duration: '24h', createdAt: 'c', expiresAt: 'e', status: 'active', endedAt: null,
          endedReason: null, lockedUntil: null, delivery: 'sent', openCount: 2, lastOpenedAt: 'l' },
        { id: '5e100000-0000-4000-8000-000000000002', reference: 'AAAA-BBBB', scope: 'card_and_records', recipientEmail: null,
          label: null, recipientHint: 'b•••@example.com', duration: '7d', createdAt: 'c', expiresAt: 'e', status: 'ended',
          endedAt: 'x', endedReason: 'patient_ended', lockedUntil: null, delivery: 'not_sent', openCount: 0,
          lastOpenedAt: null }] });
    });

    it('sends a link: 201, the address normalised, encrypted and keyed; E5 carries the 256-bit token and a stop token', async () => {
      await start('true');
      answers['identity.current_patient_account'] = () => ({ rows: [{ email: 'ada@example.com' }] });
      answers['identity.create_my_card_share'] = created;
      const answer = await patientCall('post', '').set('Idempotency-Key', 'card-share-key-000001').send(create);
      expect(answer.status).toBe(201);
      expect(answer.body).toMatchObject({ delivery: 'sent', replacedId: null, replayed: false, share: {
        reference: 'K7P2-QX9M', scope: 'card_and_records', recipientEmail: 'kemi.doctor@example.com', label: 'Dr Kemi',
        recipientHint: 'k•••@e•••.com', duration: '24h', status: 'active', delivery: 'sent', openCount: 0 } });
      const [values] = commandCalls('identity.create_my_card_share').map((call) => call.values);
      const shareId = values![2] as string;
      expect(values![3]).toBe(protector.recipientHmac('kemi.doctor@example.com'));
      // example.com is not a common provider, so its name is masked too.
      expect(values![4]).toBe('k•••@e•••.com');
      expect(protector.decrypt(shareId, 'test-v1', values![5] as Buffer)).toEqual({ email: 'kemi.doctor@example.com',
        label: 'Dr Kemi' });
      expect(values!.slice(8, 11)).toEqual(['card_and_records', '24h', 'card-share-v1']);
      expect(JSON.stringify(values)).not.toContain('kemi.doctor');
      const sent = notification.deliverCardShareLink.mock.calls[0]![0] as { shareId: string; recipient: string;
        token: string; reference: string; stopToken: string };
      expect(sent).toMatchObject({ shareId, recipient: 'kemi.doctor@example.com', reference: 'K7P2-QX9M' });
      expect(sent.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(values![7]).toBe(protector.tokenHmac(sent.token));
      expect(protector.stopShareId(sent.stopToken)).toBe(shareId);
      expect(commandCalls('identity.record_my_card_share_delivery')[0]?.values.slice(2, 4)).toEqual([shareId, 'accepted']);
      expect(JSON.stringify(audit.record.mock.calls)).not.toMatch(/kemi|Dr Kemi|[A-Za-z0-9_-]{43}/);
    });

    it('answers a replay 200 and sends nothing; a blocked or capped address reads not_sent and is not emailed', async () => {
      await start('true');
      answers['identity.current_patient_account'] = () => ({ rows: [{ email: 'ada@example.com' }] });
      answers['identity.create_my_card_share'] = (values) => ({ rows: [{ ...created(values).rows[0], outcome: 'replayed',
        send_email: false }] });
      answers['identity.list_my_card_shares'] = () => ({ rows: [{ listed: { createdToday: 1, liveCount: 1, items: [] } }] });
      let answer = await patientCall('post', '').set('Idempotency-Key', 'card-share-key-000001').send(create);
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ replayed: true });
      answers['identity.create_my_card_share'] = (values) => ({ rows: [{ ...created(values).rows[0], send_email: false,
        address_cap_reached: true }] });
      answer = await patientCall('post', '').set('Idempotency-Key', 'card-share-key-000002').send(create);
      expect(answer.status).toBe(201);
      expect(answer.body).toMatchObject({ delivery: 'not_sent', share: { delivery: 'not_sent' } });
      expect(notification.deliverCardShareLink).not.toHaveBeenCalled();
    });

    it('a failed send reads not_sent, the same as a blocked address', async () => {
      await start('true');
      answers['identity.current_patient_account'] = () => ({ rows: [{ email: 'ada@example.com' }] });
      answers['identity.create_my_card_share'] = created;
      notification.deliverCardShareLink.mockResolvedValue({ outcome: 'definitive_failure', safeCode: 'http_400' });
      const answer = await patientCall('post', '').set('Idempotency-Key', 'card-share-key-000003').send(create);
      expect(answer.body).toMatchObject({ delivery: 'not_sent' });
    });

    it.each([
      [{ ...create, email: 'not-an-address' }, 400, 'CARD_SHARE_EMAIL_INVALID'],
      [{ ...create, email: 'ADA@example.com' }, 400, 'CARD_SHARE_OWN_EMAIL'],
      [{ ...create, duration: '30d' }, 400, 'VALIDATION_FAILED'],
      [{ ...create, scope: 'everything' }, 400, 'VALIDATION_FAILED'],
      [{ ...create, label: 'x'.repeat(81) }, 400, 'VALIDATION_FAILED'],
      [{ ...create, label: '<a href>' }, 400, 'VALIDATION_FAILED'],
      [{ ...create, link: 'https://evil.example' }, 400, 'VALIDATION_FAILED'],
    ])('refuses %j with %i %s and writes nothing', async (body, status, code) => {
      await start('true');
      answers['identity.current_patient_account'] = () => ({ rows: [{ email: 'ada@example.com' }] });
      answers['identity.create_my_card_share'] = created;
      const answer = await patientCall('post', '').set('Idempotency-Key', 'card-share-key-000004').send(body);
      expect(answer.status).toBe(status);
      expect(answer.body.code).toBe(code);
      // The refusal never repeats what was typed.
      expect(JSON.stringify(answer.body)).not.toContain(String((body as { email: string }).email).trim());
      expect(commandCalls('identity.create_my_card_share')).toEqual([]);
    });

    it('requires an Idempotency-Key and a recent sign-in', async () => {
      await start('true');
      let answer = await patientCall('post', '').send(create);
      expect(answer.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      answers.recent = () => false;
      answers['identity.current_patient_account'] = () => ({ rows: [{ email: 'ada@example.com' }] });
      answer = await patientCall('post', '').set('Idempotency-Key', 'card-share-key-000005').send(create);
      expect(answer.status).toBe(403);
      expect(answer.body.code).toBe('PATIENT_RECENT_AUTH_REQUIRED');
    });

    it.each([
      ['P0001', 'CARD_SHARE_CREATE_LIMITED', 429, 'CARD_SHARE_CREATE_LIMITED'],
      ['P0001', 'CARD_SHARE_ADDRESS_LIMITED', 429, 'CARD_SHARE_ADDRESS_LIMITED'],
      ['55000', 'CARD_SHARE_LIVE_LIMIT', 409, 'CARD_SHARE_LIVE_LIMIT'],
      ['55000', 'IDEMPOTENCY_KEY_REUSED', 409, 'IDEMPOTENCY_KEY_REUSED'],
      ['42501', 'Patient self session is required', 403, 'PATIENT_SESSION_REQUIRED'],
    ])('maps the database refusal %s %s to %i %s', async (sqlstate, message, status, code) => {
      await start('true');
      answers['identity.current_patient_account'] = () => ({ rows: [{ email: 'ada@example.com' }] });
      answers['identity.create_my_card_share'] = () => { throw Object.assign(new Error(message), { code: sqlstate }); };
      const answer = await patientCall('post', '').set('Idempotency-Key', 'card-share-key-000006').send(create);
      expect(answer.status).toBe(status);
      expect(answer.body.code).toBe(code);
      expect(notification.deliverCardShareLink).not.toHaveBeenCalled();
    });

    it('ends a link at once (also when already ended); another patient\'s id is 404', async () => {
      await start('true');
      answers['identity.end_my_card_share'] = () => ({ rows: [{ outcome: 'ended', item: { id: SHARE_ID, reference: 'K7P2-QX9M',
        scope: 'card', recipientCiphertext: null, recipientKeyVersion: null, recipientHint: 'k•••@example.com',
        duration: '24h', createdAt: 'c', expiresAt: 'e', status: 'ended', endedAt: 'x', endedReason: 'patient_ended',
        lockedUntil: null, delivery: 'sent', openCount: 0, lastOpenedAt: null } }] });
      let answer = await patientCall('post', `/${SHARE_ID}/end`).send();
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ share: { id: SHARE_ID, status: 'ended', recipientEmail: null, label: null } });
      answers['identity.end_my_card_share'] = () => { throw Object.assign(new Error('CARD_SHARE_NOT_FOUND'), { code: 'P0002' }); };
      answer = await patientCall('post', `/${SHARE_ID}/end`).send();
      expect(answer.status).toBe(404);
      expect(answer.body.code).toBe('CARD_SHARE_NOT_FOUND');
      answer = await patientCall('post', '/not-a-uuid/end').send();
      expect(answer.status).toBe(400);
    });
  });

  describe('the person the link went to', () => {
    const issued = () => ({ rows: [{ outcome: 'issued', retry_after_seconds: null, share_id: SHARE_ID,
      code_id: 'c0de0000-0000-4000-8000-000000000001',
      recipient_ciphertext: protector.encrypt(SHARE_ID, { email: 'kemi.doctor@example.com', label: 'Dr Kemi' }),
      recipient_key_version: 'test-v1', recipient_hint: 'k•••@example.com', reference: 'K7P2-QX9M',
      code_expires_at: new Date() }] });

    it('availability answers 204 with no session read', async () => {
      await start('true');
      const answer = await publicCall('get', 'availability').set('Cookie', 'hid_access=session');
      expect(answer.status).toBe(204);
      expect(tokens.verify).not.toHaveBeenCalled();
    });

    it('"Email me a code": Origin, the link\'s shape and Turnstile card-share-code first; 202 with the hint; E6 after', async () => {
      await start('true');
      answers['identity.issue_card_share_code'] = issued;
      const answer = await publicCall('post', 'code').set('Cookie', 'hid_access=patient-session')
        .send({ token: TOKEN, turnstileToken: 'turnstile-proof' });
      expect(answer.status).toBe(202);
      expect(answer.body).toEqual({ sentTo: 'k•••@example.com', expiresInSeconds: 600, resendAfterSeconds: 60 });
      expect(turnstile.verify).toHaveBeenCalledWith(expect.objectContaining({ token: 'turnstile-proof',
        action: 'card-share-code', origin }));
      const [values] = commandCalls('identity.issue_card_share_code').map((call) => call.values);
      expect(values![0]).toBe(protector.tokenHmac(TOKEN));
      const cookies = ([] as string[]).concat(answer.headers['set-cookie'] ?? []);
      const pending = cookies.find((cookie) => cookie.startsWith('hid_card_code='))!;
      expect(pending).toMatch(/; Max-Age=600; Path=\/api\/v1\/card-share; Expires=.*; HttpOnly; Secure; SameSite=Strict$/);
      const secret = pending.split(';')[0]!.split('=')[1]!;
      expect(values![4]).toBe(createHash('sha256').update(secret).digest('hex'));
      await settle();
      const sent = notification.deliverCardShareCode.mock.calls[0]![0] as { code: string; recipient: string; codeId: string;
        reference: string; stopToken: string };
      expect(sent).toMatchObject({ recipient: 'kemi.doctor@example.com', codeId: 'c0de0000-0000-4000-8000-000000000001',
        reference: 'K7P2-QX9M' });
      expect(sent.code).toMatch(/^[0-9]{6}$/);
      expect(values![2]).toBe(protector.codeVerifier(protector.tokenHmac(TOKEN), sent.code));
      expect(commandCalls('identity.record_card_share_code_delivery')[0]?.values).toEqual([
        'c0de0000-0000-4000-8000-000000000001', 'accepted']);
      expect(tokens.verify).not.toHaveBeenCalled();
    });

    it('a malformed link answers 400 without Turnstile or the database and never repeats it', async () => {
      await start('true');
      for (const token of ['short', `${TOKEN}A`, `${TOKEN.slice(0, 42)}+`]) {
        const answer = await publicCall('post', 'code').send({ token, turnstileToken: 'turnstile-proof' });
        expect(answer.status).toBe(400);
        expect(answer.body).toMatchObject({ code: 'CARD_SHARE_LINK_INVALID',
          detail: 'This link isn\'t complete. Open it again from your email.' });
        expect(JSON.stringify(answer.body)).not.toContain(token);
      }
      expect(turnstile.verify).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    });

    it('refuses a missing or other Origin with 403, never 401', async () => {
      await start('true');
      const answer = await request(app.getHttpServer()).post('/api/v1/card-share/code').set('Origin', 'https://evil.example')
        .send({ token: TOKEN, turnstileToken: 'turnstile-proof' });
      expect(answer.status).toBe(403);
      expect(answer.body.code).toBe('ORIGIN_DENIED');
    });

    it('unknown, ended and expired links answer exactly the same 410', async () => {
      await start('true');
      answers['identity.issue_card_share_code'] = () => ({ rows: [{ outcome: 'ended' }] });
      const first = await publicCall('post', 'code').send({ token: TOKEN, turnstileToken: 'turnstile-proof' });
      const second = await publicCall('post', 'code').send({ token: 'QW5vdGhlclRva2VuMDEyMzQ1Njc4OUFCQ0RFRkdISUo',
        turnstileToken: 'turnstile-proof' });
      expect(first.status).toBe(410);
      const strip = (body: Record<string, unknown>) => ({ ...body, correlationId: undefined, instance: undefined });
      expect(strip(first.body)).toEqual(strip(second.body));
      expect(first.body).toMatchObject({ code: 'CARD_SHARE_ENDED', detail: 'This card is no longer shared.' });
      await settle();
      expect(notification.deliverCardShareCode).not.toHaveBeenCalled();
    });

    it.each([
      [{ outcome: 'locked', retry_after_seconds: 3000 }, 429, 'CARD_SHARE_LOCKED', 3000],
      [{ outcome: 'limited', retry_after_seconds: 45 }, 429, 'CARD_SHARE_CODE_LIMITED', 45],
    ])('a code refused %j answers %i %s with retryAfterSeconds', async (row, status, code, retry) => {
      await start('true');
      answers['identity.issue_card_share_code'] = () => ({ rows: [row] });
      const answer = await publicCall('post', 'code').send({ token: TOKEN, turnstileToken: 'turnstile-proof' });
      expect(answer.status).toBe(status);
      expect(answer.body).toMatchObject({ code, retryAfterSeconds: retry });
    });

    it('"Open the card": a right code opens one view and sets a session cookie for that view only', async () => {
      await start('true');
      answers['identity.verify_card_share_code'] = () => ({ rows: [{ outcome: 'opened', attempts_left: null,
        retry_after_seconds: null, card, networks_today: 1 }] });
      const answer = await publicCall('post', 'verify').set('Cookie', 'hid_card_code=pending-secret; hid_access=session')
        .send({ token: TOKEN, code: '482913' });
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ viewId: card.viewId, viewExpiresAt: card.viewExpiresAt,
        card: { fullName: 'Ada Cardlink', healthId: 'HID-E8ADAA', ninVerified: true }, sharedByFirstName: 'Ada',
        recipientHint: 'k•••@example.com', reference: 'K7P2-QX9M', scope: 'card_and_records', expiresAt: card.expiresAt });
      const [values] = commandCalls('identity.verify_card_share_code').map((call) => call.values);
      expect(values!.slice(0, 3)).toEqual([protector.tokenHmac(TOKEN), protector.codeVerifier(protector.tokenHmac(TOKEN),
        '482913'), createHash('sha256').update('pending-secret').digest('hex')]);
      const cookies = ([] as string[]).concat(answer.headers['set-cookie'] ?? []);
      const view = cookies.find((cookie) => VIEW_COOKIE.test(cookie))!;
      expect(view.split('=')[0]).toBe(`hid_cv_${String(values![3]).replace(/-/g, '')}`);
      // A session cookie: no Max-Age or Expires; the server ends the view after 30 minutes.
      expect(view).toMatch(/^hid_cv_[0-9a-f]{32}=[A-Za-z0-9_-]{43}; Path=\/api\/v1\/card-share; HttpOnly; Secure; SameSite=Strict$/);
      expect(createHash('sha256').update(view.split(';')[0]!.split('=')[1]!).digest('hex')).toBe(values![4]);
      expect(cookies.some((cookie) => cookie.startsWith('hid_card_code=;'))).toBe(true);
      expect(tokens.verify).not.toHaveBeenCalled();
    });

    it.each([
      [{ outcome: 'wrong', attempts_left: 3 }, 400, { code: 'CARD_SHARE_CODE_WRONG', attemptsLeft: 3,
        detail: 'That code isn\'t right. Check the email and try again. 3 tries left.' }],
      [{ outcome: 'code_expired' }, 410, { code: 'CARD_SHARE_CODE_EXPIRED',
        detail: 'That code has stopped working. Ask for a new one.' }],
      [{ outcome: 'locked', retry_after_seconds: 3600 }, 429, { code: 'CARD_SHARE_LOCKED', retryAfterSeconds: 3600 }],
      [{ outcome: 'ended' }, 410, { code: 'CARD_SHARE_ENDED', detail: 'This card is no longer shared.' }],
    ])('a refused code %j answers %i', async (row, status, body) => {
      await start('true');
      answers['identity.verify_card_share_code'] = () => ({ rows: [row] });
      const answer = await publicCall('post', 'verify').send({ token: TOKEN, code: '000000' });
      expect(answer.status).toBe(status);
      expect(answer.body).toMatchObject(body);
      expect(answer.headers['set-cookie'] ?? []).not.toEqual(expect.arrayContaining([expect.stringMatching(VIEW_COOKIE)]));
    });

    it('a code that is not 6 digits answers 400 and uses no try', async () => {
      await start('true');
      const answer = await publicCall('post', 'verify').send({ token: TOKEN, code: '12345' });
      expect(answer.status).toBe(400);
      expect(answer.body).toMatchObject({ code: 'CARD_SHARE_CODE_FORMAT', detail: 'Enter the 6-digit code from the email.' });
      expect(calls).toEqual([]);
    });

    it('the view and end-view routes name their view in X-Card-View and read only its cookie', async () => {
      await start('true');
      const viewId = '7e300000-0000-4000-8000-000000000001';
      const cookie = `hid_cv_${viewId.replace(/-/g, '')}=view-secret; hid_cv_7e300000000040008000000000000002=other; hid_access=s`;
      answers['identity.card_share_view'] = () => ({ rows: [{ outcome: 'live', card }] });
      let answer = await publicCall('get', 'view').set('Cookie', cookie).set('X-Card-View', viewId);
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ viewId: card.viewId, card: { fullName: 'Ada Cardlink' } });
      expect(commandCalls('identity.card_share_view')[0]?.values).toEqual([viewId,
        createHash('sha256').update('view-secret').digest('hex')]);
      answers['identity.card_share_view'] = () => ({ rows: [{ outcome: 'ended', card: null }] });
      answer = await publicCall('get', 'view').set('Cookie', cookie).set('X-Card-View', viewId);
      expect(answer.status).toBe(410);
      expect(answer.body.code).toBe('CARD_SHARE_VIEW_ENDED');
      calls.length = 0;
      answer = await publicCall('get', 'view').set('Cookie', 'hid_access=s').set('X-Card-View', viewId);
      expect(answer.status).toBe(410);
      expect(calls).toEqual([]);
      answers['identity.end_card_share_view'] = () => ({ rows: [{ closed: 'closed' }] });
      answer = await publicCall('post', 'end-view').set('Cookie', cookie).set('X-Card-View', viewId).send();
      expect(answer.status).toBe(204);
      expect(([] as string[]).concat(answer.headers['set-cookie'] ?? []).some((value) =>
        value.startsWith(`hid_cv_${viewId.replace(/-/g, '')}=;`))).toBe(true);
      answer = await publicCall('post', 'end-view').set('X-Card-View', viewId).send();
      expect(answer.status).toBe(204);
      expect(tokens.verify).not.toHaveBeenCalled();
    });

    it('"Stop these emails" answers 204 for any well-formed stop token and blocks only a genuine one', async () => {
      await start('true');
      answers['identity.stop_card_share_emails'] = () => ({ rows: [{ stopped: 'blocked' }] });
      let answer = await publicCall('post', 'stop').send({ stopToken: protector.stopToken(SHARE_ID) });
      expect(answer.status).toBe(204);
      expect(commandCalls('identity.stop_card_share_emails')[0]?.values).toEqual([SHARE_ID]);
      calls.length = 0;
      const forged = `${SHARE_ID}.${'A'.repeat(43)}`;
      answer = await publicCall('post', 'stop').send({ stopToken: forged });
      expect(answer.status).toBe(204);
      expect(calls).toEqual([]);
      answer = await publicCall('post', 'stop').send({ stopToken: 'garbage' });
      expect(answer.status).toBe(400);
      expect(answer.body.code).toBe('CARD_SHARE_LINK_INVALID');
    });

    it('no public route answers 401, and no audit row or log holds the token, the code or the address', async () => {
      await start('true');
      answers['identity.issue_card_share_code'] = issued;
      answers['identity.verify_card_share_code'] = () => ({ rows: [{ outcome: 'wrong', attempts_left: 4 }] });
      tokens.verify.mockRejectedValue(new Error('should never be called'));
      const statuses = [
        (await publicCall('get', 'availability').set('Cookie', 'hid_access=expired')).status,
        (await publicCall('post', 'code').set('Cookie', 'hid_access=expired').send({ token: TOKEN, turnstileToken: 't' })).status,
        (await publicCall('post', 'verify').set('Cookie', 'hid_access=expired').send({ token: TOKEN, code: '482913' })).status,
        (await publicCall('get', 'view').set('Cookie', 'hid_access=expired')).status,
        (await publicCall('post', 'end-view').set('Cookie', 'hid_access=expired').send()).status,
      ];
      await settle();
      expect(statuses).not.toContain(401);
      const recorded = JSON.stringify(audit.record.mock.calls);
      expect(recorded).not.toContain(TOKEN);
      expect(recorded).not.toContain('482913');
      expect(recorded).not.toContain('kemi');
    });
  });
});
