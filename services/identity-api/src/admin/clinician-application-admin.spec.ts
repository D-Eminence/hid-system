jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import type { MfaService } from '../auth/mfa/mfa.service';
import { AUDIT_ACTION, HIGH_RISK_ACTION, PLATFORM_SCOPE, REQUIRED_PERMISSIONS } from '../common/decorators';
import { requestDigest } from '../common/idempotency';
import { DomainProblem, RetryAfterProblem } from '../common/problem';
import type { HidRequest, PlatformAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { assuredClient, isAssuranceQuery, platformActor, useTestEnvironment } from '../testing/platform-assurance';
import { adminCommandError } from './admin-command-error';
import { AdminClinicianApplicationsController } from './clinician-application-admin.controller';
import { ClinicianApplicationAdminService } from './clinician-application-admin.service';
import { PlatformControlCommandDto } from './dto/admin-command.dto';
import { AttestClinicianApplicationDto, ListClinicianApplicationsDto,
  RejectClinicianApplicationDto } from './dto/clinician-application-command.dto';

/** The clinician verification queue and its two-administrator review (ADR-064). */
const APPLICATION = '60000000-0000-4000-8000-0000000000a1';
const APPLICANT = '20000000-0000-4000-8000-0000000000b1';
const FACILITY = '10000000-0000-4000-8000-0000000000c1';
const ATTESTATION = '50000000-0000-4000-8000-0000000000d1';
const MEMBERSHIP = '40000000-0000-4000-8000-0000000000e1';
const FACTOR = '70000000-0000-4000-8000-0000000000f1';
const KEY = 'clinician-review-000001';
const event = { correlationId: 'clinician-admin-spec', sourceIp: '192.0.2.31', userAgent: 'synthetic' };

const context: PlatformAccessContext = {
  scope: 'platform', correlationId: 'clinician-admin-spec', facilityId: null, membershipId: null,
  purposeOfUse: 'healthcare-operations',
  actor: platformActor({ platformPermissions: ['platform.admin.access', 'platform.workforce.manage'] }),
};
const checklist = { registerChecked: true, licenceCurrentUntilRecorded: true, identityMethod: 'video_call_photo_id',
  identityConfirmed: true, employmentChannel: 'facility_public_phone', employmentConfirmed: true } as const;
const attestInput = { validUntil: '2027-06-30T22:59:59Z', evidenceReference: 'Review ticket CLIN-0001',
  checklist, authenticatorCode: '123456', reason: 'Licence and identity verified' } as AttestClinicianApplicationDto;
const attestRow = { application_id: APPLICATION, state: 'under_review', attestation_id: ATTESTATION,
  valid_until: new Date('2027-06-30T22:59:59Z'), application_version: '4', account_id: APPLICANT,
  facility_id: FACILITY, role_code: 'doctor', replayed: false };
const approveRow = { application_id: APPLICATION, state: 'approved', membership_id: MEMBERSHIP, account_id: APPLICANT,
  facility_id: FACILITY, role_code: 'doctor', attestation_id: ATTESTATION,
  attested_by: '20000000-0000-4000-8000-0000000000aa', application_version: '5', replayed: false };
const rejectRow = { application_id: APPLICATION, state: 'rejected', decision_code: 'identity_not_confirmed',
  from_state: 'submitted', account_id: APPLICANT, facility_id: FACILITY, further_applications_blocked: true,
  application_version: '4', replayed: false };

type Command = (sql: string, values: unknown[]) => unknown;
function harness(commands: Record<string, Command>, confirmation: unknown = { kind: 'confirmed', factorId: FACTOR }) {
  const order: string[] = [];
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const command = jest.fn(async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    for (const [needle, answer] of Object.entries(commands)) {
      if (sql.includes(needle)) {
        order.push(needle);
        return answer(sql, values);
      }
    }
    throw new Error(`unexpected statement: ${sql}`);
  });
  const client = assuredClient(command);
  const assured = client.query;
  client.query = jest.fn(async (sql: unknown, parameters?: unknown[]) => {
    if (isAssuranceQuery(sql)) order.push('assurance');
    return assured(sql, parameters);
  });
  const transactions: Array<{ settled: boolean }> = [];
  const database = { withTransaction: jest.fn(async (_context, operation) => {
    const transaction = { settled: false };
    transactions.push(transaction);
    const result = await operation(client as unknown as PoolClient);
    transaction.settled = true;
    return result;
  }) };
  const audit = { recordWithClient: jest.fn(async (_client: unknown, _event: unknown) => { order.push('audit'); }) };
  const mfa = { confirmApplicantFactor: jest.fn(async () => { order.push('confirm'); return confirmation; }),
    lockApplicantReview: jest.fn(async () => { order.push('lock'); }) };
  const service = new ClinicianApplicationAdminService(database as unknown as DatabaseService,
    audit as unknown as AuditService, mfa as unknown as MfaService);
  return { service, order, statements, audit, mfa, transactions };
}
const rows = (row: unknown) => () => ({ rows: [row], rowCount: 1 });

