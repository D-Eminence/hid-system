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
import type { ActorContext } from '../../common/request-context';
import type { DatabaseService } from '../../database/database.service';
import { resetEnvironmentForTests } from '../../config/environment';
import { useTestEnvironment } from '../../testing/platform-assurance';
import type { CurrentStaffContextService } from '../current-staff-context.service';
import { requireRecentPatientAuthentication, type PatientSessionActor } from '../recent-authentication';
import { TokenService, type SingleSignOnProvenance } from '../token.service';

/**
 * ADR-070: a product's session issued after single sign-on is today's
 * session (TokenService.issue, issueStaffSession), with three differences
 * that each have a test that fails without them: its provenance (client,
 * provider sid, ID token, auth_time) is stored on the new family in the
 * session's own transaction; its absolute end counts from the provider's
 * auth_time, not from the hand-off; and a patient's recent-sign-in check
 * counts from that auth_time too. Without single sign-on, nothing changes.
 */
const DAY_MS = 86_400_000;
const staff: ActorContext = {
  id: 'synthetic:staff-s', subject: 'synthetic:staff-s', accountId: '40000000-0000-4000-8000-0000000000f1',
  roles: ['doctor'], permissions: [], platformRoles: [], platformPermissions: [], facilityIds: [], facilities: [],
  authenticationMethod: 'local',
};
const patient: ActorContext = { ...staff, kind: 'patient', id: 'synthetic:patient-p', subject: 'synthetic:patient-p',
  accountId: '40000000-0000-4000-8000-0000000000f2', patientId: '50000000-0000-4000-8000-0000000000f2' };
const event = { correlationId: 'sso-session-issue-0001', sourceIp: '192.0.2.10' };
const assurance = { accountId: staff.accountId, subject: staff.subject, factorId: '41000000-0000-4000-8000-0000000000f1',
  method: 'totp' as const };

useTestEnvironment();

