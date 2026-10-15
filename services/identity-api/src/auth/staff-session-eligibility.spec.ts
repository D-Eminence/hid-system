jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(async () => ({ payload: {} })),
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

import type { PoolClient } from 'pg';
import { DomainProblem } from '../common/problem';
import type { DatabaseService } from '../database/database.service';
import { useTestEnvironment } from '../testing/platform-assurance';
import { type CurrentStaffContextService, StaffMembershipInactiveError } from './current-staff-context.service';
import { TokenService } from './token.service';

/**
 * Staff-session issuance re-checks eligibility (ADR-064, defence in depth). A
 * staff session is issued only for an account the staff resolver finds an
 * eligible membership for. One whose membership ended between the password
 * step and the code step, or a clinician applicant whose application is not
 * approved, is refused with the password step's 403
 * NO_ACTIVE_FACILITY_MEMBERSHIP (not a 401, which reads as a refused
 * credential, ADR-059), and no session row is written.
 */
useTestEnvironment();

const assurance = { accountId: '40000000-0000-4000-8000-0000000000e9', subject: 'synthetic:staff-e9',
  factorId: '41000000-0000-4000-8000-0000000000e9', method: 'totp' as const };
const event = { correlationId: '01J5A2C3D4E5F6G7H8J9K0MNE9', sourceIp: '192.0.2.90' };

function harness(resolve: jest.Mock, resolvePlatform: jest.Mock = jest.fn()) {
  const statements: string[] = [];
  const client = { query: jest.fn(async (sql: string) => {
    statements.push(String(sql));
    return String(sql).includes('select token_version::text') ? { rows: [{ token_version: '1' }], rowCount: 1 }
      : { rows: [], rowCount: 1 };
  }) } as unknown as PoolClient;
  const database = { query: jest.fn(), withSystemTransaction: jest.fn() };
  const service = new TokenService(database as unknown as DatabaseService,
    { resolve, resolvePlatform } as unknown as CurrentStaffContextService, { resolve: jest.fn() } as never);
  return { service, client, statements };
}

describe('staff session issuance re-checks eligibility', () => {
  it('refuses an account without an eligible membership with 403 NO_ACTIVE_FACILITY_MEMBERSHIP and writes nothing', async () => {
    const { service, client, statements } = harness(jest.fn().mockRejectedValue(new StaffMembershipInactiveError()));
    const error = await service.issueStaffSession(client, assurance, event).then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(DomainProblem);
    expect((error as DomainProblem).getStatus()).toBe(403);
    expect((error as DomainProblem).code).toBe('NO_ACTIVE_FACILITY_MEMBERSHIP');
    expect(statements.some((sql) => sql.includes('insert into auth.sessions'))).toBe(false);
    expect(statements.some((sql) => sql.includes('insert into auth.session_assurance'))).toBe(false);
  });

  it('keeps every other resolver failure as it was', async () => {
    const other = new Error('database unavailable');
    const { service, client } = harness(jest.fn().mockRejectedValue(other));
    await expect(service.issueStaffSession(client, assurance, event)).rejects.toBe(other);
  });

  it('keeps the resolver refusal a 401 with its message everywhere else', () => {
    const error = new StaffMembershipInactiveError();
    expect(error.getStatus()).toBe(401);
    expect(error.message).toBe('Staff account or facility membership is inactive');
  });

  it('issues a platform session from the platform resolver alone (the staff resolver is not consulted)', async () => {
    const resolve = jest.fn();
    const resolvePlatform = jest.fn().mockResolvedValue({ kind: 'platform', id: assurance.accountId,
      subject: assurance.subject, accountId: assurance.accountId, roles: [], permissions: [],
      platformRoles: ['platform_super_admin'], platformPermissions: ['platform.admin.access'], facilityIds: [],
      facilities: [], authenticationMethod: 'local' });
    const { service, client, statements } = harness(resolve, resolvePlatform);
    const issued = await service.issuePlatformSession(client, assurance, event);
    expect(resolvePlatform).toHaveBeenCalledWith(assurance.subject, undefined, client);
    expect(resolve).not.toHaveBeenCalled();
    expect(issued.actor).toMatchObject({ kind: 'platform', accountId: assurance.accountId });
    expect(statements.some((sql) => sql.includes('insert into auth.sessions'))).toBe(true);
    expect(statements.some((sql) => sql.includes('insert into auth.session_assurance'))).toBe(true);
  });
});