async function refusal(promise: Promise<unknown>): Promise<DomainProblem> {
  const error = await promise.then(() => undefined, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(DomainProblem);
  return error as DomainProblem;
}

useTestEnvironment();

describe('AdminClinicianApplicationsController', () => {
  it('declares the platform scope, the workforce permission, the actions and the audit names', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminClinicianApplicationsController)).toBe('admin/clinician-applications');
    expect(Reflect.getMetadata(PLATFORM_SCOPE, AdminClinicianApplicationsController)).toBe(true);
    const routes = Object.fromEntries(['list', 'detail', 'attest', 'approve', 'reject'].map((name) => {
      const handler = (AdminClinicianApplicationsController.prototype as unknown as Record<string, object>)[name]!;
      return [name, { method: Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod,
        path: Reflect.getMetadata(PATH_METADATA, handler) as string,
        permissions: Reflect.getMetadata(REQUIRED_PERMISSIONS, handler) as string[],
        action: Reflect.getMetadata(HIGH_RISK_ACTION, handler) as string | undefined,
        audit: Reflect.getMetadata(AUDIT_ACTION, handler) as string }];
    }));
    expect(routes).toEqual({
      list: { method: RequestMethod.GET, path: '/', permissions: ['platform.workforce.manage'], action: undefined,
        audit: 'admin.clinician-application.list.request' },
      detail: { method: RequestMethod.GET, path: ':applicationId', permissions: ['platform.workforce.manage'],
        action: undefined, audit: 'admin.clinician-application.read.request' },
      attest: { method: RequestMethod.POST, path: ':applicationId/attest', permissions: ['platform.workforce.manage'],
        action: 'platform.clinician-application.attest', audit: 'admin.clinician-application.attest.request' },
      approve: { method: RequestMethod.POST, path: ':applicationId/approve', permissions: ['platform.workforce.manage'],
        action: 'platform.clinician-application.approve', audit: 'admin.clinician-application.approve.request' },
      reject: { method: RequestMethod.POST, path: ':applicationId/reject', permissions: ['platform.workforce.manage'],
        action: 'platform.clinician-application.reject', audit: 'admin.clinician-application.reject.request' },
    });
  });

  it('requires If-Match and an Idempotency-Key on every command before the service runs', async () => {
    const service = { attest: jest.fn(), approve: jest.fn(), reject: jest.fn() };
    const controller = new AdminClinicianApplicationsController(service as unknown as ClinicianApplicationAdminService);
    const request = { actor: context.actor, accessScope: 'platform', correlationId: 'c', ip: '192.0.2.1',
      header: () => undefined } as unknown as HidRequest;
    const calls: Array<[string, (ifMatch?: string, key?: string) => unknown]> = [
      ['attest', (ifMatch, key) => controller.attest(APPLICATION, ifMatch, key, attestInput, request)],
      ['approve', (ifMatch, key) => controller.approve(APPLICATION, ifMatch, key, { reason: 'Second review done' }, request)],
      ['reject', (ifMatch, key) => controller.reject(APPLICATION, ifMatch, key,
        { decisionCode: 'other', reason: 'Not a clinician' } as RejectClinicianApplicationDto, request)],
    ];
    for (const [, call] of calls) {
      expect(() => call(undefined, KEY)).toThrow(expect.objectContaining({ code: 'IF_MATCH_REQUIRED' }));
      expect(() => call('"3"', undefined)).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REQUIRED' }));
    }
    expect(service.attest).not.toHaveBeenCalled();
    expect(service.approve).not.toHaveBeenCalled();
    expect(service.reject).not.toHaveBeenCalled();
    calls[0]![1]('W/"3"', KEY);
    expect(service.attest).toHaveBeenCalledWith(expect.objectContaining({ scope: 'platform' }), APPLICATION, 3,
      attestInput, KEY, { correlationId: 'c', sourceIp: '192.0.2.1', userAgent: undefined });
  });
});

