jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import { randomUUID } from 'node:crypto';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type { NextFunction, Response } from 'express';
import request from 'supertest';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditService } from '../audit/audit.service';
import { NotificationOtpClient } from '../auth/notification-otp.client';
import { SecurityGuard } from '../auth/security.guard';
import { TokenService } from '../auth/token.service';
import { AUDIT_ACTION, FACILITY_OPTIONAL, REQUIRED_PERMISSIONS } from '../common/decorators';
import { requestDigest } from '../common/idempotency';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, FacilityAssignment, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { AdminFacilityStaffController, membershipVersion } from './admin-facility-staff.controller';
import { FacilityStaffController } from './facility-staff.controller';
import { ADD_FACILITY_STAFF_ROLE_SQL, ADMIN_ADD_FACILITY_STAFF_ROLE_SQL, ADMIN_REMOVE_FACILITY_STAFF_ROLE_SQL,
  FacilityStaffRolesService, REMOVE_FACILITY_STAFF_ROLE_SQL } from './facility-staff-roles.service';
import { FacilityStaffService } from './facility-staff.service';
import { staffRoleProblem } from './staff-role-problems';
import { STAFF_ATTESTATION_VERSION, StaffInvitationsService } from './staff-invitations.service';
import { StaffReauthenticationService } from './staff-reauthentication.service';

// SX-4 (0139): the four routes, their answers and their audit rows. The
// database's own decisions are 0139's suite's
// (services/ehr-api/test/database/facility-staff-roles.integration.sql).

const facilityId = '10000000-0000-4000-8000-000000000002';
const membershipId = '40000000-0000-4000-8000-000000000009';
const staffPath = `/api/v1/identity/facility-staff/${membershipId}/roles`;
const supportPath = `/api/v1/admin/facilities/${facilityId}/staff/${membershipId}/roles`;

function assignment(review?: 'pending' | 'reviewed', permissions = ['workforce.manage']): FacilityAssignment {
  return { id: facilityId, membershipId: '40000000-0000-4000-8000-000000000001',
    organizationId: '10000000-0000-4000-8000-000000000001', name: 'Synthetic Clinic Ltd', roles: ['org_admin'],
    permissions, isPrimary: true, ...(review ? { selfService: { review, organizationType: 'hospital' as const } } : {}) };
}
function staff(facility: FacilityAssignment = assignment('reviewed')): ActorContext {
  return { kind: 'staff', id: 'staff:administrator', subject: 'staff:administrator',
    accountId: '20000000-0000-4000-8000-000000000001', email: 'admin@example.test', displayName: 'Ada Obi',
    roles: facility.roles, permissions: facility.permissions, platformRoles: [], platformPermissions: [],
    facilityIds: [facility.id], facilities: [facility], facility, authenticationMethod: 'local' };
}
const standaloneAdmin = (platformPermissions: string[]): ActorContext => ({ kind: 'staff', id: 'standalone:administrator',
  subject: 'standalone:administrator', accountId: 'e0000000-0000-4000-8000-000000000086', roles: [], permissions: [],
  platformRoles: ['platform_admin'], platformPermissions, facilityIds: [], facilities: [], authenticationMethod: 'local' });
const support = standaloneAdmin(['platform.admin.access', 'platform.facility-staff.manage']);

const meta = (key: symbol, target: object) => Reflect.getMetadata(key, target) as unknown;
const databaseError = (code: string, message: string) => Object.assign(new Error(message), { code });

