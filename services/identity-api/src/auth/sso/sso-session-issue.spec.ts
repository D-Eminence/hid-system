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
import { useTestEnvironment } from '../../testing/sso-test-environment';
import { CurrentStaffContextService } from '../current-staff-context.service';
import { ProductNotAuthorisedProblem, type StaffProduct } from '../product-gate';
import { requireRecentPatientAuthentication, type PatientSessionActor } from '../recent-authentication';
import { CredentialsChangedDuringSignIn, TokenService, type SingleSignOnProvenance } from '../token.service';

/**
 * ADR-070 (0127): a product's session issued after single sign-on is today's
 * session (TokenService.issue, for staff as for patients: staff sign in with
 * a password only, owner decision Q92 B), with three differences that each
 * have a test that fails without them: its provenance (client, provider sid,
 * auth_time; never the ID token) is stored on the new family in the
 * session's own transaction; its absolute end counts from the provider's
 * auth_time, not from the hand-off; and a patient's recent-sign-in check
 * counts from that auth_time too. A staff session keeps the product of its
 * site (Q88): the gate and the product-bound refresh token. Without single
 * sign-on, nothing changes.
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
// The lab site's sign-in (SsoService.siteEvent): its product, as a password sign-in there.
const labEvent = { ...event, product: 'lab' as const };
const staffIdentity = { actorKind: 'staff' as const, subject: staff.subject, accountId: staff.accountId,
  displayName: '', facilities: [], authenticationMethod: 'local' as const };

useTestEnvironment();

function harness(realStaff?: CurrentStaffContextService) {
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
    realStaff ?? currentStaff as unknown as CurrentStaffContextService, currentPatient as never);
  const statement = (fragment: string) => statements.find(({ sql }) => sql.includes(fragment));
  return { service, client, statements, statement, currentStaff };
}

function provenance(authenticatedAt: Date, clientId = 'lab'): SingleSignOnProvenance {
  return { clientId, providerSid: 'provider-session-1', authenticatedAt };
}

describe('a staff session issued after single sign-on', () => {
  it('stores its provenance on the new family, in the session\'s own transaction', async () => {
    const { service, statement } = harness();
    const signedIn = new Date(Date.now() - 60_000);
    const issued = await service.issue(staffIdentity, labEvent, provenance(signedIn));
    const family = issued.actor.sessionId;
    expect(statement('insert into auth.session_single_sign_on')?.values)
      .toEqual([family, staff.accountId, 'lab', 'provider-session-1', signedIn]);
    // The ID token is never stored.
    expect(statement('insert into auth.session_single_sign_on')?.sql).not.toContain('id_token');
    // No second factor is recorded anywhere: production has none (Q92 B).
    expect(statement('session_assurance')).toBeUndefined();
    expect(JSON.parse(String(statement('insert into auth.session_events')?.values[7])))
      .toEqual({ password_upgraded: false, sso_client: 'lab' });
  });

  it('is gated by its site\'s product and gets a refresh token bound to it, as a password sign-in there', async () => {
    const { service, currentStaff } = harness();
    const issued = await service.issue(staffIdentity, labEvent, provenance(new Date(Date.now() - 60_000)));
    expect(currentStaff.resolve).toHaveBeenCalledWith(staff.subject, 'local', undefined, undefined, { product: 'lab' });
    expect(issued.refreshToken).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]+\.lab\.local$/);
  });

  it('ends no later than the absolute lifetime after the sign-in at the provider', async () => {
    const { service, statement } = harness();
    const signedIn = new Date(Date.now() - 23 * 3_600_000);
    const issued = await service.issue(staffIdentity, labEvent, provenance(signedIn));
    const session = statement('insert into auth.sessions')!;
    const end = signedIn.getTime() + DAY_MS;
    expect((session.values[9] as Date).getTime()).toBe(end);
    // The refresh window and the access token are cut to that end too.
    expect((session.values[8] as Date).getTime()).toBe(end);
    expect(issued.refreshExpiresAt.getTime()).toBe(end);
    expect(issued.expiresAt.getTime()).toBeLessThanOrEqual(end);
  });

  it('is refused once the sign-in at the provider has reached its absolute end', async () => {
    const { service, statements } = harness();
    await expect(service.issue(staffIdentity, labEvent, provenance(new Date(Date.now() - DAY_MS))))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(statements.some(({ sql }) => sql.includes('insert into auth.sessions'))).toBe(false);
  });

  it('is issued at the token version read with the password check, and refused at any other', async () => {
    // The harness's account is at token version 1.
    const { service, statement } = harness();
    await service.issue(staffIdentity, labEvent, { ...provenance(new Date(Date.now() - 60_000)), accountTokenVersion: 1 });
    expect(statement('insert into auth.sessions')).toBeDefined();
    // A password reset or recovery raised the version after the check (0029): nothing is issued.
    const changed = harness();
    await expect(changed.service.issue(staffIdentity, labEvent,
      { ...provenance(new Date(Date.now() - 60_000)), accountTokenVersion: 0 }))
      .rejects.toBeInstanceOf(CredentialsChangedDuringSignIn);
    expect(changed.statements.some(({ sql }) => sql.includes('insert into auth.sessions'))).toBe(false);
    expect(changed.statements.some(({ sql }) => sql.includes('session_single_sign_on'))).toBe(false);
  });

  it('is today\'s staff session without single sign-on: no provenance, the same statements', async () => {
    const { service, statement, statements } = harness();
    const before = Date.now();
    const issued = await service.issue(staffIdentity, labEvent);
    expect(statements.some(({ sql }) => sql.includes('session_single_sign_on'))).toBe(false);
    expect((statement('insert into auth.sessions')!.values[9] as Date).getTime() - before)
      .toBeGreaterThanOrEqual(DAY_MS);
    expect(JSON.parse(String(statement('insert into auth.session_events')?.values[7])))
      .toEqual({ password_upgraded: false });
    expect(issued.actor.sessionId).toEqual(expect.any(String));
  });
});

/**
 * The same gate as a password sign-in, through the real staff context
 * (current-staff-context.service.ts resolve) rather than a stand-in: a staff
 * session issued after single sign-on keeps only the memberships admitted on
 * its site (facilityAdmittedOnProduct: the Q88/Q90 rule, then Q97's own-job
 * rule) and carries actor.products, every site the login can open, exactly
 * as a password sign-in on that site does. Synthetic, fictional rows only.
 */