describe('the command DTOs', () => {
  it('accepts exactly the step-1 checklist and refuses any false, unknown or missing check', async () => {
    const errors = async (value: object) => validate(plainToInstance(AttestClinicianApplicationDto, value));
    expect(await errors(attestInput)).toEqual([]);
    for (const change of [{ registerChecked: false }, { identityMethod: 'phone_call' }, { employmentChannel: 'org_admin' },
      { identityConfirmed: 'true' }, { employmentConfirmed: undefined }]) {
      expect((await errors({ ...attestInput, checklist: { ...checklist, ...change } })).length).toBeGreaterThan(0);
    }
    for (const change of [{ authenticatorCode: '12345' }, { evidenceReference: 'short' }, { reason: 'brief' },
      { validUntil: '2027-06-31' }]) {
      expect((await errors({ ...attestInput, ...change })).length).toBeGreaterThan(0);
    }
    expect((await validate(plainToInstance(RejectClinicianApplicationDto, { decisionCode: 'fraud',
      reason: 'Internal reason text' }))).length).toBeGreaterThan(0);
    const list = plainToInstance(ListClinicianApplicationsDto, {});
    expect([list.state, list.limit]).toEqual(['open', 20]);
    expect((await validate(plainToInstance(ListClinicianApplicationsDto, { limit: '51' }))).length).toBeGreaterThan(0);
    expect((await validate(plainToInstance(ListClinicianApplicationsDto, { state: 'pending' }))).length).toBeGreaterThan(0);
  });

  it('lets a Super Admin switch clinician_signup_enabled through the controls command', async () => {
    const valid = await validate(plainToInstance(PlatformControlCommandDto, { controlKey: 'clinician_signup_enabled',
      enabled: true, reason: 'Open clinician sign-up' }));
    expect(valid).toEqual([]);
    const unknown = await validate(plainToInstance(PlatformControlCommandDto, { controlKey: 'clinician_signup',
      enabled: true, reason: 'Open clinician sign-up' }));
    expect(unknown.length).toBeGreaterThan(0);
  });
});

