const signedClaims: Record<string, unknown>[] = [];
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
  SignJWT: class {
    constructor(payload: Record<string, unknown>) { signedClaims.push(payload); }
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

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpException, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { jwtVerify } from 'jose';
import type { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import type { AuthSessionAuditService } from './auth-session-audit.service';
import { CurrentStaffContextService, STAFF_CONTEXT_SQL, VERIFIED_STAFF_WITHOUT_MEMBERSHIP_SQL }
  from './current-staff-context.service';
import type { GoogleAuthenticationService } from './google-authentication.service';
import type { LocalAuthProvider } from './local-auth.provider';
import { ADMINISTRATOR_PERMISSIONS, administratorMembership, administratorProducts, facilityAdmittedOnProduct, facilityFitsProduct,
  HOSPITAL_PERMISSIONS, LAB_PERMISSIONS, organisationIsHospital, OUTREACH_PERMISSIONS, PHARMACY_PERMISSIONS, PRODUCT_HOSTS,
  productForOrigin, productPermissions, productsForFacilities, type StaffProduct } from './product-gate';
import { TokenService } from './token.service';
import type { TurnstileService } from './turnstile.service';
import type { WorkloadAuthService } from './workload-auth.service';

// Owner decision of 17 November 2026 (Q88): each staff product is its own
// site. A sign-in, a refresh and a facility choice keep only the memberships
// whose permissions fit the product of the request's Origin host; a verified
// staff login with no membership gets an account-only session on outreach.
// and 403 NO_ACTIVE_FACILITY_MEMBERSHIP elsewhere; neither 403 is a failed
// sign-in. Owner decisions Q90 and Q91 (17 November 2026): an administrator
// (organization.manage, or the administrator awaiting review) counts as a
// hospital role only at an organisation that is not recorded as a laboratory
// or a pharmacy (identity.organization_staff_kinds, 0126); otherwise it is
// admitted on lab. and/or pharmacy. as its organisation's kinds say.
//
// Owner decision Q97 ("Q97 A"): each staff site for its own job. Doctors,
// clinicians, nurses and receptionists (ehr.encounter.write without
// organization.manage) are admitted on ehr. and migrate. only; a hospital
// administrator (organization.manage, or the review-pending administrator)
// keeps every site; lab, pharmacy and outreach staff are unchanged. The
// session's actor.products lists the sites the login can open.

/**
 * auth.role_permissions as the migrations leave it: every (role, permission)
 * pair they insert, less every pair they delete (0136, owner decision Q103 A),
 * applied statement by statement in file order. A delete or update of the
 * table in any other form fails the test, so a later migration cannot change
 * the table without this model following it.
 */
function seededRolePermissions(): Map<string, Set<string>> {
  const directory = join(__dirname, '../../../ehr-api/database/migrations');
  const grants = new Map<string, Set<string>>();
  const statements = new RegExp(String.raw`insert into auth\.role_permissions\s*\([^)]*\)([\s\S]*?);`
    + String.raw`|delete from auth\.role_permissions\s+where\s*\(\s*role_code\s*,\s*permission_code\s*\)\s*in\s*\(([\s\S]*?)\)\s*;`,
  'gi');
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
    const text = readFileSync(join(directory, file), 'utf8');
    const deletes = text.match(/delete from auth\.role_permissions/gi)?.length ?? 0;
    const updates = text.match(/update auth\.role_permissions/gi)?.length ?? 0;
    let deletesRead = 0;
    for (const statement of text.matchAll(statements)) {
      const removing = statement[2] !== undefined;
      if (removing) deletesRead += 1;
      for (const pair of (statement[1] ?? statement[2] ?? '').matchAll(/\(\s*'([a-z_]+)'\s*,\s*'([a-z0-9.-]+)'\s*\)/g)) {
        const [, role, permission] = pair as unknown as [string, string, string];
        const set = grants.get(role) ?? new Set<string>();
        if (removing) set.delete(permission); else set.add(permission);
        grants.set(role, set);
      }
    }
    if (deletesRead !== deletes || updates > 0) {
      throw new Error(`${file} changes auth.role_permissions in a form this model does not read`);
    }
  }
  return grants;
}

const SEEDS = seededRolePermissions();
const permissionsOf = (role: string) => [...(SEEDS.get(role) ?? [])].sort();

const PROD = (product: StaffProduct) => `https://${product}.healthidentitydirectory.com`;
const STAGING = (product: StaffProduct) => `https://${product}.staging.healthidentitydirectory.com`;
const ADMIN = 'https://admin.healthidentitydirectory.com';
const LOCAL = 'http://localhost:5173';
const PRODUCTS: StaffProduct[] = ['ehr', 'lab', 'pharmacy', 'migrate', 'outreach'];

// Each place with the kinds and products identity.organization_staff_kinds
// (0126) answers for it: QA Hospital has no application (no kind, Q91 A: a
// hospital) and no product, QA Laboratory and QA Pharmacy one governed
// application and product each (0123).
const HOSPITAL = { organization: '30000000-0000-4000-8000-000000000001', facility: '10000000-0000-4000-8000-000000000001',
  name: 'QA Hospital', kinds: [], products: [] };
const LABORATORY = { organization: '30000000-0000-4000-8000-000000000002', facility: '10000000-0000-4000-8000-000000000002',
  name: 'QA Laboratory', kinds: ['laboratory'], products: ['laboratory'] };
const PHARMACY = { organization: '30000000-0000-4000-8000-000000000003', facility: '10000000-0000-4000-8000-000000000003',
  name: 'QA Pharmacy', kinds: ['pharmacy'], products: ['pharmacy'] };
const OUTREACH_GROUP = { organization: '30000000-0000-4000-8000-000000000004',
  facility: '10000000-0000-4000-8000-000000000004', name: 'QA Outreach', kinds: [], products: [] };
const CLINIC = { organization: '30000000-0000-4000-8000-000000000005', facility: '10000000-0000-4000-8000-000000000005',
  name: 'New Clinic', kinds: ['clinic'], products: ['ehr'] };

interface Place { organization: string; facility: string; name: string; kinds: string[]; products: string[] }
interface Account {
  key: string;
  subject: string;
  accountId: string;
  memberships: Record<string, unknown>[];
  platform?: { roles: string[]; permissions: string[] };
  eligibility?: { verified_staff: boolean; platform_role: boolean; sealed_demo: boolean };
}

let accountCounter = 0;
function membership(place: Place, role: string, options: { primary?: boolean; permissionsRole?: string;
  review?: string; organizationType?: string; kinds?: string[]; products?: string[] } = {}) {
  accountCounter += 1;
  return {
    facility_id: place.facility,
    membership_id: `40000000-0000-4000-8000-${String(accountCounter).padStart(12, '0')}`,
    organization_id: place.organization,
    facility_name: place.name,
    facility_code: null,
    roles: [role],
    permissions: permissionsOf(options.permissionsRole ?? role),
    is_primary: options.primary ?? true,
    review_state: options.review ?? null,
    organization_type: options.organizationType ?? null,
    organization_kinds: options.kinds ?? place.kinds,
    organization_products: options.products ?? place.products,
  };
}

function account(key: string, memberships: Record<string, unknown>[], extra: Partial<Account> = {}): Account {
  accountCounter += 1;
  const id = `20000000-0000-4000-8000-${String(accountCounter).padStart(12, '0')}`;
  return { key, subject: `staff:${key}`, accountId: id, memberships, ...extra };
}

const ELIGIBLE = { verified_staff: true, platform_role: false, sealed_demo: false };

const accounts = {
  doctor: account('doctor', [membership(HOSPITAL, 'doctor')]),
  clinician: account('clinician', [membership(HOSPITAL, 'clinician')]),
  nurse: account('nurse', [membership(HOSPITAL, 'nurse')]),
  receptionist: account('receptionist', [membership(HOSPITAL, 'receptionist')]),
  admin: account('admin', [membership(HOSPITAL, 'admin')]),
  orgAdmin: account('org-admin', [membership(HOSPITAL, 'org_admin'), membership(LABORATORY, 'org_admin', { primary: false }),
    membership(PHARMACY, 'org_admin', { primary: false })]),
  lab: account('lab', [membership(LABORATORY, 'lab')]),
  labSecondChecker: account('lab-second-checker', [membership(LABORATORY, 'lab')]),
  pharmacist: account('pharmacist', [membership(PHARMACY, 'pharmacist')]),
  organiser: account('outreach-organiser', [membership(OUTREACH_GROUP, 'outreach_organiser')]),
  volunteer: account('outreach-volunteer', [membership(OUTREACH_GROUP, 'outreach_volunteer')]),
  noMembership: account('no-membership', [], { eligibility: ELIGIBLE }),
  platformAdmin: account('platform-admin', [], { platform: { roles: ['platform_super_admin'],
    permissions: permissionsOf('platform_super_admin') }, eligibility: { ...ELIGIBLE, platform_role: true } }),
  pendingReview: account('pending-review', [membership(CLINIC, 'org_admin', { permissionsRole: 'org_admin_awaiting_review',
    review: 'pending', organizationType: 'clinic' })]),
  labAndVolunteer: account('lab-and-volunteer', [membership(LABORATORY, 'lab'),
    membership(OUTREACH_GROUP, 'outreach_volunteer', { primary: false })]),
  doctorAndVolunteer: account('doctor-and-volunteer', [membership(HOSPITAL, 'doctor'),
    membership(OUTREACH_GROUP, 'outreach_volunteer', { primary: false })]),
  noMembershipPatient: account('patient', [], { eligibility: { verified_staff: false, platform_role: false, sealed_demo: false } }),
  noMembershipDemo: account('demo', [], { eligibility: { ...ELIGIBLE, sealed_demo: true } }),
  noMembershipPlatformRole: account('platform-role-without-access', [],
    { eligibility: { ...ELIGIBLE, platform_role: true } }),
};

function fakeDatabase(people: Account[], refreshFor?: Account) {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const bySubject = (subject: unknown) => people.find((candidate) => candidate.subject === subject);
  const byId = (id: unknown) => people.find((candidate) => candidate.accountId === id);
  const rows = (list: unknown[]) => ({ rows: list, rowCount: list.length });
  const answer = async (sql: string, values: readonly unknown[] = []) => {
    calls.push({ sql, values });
    if (sql === STAFF_CONTEXT_SQL) return rows(bySubject(values[0])?.memberships.map((row) => ({ ...row,
      account_id: bySubject(values[0])?.accountId, subject: values[0], email: `${bySubject(values[0])?.key}@example.test`,
      display_name: 'Staff' })) ?? []);
    if (sql.includes('select id::text, email, display_name from auth.accounts')) {
      const found = bySubject(values[0]);
      return rows(found ? [{ id: found.accountId, email: `${found.key}@example.test`, display_name: 'Staff' }] : []);
    }
    if (sql.includes("assignment.scope_type = 'platform'") && sql.includes('array_agg(distinct role.code)')) {
      return rows([byId(values[0])?.platform ?? { roles: [], permissions: [] }]);
    }
    if (sql === VERIFIED_STAFF_WITHOUT_MEMBERSHIP_SQL) {
      return rows([byId(values[0])?.eligibility ?? { verified_staff: false, platform_role: false, sealed_demo: false }]);
    }
    if (sql.includes('select token_version::text from auth.accounts')) return rows([{ token_version: '1' }]);
    if (sql.includes('session.refresh_token_sha256 = $1') && refreshFor) {
      const now = Date.now();
      return rows([{ id: '90000000-0000-4000-8000-000000000001', account_id: refreshFor.accountId,
        actor_subject: refreshFor.subject, family_id: '90000000-0000-4000-8000-000000000001',
        access_jti: '90000000-0000-4000-8000-000000000002', token_version: '1', authentication_method: 'password',
        session_kind: 'staff', patient_id: null, expires_at: new Date(now + 3_600_000),
        absolute_expires_at: new Date(now + 7_200_000), revoked_at: null }]);
    }
    if (sql.includes('session.access_jti = $3')) return { rows: [{}], rowCount: 1 };
    if (sql.includes("revocation_reason = 'rotated'")) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const database = {
    query: jest.fn(answer),
    withSystemTransaction: jest.fn(async (_correlation: string, work: (client: unknown) => Promise<unknown>) =>
      work({ query: jest.fn(answer) })),
  };
  return { calls, database: database as unknown as DatabaseService };
}

const WRONG = 'wrong-password';

function harness(people: Account[] = Object.values(accounts), refreshFor?: Account) {
  const { calls, database } = fakeDatabase(people, refreshFor);
  const staffContext = new CurrentStaffContextService(database);
  const tokens = new TokenService(database, staffContext);
  const localProvider = {
    authenticate: jest.fn(async (email: string, password: string) => {
      const found = people.find((candidate) => `${candidate.key}@example.test` === email);
      if (!found || password === WRONG) throw new UnauthorizedException('Invalid credentials');
      return { subject: found.subject, accountId: found.accountId, email, displayName: 'Staff', facilities: [],
        authenticationMethod: 'local' as const };
    }),
    principalHash: jest.fn(() => 'a'.repeat(64)),
  };
  const auth = new AuthService(localProvider as unknown as LocalAuthProvider, tokens);
  const sessionAudit = { record: jest.fn(async () => undefined), recordLoginFailure: jest.fn(async () => undefined) };
  const audit = { record: jest.fn(async () => undefined) };
  const controller = new AuthController(auth, tokens, sessionAudit as unknown as AuthSessionAuditService,
    audit as unknown as AuditService, {} as WorkloadAuthService,
    { verifyLogin: jest.fn(async () => undefined) } as unknown as TurnstileService, {} as GoogleAuthenticationService);
  return { controller, tokens, staffContext, sessionAudit, audit, calls, localProvider };
}

function request(origin: string, extra: Partial<HidRequest> = {}, headers: Record<string, string> = {}): HidRequest {
  const all: Record<string, string> = { origin, 'user-agent': 'product-gate-spec', ...headers };
  return { correlationId: 'product-gate-spec', ip: '203.0.113.20', method: 'POST', cookies: {},
    header: (name: string) => all[name.toLowerCase()], ...extra } as unknown as HidRequest;
}

function response() {
  return { cookie: jest.fn(), clearCookie: jest.fn(), setHeader: jest.fn(), status: jest.fn() } as unknown as Response;
}

const login = (who: Account, password = 'right-password') =>
  ({ email: `${who.key}@example.test`, password, turnstileAction: 'staff-login' as const });

async function refusal(promise: Promise<unknown>): Promise<HttpException> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(HttpException);
  return error as HttpException;
}

const ALL_ORIGINS = [...PRODUCTS.map(PROD), ...PRODUCTS.map(STAGING), ADMIN, LOCAL].join(',');
const originalEnvironment = { ...process.env };

beforeEach(() => {
  signedClaims.length = 0;
  Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5432/hid',
    DATABASE_SSL: 'false', CORS_ORIGINS: ALL_ORIGINS, AUTH_MODE: 'local',
    AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
    AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters', AUTH_COOKIE_NAME: 'hid_access',
    AUTH_COOKIE_SECURE: 'false', TURNSTILE_MODE: 'disabled' });
  resetEnvironmentForTests();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
  resetEnvironmentForTests();
  jest.mocked(jwtVerify).mockReset();
});