describe('SX-4 routes: metadata', () => {
  it('the administrator\'s routes need workforce.manage at the facility and are audited there', () => {
    const routes = FacilityStaffController.prototype as unknown as Record<string, object>;
    expect(meta(REQUIRED_PERMISSIONS, routes.addRole as object)).toEqual(['workforce.manage']);
    expect(meta(REQUIRED_PERMISSIONS, routes.removeRole as object)).toEqual(['workforce.manage']);
    expect(meta(AUDIT_ACTION, routes.addRole as object)).toBe('identity.facility-staff.role-add');
    expect(meta(AUDIT_ACTION, routes.removeRole as object)).toBe('identity.facility-staff.role-remove');
    expect(meta(FACILITY_OPTIONAL, FacilityStaffController)).toBeUndefined();
  });

  it('support\'s routes need platform.facility-staff.manage, facility optional', () => {
    const routes = AdminFacilityStaffController.prototype as unknown as Record<string, object>;
    expect(meta(FACILITY_OPTIONAL, AdminFacilityStaffController)).toBe(true);
    expect(meta(REQUIRED_PERMISSIONS, routes.addRole as object)).toEqual(['platform.facility-staff.manage']);
    expect(meta(REQUIRED_PERMISSIONS, routes.removeRole as object)).toEqual(['platform.facility-staff.manage']);
    expect(meta(AUDIT_ACTION, routes.addRole as object)).toBe('admin.facility-staff.role-add.request');
    expect(meta(AUDIT_ACTION, routes.removeRole as object)).toBe('admin.facility-staff.role-remove.request');
  });

  it('If-Match: a positive version, quoted, weak or bare; else 428 IF_MATCH_REQUIRED', () => {
    expect([membershipVersion('"4"'), membershipVersion('W/"4"'), membershipVersion(' 4 ')]).toEqual([4, 4, 4]);
    for (const value of [undefined, '', '"0"', '"-1"', '"4.5"', '"x"', '*']) {
      expect(() => membershipVersion(value)).toThrow(expect.objectContaining({ code: 'IF_MATCH_REQUIRED' }));
    }
  });
});

describe('SX-4 problems', () => {
  it('answers 0139\'s refusals with the contract\'s codes and words, the rest as every staff command', () => {
    const answer = (code: string, message: string, caller: 'facility' | 'support' = 'facility') => {
      const problem = staffRoleProblem(databaseError(code, message), caller);
      return [problem.getStatus(), problem.code, (problem.getResponse() as { message?: string }).message ?? problem.message];
    };
    expect(answer('P0001', 'FACILITY_STAFF_ROLE_ALREADY_HELD').slice(0, 2)).toEqual([409, 'FACILITY_STAFF_ROLE_ALREADY_HELD']);
    expect(answer('P0001', 'FACILITY_STAFF_ROLE_NOT_HELD').slice(0, 2)).toEqual([409, 'FACILITY_STAFF_ROLE_NOT_HELD']);
    expect(answer('P0001', 'FACILITY_STAFF_LAST_ROLE').slice(0, 2)).toEqual([409, 'FACILITY_STAFF_LAST_ROLE']);
    expect(answer('23505', 'IDEMPOTENCY_KEY_REUSED').slice(0, 2)).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
    expect(answer('22023', 'IDEMPOTENCY_KEY_REQUIRED').slice(0, 2)).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
    expect(answer('22023', 'STAFF_INVITATION_INVALID').slice(0, 2)).toEqual([400, 'STAFF_INVITATION_INVALID']);
    expect(answer('22023', 'STAFF_INVITATION_ROLE_NOT_ALLOWED').slice(0, 2)).toEqual([400, 'STAFF_INVITATION_ROLE_NOT_ALLOWED']);
    expect(answer('40001', 'Facility staff membership version conflict').slice(0, 2)).toEqual([409, 'VERSION_CONFLICT']);
    expect(answer('P0002', 'FACILITY_STAFF_NOT_FOUND').slice(0, 2)).toEqual([404, 'FACILITY_STAFF_NOT_FOUND']);
    expect(answer('P0001', 'FACILITY_STAFF_SELF').slice(0, 2)).toEqual([409, 'FACILITY_STAFF_SELF']);
    expect(answer('P0001', 'FACILITY_STAFF_PLATFORM_ACCOUNT').slice(0, 2)).toEqual([409, 'FACILITY_STAFF_PLATFORM_ACCOUNT']);
    expect(answer('P0001', 'FACILITY_REVIEW_PENDING').slice(0, 2)).toEqual([409, 'FACILITY_REVIEW_PENDING']);
    expect(answer('42501', 'STAFF_MANAGEMENT_NOT_AVAILABLE').slice(0, 2)).toEqual([403, 'STAFF_MANAGEMENT_NOT_AVAILABLE']);
    expect(answer('55000', 'PLATFORM_CONTROL_DISABLED:staff_invitations_enabled').slice(0, 2))
      .toEqual([423, 'STAFF_INVITATIONS_UNAVAILABLE']);
    expect(answer('P0001', 'SOMETHING_ELSE').slice(0, 2)).toEqual([503, 'STAFF_MANAGEMENT_UNAVAILABLE']);
    expect(answer('XX000', 'boom').slice(0, 2)).toEqual([503, 'STAFF_MANAGEMENT_UNAVAILABLE']);
    // Support's own answers.
    expect(answer('42501', 'ADMIN_PERMISSION_DENIED', 'support').slice(0, 2)).toEqual([403, 'PERMISSION_DENIED']);
    expect(answer('P0002', 'ADMIN_FACILITY_NOT_FOUND', 'support').slice(0, 2)).toEqual([404, 'ADMIN_FACILITY_NOT_FOUND']);
    expect(answer('P0002', 'FACILITY_STAFF_NOT_FOUND', 'support').slice(0, 2)).toEqual([404, 'FACILITY_STAFF_NOT_FOUND']);
    // A refusal raised with an unexpected SQLSTATE is not taken for one.
    expect(answer('XX000', 'FACILITY_STAFF_LAST_ROLE').slice(0, 2)).toEqual([503, 'STAFF_MANAGEMENT_UNAVAILABLE']);
  });
});

