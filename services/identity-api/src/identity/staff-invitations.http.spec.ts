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
import { TurnstileService } from '../auth/turnstile.service';
import { AUDIT_ACTION, AUDIT_FAILURES_ONLY, FACILITY_OPTIONAL, NO_AUDIT, PUBLIC_ROUTE,
  REQUIRED_PERMISSIONS } from '../common/decorators';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, FacilityAssignment, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { AdminFacilityStaffController } from './admin-facility-staff.controller';
import { FacilityStaffController } from './facility-staff.controller';
import { FacilityStaffService } from './facility-staff.service';
import { StaffInvitationsPublicController } from './staff-invitations-public.controller';
import { StaffInvitationsSignedInController } from './staff-invitations-signed-in.controller';
import { StaffInvitationsService } from './staff-invitations.service';
import { StaffReauthenticationService } from './staff-reauthentication.service';

const origin = 'https://app.healthidentitydirectory.com';
const facilityId = '10000000-0000-4000-8000-000000000002';
const invitationId = '3f2a9c1b-7d4e-4a5b-8c6d-0e1f2a3b4c5d';
const membershipId = '40000000-0000-4000-8000-000000000009';
const token = 'Ab3_-Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LzXcVbNm';

function assignment(review?: 'pending' | 'reviewed', permissions = ['workforce.manage', 'audit.read']): FacilityAssignment {
  return { id: facilityId, membershipId: '40000000-0000-4000-8000-000000000001',
    organizationId: '10000000-0000-4000-8000-000000000001', name: 'Synthetic Clinic Ltd', roles: ['org_admin'],
    permissions, isPrimary: true, ...(review ? { selfService: { review, organizationType: 'hospital' as const } } : {}) };
}
function staff(facility: FacilityAssignment = assignment('reviewed'), overrides: Partial<ActorContext> = {}): ActorContext {
  return { kind: 'staff', id: 'staff:administrator', subject: 'staff:administrator',
    accountId: '20000000-0000-4000-8000-000000000001', email: 'admin@example.test', displayName: 'Ada Obi',
    roles: facility.roles, permissions: facility.permissions, platformRoles: [], platformPermissions: [],
    facilityIds: [facility.id], facilities: [facility], facility, authenticationMethod: 'local', ...overrides };
}
const standaloneAdmin = (platformPermissions: string[]): ActorContext => ({ kind: 'staff', id: 'standalone:administrator',
  subject: 'standalone:administrator', accountId: 'e0000000-0000-4000-8000-000000000086', roles: [], permissions: [],
  platformRoles: ['platform_super_admin'], platformPermissions, facilityIds: [], facilities: [], authenticationMethod: 'local' });

const meta = (key: symbol, target: object) => Reflect.getMetadata(key, target) as unknown;