describe('the product of a request (Origin host, exactly as turnstile.service.ts names the sites)', () => {
  it.each(PRODUCTS)('%s: the production and staging hosts', (product) => {
    expect(productForOrigin(PROD(product))).toBe(product);
    expect(productForOrigin(STAGING(product))).toBe(product);
  });

  it('names exactly the ten product hosts', () => {
    expect(Object.keys(PRODUCT_HOSTS).sort()).toEqual([...PRODUCTS.map(PROD), ...PRODUCTS.map(STAGING)]
      .map((origin) => new URL(origin).hostname).sort());
  });

  it.each([
    undefined, '', 'null', ADMIN, 'https://app.healthidentitydirectory.com', 'https://www.healthidentitydirectory.com',
    'https://healthidentitydirectory.com', 'https://staging.healthidentitydirectory.com', LOCAL,
    'http://ehr.healthidentitydirectory.com', 'https://ehr.healthidentitydirectory.com:8443',
    'https://ehr.healthidentitydirectory.com/', 'https://ehr.healthidentitydirectory.com.example.test',
    'https://pr-12.ehr.healthidentitydirectory.com', 'https://user@ehr.healthidentitydirectory.com', 'not a url',
  ])('%p has no product (today\'s behaviour)', (origin) => {
    expect(productForOrigin(origin)).toBeUndefined();
  });
});

