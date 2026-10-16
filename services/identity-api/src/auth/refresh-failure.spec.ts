jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
  SignJWT: class {
    setProtectedHeader() { return this; }
    setSubject() { return this; }
    setIssuer() { return this; }
    setAudience() { return this; }
    setJti() { return this; }
    setIssuedAt() { return this; }
    setExpirationTime() { return this; }
    async sign() { return 'signed-access-token'; }
  },
}));
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import type { PoolClient } from 'pg';
import type { AuditEventInput, AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import type { AuthSessionAuditService } from './auth-session-audit.service';
import type { CurrentStaffContextService } from './current-staff-context.service';
import type { GoogleAuthenticationService } from './google-authentication.service';
import type { MfaService } from './mfa/mfa.service';
import { PlatformAuthController } from './platform-auth.controller';
import { TokenService, type RefreshRotationHook, type SessionEventMetadata } from './token.service';
import type { TurnstileService } from './turnstile.service';
import type { WorkloadAuthService } from './workload-auth.service';

// A6: POST /auth/refresh cleared the session cookies on any failure. A
// statement timeout (500) or a failed success audit after the rotation had
// committed (503) cleared them too, and the rotated cookies were never sent:
// behind the gateway the browser kept the spent refresh token, whose next use
// revoked the whole sign-in as refresh-token reuse.

const ORIGIN = 'https://www.healthidentitydirectory.com';
const SESSION_COOKIES = ['hid_access', 'hid_access_refresh', 'hid_access_csrf'];

const staff: ActorContext = {
  kind: 'staff', id: 'staff:doctor', subject: 'staff:doctor', accountId: '20000000-0000-4000-8000-000000000001',
  sessionId: '90000000-0000-4000-8000-0000000000aa', roles: ['doctor'], permissions: [], platformRoles: [],
  platformPermissions: [], facilityIds: ['10000000-0000-4000-8000-00000000000a'], authenticationMethod: 'local',
  facilities: [{ id: '10000000-0000-4000-8000-00000000000a', membershipId: '40000000-0000-4000-8000-00000000000a',
    organizationId: '30000000-0000-4000-8000-00000000000a', name: 'Facility A', roles: ['doctor'], permissions: [],
    isPrimary: true }],
  facility: { id: '10000000-0000-4000-8000-00000000000a', membershipId: '40000000-0000-4000-8000-00000000000a',
    organizationId: '30000000-0000-4000-8000-00000000000a', name: 'Facility A', roles: ['doctor'], permissions: [],
    isPrimary: true },
} as ActorContext;

beforeEach(() => {
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
    CORS_ORIGINS: ORIGIN, AUTH_MODE: 'local', STORAGE_MODE: 'disabled', AUTH_COOKIE_NAME: 'hid_access',
    AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
    AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters' });
  resetEnvironmentForTests();
});
afterEach(() => resetEnvironmentForTests());

function responseFor() {
  return { cookie: jest.fn(), clearCookie: jest.fn(), setHeader: jest.fn(), status: jest.fn() } as unknown as Response
    & { cookie: jest.Mock; clearCookie: jest.Mock; setHeader: jest.Mock };
}

function refreshRequest(cookieName = 'hid_access', refreshToken = 'refresh-token'): HidRequest {
  const headers: Record<string, string> = { origin: ORIGIN, 'x-csrf-token': 'csrf-token', 'user-agent': 'refresh-spec' };
  return { correlationId: 'refresh-failure-test', ip: '127.0.0.1',
    cookies: { [`${cookieName}_refresh`]: refreshToken, [`${cookieName}_csrf`]: 'csrf-token' },
    header: (name: string) => headers[name.toLowerCase()] } as unknown as HidRequest;
}

const cleared = (response: { clearCookie: jest.Mock }) => response.clearCookie.mock.calls.map(([name]) => String(name));
const set = (response: { cookie: jest.Mock }) => response.cookie.mock.calls.map(([name]) => String(name));

function controllerWith(refresh: jest.Mock) {
  const audit = { record: jest.fn().mockResolvedValue(undefined), recordWithClient: jest.fn().mockResolvedValue(undefined) };
  // No facility selection stored: a staff refresh reports 'default'.
  const tokens = { verifyRefreshCsrf: jest.fn(() => true), refreshSessionKind: jest.fn(),
    selectedFacilityId: jest.fn().mockResolvedValue(undefined) };
  const controller = new AuthController({ refresh } as unknown as AuthService, tokens as unknown as TokenService,
    { record: jest.fn() } as unknown as AuthSessionAuditService, audit as unknown as AuditService,
    {} as WorkloadAuthService, {} as TurnstileService, {} as GoogleAuthenticationService, {} as MfaService);
  return { controller, audit };
}

const rotated = () => ({ actor: { ...staff, sessionId: '90000000-0000-4000-8000-0000000000bb' },
  accessToken: 'new-access', refreshToken: 'new-refresh', csrfToken: 'new-csrf',
  expiresAt: new Date('2030-01-01T00:00:00Z'), refreshExpiresAt: new Date('2030-01-01T08:00:00Z') });

describe('POST /auth/refresh keeps the cookies unless the refresh token was definitively refused (A6)', () => {
  it.each([
    ['a statement timeout (500)', Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })],
    ['an unavailable audit store (503)', new ServiceUnavailableException('Audit persistence is unavailable; request was denied')],
    ['an unavailable dependency (503 DomainProblem)', new DomainProblem(503, 'AUTHENTICATION_UNAVAILABLE',
      'Authentication is temporarily unavailable')],
  ])('keeps the session cookies after %s', async (_label, fault) => {
    const { controller } = controllerWith(jest.fn().mockRejectedValue(fault));
    const response = responseFor();
    await expect(controller.refresh(refreshRequest(), response)).rejects.toBe(fault);
    expect(cleared(response)).toEqual([]);
  });

  it.each([
    ['a refused refresh token (401)', new UnauthorizedException('Refresh session ended')],
    ['a staff sign-in without MFA assurance (403 STAFF_MFA_REQUIRED)', new DomainProblem(403, 'STAFF_MFA_REQUIRED',
      'Sign in again with your authenticator code to continue')],
    ['an ambiguous facility membership (409)', new DomainProblem(409, 'FACILITY_MEMBERSHIP_AMBIGUOUS',
      'More than one active membership binds this account at one facility')],
  ])('clears the session cookies after %s', async (_label, refusal) => {
    const { controller } = controllerWith(jest.fn().mockRejectedValue(refusal));
    const response = responseFor();
    await expect(controller.refresh(refreshRequest(), response)).rejects.toBe(refusal);
    expect(cleared(response)).toEqual(expect.arrayContaining(SESSION_COOKIES));
  });

  it('records the auth.refresh audit inside the rotation, not after it has committed', async () => {
    const refresh = jest.fn(async (_token: string, _event: unknown,
      onRotated?: (client: PoolClient, actor: ActorContext) => Promise<void>) => {
      const result = rotated();
      // TokenService calls the hook inside the rotation transaction.
      await onRotated?.({ query: jest.fn() } as unknown as PoolClient, result.actor);
      return result;
    });
    const { controller, audit } = controllerWith(refresh);
    const response = responseFor();
    await controller.refresh(refreshRequest(), response);
    expect(audit.record).not.toHaveBeenCalled();
    expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'auth.refresh', resourceType: 'session', resourceId: '90000000-0000-4000-8000-0000000000bb',
      outcome: 'success', actorType: 'staff', facilityId: staff.facility?.id }));
    expect(set(response)).toEqual(expect.arrayContaining(SESSION_COOKIES));
    expect(cleared(response)).not.toEqual(expect.arrayContaining(SESSION_COOKIES));
  });

  it('answers a failed in-transaction audit write as 503 without clearing, so the rotation rolls back', async () => {
    const refresh = jest.fn(async (_token: string, _event: unknown,
      onRotated?: (client: PoolClient, actor: ActorContext) => Promise<void>) => {
      await onRotated?.({ query: jest.fn() } as unknown as PoolClient, rotated().actor);
      return rotated();
    });
    const { controller, audit } = controllerWith(refresh);
    audit.recordWithClient.mockRejectedValue(Object.assign(new Error('lock timeout'), { code: '55P03' }));
    const response = responseFor();
    const error = await controller.refresh(refreshRequest(), response).then(() => undefined, (failure: unknown) => failure);
    expect((error as ServiceUnavailableException).getStatus?.()).toBe(503);
    expect(cleared(response)).toEqual([]);
    expect(set(response)).toEqual([]);
  });
});

