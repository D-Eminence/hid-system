import { UnauthorizedException } from '@nestjs/common';
import type { AuthSessionAuditService } from '../auth/auth-session-audit.service';
import type { LocalAuthProvider } from '../auth/local-auth.provider';
import type { ActorContext, DataAccessContext, FacilityAssignment, HidRequest,
  PlatformAdminContext } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { FacilityStaffService } from './facility-staff.service';
import { STAFF_ATTESTATION_VERSION, StaffInvitationsService } from './staff-invitations.service';
import { StaffReauthenticationService } from './staff-reauthentication.service';

const facilityId = '10000000-0000-4000-8000-000000000002';
const membershipId = '40000000-0000-4000-8000-000000000009';

function staffContext(review?: 'pending' | 'reviewed'): DataAccessContext {
  const assignment: FacilityAssignment = { id: facilityId, membershipId: '40000000-0000-4000-8000-000000000001',
    organizationId: '10000000-0000-4000-8000-000000000001', name: 'Synthetic Clinic Ltd', roles: ['org_admin'],
    permissions: ['workforce.manage'], isPrimary: true,
    ...(review ? { selfService: { review, organizationType: 'hospital' as const } } : {}) };
  const actor: ActorContext = { kind: 'staff', id: 'staff:administrator', subject: 'staff:administrator',
    accountId: '20000000-0000-4000-8000-000000000001', email: 'admin@example.test', roles: assignment.roles,
    permissions: assignment.permissions, facilityIds: [facilityId], facilities: [assignment], facility: assignment,
    authenticationMethod: 'local' };
  return { actor, facilityId, membershipId: assignment.membershipId, correlationId: 'facility-staff-test',
    purposeOfUse: 'healthcare-operations' };
}

const httpRequest = { correlationId: 'facility-staff-test', ip: '203.0.113.9',
  header: () => 'synthetic-agent' } as unknown as HidRequest;

const stateRow = {
  facility_id: facilityId, facility_name: 'Synthetic Clinic Ltd', organization_type: 'hospital', product_code: 'ehr',
  review_state: 'reviewed', on_probation: true, probation_ends_at: new Date('2026-11-24T10:00:00.000Z'),
  invitations_open: true, pending_count: '2', invitations_last_day: '3', emails_last_day: 4, delivery_paused: false,
  invitable_roles: ['doctor', 'nurse', 'lab', 'pharmacist', 'receptionist'], attestation_version: STAFF_ATTESTATION_VERSION,
  attestation_text: 'I confirm that {name} works at {facility} …', administrator_licence_body: 'MDCN',
  administrator_licence_hint: '2345', administrator_licence_recorded_at: '2026-10-24T09:00:00Z',
  reviewable_licence_bodies: ['MDCN', 'NMCN'], pending_limit: 100, invitations_per_day: 10, emails_per_day: 20,
  recipient_invitations_per_30_days: 3, recipient_emails_per_30_days: 8, recipient_emails_per_day_all_facilities: 5,
  delivery_failures_pause: 10, sends_per_invitation: 5, resend_cooldown_seconds: 60, validity_days: 7,
};
const memberRows = [
  { membership_id: '40000000-0000-4000-8000-000000000001', row_version: '3', account_id: 'admin', display_name: 'Ada Obi',
    email: 'admin@example.test', roles: ['org_admin', 'doctor'], is_administrator: true, is_self: true,
    joined_at: new Date('2026-10-24T08:00:00.000Z'), licence_body: 'MDCN', licence_number_hint: '2345',
    vouched_by_name: 'Health ID support', vouched_at: '2026-10-25T08:00:00Z', verification_method: 'platform_review' },
  { membership_id: membershipId, row_version: 1, account_id: 'receptionist', display_name: 'Bola Adeyemi',
    email: 'bola@example.test', roles: ['receptionist'], is_administrator: false, is_self: false, joined_at: '2026-10-26T08:00:00Z',
    licence_body: null, licence_number_hint: null, vouched_by_name: null, vouched_at: null, verification_method: null },
];
const invitationRows = [
  { invitation_id: '3f2a9c1b-7d4e-4a5b-8c6d-0e1f2a3b4c5d', row_version: '1', reference: '3F2A9C1B', invitee_name: 'Chidi Eze',
    invitee_email: 'chidi@example.test', role_code: 'nurse', licence_body: 'NMCN', licence_number_hint: '0042',
    status: 'pending', invited_by_name: 'Ada Obi', created_at: '2026-10-26T09:00:00Z', last_sent_at: '2026-10-26T09:00:00Z',
    expires_at: '2026-11-02T09:00:00Z', send_count: '1', delivery_outcome: 'accepted', resend_available_at: '2026-10-26T09:01:00Z' },
];