describe('step 1 (attest)', () => {
  const commands = (prior: unknown = null) => ({
    'admin_clinician_application_prior': rows({ prior }),
    'admin_clinician_application_attest_precheck': rows({ account_id: APPLICANT }),
    'admin_attest_clinician_application': rows(attestRow),
  });
  const stored = { applicationId: APPLICATION, state: 'under_review', attestationId: ATTESTATION,
    validUntil: '2027-06-30T22:59:59+00:00', applicationVersion: 4, accountId: APPLICANT, facilityId: FACILITY,
    roleCode: 'doctor' };
  const marked = (message: string) => () => { throw Object.assign(new Error(message), { code: 'P0001' }); };

  it('checks the session, probes for a replay, pre-checks, takes both account locks, probes and pre-checks again, confirms the live code, attests and audits twice, in one transaction', async () => {
    const h = harness(commands());
    const answer = await h.service.attest(context, APPLICATION, 3, attestInput, KEY, event);
    expect(answer).toEqual({ applicationId: APPLICATION, state: 'under_review', attestationId: ATTESTATION,
      attestedRoles: ['doctor'], verificationMethod: 'manual_review', validUntil: '2027-06-30T22:59:59.000Z',
      version: 4, replayed: false });
    expect(h.order).toEqual(['assurance', 'admin_clinician_application_prior',
      'admin_clinician_application_attest_precheck', 'lock', 'admin_clinician_application_prior',
      'admin_clinician_application_attest_precheck', 'confirm', 'admin_attest_clinician_application', 'audit', 'audit']);
    expect(h.transactions).toHaveLength(1);
    expect(h.mfa.lockApplicantReview).toHaveBeenCalledWith(expect.anything(),
      { applicantAccountId: APPLICANT, actorAccountId: context.actor.accountId });
    expect(h.statements.filter(({ sql }) => sql.includes('admin_clinician_application_attest_precheck'))
      .map(({ values }) => values)).toEqual(Array(2).fill([APPLICATION, 3, '2027-06-30T22:59:59.000Z',
      'Review ticket CLIN-0001', JSON.stringify(checklist), 'Licence and identity verified', KEY]));
    expect(h.mfa.confirmApplicantFactor).toHaveBeenCalledWith(expect.anything(),
      { applicantAccountId: APPLICANT, actorAccountId: context.actor.accountId }, '123456', event);
    const { authenticatorCode: _code, ...withoutCode } = attestInput;
    const digest = requestDigest('platform.clinician-application:platform.clinician-application.attest',
      { applicationId: APPLICATION, expectedVersion: 3, ...withoutCode });
    expect(h.statements[0]!.values).toEqual(['workforce.clinician-application.attest', KEY, digest]);
    const attest = h.statements.find(({ sql }) => sql.includes('admin_attest_clinician_application'))!;
    expect(attest.values).toEqual([APPLICATION, 3, '2027-06-30T22:59:59.000Z', 'Review ticket CLIN-0001',
      JSON.stringify(checklist), FACTOR, 'Licence and identity verified', KEY, digest]);
    // The code is neither stored, audited nor part of the digest.
    expect(JSON.stringify(h.statements)).not.toContain('123456');
    expect(JSON.stringify(h.audit.recordWithClient.mock.calls)).not.toContain('123456');
    expect(h.audit.recordWithClient.mock.calls.map(([, row]) => (row as { action: string }).action))
      .toEqual(['admin.clinician-application.attested', 'admin.workforce.credential.attested']);
    expect(h.audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'admin.clinician-application.attested', resourceType: 'clinician-application', resourceId: APPLICATION,
      accessScope: 'platform', outcome: 'success', reason: 'Licence and identity verified',
      details: { applicationId: APPLICATION, accountId: APPLICANT, facilityId: FACILITY, attestationId: ATTESTATION,
        attestedRoles: ['doctor'], validUntil: '2027-06-30T22:59:59.000Z', factorId: FACTOR,
        identityMethod: 'video_call_photo_id', employmentChannel: 'facility_public_phone' } }));
  });

  it('answers a replay from the stored answer without checking a code or auditing', async () => {
    const h = harness(commands(stored));
    const answer = await h.service.attest(context, APPLICATION, 3, { ...attestInput, authenticatorCode: '999999' }, KEY, event);
    expect(answer).toMatchObject({ applicationId: APPLICATION, replayed: true, version: 4, attestedRoles: ['doctor'] });
    expect(h.order).toEqual(['assurance', 'admin_clinician_application_prior']);
    expect(h.mfa.confirmApplicantFactor).not.toHaveBeenCalled();
    expect(h.audit.recordWithClient).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'invalid' }, 403, 'CLINICIAN_APPLICATION_AUTHENTICATOR_CODE_INVALID'],
    [{ kind: 'rate_limited' }, 429, 'CLINICIAN_APPLICATION_AUTHENTICATOR_RATE_LIMITED'],
    [{ kind: 'no_factor' }, 409, 'CLINICIAN_APPLICATION_AUTHENTICATOR_REQUIRED'],
  ])('commits a refused confirmation (%o) and then answers %i %s, attesting nothing', async (confirmation, status, code) => {
    const h = harness(commands(), confirmation);
    const problem = await refusal(h.service.attest(context, APPLICATION, 3, attestInput, KEY, event));
    expect([problem.getStatus(), problem.code]).toEqual([status, code]);
    if (status === 429) expect((problem as RetryAfterProblem).retryAfterSeconds).toBeGreaterThan(0);
    expect(h.transactions).toEqual([{ settled: true }]);
    expect(h.order).not.toContain('admin_attest_clinician_application');
    expect(h.audit.recordWithClient).not.toHaveBeenCalled();
  });

  it.each([
    ['WORKFORCE_FACILITY_CONFLICT', 403, 'WORKFORCE_FACILITY_CONFLICT'],
    ['CLINICIAN_APPLICATION_STATE_INVALID', 409, 'CLINICIAN_APPLICATION_STATE_INVALID'],
    ['ADMIN_VERSION_CONFLICT', 409, 'VERSION_CONFLICT'],
    ['CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE', 409, 'CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE'],
    ['WORKFORCE_SELF_CHANGE_DENIED', 403, 'WORKFORCE_SELF_CHANGE_DENIED'],
    ['WORKFORCE_FACILITY_NOT_VERIFIED', 409, 'WORKFORCE_FACILITY_NOT_VERIFIED'],
    ['CLINICIAN_APPLICATION_NOT_FOUND', 404, 'CLINICIAN_APPLICATION_NOT_FOUND'],
    // What C20 refused only after the code: the request's own fields, a key
    // used for a generic 0087 attestation, the applicant account and staff record.
    ['CLINICIAN_APPLICATION_COMMAND_INVALID', 400, 'CLINICIAN_APPLICATION_COMMAND_INVALID'],
    ['ADMIN_IDEMPOTENCY_CONFLICT', 409, 'IDEMPOTENCY_CONFLICT'],
    ['WORKFORCE_ACCOUNT_INELIGIBLE', 409, 'WORKFORCE_ACCOUNT_INELIGIBLE'],
    ['WORKFORCE_STAFF_INELIGIBLE', 409, 'WORKFORCE_STAFF_INELIGIBLE'],
    ['WORKFORCE_STAFF_NOT_FOUND', 404, 'WORKFORCE_STAFF_NOT_FOUND'],
  ])('refuses %s from the pre-check before any lock or code, so no failure is counted', async (message, status, code) => {
    const h = harness({ ...commands(), 'admin_clinician_application_attest_precheck': marked(message) });
    const problem = await refusal(h.service.attest(context, APPLICATION, 3, attestInput, KEY, event));
    expect([problem.getStatus(), problem.code]).toEqual([status, code]);
    expect(h.mfa.lockApplicantReview).not.toHaveBeenCalled();
    expect(h.mfa.confirmApplicantFactor).not.toHaveBeenCalled();
    expect(h.order).not.toContain('admin_attest_clinician_application');
  });

  it('pre-checks the reason as step 1 gets it (trimmed), so a blank one is refused before the code', async () => {
    const h = harness(commands());
    await h.service.attest(context, APPLICATION, 3, { ...attestInput, reason: '   Licence and identity verified   ' },
      KEY, event);
    const prechecked = h.statements.filter(({ sql }) => sql.includes('admin_clinician_application_attest_precheck'));
    const attest = h.statements.find(({ sql }) => sql.includes('admin_attest_clinician_application'))!;
    expect(prechecked.map(({ values }) => values[5])).toEqual(['Licence and identity verified', 'Licence and identity verified']);
    expect(attest.values[6]).toBe('Licence and identity verified');
  });

  it('refuses, under the locks and before any code, an application that changed while it waited', async () => {
    let prechecks = 0;
    const h = harness({ ...commands(), 'admin_clinician_application_attest_precheck': () => {
      prechecks += 1;
      if (prechecks === 1) return { rows: [{ account_id: APPLICANT }], rowCount: 1 };
      throw Object.assign(new Error('CLINICIAN_APPLICATION_STATE_INVALID'), { code: 'P0001' });
    } });
    const problem = await refusal(h.service.attest(context, APPLICATION, 3, attestInput, KEY, event));
    expect([problem.getStatus(), problem.code]).toEqual([409, 'CLINICIAN_APPLICATION_STATE_INVALID']);
    expect(h.mfa.lockApplicantReview).toHaveBeenCalledTimes(1);
    expect(h.mfa.confirmApplicantFactor).not.toHaveBeenCalled();
  });

  it('answers a concurrent request with the same key from its stored answer once it holds the locks, checking no code', async () => {
    let probes = 0;
    const h = harness({ ...commands(), 'admin_clinician_application_prior': () => {
      probes += 1;
      return { rows: [{ prior: probes === 1 ? null : stored }], rowCount: 1 };
    } });
    const answer = await h.service.attest(context, APPLICATION, 3, attestInput, KEY, event);
    expect(answer).toMatchObject({ applicationId: APPLICATION, attestationId: ATTESTATION, replayed: true, version: 4 });
    expect(h.order).toEqual(['assurance', 'admin_clinician_application_prior',
      'admin_clinician_application_attest_precheck', 'lock', 'admin_clinician_application_prior']);
    expect(h.mfa.confirmApplicantFactor).not.toHaveBeenCalled();
    expect(h.audit.recordWithClient).not.toHaveBeenCalled();
    expect(h.transactions).toEqual([{ settled: true }]);
  });

  it('refuses the applicant reviewing their own application before checking any code', async () => {
    const own = { ...context, actor: platformActor({ accountId: APPLICANT,
      platformPermissions: ['platform.admin.access', 'platform.workforce.manage'] }) };
    const h = harness(commands());
    const problem = await refusal(h.service.attest(own, APPLICATION, 3, attestInput, KEY, event));
    expect([problem.getStatus(), problem.code]).toEqual([403, 'WORKFORCE_SELF_CHANGE_DENIED']);
    expect(h.mfa.confirmApplicantFactor).not.toHaveBeenCalled();
  });

  it('refuses without a fresh step-up before touching the application', async () => {
    const h = harness(commands());
    const stale = assuredClient(jest.fn(), { stepUpFresh: false, stepUpExpired: true });
    const database = { withTransaction: jest.fn(async (_c, operation) => operation(stale as unknown as PoolClient)) };
    const service = new ClinicianApplicationAdminService(database as unknown as DatabaseService,
      h.audit as unknown as AuditService, h.mfa as unknown as MfaService);
    const problem = await refusal(service.attest(context, APPLICATION, 3, attestInput, KEY, event));
    expect(problem.code).toMatch(/^STEP_UP_(REQUIRED|EXPIRED)$/);
    expect(h.mfa.confirmApplicantFactor).not.toHaveBeenCalled();
  });
});