function harness() {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const clientQuery = jest.fn(async (sql: string, values: unknown[] = []) => {
    statements.push({ sql: String(sql), values });
    if (String(sql).includes('select token_version::text')) return { rows: [{ token_version: '1' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const client = { query: clientQuery } as unknown as PoolClient;
  const database = {
    query: jest.fn(async (sql: string) => (String(sql).includes('select token_version::text')
      ? { rows: [{ token_version: '1' }], rowCount: 1 } : { rows: [], rowCount: 0 })),
    withSystemTransaction: jest.fn(async (_id: string, work: (transaction: PoolClient) => unknown) => work(client)),
  };
  const currentStaff = { resolve: jest.fn().mockResolvedValue(staff) };
  const currentPatient = { resolve: jest.fn().mockResolvedValue(patient) };
  const service = new TokenService(database as unknown as DatabaseService,
    currentStaff as unknown as CurrentStaffContextService, currentPatient as never);
  const statement = (fragment: string) => statements.find(({ sql }) => sql.includes(fragment));
  return { service, client, statements, statement };
}

function provenance(authenticatedAt: Date, clientId = 'lab'): SingleSignOnProvenance {
  return { clientId, providerSid: 'provider-session-1', authenticatedAt };
}

describe('a staff session issued after single sign-on', () => {
  it('stores its provenance on the new family, in the session\'s own transaction', async () => {
    const { service, client, statement } = harness();
    const signedIn = new Date(Date.now() - 60_000);
    const issued = await service.issueStaffSession(client, assurance, event, provenance(signedIn));
    const family = issued.actor.sessionId;
    expect(statement('insert into auth.session_single_sign_on')?.values)
      .toEqual([family, staff.accountId, 'lab', 'provider-session-1', signedIn]);
    // The ID token is never stored.
    expect(statement('insert into auth.session_single_sign_on')?.sql).not.toContain('id_token');
    // The provider verified the second factor at its auth_time.
    expect(statement('insert into auth.session_assurance')?.values)
      .toEqual([family, staff.accountId, assurance.factorId, 'totp', signedIn]);
    expect(JSON.parse(String(statement('insert into auth.session_events')?.values[7])))
      .toEqual({ session_kind: 'staff', mfa_method: 'totp', sso_client: 'lab' });
  });

  it('ends no later than the absolute lifetime after the sign-in at the provider', async () => {
    const { service, client, statement } = harness();
    const signedIn = new Date(Date.now() - 23 * 3_600_000);
    const issued = await service.issueStaffSession(client, assurance, event, provenance(signedIn));
    const session = statement('insert into auth.sessions')!;
    const end = signedIn.getTime() + DAY_MS;
    expect((session.values[9] as Date).getTime()).toBe(end);
    // The refresh window and the access token are cut to that end too.
    expect((session.values[8] as Date).getTime()).toBe(end);
    expect(issued.refreshExpiresAt.getTime()).toBe(end);
    expect(issued.expiresAt.getTime()).toBeLessThanOrEqual(end);
  });

  it('is refused once the sign-in at the provider has reached its absolute end', async () => {
    const { service, client, statements } = harness();
    await expect(service.issueStaffSession(client, assurance, event, provenance(new Date(Date.now() - DAY_MS))))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(statements.some(({ sql }) => sql.includes('insert into auth.sessions'))).toBe(false);
  });

  it('is today\'s staff session without single sign-on: no provenance, the same statements', async () => {
    const { service, client, statement, statements } = harness();
    const before = Date.now();
    const issued = await service.issueStaffSession(client, assurance, event);
    expect(statements.some(({ sql }) => sql.includes('session_single_sign_on'))).toBe(false);
    expect(statement('insert into auth.session_assurance')?.sql).toContain('clock_timestamp())');
    expect(statement('insert into auth.session_assurance')?.values).toHaveLength(4);
    expect((statement('insert into auth.sessions')!.values[9] as Date).getTime() - before)
      .toBeGreaterThanOrEqual(DAY_MS);
    expect(JSON.parse(String(statement('insert into auth.session_events')?.values[7])))
      .toEqual({ session_kind: 'staff', mfa_method: 'totp' });
    expect(issued.actor.sessionId).toEqual(expect.any(String));
  });
});

describe('a patient session issued after single sign-on', () => {
  const identity = { actorKind: 'patient' as const, subject: patient.subject, accountId: patient.accountId,
    displayName: '', facilities: [], authenticationMethod: 'local' as const };

  it('stores its provenance in the session\'s transaction and ends with the sign-in at the provider', async () => {
    const { service, statement } = harness();
    const signedIn = new Date(Date.now() - 23.5 * 3_600_000);
    const issued = await service.issue(identity, event, provenance(signedIn, 'web'));
    expect(statement('insert into auth.session_single_sign_on')?.values)
      .toEqual([issued.actor.sessionId, patient.accountId, 'web', 'provider-session-1', signedIn]);
    expect((statement('insert into auth.sessions')!.values[9] as Date).getTime()).toBe(signedIn.getTime() + DAY_MS);
    expect(JSON.parse(String(statement('insert into auth.session_events')?.values[7])))
      .toEqual({ password_upgraded: false, sso_client: 'web' });
  });

  it('is today\'s patient session without single sign-on', async () => {
    const { service, statement, statements } = harness();
    await service.issue(identity, event);
    expect(statements.some(({ sql }) => sql.includes('session_single_sign_on'))).toBe(false);
    expect(JSON.parse(String(statement('insert into auth.session_events')?.values[7]))).toEqual({ password_upgraded: false });
  });
});

describe('the patient recent-sign-in check', () => {
  const sqlOf = async () => {
    const query = jest.fn(async () => ({ rows: [{ recent: true }] }));
    await requireRecentPatientAuthentication({ query } as unknown as PoolClient, { ...patient,
      sessionId: '70000000-0000-4000-8000-0000000000f2' } as PatientSessionActor, 'detail');
    return String((query.mock.calls[0] as unknown[] | undefined)?.[0]).replace(/\s+/g, ' ');
  };

  it('counts a single sign-on family from the sign-in at the provider, not from the hand-off', async () => {
    Object.assign(process.env, {
      CORS_ORIGINS: 'https://app.sso-issue.invalid', AUTH_SSO_ISSUER: 'https://auth.sso-issue.invalid',
      AUTH_SSO_CLIENTS: JSON.stringify([{ client_id: 'web', host: 'app.sso-issue.invalid', kind: 'patient',
        token_endpoint_auth_method: 'client_secret_basic' }]),
      AUTH_SSO_CLIENT_CREDENTIALS: JSON.stringify({ web: { client_secret: 'synthetic-client-secret-0123456789abcdef' } }),
    });
    resetEnvironmentForTests();
    const sql = await sqlOf();
    expect(sql).toContain('least(min(family.issued_at), max(single_sign_on.authenticated_at))');
    expect(sql).toContain('left join auth.session_single_sign_on single_sign_on on single_sign_on.family_id = '
      + 'current_session.family_id');
    // The behaviour itself is run against PostgreSQL in sso-relying-party.integration.sql.
  });

  it('is today\'s statement, which reads no single sign-on table, while the settings are unset', async () => {
    expect(await sqlOf()).toBe('select coalesce(min(family.issued_at) >= clock_timestamp() - interval \'10 minutes\', '
      + 'false) as recent from auth.sessions current_session join auth.sessions family on family.family_id = '
      + 'current_session.family_id where current_session.id = $1 and current_session.account_id = $2 and '
      + 'current_session.patient_id = $3 and current_session.session_kind = \'patient\' and '
      + 'current_session.revoked_at is null');
  });
});