function harness(handlers: Record<string, (values: unknown[]) => unknown> = {}) {
  const calls: { sql: string; values: unknown[]; transaction: string; options?: unknown }[] = [];
  const respond = (transaction: string, options?: unknown) => jest.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values, transaction, options });
    for (const [needle, handler] of Object.entries(handlers)) if (sql.includes(needle)) return handler(values);
    if (sql.includes('otp_challenges')) return { rows: [{ held: false }] };
    if (sql.includes('platform.control_enabled')) return { rows: [{ invitations: true, provider_portal: true, maintenance: false }] };
    return { rows: [] };
  });
  const database = {
    query: respond('none'),
    withTransaction: jest.fn(async (_context: unknown, work: (client: unknown) => Promise<unknown>, options?: unknown) =>
      work({ query: respond('staff', options) })),
    withPlatformTransaction: jest.fn(async (_context: unknown, work: (client: unknown) => Promise<unknown>, options?: unknown) =>
      work({ query: respond('platform', options) })),
    withSystemTransaction: jest.fn(),
  };
  const local = { authenticate: jest.fn(async () => ({ accountId: '20000000-0000-4000-8000-000000000001' })) };
  const sessionAudit = { recordLoginFailure: jest.fn(async () => undefined) };
  const reauthentication = new StaffReauthenticationService(local as unknown as LocalAuthProvider,
    sessionAudit as unknown as AuthSessionAuditService);
  const invitations = new StaffInvitationsService(database as unknown as DatabaseService,
    { deliverStaffInvitation: jest.fn() } as never, reauthentication);
  const service = new FacilityStaffService(database as unknown as DatabaseService, invitations, reauthentication);
  const sqlCalls = (needle: string) => calls.filter((call) => call.sql.includes(needle));
  return { service, database, local, sessionAudit, calls, sqlCalls };
}