describe('facility staff routes: metadata (SPEC 6.1, 6.6)', () => {
  it('staff routes need workforce.manage at the X-Facility-ID facility and are audited at it', () => {
    const routes = FacilityStaffController.prototype;
    expect(meta(FACILITY_OPTIONAL, FacilityStaffController)).toBeUndefined();
    expect(meta(PUBLIC_ROUTE, FacilityStaffController)).toBeUndefined();
    expect(meta(AUDIT_FAILURES_ONLY, FacilityStaffController)).toBeUndefined();
    expect(meta(NO_AUDIT, FacilityStaffController)).toBeUndefined();
    const expected: Record<string, string> = {
      list: 'identity.facility-staff.list', administratorLicence: 'identity.facility-staff.administrator-licence',
      create: 'identity.staff-invitation.create', resend: 'identity.staff-invitation.resend',
      revoke: 'identity.staff-invitation.revoke', end: 'identity.facility-staff.end',
      changeRole: 'identity.facility-staff.role-change',
    };
    for (const [handler, action] of Object.entries(expected)) {
      const method = (routes as unknown as Record<string, object>)[handler] as object;
      expect(meta(REQUIRED_PERMISSIONS, method)).toEqual(['workforce.manage']);
      expect(meta(AUDIT_ACTION, method)).toBe(action);
      expect(meta(FACILITY_OPTIONAL, method)).toBeUndefined();
    }
  });

  it('signed-in routes: a session with no facility, no permission and no interceptor row (S5)', () => {
    expect(meta(FACILITY_OPTIONAL, StaffInvitationsSignedInController)).toBe(true);
    expect(meta(NO_AUDIT, StaffInvitationsSignedInController)).toBe(true);
    expect(meta(PUBLIC_ROUTE, StaffInvitationsSignedInController)).toBeUndefined();
    for (const method of [StaffInvitationsSignedInController.prototype.preview, StaffInvitationsSignedInController.prototype.accept]) {
      expect(meta(REQUIRED_PERMISSIONS, method)).toBeUndefined();
    }
  });

  it('public routes: accountless, failures audited only', () => {
    expect(meta(PUBLIC_ROUTE, StaffInvitationsPublicController)).toBe(true);
    expect(meta(AUDIT_FAILURES_ONLY, StaffInvitationsPublicController)).toBe(true);
    expect(meta(AUDIT_ACTION, StaffInvitationsPublicController.prototype.open)).toBe('identity.staff-invitation.open');
    expect(meta(AUDIT_ACTION, StaffInvitationsPublicController.prototype.accept)).toBe('identity.staff-invitation.accept');
  });

  it('support\'s reads: facility optional, platform.principal.read, success audited too (FEA R2)', () => {
    expect(meta(FACILITY_OPTIONAL, AdminFacilityStaffController)).toBe(true);
    expect(meta(AUDIT_FAILURES_ONLY, AdminFacilityStaffController)).toBeUndefined();
    expect(meta(REQUIRED_PERMISSIONS, AdminFacilityStaffController.prototype.facilityStaff)).toEqual(['platform.principal.read']);
    expect(meta(REQUIRED_PERMISSIONS, AdminFacilityStaffController.prototype.findInvitations)).toEqual(['platform.principal.read']);
    expect(meta(AUDIT_ACTION, AdminFacilityStaffController.prototype.facilityStaff)).toBe('admin.facility-staff.read');
    expect(meta(AUDIT_ACTION, AdminFacilityStaffController.prototype.findInvitations)).toBe('admin.staff-invitations.find');
  });
});

