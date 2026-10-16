jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request as ExpressRequest, Response as ExpressResponse } from 'express';
import request from 'supertest';
import { AuditService } from '../audit/audit.service';
import { PublicDemoRequestsController } from '../commercial/demo-requests.controller';
import { DemoRequestsService } from '../commercial/demo-requests.service';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { PublicOrganizationApplicationsController,
  PublicOrganizationProfileCompletionController } from '../identity/organization-applications.controller';
import { ClinicianApplicationController } from '../identity/clinician-application.controller';
import { ClinicianApplicationService } from '../identity/clinician-application.service';
import { OrganizationApplicationsService } from '../identity/organization-applications.service';
import { OrganizationProfileCompletionService } from '../identity/organization-profile-completion.service';
import { PatientEnrollmentController } from '../identity/patient-enrollment.controller';
import { PatientEnrollmentService } from '../identity/patient-enrollment.service';
import { ProviderEnrollmentController } from '../identity/provider-enrollment.controller';
import { ProviderEnrollmentService } from '../identity/provider-enrollment.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthSessionAuditService } from './auth-session-audit.service';
import { GoogleAuthenticationService } from './google-authentication.service';
import { MfaService } from './mfa/mfa.service';
import { OtpController } from './otp.controller';
import { OtpService } from './otp.service';
import { PlatformAuthController } from './platform-auth.controller';
import { TokenService } from './token.service';
import { TurnstileService } from './turnstile.service';
import { WorkloadAuthService } from './workload-auth.service';

// TS-12: every route that requires a Turnstile check, through the real
// ValidationPipe, problem filter and TurnstileService, against a Siteverify
// stand-in that behaves as Cloudflare documents: a token is good once, a
// second verification of it under another idempotency key answers
// timeout-or-duplicate, and a retry under the same key repeats the first
// answer. Each refusal must stop the request before the service behind the
// route runs.

const SITE = 'www.healthidentitydirectory.com';
const ORIGIN = `https://${SITE}`;
/** The product host each workforce sign-in action is allowed on in production. */
const WORKFORCE_HOSTS = { 'staff-login': SITE, 'ehr-login': 'ehr.healthidentitydirectory.com',
  'lab-login': 'lab.healthidentitydirectory.com', 'pharmacy-login': 'pharmacy.healthidentitydirectory.com',
  'ocr-login': 'migrate.healthidentitydirectory.com', 'outreach-login': 'outreach.healthidentitydirectory.com' } as const;
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** The first service call behind each route; it answers 409 DOWNSTREAM_REACHED. */
const reached = () => jest.fn(async (..._args: unknown[]): Promise<never> => {
  throw new DomainProblem(409, 'DOWNSTREAM_REACHED', 'The route passed its Turnstile check');
});
const downstream = {
  staffLogin: reached(), patientLogin: reached(), googleLogin: reached(), googleExchange: reached(), googleLink: reached(),
  adminLogin: reached(), otpStart: reached(), demoSubmit: reached(), applicationSubmit: reached(), completionStart: reached(),
  patientEnrollmentStart: reached(), providerEnrollmentStart: reached(),
  clinicianSignupStart: reached(), clinicianStatusStart: reached(),
};

const password = 'Synthetic-Password-2026';
const email = 'synthetic.user@example.invalid';
const cac = { productCode: 'ehr', cacRegistrationNumber: 'RC1234567', administratorEmail: email };

/**
 * Each gated route with a body that is valid apart from its Turnstile token.
 * `passes` is the answer once the check passes: the service behind it, or,
 * for the Google routes, the missing sign-in nonce checked right after it.
 */
