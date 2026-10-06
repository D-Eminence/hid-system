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

import { UnauthorizedException } from '@nestjs/common';
import { jwtVerify } from 'jose';
import type { PoolClient } from 'pg';
import type { ActorContext } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { CurrentStaffContextService } from './current-staff-context.service';
import { TokenService } from './token.service';

const actor: ActorContext = {
  id: '30000000-0000-4000-8000-000000000001',
  subject: '30000000-0000-4000-8000-000000000001',
  accountId: '40000000-0000-4000-8000-000000000001',
  email: 'clinician@example.test',
  displayName: 'Test Clinician',
  authenticationMethod: 'local',
  roles: ['clinician'],
  permissions: ['ehr.encounter.read'],
  facilityIds: ['10000000-0000-4000-8000-000000000001'],
  facilities: [{
    id: '10000000-0000-4000-8000-000000000001',
    membershipId: '20000000-0000-4000-8000-000000000001',
    organizationId: '60000000-0000-4000-8000-000000000001',
    name: 'Test Facility',
    roles: ['clinician'],
    permissions: ['ehr.encounter.read'],
    isPrimary: true,
  }],
};

describe('TokenService legacy password continuity', () => {
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/hid',
      CORS_ORIGINS: 'http://localhost:5173',
      AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
      AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters',
      STORAGE_MODE: 'disabled',
    });
    resetEnvironmentForTests();
  });

  afterEach(() => resetEnvironmentForTests());

  it('issues a platform-only session without clinical assignments', async () => {
    const principal = { ...actor, roles: [], permissions: [], facilities: [], facilityIds: [],
      platformRoles: ['platform_super_admin'], platformPermissions: ['platform.admin.access'] };
    const { service } = serviceWithUpgradeResult(true, principal);
    const result = await service.issue({ subject: principal.subject, accountId: principal.accountId,
      displayName: 'Administrator', facilities: [], authenticationMethod: 'local' }, { correlationId: 'platform-session-test' });
    expect(result.actor.platformPermissions).toEqual(['platform.admin.access']);
    expect(result.actor.facilities).toEqual([]);
    expect(result.actor.permissions).toEqual([]);
  });

  it('rechecks current platform authority when verifying an existing signed session', async () => {
    const { service, resolve } = serviceWithUpgradeResult(true);
    jest.mocked(jwtVerify).mockResolvedValue({ payload: { sub: actor.subject, sid: 'session-id', jti: 'access-id',
      token_version: 1, auth_method: 'local', actor_kind: 'staff', platform_permissions: ['platform.admin.access'] } } as never);
    resolve.mockRejectedValueOnce(new UnauthorizedException('Role revoked'));
    await expect(service.verify('signed-access-token')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(resolve).toHaveBeenCalledWith(actor.subject, 'local', 'session-id');
  });

  it('refuses refresh after current platform authority is revoked, before creating a new session', async () => {
    const { service, resolve, accountQuery, clientQuery } = serviceWithUpgradeResult(true);
    accountQuery.mockResolvedValueOnce({ rows: [{ id: 'old-session', account_id: actor.accountId,
      actor_subject: actor.subject, family_id: 'session-family', token_version: '1', authentication_method: 'password',
      session_kind: 'staff', revoked_at: null, expires_at: new Date(Date.now() + 60000),
      absolute_expires_at: new Date(Date.now() + 60000) }], rowCount: 1 } as never);
    resolve.mockRejectedValueOnce(new UnauthorizedException('Role revoked'));
    await expect(service.refresh('old-session.random.local', { correlationId: 'platform-refresh-test' }))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(resolve).toHaveBeenCalledWith(actor.subject, 'local', undefined);
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('uses the constrained database command instead of direct account-table UPDATE', async () => {
    const { service, clientQuery } = serviceWithUpgradeResult(true);
    await service.issue({
      subject: actor.subject,
      email: actor.email ?? '',
      displayName: actor.displayName ?? '',
      facilities: [...actor.facilities],
      authenticationMethod: 'local',
      passwordUpgrade: { hash: policyHash(), expectedRowVersion: 3 },
    }, { correlationId: '01J5A2C3D4E5F6G7H8J9K0MNPQ' });

    const calls = clientQuery.mock.calls.map(([sql]) => String(sql));
    expect(calls.some((sql) => sql.includes('auth.upgrade_legacy_password'))).toBe(true);
    expect(calls.some((sql) => /update\s+auth\.accounts/i.test(sql))).toBe(false);
    const upgrade = clientQuery.mock.calls.find(([sql]) => String(sql).includes('auth.upgrade_legacy_password'));
    expect(upgrade?.[1]).toEqual([actor.accountId, actor.subject, 3, policyHash()]);
  });

  it('fails closed when the compare-and-swap upgrade loses a concurrency race', async () => {
    const { service, clientQuery } = serviceWithUpgradeResult(false);
    await expect(service.issue({
      subject: actor.subject,
      email: actor.email ?? '',
      displayName: actor.displayName ?? '',
      facilities: [...actor.facilities],
      authenticationMethod: 'local',
      passwordUpgrade: { hash: policyHash(), expectedRowVersion: 3 },
    }, { correlationId: '01J5A2C3D4E5F6G7H8J9K0MNPQ' })).rejects.toBeInstanceOf(UnauthorizedException);

    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes('insert into auth.sessions'))).toBe(false);
  });

  it('fails closed when an authenticated identity does not map to the resolved account', async () => {
    const { service, clientQuery } = serviceWithUpgradeResult(true);

    await expect(service.issue({
      subject: actor.subject,
      accountId: '50000000-0000-4000-8000-000000000001',
      email: actor.email ?? '',
      displayName: actor.displayName ?? '',
      facilities: [...actor.facilities],
      authenticationMethod: 'oidc',
    }, { correlationId: '01J5A2C3D4E5F6G7H8J9K0MNPQ' })).rejects.toBeInstanceOf(UnauthorizedException);

    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes('insert into auth.sessions'))).toBe(false);
  });

  it('only accepts refresh sessions for a currently active, unsuspended account at the current token version', async () => {
    const query = jest.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [], rowCount: 0 }));
    const database = { query } as unknown as DatabaseService;
    const currentStaff = { resolve: jest.fn() } as unknown as CurrentStaffContextService;
    const service = new TokenService(database, currentStaff);

    await expect(service.refresh(
      '00000000-0000-4000-8000-000000000001.local.refresh-secret',
      { correlationId: '01J5A2C3D4E5F6G7H8J9K0MNPQ' },
    )).rejects.toBeInstanceOf(UnauthorizedException);

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("account.status = 'active'");
    expect(sql).toContain('account.disabled_until');
    expect(sql).toContain('account.token_version = session.account_token_version');
    expect(currentStaff.resolve).not.toHaveBeenCalled();
  });
});

function serviceWithUpgradeResult(upgraded: boolean, principal: ActorContext = actor) {
  const clientQuery = jest.fn(async (sql: string, _values?: readonly unknown[]) => {
    if (sql.includes('auth.upgrade_legacy_password')) {
      return { rows: [{ upgraded }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const accountQuery = jest.fn(async () => ({ rows: [{ token_version: '1' }], rowCount: 1 }));
  const database = {
    query: accountQuery,
    withSystemTransaction: jest.fn(async (
      _correlationId: string,
      operation: (client: PoolClient) => Promise<unknown>,
    ) => operation({ query: clientQuery } as unknown as PoolClient)),
  } as unknown as DatabaseService;
  const resolve = jest.fn(async () => principal);
  const currentStaff = { resolve } as unknown as CurrentStaffContextService;
  return { service: new TokenService(database, currentStaff), clientQuery, resolve, accountQuery };
}

function policyHash(): string {
  return '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dmFsaWRoYXNoZm9ydGVzdGluZ29ubHk';
}