describe('the permission codes the gate reads are the database seeds\' (auth.role_permissions)', () => {
  // After 0136 (Q103 A): doctors and administrators hold neither work list,
  // and doctors hold no Outreach code.
  it('every code is granted by the seeds, to the roles the owner named', () => {
    const holders = (code: string) => [...SEEDS.entries()].filter(([, set]) => set.has(code)).map(([role]) => role).sort();
    expect(holders('ehr.encounter.write')).toEqual(['clinician', 'doctor', 'nurse', 'receptionist']);
    expect(holders('organization.manage')).toEqual(['admin', 'org_admin']);
    expect(holders('lab.work-item.read')).toEqual(['clinician', 'lab', 'nurse']);
    expect(holders('lab.work-item.accept')).toEqual(['clinician', 'doctor', 'lab', 'nurse']);
    expect(holders('pharmacy.work-item.read')).toEqual(['clinician', 'nurse', 'pharmacist']);
    expect(holders('pharmacy.dispensing.read')).toEqual(['admin', 'clinician', 'doctor', 'nurse', 'pharmacist']);
    expect(holders('outreach.registration.read')).toEqual(['admin', 'clinician', 'nurse', 'org_admin',
      'org_admin_awaiting_review', 'outreach_organiser', 'outreach_volunteer', 'receptionist']);
    expect(holders('outreach.campaign.read')).toEqual(['admin', 'clinician', 'nurse', 'org_admin',
      'org_admin_awaiting_review', 'outreach_organiser', 'outreach_volunteer', 'receptionist']);
    // Q111 A: doctors keep ocr.job.write (checking readings, confirming their
    // patient); starting a reading also needs ocr.job.start, which they lack.
    expect(holders('ocr.job.write')).toEqual(['clinician', 'doctor', 'nurse', 'receptionist']);
    expect(holders('ocr.job.start')).toEqual(['clinician', 'nurse', 'receptionist']);
    // Q112 A: only the front desk holds the "own uploads" reads, and it holds
    // neither full read.
    expect(holders('ehr.document.read-own')).toEqual(['receptionist']);
    expect(holders('ocr.job.read-own')).toEqual(['receptionist']);
    expect(holders('ehr.document.read')).toEqual(['clinician', 'doctor', 'lab', 'nurse']);
    expect(holders('ocr.job.read')).toEqual(['admin', 'clinician', 'doctor', 'nurse']);
  });

  it('admits by exactly these codes on each site (Q97: lab., pharmacy. and outreach. take organization.manage, not ehr.encounter.write)', () => {
    expect(HOSPITAL_PERMISSIONS).toEqual(['ehr.encounter.write', 'organization.manage']);
    expect(ADMINISTRATOR_PERMISSIONS).toEqual(['organization.manage']);
    expect(LAB_PERMISSIONS).toEqual(['lab.work-item.read', 'lab.work-item.accept']);
    expect(PHARMACY_PERMISSIONS).toEqual(['pharmacy.work-item.read', 'pharmacy.dispensing.read']);
    expect(OUTREACH_PERMISSIONS).toEqual(['outreach.registration.read', 'outreach.campaign.read']);
    expect(productPermissions('ehr')).toEqual(['ehr.encounter.write', 'organization.manage']);
    expect(productPermissions('migrate')).toEqual(['ehr.encounter.write', 'organization.manage']);
    expect(productPermissions('lab')).toEqual(['lab.work-item.read', 'lab.work-item.accept', 'organization.manage']);
    expect(productPermissions('pharmacy')).toEqual(['pharmacy.work-item.read', 'pharmacy.dispensing.read',
      'organization.manage']);
    expect(productPermissions('outreach')).toEqual(['outreach.registration.read', 'outreach.campaign.read',
      'organization.manage']);
  });

  const assignment = (roles: string[], permissions: string[]) => ({ id: HOSPITAL.facility, membershipId: 'm',
    organizationId: HOSPITAL.organization, name: HOSPITAL.name, roles, permissions, isPrimary: true });

  // The seeds also grant the hospital clinical roles the lab, pharmacy and
  // outreach reading codes (0018, 0023, 0024, 0038) for their own hospital
  // work; Q97 refuses them on those sites all the same. Since 0136 (Q103 A)
  // doctors hold no Outreach code and no work list, but still hold
  // lab.work-item.accept and pharmacy.dispensing.read.
  it.each([
    ['doctor', 'lab.work-item.accept'], ['clinician', 'outreach.registration.read'],
    ['nurse', 'outreach.registration.read'], ['receptionist', 'outreach.registration.read'],
  ])('a %s membership holds a reading code another site names (%s), and fits ehr. and migrate. only', (role, code) => {
      const permissions = permissionsOf(role);
      expect(permissions).toContain('ehr.encounter.write');
      expect(permissions).not.toContain('organization.manage');
      expect(permissions).toContain(code);
      const facility = assignment([role], permissions);
      expect(PRODUCTS.filter((product) => facilityAdmittedOnProduct(facility, product))).toEqual(['ehr', 'migrate']);
    });

  it('a membership holding both ehr.encounter.write and organization.manage (doctor and admin) fits every site', () => {
    const facility = assignment(['admin', 'doctor'], [...new Set([...permissionsOf('admin'), ...permissionsOf('doctor')])]);
    expect(PRODUCTS.filter((product) => facilityAdmittedOnProduct(facility, product))).toEqual(PRODUCTS);
  });

  it.each(['admin', 'org_admin'])('a hospital %s membership fits every site', (role) => {
    const facility = assignment([role], permissionsOf(role));
    expect(PRODUCTS.filter((product) => facilityAdmittedOnProduct(facility, product))).toEqual(PRODUCTS);
  });

  it.each([
    ['lab', ['lab']], ['pharmacist', ['pharmacy']], ['outreach_organiser', ['outreach']], ['outreach_volunteer', ['outreach']],
  ] as const)('a %s membership fits %j only (unchanged)', (role, expected) => {
    const facility = assignment([role], permissionsOf(role));
    expect(PRODUCTS.filter((product) => facilityAdmittedOnProduct(facility, product))).toEqual(expected);
  });

  it('productsForFacilities lists every site any membership fits, in site order', () => {
    expect(productsForFacilities([])).toEqual([]);
    expect(productsForFacilities([assignment(['outreach_volunteer'], permissionsOf('outreach_volunteer')),
      assignment(['doctor'], permissionsOf('doctor'))])).toEqual(['ehr', 'migrate', 'outreach']);
    expect(productsForFacilities([assignment(['pharmacist'], permissionsOf('pharmacist')),
      assignment(['lab'], permissionsOf('lab'))])).toEqual(['lab', 'pharmacy']);
  });

  it('lab staff hold no ocr.job.* code since 0136 (Q103 A) and are still not admitted on migrate', () => {
    expect(permissionsOf('lab').filter((code) => code.startsWith('ocr.'))).toEqual([]);
    expect(permissionsOf('lab')).not.toContain('ehr.encounter.read');
    expect(permissionsOf('lab')).toEqual(expect.arrayContaining(['lab.work-item.read', 'lab.work-item.accept']));
    const facility = { id: LABORATORY.facility, membershipId: 'm', organizationId: LABORATORY.organization,
      name: LABORATORY.name, roles: ['lab'], permissions: permissionsOf('lab'), isPrimary: true };
    expect(facilityFitsProduct(facility, 'migrate')).toBe(false);
    expect(PRODUCTS.filter((product) => facilityFitsProduct(facility, product))).toEqual(['lab']);
  });

  // 0136 (owner decision Q103 A): the model reads 0136's DELETE as well as
  // every INSERT, so these are the sets the roles hold in production after it.
  it('the front desk holds the six 0136 codes and still fits ehr. and migrate. only', () => {
    const permissions = permissionsOf('receptionist');
    expect(permissions).toEqual(expect.arrayContaining(['ehr.document.write', 'ehr.document.read-own', 'ocr.job.write',
      'ocr.job.start', 'ocr.job.read-own', 'ehr.vital.read']));
    for (const code of ['ehr.document.read', 'ocr.job.read', 'ocr.validation.write', 'ocr.patient.confirm',
      'ocr.publication.write', 'ehr.note.read', 'ehr.diagnosis.read', 'ehr.prescription.read', 'ehr.lab-request.read']) {
      expect(permissions).not.toContain(code);
    }
    const facility = assignment(['receptionist'], permissions);
    expect(PRODUCTS.filter((product) => facilityAdmittedOnProduct(facility, product))).toEqual(['ehr', 'migrate']);
  });

  it('doctors and administrators lose the 0136 rows; the kept rows stay (doctors keep checking, Q111 A)', () => {
    const doctor = permissionsOf('doctor');
    for (const code of ['ocr.job.start', 'outreach.campaign.read', 'outreach.campaign.write', 'outreach.registration.read',
      'outreach.registration.write', 'lab.work-item.read', 'pharmacy.work-item.read']) {
      expect(doctor).not.toContain(code);
    }
    expect(doctor).toEqual(expect.arrayContaining(['ocr.job.write', 'ocr.job.read', 'ocr.validation.write',
      'ocr.patient.confirm', 'ocr.publication.write', 'lab.work-item.accept', 'ehr.lab-request.read',
      'ehr.prescription.read', 'lab.result.released.read']));
    const admin = permissionsOf('admin');
    expect(admin).not.toContain('lab.work-item.read');
    expect(admin).not.toContain('pharmacy.work-item.read');
    expect(admin).toEqual(expect.arrayContaining(['identity.registration.approve', 'organization.manage',
      'workforce.manage', 'audit.read']));
    expect(permissionsOf('nurse')).toEqual(expect.arrayContaining(['ehr.note.write', 'ocr.job.write', 'ocr.job.start',
      'ocr.validation.write', 'lab.work-item.read', 'pharmacy.work-item.read']));
    // A doctor membership is still a hospital clinical membership: ehr. and migrate. only.
    expect(PRODUCTS.filter((product) => facilityAdmittedOnProduct(assignment(['doctor'], doctor), product)))
      .toEqual(['ehr', 'migrate']);
    // A hospital administrator still opens every site through organization.manage.
    expect(PRODUCTS.filter((product) => facilityAdmittedOnProduct(assignment(['admin'], admin), product)))
      .toEqual(PRODUCTS);
  });
});

