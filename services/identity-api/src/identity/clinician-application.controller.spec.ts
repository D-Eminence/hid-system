jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request as ExpressRequest, Response as ExpressResponse } from 'express';
import request from 'supertest';
import { TurnstileService } from '../auth/turnstile.service';
import { DomainProblem, ProblemDetailsFilter, PublicDetailProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { preventResponseCaching } from '../common/response-security.middleware';
import { resetEnvironmentForTests } from '../config/environment';
import { ClinicianApplicationController } from './clinician-application.controller';
import { ClinicianApplicationService } from './clinician-application.service';

/**
 * The clinician application routes (ADR-064) over HTTP, through the real
 * ValidationPipe and problem filter, with the service and Turnstile replaced:
 * the refusal order, the capability cookie, the headers and the answers that
 * must not differ.
 */
const ORIGIN = 'https://www.healthidentitydirectory.com';
const BASE = '/api/v1/identity/clinician-applications';
const TOKEN = 'C'.repeat(43);
const NEXT = 'N'.repeat(43);
const email = 'synthetic.clinician@example.invalid';
const challengeId = '3f0c4a8e-2b1d-4c6e-9a7f-5d8b1e2c3a40';
const facilityId = '0d9f8e7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f';
const applicationId = '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d';
const details = { profession: 'doctor', regulator: 'MDCN', licenceNumber: 'MDCN/12345', licenceValidUntil: '2027-06-30',
  facilityId, declarations: { accurate: true, verificationConsent: true } };
const signup = { ...details, email, fullName: 'Ada Synthetic', password: 'a-long-synthetic-password' };
const codeAnswer = { accepted: true, challengeId, expiresInSeconds: 600, resendAfterSeconds: 60 };

let app: INestApplication;
const SERVICE_METHODS = ['availability', 'startSignup', 'startStatus', 'verifySignupCode', 'verifyStatusCode',
  'searchFacilities', 'submit', 'sendAuthenticatorCode', 'startAuthenticator', 'activateAuthenticator',
  'verifyAuthenticator', 'reopenAuthenticator', 'current', 'withdraw', 'apply', 'endSession'] as const;
let service: Record<typeof SERVICE_METHODS[number], jest.Mock>;
let turnstile: { verify: jest.Mock };
const originalEnvironment = { ...process.env };

beforeEach(async () => {
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
    CORS_ORIGINS: ORIGIN, AUTH_MODE: 'local', AUTH_COOKIE_NAME: 'hid_access', AUTH_COOKIE_SECURE: 'true',
    AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
    AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters' });
  resetEnvironmentForTests();
  service = {
    availability: jest.fn().mockResolvedValue({ open: true }),
    startSignup: jest.fn().mockResolvedValue(codeAnswer),
    startStatus: jest.fn().mockResolvedValue(codeAnswer),
    verifySignupCode: jest.fn().mockResolvedValue({ answer: { verified: true, expiresAt: '2026-10-15T11:00:00.000Z' },
      token: TOKEN }),
    verifyStatusCode: jest.fn().mockResolvedValue({ answer: { next: 'authenticator_verify',
      expiresAt: '2026-10-15T10:30:00.000Z' }, token: NEXT }),
    searchFacilities: jest.fn().mockResolvedValue({ facilities: [] }),
    submit: jest.fn().mockResolvedValue({ answer: { applicationId, state: 'awaiting_authenticator' }, token: NEXT }),
    sendAuthenticatorCode: jest.fn().mockResolvedValue({ accepted: true, channel: 'email', expiresAt: 'x' }),
    startAuthenticator: jest.fn().mockResolvedValue({ secret: 'S' }),
    activateAuthenticator: jest.fn().mockResolvedValue({ recoveryCodes: ['r'], stage: 'ready', applications: [] }),
    verifyAuthenticator: jest.fn().mockResolvedValue({ stage: 'ready', applications: [] }),
    reopenAuthenticator: jest.fn().mockResolvedValue({ purpose: 'verify', expiresAt: 'x' }),
    current: jest.fn().mockResolvedValue({ stage: 'ready', applications: [] }),
    withdraw: jest.fn().mockResolvedValue({ applicationId, state: 'withdrawn' }),
    apply: jest.fn().mockResolvedValue({ applicationId, state: 'submitted', replayed: false }),
    endSession: jest.fn().mockResolvedValue(undefined),
  };
  turnstile = { verify: jest.fn().mockResolvedValue(undefined) };
  const module = await Test.createTestingModule({
    controllers: [ClinicianApplicationController],
    providers: [
      { provide: ClinicianApplicationService, useValue: service },
      { provide: TurnstileService, useValue: turnstile },
    ],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.use(cookieParser());
  app.use(preventResponseCaching);
  app.use((incoming: ExpressRequest, _response: ExpressResponse, next: NextFunction) => {
    (incoming as unknown as HidRequest).correlationId = '00000000-0000-4000-8000-0000000000c9';
    next();
  });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
    transform: true, transformOptions: { enableImplicitConversion: false },
    exceptionFactory: () => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.') }));
  app.useGlobalFilters(new ProblemDetailsFilter());
  await app.init();
});

afterEach(async () => {
  await app.close();
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
  resetEnvironmentForTests();
});

const post = (path: string, body: object = {}, headers: Record<string, string> = {}) => {
  let call = request(app.getHttpServer()).post(`${BASE}${path}`).set('Origin', ORIGIN);
  for (const [name, value] of Object.entries(headers)) call = call.set(name, value);
  return call.send(body);
};
const setCookies = (response: request.Response): string[] => {
  const header = response.headers['set-cookie'] as unknown;
  return Array.isArray(header) ? header as string[] : typeof header === 'string' ? [header] : [];
};
const untouched = () => { for (const mock of Object.values(service)) expect(mock).not.toHaveBeenCalled(); };

describe('refusal order on the intake routes', () => {
  const start = { email, turnstileAction: 'clinician-application', turnstileToken: 'proof' };

  it('validates the body first, then the Origin, then the signed-out browser, then Turnstile', async () => {
    const invalid = await request(app.getHttpServer()).post(`${BASE}/email-code`).set('Origin', 'https://evil.example')
      .set('Cookie', 'hid_access=session').send({ email: 'not-an-email', turnstileAction: 'clinician-application' });
    expect([invalid.status, invalid.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    const origin = await request(app.getHttpServer()).post(`${BASE}/email-code`).set('Origin', 'https://evil.example')
      .set('Cookie', 'hid_access=session').send(start);
    expect([origin.status, origin.body.code]).toEqual([403, 'ORIGIN_DENIED']);
    // A signed-in browser whose access cookie expired still sends the CSRF
    // cookie here (path '/'); the refresh cookie (path '/api/v1/auth') never.
    for (const signedIn of [{ Cookie: 'hid_access=session' }, { Cookie: 'hid_access_refresh=refresh' },
      { Cookie: 'hid_access_csrf=csrf' }, { Authorization: 'Bearer token' }] as Record<string, string>[]) {
      const refused = await post('/email-code', start, signedIn);
      expect([refused.status, refused.body.code]).toEqual([409, 'CLINICIAN_APPLICATION_REQUIRES_SIGN_OUT']);
    }
    expect(turnstile.verify).not.toHaveBeenCalled();
    turnstile.verify.mockRejectedValueOnce(new DomainProblem(403, 'TURNSTILE_REJECTED', 'The security check failed'));
    const rejected = await post('/email-code', start);
    expect([rejected.status, rejected.body.code]).toEqual([403, 'TURNSTILE_REJECTED']);
    untouched();
    const accepted = await post('/email-code', start);
    expect(accepted.status).toBe(202);
    expect(turnstile.verify).toHaveBeenLastCalledWith({ token: 'proof', action: 'clinician-application',
      origin: ORIGIN, remoteIp: expect.any(String) });
    expect(service.startSignup).toHaveBeenCalledWith(email, expect.objectContaining({
      correlationId: '00000000-0000-4000-8000-0000000000c9' }));
  });

  it('refuses a signed-in browser on every intake route, before the service', async () => {
    const cookie = { Cookie: `hid_access=session; hid_clinician_application=${TOKEN}` };
    for (const [path, body, headers] of [
      ['/email-code/verify', { challengeId, email, code: '123456' }, {}],
      ['', signup, { 'Idempotency-Key': 'clinician-submit-0000000001' }],
    ] as const) {
      const response = await post(path, body, { ...cookie, ...headers });
      expect([response.status, response.body.code]).toEqual([409, 'CLINICIAN_APPLICATION_REQUIRES_SIGN_OUT']);
    }
    untouched();
  });

  it('does not hold the status and authenticator routes to a signed-out browser', async () => {
    const cookie = { Cookie: `hid_access=session; hid_clinician_application=${TOKEN}` };
    expect((await post('/status/email-code', { email, turnstileAction: 'clinician-application-status' }, cookie)).status)
      .toBe(202);
    expect((await post('/status/email-code/verify', { challengeId, email, code: '123456' }, cookie)).status).toBe(200);
    expect((await post('/authenticator/verify', { code: '123456' }, cookie)).status).toBe(200);
    expect((await post('/authenticator/challenge', {}, cookie)).status).toBe(200);
    const current = await request(app.getHttpServer()).get(`${BASE}/current`).set('Cookie', cookie.Cookie);
    expect(current.status).toBe(200);
    // A search tells the service the browser is signed in; the service refuses a draft for it.
    expect((await post('/facility-search', { query: 'Synthetic' }, cookie)).status).toBe(200);
    expect(service.searchFacilities).toHaveBeenCalledWith(TOKEN, 'Synthetic', true, expect.anything());
  });

  it('requires Idempotency-Key on submit and apply, and If-Match on withdraw', async () => {
    const cookie = { Cookie: `hid_clinician_application=${TOKEN}` };
    const submit = await post('', signup, cookie);
    expect([submit.status, submit.body.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
    const apply = await post('/current/applications', details, cookie);
    expect([apply.status, apply.body.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
    const withdraw = await post(`/${applicationId}/withdraw`, {}, cookie);
    expect([withdraw.status, withdraw.body.code]).toEqual([428, 'IF_MATCH_REQUIRED']);
    untouched();
    const withdrawn = await post(`/${applicationId}/withdraw`, {}, { ...cookie, 'If-Match': '"3"' });
    expect(withdrawn.status).toBe(200);
    expect(service.withdraw).toHaveBeenCalledWith(TOKEN, applicationId, 3, expect.anything());
    const badId = await post('/not-a-uuid/withdraw', {}, { ...cookie, 'If-Match': '"3"' });
    expect(badId.status).toBe(400);
  });

  it('refuses a regulator field it does not know, and a licence it cannot normalize, as VALIDATION_FAILED', async () => {
    const headers = { Cookie: `hid_clinician_application=${TOKEN}`, 'Idempotency-Key': 'clinician-submit-0000000002' };
    for (const change of [{ regulator: 'OTHER' }, { profession: 'clinician' }, { licenceNumber: '-12345' },
      { licenceValidUntil: '2027-02-30' }, { declarations: { accurate: true, verificationConsent: false } },
      { declarations: { accurate: true } }, { fullName: 'A' }, { email: 'nobody' }]) {
      const response = await post('', { ...signup, ...change }, headers);
      expect([response.status, response.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    }
    untouched();
    const normalized = await post('', { ...signup, licenceNumber: '  mdcn   12345 ', email: ` ${email.toUpperCase()} ` },
      headers);
    expect(normalized.status).toBe(201);
    expect(service.submit).toHaveBeenCalledWith(TOKEN, 'clinician-submit-0000000002',
      expect.objectContaining({ licenceNumber: 'MDCN 12345', email }), expect.anything());
  });
});

describe('the application capability cookie', () => {
  function capabilityCookie(response: request.Response): string {
    const cookies = setCookies(response);
    expect(cookies).toHaveLength(1);
    return cookies[0]!;
  }

  it('sets a draft for 60 minutes and an account capability for 30, HttpOnly, Secure, Strict, host-only, scoped', async () => {
    const draft = capabilityCookie(await post('/email-code/verify', { challengeId, email, code: '123456' }));
    expect(draft).toMatch(new RegExp(`^hid_clinician_application=${TOKEN}; `));
    for (const [response, maxAge] of [[draft, 3600],
      [capabilityCookie(await post('', signup, { Cookie: `hid_clinician_application=${TOKEN}`,
        'Idempotency-Key': 'clinician-submit-0000000003' })), 1800],
      [capabilityCookie(await post('/status/email-code/verify', { challengeId, email, code: '123456' })), 1800],
    ] as const) {
      const attributes = response.split('; ').slice(1).map((part) => part.split('=')[0]!.toLowerCase());
      expect(response).toContain(`Max-Age=${maxAge}`);
      expect(response).toContain('Path=/api/v1/identity/clinician-applications');
      expect(response).toContain('HttpOnly');
      expect(response).toContain('Secure');
      expect(response).toContain('SameSite=Strict');
      expect(attributes).not.toContain('domain');
    }
  });

  it('never sets a session cookie and never returns a token in a body or header', async () => {
    const responses = [
      await post('/email-code/verify', { challengeId, email, code: '123456' }),
      await post('', signup, { Cookie: `hid_clinician_application=${TOKEN}`, 'Idempotency-Key': 'clinician-submit-04xx' }),
      await post('/status/email-code/verify', { challengeId, email, code: '123456' }),
      await post('/authenticator/activate', { code: '123456' }, { Cookie: `hid_clinician_application=${TOKEN}` }),
      await post('/authenticator/verify', { code: '123456' }, { Cookie: `hid_clinician_application=${TOKEN}` }),
    ];
    for (const response of responses) {
      expect(response.status).toBeLessThan(300);
      for (const cookie of setCookies(response)) expect(cookie).toMatch(/^hid_clinician_application=/);
      expect(JSON.stringify(response.body)).not.toContain(TOKEN);
      expect(JSON.stringify(response.body)).not.toContain(NEXT);
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });

  it('reads the capability only when it is sent once', async () => {
    await request(app.getHttpServer()).get(`${BASE}/current`)
      .set('Cookie', `hid_clinician_application=${TOKEN}; hid_clinician_application=${NEXT}`);
    expect(service.current).toHaveBeenCalledWith(undefined, expect.anything());
  });

  it('ends the capability and clears the cookie with 204, with or without one', async () => {
    for (const cookie of [`hid_clinician_application=${TOKEN}`, '']) {
      const response = await post('/session/end', {}, cookie ? { Cookie: cookie } : {});
      expect(response.status).toBe(204);
      const cleared = setCookies(response);
      expect(cleared).toHaveLength(1);
      expect(cleared[0]).toMatch(/^hid_clinician_application=; Path=\/api\/v1\/identity\/clinician-applications; Expires=Thu, 01 Jan 1970/);
    }
    expect(service.endSession.mock.calls.map(([token]) => token)).toEqual([TOKEN, undefined]);
  });
});

describe('answers', () => {
  it('keeps the CLINICIAN_SIGNUP_CLOSED sentence through the filter while other 5xx details stay masked', async () => {
    const detail = 'Clinician sign-up is not open yet. If you already have a Health ID provider account, sign in.';
    service.startSignup.mockRejectedValueOnce(new PublicDetailProblem(503, 'CLINICIAN_SIGNUP_CLOSED', detail));
    const closed = await post('/email-code', { email, turnstileAction: 'clinician-application' });
    expect([closed.status, closed.body.code, closed.body.detail]).toEqual([503, 'CLINICIAN_SIGNUP_CLOSED', detail]);
    service.startSignup.mockRejectedValueOnce(new DomainProblem(503, 'CLINICIAN_APPLICATION_UNAVAILABLE',
      'internal detail that must not leak'));
    const masked = await post('/email-code', { email, turnstileAction: 'clinician-application' });
    expect(masked.body.code).toBe('CLINICIAN_APPLICATION_UNAVAILABLE');
    expect(masked.body.detail).not.toContain('internal detail');
  });

  it('answers both email-code starts identically, whatever the address', async () => {
    const first = await post('/email-code', { email, turnstileAction: 'clinician-application' });
    const second = await post('/email-code', { email: 'other@example.invalid', turnstileAction: 'clinician-application' });
    const status = await post('/status/email-code', { email, turnstileAction: 'clinician-application-status' });
    for (const response of [first, second, status]) {
      expect(response.status).toBe(202);
      expect(response.body).toEqual(codeAnswer);
      expect(setCookies(response)).toEqual([]);
    }
    const names = (response: request.Response) => Object.keys(response.headers)
      .filter((name) => !['date', 'etag', 'content-length'].includes(name)).sort();
    expect(names(second)).toEqual(names(first));
    expect(names(status)).toEqual(names(first));
  });

  it('answers availability to anyone, briefly cacheable, without reading the request', async () => {
    const response = await request(app.getHttpServer()).get(`${BASE}/availability`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ open: true });
    expect(response.headers['cache-control']).toBe('public, max-age=30');
    for (const name of ['pragma', 'expires', 'surrogate-control']) expect(response.headers[name]).toBeUndefined();
    service.availability.mockRejectedValueOnce(new DomainProblem(503, 'PLATFORM_CONTROL_UNAVAILABLE', 'x'));
    const fault = await request(app.getHttpServer()).get(`${BASE}/availability`);
    expect([fault.status, fault.body.code]).toEqual([503, 'PLATFORM_CONTROL_UNAVAILABLE']);
    expect(fault.headers['cache-control']).toBe('private, no-store');
  });

  it('passes exactly one authenticator proof to the service', async () => {
    const cookie = { Cookie: `hid_clinician_application=${TOKEN}` };
    await post('/authenticator/verify', { recoveryCode: 'abcd-efgh-jk' }, cookie);
    expect(service.verifyAuthenticator).toHaveBeenLastCalledWith(TOKEN, { recoveryCode: 'abcd-efgh-jk' }, expect.anything());
    await post('/authenticator/verify', { code: '654321' }, cookie);
    expect(service.verifyAuthenticator).toHaveBeenLastCalledWith(TOKEN, { code: '654321' }, expect.anything());
  });
});
