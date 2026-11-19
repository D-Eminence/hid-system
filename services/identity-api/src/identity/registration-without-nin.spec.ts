import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as environment from '../config/environment';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { TEST_FIELD_KEY_B64 } from '../../test/collected-fields.fixtures';
import { createContactLookupHmac } from './contact-lookup';
import { RegisterWithoutNinDto } from './dto/register-without-nin.dto';
import { NinRegistrationController } from './nin-registration.controller';
import { NinRegistrationService } from './nin-registration.service';
import {
  NO_NIN_FACILITY_DAILY_ALERT, RegistrationWithoutNinService, WITHOUT_NIN_MESSAGES,
} from './registration-without-nin.service';

// 0130 (ID-2, owner Q106 of 18 November 2026). Fictional people and identifiers only.
const facilityId = '0b0e0f10-0000-4000-8000-000000000002';
const deskAccount = '0b0e0f10-0000-4000-8000-000000000101';
const approverAccount = '0b0e0f10-0000-4000-8000-000000000103';
const caseId = '0b0e0f10-0000-4000-8000-000000000501';
const patientId = '0b0e0f10-0000-4000-8000-000000000401';

function context(accountId = deskAccount, permissions = ['identity.registration.write']): DataAccessContext {
  return {
    actor: {
      kind: 'staff', subject: `synthetic:${accountId}`, accountId, permissions,
      facility: { facilityId, organizationId: '0b0e0f10-0000-4000-8000-000000000001', roles: ['receptionist'] },
    },
    facilityId, membershipId: '0b0e0f10-0000-4000-8000-000000000301', correlationId: 'no-nin-spec-0001',
    purposeOfUse: 'healthcare-operations',
  } as unknown as DataAccessContext;
}

function body(overrides: Record<string, unknown> = {}) {
  return plainToInstance(RegisterWithoutNinDto, {
    firstName: 'Ngozi', lastName: 'Fictional', dateOfBirth: '1990-03-04', noNinReason: 'no_nin',
    purpose: 'healthcare-operations', phone: '08031234567', addressLine: '12 Fictional Road, Yaba', city: 'Lagos',
    stateCode: 'LA', lga: 'Lagos Mainland', hasExistingHealthId: false, ...overrides,
  });
}

function databaseError(code: string, message: string, constraint?: string) {
  return Object.assign(new Error(message), { code, constraint });
}

function setup(rows: Array<Record<string, unknown> | Error>) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const query = jest.fn(async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    const next = rows.shift();
    if (next instanceof Error) throw next;
    return { rows: next ? [next] : [], rowCount: next ? 1 : 0 };
  });
  const database = { withTransaction: jest.fn(async (_context: unknown, action: (client: unknown) => unknown) => action({ query })) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  let draw = 0;
  const hidGenerator = {
    reserve: jest.fn(async (reservation: (hid: string) => Promise<{ reserved: boolean; result?: unknown }>) => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        draw += 1;
        const outcome = await reservation(`HID-QX${draw}K2M`);
        if (outcome.reserved) return outcome.result;
      }
      throw new Error('no Health ID');
    }),
  };
  const service = new RegistrationWithoutNinService(database as never, audit as never, hidGenerator as never);
  return { service, statements, audit, hidGenerator, database };
}

const created = {
  case_id: caseId, case_status: 'approved_new_identity', case_version: '1', subject_patient_id: patientId,
  subject_hid_code: 'HID-QX1K2M', candidate_count: 0, facility_daily_count: 3, replayed: false,
};
const sentForReview = {
  case_id: caseId, case_status: 'review_required', case_version: '1', subject_patient_id: null,
  subject_hid_code: null, candidate_count: 2, facility_daily_count: 4, replayed: false,
};

