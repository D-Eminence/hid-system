import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { HidRequest, PlatformAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { assuredClient, type AssuranceOptions, platformActor, useTestEnvironment } from '../testing/platform-assurance';
import {
  WorkforceAttachCommandDto, WorkforceAttestationCommandDto, WorkforceEndMembershipCommandDto, WorkforceRoleCommandDto,
} from './dto/workforce-command.dto';
import { WorkforceAdminController } from './workforce-admin.controller';
import { WorkforceAdminService } from './workforce-admin.service';

/** Launch D14 governed clinician provisioning (0087). */
const FACILITY = '10000000-0000-4000-8000-0000000000a1';
const ACCOUNT = '20000000-0000-4000-8000-0000000000b1';
const MEMBERSHIP = '40000000-0000-4000-8000-0000000000c1';
const ATTESTATION = '50000000-0000-4000-8000-0000000000d1';

const context: PlatformAccessContext = {
  scope: 'platform', correlationId: 'workforce-spec-correlation', facilityId: null, membershipId: null,
  purposeOfUse: 'healthcare-operations',
  actor: platformActor({ platformPermissions: ['platform.admin.access', 'platform.workforce.manage'] }),
};

function harness(row: Readonly<Record<string, unknown>>, assurance: AssuranceOptions = {}) {
  const command = jest.fn().mockResolvedValue({ rows: [row], rowCount: 1 });
  const client = assuredClient(command, assurance);
  const transactions: unknown[] = [];
  const database = { withTransaction: jest.fn(async (_context, operation, options) => {
    transactions.push(options);
    return operation(client as unknown as PoolClient);
  }) };
  const audit = { recordWithClient: jest.fn().mockResolvedValue(undefined) };
  const service = new WorkforceAdminService(database as unknown as DatabaseService, audit as unknown as AuditService);
  return { service, command, audit, transactions };
}

async function refusal(promise: Promise<unknown>): Promise<DomainProblem> {
  const error = await promise.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(DomainProblem);
  return error as DomainProblem;
}

const attachRow = { membership_id: MEMBERSHIP, account_id: ACCOUNT, staff_id: '30000000-0000-4000-8000-0000000000e1',
  facility_id: FACILITY, account_status: 'pending_reset', account_created: true, membership_version: '1',
  staff_version: '1', replayed: false };
const roleRow = { membership_id: MEMBERSHIP, facility_id: FACILITY, role_code: 'doctor', role_active: true,
  membership_active: true, membership_state: 'active', membership_version: '2', attestation_id: ATTESTATION,
  replayed: false };
const endRow = { membership_id: MEMBERSHIP, facility_id: FACILITY, account_id: ACCOUNT, revoked_roles: 1,
  revoked_grants: 2, expired_requests: 3, revoked_sessions: 4, membership_version: '4', replayed: false };
const attestation = { attestedRoles: ['doctor'], credentialReference: 'MDCN/R/0001',
  issuingAuthority: 'Medical and Dental Council of Nigeria', verificationMethod: 'manual_review' as const,
  evidenceReference: 'Credential review ticket WF-1', validUntil: '2027-10-01T00:00:00Z',
  reason: 'Reviewed the practising licence' };

const role: WorkforceRoleCommandDto = { facilityId: FACILITY, roleCode: 'doctor', action: 'grant',
  reason: 'Attested clinician' };

useTestEnvironment();

describe('WorkforceAdminService', () => {
  it('attaches a new staff identity as a pending membership and audits it in the same transaction', async () => {
    const { service, command, audit } = harness(attachRow);
    await expect(service.attach(context, { facilityId: FACILITY, email: 'new.clinician@example.invalid',
      fullName: 'New Clinician', reason: 'New clinician joining the facility' }, 'workforce-key-000001'))
      .resolves.toEqual({ membershipId: MEMBERSHIP, accountId: ACCOUNT, staffId: attachRow.staff_id, facilityId: FACILITY,
        state: 'pending', accountStatus: 'pending_reset', accountCreated: true, membershipVersion: 1, staffVersion: 1,
        replayed: false });
    expect(command).toHaveBeenCalledWith(expect.stringContaining('identity.admin_attach_workforce_member'),
      [FACILITY, null, 'new.clinician@example.invalid', 'New Clinician', 'New clinician joining the facility',
        'workforce-key-000001', expect.stringMatching(/^[0-9a-f]{64}$/)]);
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'admin.workforce.membership.attached', resourceType: 'staff-membership', resourceId: MEMBERSHIP,
      accessScope: 'platform', outcome: 'success', reason: 'New clinician joining the facility' }));
    const event = audit.recordWithClient.mock.calls[0][1] as Record<string, unknown>;
    expect(event.facilityId).toBeUndefined();
    expect(event.actorMembershipId).toBeUndefined();
  });

  it.each([
    [{ facilityId: FACILITY, reason: 'Neither form given here' }],
    [{ facilityId: FACILITY, accountId: ACCOUNT, email: 'x@example.invalid', fullName: 'Both Forms',
      reason: 'Both forms given here' }],
    [{ facilityId: FACILITY, accountId: ACCOUNT, fullName: 'Name For Existing', reason: 'Existing with a name' }],
    [{ facilityId: FACILITY, email: 'x@example.invalid', reason: 'New identity without a name' }],
  ])('refuses an attach that does not name exactly one identity: %j', async (input) => {
    const { service, command } = harness(attachRow);
    const problem = await refusal(service.attach(context, input as WorkforceAttachCommandDto, 'workforce-key-000002'));
    expect(problem.code).toBe('WORKFORCE_COMMAND_INVALID');
    expect(command).not.toHaveBeenCalled();
  });

  it('requires a fresh step-up before any workforce command reaches the database', async () => {
    const { service, command } = harness(roleRow, { stepUpFresh: false });
    const problem = await refusal(service.changeRole(context, MEMBERSHIP, 1,
      { facilityId: FACILITY, roleCode: 'doctor', action: 'grant', reason: 'Attested clinician' }, 'workforce-key-000003'));
    expect(problem.code).toBe('STEP_UP_REQUIRED');
    expect(command).not.toHaveBeenCalled();
  });

  it('requires the workforce permission even when called without the guard', async () => {
    const { service, command } = harness(roleRow);
    const support = { ...context, actor: platformActor({ platformPermissions: ['platform.admin.access'] }) };
    const problem = await refusal(service.endMembership(support, MEMBERSHIP, 1,
      { facilityId: FACILITY, reason: 'End of employment' }, 'workforce-key-000004'));
    expect(problem.code).toBe('PERMISSION_DENIED');
    expect(command).not.toHaveBeenCalled();
  });

  it('records an attestation with its method and lapse, never the evidence text, in the audit event', async () => {
    const { service, command, audit } = harness({ attestation_id: ATTESTATION, account_id: ACCOUNT,
      staff_id: attachRow.staff_id, attested_roles: ['doctor'], valid_until: new Date('2027-10-01T00:00:00Z'),
      verification_status: 'verified', staff_version: '2', replayed: false });
    await expect(service.attest(context, ACCOUNT, 1, attestation, 'workforce-key-000005')).resolves.toMatchObject({
      attestationId: ATTESTATION, attestedRoles: ['doctor'], verificationMethod: 'manual_review',
      validUntil: '2027-10-01T00:00:00.000Z', verificationStatus: 'verified', staffVersion: 2 });
    expect(command).toHaveBeenCalledWith(expect.stringContaining('identity.admin_record_credential_attestation'),
      [ACCOUNT, 1, ['doctor'], 'MDCN/R/0001', 'Medical and Dental Council of Nigeria', 'Credential review ticket WF-1',
        '2027-10-01T00:00:00.000Z', 'Reviewed the practising licence', 'workforce-key-000005',
        expect.stringMatching(/^[0-9a-f]{64}$/)]);
    const event = audit.recordWithClient.mock.calls[0][1] as { action: string; details: Record<string, unknown> };
    expect(event.action).toBe('admin.workforce.credential.attested');
    expect(JSON.stringify(event.details)).not.toContain('MDCN/R/0001');
    expect(JSON.stringify(event.details)).not.toContain('Credential review ticket');
  });

  it('grants one role and reports the attestation it relied on', async () => {
    const { service, command, audit } = harness(roleRow);
    await expect(service.changeRole(context, MEMBERSHIP, 1,
      { facilityId: FACILITY, roleCode: 'doctor', action: 'grant', reason: 'Attested clinician' }, 'workforce-key-000006'))
      .resolves.toEqual({ membershipId: MEMBERSHIP, facilityId: FACILITY, roleCode: 'doctor', roleActive: true,
        membershipActive: true, state: 'active', version: 2, attestationId: ATTESTATION, replayed: false });
    expect(command).toHaveBeenCalledWith(expect.stringContaining('identity.admin_change_workforce_role'),
      [MEMBERSHIP, FACILITY, 1, 'doctor', 'grant', 'Attested clinician', 'workforce-key-000006',
        expect.stringMatching(/^[0-9a-f]{64}$/)]);
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'admin.workforce.role.granted', details: expect.objectContaining({ roleCode: 'doctor',
        attestationId: ATTESTATION, facilityId: FACILITY }) }));
  });

  it('ends a membership and reports what it closed', async () => {
    const { service, audit } = harness(endRow);
    await expect(service.endMembership(context, MEMBERSHIP, 3, { facilityId: FACILITY, reason: 'End of employment' },
      'workforce-key-000007')).resolves.toEqual({ membershipId: MEMBERSHIP, facilityId: FACILITY, accountId: ACCOUNT,
      state: 'ended', revokedRoles: 1, revokedGrants: 2, expiredRequests: 3, revokedSessions: 4, version: 4,
      replayed: false });
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'admin.workforce.membership.ended', details: expect.objectContaining({ revokedGrants: 2,
        expiredRequests: 3, revokedSessions: 4 }) }));
  });

  it('records no second audit event for a replayed command', async () => {
    const { service, audit } = harness({ ...endRow, replayed: true });
    await expect(service.endMembership(context, MEMBERSHIP, 3, { facilityId: FACILITY, reason: 'End of employment' },
      'workforce-key-000008')).resolves.toMatchObject({ replayed: true });
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('binds the idempotency digest to every field of the command', async () => {
    const first = harness(roleRow);
    const second = harness(roleRow);
    await first.service.changeRole(context, MEMBERSHIP, 1,
      { facilityId: FACILITY, roleCode: 'doctor', action: 'grant', reason: 'Attested clinician' }, 'workforce-key-000009');
    await second.service.changeRole(context, MEMBERSHIP, 1,
      { facilityId: FACILITY, roleCode: 'nurse', action: 'grant', reason: 'Attested clinician' }, 'workforce-key-000009');
    const digest = (call: unknown[]) => (call[1] as unknown[])[7];
    expect(digest(first.command.mock.calls[0])).not.toEqual(digest(second.command.mock.calls[0]));
  });

  it.each([
    ['WORKFORCE_SECOND_PERSON_REQUIRED', 403, 'WORKFORCE_SECOND_PERSON_REQUIRED'],
    ['WORKFORCE_FACILITY_CONFLICT', 403, 'WORKFORCE_FACILITY_CONFLICT'],
    ['WORKFORCE_SELF_CHANGE_DENIED', 403, 'WORKFORCE_SELF_CHANGE_DENIED'],
    ['WORKFORCE_ATTESTATION_REQUIRED', 409, 'WORKFORCE_ATTESTATION_REQUIRED'],
    ['WORKFORCE_ROLE_CONFLICT', 409, 'WORKFORCE_ROLE_CONFLICT'],
    ['WORKFORCE_FACILITY_MISMATCH', 409, 'WORKFORCE_FACILITY_MISMATCH'],
    ['WORKFORCE_MEMBERSHIP_ENDED', 409, 'WORKFORCE_MEMBERSHIP_ENDED'],
    ['WORKFORCE_ROLE_NOT_GRANTABLE', 400, 'WORKFORCE_ROLE_NOT_GRANTABLE'],
    ['WORKFORCE_MEMBERSHIP_NOT_FOUND', 404, 'WORKFORCE_MEMBERSHIP_NOT_FOUND'],
    ['WORKFORCE_INVALID_COMMAND', 400, 'WORKFORCE_COMMAND_INVALID'],
    ['ADMIN_VERSION_CONFLICT', 409, 'VERSION_CONFLICT'],
    ['ADMIN_IDEMPOTENCY_CONFLICT', 409, 'IDEMPOTENCY_CONFLICT'],
    ['ADMIN_STEP_UP_REQUIRED', 403, 'STEP_UP_REQUIRED'],
  ] as const)('maps %s to %i %s', async (databaseMessage, status, code) => {
    const { service, command, audit } = harness(roleRow);
    command.mockRejectedValue(new Error(databaseMessage));
    const problem = await refusal(service.changeRole(context, MEMBERSHIP, 1,
      { facilityId: FACILITY, roleCode: 'doctor', action: 'grant', reason: 'Attested clinician' }, 'workforce-key-000010'));
    expect([problem.getStatus(), problem.code]).toEqual([status, code]);
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('reads a workforce profile in a read-only transaction', async () => {
    const profile = { account: { id: ACCOUNT }, staff: null, attestations: [], memberships: [] };
    const { service, command, transactions } = harness({ profile });
    await expect(service.profile(context, ACCOUNT)).resolves.toEqual(profile);
    expect(command).toHaveBeenCalledWith('select identity.admin_workforce_profile($1) as profile', [ACCOUNT]);
    expect(transactions).toEqual([{ readOnly: true }]);
  });
});

describe('WorkforceAdminController', () => {
  const request = { actor: context.actor, accessScope: 'platform', correlationId: 'workforce-spec-correlation',
    header: () => undefined } as unknown as HidRequest;
  const service = { attach: jest.fn(), attest: jest.fn(), changeRole: jest.fn(), endMembership: jest.fn(),
    profile: jest.fn() };
  const controller = new WorkforceAdminController(service as unknown as WorkforceAdminService);

  beforeEach(() => jest.clearAllMocks());

  it.each([undefined, '', 'abc', '0', '-1', '1.5'])('refuses a versioned command with If-Match %p', (ifMatch) => {
    expect(() => controller.changeRole(MEMBERSHIP, ifMatch, 'workforce-key-000011', role, request))
      .toThrow(expect.objectContaining({ code: 'IF_MATCH_REQUIRED' }));
    expect(() => controller.endMembership(MEMBERSHIP, ifMatch, 'workforce-key-000011',
      { facilityId: FACILITY, reason: 'End of employment' }, request))
      .toThrow(expect.objectContaining({ code: 'IF_MATCH_REQUIRED' }));
    expect(service.changeRole).not.toHaveBeenCalled();
  });

  it('accepts a quoted or weak If-Match version', () => {
    controller.changeRole(MEMBERSHIP, 'W/"7"', 'workforce-key-000012', role, request);
    expect(service.changeRole).toHaveBeenCalledWith(expect.anything(), MEMBERSHIP, 7, role, 'workforce-key-000012');
  });

  it('refuses a command without an Idempotency-Key', () => {
    expect(() => controller.attach(undefined, { facilityId: FACILITY, accountId: ACCOUNT,
      reason: 'Existing clinician joins' }, request)).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REQUIRED' }));
    expect(() => controller.attest(ACCOUNT, '1', 'short', attestation, request))
      .toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REQUIRED' }));
  });
});

describe('workforce command validation', () => {
  const errors = async <T extends object>(type: new () => T, body: Record<string, unknown>) =>
    (await validate(plainToInstance(type, body), { whitelist: true, forbidNonWhitelisted: true }))
      .map((error) => error.property);

  it('accepts only the launch clinical roles for an attestation, once each', async () => {
    expect(await errors(WorkforceAttestationCommandDto, attestation)).toEqual([]);
    expect(await errors(WorkforceAttestationCommandDto, { ...attestation, attestedRoles: ['lab'] })).toEqual(['attestedRoles']);
    expect(await errors(WorkforceAttestationCommandDto, { ...attestation, attestedRoles: ['doctor', 'doctor'] }))
      .toEqual(['attestedRoles']);
    expect(await errors(WorkforceAttestationCommandDto, { ...attestation, attestedRoles: [] })).toEqual(['attestedRoles']);
  });

  it('requires the documented manual-review method and a dated lapse', async () => {
    expect(await errors(WorkforceAttestationCommandDto, { ...attestation, verificationMethod: 'registry' }))
      .toEqual(['verificationMethod']);
    expect(await errors(WorkforceAttestationCommandDto, { ...attestation, validUntil: 'next year' }))
      .toEqual(['validUntil']);
    const { evidenceReference: _omitted, ...withoutEvidence } = attestation;
    expect(await errors(WorkforceAttestationCommandDto, withoutEvidence)).toEqual(['evidenceReference']);
  });

  it('names a facility and one known role for a role command', async () => {
    expect(await errors(WorkforceRoleCommandDto, { ...role, roleCode: 'org_admin' })).toEqual(['roleCode']);
    expect(await errors(WorkforceRoleCommandDto, { ...role, roleCode: 'lab', action: 'revoke' })).toEqual([]);
    const { facilityId: _facility, ...withoutFacility } = role;
    expect(await errors(WorkforceRoleCommandDto, withoutFacility)).toEqual(['facilityId']);
    expect(await errors(WorkforceEndMembershipCommandDto, { facilityId: 'not-a-uuid', reason: 'End of employment' }))
      .toEqual(['facilityId']);
  });

  it('rejects unknown fields such as a client-chosen password', async () => {
    expect(await errors(WorkforceAttachCommandDto, { facilityId: FACILITY, email: 'n@example.invalid',
      fullName: 'New Clinician', reason: 'New clinician joining', password: 'chosen-by-admin' })).toEqual(['password']);
  });
});