const ROUTES = [
  { path: '/auth/login', action: 'staff-login', body: { email, password }, passes: 'DOWNSTREAM_REACHED', service: 'staffLogin' },
  { path: '/auth/patient/login', action: 'patient-login', body: { email, password }, passes: 'DOWNSTREAM_REACHED', service: 'patientLogin' },
  { path: '/auth/oidc/exchange', action: 'patient-login', body: { idToken: 'g'.repeat(64), intent: 'sign_in' },
    passes: 'GOOGLE_SIGN_IN_DENIED', service: 'googleLogin' },
  { path: '/auth/google/link', action: 'patient-login', body: { idToken: 'g'.repeat(64), principal: email, password },
    passes: 'GOOGLE_SIGN_IN_DENIED', service: 'googleLink' },
  { path: '/auth/admin/login', action: 'admin-login', body: { email, password }, passes: 'DOWNSTREAM_REACHED', service: 'adminLogin' },
  { path: '/auth/otp/start', action: 'patient-reset-start', body: { identifier: email, purpose: 'PASSWORD_RESET' },
    passes: 'DOWNSTREAM_REACHED', service: 'otpStart' },
  { path: '/commercial/demo-requests', action: 'book-demo', body: { contactName: 'Ada Example', contactEmail: email, productCode: 'ehr' },
    passes: 'DOWNSTREAM_REACHED', service: 'demoSubmit' },
  { path: '/identity/organization-applications', action: 'organization-application',
    body: { ...cac, organizationType: 'clinic', administratorName: 'Ada Example' }, passes: 'DOWNSTREAM_REACHED', service: 'applicationSubmit' },
  { path: '/identity/organization-applications/completion/start', action: 'organization-completion', body: cac,
    passes: 'DOWNSTREAM_REACHED', service: 'completionStart' },
  { path: '/identity/patient-enrollments', action: 'patient-enrollment', body: { nin: '12345678901' },
    passes: 'DOWNSTREAM_REACHED', service: 'patientEnrollmentStart' },
  { path: '/identity/provider-enrollments', action: 'provider-enrollment',
    body: { ...cac, organizationType: 'clinic', administratorName: 'Ada Example' }, passes: 'DOWNSTREAM_REACHED', service: 'providerEnrollmentStart' },
  { path: '/identity/clinician-applications/email-code', action: 'clinician-application', body: { email },
    passes: 'DOWNSTREAM_REACHED', service: 'clinicianSignupStart' },
  { path: '/identity/clinician-applications/status/email-code', action: 'clinician-application-status', body: { email },
    passes: 'DOWNSTREAM_REACHED', service: 'clinicianStatusStart' },
] as const;

/** Cloudflare Siteverify as documented, for tokens named `pass:<action>:<hostname>`, `invalid`, `expired` and `outage`. */
const verified = new Map<string, { key: string; answer: object }>();
let siteverifyCalls = 0;
async function siteverify(url: string, init: RequestInit): Promise<Response> {
  expect(url).toBe(SITEVERIFY);
  siteverifyCalls += 1;
  const body = JSON.parse(String(init.body)) as { response: string; idempotency_key: string };
  if (body.response === 'outage') throw new TypeError('fetch failed');
  const earlier = verified.get(body.response);
  if (earlier) {
    return Response.json(earlier.key === body.idempotency_key
      ? earlier.answer : { success: false, 'error-codes': ['timeout-or-duplicate'] });
  }
  const [kind, action, hostname] = body.response.split(':');
  const answer = kind === 'pass' ? { success: true, action, hostname, 'error-codes': [] }
    : { success: false, 'error-codes': [body.response === 'expired' ? 'timeout-or-duplicate' : 'invalid-input-response'] };
  verified.set(body.response, { key: body.idempotency_key, answer });
  return Response.json(answer);
}

const patient = { id: 'patient:p', subject: 'patient:p', kind: 'patient', accountId: '20000000-0000-4000-8000-0000000000c1',
  roles: [], permissions: [], facilityIds: [], facilities: [], platformRoles: [], platformPermissions: [] } as unknown as ActorContext;

let app: INestApplication;
let sequence = 0;
const originalFetch = global.fetch;
const originalEnvironment = { ...process.env };

