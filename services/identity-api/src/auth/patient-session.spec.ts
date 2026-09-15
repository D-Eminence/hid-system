jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(),
  SignJWT: class {
    setProtectedHeader() { return this; } setSubject() { return this; } setIssuer() { return this; }
    setAudience() { return this; } setJti() { return this; } setIssuedAt() { return this; }
    setExpirationTime() { return this; } async sign() { return 'signed-patient-access'; }
  },
}));
import { jwtVerify } from 'jose';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { PATIENT_ALLOWED, FACILITY_OPTIONAL } from '../common/decorators';
import type { ActorContext, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { CurrentPatientContextService } from './current-patient-context.service';
import type { CurrentStaffContextService } from './current-staff-context.service';
import { TokenService } from './token.service';
import { SecurityGuard } from './security.guard';

const actor: ActorContext = { kind: 'patient', patientId: '51000000-0000-4000-8000-000000000001',
  id: 'patient-subject', subject: 'patient-subject', accountId: '21000000-0000-4000-8000-000000000001',
  roles: [], permissions: [], platformPermissions: [], platformRoles: [], facilities: [], facilityIds: [], authenticationMethod: 'local' };
beforeEach(() => {
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
    CORS_ORIGINS: 'http://localhost:5173', AUTH_MODE: 'local', STORAGE_MODE: 'disabled',
    AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
    AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters' });
  resetEnvironmentForTests();
});
afterEach(() => resetEnvironmentForTests());

describe('Patient session separation', () => {
  it('stores a patient-scoped session and canonical binding without resolving workforce authority', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ token_version: '1' }], rowCount: 1 });
    const clientQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const staff = { resolve: jest.fn() };
    const patient = { resolve: jest.fn().mockResolvedValue(actor) };
    const database = { query, withSystemTransaction: async (_id: string, work: (c: PoolClient) => Promise<unknown>) => work({ query: clientQuery } as unknown as PoolClient) };
    const service = new TokenService(database as unknown as DatabaseService,
      staff as unknown as CurrentStaffContextService, patient as unknown as CurrentPatientContextService);
    const result = await service.issue({ subject: actor.subject, actorKind: 'patient', email: '',
      displayName: '', facilities: [], authenticationMethod: 'local' }, { correlationId: 'patient-session-login-test' });
    expect(staff.resolve).not.toHaveBeenCalled();
    expect(result.actor.kind).toBe('patient');
    const insert = clientQuery.mock.calls.find(([sql]) => String(sql).includes('insert into auth.sessions'));
    expect(insert?.[1].slice(-2)).toEqual(['patient', actor.patientId]);
    expect(service.verifyRefreshCsrf(result.refreshToken, result.csrfToken, 'forged')).toBe(false);
    expect(service.verifyRefreshCsrf(result.refreshToken, result.csrfToken, result.csrfToken)).toBe(true);
  });

  it('rejects a changed canonical association even when the access signature and stored session pass', async () => {
    jest.mocked(jwtVerify).mockResolvedValue({ payload: { sub: actor.subject, sid: 'session', jti: 'jti',
      auth_method: 'local', actor_kind: 'patient', patient_id: actor.patientId, token_version: 1 }, protectedHeader: { alg: 'HS256' } } as never);
    const query = jest.fn().mockResolvedValue({ rowCount: 1, rows: [{}] });
    const service = new TokenService({ query } as unknown as DatabaseService,
      { resolve: jest.fn() } as unknown as CurrentStaffContextService,
      { resolve: jest.fn().mockResolvedValue({ ...actor, patientId: 'different-patient' }) } as unknown as CurrentPatientContextService);
    await expect(service.verify('signed')).rejects.toThrow('Patient account association changed');
    expect(query.mock.calls[0]?.[1].slice(-2)).toEqual(['patient', actor.patientId]);
    expect(query.mock.calls[0]?.[0]).toContain('session.absolute_expires_at > clock_timestamp()');
  });

  it('denies patient actors at workforce routes before any facility or permission expansion', async () => {
    const request = { method: 'GET', correlationId: 'patient-guard-test', header: (key: string) => key === 'authorization' ? 'Bearer signed' : undefined } as unknown as HidRequest;
    const context = { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => ({}), getClass: () => ({}) } as unknown as ExecutionContext;
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const reflector = { getAllAndOverride: (key: symbol) => key === FACILITY_OPTIONAL ? true : undefined } as unknown as Reflector;
    const guard = new SecurityGuard(reflector, { verify: jest.fn().mockResolvedValue({ actor, claims: {} }) } as unknown as TokenService,
      audit as unknown as AuditService);
    await expect(guard.canActivate(context)).rejects.toThrow('This operation requires workforce authorization');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'patient', outcome: 'denied' }));
    const allowed = { getAllAndOverride: (key: symbol) => key === FACILITY_OPTIONAL || key === PATIENT_ALLOWED ? true : undefined } as unknown as Reflector;
    await expect(new SecurityGuard(allowed, { verify: jest.fn().mockResolvedValue({ actor, claims: {} }) } as unknown as TokenService,
      audit as unknown as AuditService).canActivate(context)).resolves.toBe(true);
  });
});
