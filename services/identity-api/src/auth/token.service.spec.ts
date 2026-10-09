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

function serviceWithUpgradeResult(upgraded: boolean) {
  const clientQuery = jest.fn(async (sql: string, _values?: readonly unknown[]) => {
    if (sql.includes('auth.upgrade_legacy_password')) {
      return { rows: [{ upgraded }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const database = {
    query: jest.fn(async () => ({ rows: [{ token_version: '1' }], rowCount: 1 })),
    withSystemTransaction: jest.fn(async (
      _correlationId: string,
      operation: (client: PoolClient) => Promise<unknown>,
    ) => operation({ query: clientQuery } as unknown as PoolClient)),
  } as unknown as DatabaseService;
  const currentStaff = {
    resolve: jest.fn(async () => actor),
  } as unknown as CurrentStaffContextService;
  return { service: new TokenService(database, currentStaff), clientQuery };
}

function policyHash(): string {
  return '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dmFsaWRoYXNoZm9ydGVzdGluZ29ubHk';
}

describe('TokenService platform session separation (Stage 2A)', () => {
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/hid', CORS_ORIGINS: 'http://localhost:5173',
      AUTH_MODE: 'local', AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
      AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters', STORAGE_MODE: 'disabled',
    });
    resetEnvironmentForTests();
  });
  afterEach(() => resetEnvironmentForTests());

  function sessionRow(kind: 'staff' | 'platform') {
    return {
      id: '70000000-0000-4000-8000-000000000001', account_id: actor.accountId, actor_subject: actor.subject,
      family_id: '70000000-0000-4000-8000-000000000001', access_jti: '71000000-0000-4000-8000-000000000001',
      token_version: '1', authentication_method: 'password', session_kind: kind, patient_id: null,
      expires_at: new Date(Date.now() + 600_000), absolute_expires_at: new Date(Date.now() + 3_600_000),
      revoked_at: null,
    };
  }

  function refreshHarness(kind: 'staff' | 'platform', assuranceActive = true) {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('from auth.sessions session') && sql.includes('refresh_token_sha256')) {
        return { rows: [sessionRow(kind)], rowCount: 1 };
      }
      if (sql.includes('from auth.session_assurance')) return { rows: assuranceActive ? [{}] : [], rowCount: assuranceActive ? 1 : 0 };
      return { rows: [], rowCount: 0 };
    });
    const clientQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const database = { query, withSystemTransaction: jest.fn(async (_id, work) => work({ query: clientQuery } as unknown as PoolClient)) };
    const staff = { resolve: jest.fn().mockResolvedValue(actor),
      resolvePlatform: jest.fn().mockResolvedValue({ ...actor, kind: 'platform', facilities: [], facilityIds: [] }) };
    const service = new TokenService(database as unknown as DatabaseService, staff as unknown as CurrentStaffContextService);
    return { service, query, clientQuery, staff, database };
  }

  const token = '70000000-0000-4000-8000-000000000001.opaque-refresh-secret.local';
  const event = { correlationId: '01J5A2C3D4E5F6G7H8J9K0MNPQ' };

  it('refuses a platform refresh token on the standard refresh endpoint without touching the session', async () => {
    const { service, clientQuery, database } = refreshHarness('platform');
    await expect(service.refresh(token, event)).rejects.toThrow(UnauthorizedException);
    expect(database.withSystemTransaction).not.toHaveBeenCalled();
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('refuses a staff refresh token on the platform refresh endpoint', async () => {
    const { service, database } = refreshHarness('staff');
    await expect(service.refresh(token, event, 'platform')).rejects.toThrow(UnauthorizedException);
    expect(database.withSystemTransaction).not.toHaveBeenCalled();
  });

  it('refuses a platform refresh once its MFA assurance is gone (factor reset or revoked)', async () => {
    const { service, staff } = refreshHarness('platform', false);
    await expect(service.refresh(token, event, 'platform')).rejects.toThrow('Platform session assurance is no longer valid');
    expect(staff.resolvePlatform).not.toHaveBeenCalled();
  });

  it('rotates a platform session with the platform idle window, resolved without a membership', async () => {
    const { service, staff, clientQuery } = refreshHarness('platform');
    const before = Date.now();
    const result = await service.refresh(token, event, 'platform');
    expect(staff.resolvePlatform).toHaveBeenCalledWith(actor.subject, undefined);
    expect(staff.resolve).not.toHaveBeenCalled();
    // Default platform lifetimes: 5-minute access token, 15-minute idle window.
    expect(result.expiresAt.getTime() - before).toBeLessThanOrEqual(300_000 + 1_000);
    expect(result.refreshExpiresAt.getTime() - before).toBeLessThanOrEqual(900_000 + 1_000);
    const insert = clientQuery.mock.calls.find(([sql]) => String(sql).includes('insert into auth.sessions'));
    expect(insert?.[1]).toContain('platform');
  });
});