beforeEach(async () => {
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
    CORS_ORIGINS: Object.values(WORKFORCE_HOSTS).map((host) => `https://${host}`).join(','), AUTH_MODE: 'local', AUTH_COOKIE_NAME: 'hid_access', AUTH_COOKIE_SECURE: 'false',
    AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
    AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters',
    HID_DEPLOYMENT_ENV: 'production', TURNSTILE_MODE: 'required', TURNSTILE_SECRET_KEY: 'synthetic-turnstile-secret',
    TURNSTILE_TIMEOUT_MS: '250' });
  resetEnvironmentForTests();
  verified.clear();
  siteverifyCalls = 0;
  global.fetch = jest.fn(siteverify) as unknown as typeof fetch;
  for (const service of Object.values(downstream)) service.mockClear();
  const audit = { record: jest.fn(), recordLoginFailure: jest.fn() };
  const module = await Test.createTestingModule({
    controllers: [AuthController, PlatformAuthController, OtpController, PublicDemoRequestsController,
      PublicOrganizationApplicationsController, PublicOrganizationProfileCompletionController,
      PatientEnrollmentController, ProviderEnrollmentController, ClinicianApplicationController],
    providers: [
      TurnstileService,
      { provide: AuthService, useValue: { login: downstream.patientLogin } },
      { provide: TokenService, useValue: {} },
      { provide: AuthSessionAuditService, useValue: audit },
      { provide: AuditService, useValue: {} },
      { provide: WorkloadAuthService, useValue: {} },
      { provide: GoogleAuthenticationService, useValue: { login: downstream.googleLogin, exchange: downstream.googleExchange,
        linkExistingPatient: downstream.googleLink, onboardingCookieName: 'hid_google_onboarding' } },
      // The staff and platform password steps share MfaService.beginLogin; the route names which one ran.
      { provide: MfaService, useValue: { beginLogin: jest.fn((...args: unknown[]) =>
        (args[3] === 'staff' ? downstream.staffLogin : downstream.adminLogin)(...args)) } },
      { provide: OtpService, useValue: { start: downstream.otpStart } },
      { provide: DemoRequestsService, useValue: { submit: downstream.demoSubmit } },
      { provide: OrganizationApplicationsService, useValue: { submit: downstream.applicationSubmit } },
      { provide: OrganizationProfileCompletionService, useValue: { start: downstream.completionStart } },
      { provide: PatientEnrollmentService, useValue: { start: downstream.patientEnrollmentStart } },
      { provide: ProviderEnrollmentService, useValue: { start: downstream.providerEnrollmentStart } },
      { provide: ClinicianApplicationService, useValue: { startSignup: downstream.clinicianSignupStart,
        startStatus: downstream.clinicianStatusStart } },
    ],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.use(cookieParser());
  // The security guard's effect on the one gated route that needs a session.
  app.use((incoming: ExpressRequest, _response: ExpressResponse, next: NextFunction) => {
    const hid = incoming as unknown as HidRequest;
    hid.correlationId = '00000000-0000-4000-8000-0000000000c1';
    if (incoming.path === '/api/v1/auth/google/link') hid.actor = patient;
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
  global.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
  resetEnvironmentForTests();
});

function post(route: typeof ROUTES[number], fields: Record<string, unknown>) {
  sequence += 1;
  return request(app.getHttpServer()).post(`/api/v1${route.path}`).set('Origin', ORIGIN)
    .set('Idempotency-Key', `turnstile-route-${String(sequence).padStart(8, '0')}`)
    .send({ ...route.body, turnstileAction: route.action, ...fields });
}

function untouched(): void {
  for (const service of Object.values(downstream)) expect(service).not.toHaveBeenCalled();
}

describe.each([...ROUTES])('$path', (route) => {
  const token = (action: string = route.action, hostname = SITE) => `pass:${action}:${hostname}:${sequence + 1}`;

  it('reaches its service only with a token Cloudflare accepts for its action and host', async () => {
    const response = await post(route, { turnstileToken: token() });
    expect(response.body.code).toBe(route.passes);
    expect(siteverifyCalls).toBe(1);
    if (route.passes === 'DOWNSTREAM_REACHED') expect(downstream[route.service]).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a missing token', {}],
    ['an empty token', { turnstileToken: '' }],
  ])('answers %s 400 TURNSTILE_REQUIRED without calling Cloudflare', async (_label, fields) => {
    const response = await post(route, fields);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('TURNSTILE_REQUIRED');
    expect(siteverifyCalls).toBe(0);
    untouched();
  });

  it.each([
    ['an invalid token', () => 'invalid', 403, 'TURNSTILE_REJECTED'],
    ['an expired token', () => 'expired', 403, 'TURNSTILE_EXPIRED_OR_REPLAYED'],
    ['a token issued for another action', () => token('outreach-login'), 403, 'TURNSTILE_ACTION_MISMATCH'],
    ['a token issued on another host', () => token(route.action, 'evil.example'), 403, 'TURNSTILE_HOSTNAME_MISMATCH'],
    ['Cloudflare unreachable', () => 'outage', 503, 'TURNSTILE_UNAVAILABLE'],
  ])('answers %s with its refusal before the service runs', async (_label, value, status, code) => {
    const response = await post(route, { turnstileToken: value() });
    expect(response.status).toBe(status);
    expect(response.body.code).toBe(code);
    untouched();
  });

  it('refuses a token already spent on an earlier request', async () => {
    const spent = token();
    expect((await post(route, { turnstileToken: spent })).body.code).toBe(route.passes);
    for (const service of Object.values(downstream)) service.mockClear();
    const replay = await post(route, { turnstileToken: spent });
    expect(replay.status).toBe(403);
    expect(replay.body.code).toBe('TURNSTILE_EXPIRED_OR_REPLAYED');
    untouched();
  });
});

describe('the workforce sign-in route', () => {
  // TS-6: /auth/login takes only the workforce actions. Before, any login
  // action but patient-login was verified, so an admin-login token from the
  // platform administration page signed in to the staff password step.
  it.each(['admin-login', 'patient-login'])('refuses a %s token with 400 INVALID_LOGIN_ACTION before Cloudflare', async (action) => {
    const response = await post(ROUTES[0], { turnstileAction: action, turnstileToken: `pass:${action}:${SITE}:x` });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_LOGIN_ACTION');
    expect(siteverifyCalls).toBe(0);
    untouched();
  });

  it.each(Object.entries(WORKFORCE_HOSTS))('verifies a %s token from %s', async (action, host) => {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', `https://${host}`)
      .send({ email, password, turnstileAction: action, turnstileToken: `pass:${action}:${host}:workforce` });
    expect(response.body.code).toBe('DOWNSTREAM_REACHED');
    expect(siteverifyCalls).toBe(1);
    expect(downstream.staffLogin).toHaveBeenCalledTimes(1);
  });
});

describe('the clinician application routes (ADR-066)', () => {
  // Both actions belong to the main site only: a product host (where a staff
  // member signs in) never presents them, so a token from one is refused
  // before Cloudflare is called.
  it.each([
    ['/identity/clinician-applications/email-code', 'clinician-application'],
    ['/identity/clinician-applications/status/email-code', 'clinician-application-status'],
  ])('refuses %s from a product host with 403 TURNSTILE_CONTEXT_MISMATCH', async (path, action) => {
    const host = WORKFORCE_HOSTS['ehr-login'];
    const response = await request(app.getHttpServer()).post(`/api/v1${path}`).set('Origin', `https://${host}`)
      .send({ email, turnstileAction: action, turnstileToken: `pass:${action}:${host}:product` });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('TURNSTILE_CONTEXT_MISMATCH');
    expect(siteverifyCalls).toBe(0);
    untouched();
  });

  it('refuses the sign-up action on the status route and the status action on the sign-up route', async () => {
    for (const [path, action] of [['/identity/clinician-applications/email-code', 'clinician-application-status'],
      ['/identity/clinician-applications/status/email-code', 'clinician-application']] as const) {
      const response = await request(app.getHttpServer()).post(`/api/v1${path}`).set('Origin', ORIGIN)
        .send({ email, turnstileAction: action, turnstileToken: `pass:${action}:${SITE}:swap` });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    }
    expect(siteverifyCalls).toBe(0);
    untouched();
  });
});