describe('step 2 (approve) and reject', () => {
  it('approves through the pinned command and audits three events; a replay audits none', async () => {
    const h = harness({ 'admin_approve_clinician_application': rows(approveRow) });
    const answer = await h.service.approve(context, APPLICATION, 4, { reason: 'Second review complete' }, KEY);
    expect(answer).toEqual({ applicationId: APPLICATION, state: 'approved', accountId: APPLICANT, facilityId: FACILITY,
      membershipId: MEMBERSHIP, roleCode: 'doctor', attestationId: ATTESTATION, version: 5, replayed: false });
    expect(h.order).toEqual(['assurance', 'admin_approve_clinician_application', 'audit', 'audit', 'audit']);
    expect(h.statements[0]!.values).toEqual([APPLICATION, 4, 'Second review complete', KEY,
      requestDigest('platform.clinician-application:platform.clinician-application.approve',
        { applicationId: APPLICATION, expectedVersion: 4, reason: 'Second review complete' })]);
    expect(h.audit.recordWithClient.mock.calls.map(([, row]) => (row as { action: string }).action))
      .toEqual(['admin.clinician-application.approved', 'admin.workforce.membership.attached', 'admin.workforce.role.granted']);
    expect(h.audit.recordWithClient).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      details: { facilityId: FACILITY, roleCode: 'doctor', membershipActive: true, attestationId: ATTESTATION,
        renewed: false } }));
    const replay = harness({ 'admin_approve_clinician_application': rows({ ...approveRow, replayed: true }) });
    await expect(replay.service.approve(context, APPLICATION, 4, { reason: 'Second review complete' }, KEY))
      .resolves.toMatchObject({ replayed: true });
    expect(replay.audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('rejects with one audit event; a replay audits none', async () => {
    const h = harness({ 'admin_reject_clinician_application': rows(rejectRow) });
    const input = { decisionCode: 'identity_not_confirmed', reason: 'Photo ID did not match' } as RejectClinicianApplicationDto;
    await expect(h.service.reject(context, APPLICATION, 3, input, KEY)).resolves.toEqual({ applicationId: APPLICATION,
      state: 'rejected', decisionCode: 'identity_not_confirmed', version: 4, replayed: false });
    expect(h.statements[0]!.values).toEqual([APPLICATION, 3, 'identity_not_confirmed', 'Photo ID did not match', KEY,
      requestDigest('platform.clinician-application:platform.clinician-application.reject',
        { applicationId: APPLICATION, expectedVersion: 3, ...input })]);
    expect(h.audit.recordWithClient).toHaveBeenCalledTimes(1);
    expect(h.audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'admin.clinician-application.rejected', details: { applicationId: APPLICATION, accountId: APPLICANT,
        facilityId: FACILITY, decisionCode: 'identity_not_confirmed', fromState: 'submitted',
        furtherApplicationsBlocked: true } }));
    const replay = harness({ 'admin_reject_clinician_application': rows({ ...rejectRow, replayed: true }) });
    await replay.service.reject(context, APPLICATION, 3, input, KEY);
    expect(replay.audit.recordWithClient).not.toHaveBeenCalled();
  });
});

