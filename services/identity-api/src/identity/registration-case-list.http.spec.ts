jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import { randomUUID } from 'node:crypto';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Response } from 'express';
import request from 'supertest';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditService } from '../audit/audit.service';
import { SecurityGuard } from '../auth/security.guard';
import { TokenService } from '../auth/token.service';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, FacilityAssignment, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { HidCodeGenerator } from './hid-code-generator.service';
import { NinIdentifierProtector } from './nin-identifier-protector';
import { NinProviderBreaker } from './nin-provider-breaker';
import { NinRegistrationController } from './nin-registration.controller';
import { NinRegistrationService } from './nin-registration.service';
import { NIN_VERIFICATION_PROVIDER } from './nin.types';

/**
 * SX-10 over HTTP: GET /api/v1/identity/registration-cases with the real
 * security guard, audit interceptor, the global validation pipe as main.ts
 * sets it, and the problem filter, on a fake database. Fictional people and
 * identifiers only.
 */
const facilityId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const membershipId = 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f';
const accountId = 'f0e1d2c3-b4a5-4968-8776-655443322110';
const caseId = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const LIST_SQL = 'from identity.registration_cases registration';

function deskAt(permissions: string[]): ActorContext {
  const facility: FacilityAssignment = { id: facilityId, membershipId, organizationId: '10000000-0000-4000-8000-000000000001',
    name: 'Synthetic Clinic', roles: ['receptionist'], permissions, isPrimary: true };
  return { kind: 'staff', id: 'staff:desk', subject: 'synthetic:desk', accountId, roles: ['receptionist'], permissions,
    platformRoles: [], platformPermissions: [], facilityIds: [facilityId], facilities: [facility], facility,
    authenticationMethod: 'local' };
}

describe('SX-10 registration-case list over HTTP', () => {
  const originalEnvironment = { ...process.env };
  let app: INestApplication;
  const calls: { sql: string; values: unknown[] }[] = [];
  const respond = jest.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.includes('platform.control_enabled($1)')) return { rows: [{ enabled: values[0] !== 'maintenance_mode' }] };
    if (sql.includes(LIST_SQL)) {
      return { rows: [{ id: caseId, status: 'pending_new_identity_approval', row_version: '1', resolved_patient_id: null,
        resolved_hid_code: null, candidate_count: '0', contact_recorded: true, nin_verified: true,
        full_name: 'Ada Fictional', dob: '1991-04-05', created_at: new Date('2026-11-18T10:00:58Z'),
        updated_at: new Date('2026-11-18T10:05:58Z'), created_at_cursor: '2026-11-18 10:00:58.123456+00', created_by_me: true,
        created_by_membership_id: 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f', created_by_name: 'Ada Desk' }] };
    }
    return { rows: [] };
  });
  const database = {
    query: respond,
    withTransaction: jest.fn(async (_context: unknown, work: (client: unknown) => Promise<unknown>) => work({ query: respond })),
  };
  const tokens = { verify: jest.fn(), verifyCsrf: jest.fn() };
  const audit = { record: jest.fn(), recordWithClient: jest.fn() };
  const listQueries = () => calls.filter((call) => call.sql.includes(LIST_SQL));

  beforeEach(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://ehr.healthidentitydirectory.com',
      AUTH_MODE: 'local', AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456', AUTH_COOKIE_SECURE: 'true', NIN_PROVIDER_MODE: 'test',
    });
    resetEnvironmentForTests();
    jest.clearAllMocks();
    calls.length = 0;
    tokens.verify.mockResolvedValue({ actor: deskAt(['identity.registration.write']), claims: {} });
    tokens.verifyCsrf.mockReturnValue(true);
    audit.record.mockResolvedValue(undefined);
    audit.recordWithClient.mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [NinRegistrationController],
      providers: [
        NinRegistrationService, NinProviderBreaker,
        { provide: DatabaseService, useValue: database },
        { provide: TokenService, useValue: tokens },
        { provide: AuditService, useValue: audit },
        { provide: NinIdentifierProtector, useValue: {} },
        { provide: HidCodeGenerator, useValue: {} },
        { provide: NIN_VERIFICATION_PROVIDER, useValue: { name: 'deterministic-test', verify: jest.fn() } },
        { provide: APP_GUARD, useFactory: (reflector: Reflector) => new SecurityGuard(reflector,
          tokens as unknown as TokenService, audit as unknown as AuditService, database as unknown as DatabaseService),
        inject: [Reflector] },
        { provide: APP_INTERCEPTOR, useFactory: (reflector: Reflector) => new AuditInterceptor(reflector,
          audit as unknown as AuditService), inject: [Reflector] },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.use((incoming: HidRequest, _response: Response, next: NextFunction) => {
      incoming.correlationId = randomUUID();
      next();
    });
    // As main.ts sets it.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
      transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
      exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
        errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    resetEnvironmentForTests();
  });

  const list = (query = '') => request(app.getHttpServer()).get(`/api/v1/identity/registration-cases${query}`)
    .set('Authorization', 'Bearer synthetic').set('X-Facility-ID', facilityId)
    .set('X-Purpose-Of-Use', 'healthcare-operations');

  it('answers the desk its own cases, not cached, and audits the answer', async () => {
    const answer = await list('?view=mine&limit=10');
    expect(answer.status).toBe(200);
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(answer.body).toEqual({ view: 'mine', nextCursor: null, cases: [{
      caseId, status: 'pending_new_identity_approval', version: 1, candidateCount: 0, contactRecorded: true,
      ninStatus: 'verified', identityEvidence: 'nin', fullName: 'Ada Fictional', dateOfBirth: '1991-04-05',
      createdAt: '2026-11-18T10:00:58.000Z', updatedAt: '2026-11-18T10:05:58.000Z', createdByMe: true,
      createdByMembershipId: 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f', createdByName: 'Ada Desk' }] });
    expect(listQueries()).toHaveLength(1);
    expect(listQueries()[0]?.values).toEqual(['mine', accountId, null, null, null, 11, null]);
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'identity.registration-case.list', outcome: 'success', facilityId,
      details: { view: 'mine', status: null, page: 'first', count: 1, caseIds: [caseId], patientIds: [] } }));
  });

  it('refuses a member without identity.registration.write: 403 PERMISSION_DENIED, nothing read', async () => {
    tokens.verify.mockResolvedValue({ actor: deskAt(['identity.patient.read']), claims: {} });
    const answer = await list();
    expect([answer.status, answer.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    expect(listQueries()).toHaveLength(0);
    expect(database.withTransaction).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied' }));
  });

  it('refuses a Health ID in the URL: 400 VALIDATION_FAILED, nothing read, the Health ID written nowhere', async () => {
    const answer = await list('?hid=HID-QX7K2M');
    expect([answer.status, answer.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(answer.body.errors).toEqual([expect.objectContaining({ field: 'hid' })]);
    expect(listQueries()).toHaveLength(0);
    expect(database.withTransaction).not.toHaveBeenCalled();
    const written = JSON.stringify([audit.record.mock.calls, audit.recordWithClient.mock.calls]);
    expect(written).not.toContain('QX7K2M');
  });

  it('refuses a missing purpose of use before reading', async () => {
    const answer = await request(app.getHttpServer()).get('/api/v1/identity/registration-cases')
      .set('Authorization', 'Bearer synthetic').set('X-Facility-ID', facilityId);
    expect([answer.status, answer.body.code]).toEqual([400, 'PURPOSE_OF_USE_REQUIRED']);
    expect(listQueries()).toHaveLength(0);
  });
});