type Expectation = 'session' | 'PRODUCT_NOT_AUTHORISED' | 'NO_ACTIVE_FACILITY_MEMBERSHIP' | 'account-only';
const ALL_SESSION: Record<StaffProduct, Expectation> = { ehr: 'session', lab: 'session', pharmacy: 'session',
  migrate: 'session', outreach: 'session' };
const only = (...products: StaffProduct[]): Record<StaffProduct, Expectation> => Object.fromEntries(PRODUCTS.map(
  (product) => [product, products.includes(product) ? 'session' : 'PRODUCT_NOT_AUTHORISED'])) as Record<StaffProduct, Expectation>;

const MATRIX: [string, Account, Record<StaffProduct, Expectation>][] = [
  // Q97: the hospital clinical roles are refused on lab., pharmacy. and outreach.
  ['doctor', accounts.doctor, only('ehr', 'migrate')],
  ['clinician', accounts.clinician, only('ehr', 'migrate')],
  ['nurse', accounts.nurse, only('ehr', 'migrate')],
  ['receptionist', accounts.receptionist, only('ehr', 'migrate')],
  ['facility admin (admin)', accounts.admin, ALL_SESSION],
  ['organization admin (org_admin)', accounts.orgAdmin, ALL_SESSION],
  ['administrator of a facility awaiting review', accounts.pendingReview, ALL_SESSION],
  ['lab', accounts.lab, only('lab')],
  ['lab second checker', accounts.labSecondChecker, only('lab')],
  ['pharmacist', accounts.pharmacist, only('pharmacy')],
  ['outreach organiser', accounts.organiser, only('outreach')],
  ['outreach volunteer', accounts.volunteer, only('outreach')],
  ['verified staff with no membership', accounts.noMembership, { ehr: 'NO_ACTIVE_FACILITY_MEMBERSHIP',
    lab: 'NO_ACTIVE_FACILITY_MEMBERSHIP', pharmacy: 'NO_ACTIVE_FACILITY_MEMBERSHIP',
    migrate: 'NO_ACTIVE_FACILITY_MEMBERSHIP', outreach: 'account-only' }],
  ['platform admin with no membership', accounts.platformAdmin, only()],
  ['lab and outreach volunteer', accounts.labAndVolunteer, only('lab', 'outreach')],
  ['doctor and outreach volunteer', accounts.doctorAndVolunteer, only('ehr', 'migrate', 'outreach')],
];

/** The sites a row of MATRIX can open: actor.products (Q97). */
const productsOf = (expected: Record<StaffProduct, Expectation>) =>
  PRODUCTS.filter((product) => expected[product] === 'session' || expected[product] === 'account-only');
const expectedFor = (who: Account) => MATRIX.find(([, row]) => row === who)![2];