describe('TokenService.refresh commits the rotation with its audit or not at all (A6)', () => {
  function harness(hookFault?: unknown) {
    const statements: string[] = [];
    const session = { id: '70000000-0000-4000-8000-000000000001', account_id: staff.accountId,
      actor_subject: staff.subject, family_id: '70000000-0000-4000-8000-000000000001',
      access_jti: '71000000-0000-4000-8000-000000000001', token_version: '1', authentication_method: 'password',
      session_kind: 'staff', patient_id: null, expires_at: new Date(Date.now() + 600_000),
      absolute_expires_at: new Date(Date.now() + 3_600_000), revoked_at: null };
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('refresh_token_sha256')) return { rows: [session], rowCount: 1 };
      if (sql.includes('from auth.session_assurance')) return { rows: [{}], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const client = { query: jest.fn(async (sql: string) => { statements.push(sql); return { rows: [], rowCount: 1 }; }) };
    const database = { query, withSystemTransaction: jest.fn(async (_id: string, work: (c: PoolClient) => Promise<unknown>) => {
      statements.push('begin');
      try {
        const result = await work(client as unknown as PoolClient);
        statements.push('commit');
        return result;
      } catch (error) {
        statements.push('rollback');
        throw error;
      }
    }) };
    const currentStaff = { resolve: jest.fn().mockResolvedValue(staff) };
    const service = new TokenService(database as unknown as DatabaseService,
      currentStaff as unknown as CurrentStaffContextService);
    const hook = jest.fn(async (hookClient: PoolClient) => {
      statements.push('hook');
      expect(hookClient).toBe(client);
      if (hookFault) throw hookFault;
    });
    return { service, statements, hook };
  }
  const token = '70000000-0000-4000-8000-000000000001.opaque-refresh-secret.local';
  const event = { correlationId: 'refresh-failure-test' };

  it('runs the rotation hook inside the transaction, after the rotated session event', async () => {
    const { service, statements, hook } = harness();
    await (service.refresh as (...args: unknown[]) => Promise<unknown>)(token, event, 'standard', hook);
    expect(hook).toHaveBeenCalledTimes(1);
    const rotatedEvent = statements.findIndex((sql) => sql.includes('insert into auth.session_events'));
    expect(rotatedEvent).toBeGreaterThan(-1);
    expect(statements.indexOf('hook')).toBeGreaterThan(rotatedEvent);
    expect(statements.indexOf('commit')).toBeGreaterThan(statements.indexOf('hook'));
  });

  it('rolls the rotation back when the hook fails, so the presented refresh token stays the live one', async () => {
    const fault = new ServiceUnavailableException('Audit persistence is unavailable; request was denied');
    const { service, statements, hook } = harness(fault);
    await expect((service.refresh as (...args: unknown[]) => Promise<unknown>)(token, event, 'standard', hook))
      .rejects.toBe(fault);
    expect(statements).toContain('rollback');
    expect(statements).not.toContain('commit');
    // Not treated as a rotation conflict: no reuse is recorded and no family is revoked.
    expect(statements.some((sql) => sql.includes("'refresh_token_reuse'"))).toBe(false);
  });
});