describe('facility staff routes over HTTP', () => {
  const originalEnvironment = { ...process.env };
  let app: INestApplication;
  const handlers: Record<string, (values: unknown[]) => unknown> = {};
  const calls: { sql: string; values: unknown[] }[] = [];
  const respond = jest.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    for (const [needle, handler] of Object.entries(handlers)) if (sql.includes(needle)) return handler(values);
    if (sql.includes('platform.control_enabled($1)')) return { rows: [{ enabled: values[0] !== 'maintenance_mode' }] };
    if (sql.includes('platform.control_enabled')) return { rows: [{ invitations: true, provider_portal: true, maintenance: false }] };
    if (sql.includes('otp_challenges')) return { rows: [{ held: false }] };
    return { rows: [] };
  });
  const database = {
    query: respond,
    withTransaction: jest.fn(async (_context: unknown, work: (client: unknown) => Promise<unknown>) => work({ query: respond })),
    withSystemTransaction: jest.fn(async (_correlation: unknown, work: (client: unknown) => Promise<unknown>) => work({ query: respond })),
    withPlatformTransaction: jest.fn(async (_context: unknown, work: (client: unknown) => Promise<unknown>) => work({ query: respond })),
  };
  const tokens = { verify: jest.fn(), verifyCsrf: jest.fn() };
  const audit = { record: jest.fn() };
  const turnstile = { verify: jest.fn() };
  const notification = { deliverStaffInvitation: jest.fn() };
  const reauthentication = { confirm: jest.fn() };
  const sqlCalls = (needle: string) => calls.filter((call) => call.sql.includes(needle));

  beforeEach(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: `${origin},https://ehr.healthidentitydirectory.com,https://admin.healthidentitydirectory.com`,
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
    turnstile.verify.mockResolvedValue(undefined);
    notification.deliverStaffInvitation.mockResolvedValue({ outcome: 'accepted' });
    reauthentication.confirm.mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [StaffInvitationsSignedInController, StaffInvitationsPublicController, FacilityStaffController,
        AdminFacilityStaffController],
      providers: [
        StaffInvitationsService, FacilityStaffService,
        { provide: StaffReauthenticationService, useValue: reauthentication },
        { provide: DatabaseService, useValue: database },
        { provide: NotificationOtpClient, useValue: notification },
        { provide: TurnstileService, useValue: turnstile },
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
  const auditedActions = () => audit.record.mock.calls.map(([event]) => (event as { action: string }).action);

  describe('public: open and accept', () => {
    const openBody = { invitationId, token, turnstileAction: 'staff-invitation', turnstileToken: 'proof' };
    const ready = { result: 'ready', invitation_id: invitationId, facility_name: 'Synthetic Clinic Ltd', role_code: 'nurse',
      inviter_name: 'Ada Obi', invitee_name: 'Bola Adeyemi', invitee_email: 'bola@example.test',
      expires_at: '2026-11-01T13:35:00Z', account_case: 'new', link_required: false, session_expires_at: '2026-10-25T14:35:00Z' };

    it('validates first, then Origin, then the signed-in check, then Turnstile, then the gate (FEA R3)', async () => {
      const invalid = await request(server()).post('/api/v1/identity/staff-invitations/open')
        .set('Origin', 'https://attacker.example').set('Cookie', 'hid_access_csrf=x').send({ ...openBody, token: 'short' });
      expect([invalid.status, invalid.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      const noOrigin = await request(server()).post('/api/v1/identity/staff-invitations/open')
        .set('Cookie', 'hid_access_csrf=x').send(openBody);
      expect([noOrigin.status, noOrigin.body.code]).toEqual([403, 'ORIGIN_DENIED']);
      const signedIn = await request(server()).post('/api/v1/identity/staff-invitations/open').set('Origin', origin)
        .set('Cookie', 'hid_access_csrf=x').send(openBody);
      expect([signedIn.status, signedIn.body.code]).toEqual([409, 'STAFF_INVITATION_REQUIRES_SIGN_OUT']);
      expect(turnstile.verify).not.toHaveBeenCalled();
      turnstile.verify.mockRejectedValueOnce(new DomainProblem(403, 'TURNSTILE_CONTEXT_MISMATCH', 'x'));
      const wrongHost = await request(server()).post('/api/v1/identity/staff-invitations/open').set('Origin', origin).send(openBody);
      expect([wrongHost.status, wrongHost.body.code]).toEqual([403, 'TURNSTILE_CONTEXT_MISMATCH']);
      expect(calls).toHaveLength(0);
      handlers['platform.control_enabled'] = () => ({ rows: [{ invitations: false, provider_portal: true, maintenance: false }] });
      const closed = await request(server()).post('/api/v1/identity/staff-invitations/open').set('Origin', origin).send(openBody);
      expect([closed.status, closed.body.code]).toEqual([423, 'STAFF_INVITATIONS_UNAVAILABLE']);
      expect(turnstile.verify).toHaveBeenLastCalledWith({ token: 'proof', action: 'staff-invitation', origin,
        remoteIp: expect.any(String) });
      // Nothing counted while closed.
      expect(sqlCalls('otp_rate')).toHaveLength(0);
      // Failures are audited by the interceptor, with no actor and no facility.
      expect(auditedActions().filter((action) => action === 'api.identity.staff-invitation.open').length).toBeGreaterThan(0);
    });

    it('sets the acceptance cookie for a new account: HttpOnly, SameSite=Strict, Secure, its path, 1 hour, host-only', async () => {
      handlers['identity.open_staff_invitation'] = () => ({ rows: [ready] });
      const answer = await request(server()).post('/api/v1/identity/staff-invitations/open').set('Origin', origin).send(openBody);
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({ invitationId, facilityName: 'Synthetic Clinic Ltd', roleCode: 'nurse',
        inviterName: 'Ada Obi', inviteeName: 'Bola Adeyemi', email: 'bola@example.test',
        expiresAt: '2026-11-01T13:35:00.000Z', accountCase: 'new', linkRequired: false });
      const cookies = answer.headers['set-cookie'] as unknown as string[];
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toMatch(/^hid_staff_invitation=[A-Za-z0-9_-]{43}; Max-Age=3600; Path=\/api\/v1\/identity\/staff-invitations; Expires=[^;]+; HttpOnly; Secure; SameSite=Strict$/);
      expect(cookies[0]).not.toContain('Domain=');
      // Success is not audited by the interceptor (the command writes its own row).
      expect(auditedActions()).not.toContain('api.identity.staff-invitation.open');
    });

    it('sets no cookie for an existing account', async () => {
      handlers['identity.open_staff_invitation'] = () => ({ rows: [{ ...ready, account_case: 'existing_staff',
        session_expires_at: null }] });
      const answer = await request(server()).post('/api/v1/identity/staff-invitations/open').set('Origin', origin).send(openBody);
      expect([answer.status, answer.body.accountCase]).toEqual([200, 'existing_staff']);
      expect(answer.headers['set-cookie']).toBeUndefined();
    });

    it('accepts with the cookie read once, clears it and issues no session cookie', async () => {
      handlers['prepare_staff_invitation_acceptance'] = () => ({ rows: [{ result: 'ready', account_case: 'new' }] });
      handlers['accept_staff_invitation_with_password'] = () => ({ rows: [{ account_id: 'a', membership_id: 'm',
        organization_id: 'o', facility_id: facilityId, facility_name: 'Synthetic Clinic Ltd', role_code: 'nurse',
        account_case: 'new' }] });
      const answer = await request(server()).post('/api/v1/identity/staff-invitations/accept').set('Origin', origin)
        .set('Cookie', `hid_staff_invitation=${token}`).send({ password: 'a long new password' });
      expect([answer.status, answer.body]).toEqual([200, { accepted: true, facilityName: 'Synthetic Clinic Ltd', roleCode: 'nurse' }]);
      const cookies = answer.headers['set-cookie'] as unknown as string[];
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toMatch(/^hid_staff_invitation=; Path=\/api\/v1\/identity\/staff-invitations; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict$/);
      expect(answer.headers['x-csrf-token']).toBeUndefined();
      // Two copies of the cookie: no session, 401, no database call.
      calls.length = 0;
      const twice = await request(server()).post('/api/v1/identity/staff-invitations/accept').set('Origin', origin)
        .set('Cookie', `hid_staff_invitation=${token}; hid_staff_invitation=${token}`).send({ password: 'a long new password' });
      expect([twice.status, twice.body.code]).toEqual([401, 'STAFF_INVITATION_SESSION_INVALID']);
      expect(sqlCalls('prepare_staff_invitation_acceptance')).toHaveLength(0);
    });

    it('refuses accept: weak password 400, signed in 409, closed 423, before the cookie is read', async () => {
      const weak = await request(server()).post('/api/v1/identity/staff-invitations/accept').set('Origin', origin)
        .set('Cookie', `hid_staff_invitation=${token}`).send({ password: 'short' });
      expect([weak.status, weak.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      const signedIn = await request(server()).post('/api/v1/identity/staff-invitations/accept').set('Origin', origin)
        .set('Cookie', `hid_access=x; hid_staff_invitation=${token}`).send({ password: 'a long new password' });
      expect([signedIn.status, signedIn.body.code]).toEqual([409, 'STAFF_INVITATION_REQUIRES_SIGN_OUT']);
      handlers['platform.control_enabled'] = () => ({ rows: [{ invitations: true, provider_portal: true, maintenance: true }] });
      const closed = await request(server()).post('/api/v1/identity/staff-invitations/accept').set('Origin', origin)
        .set('Cookie', `hid_staff_invitation=${token}`).send({ password: 'a long new password' });
      expect([closed.status, closed.body.code]).toEqual([423, 'STAFF_INVITATIONS_UNAVAILABLE']);
      expect(sqlCalls('prepare_staff_invitation_acceptance')).toHaveLength(0);
    });
  });

  describe('signed in: preview and accept on the person\'s own host', () => {
    beforeEach(() => {
      // A doctor at another facility: no workforce.manage, and no X-Facility-ID sent.
      tokens.verify.mockResolvedValue({ actor: staff(assignment(undefined, ['ehr.encounter.read'])), claims: {} });
      handlers['preview_staff_invitation_for_account'] = () => ({ rows: [{ result: 'ready', invitation_id: invitationId,
        facility_id: facilityId, facility_name: 'Synthetic Clinic Ltd', role_code: 'nurse', inviter_name: 'Ada Obi',
        expires_at: '2026-11-01T13:35:00Z' }] });
      handlers['accept_staff_invitation_for_account'] = () => ({ rows: [{ result: 'ready', membership_id: membershipId,
        facility_id: facilityId, facility_name: 'Synthetic Clinic Ltd', role_code: 'nurse' }] });
    });

    it('previews and accepts with no facility, no permission and no interceptor row; the context has no facility', async () => {
      const preview = await request(server()).post('/api/v1/identity/staff-invitations/signed-in/preview')
        .set('Authorization', 'Bearer synthetic').send({ invitationId, token });
      expect([preview.status, preview.body.facilityName]).toEqual([200, 'Synthetic Clinic Ltd']);
      const accept = await request(server()).post('/api/v1/identity/staff-invitations/signed-in/accept')
        .set('Authorization', 'Bearer synthetic').send({ code: '048213' });
      expect([accept.status, accept.body]).toEqual([200, { accepted: true, facilityId, membershipId,
        facilityName: 'Synthetic Clinic Ltd', roleCode: 'nurse' }]);
      const contexts = database.withTransaction.mock.calls.map(([context]) => context as Record<string, unknown>);
      expect(contexts).toHaveLength(2);
      for (const context of contexts) {
        expect(context).toMatchObject({ facilityId: '', membershipId: '', purposeOfUse: 'healthcare-operations' });
      }
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('refuses a refused invitation with its code and still writes no interceptor row', async () => {
      handlers['accept_staff_invitation_for_account'] = () => ({ rows: [{ result: 'email_mismatch' }] });
      const refused = await request(server()).post('/api/v1/identity/staff-invitations/signed-in/accept')
        .set('Authorization', 'Bearer synthetic').send({ invitationId, token });
      expect([refused.status, refused.body.code]).toEqual([409, 'STAFF_INVITATION_EMAIL_MISMATCH']);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('needs CSRF for a cookie session, and refuses a patient session', async () => {
      tokens.verifyCsrf.mockReturnValue(false);
      const noCsrf = await request(server()).post('/api/v1/identity/staff-invitations/signed-in/accept')
        .set('Cookie', 'hid_access=session').set('Origin', 'https://ehr.healthidentitydirectory.com').send({ code: '048213' });
      expect([noCsrf.status, noCsrf.body.code]).toEqual([403, 'CSRF_VALIDATION_FAILED']);
      tokens.verify.mockResolvedValue({ actor: { ...staff(), kind: 'patient', patientId: 'p' }, claims: {} });
      const patient = await request(server()).post('/api/v1/identity/staff-invitations/signed-in/preview')
        .set('Authorization', 'Bearer synthetic').send({ code: '048213' });
      expect([patient.status, patient.body.code]).toEqual([403, 'PATIENT_SCOPE_DENIED']);
      expect(sqlCalls('_for_account')).toHaveLength(0);
    });
  });

  describe('staff: the administrator\'s routes', () => {
    const invite = { name: 'Bola Adeyemi', email: 'bola@example.test', role: 'receptionist', attested: true,
      currentPassword: 'secret pass' };

    it('needs X-Facility-ID and workforce.manage', async () => {
      const noFacility = await request(server()).get('/api/v1/identity/facility-staff').set('Authorization', 'Bearer synthetic');
      expect([noFacility.status, noFacility.body.code]).toEqual([400, 'FACILITY_REQUIRED']);
      tokens.verify.mockResolvedValue({ actor: staff(assignment('reviewed', ['ehr.encounter.read'])), claims: {} });
      const noPermission = await request(server()).get('/api/v1/identity/facility-staff')
        .set('Authorization', 'Bearer synthetic').set('X-Facility-ID', facilityId);
      expect([noPermission.status, noPermission.body.code]).toEqual([403, 'PERMISSION_DENIED']);
      expect(database.withTransaction).not.toHaveBeenCalled();
    });

    it('answers a governed administrator 403 STAFF_MANAGEMENT_NOT_AVAILABLE and audits it at the facility', async () => {
      tokens.verify.mockResolvedValue({ actor: staff(assignment(undefined)), claims: {} });
      const answer = await request(server()).get('/api/v1/identity/facility-staff')
        .set('Authorization', 'Bearer synthetic').set('X-Facility-ID', facilityId);
      expect([answer.status, answer.body.code]).toEqual([403, 'STAFF_MANAGEMENT_NOT_AVAILABLE']);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'api.identity.facility-staff.list',
        outcome: 'failure', facilityId, actorType: 'staff' }));
    });

    it('creates 201, and answers a replay 200; requires an Idempotency-Key', async () => {
      handlers['identity.create_staff_invitation'] = () => ({ rows: [{ invitation_id: invitationId, row_version: 1,
        send_id: 'e0000000-0000-4000-8000-000000000001', expires_at: '2026-11-01T13:35:00Z', replayed: false, dispatch: true,
        facility_name: 'Synthetic Clinic Ltd', role_code: 'receptionist', invitee_email: 'bola@example.test' }] });
      const noKey = await request(server()).post('/api/v1/identity/staff-invitations').set('Authorization', 'Bearer synthetic')
        .set('X-Facility-ID', facilityId).send(invite);
      expect([noKey.status, noKey.body.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
      const created = await request(server()).post('/api/v1/identity/staff-invitations').set('Authorization', 'Bearer synthetic')
        .set('X-Facility-ID', facilityId).set('Idempotency-Key', 'invite-dialog-0001').send(invite);
      expect([created.status, created.body]).toEqual([201, { invitationId, version: 1, expiresAt: '2026-11-01T13:35:00.000Z',
        deliveryOutcome: 'accepted', replayed: false }]);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'api.identity.staff-invitation.create',
        outcome: 'success', facilityId }));
      // The password never reaches an audit row.
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain('secret pass');
      handlers['identity.create_staff_invitation'] = () => ({ rows: [{ invitation_id: invitationId, row_version: 2,
        send_id: 'x', expires_at: '2026-11-01T13:35:00Z', replayed: true, dispatch: false, facility_name: 'x',
        role_code: 'receptionist', invitee_email: 'bola@example.test' }] });
      const replay = await request(server()).post('/api/v1/identity/staff-invitations').set('Authorization', 'Bearer synthetic')
        .set('X-Facility-ID', facilityId).set('Idempotency-Key', 'invite-dialog-0001').send(invite);
      expect([replay.status, replay.body.replayed, replay.body.deliveryOutcome]).toEqual([200, true, 'unknown']);
      expect(notification.deliverStaffInvitation).toHaveBeenCalledTimes(1);
    });

    it('takes uuid v4 ids and the version in the body', async () => {
      const badId = await request(server()).post('/api/v1/identity/staff-invitations/not-a-uuid/revoke')
        .set('Authorization', 'Bearer synthetic').set('X-Facility-ID', facilityId).send({ expectedVersion: 1 });
      expect(badId.status).toBe(400);
      const noVersion = await request(server()).post(`/api/v1/identity/facility-staff/${membershipId}/end`)
        .set('Authorization', 'Bearer synthetic').set('X-Facility-ID', facilityId)
        .send({ reason: 'Left the hospital', currentPassword: 'p' });
      expect([noVersion.status, noVersion.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      handlers['revoke_staff_invitation'] = () => ({ rows: [{ row_version: 2, revoked_at: '2026-10-26T10:00:00Z' }] });
      const revoked = await request(server()).post(`/api/v1/identity/staff-invitations/${invitationId}/revoke`)
        .set('Authorization', 'Bearer synthetic').set('X-Facility-ID', facilityId).send({ expectedVersion: 1 });
      expect([revoked.status, revoked.body]).toEqual([200, { version: 2, revokedAt: '2026-10-26T10:00:00.000Z' }]);
    });

    it('records the pending administrator\'s own licence', async () => {
      tokens.verify.mockResolvedValue({ actor: staff(assignment('pending')), claims: {} });
      handlers['record_self_service_administrator_licence'] = () => ({ rows: [{ licence_body: 'MDCN', number_hint: '2345',
        recorded_at: '2026-10-24T09:00:00Z' }] });
      const recorded = await request(server()).post('/api/v1/identity/facility-staff/administrator-licence')
        .set('Authorization', 'Bearer synthetic').set('X-Facility-ID', facilityId)
        .send({ licenceBody: 'MDCN', licenceNumber: 'MDCN/12345' });
      expect([recorded.status, recorded.body]).toEqual([200, { licenceBody: 'MDCN', numberHint: '2345',
        recordedAt: '2026-10-24T09:00:00.000Z' }]);
    });
  });

  describe('support', () => {
    beforeEach(() => {
      tokens.verify.mockResolvedValue({ actor: standaloneAdmin(['platform.admin.access', 'platform.principal.read']), claims: {} });
    });

    it('reads a facility\'s staff as a standalone administrator, audited on success as a platform row', async () => {
      handlers['from identity.facilities facility'] = () => ({ rows: [{ id: facilityId, name: 'Synthetic Clinic Ltd',
        review_state: 'reviewed', organization_type: 'hospital', product_code: 'ehr' }] });
      const answer = await request(server()).get(`/api/v1/admin/facilities/${facilityId}/staff`)
        .set('Authorization', 'Bearer synthetic');
      expect([answer.status, answer.body.facility.selfService.review]).toEqual([200, 'reviewed']);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'api.admin.facility-staff.read',
        outcome: 'success', actorType: 'platform', facilityId: undefined }));
    });

    it('finds an invitation by reference; refuses a malformed one 400 and a missing permission 403', async () => {
      handlers['admin_find_staff_invitations'] = () => ({ rows: [] });
      const found = await request(server()).get('/api/v1/admin/staff-invitations?reference=3f2a9c1b')
        .set('Authorization', 'Bearer synthetic');
      expect([found.status, found.body]).toEqual([200, { items: [] }]);
      expect(sqlCalls('admin_find_staff_invitations')[0]?.values).toEqual(['3F2A9C1B']);
      for (const query of ['reference=3F2A9C1', 'reference=3F2A9C1BX', 'reference=GGGGGGGG', '', 'reference=3F2A9C1B&x=1']) {
        const invalid = await request(server()).get(`/api/v1/admin/staff-invitations?${query}`).set('Authorization', 'Bearer synthetic');
        expect([invalid.status, invalid.body.code]).toEqual([400, 'VALIDATION_FAILED']);
      }
      tokens.verify.mockResolvedValue({ actor: standaloneAdmin(['platform.admin.access']), claims: {} });
      const denied = await request(server()).get('/api/v1/admin/staff-invitations?reference=3F2A9C1B')
        .set('Authorization', 'Bearer synthetic');
      expect([denied.status, denied.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    });
  });
});
