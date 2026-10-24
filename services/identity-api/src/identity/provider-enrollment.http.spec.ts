jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthService } from '../auth/auth.service';
import { TurnstileService } from '../auth/turnstile.service';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import { resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { IntegrationRuntimeService } from '../integrations/integration-runtime.service';
import { OrganizationProfileCompletionService } from './organization-profile-completion.service';
import { ProviderEnrollmentController } from './provider-enrollment.controller';
import { ProviderEnrollmentService } from './provider-enrollment.service';
import { QoreIdVerificationAdapter } from './qoreid-verification.adapter';

/**
 * The provider enrollment routes over HTTP, with the real gate, the
 * production ValidationPipe options (main.ts) and the problem filter: the
 * order of the checks (CRITIC C6: request validation first) and the statuses
 * and codes the browser receives.
 */
const origin = 'https://app.healthidentitydirectory.com';
const base = '/api/v1/identity/provider-enrollments';
const startBody = {
  productCode: 'pharmacy', organizationType: 'pharmacy', cacRegistrationNumber: 'rc 1234567',
  administratorName: 'Synthetic Provider Admin', administratorEmail: 'provider@example.invalid',
  turnstileAction: 'provider-enrollment', turnstileToken: 'opaque-proof',
};
const verifyBody = { challengeId: '8ce75fc3-0bda-4300-b198-f5688df65d6c', code: '123456' };
const controls = (row: Record<string, boolean>) => ({ rows: [row] });
const open = { self_service: true, provider_portal: true, maintenance: false };

describe('provider enrollment over HTTP', () => {
  const originalEnvironment = { ...process.env };
  let app: INestApplication;
  const database = { query: jest.fn(), withSystemTransaction: jest.fn() };
  const integrations = { assertAvailable: jest.fn(), consumeSelfServiceCacQuota: jest.fn() };
  const completion = { verify: jest.fn(), activate: jest.fn(), start: jest.fn(), publicApplicationDigest: jest.fn(),
    publicApplicationNetworkDigest: jest.fn(), selfServiceProfile: jest.fn() };
  const turnstile = { verify: jest.fn() };
  const auth = { login: jest.fn() };

  beforeEach(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: origin, AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      AUTH_COOKIE_SECURE: 'true', QOREID_ENABLED: 'true',
      QOREID_CLIENT_ID: 'synthetic-client', QOREID_CLIENT_SECRET: 'synthetic-secret',
    });
    delete process.env.PROVIDER_SELF_SERVICE_QOREID_DAILY_CAP;
    resetEnvironmentForTests();
    jest.resetAllMocks();
    database.query.mockResolvedValue(controls({ ...open, self_service: false }));
    integrations.assertAvailable.mockResolvedValue(undefined);
    turnstile.verify.mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [ProviderEnrollmentController],
      providers: [
        ProviderEnrollmentService,
        { provide: DatabaseService, useValue: database },
        { provide: IntegrationRuntimeService, useValue: integrations },
        { provide: QoreIdVerificationAdapter, useValue: { verifyCac: jest.fn() } },
        { provide: OrganizationProfileCompletionService, useValue: completion },
        { provide: TurnstileService, useValue: turnstile },
        { provide: AuthService, useValue: auth },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({
      whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true, transform: true,
      transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
      exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
        errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))),
    }));
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    resetEnvironmentForTests();
  });

  it('validates the request before Origin, the signed-in check and the gate (C6)', async () => {
    for (const [path, body] of [['', { ...startBody, productCode: 'dental' }], ['', { ...startBody, extra: 'x' }],
      ['/verify', { ...verifyBody, code: '12345' }], ['/activate', { password: 'short' }]] as const) {
      const answer = await request(app.getHttpServer()).post(`${base}${path}`)
        .set('Origin', 'https://attacker.example').set('Cookie', 'hid_access_csrf=x').send(body);
      expect([answer.status, answer.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    }
    expect(turnstile.verify).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it('answers 423 PROVIDER_ENROLLMENT_UNAVAILABLE on every route while the control is off', async () => {
    const start = await request(app.getHttpServer()).post(base).set('Origin', origin).send(startBody);
    const verify = await request(app.getHttpServer()).post(`${base}/verify`).set('Origin', origin).send(verifyBody);
    const activate = await request(app.getHttpServer()).post(`${base}/activate`).set('Origin', origin)
      .set('Cookie', `hid_provider_enrollment=${'A'.repeat(43)}`).send({ password: 'x'.repeat(12) });
    const profile = await request(app.getHttpServer()).get(`${base}/profile`)
      .set('Cookie', `hid_provider_enrollment=${'A'.repeat(43)}`);
    for (const answer of [start, verify, activate, profile]) {
      expect(answer.status).toBe(423);
      expect(answer.body).toMatchObject({ status: 423, code: 'PROVIDER_ENROLLMENT_UNAVAILABLE',
        detail: 'Facility self sign-up is not open' });
      expect(answer.headers['set-cookie']).toBeUndefined();
    }
    // Start checks the gate after Turnstile; nothing is written at any route.
    expect(turnstile.verify).toHaveBeenCalledTimes(1);
    expect(database.withSystemTransaction).not.toHaveBeenCalled();
    expect(completion.verify).not.toHaveBeenCalled();
    expect(completion.activate).not.toHaveBeenCalled();
    expect(completion.selfServiceProfile).not.toHaveBeenCalled();
    expect(auth.login).not.toHaveBeenCalled();
  });

  it('serves the confirmation read on a GET with no Origin, from the enrollment cookie (R13)', async () => {
    database.query.mockResolvedValue(controls(open));
    const shown = { organizationName: 'Confirm Hospital Ltd', registrationNumber: 'RC1234567', productCode: 'pharmacy',
      organizationType: 'pharmacy', administratorName: 'Dr Ada Obi', administratorEmail: 'provider@example.invalid' };
    completion.selfServiceProfile.mockResolvedValue(shown);
    const answer = await request(app.getHttpServer()).get(`${base}/profile`)
      .set('Cookie', `hid_provider_enrollment=${'A'.repeat(43)}`);
    expect([answer.status, answer.body]).toEqual([200, shown]);
    expect(completion.selfServiceProfile.mock.calls.map(([cookie]) => cookie)).toEqual(['A'.repeat(43)]);
    // A signed-in browser is refused as on the other routes, before the session is read.
    completion.selfServiceProfile.mockClear();
    const signedIn = await request(app.getHttpServer()).get(`${base}/profile`)
      .set('Cookie', `hid_access_csrf=x; hid_provider_enrollment=${'A'.repeat(43)}`);
    expect([signedIn.status, signedIn.body.code]).toEqual([409, 'PROVIDER_ENROLLMENT_REQUIRES_SIGN_OUT']);
    expect(completion.selfServiceProfile).not.toHaveBeenCalled();
    // The read writes nothing and the route sets no cookie.
    expect(answer.headers['set-cookie']).toBeUndefined();
    expect(database.withSystemTransaction).not.toHaveBeenCalled();
  });

  it('answers 423 before the migration (unknown control key), not 400 or 5xx', async () => {
    database.query.mockRejectedValue(Object.assign(new Error('PLATFORM_CONTROL_INVALID'), { code: '22023' }));
    const answer = await request(app.getHttpServer()).post(`${base}/verify`).set('Origin', origin).send(verifyBody);
    expect([answer.status, answer.body.code]).toEqual([423, 'PROVIDER_ENROLLMENT_UNAVAILABLE']);
  });

  it('answers a missing Origin 403 ORIGIN_DENIED and a signed-in browser 409', async () => {
    const noOrigin = await request(app.getHttpServer()).post(base).send(startBody);
    expect([noOrigin.status, noOrigin.body.code]).toEqual([403, 'ORIGIN_DENIED']);
    const signedIn = await request(app.getHttpServer()).post(base).set('Origin', origin)
      .set('Cookie', 'hid_access_csrf=x').send(startBody);
    expect([signedIn.status, signedIn.body.code]).toEqual([409, 'PROVIDER_ENROLLMENT_REQUIRES_SIGN_OUT']);
    expect(turnstile.verify).not.toHaveBeenCalled();
  });

  it('answers availability 200: closed when switched off, unavailable on a fault, open only when everything is', async () => {
    // R10: a fault is not "closed", so the page says "try again shortly", not "not open".
    database.query.mockRejectedValueOnce(new Error('database down'));
    const down = await request(app.getHttpServer()).get(`${base}/availability`);
    expect([down.status, down.body]).toEqual([200, { open: false, reason: 'unavailable' }]);
    const off = await request(app.getHttpServer()).get(`${base}/availability`);
    expect([off.status, off.body]).toEqual([200, { open: false, reason: 'closed' }]);
    database.query.mockResolvedValue(controls(open));
    integrations.assertAvailable.mockRejectedValueOnce(new DomainProblem(503, 'INTEGRATION_PAUSED', 'paused'));
    const paused = await request(app.getHttpServer()).get(`${base}/availability`);
    expect([paused.status, paused.body]).toEqual([200, { open: false, reason: 'closed' }]);
    const openNow = await request(app.getHttpServer()).get(`${base}/availability`);
    expect([openNow.status, openNow.body]).toEqual([200, { open: true }]);
  });

  it('answers 423 when the control is switched off between the gate and the submit command', async () => {
    database.query.mockResolvedValue(controls(open));
    completion.publicApplicationNetworkDigest.mockReturnValue('b'.repeat(64));
    // The quota charge commits; the submit command's own
    // platform.require_control_enabled then refuses.
    database.withSystemTransaction.mockResolvedValueOnce(undefined).mockRejectedValueOnce(
      Object.assign(new Error('PLATFORM_CONTROL_DISABLED:provider_self_service_enabled'), { code: '55000' }));
    const answer = await request(app.getHttpServer()).post(base).set('Origin', origin).send(startBody);
    expect([answer.status, answer.body.code]).toEqual([423, 'PROVIDER_ENROLLMENT_UNAVAILABLE']);
    expect(database.withSystemTransaction).toHaveBeenCalledTimes(2);
    expect(turnstile.verify).toHaveBeenCalledWith(expect.objectContaining({ action: 'provider-enrollment', origin }));
  });

  it('activates with the three session cookies, x-csrf-token and the actor', async () => {
    database.query.mockResolvedValue(controls(open));
    completion.activate.mockResolvedValue({ email: 'provider@example.invalid', organizationId: 'organization-1',
      facilityId: 'facility-1', accountId: 'account-1' });
    auth.login.mockResolvedValue({ actor: { subject: 'org-onboarding:account-1', kind: 'staff' },
      accessToken: 'access-token', refreshToken: 'refresh-token', csrfToken: 'csrf-token',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'), refreshExpiresAt: new Date('2030-01-02T00:00:00.000Z') });
    const answer = await request(app.getHttpServer()).post(`${base}/activate`).set('Origin', origin)
      .set('Cookie', `hid_enrollment=patient-flow; hid_provider_enrollment=${'A'.repeat(43)}`)
      .send({ password: 'a-strong-test-password' });
    expect(answer.status).toBe(200);
    expect(answer.headers['x-csrf-token']).toBe('csrf-token');
    expect(answer.body).toEqual({ activated: true, organizationId: 'organization-1', facilityId: 'facility-1',
      accountId: 'account-1', actor: { subject: 'org-onboarding:account-1', kind: 'staff' },
      expiresAt: '2030-01-01T00:00:00.000Z' });
    const cookies = answer.headers['set-cookie'] as unknown as string[];
    const named = (name: string) => cookies.find((cookie) => cookie.startsWith(`${name}=`));
    expect(named('hid_access')).toMatch(/^hid_access=access-token; Path=\/; Expires=.*; HttpOnly; Secure; SameSite=Strict$/);
    expect(named('hid_access_refresh')).toMatch(/Path=\/api\/v1\/auth; .*HttpOnly; Secure; SameSite=Strict$/);
    expect(named('hid_access_csrf')).toMatch(/^hid_access_csrf=csrf-token; Path=\/; Expires=.*; Secure; SameSite=Strict$/);
    expect(named('hid_provider_enrollment')).toMatch(/^hid_provider_enrollment=; Path=\/api\/v1\/identity\/provider-enrollments; Expires=Thu, 01 Jan 1970/);
    expect(named('hid_enrollment')).toBeUndefined();
    expect(cookies).toHaveLength(4);
    expect(cookies.some((cookie) => /Domain=/i.test(cookie))).toBe(false);
  });
});