describe('POST /auth/login on each product site (Q88-1, Q88-2)', () => {
  const cases = MATRIX.flatMap(([label, who, expected]) => PRODUCTS.flatMap((product) =>
    [PROD(product), STAGING(product)].map((origin) => [label, origin, who, expected[product]] as const)));

  it.each(cases)('%s on %s', async (_label, origin, who, expected) => {
    const { controller, sessionAudit, audit, calls } = harness();
    const attempt = controller.login(login(who), request(origin), response());
    if (expected === 'session' || expected === 'account-only') {
      const answer = await attempt;
      const product = productForOrigin(origin)!;
      // The session holds only facilities that fit this site's product.
      for (const facility of answer.actor.facilities) expect(facilityAdmittedOnProduct(facility, product)).toBe(true);
      expect(answer.actor.facilityIds).toEqual(answer.actor.facilities.map((facility) => facility.id));
      if (expected === 'account-only') {
        expect(answer.actor).toMatchObject({ accountOnly: true, facilities: [], facilityIds: [], permissions: [],
          roles: [] });
        expect(answer.actor.facility).toBeUndefined();
      } else {
        expect(answer.actor.facilities.length).toBeGreaterThan(0);
        expect(answer.actor.accountOnly).toBeUndefined();
      }
      // The access token carries the product, so every later request keeps the gate.
      expect(signedClaims.at(-1)).toMatchObject({ product });
      // Q97: every site this login can open, the same on every site it signs in on.
      expect(answer.actor.products).toEqual(productsOf(expectedFor(who)));
      expect(answer.actor.products).toContain(product);
      expect(sessionAudit.recordLoginFailure).not.toHaveBeenCalled();
      return;
    }
    const error = await refusal(attempt);
    expect(error).toBeInstanceOf(DomainProblem);
    expect([error.getStatus(), (error as DomainProblem).code]).toEqual([403, expected]);
    expect(error.message).toBe(expected === 'PRODUCT_NOT_AUTHORISED'
      ? "This account isn't set up for this Health ID product."
      : "You aren't part of a facility or outreach group yet.");
    if (expected === 'PRODUCT_NOT_AUTHORISED') {
      expect((error as DomainProblem).extensions).toEqual({ product: productForOrigin(origin) });
    }
    // Not a failed sign-in: no lockout count, no login_failed row, no session.
    expect(sessionAudit.recordLoginFailure).not.toHaveBeenCalled();
    expect(sessionAudit.record).not.toHaveBeenCalled();
    expect(calls.some(({ sql }) => sql.includes('auth.login_attempts'))).toBe(false);
    expect(calls.some(({ sql }) => sql.includes('insert into auth.sessions'))).toBe(false);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'staff', actorSubject: who.subject,
      action: 'auth.login.refused', resourceType: 'authentication', outcome: 'denied',
      details: { reason: expected.toLowerCase(), product: productForOrigin(origin) } }));
  });

  it('keeps only the fitting facilities of an account with several (lab and outreach volunteer)', async () => {
    const { controller } = harness();
    const ids = async (origin: string) => (await controller.login(login(accounts.labAndVolunteer), request(origin),
      response())).actor.facilities.map((facility) => facility.id);
    await expect(ids(PROD('lab'))).resolves.toEqual([LABORATORY.facility]);
    await expect(ids(PROD('outreach'))).resolves.toEqual([OUTREACH_GROUP.facility]);
    const ehr = await refusal(controller.login(login(accounts.labAndVolunteer), request(PROD('ehr')), response()));
    expect((ehr as DomainProblem).code).toBe('PRODUCT_NOT_AUTHORISED');
    // The selected facility is always one of the kept ones, even when the primary is not.
    const outreach = await controller.login(login(accounts.labAndVolunteer), request(PROD('outreach')), response());
    expect(outreach.actor.facility?.id).toBe(OUTREACH_GROUP.facility);
    expect(outreach.actor.permissions).toEqual(permissionsOf('outreach_volunteer'));
  });

  // Owner decisions Q90 ("Q90 A since its the best option that gives each
  // product seperate environment") and Q91 ("Q91 A"), 17 November 2026: an
  // administrator counts as a hospital role only at an organisation not
  // recorded as a laboratory or a pharmacy.
  describe('an administrator\'s sites follow its organisation\'s recorded kinds (Q90, Q91)', () => {
    const ids = (answer: { actor: ActorContext }) => answer.actor.facilities.map((facility) => facility.id).sort();

    it.each([
      ['ehr', [HOSPITAL.facility]],
      ['migrate', [HOSPITAL.facility]],
      ['outreach', [HOSPITAL.facility]],
      ['lab', [HOSPITAL.facility, LABORATORY.facility]],
      ['pharmacy', [HOSPITAL.facility, PHARMACY.facility]],
    ] as const)('admin@ (org_admin at QA Hospital, QA Laboratory and QA Pharmacy, as 0123 seeds it) on %s.',
      async (product, expected) => {
        const { controller } = harness();
        const answer = await controller.login(login(accounts.orgAdmin), request(PROD(product)), response());
        expect(ids(answer)).toEqual([...expected].sort());
        expect(answer.actor.facility?.id).toBe(HOSPITAL.facility);
      });

    it.each(PRODUCTS)('the org_admin of a lab-only organisation is admitted on lab. only (%s.)', async (product) => {
      const labOnlyAdmin = account('lab-only-org-admin', [membership(LABORATORY, 'org_admin')]);
      const { controller } = harness([labOnlyAdmin]);
      const attempt = controller.login(login(labOnlyAdmin), request(PROD(product)), response());
      if (product === 'lab') {
        expect((await attempt).actor.facilityIds).toEqual([LABORATORY.facility]);
        return;
      }
      // org_admin also holds the outreach reads (0115) and is still not admitted on outreach.
      const error = await refusal(attempt);
      expect([error.getStatus(), (error as DomainProblem).code]).toEqual([403, 'PRODUCT_NOT_AUTHORISED']);
    });

    it.each(PRODUCTS)('the org_admin of a pharmacy-only organisation is admitted on pharmacy. only (%s.)', async (product) => {
      const pharmacyOnlyAdmin = account('pharmacy-only-org-admin', [membership(PHARMACY, 'org_admin')]);
      const { controller } = harness([pharmacyOnlyAdmin]);
      const attempt = controller.login(login(pharmacyOnlyAdmin), request(PROD(product)), response());
      if (product === 'pharmacy') {
        expect((await attempt).actor.facilityIds).toEqual([PHARMACY.facility]);
        return;
      }
      const error = await refusal(attempt);
      expect([error.getStatus(), (error as DomainProblem).code]).toEqual([403, 'PRODUCT_NOT_AUTHORISED']);
    });

    it.each(PRODUCTS)('a facility admin (admin) of a lab-only organisation is admitted on lab. only (%s.), '
      + 'although admin also reads pharmacy work (0023)', async (product) => {
      const labOnlyAdmin = account('lab-only-admin', [membership(LABORATORY, 'admin')]);
      const { controller } = harness([labOnlyAdmin]);
      const attempt = controller.login(login(labOnlyAdmin), request(PROD(product)), response());
      if (product === 'lab') {
        expect((await attempt).actor.facilityIds).toEqual([LABORATORY.facility]);
        return;
      }
      expect(((await refusal(attempt)) as DomainProblem).code).toBe('PRODUCT_NOT_AUTHORISED');
    });

    const BOTH = { ...LABORATORY, name: 'Lab And Pharmacy', kinds: ['laboratory', 'pharmacy'] };
    it.each(PRODUCTS)('the org_admin of an organisation recorded as a laboratory and a pharmacy: lab. and pharmacy. (%s.)',
      async (product) => {
        const bothAdmin = account('lab-and-pharmacy-org-admin', [membership(BOTH, 'org_admin')]);
        const { controller } = harness([bothAdmin]);
        const attempt = controller.login(login(bothAdmin), request(PROD(product)), response());
        if (product === 'lab' || product === 'pharmacy') {
          expect((await attempt).actor.facilityIds).toEqual([BOTH.facility]);
          return;
        }
        expect(((await refusal(attempt)) as DomainProblem).code).toBe('PRODUCT_NOT_AUTHORISED');
      });

    it.each([
      ['no recorded kind (Q91 A: QA Hospital, legacy, outreach groups)', []],
      ['a hospital', ['hospital']],
      ['a clinic', ['clinic']],
      ['a hospital that also runs a laboratory (a reused organisation)', ['hospital', 'laboratory']],
      ['a clinic that also runs a pharmacy', ['clinic', 'pharmacy']],
      ['\'other\' with ehr or migrate (the database answers hospital)', ['hospital']],
      ['an organisation promoted from the legacy system that a governed approval reused for a laboratory product '
        + '(the database answers hospital and laboratory)', ['hospital', 'laboratory']],
    ])('the org_admin of %s is a hospital role on every product site', async (_label, kinds) => {
      const admin = account('hospital-org-admin', [membership(HOSPITAL, 'org_admin', { kinds,
        products: kinds.includes('laboratory') ? ['laboratory'] : [] })]);
      for (const product of PRODUCTS) {
        const { controller } = harness([admin]);
        const answer = await controller.login(login(admin), request(PROD(product)), response());
        expect(answer.actor.facilityIds).toEqual([HOSPITAL.facility]);
      }
    });

    // 0126 reads 'other' as staff_invitable_roles does, and the gate adds the
    // site of each product the organisation holds.
    it.each([
      ['\'other\' with a laboratory product (the database answers laboratory)', ['laboratory'], ['laboratory'], ['lab']],
      ['\'other\' with a pharmacy product (the database answers pharmacy)', ['pharmacy'], ['pharmacy'], ['pharmacy']],
      ['a laboratory application beside an \'other\' pharmacy product (laboratory and pharmacy)',
        ['laboratory', 'pharmacy'], ['laboratory', 'pharmacy'], ['lab', 'pharmacy']],
      ['a laboratory that bought the migrate product', ['laboratory'], ['migrate'], ['lab', 'migrate']],
      ['a laboratory that bought the ehr product', ['laboratory'], ['ehr'], ['ehr', 'lab']],
      ['a pharmacy that bought the migrate product', ['pharmacy'], ['migrate'], ['pharmacy', 'migrate']],
      ['a laboratory whose only product is suspended (the kind stays recorded, no product is held)', ['laboratory'], [],
        ['lab']],
    ] as const)('the org_admin of %s', async (_label, kinds, products, admitted) => {
      const admin = account('kind-org-admin', [membership(LABORATORY, 'org_admin', { kinds: [...kinds],
        products: [...products] })]);
      for (const product of PRODUCTS) {
        const { controller } = harness([admin]);
        const attempt = controller.login(login(admin), request(PROD(product)), response());
        if ((admitted as readonly StaffProduct[]).includes(product)) {
          expect((await attempt).actor.facilityIds).toEqual([LABORATORY.facility]);
        } else {
          expect(((await refusal(attempt)) as DomainProblem).code).toBe('PRODUCT_NOT_AUTHORISED');
        }
      }
    });

    it.each([
      ['a laboratory', ['laboratory'], ['laboratory'], 'laboratory', ['lab']],
      ['a pharmacy', ['pharmacy'], ['pharmacy'], 'pharmacy', ['pharmacy']],
      ['a pharmacy that signed up on migrate. for the migrate product', ['pharmacy'], ['migrate'], 'pharmacy',
        ['pharmacy', 'migrate']],
      ['a laboratory that signed up on ehr. for the ehr product', ['laboratory'], ['ehr'], 'laboratory', ['ehr', 'lab']],
      ['an \'other\' organisation that signed up on lab.', ['laboratory'], ['laboratory'], 'other', ['lab']],
      ['a hospital', ['hospital'], ['ehr'], 'hospital', PRODUCTS],
      ['a clinic', ['clinic'], ['migrate'], 'clinic', PRODUCTS],
    ] as const)('the administrator of %s awaiting review is admitted where that organisation\'s org_admin is',
      async (_label, kinds, products, organizationType, admitted) => {
        const pending = account('pending-review-admin', [membership(CLINIC, 'org_admin', {
          permissionsRole: 'org_admin_awaiting_review', review: 'pending', organizationType, kinds: [...kinds],
          products: [...products] })]);
        for (const product of PRODUCTS) {
          const { controller } = harness([pending]);
          const attempt = controller.login(login(pending), request(PROD(product)), response());
          if ((admitted as readonly StaffProduct[]).includes(product)) {
            expect((await attempt).actor.facilityIds).toEqual([CLINIC.facility]);
          } else {
            expect(((await refusal(attempt)) as DomainProblem).code).toBe('PRODUCT_NOT_AUTHORISED');
          }
        }
      });

    // Q97: a clinical hospital role is admitted on ehr. and migrate. only, at any organisation.
    it('clinical hospital roles (ehr.encounter.write) keep ehr. and migrate. at any organisation, and lab and pharmacy roles keep their own sites',
      async () => {
        for (const [role, place, admitted] of [
          ['doctor', LABORATORY, ['ehr', 'migrate']], ['nurse', PHARMACY, ['ehr', 'migrate']],
          ['receptionist', LABORATORY, ['ehr', 'migrate']], ['clinician', PHARMACY, ['ehr', 'migrate']],
          ['lab', HOSPITAL, ['lab']], ['pharmacist', HOSPITAL, ['pharmacy']], ['lab', LABORATORY, ['lab']],
        ] as const) {
          const who = account(`${role}-at-${place.name}`, [membership(place, role)]);
          for (const product of PRODUCTS) {
            const { controller } = harness([who]);
            const attempt = controller.login(login(who), request(PROD(product)), response());
            if ((admitted as readonly StaffProduct[]).includes(product)) {
              expect((await attempt).actor.facilityIds).toEqual([place.facility]);
            } else {
              expect(((await refusal(attempt)) as DomainProblem).code).toBe('PRODUCT_NOT_AUTHORISED');
            }
          }
        }
      });

    it('the rule itself: who is an administrator, which organisation is a hospital, and its sites', () => {
      const facility = (permissionsRole: string, kinds?: string[], review?: 'pending' | 'reviewed', products?: string[]) => ({
        id: 'f', membershipId: 'm', organizationId: 'o', name: 'n', roles: [permissionsRole],
        permissions: permissionsOf(permissionsRole), isPrimary: true,
        ...(kinds ? { organizationKinds: kinds as never } : {}),
        ...(products ? { organizationProducts: products as never } : {}),
        ...(review ? { selfService: { review, organizationType: 'laboratory' as const } } : {}) });
      expect(administratorMembership(facility('org_admin'))).toBe(true);
      expect(administratorMembership(facility('admin'))).toBe(true);
      expect(administratorMembership(facility('org_admin_awaiting_review', ['laboratory'], 'pending'))).toBe(true);
      // Reviewed: the role is org_admin again; awaiting-review permissions without a pending review are no administrator.
      expect(administratorMembership(facility('org_admin_awaiting_review', ['laboratory'], 'reviewed'))).toBe(false);
      expect(administratorMembership(facility('doctor'))).toBe(false);
      expect(administratorMembership(facility('lab'))).toBe(false);
      expect(organisationIsHospital(facility('org_admin'))).toBe(true);
      expect(organisationIsHospital(facility('org_admin', []))).toBe(true);
      expect(organisationIsHospital(facility('org_admin', ['laboratory', 'pharmacy']))).toBe(false);
      expect(organisationIsHospital(facility('org_admin', ['clinic', 'laboratory']))).toBe(true);
      expect(administratorProducts(facility('org_admin'))).toEqual(PRODUCTS);
      expect(administratorProducts(facility('org_admin', ['laboratory']))).toEqual(['lab']);
      expect(administratorProducts(facility('org_admin', ['pharmacy']))).toEqual(['pharmacy']);
      expect(administratorProducts(facility('org_admin', ['laboratory', 'pharmacy']))).toEqual(['lab', 'pharmacy']);
      // The site of each held product is added; at a hospital every site already is.
      expect(administratorProducts(facility('org_admin', ['laboratory'], undefined, ['laboratory']))).toEqual(['lab']);
      expect(administratorProducts(facility('org_admin', ['laboratory'], undefined, ['migrate']))).toEqual(['lab', 'migrate']);
      expect(administratorProducts(facility('org_admin', ['pharmacy'], undefined, ['ehr', 'migrate'])))
        .toEqual(['ehr', 'pharmacy', 'migrate']);
      expect(administratorProducts(facility('org_admin', ['pharmacy'], undefined, ['laboratory']))).toEqual(['lab', 'pharmacy']);
      expect(administratorProducts(facility('org_admin', ['hospital'], undefined, ['laboratory']))).toEqual(PRODUCTS);
      expect(administratorProducts(facility('org_admin', ['laboratory'], undefined, []))).toEqual(['lab']);
      // Never outreach. for an organisation that is not a hospital.
      expect(administratorProducts(facility('org_admin', ['laboratory', 'pharmacy'], undefined,
        ['ehr', 'migrate', 'laboratory', 'pharmacy']))).toEqual(['ehr', 'lab', 'pharmacy', 'migrate']);
    });
  });

  it('a hospital receptionist holds ehr.encounter.write (0006), so is admitted on migrate. as a hospital role', async () => {
    const { controller } = harness([accounts.receptionist]);
    const answer = await controller.login(login(accounts.receptionist), request(PROD('migrate')), response());
    expect(answer.actor.facilityIds).toEqual([HOSPITAL.facility]);
  });

  it('a doctor who also helps an outreach group keeps only the group on outreach., and only the hospital on ehr.', async () => {
    const { controller } = harness();
    const outreach = await controller.login(login(accounts.doctorAndVolunteer), request(PROD('outreach')), response());
    expect(outreach.actor.facilityIds).toEqual([OUTREACH_GROUP.facility]);
    expect(outreach.actor.permissions).toEqual(permissionsOf('outreach_volunteer'));
    const ehr = await controller.login(login(accounts.doctorAndVolunteer), request(PROD('ehr')), response());
    expect(ehr.actor.facilityIds).toEqual([HOSPITAL.facility]);
    for (const site of ['lab', 'pharmacy'] as const) {
      const error = await refusal(controller.login(login(accounts.doctorAndVolunteer), request(PROD(site)), response()));
      expect((error as DomainProblem).code).toBe('PRODUCT_NOT_AUTHORISED');
    }
  });

  describe('hosts with no product keep today\'s behaviour', () => {
    it.each([ADMIN, LOCAL])('%s: every membership, and no product in the token', async (origin) => {
      const { controller } = harness();
      for (const who of [accounts.lab, accounts.pharmacist, accounts.volunteer, accounts.orgAdmin, accounts.labAndVolunteer]) {
        const answer = await controller.login(login(who), request(origin), response());
        expect(answer.actor.facilities.map((facility) => facility.id).sort())
          .toEqual(who.memberships.map((row) => row.facility_id).sort());
        expect(signedClaims.at(-1)).not.toHaveProperty('product');
      }
    });

    it.each([ADMIN, LOCAL])('%s: a platform admin with no membership signs in as today (no staff product site)', async (origin) => {
      const { controller } = harness();
      const answer = await controller.login(login(accounts.platformAdmin), request(origin), response());
      expect(answer.actor).toMatchObject({ facilities: [], platformPermissions: expect.arrayContaining(['platform.admin.access']) });
      expect(answer.actor.accountOnly).toBeUndefined();
      expect(answer.actor.products).toEqual([]);
    });

    it.each([ADMIN, LOCAL])('%s: actor.products still lists every site each login can open (Q97)', async (origin) => {
      const { controller } = harness();
      for (const [, who, expected] of MATRIX.filter(([, row]) => row.memberships.length > 0)) {
        const answer = await controller.login(login(who), request(origin), response());
        expect(answer.actor.products).toEqual(productsOf(expected));
      }
    });

    it.each([ADMIN, LOCAL])('%s: a verified staff login with no membership is told so (403, not counted)', async (origin) => {
      const { controller, sessionAudit } = harness();
      const error = await refusal(controller.login(login(accounts.noMembership), request(origin), response()));
      expect([error.getStatus(), (error as DomainProblem).code]).toEqual([403, 'NO_ACTIVE_FACILITY_MEMBERSHIP']);
      expect(sessionAudit.recordLoginFailure).not.toHaveBeenCalled();
    });
  });

  describe('everything else keeps the one wrong-password answer, counted as a failed sign-in', () => {
    const origins = [...PRODUCTS.map(PROD), ADMIN, LOCAL];
    it.each(origins)('a wrong password on %s is 401 and counted', async (origin) => {
      const { controller, sessionAudit, audit } = harness();
      const error = await refusal(controller.login(login(accounts.doctor, WRONG), request(origin), response()));
      expect([error.getStatus(), error.message]).toEqual([401, 'Invalid credentials']);
      expect(sessionAudit.recordLoginFailure).toHaveBeenCalledWith(`${accounts.doctor.key}@example.test`, expect.any(Object));
      expect(audit.record).not.toHaveBeenCalled();
    });

    it.each(origins)('a wrong password for a login the site would refuse (lab on %s) is still 401 and counted', async (origin) => {
      const { controller, sessionAudit } = harness();
      const error = await refusal(controller.login(login(accounts.lab, WRONG), request(origin), response()));
      expect(error.getStatus()).toBe(401);
      expect(sessionAudit.recordLoginFailure).toHaveBeenCalledTimes(1);
    });

    it.each(PRODUCTS.flatMap((product) => [
      ['an account with no staff record (a patient login)', accounts.noMembershipPatient, product],
      ['a sealed demo account with no membership', accounts.noMembershipDemo, product],
      ['an account with a platform role but no admin access', accounts.noMembershipPlatformRole, product],
    ] as const))('%s on %s. with the right password: 401 "Invalid credentials", counted', async (_label, who, product) => {
      const { controller, sessionAudit } = harness();
      const error = await refusal(controller.login(login(who), request(PROD(product)), response()));
      expect([error.getStatus(), error.message]).toEqual([401, 'Invalid credentials']);
      expect(sessionAudit.recordLoginFailure).toHaveBeenCalledTimes(1);
    });
  });
});