describe('FacilityStaffService', () => {
  const original = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://ehr.healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901', AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456' });
    resetEnvironmentForTests();
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  describe('the Staff page', () => {
    it('reads state, members and invitations in one read-only transaction and answers SPEC 6.3\'s shape', async () => {
      const { service, database, sqlCalls } = harness({
        'facility_staff_management_state': () => ({ rows: [stateRow] }),
        'identity.list_facility_staff()': () => ({ rows: memberRows }),
        'list_facility_staff_invitations': () => ({ rows: invitationRows }),
      });
      const answer = await service.list(staffContext('reviewed'));
      expect(database.withTransaction).toHaveBeenCalledTimes(1);
      expect(database.withTransaction.mock.calls[0]?.[2]).toEqual({ readOnly: true });
      expect(sqlCalls('facility_staff_management_state')[0]?.sql).toBe('select * from identity.facility_staff_management_state()');
      expect(sqlCalls('identity.list_facility_staff()')[0]?.sql).toBe('select * from identity.list_facility_staff()');
      expect(sqlCalls('list_facility_staff_invitations')[0]?.sql).toBe('select * from identity.list_facility_staff_invitations()');
      expect(answer).toEqual({
        facility: { id: facilityId, name: 'Synthetic Clinic Ltd', organizationType: 'hospital', reviewState: 'reviewed',
          firstThirtyDaysEndAt: '2026-11-24T10:00:00.000Z', invitationsOpen: true, deliveryPaused: false },
        canInvite: true,
        limits: { pendingInvitations: 2, pendingLimit: 100, invitationsToday: 3, invitationsPerDay: 10, emailsToday: 4,
          emailsPerDay: 20 },
        inviteOptions: {
          roles: [{ code: 'doctor', licenceBody: 'MDCN' }, { code: 'nurse', licenceBody: 'NMCN' },
            { code: 'lab', licenceBody: 'MLSCN' }, { code: 'pharmacist', licenceBody: 'PCN' },
            { code: 'receptionist', licenceBody: null }],
          attestation: { version: STAFF_ATTESTATION_VERSION, text: 'I confirm that {name} works at {facility} …' },
        },
        administratorLicence: { body: 'MDCN', numberHint: '2345', recordedAt: '2026-10-24T09:00:00.000Z' },
        administratorLicenceBodies: ['MDCN', 'NMCN'],
        members: [
          { membershipId: '40000000-0000-4000-8000-000000000001', version: 3, accountId: 'admin', name: 'Ada Obi',
            email: 'admin@example.test', roles: ['org_admin', 'doctor'], isAdministrator: true, isSelf: true,
            joinedAt: '2026-10-24T08:00:00.000Z', licence: { body: 'MDCN', numberHint: '2345', vouchedBy: 'Health ID support',
              vouchedAt: '2026-10-25T08:00:00.000Z', method: 'platform_review' } },
          { membershipId, version: 1, accountId: 'receptionist', name: 'Bola Adeyemi', email: 'bola@example.test',
            roles: ['receptionist'], isAdministrator: false, isSelf: false, joinedAt: '2026-10-26T08:00:00.000Z', licence: null },
        ],
        invitations: [{ invitationId: '3f2a9c1b-7d4e-4a5b-8c6d-0e1f2a3b4c5d', version: 1, reference: '3F2A9C1B',
          name: 'Chidi Eze', email: 'chidi@example.test', roleCode: 'nurse', licence: { body: 'NMCN', numberHint: '0042' },
          status: 'pending', invitedBy: 'Ada Obi', createdAt: '2026-10-26T09:00:00.000Z',
          lastSentAt: '2026-10-26T09:00:00.000Z', expiresAt: '2026-11-02T09:00:00.000Z', sendCount: 1,
          deliveryOutcome: 'accepted', resendAvailableAt: '2026-10-26T09:01:00.000Z' }],
      });
    });

    it.each([
      ['pending', { review_state: 'pending' }], ['invitations closed', { invitations_open: false }],
      ['delivery paused', { delivery_paused: true }], ['at the pending limit', { pending_count: 100 }],
      ['at the daily invitations', { invitations_last_day: 10 }], ['at the daily emails', { emails_last_day: 20 }],
    ])('cannot invite when %s', async (_case, change) => {
      const { service } = harness({
        'facility_staff_management_state': () => ({ rows: [{ ...stateRow, ...change }] }),
        'identity.list_facility_staff()': () => ({ rows: [] }),
        'list_facility_staff_invitations': () => ({ rows: [] }),
      });
      await expect(service.list(staffContext('review_state' in change ? 'pending' : 'reviewed')))
        .resolves.toMatchObject({ canInvite: false });
    });

    it('is open to a pending administrator, with no licence recorded yet', async () => {
      const { service } = harness({
        'facility_staff_management_state': () => ({ rows: [{ ...stateRow, review_state: 'pending', on_probation: false,
          probation_ends_at: null, administrator_licence_body: null, administrator_licence_hint: null,
          administrator_licence_recorded_at: null }] }),
        'identity.list_facility_staff()': () => ({ rows: [memberRows[0]] }),
      });
      await expect(service.list(staffContext('pending'))).resolves.toMatchObject({ canInvite: false,
        administratorLicence: null, facility: { reviewState: 'pending', firstThirtyDaysEndAt: null }, invitations: [] });
    });

    it('refuses a governed facility 403 before the database, and maps the database\'s own refusal', async () => {
      const { service, calls } = harness();
      await expect(service.list(staffContext())).rejects.toMatchObject({ status: 403, code: 'STAFF_MANAGEMENT_NOT_AVAILABLE' });
      expect(calls).toHaveLength(0);
      const refused = harness({ 'facility_staff_management_state': () => {
        throw Object.assign(new Error('STAFF_MANAGEMENT_NOT_AVAILABLE'), { code: '42501' }); } });
      await expect(refused.service.list(staffContext('reviewed')))
        .rejects.toMatchObject({ status: 403, code: 'STAFF_MANAGEMENT_NOT_AVAILABLE' });
    });
  });

  describe('the administrator\'s own licence', () => {
    it('records it while pending, normalized, and answers the hint', async () => {
      const { service, sqlCalls } = harness({ 'record_self_service_administrator_licence': () => ({ rows: [{
        licence_body: 'MDCN', number_hint: '2345', recorded_at: new Date('2026-10-24T09:00:00.000Z') }] }) });
      await expect(service.recordAdministratorLicence(staffContext('pending'), 'MDCN', ' mdcn/12  345 '))
        .resolves.toEqual({ licenceBody: 'MDCN', numberHint: '2345', recordedAt: '2026-10-24T09:00:00.000Z' });
      expect(sqlCalls('record_self_service_administrator_licence')[0]).toMatchObject({ transaction: 'staff',
        sql: 'select * from identity.record_self_service_administrator_licence($1,$2)', values: ['MDCN', 'MDCN/12 345'] });
      // Not gated by the invitations control.
      expect(sqlCalls('platform.control_enabled')).toHaveLength(0);
    });

    it('answers 409 after review and 403 for a governed facility, before the database', async () => {
      const { service, calls } = harness();
      await expect(service.recordAdministratorLicence(staffContext('reviewed'), 'MDCN', '12345'))
        .rejects.toMatchObject({ status: 409, code: 'FACILITY_ALREADY_REVIEWED' });
      await expect(service.recordAdministratorLicence(staffContext(), 'MDCN', '12345'))
        .rejects.toMatchObject({ status: 403, code: 'STAFF_MANAGEMENT_NOT_AVAILABLE' });
      expect(calls).toHaveLength(0);
    });

    it.each([
      ['P0001', 'STAFF_MANAGEMENT_NOT_ADMINISTRATOR', 403], ['P0001', 'FACILITY_ALREADY_REVIEWED', 409],
      ['22023', 'ADMINISTRATOR_LICENCE_INVALID', 400],
    ])('maps %s %s to %i', async (code, message, status) => {
      const { service } = harness({ 'record_self_service_administrator_licence': () => {
        throw Object.assign(new Error(message), { code }); } });
      await expect(service.recordAdministratorLicence(staffContext('pending'), 'PCN', '12345'))
        .rejects.toMatchObject({ status, code: message });
    });
  });

  describe('remove and change role', () => {
    const end = { expectedVersion: 2, reason: 'Left the hospital', currentPassword: 'secret pass' };
    const change = { expectedVersion: 2, role: 'nurse' as const, licenceBody: 'NMCN' as const, licenceNumber: ' rn  0042 ',
      attested: true as const, reason: 'Moved to the wards', currentPassword: 'secret pass' };

    it('removes after the password: not gated, not held after a recovery', async () => {
      const { service, local, sqlCalls } = harness({
        'platform.control_enabled': () => ({ rows: [{ invitations: false, provider_portal: true, maintenance: false }] }),
        'otp_challenges': () => ({ rows: [{ held: true }] }),
        'end_facility_staff_membership': () => ({ rows: [{ row_version: '3', ended_at: '2026-10-27T10:00:00Z',
          roles_revoked: 1, grants_revoked: '2', requests_expired: 0 }] }),
      });
      await expect(service.end(staffContext('reviewed'), httpRequest, membershipId, end))
        .resolves.toEqual({ version: 3, endedAt: '2026-10-27T10:00:00.000Z', grantsRevoked: 2 });
      expect(local.authenticate).toHaveBeenCalledWith('admin@example.test', 'secret pass', 'staff', 'facility-staff-test');
      expect(sqlCalls('end_facility_staff_membership')[0]).toMatchObject({
        sql: 'select * from identity.end_facility_staff_membership($1,$2,$3)', values: [membershipId, 2, 'Left the hospital'] });
      expect(sqlCalls('otp_challenges')).toHaveLength(0);
      expect(sqlCalls('platform.control_enabled')).toHaveLength(0);
    });

    it('refuses a wrong password 403 and counts it towards the sign-in lockout, with no command', async () => {
      const { service, local, sessionAudit, sqlCalls } = harness();
      local.authenticate.mockRejectedValueOnce(new UnauthorizedException('Invalid credentials'));
      await expect(service.end(staffContext('reviewed'), httpRequest, membershipId, end))
        .rejects.toMatchObject({ status: 403, code: 'STAFF_REAUTHENTICATION_FAILED' });
      expect(sessionAudit.recordLoginFailure).toHaveBeenCalledWith('admin@example.test', { correlationId: 'facility-staff-test',
        actorSubject: 'staff:administrator', sourceIp: '203.0.113.9', userAgent: 'synthetic-agent' });
      expect(sqlCalls('end_facility_staff_membership')).toHaveLength(0);
    });

    it('changes a role: gated, after the password, held after a recovery, with the attestation version', async () => {
      const { service, sqlCalls, local } = harness({
        'change_facility_staff_role': () => ({ rows: [{ row_version: '4', role_code: 'nurse' }] }) });
      await expect(service.changeRole(staffContext('reviewed'), httpRequest, membershipId, change))
        .resolves.toEqual({ version: 4, roleCode: 'nurse' });
      expect(sqlCalls('platform.control_enabled')).toHaveLength(1);
      expect(local.authenticate).toHaveBeenCalledTimes(1);
      expect(sqlCalls('otp_challenges')).toHaveLength(1);
      expect(sqlCalls('change_facility_staff_role')[0]).toMatchObject({
        sql: 'select * from identity.change_facility_staff_role($1,$2,$3,$4,$5,$6,$7)',
        values: [membershipId, 2, 'nurse', 'NMCN', 'RN 0042', STAFF_ATTESTATION_VERSION, 'Moved to the wards'] });
      const held = harness({ 'otp_challenges': () => ({ rows: [{ held: true }] }) });
      await expect(held.service.changeRole(staffContext('reviewed'), httpRequest, membershipId, change))
        .rejects.toMatchObject({ status: 403, code: 'STAFF_RECENT_RECOVERY_HOLD' });
      expect(held.sqlCalls('change_facility_staff_role')).toHaveLength(0);
      const closed = harness({ 'platform.control_enabled': () => ({ rows: [{ invitations: false, provider_portal: true,
        maintenance: false }] }) });
      await expect(closed.service.changeRole(staffContext('reviewed'), httpRequest, membershipId, change))
        .rejects.toMatchObject({ status: 423, code: 'STAFF_INVITATIONS_UNAVAILABLE' });
      expect(closed.local.authenticate).not.toHaveBeenCalled();
    });

    it('passes a receptionist without a licence as nulls', async () => {
      const { service, sqlCalls } = harness({ 'change_facility_staff_role': () => ({ rows: [{ row_version: 4, role_code: 'receptionist' }] }) });
      await service.changeRole(staffContext('reviewed'), httpRequest, membershipId, { ...change, role: 'receptionist',
        licenceBody: undefined, licenceNumber: undefined });
      expect(sqlCalls('change_facility_staff_role')[0]?.values.slice(2, 5)).toEqual(['receptionist', null, null]);
    });

    it.each([
      ['P0002', 'x', 404, 'FACILITY_STAFF_NOT_FOUND'], ['40001', 'x', 409, 'VERSION_CONFLICT'],
      ['P0001', 'FACILITY_STAFF_SELF', 409, 'FACILITY_STAFF_SELF'],
      ['P0001', 'FACILITY_STAFF_ADMINISTRATOR', 409, 'FACILITY_STAFF_ADMINISTRATOR'],
      ['P0001', 'FACILITY_STAFF_ALREADY_ENDED', 409, 'FACILITY_STAFF_ALREADY_ENDED'],
      ['P0001', 'FACILITY_STAFF_ROLE_UNCHANGED', 409, 'FACILITY_STAFF_ROLE_UNCHANGED'],
      ['P0001', 'FACILITY_STAFF_PLATFORM_ACCOUNT', 409, 'FACILITY_STAFF_PLATFORM_ACCOUNT'],
      ['22023', 'STAFF_INVITATION_ROLE_NOT_ALLOWED', 400, 'STAFF_INVITATION_ROLE_NOT_ALLOWED'],
      ['22023', 'FACILITY_STAFF_REASON_INVALID', 400, 'FACILITY_STAFF_REASON_INVALID'],
      ['P0001', 'FACILITY_REVIEW_PENDING', 409, 'FACILITY_REVIEW_PENDING'],
    ])('maps the role change\'s %s %s to %i %s', async (code, message, status, answer) => {
      const { service } = harness({ 'change_facility_staff_role': () => { throw Object.assign(new Error(message), { code }); } });
      await expect(service.changeRole(staffContext('reviewed'), httpRequest, membershipId, change))
        .rejects.toMatchObject({ status, code: answer });
    });

    it('refuses both before review 409, before the password', async () => {
      const { service, local } = harness();
      await expect(service.end(staffContext('pending'), httpRequest, membershipId, end))
        .rejects.toMatchObject({ status: 409, code: 'FACILITY_REVIEW_PENDING' });
      await expect(service.changeRole(staffContext('pending'), httpRequest, membershipId, change))
        .rejects.toMatchObject({ status: 409, code: 'FACILITY_REVIEW_PENDING' });
      expect(local.authenticate).not.toHaveBeenCalled();
    });
  });

  describe('support\'s reads', () => {
    const admin: PlatformAdminContext = { actor: { ...staffContext().actor, facilities: [], facilityIds: [],
      facility: undefined, platformPermissions: ['platform.admin.access', 'platform.principal.read'] },
    correlationId: 'admin-test', purposeOfUse: 'healthcare-operations' };

    it('lists a facility\'s members and invitations with full licences, read-only', async () => {
      const { service, database, sqlCalls } = harness({
        'from identity.facilities facility': () => ({ rows: [{ id: facilityId, name: 'Synthetic Clinic Ltd',
          review_state: 'reviewed', organization_type: 'clinic', product_code: 'ehr' }] }),
        'admin_list_facility_staff': () => ({ rows: [
          { kind: 'membership', membership_id: membershipId, invitation_id: null, reference: null, account_id: 'acc',
            name: 'Chidi Eze', email: 'chidi@example.test', roles: ['nurse'], status: 'active', licence_body: 'NMCN',
            licence_number: 'RN 0042', licence_key: 'NMCN:RN0042', same_licence_elsewhere: '1', name_mismatch: true,
            attested_by_account_id: 'admin', attested_by_name: 'Ada Obi', verification_method: 'facility_attestation',
            attested_at: '2026-10-26T09:00:00Z', created_at: '2026-10-26T10:00:00Z' },
          { kind: 'invitation', membership_id: null, invitation_id: 'inv', reference: '3F2A9C1B', account_id: null,
            name: 'Dayo Ade', email: 'dayo@example.test', roles: ['lab'], status: 'pending', licence_body: 'MLSCN',
            licence_number: 'ML/77', licence_key: 'MLSCN:ML77', same_licence_elsewhere: 0, name_mismatch: null,
            attested_by_account_id: 'admin', attested_by_name: 'Ada Obi', verification_method: 'facility_attestation',
            attested_at: '2026-10-27T09:00:00Z', created_at: '2026-10-27T09:00:00Z' },
        ] }),
      });
      const answer = await service.adminStaff(admin, facilityId);
      expect(database.withPlatformTransaction).toHaveBeenCalledWith(admin, expect.any(Function), { readOnly: true });
      expect(sqlCalls('admin_list_facility_staff')[0]).toMatchObject({ transaction: 'platform',
        sql: 'select * from identity.admin_list_facility_staff($1)', values: [facilityId] });
      expect(sqlCalls('organization_self_service_state')[0]?.values).toEqual([facilityId]);
      expect(answer.facility).toEqual({ id: facilityId, name: 'Synthetic Clinic Ltd',
        selfService: { review: 'reviewed', organizationType: 'clinic', productCode: 'ehr' } });
      expect(answer.members).toEqual([{ membershipId, accountId: 'acc', name: 'Chidi Eze', email: 'chidi@example.test',
        roles: ['nurse'], status: 'active', licenceBody: 'NMCN', licenceNumber: 'RN 0042', licenceKey: 'NMCN:RN0042',
        sameLicenceElsewhere: 1, nameMismatch: true, attestedByAccountId: 'admin', attestedByName: 'Ada Obi',
        verificationMethod: 'facility_attestation', attestedAt: '2026-10-26T09:00:00.000Z', createdAt: '2026-10-26T10:00:00.000Z' }]);
      expect(answer.invitations).toEqual([expect.objectContaining({ invitationId: 'inv', reference: '3F2A9C1B',
        licenceNumber: 'ML/77', sameLicenceElsewhere: 0, nameMismatch: false })]);
      expect(answer.invitations[0]).not.toHaveProperty('membershipId');
    });

    it('answers a governed facility with selfService null, and an unknown one 404', async () => {
      const governed = harness({ 'from identity.facilities facility': () => ({ rows: [{ id: facilityId, name: 'Governed',
        review_state: null, organization_type: null, product_code: null }] }) });
      await expect(governed.service.adminStaff(admin, facilityId)).resolves.toEqual({
        facility: { id: facilityId, name: 'Governed', selfService: null }, members: [], invitations: [] });
      const unknown = harness();
      await expect(unknown.service.adminStaff(admin, facilityId)).rejects.toMatchObject({ status: 404,
        code: 'ADMIN_FACILITY_NOT_FOUND' });
      expect(unknown.sqlCalls('admin_list_facility_staff')).toHaveLength(0);
    });

    it('finds an invitation by its reference, upper case', async () => {
      const { service, sqlCalls } = harness({ 'admin_find_staff_invitations': () => ({ rows: [{ invitation_id: 'inv',
        reference: '3F2A9C1B', facility_id: facilityId, facility_name: 'Synthetic Clinic Ltd', organization_id: 'org',
        status: 'pending', role_code: 'nurse', created_at: '2026-10-26T09:00:00Z', expires_at: '2026-11-02T09:00:00Z' }] }) });
      await expect(service.adminFindInvitations(admin, '3f2a9c1b')).resolves.toEqual({ items: [{ invitationId: 'inv',
        reference: '3F2A9C1B', facilityId, facilityName: 'Synthetic Clinic Ltd', organizationId: 'org', status: 'pending',
        roleCode: 'nurse', createdAt: '2026-10-26T09:00:00.000Z', expiresAt: '2026-11-02T09:00:00.000Z' }] });
      expect(sqlCalls('admin_find_staff_invitations')[0]?.values).toEqual(['3F2A9C1B']);
    });

    it.each([['42501', 403, 'PERMISSION_DENIED'], ['22023', 400, 'STAFF_INVITATION_REFERENCE_INVALID'],
      ['XX000', 503, 'STAFF_MANAGEMENT_UNAVAILABLE']])('maps the lookup\'s %s to %i %s', async (code, status, answer) => {
      const { service } = harness({ 'admin_find_staff_invitations': () => { throw Object.assign(new Error('x'), { code }); } });
      await expect(service.adminFindInvitations(admin, '3F2A9C1B')).rejects.toMatchObject({ status, code: answer });
    });
  });
});