describe('the product gate of a staff session issued after single sign-on (Q88, Q90, Q97)', () => {
  const HOSPITAL = '10000000-0000-4000-8000-0000000000a1';
  const membership = (overrides: Record<string, unknown>) => ({
    account_id: staff.accountId, subject: staff.subject, email: 'sso-staff@example.invalid',
    display_name: 'Synthetic SSO Staff', facility_id: '30000000-0000-4000-8000-0000000000a1',
    membership_id: '40000000-0000-4000-8000-0000000000a1', organization_id: HOSPITAL,
    facility_name: 'Fictional General Hospital', facility_code: 'FGH', is_primary: true, ...overrides,
  });
  // A hospital doctor as the seeds grant it: its own ehr. code and the lab, pharmacy and outreach reading codes
  // for its own hospital work (0018, 0023, 0024, 0038), which Q97 does not let open those sites.
  const doctor = membership({ roles: ['doctor'], permissions: ['ehr.encounter.write', 'lab.work-item.read',
    'outreach.registration.read', 'pharmacy.work-item.read'] });
  // A laboratory scientist at a second, fictional laboratory organisation (Q90: recorded as a laboratory).
  const scientist = membership({ facility_id: '30000000-0000-4000-8000-0000000000b2',
    membership_id: '40000000-0000-4000-8000-0000000000b2', organization_id: '10000000-0000-4000-8000-0000000000b2',
    facility_name: 'Fictional Laboratory', facility_code: 'FLB', is_primary: false, roles: ['lab'],
    permissions: ['lab.result.enter', 'lab.specimen.receive', 'lab.work-item.accept', 'lab.work-item.read'],
    organization_kinds: ['laboratory'] });

  function gatedHarness(rows: Record<string, unknown>[]) {
    // The staff context's own reads: its memberships, then the platform authority (none here).
    const staffQuery = jest.fn(async (sql: string) => (String(sql).includes("assignment.scope_type = 'platform'")
      ? { rows: [{ roles: [], permissions: [] }], rowCount: 1 } : { rows, rowCount: rows.length }));
    return harness(new CurrentStaffContextService({ query: staffQuery } as unknown as DatabaseService));
  }
  const signIn = (rows: Record<string, unknown>[], product: StaffProduct) => gatedHarness(rows).service
    .issue(staffIdentity, { ...event, product }, provenance(new Date(Date.now() - 60_000), product));

  it.each(['lab', 'pharmacy', 'outreach'] as const)('refuses a hospital doctor on %s. (Q97), as a password sign-in there',
    async (product) => {
      const { service, statements } = gatedHarness([doctor]);
      await expect(service.issue(staffIdentity, { ...event, product }, provenance(new Date(Date.now() - 60_000), product)))
        .rejects.toBeInstanceOf(ProductNotAuthorisedProblem);
      expect(statements.some(({ sql }) => sql.includes('insert into auth.sessions'))).toBe(false);
      expect(statements.some(({ sql }) => sql.includes('session_single_sign_on'))).toBe(false);
    });

  it.each(['ehr', 'migrate'] as const)('admits a hospital doctor on %s. with actor.products set', async (product) => {
    const issued = await signIn([doctor], product);
    expect(issued.actor.products).toEqual(['ehr', 'migrate']);
    expect(issued.actor.facilities.map((facility) => facility.id)).toEqual([doctor.facility_id]);
    expect(issued.refreshToken).toMatch(new RegExp(`^[0-9a-f-]{36}\\.[A-Za-z0-9_-]+\\.${product}\\.local$`));
  });

  it('keeps only the memberships admitted on the site, and lists every site the login can open', async () => {
    const onLab = await signIn([doctor, scientist], 'lab');
    expect(onLab.actor.facilities.map((facility) => facility.id)).toEqual([scientist.facility_id]);
    expect(onLab.actor.products).toEqual(['ehr', 'lab', 'migrate']);
    const onEhr = await signIn([doctor, scientist], 'ehr');
    expect(onEhr.actor.facilities.map((facility) => facility.id)).toEqual([doctor.facility_id]);
    expect(onEhr.actor.products).toEqual(['ehr', 'lab', 'migrate']);
  });
});