describe('the queue', () => {
  const listRow = (index: number) => ({ id: `60000000-0000-4000-8000-0000000000${String(index).padStart(2, '0')}`,
    state: 'submitted', version: '2', submitted_at: new Date('2026-10-01T10:00:00Z'),
    expires_at: new Date('2026-10-31T10:00:00Z'), account_id: APPLICANT, applicant_full_name: 'Ada Synthetic',
    email: 'ada@example.invalid', requested_role: 'doctor', regulator_code: 'MDCN',
    issuing_authority: 'Medical and Dental Council of Nigeria', licence_number: 'MDCN/12345',
    licence_valid_until: '2027-06-30', facility_id: FACILITY, facility_name: 'Synthetic Clinic',
    organization_name: 'Synthetic Health', attested_by: null, attested_by_name: null, attested_at: null,
    authenticator_ready: true, cursor_at: `2026-10-01T10:00:00.0000${String(index).padStart(2, '0')}Z` });

  it('pages oldest-first open applications with a cursor bound to the state', async () => {
    const h = harness({ 'admin_list_clinician_applications': () => ({ rows: [listRow(1), listRow(2), listRow(3)] }) });
    const page = await h.service.list(context, { state: 'open', limit: 2 } as ListClinicianApplicationsDto);
    expect(h.statements[0]!.values).toEqual(['open', null, null, 3]);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toEqual({ applicationId: listRow(1).id, state: 'submitted', version: 2,
      submittedAt: '2026-10-01T10:00:00.000Z', expiresAt: '2026-10-31T10:00:00.000Z',
      applicant: { accountId: APPLICANT, fullName: 'Ada Synthetic', email: 'ada@example.invalid' }, profession: 'doctor',
      regulator: { code: 'MDCN', name: 'Medical and Dental Council of Nigeria' }, licenceNumber: 'MDCN/12345',
      licenceValidUntil: '2027-06-30', facility: { id: FACILITY, name: 'Synthetic Clinic', organizationName: 'Synthetic Health' },
      authenticatorReady: true, step1: null });
    expect(page.nextCursor).toEqual(expect.any(String));
    const next = harness({ 'admin_list_clinician_applications': () => ({ rows: [listRow(3)] }) });
    const last = await next.service.list(context, { state: 'open', limit: 2, cursor: page.nextCursor! } as ListClinicianApplicationsDto);
    expect(next.statements[0]!.values).toEqual(['open', '2026-10-01T10:00:00.000002Z', listRow(2).id, 3]);
    expect(last.nextCursor).toBeNull();
    const other = await refusal(next.service.list(context, { state: 'approved', limit: 2,
      cursor: page.nextCursor! } as ListClinicianApplicationsDto));
    expect([other.getStatus(), other.code]).toEqual([400, 'ADMIN_INVALID_CURSOR']);
  });

  it('asks for at most 50 rows and offers a next page when a 50-row page is full', async () => {
    const full = Array.from({ length: 50 }, (_, index) => listRow(index + 1));
    const h = harness({ 'admin_list_clinician_applications': () => ({ rows: full }) });
    const page = await h.service.list(context, { state: 'approved', limit: 50 } as ListClinicianApplicationsDto);
    expect(h.statements[0]!.values).toEqual(['approved', null, null, 50]);
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).toEqual(expect.any(String));
  });
});