describe('refresh re-applies the gate (POST /auth/refresh)', () => {
  const refreshToken = '90000000-0000-4000-8000-000000000001.opaque-refresh-secret-value.local';

  async function refreshed(who: Account, origin: string) {
    const { tokens } = harness(Object.values(accounts), who);
    return tokens.refresh(refreshToken, { correlationId: 'product-gate-refresh', origin,
      ...(productForOrigin(origin) ? { product: productForOrigin(origin) } : {}) });
  }

  it.each(MATRIX.flatMap(([label, who, expected]) => PRODUCTS.map((product) => [label, product, who, expected[product]] as const)))(
    '%s refreshing on %s.', async (_label, product, who, expected) => {
      const attempt = refreshed(who, PROD(product));
      if (expected === 'session' || expected === 'account-only') {
        const result = await attempt;
        for (const facility of result.actor.facilities) expect(facilityAdmittedOnProduct(facility, product)).toBe(true);
        expect(Boolean(result.actor.accountOnly)).toBe(expected === 'account-only');
        expect(result.actor.products).toEqual(productsOf(expectedFor(who)));
        expect(signedClaims.at(-1)).toMatchObject({ product,
          facility_ids: result.actor.facilities.map((facility) => facility.id) });
        return;
      }
      // A session that no longer fits its site ends with 401, the answer every
      // website already signs out on (not a 403 that shows an error screen).
      await expect(attempt).rejects.toBeInstanceOf(UnauthorizedException);
    });

  it('the controller answers 401 and clears the cookies when a refresh no longer fits the site', async () => {
    const { controller, tokens } = harness(Object.values(accounts), accounts.lab);
    jest.spyOn(tokens, 'verifyRefreshCsrf').mockReturnValue(true);
    const answer = response();
    const req = request(PROD('ehr'), { cookies: { hid_access_refresh: refreshToken, hid_access_csrf: 'csrf' } } as Partial<HidRequest>,
      { 'x-csrf-token': 'csrf' });
    const error = await refusal(controller.refresh(req, answer));
    expect(error).toBeInstanceOf(UnauthorizedException);
    expect(error.getStatus()).toBe(401);
    expect((answer as unknown as { clearCookie: jest.Mock }).clearCookie).toHaveBeenCalled();
  });

  it.each([ADMIN, LOCAL])('a membership that ended, refreshed on %s, ends the session with 401 (as before the gate)',
    async (origin) => {
      const { controller, tokens } = harness(Object.values(accounts), accounts.noMembership);
      jest.spyOn(tokens, 'verifyRefreshCsrf').mockReturnValue(true);
      const answer = response();
      const req = request(origin, { cookies: { hid_access_refresh: refreshToken, hid_access_csrf: 'csrf' } } as Partial<HidRequest>,
        { 'x-csrf-token': 'csrf' });
      const error = await refusal(controller.refresh(req, answer));
      expect(error.getStatus()).toBe(401);
      expect((answer as unknown as { clearCookie: jest.Mock }).clearCookie).toHaveBeenCalled();
    });

  it('the administrator awaiting review of a pharmacy that signed up on migrate. refreshes there (it holds migrate)',
    async () => {
      const pending = account('pending-pharmacy-migrate', [membership(PHARMACY, 'org_admin', {
        permissionsRole: 'org_admin_awaiting_review', review: 'pending', organizationType: 'pharmacy',
        kinds: ['pharmacy'], products: ['migrate'] })]);
      for (const product of PRODUCTS) {
        const { tokens } = harness([pending], pending);
        const attempt = tokens.refresh(refreshToken, { correlationId: 'product-gate-refresh', origin: PROD(product),
          product });
        if (product === 'migrate' || product === 'pharmacy') {
          expect((await attempt).actor.facilityIds).toEqual([PHARMACY.facility]);
        } else {
          await expect(attempt).rejects.toBeInstanceOf(UnauthorizedException);
        }
      }
    });

  it('a refresh on a host with no product keeps every membership', async () => {
    const result = await refreshed(accounts.orgAdmin, ADMIN);
    expect(result.actor.facilities).toHaveLength(3);
    expect(signedClaims.at(-1)).not.toHaveProperty('product');
    expect(result.refreshToken.split('.')).toHaveLength(3);
  });
});