describe('SX-4 routes over HTTP', () => {
  const originalEnvironment = { ...process.env };
  let app: INestApplication;
  const handlers: Record<string, (values: unknown[]) => unknown> = {};
  const calls: { sql: string; values: unknown[]; transaction: string }[] = [];
  const respond = (transaction: string) => jest.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values, transaction });
    for (const [needle, handler] of Object.entries(handlers)) if (sql.includes(needle)) return handler(values);
    if (sql.includes('platform.control_enabled($1)')) return { rows: [{ enabled: values[0] !== 'maintenance_mode' }] };
    if (sql.includes('platform.control_enabled')) return { rows: [{ invitations: true, provider_portal: true, maintenance: false }] };
    if (sql.includes('otp_challenges')) return { rows: [{ held: false }] };
    return { rows: [] };
  });
  const database = {
    query: respond('none'),
    withTransaction: jest.fn(async (_context: unknown, work: (client: unknown) => Promise<unknown>) =>
      work({ query: respond('staff') })),
    withSystemTransaction: jest.fn(),
    withPlatformTransaction: jest.fn(async (_context: unknown, work: (client: unknown) => Promise<unknown>) =>
      work({ query: respond('platform') })),
  };
  const tokens = { verify: jest.fn(), verifyCsrf: jest.fn() };
  const audit = { record: jest.fn(), recordWithClient: jest.fn() };
  const reauthentication = { confirm: jest.fn() };
  const sqlCalls = (needle: string) => calls.filter((call) => call.sql.includes(needle));
  const domainRows = (action: string) => [...audit.record.mock.calls, ...audit.recordWithClient.mock.calls]
    .map((call) => call[call.length - 1] as { action: string })
    .filter((event) => event.action === action);

  const addBody = { role: 'nurse', licenceBody: 'NMCN', licenceNumber: ' rn/ 2002 ', attested: true,
    reason: ' Also covers night triage ', currentPassword: 'secret pass', expectedVersion: 4 };
  const removeBody = { role: 'lab', reason: 'Moved to the ward full time', currentPassword: 'secret pass',
    expectedVersion: 5 };
  const supportAddBody = { role: 'nurse', licenceBody: 'NMCN', licenceNumber: 'RN 7007', attested: true,
    verificationMethod: 'regulator_register', reason: 'Covers the governed ward' };
  const changed = (overrides: Record<string, unknown> = {}) => () => ({ rows: [{ membership_id: membershipId,
    row_version: '5', roles: ['doctor', 'nurse'], previous_roles: ['doctor'], requests_closed: 0, replayed: false,
    ...overrides }] });

  beforeEach(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://app.healthidentitydirectory.com,https://admin.healthidentitydirectory.com',
      AUTH_MODE: 'local', AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456', AUTH_COOKIE_SECURE: 'true',
      OTP_HMAC_KEY_B64: Buffer.alloc(32, 3).toString('base64'),
    });
    resetEnvironmentForTests();
    jest.clearAllMocks();
    calls.length = 0;
    for (const key of Object.keys(handlers)) delete handlers[key];
    tokens.verify.mockResolvedValue({ actor: staff(), claims: {} });
    tokens.verifyCsrf.mockReturnValue(true);
    audit.record.mockResolvedValue(undefined);
    audit.recordWithClient.mockResolvedValue(undefined);
    reauthentication.confirm.mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [FacilityStaffController, AdminFacilityStaffController],
      providers: [
        StaffInvitationsService, FacilityStaffService, FacilityStaffRolesService,
        { provide: StaffReauthenticationService, useValue: reauthentication },
        { provide: DatabaseService, useValue: database },
        { provide: NotificationOtpClient, useValue: { deliverStaffInvitation: jest.fn() } },
        { provide: TokenService, useValue: tokens },
        { provide: AuditService, useValue: audit },
        { provide: APP_GUARD, useFactory: (reflector: Reflector) => new SecurityGuard(reflector,
          tokens as unknown as TokenService, audit as unknown as AuditService, database as unknown as DatabaseService),
        inject: [Reflector] },
        { provide: APP_INTERCEPTOR, useFactory: (reflector: Reflector) => new AuditInterceptor(reflector,
          audit as unknown as AuditService), inject: [Reflector] },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.use((incoming: HidRequest, _response: Response, next: NextFunction) => {
      incoming.correlationId = randomUUID();
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
      transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
      exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
        errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    resetEnvironmentForTests();
  });

  const server = () => app.getHttpServer();
  const asStaff = (path: string) => request(server()).post(path).set('Authorization', 'Bearer synthetic')
    .set('X-Facility-ID', facilityId);
  const asSupport = (path: string) => request(server()).post(path).set('Authorization', 'Bearer synthetic');

  describe('the administrator: add', () => {
    it('answers 201 with the new roles, sending the licence as stored and the request\'s digest', async () => {
      handlers['identity.add_facility_staff_role'] = changed();
      const answer = await asStaff(`${staffPath}/add`).set('Idempotency-Key', 'add-role-dialog-0001').send(addBody);
      expect([answer.status, answer.body]).toEqual([201,
        { membershipId, version: 5, roles: ['doctor', 'nurse'], replayed: false }]);
      const [call] = sqlCalls('identity.add_facility_staff_role');
      expect(call?.sql).toBe(ADD_FACILITY_STAFF_ROLE_SQL);
      expect(call?.transaction).toBe('staff');
      expect(call?.values).toEqual([membershipId, 4, 'nurse', 'NMCN', 'RN/ 2002', STAFF_ATTESTATION_VERSION,
        'Also covers night triage', 'add-role-dialog-0001', requestDigest('identity.facility-staff.role-add', {
          facilityId, membershipId, expectedVersion: 4, role: 'nurse', licenceBody: 'NMCN', licenceNumber: 'RN/ 2002',
          attested: true, reason: 'Also covers night triage' })]);
      // The recovery hold is read in the command's transaction, before the command.
      expect(calls.findIndex((entry) => entry.sql.includes('otp_challenges')))
        .toBeLessThan(calls.findIndex((entry) => entry.sql.includes('add_facility_staff_role')));
      expect(reauthentication.confirm).toHaveBeenCalledWith(expect.objectContaining({ accountId: staff().accountId }),
        'secret pass', expect.anything());
      expect(domainRows('api.identity.facility-staff.role-add')).toEqual([expect.objectContaining({ outcome: 'success',
        facilityId })]);
      // The database writes the success row; nothing here writes another, and no password reaches a row.
      expect(domainRows('identity.facility-staff.role-add')).toEqual([]);
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain('secret pass');
    });

    it('answers a replay 200 with replayed: true; the digest leaves the password out', async () => {
      handlers['identity.add_facility_staff_role'] = changed({ replayed: true });
      const answer = await asStaff(`${staffPath}/add`).set('Idempotency-Key', 'add-role-dialog-0001')
        .send({ ...addBody, currentPassword: 'another typing of it' });
      expect([answer.status, answer.body.replayed]).toEqual([200, true]);
      expect(sqlCalls('identity.add_facility_staff_role')[0]?.values[8]).toBe(requestDigest(
        'identity.facility-staff.role-add', { facilityId, membershipId, expectedVersion: 4, role: 'nurse',
          licenceBody: 'NMCN', licenceNumber: 'RN/ 2002', attested: true, reason: 'Also covers night triage' }));
    });

    it('needs an Idempotency-Key, the role\'s licence, the attestation, a reason, the password and a version', async () => {
      const noKey = await asStaff(`${staffPath}/add`).send(addBody);
      expect([noKey.status, noKey.body.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
      for (const body of [{ ...addBody, licenceBody: 'MDCN' }, { ...addBody, licenceNumber: undefined },
        { ...addBody, role: 'receptionist' }, { ...addBody, role: 'org_admin' }, { ...addBody, attested: false },
        { ...addBody, reason: 'short' }, { ...addBody, currentPassword: '' }, { ...addBody, expectedVersion: 0 },
        { ...addBody, verificationMethod: 'in_person' }]) {
        const invalid = await asStaff(`${staffPath}/add`).set('Idempotency-Key', 'add-role-dialog-0001').send(body);
        expect([invalid.status, invalid.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      }
      expect(sqlCalls('add_facility_staff_role')).toEqual([]);
    });

    it('adds the front desk with no licence', async () => {
      handlers['identity.add_facility_staff_role'] = changed({ roles: ['doctor', 'receptionist'] });
      const answer = await asStaff(`${staffPath}/add`).set('Idempotency-Key', 'add-role-dialog-0002')
        .send({ role: 'receptionist', attested: true, reason: 'Also covers the desk', currentPassword: 'secret pass',
          expectedVersion: 4 });
      expect(answer.status).toBe(201);
      expect(sqlCalls('identity.add_facility_staff_role')[0]?.values.slice(2, 5)).toEqual(['receptionist', null, null]);
    });

    it('writes one denied row at the facility for a database refusal, with the membership, role, reason and code', async () => {
      handlers['identity.add_facility_staff_role'] = () => { throw databaseError('P0001', 'FACILITY_STAFF_ROLE_ALREADY_HELD'); };
      const answer = await asStaff(`${staffPath}/add`).set('Idempotency-Key', 'add-role-dialog-0003').send(addBody);
      expect([answer.status, answer.body.code, answer.body.detail]).toEqual([409, 'FACILITY_STAFF_ROLE_ALREADY_HELD',
        'This person already has that role']);
      expect(domainRows('identity.facility-staff.role-add')).toEqual([expect.objectContaining({ outcome: 'denied',
        actorType: 'staff', facilityId, resourceType: 'staff-membership', resourceId: membershipId,
        reason: 'Also covers night triage',
        details: { membershipId, roleCode: 'nurse', code: 'FACILITY_STAFF_ROLE_ALREADY_HELD' } })]);
      expect(JSON.stringify(domainRows('identity.facility-staff.role-add'))).not.toContain('2002');
    });

    it('maps the other refusals: version, reused key, licence, closed gate, recovery hold, governed facility', async () => {
      const cases: [unknown, number, string][] = [
        [databaseError('40001', 'Facility staff membership version conflict'), 409, 'VERSION_CONFLICT'],
        [databaseError('23505', 'IDEMPOTENCY_KEY_REUSED'), 409, 'IDEMPOTENCY_KEY_REUSED'],
        [databaseError('22023', 'STAFF_INVITATION_INVALID'), 400, 'STAFF_INVITATION_INVALID'],
        [databaseError('22023', 'STAFF_INVITATION_ROLE_NOT_ALLOWED'), 400, 'STAFF_INVITATION_ROLE_NOT_ALLOWED'],
        [databaseError('P0002', 'FACILITY_STAFF_NOT_FOUND'), 404, 'FACILITY_STAFF_NOT_FOUND'],
      ];
      const details: string[] = [];
      for (const [error, status, code] of cases) {
        handlers['identity.add_facility_staff_role'] = () => { throw error; };
        const answer = await asStaff(`${staffPath}/add`).set('Idempotency-Key', 'add-role-dialog-0004').send(addBody);
        expect([answer.status, answer.body.code]).toEqual([status, code]);
        details.push(answer.body.detail);
      }
      // This route's own wording for today's licence code (the contract's "SX-4" errors).
      expect(details[2]).toBe('The licence does not match the role');
      handlers['identity.add_facility_staff_role'] = changed();
      handlers['as invitations'] = () => ({ rows: [{ invitations: false, provider_portal: true, maintenance: false }] });
      const closed = await asStaff(`${staffPath}/add`).set('Idempotency-Key', 'add-role-dialog-0005').send(addBody);
      expect([closed.status, closed.body.code]).toEqual([423, 'STAFF_INVITATIONS_UNAVAILABLE']);
      delete handlers['as invitations'];
      handlers['otp_challenges'] = () => ({ rows: [{ held: true }] });
      const held = await asStaff(`${staffPath}/add`).set('Idempotency-Key', 'add-role-dialog-0006').send(addBody);
      expect([held.status, held.body.code]).toEqual([403, 'STAFF_RECENT_RECOVERY_HOLD']);
      delete handlers['otp_challenges'];
      tokens.verify.mockResolvedValue({ actor: staff(assignment(undefined)), claims: {} });
      const governed = await asStaff(`${staffPath}/add`).set('Idempotency-Key', 'add-role-dialog-0007').send(addBody);
      expect([governed.status, governed.body.code]).toEqual([403, 'STAFF_MANAGEMENT_NOT_AVAILABLE']);
      expect(domainRows('identity.facility-staff.role-add').map((row) => (row as unknown as { details: { code: string } })
        .details.code)).toEqual(['VERSION_CONFLICT', 'IDEMPOTENCY_KEY_REUSED', 'STAFF_INVITATION_INVALID',
        'STAFF_INVITATION_ROLE_NOT_ALLOWED', 'FACILITY_STAFF_NOT_FOUND', 'STAFF_INVITATIONS_UNAVAILABLE', 'STAFF_RECENT_RECOVERY_HOLD', 'STAFF_MANAGEMENT_NOT_AVAILABLE']);
    });

    it('writes no denied row for a 5xx', async () => {
      handlers['identity.add_facility_staff_role'] = () => { throw databaseError('XX000', 'boom'); };
      const answer = await asStaff(`${staffPath}/add`).set('Idempotency-Key', 'add-role-dialog-0008').send(addBody);
      expect([answer.status, answer.body.code]).toEqual([503, 'STAFF_MANAGEMENT_UNAVAILABLE']);
      expect(domainRows('identity.facility-staff.role-add')).toEqual([]);
    });
  });

  describe('the administrator: remove', () => {
    it('answers 200 with the roles left and the grants revoked; not behind the staff-invitations gate', async () => {
      handlers['identity.remove_facility_staff_role'] = changed({ roles: ['nurse'], previous_roles: undefined,
        replayed: undefined, requests_closed: 1, grants_revoked: '2' });
      handlers['as invitations'] = () => ({ rows: [{ invitations: false, provider_portal: true, maintenance: false }] });
      const answer = await asStaff(`${staffPath}/remove`).send(removeBody);
      expect([answer.status, answer.body]).toEqual([200,
        { membershipId, version: 5, roles: ['nurse'], replayed: false, grantsRevoked: 2 }]);
      const [call] = sqlCalls('identity.remove_facility_staff_role');
      expect([call?.sql, call?.values]).toEqual([REMOVE_FACILITY_STAFF_ROLE_SQL,
        [membershipId, 5, 'lab', 'Moved to the ward full time']]);
      expect(sqlCalls('otp_challenges')).toEqual([]);
      expect(reauthentication.confirm).toHaveBeenCalled();
    });

    it('answers a retry 409 FACILITY_STAFF_ROLE_NOT_HELD and the last role 409 FACILITY_STAFF_LAST_ROLE, each with a denied row', async () => {
      handlers['identity.remove_facility_staff_role'] = () => { throw databaseError('P0001', 'FACILITY_STAFF_ROLE_NOT_HELD'); };
      const retry = await asStaff(`${staffPath}/remove`).send(removeBody);
      expect([retry.status, retry.body.code]).toEqual([409, 'FACILITY_STAFF_ROLE_NOT_HELD']);
      handlers['identity.remove_facility_staff_role'] = () => { throw databaseError('P0001', 'FACILITY_STAFF_LAST_ROLE'); };
      const last = await asStaff(`${staffPath}/remove`).send(removeBody);
      expect([last.status, last.body.code, last.body.detail]).toEqual([409, 'FACILITY_STAFF_LAST_ROLE',
        'This is the person\'s only role. To stop their access, remove them from the facility']);
      handlers['identity.remove_facility_staff_role'] = () => {
        throw databaseError('P0001', 'FACILITY_STAFF_ROLE_COLUMN_CONFLICT');
      };
      const column = await asStaff(`${staffPath}/remove`).send(removeBody);
      expect([column.status, column.body.code, column.body.detail]).toEqual([409, 'FACILITY_STAFF_ROLE_COLUMN_CONFLICT',
        'This role cannot be removed here. To change this person\'s roles, remove them from the facility and invite them again']);
      expect(domainRows('identity.facility-staff.role-remove')).toEqual([
        expect.objectContaining({ outcome: 'denied', details: { membershipId, roleCode: 'lab', code: 'FACILITY_STAFF_ROLE_NOT_HELD' } }),
        expect.objectContaining({ outcome: 'denied', details: { membershipId, roleCode: 'lab', code: 'FACILITY_STAFF_LAST_ROLE' } }),
        expect.objectContaining({ outcome: 'denied',
          details: { membershipId, roleCode: 'lab', code: 'FACILITY_STAFF_ROLE_COLUMN_CONFLICT' } }),
      ]);
    });

    it('takes no Idempotency-Key and refuses unknown fields', async () => {
      for (const body of [{ ...removeBody, licenceBody: 'MLSCN' }, { ...removeBody, role: 'admin' },
        { ...removeBody, reason: 'short' }, { ...removeBody, currentPassword: undefined }]) {
        const invalid = await asStaff(`${staffPath}/remove`).send(body);
        expect([invalid.status, invalid.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      }
    });
  });

  describe('support', () => {
    beforeEach(() => {
      tokens.verify.mockResolvedValue({ actor: support, claims: {} });
    });

    it('adds 201 with If-Match and an Idempotency-Key, and writes its success row in the transaction', async () => {
      handlers['identity.admin_add_facility_staff_role'] = changed();
      const answer = await asSupport(`${supportPath}/add`).set('If-Match', '"4"')
        .set('Idempotency-Key', 'support-add-role-0001').send(supportAddBody);
      expect([answer.status, answer.body]).toEqual([201,
        { membershipId, version: 5, roles: ['doctor', 'nurse'], replayed: false }]);
      const [call] = sqlCalls('identity.admin_add_facility_staff_role');
      expect([call?.sql, call?.transaction]).toEqual([ADMIN_ADD_FACILITY_STAFF_ROLE_SQL, 'platform']);
      expect(call?.values).toEqual([facilityId, membershipId, 4, 'nurse', 'NMCN', 'RN 7007', 'regulator_register',
        'Covers the governed ward', 'support-add-role-0001', requestDigest('admin.facility-staff.role-add', {
          facilityId, membershipId, expectedVersion: 4, role: 'nurse', licenceBody: 'NMCN', licenceNumber: 'RN 7007',
          verificationMethod: 'regulator_register', attested: true, reason: 'Covers the governed ward' })]);
      expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
      expect(domainRows('admin.facility-staff.role-add')).toEqual([expect.objectContaining({ outcome: 'success',
        actorType: 'platform', facilityId: undefined, resourceType: 'staff-membership', resourceId: membershipId,
        reason: 'Covers the governed ward', details: { facilityId, membershipId, roleCode: 'nurse', licenceBody: 'NMCN',
          verificationMethod: 'regulator_register', previousRoles: ['doctor'], roles: ['doctor', 'nurse'] } })]);
      expect(domainRows('api.admin.facility-staff.role-add.request')).toEqual([expect.objectContaining({
        outcome: 'success', actorType: 'platform' })]);
      expect(JSON.stringify(domainRows('admin.facility-staff.role-add'))).not.toContain('7007');
    });

    it('answers a replay 200 and writes no second success row', async () => {
      handlers['identity.admin_add_facility_staff_role'] = changed({ replayed: true });
      const answer = await asSupport(`${supportPath}/add`).set('If-Match', 'W/"4"')
        .set('Idempotency-Key', 'support-add-role-0001').send(supportAddBody);
      expect([answer.status, answer.body.replayed]).toEqual([200, true]);
      expect(audit.recordWithClient).not.toHaveBeenCalled();
    });

    it('needs If-Match, an Idempotency-Key and, for a licensed role only, how the licence was checked', async () => {
      handlers['identity.admin_add_facility_staff_role'] = changed();
      const noVersion = await asSupport(`${supportPath}/add`).set('Idempotency-Key', 'support-add-role-0002')
        .send(supportAddBody);
      expect([noVersion.status, noVersion.body.code]).toEqual([428, 'IF_MATCH_REQUIRED']);
      const noKey = await asSupport(`${supportPath}/add`).set('If-Match', '"4"').send(supportAddBody);
      expect([noKey.status, noKey.body.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
      for (const body of [{ ...supportAddBody, verificationMethod: undefined },
        { ...supportAddBody, verificationMethod: 'facility_attestation' },
        { role: 'receptionist', attested: true, verificationMethod: 'in_person', reason: 'Covers the governed desk' },
        { ...supportAddBody, currentPassword: 'secret pass' }, { ...supportAddBody, expectedVersion: 4 }]) {
        const invalid = await asSupport(`${supportPath}/add`).set('If-Match', '"4"')
          .set('Idempotency-Key', 'support-add-role-0002').send(body);
        expect([invalid.status, invalid.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      }
      const desk = await asSupport(`${supportPath}/add`).set('If-Match', '"4"').set('Idempotency-Key', 'support-add-role-0003')
        .send({ role: 'receptionist', attested: true, reason: 'Covers the governed desk' });
      expect(desk.status).toBe(201);
      expect(sqlCalls('identity.admin_add_facility_staff_role')[0]?.values.slice(3, 7)).toEqual(['receptionist', null, null, null]);
    });

    it('needs platform.facility-staff.manage; maps its own refusals', async () => {
      tokens.verify.mockResolvedValue({ actor: standaloneAdmin(['platform.admin.access', 'platform.principal.read']),
        claims: {} });
      const denied = await asSupport(`${supportPath}/add`).set('If-Match', '"4"')
        .set('Idempotency-Key', 'support-add-role-0004').send(supportAddBody);
      expect([denied.status, denied.body.code]).toEqual([403, 'PERMISSION_DENIED']);
      expect(sqlCalls('admin_add_facility_staff_role')).toEqual([]);
      tokens.verify.mockResolvedValue({ actor: support, claims: {} });
      for (const [error, status, code] of [
        [databaseError('P0002', 'ADMIN_FACILITY_NOT_FOUND'), 404, 'ADMIN_FACILITY_NOT_FOUND'],
        [databaseError('P0001', 'FACILITY_REVIEW_PENDING'), 409, 'FACILITY_REVIEW_PENDING'],
        [databaseError('42501', 'ADMIN_PERMISSION_DENIED'), 403, 'PERMISSION_DENIED'],
        [databaseError('P0001', 'FACILITY_STAFF_ADMINISTRATOR'), 409, 'FACILITY_STAFF_ADMINISTRATOR'],
      ] as [unknown, number, string][]) {
        handlers['identity.admin_add_facility_staff_role'] = () => { throw error; };
        const answer = await asSupport(`${supportPath}/add`).set('If-Match', '"4"')
          .set('Idempotency-Key', 'support-add-role-0005').send(supportAddBody);
        expect([answer.status, answer.body.code]).toEqual([status, code]);
        if (code === 'FACILITY_STAFF_ADMINISTRATOR') {
          // Support is pointed to 0086 S12's command, not told that support changes it.
          expect(answer.body.detail).toBe('This is a self-signed-up facility\'s administrator. Before review, set their '
            + 'role in the facility\'s review; after review, change it with the facility\'s administrator role');
        }
      }
      expect(audit.recordWithClient).not.toHaveBeenCalled();
    });

    it('removes 200, writes its success row once, and a replay none', async () => {
      handlers['identity.admin_remove_facility_staff_role'] = changed({ roles: ['nurse'], previous_roles: ['doctor', 'nurse'],
        requests_closed: '2', grants_revoked: 1 });
      const removed = await asSupport(`${supportPath}/remove`).set('If-Match', '"5"')
        .set('Idempotency-Key', 'support-remove-role-0001').send({ role: 'doctor', reason: 'Nursing only from now' });
      expect([removed.status, removed.body]).toEqual([200,
        { membershipId, version: 5, roles: ['nurse'], replayed: false, grantsRevoked: 1 }]);
      const [call] = sqlCalls('identity.admin_remove_facility_staff_role');
      expect([call?.sql, call?.values]).toEqual([ADMIN_REMOVE_FACILITY_STAFF_ROLE_SQL, [facilityId, membershipId, 5,
        'doctor', 'Nursing only from now', 'support-remove-role-0001', requestDigest('admin.facility-staff.role-remove',
          { facilityId, membershipId, expectedVersion: 5, role: 'doctor', reason: 'Nursing only from now' })]]);
      expect(domainRows('admin.facility-staff.role-remove')).toEqual([expect.objectContaining({ outcome: 'success',
        details: { facilityId, membershipId, roleCode: 'doctor', previousRoles: ['doctor', 'nurse'], roles: ['nurse'],
          requestsClosed: 2, grantsRevoked: 1 } })]);
      handlers['identity.admin_remove_facility_staff_role'] = changed({ roles: ['nurse'], replayed: true,
        grants_revoked: 1 });
      const replay = await asSupport(`${supportPath}/remove`).set('If-Match', '"5"')
        .set('Idempotency-Key', 'support-remove-role-0001').send({ role: 'doctor', reason: 'Nursing only from now' });
      expect([replay.status, replay.body.replayed, replay.body.grantsRevoked]).toEqual([200, true, 1]);
      expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
    });
  });
});