describe('a patient session issued after single sign-on', () => {
  const identity = { actorKind: 'patient' as const, subject: patient.subject, accountId: patient.accountId,
    displayName: '', facilities: [], authenticationMethod: 'local' as const };

  it('stores its provenance in the session\'s transaction and ends with the sign-in at the provider', async () => {
    const { service, statement } = harness();
    // A patient sign-in lasts 30 days at most (AUTH_PATIENT_ABSOLUTE_TTL_SECONDS), counted from the provider.
    const signedIn = new Date(Date.now() - 29.5 * DAY_MS);
    const issued = await service.issue(identity, event, provenance(signedIn, 'web'));
    expect(statement('insert into auth.session_single_sign_on')?.values)
      .toEqual([issued.actor.sessionId, patient.accountId, 'web', 'provider-session-1', signedIn]);
    expect((statement('insert into auth.sessions')!.values[9] as Date).getTime()).toBe(signedIn.getTime() + 30 * DAY_MS);
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
  const SSO_STATEMENT = 'least(min(family.issued_at), max(single_sign_on.authenticated_at))';
  const TODAY = 'select coalesce(min(family.issued_at) >= clock_timestamp() - interval \'10 minutes\', '
    + 'false) as recent from auth.sessions current_session join auth.sessions family on family.family_id = '
    + 'current_session.family_id where current_session.id = $1 and current_session.account_id = $2 and '
    + 'current_session.patient_id = $3 and current_session.session_kind = \'patient\' and '
    + 'current_session.revoked_at is null';
  /** The statement the check sends on a database where 0127 is (or is not) applied. */
  const sqlOf = async (stored: boolean) => {
    const query = jest.fn(async (sql: string) => (sql.includes('to_regclass')
      ? { rows: [{ stored }] } : { rows: [{ recent: true }] }));
    await requireRecentPatientAuthentication({ query } as unknown as PoolClient, { ...patient,
      sessionId: '70000000-0000-4000-8000-0000000000f2' } as PatientSessionActor, 'detail');
    expect(String(query.mock.calls[0]?.[0])).toContain("to_regclass('auth.session_single_sign_on')");
    return String((query.mock.calls[1] as unknown[] | undefined)?.[0]).replace(/\s+/g, ' ');
  };
  const ssoSettings = {
    CORS_ORIGINS: 'https://app.sso-issue.invalid', AUTH_SSO_ISSUER: 'https://auth.sso-issue.invalid',
    AUTH_SSO_CLIENTS: JSON.stringify([{ client_id: 'web', host: 'app.sso-issue.invalid', kind: 'patient',
      token_endpoint_auth_method: 'client_secret_basic' }]),
    AUTH_SSO_CLIENT_CREDENTIALS: JSON.stringify({ web: { client_secret: 'synthetic-client-secret-0123456789abcdef' } }),
  };

  it('counts a single sign-on family from the sign-in at the provider, not from the hand-off', async () => {
    Object.assign(process.env, ssoSettings);
    resetEnvironmentForTests();
    const sql = await sqlOf(true);
    expect(sql).toContain(SSO_STATEMENT);
    expect(sql).toContain('left join auth.session_single_sign_on single_sign_on on single_sign_on.family_id = '
      + 'current_session.family_id');
    // The behaviour itself is run against PostgreSQL in sso-relying-party.integration.sql and verify-sso-runtime.mjs.
  });

  it('still counts from the provider sign-in after single sign-on is switched off, while 0127 is applied', async () => {
    // A family issued while single sign-on was on keeps its row: its hand-off must not become a fresh sign-in.
    for (const name of Object.keys(ssoSettings)) delete process.env[name];
    resetEnvironmentForTests();
    expect(await sqlOf(true)).toContain(SSO_STATEMENT);
  });

  it('is today\'s statement, which reads no single sign-on table, only on a database without 0127', async () => {
    Object.assign(process.env, ssoSettings);
    resetEnvironmentForTests();
    expect(await sqlOf(false)).toBe(TODAY);
  });

  it('fails closed: no answer is not recent', async () => {
    const query = jest.fn(async (sql: string) => (sql.includes('to_regclass') ? { rows: [{ stored: true }] } : { rows: [] }));
    await expect(requireRecentPatientAuthentication({ query } as unknown as PoolClient, { ...patient,
      sessionId: '70000000-0000-4000-8000-0000000000f2' } as PatientSessionActor, 'detail'))
      .rejects.toMatchObject({ code: 'PATIENT_RECENT_AUTH_REQUIRED' });
  });
});