describe('the product is bound to the session, not to the Origin a refresh names', () => {
  async function issuedOn(who: Account, origin: string) {
    const { tokens } = harness(Object.values(accounts), who);
    const product = productForOrigin(origin);
    return tokens.issue({ subject: who.subject, accountId: who.accountId, email: `${who.key}@example.test`,
      displayName: 'Staff', facilities: [], authenticationMethod: 'local' },
    { correlationId: 'product-gate-bound', origin, ...(product ? { product } : {}) });
  }

  async function refreshOn(who: Account, token: string, origin: string | undefined) {
    const { tokens } = harness(Object.values(accounts), who);
    const product = productForOrigin(origin);
    return tokens.refresh(token, { correlationId: 'product-gate-bound', ...(origin ? { origin } : {}),
      ...(product ? { product } : {}) });
  }

  it('a staff session issued on a product site carries that product in its refresh token', async () => {
    const lab = await issuedOn(accounts.orgAdmin, PROD('lab'));
    expect(lab.refreshToken.split('.')).toHaveLength(4);
    expect(lab.refreshToken.split('.')[2]).toBe('lab');
    expect(lab.refreshToken.endsWith('.local')).toBe(true);
    const admin = await issuedOn(accounts.orgAdmin, ADMIN);
    expect(admin.refreshToken.split('.')).toHaveLength(3);
  });

  it.each([
    'https://app.healthidentitydirectory.com', 'https://www.healthidentitydirectory.com', ADMIN, LOCAL,
    PROD('ehr'), STAGING('outreach'), undefined,
  ])('a session issued on lab. refreshed with Origin %p ends with 401 and gains nothing', async (origin) => {
    const issued = await issuedOn(accounts.labAndVolunteer, PROD('lab'));
    expect(issued.actor.facilityIds).toEqual([LABORATORY.facility]);
    signedClaims.length = 0;
    await expect(refreshOn(accounts.labAndVolunteer, issued.refreshToken, origin))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(signedClaims).toHaveLength(0);
  });

  it('a login every site admits (org_admin) issued on lab. still cannot be refreshed as another site\'s', async () => {
    const issued = await issuedOn(accounts.orgAdmin, PROD('lab'));
    for (const origin of [PROD('ehr'), PROD('migrate'), 'https://app.healthidentitydirectory.com', ADMIN]) {
      await expect(refreshOn(accounts.orgAdmin, issued.refreshToken, origin)).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });

  it('the same session refreshed on lab. keeps lab only, and the new refresh token keeps lab', async () => {
    const issued = await issuedOn(accounts.labAndVolunteer, PROD('lab'));
    const result = await refreshOn(accounts.labAndVolunteer, issued.refreshToken, PROD('lab'));
    expect(result.actor.facilityIds).toEqual([LABORATORY.facility]);
    expect(signedClaims.at(-1)).toMatchObject({ product: 'lab' });
    expect(result.refreshToken.split('.')[2]).toBe('lab');
  });

  it('a refresh token issued before the gate takes the product of the site it is refreshed on, and keeps it', async () => {
    const legacy = '90000000-0000-4000-8000-000000000001.opaque-refresh-secret-value.local';
    const result = await refreshOn(accounts.labAndVolunteer, legacy, PROD('outreach'));
    expect(result.actor.facilityIds).toEqual([OUTREACH_GROUP.facility]);
    expect(result.refreshToken.split('.')[2]).toBe('outreach');
    await expect(refreshOn(accounts.labAndVolunteer, result.refreshToken, 'https://app.healthidentitydirectory.com'))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each([
    '90000000-0000-4000-8000-000000000001.opaque.admin.local',
    '90000000-0000-4000-8000-000000000001.opaque.lab.extra.local',
  ])('refuses a refresh token naming no product it knows (%s)', async (token) => {
    await expect(refreshOn(accounts.lab, token, PROD('lab'))).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('every request keeps the product the session was issued under (access token claim)', () => {
  function claims(who: Account, product?: string) {
    return { payload: { sub: who.subject, sid: '90000000-0000-4000-8000-000000000001', jti: 'jti', token_version: 1,
      auth_method: 'local', actor_kind: 'staff', ...(product ? { product } : {}) } } as never;
  }

  it('keeps only the fitting facilities on each request, and lists every site the login can open (GET /auth/session)', async () => {
    const { tokens } = harness();
    jest.mocked(jwtVerify).mockResolvedValue(claims(accounts.orgAdmin, 'lab'));
    const lab = await tokens.verify('signed');
    // Q90/Q91: QA Hospital and QA Laboratory; QA Pharmacy is a pharmacy only.
    expect(lab.actor.facilityIds).toEqual([HOSPITAL.facility, LABORATORY.facility]);
    expect(lab.actor.products).toEqual(PRODUCTS);
    jest.mocked(jwtVerify).mockResolvedValue(claims(accounts.doctorAndVolunteer, 'outreach'));
    const doctorOnOutreach = await tokens.verify('signed');
    expect(doctorOnOutreach.actor.facilityIds).toEqual([OUTREACH_GROUP.facility]);
    expect(doctorOnOutreach.actor.products).toEqual(['ehr', 'migrate', 'outreach']);
    jest.mocked(jwtVerify).mockResolvedValue(claims(accounts.labAndVolunteer, 'outreach'));
    const outreach = await tokens.verify('signed');
    expect(outreach.actor.facilityIds).toEqual([OUTREACH_GROUP.facility]);
  });

  it('ends a session that no longer fits its site with 401 (as an ended membership always has)', async () => {
    const { tokens } = harness();
    jest.mocked(jwtVerify).mockResolvedValue(claims(accounts.lab, 'pharmacy'));
    await expect(tokens.verify('signed')).rejects.toBeInstanceOf(UnauthorizedException);
    // Q97: a doctor's session issued on lab. before the change ends at its next request.
    jest.mocked(jwtVerify).mockResolvedValue(claims(accounts.doctor, 'lab'));
    await expect(tokens.verify('signed')).rejects.toBeInstanceOf(UnauthorizedException);
    jest.mocked(jwtVerify).mockResolvedValue(claims(accounts.noMembership, 'ehr'));
    await expect(tokens.verify('signed')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('resolves the account-only session on outreach., and refuses a claim that names no product it knows', async () => {
    const { tokens } = harness();
    jest.mocked(jwtVerify).mockResolvedValue(claims(accounts.noMembership, 'outreach'));
    await expect(tokens.verify('signed')).resolves.toMatchObject({ actor: { accountOnly: true, facilities: [],
      products: ['outreach'] } });
    jest.mocked(jwtVerify).mockResolvedValue(claims(accounts.doctor, 'admin'));
    await expect(tokens.verify('signed')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('a token with no product (issued before the gate, or off the product sites) keeps today\'s behaviour', async () => {
    const { tokens } = harness();
    jest.mocked(jwtVerify).mockResolvedValue(claims(accounts.labAndVolunteer));
    const verified = await tokens.verify('signed');
    expect(verified.actor.facilities).toHaveLength(2);
  });
});

describe('facility selection re-applies the gate (POST /auth/facility)', () => {
  function actorWith(who: Account): ActorContext {
    const facilities = who.memberships.map((row) => ({ id: String(row.facility_id), membershipId: String(row.membership_id),
      organizationId: String(row.organization_id), name: String(row.facility_name), roles: row.roles as string[],
      permissions: row.permissions as string[], isPrimary: Boolean(row.is_primary),
      ...((row.organization_kinds as string[]).length > 0 ? { organizationKinds: row.organization_kinds as never } : {}),
      ...((row.organization_kinds as string[]).length > 0 && (row.organization_products as string[]).length > 0
        ? { organizationProducts: row.organization_products as never } : {}) }));
    return { kind: 'staff', id: who.subject, subject: who.subject, accountId: who.accountId, sessionId: 'session',
      roles: facilities[0]?.roles ?? [], permissions: facilities[0]?.permissions ?? [], facilityIds: facilities.map((f) => f.id),
      facilities, facility: facilities[0], authenticationMethod: 'local' };
  }

  it.each([
    ['org_admin on lab. picks QA Laboratory (a laboratory)', accounts.orgAdmin, PROD('lab'), LABORATORY.facility, true],
    ['org_admin on lab. picks QA Hospital (no kind: a hospital)', accounts.orgAdmin, PROD('lab'), HOSPITAL.facility, true],
    ['org_admin on lab. picks QA Pharmacy (a pharmacy only: Q90)', accounts.orgAdmin, PROD('lab'), PHARMACY.facility, false],
    ['org_admin on pharmacy. picks QA Pharmacy (a pharmacy)', accounts.orgAdmin, PROD('pharmacy'), PHARMACY.facility, true],
    ['org_admin on ehr. picks QA Laboratory (a laboratory only: Q90)', accounts.orgAdmin, PROD('ehr'), LABORATORY.facility, false],
    ['org_admin on admin. picks QA Pharmacy (no product)', accounts.orgAdmin, ADMIN, PHARMACY.facility, true],
    ['lab and volunteer on lab. picks the outreach group', accounts.labAndVolunteer, PROD('lab'), OUTREACH_GROUP.facility, false],
    ['lab and volunteer on outreach. picks the laboratory', accounts.labAndVolunteer, PROD('outreach'), LABORATORY.facility, false],
    ['lab and volunteer on outreach. picks the outreach group', accounts.labAndVolunteer, PROD('outreach'), OUTREACH_GROUP.facility, true],
    ['lab and volunteer on admin. picks either', accounts.labAndVolunteer, ADMIN, OUTREACH_GROUP.facility, true],
  ] as const)('%s', async (_label, who, origin, facilityId, allowed) => {
    const { controller } = harness();
    const req = request(origin, { actor: actorWith(who) } as Partial<HidRequest>);
    const attempt = controller.selectFacility({ facilityId }, req, response());
    if (!allowed) {
      await expect(attempt).rejects.toMatchObject({ code: 'FACILITY_ACCESS_DENIED', status: 403 });
      return;
    }
    const answer = await attempt;
    expect(answer.actor.facility?.id).toBe(facilityId);
    const product = productForOrigin(origin);
    if (product) for (const facility of answer.actor.facilities) expect(facilityAdmittedOnProduct(facility, product)).toBe(true);
    expect(answer.actor.facilityIds).toEqual(answer.actor.facilities.map((facility) => facility.id));
  });

  it('the answer keeps actor.products (Q97)', async () => {
    const { controller } = harness();
    const actor = { ...actorWith(accounts.orgAdmin), products: productsForFacilities(actorWith(accounts.orgAdmin).facilities) };
    // Q90/Q91: on lab. the org_admin keeps QA Hospital and QA Laboratory (QA Pharmacy is a pharmacy only).
    const answer = await controller.selectFacility({ facilityId: LABORATORY.facility },
      request(PROD('lab'), { actor } as Partial<HidRequest>), response());
    expect(answer.actor.products).toEqual(PRODUCTS);
  });

  it('an account-only session has no facility to pick', async () => {
    const { controller } = harness();
    const actor = { ...actorWith(accounts.noMembership), accountOnly: true as const };
    await expect(controller.selectFacility({ facilityId: OUTREACH_GROUP.facility },
      request(PROD('outreach'), { actor } as Partial<HidRequest>), response()))
      .rejects.toMatchObject({ code: 'FACILITY_ACCESS_DENIED' });
  });
});

describe('the account-only session (Q88-2) is decided by the database\'s own eligibility facts', () => {
  it('reads the staff record, platform roles and the sealed demo list for that account only', async () => {
    const { controller, calls } = harness();
    await controller.login(login(accounts.noMembership), request(PROD('outreach')), response());
    const eligibility = calls.find(({ sql }) => sql === VERIFIED_STAFF_WITHOUT_MEMBERSHIP_SQL);
    expect(eligibility?.values).toEqual([accounts.noMembership.accountId, ['verified', 'approved', 'active']]);
    expect(VERIFIED_STAFF_WITHOUT_MEMBERSHIP_SQL).toContain('staff.active');
    expect(VERIFIED_STAFF_WITHOUT_MEMBERSHIP_SQL).toContain("assignment.scope_type = 'platform'");
    expect(VERIFIED_STAFF_WITHOUT_MEMBERSHIP_SQL).toContain("identity.sealed_demo_ids('account')");
  });

  it('is never read for an account that has a membership (a doctor on outreach., refused as Q97 says)', async () => {
    const { controller, calls } = harness();
    const error = await refusal(controller.login(login(accounts.doctor), request(PROD('outreach')), response()));
    expect((error as DomainProblem).code).toBe('PRODUCT_NOT_AUTHORISED');
    expect(calls.some(({ sql }) => sql === VERIFIED_STAFF_WITHOUT_MEMBERSHIP_SQL)).toBe(false);
    await controller.login(login(accounts.organiser), request(PROD('outreach')), response());
    expect(calls.some(({ sql }) => sql === VERIFIED_STAFF_WITHOUT_MEMBERSHIP_SQL)).toBe(false);
  });
});