describe('POST /auth/refresh reads the facility selection in the rotation, under a savepoint (A6, 0089)', () => {
  // AuthController and TokenService together, over a stand-in transaction
  // that behaves as PostgreSQL does: a failed statement aborts it, and it then
  // refuses every statement (25P02) until it is rolled back to a savepoint;
  // COMMIT of an aborted transaction rolls it back. The auth.refresh row was
  // written at the default facility while the response reported the one the
  // sign-in selected, read again after the commit.
  const primary = staff.facility!;
  const secondary = { id: '10000000-0000-4000-8000-00000000000b', membershipId: '40000000-0000-4000-8000-00000000000b',
    organizationId: '30000000-0000-4000-8000-00000000000a', name: 'Facility B', roles: ['nurse'], permissions: [],
    isPrimary: false };
  const resolved = { ...staff, facilities: [primary, secondary], facilityIds: [primary.id, secondary.id] } as ActorContext;
  const token = '70000000-0000-4000-8000-000000000001.opaque-refresh-secret.local';
  const SELECTION_READ = 'join auth.session_facility_selection selection';
  const timeout = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });

  /** `readFault` fails the selection read; `restoreFault` also fails the rollback to its savepoint. */
  function harness(options: { readFault?: Error; restoreFault?: Error } = {}) {
    const statements: string[] = [];
    let aborted = false;
    const session = { id: '70000000-0000-4000-8000-000000000001', account_id: staff.accountId,
      actor_subject: staff.subject, family_id: '70000000-0000-4000-8000-000000000001',
      access_jti: '71000000-0000-4000-8000-000000000001', token_version: '1', authentication_method: 'password',
      session_kind: 'staff', patient_id: null, expires_at: new Date(Date.now() + 600_000),
      absolute_expires_at: new Date(Date.now() + 3_600_000), revoked_at: null };
    const selection = () => {
      if (options.readFault) throw options.readFault;
      return { rows: [{ facility_id: secondary.id }], rowCount: 1 };
    };
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('refresh_token_sha256')) return { rows: [session], rowCount: 1 };
      if (sql.includes('from auth.session_assurance')) return { rows: [{}], rowCount: 1 };
      if (sql.includes(SELECTION_READ)) return selection();
      return { rows: [], rowCount: 0 };
    });
    const client = { query: jest.fn(async (sql: string) => {
      const statement = sql.replace(/\s+/g, ' ').trim();
      statements.push(statement);
      if (statement.startsWith('rollback to savepoint')) {
        if (options.restoreFault) throw options.restoreFault;
        aborted = false;
        return { rows: [], rowCount: 0 };
      }
      if (aborted) {
        throw Object.assign(new Error('current transaction is aborted, commands ignored until end of transaction block'),
          { code: '25P02' });
      }
      if (statement.includes(SELECTION_READ)) {
        try {
          return selection();
        } catch (error) {
          aborted = true;
          throw error;
        }
      }
      return { rows: [], rowCount: 1 };
    }) };
    const database = { query, withSystemTransaction: jest.fn(async (_id: string, work: (c: PoolClient) => Promise<unknown>) => {
      statements.push('begin');
      try {
        const result = await work(client as unknown as PoolClient);
        statements.push(aborted ? 'commit of an aborted transaction (rolled back)' : 'commit');
        return result;
      } catch (error) {
        statements.push('rollback');
        aborted = false;
        throw error;
      }
    }) };
    const service = new TokenService(database as unknown as DatabaseService,
      { resolve: jest.fn().mockResolvedValue(resolved) } as unknown as CurrentStaffContextService);
    jest.spyOn(service, 'verifyRefreshCsrf').mockReturnValue(true);
    // As AuthService.refresh passes it on: the standard scope, with the controller's hook.
    const auth = { refresh: (refreshToken: string, event: SessionEventMetadata, onRotated?: RefreshRotationHook) =>
      service.refresh(refreshToken, event, 'standard', onRotated) };
    // As AuditService.recordWithClient writes it: one row on the caller's transaction.
    const audit = { record: jest.fn(), recordWithClient: jest.fn(async (transaction: PoolClient, event: AuditEventInput) => {
      await transaction.query('insert into audit.events (action, facility_id, actor_membership_id) values ($1, $2, $3)',
        [event.action, event.facilityId, event.actorMembershipId]);
    }) };
    const controller = new AuthController(auth as unknown as AuthService, service,
      { record: jest.fn() } as unknown as AuthSessionAuditService, audit as unknown as AuditService,
      {} as WorkloadAuthService, {} as TurnstileService, {} as GoogleAuthenticationService, {} as MfaService);
    return { controller, statements, query, audit };
  }

  const steps = (statements: string[]) => statements.map((sql) => sql.startsWith('insert into auth.sessions') ? 'session'
    : sql.includes("revocation_reason = 'rotated'") ? 'rotated'
      : sql.startsWith('insert into auth.session_events') ? 'event'
        : sql.includes(SELECTION_READ) ? 'selection read'
          : sql.startsWith('insert into audit.events') ? 'audit' : sql);
  const refreshAudit = (audit: { recordWithClient: jest.Mock }) => audit.recordWithClient.mock.calls
    .map(([, event]) => event as AuditEventInput).filter((event) => event.action === 'auth.refresh');

  it('reports the selected facility and audits auth.refresh at it, from one read in the rotation\'s transaction', async () => {
    const { controller, statements, query, audit } = harness();
    const response = responseFor();

    const body = await controller.refresh(refreshRequest('hid_access', token), response);

    expect(body).toMatchObject({ facilitySelection: 'selected', actor: { facility: { id: secondary.id } } });
    expect(steps(statements)).toEqual(['begin', 'session', 'rotated', 'event', 'savepoint facility_selection_read',
      'selection read', 'release savepoint facility_selection_read', 'audit', 'commit']);
    expect(refreshAudit(audit)).toEqual([expect.objectContaining({ facilityId: secondary.id,
      actorMembershipId: secondary.membershipId, organizationId: secondary.organizationId,
      resourceId: (body.actor as ActorContext).sessionId })]);
    // Nothing is read again on another connection once the rotation has committed.
    expect(query.mock.calls.some(([sql]) => String(sql).includes(SELECTION_READ))).toBe(false);
    expect(set(response)).toEqual(expect.arrayContaining(SESSION_COOKIES));
    expect(cleared(response)).not.toEqual(expect.arrayContaining(SESSION_COOKIES));
  });

  it('rolls a failed read back to its savepoint only: the rotation commits with its audit at the default facility, reported as unavailable', async () => {
    const { controller, statements, audit } = harness({ readFault: timeout() });
    const response = responseFor();

    const body = await controller.refresh(refreshRequest('hid_access', token), response);

    expect(body).toMatchObject({ facilitySelection: 'unavailable', actor: { facility: { id: primary.id } } });
    expect(steps(statements)).toEqual(['begin', 'session', 'rotated', 'event', 'savepoint facility_selection_read',
      'selection read', 'rollback to savepoint facility_selection_read', 'audit', 'commit']);
    expect(refreshAudit(audit)).toEqual([expect.objectContaining({ facilityId: primary.id,
      actorMembershipId: primary.membershipId })]);
    expect(set(response)).toEqual(expect.arrayContaining(SESSION_COOKIES));
    expect(cleared(response)).not.toEqual(expect.arrayContaining(SESSION_COOKIES));
  });

  it('rolls the rotation back with 503 and touches no cookie when the failed read cannot be rolled back to its savepoint', async () => {
    const { controller, statements } = harness({ readFault: timeout(),
      restoreFault: Object.assign(new Error('savepoint "facility_selection_read" does not exist'), { code: '3B001' }) });
    const response = responseFor();

    const error = await controller.refresh(refreshRequest('hid_access', token), response)
      .then(() => undefined, (failure: unknown) => failure);

    // The transaction stays aborted, so the audit row cannot be written and
    // the rotation is not committed: the presented refresh token stays live.
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).message).not.toContain('savepoint');
    expect(steps(statements)).toEqual(['begin', 'session', 'rotated', 'event', 'savepoint facility_selection_read',
      'selection read', 'rollback to savepoint facility_selection_read', 'audit', 'rollback']);
    expect(set(response)).toEqual([]);
    expect(cleared(response)).toEqual([]);
  });
});