describe('registration without a NIN (0130, ID-2)', () => {
  beforeEach(() => {
    jest.spyOn(environment, 'getEnvironment').mockReturnValue({ NODE_ENV: 'test',
      NIN_ENCRYPTION_KEY_B64: TEST_FIELD_KEY_B64, NIN_KEY_VERSION: 'test-v1',
      CONTACT_LOOKUP_HMAC_KEY_B64: Buffer.alloc(32, 9).toString('base64') } as environment.Environment);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('the request', () => {
    it('needs a phone and address unless the patient is a child', async () => {
      const adult = await validate(body({ phone: undefined, addressLine: undefined, city: undefined,
        stateCode: undefined, lga: undefined }));
      expect(adult.map((error) => error.property).sort()).toEqual(['addressLine', 'city', 'lga', 'phone', 'stateCode']);
      const child = await validate(body({ noNinReason: 'child', phone: undefined, addressLine: undefined,
        city: undefined, stateCode: undefined, lga: undefined }));
      expect(child).toEqual([]);
      const partialChild = await validate(body({ noNinReason: 'child', addressLine: undefined }));
      expect(partialChild.map((error) => error.property)).toEqual(['addressLine']);
    });

    it('takes only the five reasons and healthcare operations', async () => {
      expect((await validate(body({ noNinReason: 'lost_it' }))).map((error) => error.property)).toEqual(['noNinReason']);
      expect((await validate(body({ purpose: 'direct-care' }))).map((error) => error.property)).toEqual(['purpose']);
      expect(await validate(body({ noNinReason: 'foreign_national' }))).toEqual([]);
    });

    it('takes a stated Health ID only in its shape', async () => {
      expect(await validate(body({ hasExistingHealthId: true, existingHealthId: 'hid-qx7k2m' }))).toEqual([]);
      expect((await validate(body({ hasExistingHealthId: true }))).map((error) => error.property))
        .toEqual(['existingHealthId']);
    });
  });

  describe('register', () => {
    it('creates the patient when there is no possible duplicate, sending only protected values', async () => {
      const { service, statements } = setup([created]);
      const answer = await service.register(body(), 'no-nin-spec-key-0001', context());
      expect(answer).toEqual({
        caseId, status: 'approved_new_identity', version: 1, outcome: 'registered',
        message: WITHOUT_NIN_MESSAGES.registered, identityEvidence: 'none', ninStatus: 'not_verified',
        replayed: false, patient: { patientId, hid: 'HID-QX1K2M' },
      });
      const [{ sql, values }] = statements as [{ sql: string; values: unknown[] }];
      expect(sql).toContain('identity.register_patient_without_nin(');
      // The phone goes only as lookup hashes (both stored forms of a Nigerian number) and ciphertext.
      expect(values[6]).toBe(`${createContactLookupHmac('phone', '+2348031234567')},`
        + createContactLookupHmac('phone', '+23408031234567'));
      expect(values[7]).toBeInstanceOf(Buffer);
      expect(values[8]).toBeInstanceOf(Buffer);
      expect(values[9]).toBe('test-v1');
      expect(values[10]).toBeNull();
      expect(JSON.stringify(values)).not.toMatch(/8031234567|Fictional Road/);
      expect(values[13]).toBe('HID-QX1K2M');
    });

    it('tells the desk only that the registration was sent for review', async () => {
      const { service } = setup([sentForReview]);
      const answer = await service.register(body(), 'no-nin-spec-key-0002', context());
      expect(answer).toEqual({
        caseId, status: 'review_required', version: 1, outcome: 'sent_for_review',
        message: WITHOUT_NIN_MESSAGES.sentForReview, identityEvidence: 'none', ninStatus: 'not_verified', replayed: false,
      });
      expect(JSON.stringify(answer)).not.toMatch(/candidate|unverified/i);
    });

    it('sends no phone for a child registered without one', async () => {
      const { service, statements } = setup([created]);
      await service.register(body({ noNinReason: 'child', dateOfBirth: '2020-01-01', phone: undefined,
        addressLine: undefined, city: undefined, stateCode: undefined, lga: undefined }), 'no-nin-spec-key-0003', context());
      expect(statements[0]!.values.slice(6, 10)).toEqual([null, null, null, null]);
    });

    it('takes a new Health ID when the first one is taken', async () => {
      const { service, statements } = setup([databaseError('23505', 'duplicate', 'patients_hid_code_ci_uq'), created]);
      await service.register(body(), 'no-nin-spec-key-0004', context());
      expect(statements.map((statement) => statement.values[13])).toEqual(['HID-QX1K2M', 'HID-QX2K2M']);
    });

    it('refuses a stated Health ID the patient did not say they have, and audits it', async () => {
      const { service, statements, audit } = setup([]);
      await expect(service.register(body({ existingHealthId: 'HID-QX7K2M' }), 'no-nin-spec-key-0005', context()))
        .rejects.toMatchObject({ code: 'REGISTRATION_WITHOUT_NIN_INVALID' });
      expect(statements).toEqual([]);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied',
        details: { code: 'STATED_HEALTH_ID_UNEXPECTED' } }));
    });

    it.each([
      ['42501', 'NO_NIN_REGISTRATION_DENIED', 403, 'REGISTRATION_WITHOUT_NIN_DENIED'],
      ['42501', 'NO_NIN_REGISTRATION_SEALED_FACILITY', 403, 'REGISTRATION_WITHOUT_NIN_NOT_AVAILABLE'],
      ['22023', 'NO_NIN_REGISTRATION_PHONE_REQUIRED', 400, 'PHONE_REQUIRED'],
      ['22023', 'NO_NIN_REGISTRATION_NOT_A_CHILD', 400, 'NOT_A_CHILD'],
      ['22023', 'NO_NIN_REGISTRATION_INVALID', 400, 'REGISTRATION_WITHOUT_NIN_INVALID'],
      ['22023', 'IDEMPOTENCY_KEY_REUSED', 409, 'IDEMPOTENCY_KEY_REUSED'],
    ])('answers %s %s as %s %s, in plain words, and audits the refusal', async (sqlstate, message, status, code) => {
      const { service, audit } = setup([databaseError(sqlstate, message)]);
      const failure = await service.register(body(), 'no-nin-spec-key-0006', context()).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DomainProblem);
      expect((failure as DomainProblem).getStatus()).toBe(status);
      expect((failure as DomainProblem).code).toBe(code);
      expect(JSON.stringify((failure as DomainProblem).getResponse())).not.toMatch(/NO_NIN_|unverified/i);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
        action: 'identity.registration.without-nin', outcome: 'denied', details: { code } }));
    });

    it('logs an alert with no identifiers when a facility registers many patients without a NIN in a day', async () => {
      const { service } = setup([{ ...created, facility_daily_count: NO_NIN_FACILITY_DAILY_ALERT }]);
      const warn = jest.spyOn((service as unknown as { logger: { warn: (message: string) => void } }).logger, 'warn')
        .mockImplementation(() => undefined);
      await service.register(body(), 'no-nin-spec-key-0007', context());
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatch(/facility_daily_high/);
      expect(warn.mock.calls[0]![0]).not.toMatch(/Ngozi|8031234567|HID-/);
    });
  });

  describe('review', () => {
    it.each([['create_new', 'approved_new_identity'], ['link_existing', 'linked_existing'], ['reject', 'rejected']] as const)(
      '%s', async (decision, status) => {
        const { service, statements } = setup([{ case_id: caseId, case_status: status, case_version: '2',
          subject_patient_id: decision === 'reject' ? null : patientId,
          subject_hid_code: decision === 'reject' ? null : 'HID-QX7K2M', candidate_count: 1, replayed: false }]);
        const answer = await service.review(caseId, decision, { expectedVersion: 1, reason: 'Checked the card at the desk',
          ...(decision === 'link_existing' ? { patientId } : {}) }, 'no-nin-review-key-01', context(approverAccount,
          ['identity.registration.approve']));
        expect(answer).toMatchObject({ caseId, status, version: 2, identityEvidence: 'none', ninStatus: 'not_verified' });
        expect(statements[0]!.values[2]).toBe(decision);
        expect(statements[0]!.values[7]).toBe(decision === 'create_new' ? 'HID-QX1K2M' : null);
      });

    it.each([
      ['42501', 'NO_NIN_REVIEW_SECOND_PERSON', 403, 'REGISTRATION_REVIEW_SECOND_PERSON_REQUIRED'],
      ['42501', 'NO_NIN_REVIEW_DENIED', 403, 'REGISTRATION_REVIEW_DENIED'],
      ['P0002', 'REGISTRATION_CASE_NOT_FOUND', 404, 'REGISTRATION_CASE_NOT_FOUND'],
      ['55000', 'VERSION_CONFLICT', 412, 'VERSION_CONFLICT'],
      ['55000', 'PATIENT_NOT_A_REVIEW_CANDIDATE', 409, 'PATIENT_NOT_A_REVIEW_CANDIDATE'],
      ['55000', 'NO_NIN_REVIEW_NOT_AWAITING', 409, 'REGISTRATION_CASE_ALREADY_DECIDED'],
    ])('answers %s %s as %s %s', async (sqlstate, message, status, code) => {
      const { service, audit } = setup([databaseError(sqlstate, message)]);
      const failure = await service.review(caseId, 'reject', { expectedVersion: 1, reason: 'Checked the card at the desk' },
        'no-nin-review-key-02', context(approverAccount, ['identity.registration.approve'])).catch((error: unknown) => error);
      expect((failure as DomainProblem).getStatus()).toBe(status);
      expect((failure as DomainProblem).code).toBe(code);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
        action: 'identity.registration.without-nin.review', outcome: 'denied', resourceId: caseId }));
    });
  });

  describe('routes', () => {
    function request(permissions: string[], accountId = approverAccount) {
      const ctx = context(accountId, permissions);
      return {
        actor: ctx.actor, facilityId, membershipId: ctx.membershipId, correlationId: ctx.correlationId,
        header: () => undefined,
      } as never;
    }

    it('sends a decision on a registration without a NIN to its own command', async () => {
      const withoutNin = { evidenceOf: jest.fn().mockResolvedValue('none'), review: jest.fn().mockResolvedValue({ ok: 1 }) };
      const registrations = { approveNew: jest.fn(), linkExisting: jest.fn() };
      const routes = new NinRegistrationController(registrations as never, undefined, withoutNin as never);
      const input = { expectedVersion: 1, reason: 'Checked the card at the desk', purpose: 'healthcare-operations' };
      await routes.approveNew(caseId, input as never, 'no-nin-route-key-0001', request(['identity.registration.approve']));
      await routes.linkExisting(caseId, { ...input, patientId } as never, 'no-nin-route-key-0002',
        request(['identity.registration.approve']));
      expect(withoutNin.review.mock.calls.map((call) => call[1])).toEqual(['create_new', 'link_existing']);
      expect(registrations.approveNew).not.toHaveBeenCalled();
      expect(registrations.linkExisting).not.toHaveBeenCalled();
    });

    it('leaves a NIN case to the NIN path', async () => {
      const withoutNin = { evidenceOf: jest.fn().mockResolvedValue('nin_verified'), review: jest.fn() };
      const registrations = { approveNew: jest.fn().mockResolvedValue({}) };
      const routes = new NinRegistrationController(registrations as never, undefined, withoutNin as never);
      await routes.approveNew(caseId, { expectedVersion: 1, reason: 'Checked the card at the desk',
        purpose: 'healthcare-operations' } as never, 'no-nin-route-key-0003', request(['identity.registration.approve']));
      expect(registrations.approveNew).toHaveBeenCalled();
      expect(withoutNin.review).not.toHaveBeenCalled();
    });
  });

  describe('getCase', () => {
    function caseRow(createdBy: string) {
      return { id: caseId, status: 'review_required', row_version: '1', resolved_patient_id: null, resolved_hid_code: null,
        candidate_count: '2', contact_recorded: true, nin_verified: false, identity_evidence: 'none',
        created_by_account_id: createdBy };
    }
    function serviceWith(createdBy: string) {
      const statements: string[] = [];
      const query = jest.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('"fullName"')) {
          return { rows: [{ patientId, fullName: 'Ada Fictional', dateOfBirth: '1980-01-02' }] };
        }
        return { rows: [caseRow(createdBy)] };
      });
      const database = { withTransaction: jest.fn(async (_context: unknown, action: (client: unknown) => unknown) => action({ query })) };
      const audit = { recordWithClient: jest.fn().mockResolvedValue(undefined) };
      return { service: new NinRegistrationService(database as never, audit as never, {} as never, {} as never, {} as never),
        statements, audit };
    }

    it('shows the desk no other person\'s details', async () => {
      const { service } = serviceWith(deskAccount);
      const answer = await service.getCase(caseId, context(deskAccount, ['identity.registration.write']));
      expect(answer).toMatchObject({ status: 'review_required', identityEvidence: 'none', ninStatus: 'not_verified',
        candidates: [] });
    });

    it('shows the creator no candidates even as an approver', async () => {
      const { service } = serviceWith(approverAccount);
      const answer = await service.getCase(caseId, context(approverAccount, ['identity.registration.approve']));
      expect(answer.candidates).toEqual([]);
    });

    it('shows another approver the minimal cards', async () => {
      const { service } = serviceWith(deskAccount);
      const answer = await service.getCase(caseId, context(approverAccount,
        ['identity.registration.write', 'identity.registration.approve']));
      expect(answer.candidates).toEqual([{ patientId, fullName: 'Ada Fictional', dateOfBirth: '1980-01-02' }]);
    });
  });
});