describe('StaffReauthenticationService', () => {
  const actor = { kind: 'staff', subject: 'staff:administrator', accountId: 'account-1', email: 'Admin@Example.test' } as ActorContext;
  const request = { correlationId: 'reauth-test', ip: '203.0.113.9', header: () => 'agent' } as unknown as HidRequest;

  function build() {
    const local = { authenticate: jest.fn(async () => ({ accountId: 'account-1' })) };
    const sessionAudit = { recordLoginFailure: jest.fn(async () => undefined) };
    return { local, sessionAudit, service: new StaffReauthenticationService(local as unknown as LocalAuthProvider,
      sessionAudit as unknown as AuthSessionAuditService) };
  }

  it('checks the session\'s own email as a staff sign-in does, and records nothing on success', async () => {
    const { local, sessionAudit, service } = build();
    await expect(service.confirm(actor, 'correct horse', request)).resolves.toBeUndefined();
    expect(local.authenticate).toHaveBeenCalledWith('Admin@Example.test', 'correct horse', 'staff', 'reauth-test');
    expect(sessionAudit.recordLoginFailure).not.toHaveBeenCalled();
  });

  it('refuses a password of another account 403 and counts it', async () => {
    const { local, sessionAudit, service } = build();
    local.authenticate.mockResolvedValueOnce({ accountId: 'account-2' });
    await expect(service.confirm(actor, 'other', request)).rejects.toMatchObject({ status: 403,
      code: 'STAFF_REAUTHENTICATION_FAILED' });
    expect(sessionAudit.recordLoginFailure).toHaveBeenCalledTimes(1);
  });

  it('lets a non-credential fault through without counting it, and refuses a session with no email', async () => {
    const { local, sessionAudit, service } = build();
    const outage = new Error('database down');
    local.authenticate.mockRejectedValueOnce(outage);
    await expect(service.confirm(actor, 'x', request)).rejects.toBe(outage);
    await expect(service.confirm({ ...actor, email: undefined }, 'x', request)).rejects.toMatchObject({ status: 403 });
    expect(sessionAudit.recordLoginFailure).not.toHaveBeenCalled();
  });
});