describe('POST /auth/admin/refresh keeps the cookies on a fault (A6)', () => {
  function platformController(refresh: jest.Mock) {
    const tokens = { verifyRefreshCsrf: jest.fn(() => true), refresh };
    return new PlatformAuthController({} as MfaService, tokens as unknown as TokenService,
      {} as AuthSessionAuditService, {} as TurnstileService);
  }

  it('keeps the platform cookies after a database fault', async () => {
    const fault = Object.assign(new Error('connection terminated'), { code: '08006' });
    const response = responseFor();
    await expect(platformController(jest.fn().mockRejectedValue(fault)).refresh(refreshRequest('hid_access_admin'),
      response)).rejects.toBe(fault);
    expect(cleared(response)).toEqual([]);
  });

  it('clears the platform cookies after a refused refresh', async () => {
    const response = responseFor();
    await expect(platformController(jest.fn().mockRejectedValue(new DomainProblem(401, 'PLATFORM_SESSION_REVOKED',
      'Your platform session was revoked'))).refresh(refreshRequest('hid_access_admin'), response)).rejects
      .toBeInstanceOf(DomainProblem);
    expect(cleared(response)).toEqual(expect.arrayContaining(['hid_access_admin', 'hid_access_admin_refresh',
      'hid_access_admin_csrf']));
  });
});