describe('the error map', () => {
  it.each([
    ['CLINICIAN_APPLICATION_COMMAND_INVALID', 400, 'CLINICIAN_APPLICATION_COMMAND_INVALID'],
    ['CLINICIAN_APPLICATION_SECOND_ADMIN_REQUIRED', 403, 'CLINICIAN_APPLICATION_SECOND_ADMIN_REQUIRED'],
    ['CLINICIAN_APPLICATION_NOT_FOUND', 404, 'CLINICIAN_APPLICATION_NOT_FOUND'],
    ['CLINICIAN_APPLICATION_STATE_INVALID', 409, 'CLINICIAN_APPLICATION_STATE_INVALID'],
    ['CLINICIAN_APPLICATION_AUTHENTICATOR_REQUIRED', 409, 'CLINICIAN_APPLICATION_AUTHENTICATOR_REQUIRED'],
    ['CLINICIAN_APPLICATION_AUTHENTICATOR_CHANGED', 409, 'CLINICIAN_APPLICATION_AUTHENTICATOR_CHANGED'],
    ['CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE', 409, 'CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE'],
    ['WORKFORCE_SELF_CHANGE_DENIED', 403, 'WORKFORCE_SELF_CHANGE_DENIED'],
    ['WORKFORCE_FACILITY_CONFLICT', 403, 'WORKFORCE_FACILITY_CONFLICT'],
    ['WORKFORCE_ATTESTATION_REQUIRED', 409, 'WORKFORCE_ATTESTATION_REQUIRED'],
    ['WORKFORCE_MEMBERSHIP_EXISTS', 409, 'WORKFORCE_MEMBERSHIP_EXISTS'],
    ['WORKFORCE_FACILITY_NOT_VERIFIED', 409, 'WORKFORCE_FACILITY_NOT_VERIFIED'],
    ['ADMIN_VERSION_CONFLICT', 409, 'VERSION_CONFLICT'],
    ['ADMIN_IDEMPOTENCY_CONFLICT', 409, 'IDEMPOTENCY_CONFLICT'],
    ['ADMIN_STEP_UP_REQUIRED', 403, 'STEP_UP_REQUIRED'],
    ['ADMIN_MFA_REQUIRED', 403, 'MFA_REQUIRED'],
    ['CLINICIAN_APPLICATION_GRANT_MISMATCH: the grant did not rest on the step-1 attestation', 503,
      'ADMIN_COMMAND_UNAVAILABLE'],
  ])('%s is %i %s', (message, status, code) => {
    const problem = adminCommandError(Object.assign(new Error(message), { code: 'P0001' })) as DomainProblem;
    expect([problem.getStatus(), problem.code]).toEqual([status, code]);
  });
});
