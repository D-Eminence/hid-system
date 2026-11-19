jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
  SignJWT: class {},
}));

import type { Response } from 'express';
import type { AuditService } from '../audit/audit.service';
import type { ActorContext, FacilityAssignment, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { seededRolePermissions } from '../../test/role-matrix.fixtures';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import type { AuthSessionAuditService } from './auth-session-audit.service';
import { FACILITY_MODULE_RULES, facilityModules, withFacilityModules, type FacilityModuleKey } from './facility-modules';
import type { GoogleAuthenticationService } from './google-authentication.service';
import type { TokenService } from './token.service';
import type { TurnstileService } from './turnstile.service';
import type { WorkloadAuthService } from './workload-auth.service';

// SX-1 (Akos N-2b, N-2e, P1-5): each facility of the session answer carries
// `modules`, a pure function of that facility's own permission codes.

const SEEDS = seededRolePermissions();
const permissionsOf = (role: string): readonly string[] => SEEDS.get(role) ?? [];
const KEYS: FacilityModuleKey[] = ['patients', 'registration', 'accessRequests', 'emergencyAccess', 'triage', 'consultation',
  'orders', 'lab', 'labResults', 'pharmacy', 'prescriptions', 'migrate', 'outreach', 'admin', 'audit'];
const only = (...shown: FacilityModuleKey[]) => Object.fromEntries(KEYS.map((key) => [key, shown.includes(key)]));

describe('facility areas for each seeded role (SX-1)', () => {
  it('answers every area, in a fixed order, false for no permission', () => {
    expect(FACILITY_MODULE_RULES.map((area) => area.key)).toEqual(KEYS);
    expect(Object.keys(facilityModules([]))).toEqual(KEYS);
    expect(facilityModules([])).toEqual(only());
  });

  it.each<[string, FacilityModuleKey[]]>([
    ['receptionist', ['patients', 'registration', 'accessRequests', 'outreach']],
    ['nurse', ['patients', 'registration', 'accessRequests', 'emergencyAccess', 'triage', 'consultation', 'labResults',
      'prescriptions', 'migrate', 'outreach']],
    ['doctor', ['patients', 'registration', 'accessRequests', 'emergencyAccess', 'triage', 'consultation', 'orders',
      'labResults', 'prescriptions', 'migrate', 'outreach']],
    ['clinician', ['patients', 'registration', 'accessRequests', 'emergencyAccess', 'triage', 'consultation', 'orders',
      'labResults', 'prescriptions', 'migrate', 'outreach']],
    ['lab', ['patients', 'accessRequests', 'lab', 'labResults']],
    ['pharmacist', ['patients', 'accessRequests', 'pharmacy', 'prescriptions']],
    ['admin', ['registration', 'labResults', 'outreach', 'admin', 'audit']],
    ['org_admin', ['registration', 'outreach', 'admin', 'audit']],
    ['org_admin_awaiting_review', ['outreach', 'admin', 'audit']],
    ['outreach_organiser', ['outreach']],
    ['outreach_volunteer', ['outreach']],
  ])('a %s membership shows %j', (role, shown) => {
    expect(SEEDS.has(role)).toBe(true);
    expect(facilityModules(permissionsOf(role))).toEqual(only(...shown));
  });

  it('P1-5: no clinical role is shown the facility profile and staff or the audit trail', () => {
    for (const role of ['doctor', 'clinician', 'nurse', 'receptionist', 'lab', 'pharmacist']) {
      expect(facilityModules(permissionsOf(role))).toEqual(expect.objectContaining({ admin: false, audit: false }));
    }
  });

  it('is pure: the order and repeats of the codes, and codes it does not know, change nothing', () => {
    const doctor = [...permissionsOf('doctor')];
    const first = facilityModules(doctor);
    expect(facilityModules([...doctor].reverse())).toEqual(first);
    expect(facilityModules([...doctor, ...doctor, 'platform.admin.access', 'not.a.code'])).toEqual(first);
    expect(doctor).toEqual([...permissionsOf('doctor')]);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('needs every code an area names: one of the two order codes alone does not show orders', () => {
    expect(facilityModules(['ehr.prescription.write']).orders).toBe(false);
    expect(facilityModules(['ehr.lab-request.write']).orders).toBe(false);
    expect(facilityModules(['ehr.lab-request.write', 'ehr.prescription.write']).orders).toBe(true);
    expect(facilityModules(['identity.break-glass.write']).emergencyAccess).toBe(false);
  });

  it('a membership holding two roles shows what either role shows', () => {
    const both = [...new Set([...permissionsOf('nurse'), ...permissionsOf('lab')])];
    expect(facilityModules(both)).toEqual(only('patients', 'registration', 'accessRequests', 'emergencyAccess', 'triage',
      'consultation', 'lab', 'labResults', 'prescriptions', 'migrate', 'outreach'));
  });
});

const originalEnvironment = { ...process.env };
const origin = 'https://www.healthidentitydirectory.com';

function facility(index: number, roles: string[], extra: Partial<FacilityAssignment> = {}): FacilityAssignment {
  return {
    id: `30000000-0000-4000-8000-00000000000${index}`,
    membershipId: `40000000-0000-4000-8000-00000000000${index}`,
    organizationId: '10000000-0000-4000-8000-000000000001',
    name: `Fictional Clinic ${index}`,
    code: `FC-${index}`,
    roles,
    permissions: [...new Set(roles.flatMap(permissionsOf))].sort(),
    isPrimary: index === 1,
    ...extra,
  };
}

function staffActor(): ActorContext {
  const first = facility(1, ['nurse', 'lab']);
  const second = facility(2, ['org_admin'], { organizationKinds: ['hospital'], organizationProducts: ['ehr'] });
  return {
    kind: 'staff',
    id: 'staff-subject',
    subject: 'staff-subject',
    accountId: '10000000-0000-4000-8000-000000000009',
    sessionId: '50000000-0000-4000-8000-000000000001',
    email: 'nurse@example.test',
    displayName: 'Ada Fictional',
    authenticationMethod: 'local',
    roles: first.roles,
    role: first.roles[0],
    permissions: first.permissions,
    platformRoles: [],
    platformPermissions: [],
    facilityIds: [first.id, second.id],
    facilities: [first, second],
    facility: first,
    products: ['ehr', 'lab', 'migrate'],
  };
}

function requestFor(actor: ActorContext): HidRequest {
  return {
    correlationId: '01J5A2C3D4E5F6G7H8J9K0MNPQ',
    ip: '203.0.113.10',
    cookies: { hid_access_csrf: 'csrf-token' },
    actor,
    header: jest.fn((name: string) => (name === 'origin' ? origin : name === 'user-agent' ? 'sx1-test' : undefined)),
  } as unknown as HidRequest;
}

const responseFor = () => ({ cookie: jest.fn(), clearCookie: jest.fn(), setHeader: jest.fn() }) as unknown as Response;

describe('the session answer carries each facility\'s areas (SX-1)', () => {
  let controller: AuthController;
  let audit: { record: jest.Mock };

  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/hid',
      DATABASE_SSL: 'false',
      CORS_ORIGINS: origin,
      AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: 'test-signing-secret-with-at-least-32-characters',
      AUTH_LOGIN_PEPPER: 'test-login-pepper-with-at-least-32-characters',
      AUTH_COOKIE_NAME: 'hid_access',
      AUTH_COOKIE_SECURE: 'false',
      TURNSTILE_MODE: 'disabled',
    });
    resetEnvironmentForTests();
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    controller = new AuthController(
      {} as AuthService,
      {} as TokenService,
      { record: jest.fn() } as unknown as AuthSessionAuditService,
      audit as unknown as AuditService,
      {} as WorkloadAuthService,
      { verifyLogin: jest.fn() } as unknown as TurnstileService,
      {} as GoogleAuthenticationService,
    );
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    resetEnvironmentForTests();
  });

  it('GET /auth/session adds modules to every facility and the selected one; every other field is unchanged', async () => {
    const actor = staffActor();
    const before = JSON.parse(JSON.stringify(actor)) as ActorContext;
    const answer = await controller.session(requestFor(actor), responseFor());

    expect(answer).toEqual({
      actor: {
        ...before,
        facilities: before.facilities.map((each) => ({ ...each, modules: facilityModules(each.permissions) })),
        facility: { ...before.facility, modules: facilityModules(before.facility!.permissions) },
      },
    });
    // roles[0] and the order of fields are unchanged; modules comes last.
    expect(answer.actor.role).toBe('nurse');
    expect(answer.actor.roles).toEqual(['nurse', 'lab']);
    expect(answer.actor.facilities[0]!.roles[0]).toBe('nurse');
    expect(Object.keys(answer.actor.facilities[0]!)).toEqual([...Object.keys(before.facilities[0]!), 'modules']);
    expect(Object.keys(answer.actor)).toEqual(Object.keys(before));
    expect(answer.actor.facilities[0]!.modules).toEqual(expect.objectContaining({ lab: true, triage: true, admin: false }));
    expect(answer.actor.facilities[1]!.modules).toEqual(expect.objectContaining({ admin: true, audit: true, consultation: false }));
    // The request's own actor is not changed (the guards and audit keep reading it).
    expect(actor).toEqual(before);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.session.read' }));
  });

  it('POST /auth/facility answers the chosen facility with its own areas', async () => {
    const actor = staffActor();
    const answer = await controller.selectFacility({ facilityId: actor.facilities[1]!.id }, requestFor(actor), responseFor());

    expect(answer.actor.role).toBe('org_admin');
    expect(answer.actor.facility).toEqual(withFacilityModules(actor.facilities[1]!));
    expect(answer.actor.facility!.modules).toEqual(facilityModules(permissionsOf('org_admin')));
    expect(answer.actor.facilities.map((each) => each.modules.admin)).toEqual([false, true]);
  });

  it('a patient session answer is unchanged, byte for byte (no facility, no modules)', async () => {
    const patient: ActorContext = {
      kind: 'patient', patientId: '20000000-0000-4000-8000-000000000001', id: 'patient-subject', subject: 'patient-subject',
      accountId: '10000000-0000-4000-8000-000000000001', authenticationMethod: 'oidc', roles: [], permissions: [],
      platformRoles: [], platformPermissions: [], facilityIds: [], facilities: [],
    };
    const answer = await controller.session(requestFor(patient), responseFor());
    expect(JSON.stringify(answer)).toBe(JSON.stringify({ actor: patient }));
  });
});
