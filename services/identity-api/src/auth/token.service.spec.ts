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
