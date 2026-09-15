import { randomBytes, randomUUID } from 'node:crypto';
import { Global, Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { NextFunction, Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { SecurityGuard } from '../auth/security.guard';
import type { TokenService } from '../auth/token.service';
import { WorkloadAuthService } from '../auth/workload-auth.service';
import { ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import { getEnvironment, resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { IdentityModule } from './identity.module';
import { HidCodeGenerator } from './hid-code-generator.service';
import { NinIdentifierProtector } from './nin-identifier-protector';
import { NIN_VERIFICATION_PROVIDER, type NinVerificationProvider } from './nin.types';
import { DeferredNinVerificationProvider, DeterministicTestNinVerificationProvider } from './nin-verification.provider';

// Provider tests use a trusted synthetic request context; capabilities boundary
// tests use the actual SecurityGuard with synthetic token verification. No
// OIDC/JWKS/database calls may occur in either isolated fixture.
jest.mock('../auth/workload-auth.service', () => ({ WorkloadAuthService: class WorkloadAuthService {} }));
jest.mock('../auth/token.service', () => ({ TokenService: class TokenService {} }));

const database = { withTransaction: jest.fn(), withSystemTransaction: jest.fn(), query: jest.fn() };
const audit = { record: jest.fn(), recordWithClient: jest.fn() };

@Global()
@Module({
  providers: [
    { provide: DatabaseService, useValue: database },
    { provide: AuditService, useValue: audit },
    { provide: WorkloadAuthService, useValue: {} },
  ],
  exports: [DatabaseService, AuditService, WorkloadAuthService],
})
class IsolatedDependenciesModule {}

describe('explicitly deferred staging NIN', () => {
  const original = process.env;
  let app: INestApplication | undefined;
  const facilityId = randomUUID();
  const actor: ActorContext = {
    kind: 'staff', id: randomUUID(), subject: 'synthetic:staging-staff', accountId: randomUUID(),
    roles: ['doctor'], permissions: ['identity.registration.write', 'identity.registration.approve'],
    facilityIds: [facilityId], facilities: [], authenticationMethod: 'oidc',
    facility: { id: facilityId, membershipId: randomUUID(), organizationId: randomUUID(),
      name: 'Synthetic facility', roles: ['doctor'], permissions: ['identity.registration.write', 'identity.registration.approve'], isPrimary: true },
  };

  beforeEach(() => {
    process.env = {
      NODE_ENV: 'production', HID_DEPLOYMENT_ENV: 'staging', NIN_PROVIDER_MODE: 'deferred',
      DATABASE_URL: 'postgresql://synthetic@db.example.test/hid', DATABASE_SSL: 'true',
      DATABASE_SSL_ROOT_CERT_BASE64: Buffer.from('synthetic-unused-ca').toString('base64'),
      CORS_ORIGINS: 'https://staging.healthidentitydirectory.com', TRUST_PROXY_CIDRS: '10.0.0.0/8',
      AUTH_MODE: 'oidc', AUTH_COOKIE_SECURE: 'true', OIDC_ISSUER_URL: 'https://issuer.example.test',
      OIDC_AUDIENCE: 'hid-api', OIDC_JWKS_URL: 'https://issuer.example.test/jwks',
      IDENTITY_SERVICE_IDENTITY_MODE: 'jwt', WORKLOAD_ISSUER_URL: 'https://workloads.example.test',
      WORKLOAD_AUDIENCE: 'hid-identity-api', WORKLOAD_JWKS_URL: 'https://workloads.example.test/jwks',
      IDENTITY_EHR_CALLER_SUBJECT: 'hid:staging:ehr-api', IDENTITY_LAB_CALLER_SUBJECT: 'hid:staging:lab-api',
      IDENTITY_PHARMACY_CALLER_SUBJECT: 'hid:staging:pharmacy-api', IDENTITY_OCR_CALLER_SUBJECT: 'hid:staging:ocr-api',
      OUTREACH_CALLER_SUBJECT: 'hid:staging:outreach-api', TURNSTILE_MODE: 'required',
      TURNSTILE_SECRET_KEY: randomBytes(32).toString('base64url'), OTP_HMAC_KEY_B64: randomBytes(32).toString('base64'),
      NOTIFICATION_API_URL: 'https://notification.example.test', NOTIFICATION_SERVICE_IDENTITY_MODE: 'jwt',
      NOTIFICATION_IDENTITY_WORKLOAD_TOKEN_FILE: '/synthetic/unused-notification.jwt',
    };
    resetEnvironmentForTests();
    jest.resetAllMocks();
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External transport is forbidden in this fixture'));
  });

  afterEach(async () => {
    await app?.close(); app = undefined;
    process.env = original; resetEnvironmentForTests(); jest.restoreAllMocks();
  });

  async function startModule(tokens?: { verify: jest.Mock }) {
    const module = await Test.createTestingModule({ imports: [IsolatedDependenciesModule, IdentityModule] }).compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new ProblemDetailsFilter());
    if (tokens) app.useGlobalGuards(new SecurityGuard(new Reflector(),
      tokens as unknown as TokenService, audit as unknown as AuditService));
    app.use((incoming: HidRequest, _response: Response, next: NextFunction) => {
      incoming.correlationId = randomUUID();
      if (!tokens) { incoming.actor = actor; incoming.facilityId = facilityId; }
      next();
    });
    await app.init();
    return module;
  }

  it('starts the actual Identity module with no NIN cryptographic keys or MetaMap credentials', async () => {
    expect(getEnvironment().NIN_PROVIDER_MODE).toBe('deferred');
    expect(getEnvironment().NIN_LOOKUP_HMAC_KEY_B64).toBeUndefined();
    expect(getEnvironment().NIN_ENCRYPTION_KEY_B64).toBeUndefined();
    expect(Object.keys(process.env).some(key => key.startsWith('METAMAP_'))).toBe(false);
    await startModule();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(database.withTransaction).not.toHaveBeenCalled();
  });

  it.each(['production', undefined])('rejects deferred mode without the explicit staging deployment (%s)', deployment => {
    if (deployment) process.env.HID_DEPLOYMENT_ENV = deployment;
    else delete process.env.HID_DEPLOYMENT_ENV;
    expect(() => getEnvironment()).toThrow(/deferred|staging/i);
  });

  it('rejects deterministic NIN mode under the production Node runtime even in staging', () => {
    process.env.NIN_PROVIDER_MODE = 'test';
    expect(() => getEnvironment()).toThrow(/deterministic NIN provider is test-only/);
  });

  it('rejects deterministic NIN mode in the staging profile even under the test Node runtime', () => {
    process.env.NODE_ENV = 'test';
    process.env.NIN_PROVIDER_MODE = 'test';
    expect(() => getEnvironment()).toThrow(/Staging NIN verification is deferred; test verification cannot be enabled/);
  });

  it('resolves the actual module provider to a closed deferred result without external transport', async () => {
    const deterministic = jest.spyOn(DeterministicTestNinVerificationProvider.prototype, 'verify');
    const module = await startModule();
    const provider = module.get<NinVerificationProvider>(NIN_VERIFICATION_PROVIDER);
    expect(provider).toBeInstanceOf(DeferredNinVerificationProvider);
    expect(provider.name).toBe('deferred');
    await expect(provider.verify({ nin: '12345678901', correlationId: randomUUID(),
      claimedDemographics: { firstName: 'Synthetic', lastName: 'Patient', dateOfBirth: '1990-01-02' } }))
      .rejects.toMatchObject({ code: 'NIN_PROVIDER_DEFERRED', status: 503 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(deterministic).not.toHaveBeenCalled();
  });

  it('denies the NIN resolve API before lookup/protection, database access, or HID generation', async () => {
    const module = await startModule();
    const lookup = jest.spyOn(module.get(NinIdentifierProtector), 'lookup');
    const protect = jest.spyOn(module.get(NinIdentifierProtector), 'protect');
    const reserve = jest.spyOn(module.get(HidCodeGenerator), 'reserve');
    const response = await request(app!.getHttpServer()).post('/api/v1/identity/nin/resolve')
      .set('idempotency-key', `deferred:${randomUUID()}`)
      .send({ nin: '12345678901', firstName: 'Synthetic', lastName: 'Patient', dateOfBirth: '1990-01-02', purpose: 'healthcare-operations' });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('NIN_PROVIDER_DEFERRED');
    expect(JSON.stringify(response.body)).not.toContain('12345678901');
    expect(lookup).not.toHaveBeenCalled(); expect(protect).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled(); expect(database.withTransaction).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('reports the deferred capability without a NIN call', async () => {
    await startModule();
    const response = await request(app!.getHttpServer()).get('/api/v1/identity/registration-capabilities');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ nin: { enabled: false, state: 'deferred' }, newPatientRegistrationRequiresNin: true });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['missing authentication', 401, 'AUTHENTICATION_REQUIRED'],
    ['patient principal', 403, 'PATIENT_SCOPE_DENIED'],
    ['missing facility', 400, 'FACILITY_REQUIRED'],
    ['wrong facility', 403, 'FACILITY_ACCESS_DENIED'],
    ['missing permission', 403, 'PERMISSION_DENIED'],
  ] as const)('protects registration capabilities against %s with the actual security guard', async (scenario, status, code) => {
    const verifiedActor: ActorContext = {
      ...actor, facilities: [{ ...actor.facility!, permissions: scenario === 'missing permission' ? [] : actor.permissions }],
    };
    if (scenario === 'patient principal') {
      Object.assign(verifiedActor, { kind: 'patient', patientId: randomUUID(),
        roles: [], permissions: [], facilities: [], facilityIds: [], facility: undefined });
    }
    const tokens = { verify: jest.fn().mockResolvedValue({ actor: verifiedActor, claims: {} }) };
    await startModule(tokens);
    let pending = request(app!.getHttpServer()).get('/api/v1/identity/registration-capabilities');
    if (scenario !== 'missing authentication') pending = pending.set('authorization', 'Bearer synthetic-token');
    if (scenario !== 'missing facility') pending = pending.set('x-facility-id', scenario === 'wrong facility' ? randomUUID() : facilityId);
    const response = await pending;
    expect(response.status).toBe(status);
    expect(response.body.code).toBe(code);
    expect(response.body.nin).toBeUndefined();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied' }));
    if (scenario === 'missing authentication') expect(tokens.verify).not.toHaveBeenCalled();
    else expect(tokens.verify).toHaveBeenCalledWith('synthetic-token');
    expect(database.withTransaction).not.toHaveBeenCalled();
    expect(database.withSystemTransaction).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('allows an authorized facility member to read deferred capabilities through the actual security guard', async () => {
    const tokens = { verify: jest.fn().mockResolvedValue({
      actor: { ...actor, facilities: [actor.facility!] }, claims: {},
    }) };
    await startModule(tokens);
    const response = await request(app!.getHttpServer()).get('/api/v1/identity/registration-capabilities')
      .set('authorization', 'Bearer synthetic-token').set('x-facility-id', facilityId);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ nin: { enabled: false, state: 'deferred' }, newPatientRegistrationRequiresNin: true });
    expect(tokens.verify).toHaveBeenCalledWith('synthetic-token');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('cannot approve a nonexistent registration case to bypass deferred NIN', async () => {
    await startModule();
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    database.withTransaction.mockImplementation(async (_context, action) => action({ query }));
    const response = await request(app!.getHttpServer())
      .post(`/api/v1/identity/registration-cases/${randomUUID()}/approve-new`)
      .set('idempotency-key', `deferred:${randomUUID()}`)
      .send({ expectedVersion: 1, reason: 'Synthetic unverified registration', purpose: 'healthcare-operations' });
    expect(response.status).toBe(404);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(/^\s*select/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
