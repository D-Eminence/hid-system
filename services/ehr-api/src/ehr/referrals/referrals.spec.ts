import { RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { ArgumentMetadata } from '@nestjs/common';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { createValidationPipe } from '../../common/validation-pipe';
import { getEnvironment, resetEnvironmentForTests } from '../../config/environment';
import type { DatabaseService } from '../../database/database.service';
import type { IdentityApiService } from '../../integrations/identity-api.service';
import { PatientReferralsController, ReferralsController } from './referrals.controller';
import {
  AcceptReferralDto, ArriveReferralDto, CompleteReferralDto, DeclineReferralDto, ReferralListQueryDto, SendReferralDto,
  WithdrawReferralDto,
} from './referrals.dto';
import {
  ACCEPT_SQL, ARRIVE_SQL, DECLINE_SQL, REFERRAL_MESSAGES, ReferralsService, SEND_SQL, WITHDRAW_SQL, queueEntry,
  refusal, requireReferralAccess, translate,
} from './referrals.service';

// Fictional identifiers only.
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const patientId = '123e4567-e89b-42d3-a456-426614174001';
const encounterId = '123e4567-e89b-42d3-a456-426614174061';
const referralId = '123e4567-e89b-42d3-a456-426614174091';
const receivingId = '123e4567-e89b-42d3-a456-426614174092';
const diagnosisId = '123e4567-e89b-42d3-a456-426614174093';
const matchRef = `psr_${'a'.repeat(43)}`;
const key = 'referral-test-key-0001';

const DOCTOR = ['ehr.encounter.read', 'ehr.encounter.write', 'ehr.referral.read', 'ehr.referral.send',
  'ehr.referral.receive', 'ehr.referral.arrive'];
const DESK = ['ehr.encounter.read', 'ehr.encounter.write', 'ehr.referral.arrive'];
const NURSE = ['ehr.encounter.read', 'ehr.encounter.write'];

const context = { correlationId: 'correlation-123456', facilityId, membershipId, purposeOfUse: 'direct-care',
  actor: { id: accountId, subject: 'staff:test', accountId, permissions: [] } } as unknown as DataAccessContext;

const card = { referralId, reference: '123E4567', side: 'sent', viewLevel: 'full', rowVersion: 1 };
const packageValue = { frozenAt: '2026-12-03T09:10:00.000Z', letterText: 'Dear colleague, ...',
  sections: { diagnoses: [], medicines: [], allergies: [], vitals: [], labResults: [] } };

const sendBody = (overrides: Record<string, unknown> = {}) => ({
  destination: { kind: 'health_id', facilityId: receivingId }, departmentCode: 'cardiology',
  serviceWanted: 'Cardiology clinic', urgency: 'routine', reason: 'New heart murmur with breathlessness',
  letterText: 'Dear colleague, please see this patient about a new heart murmur.',
  package: { diagnosisIds: [diagnosisId] }, attestationTextVersion: 'referral-health-id-attestation-v1',
  patientAgreed: true, ...overrides,
});

function fakeDatabase(rows: readonly Record<string, unknown>[] | Error) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const database = {
    withTransaction: jest.fn(async (_given: DataAccessContext, operation: (client: unknown) => Promise<unknown>) =>
      operation({
        query: async (sql: string, values: unknown[]) => {
          calls.push({ sql, values });
          if (rows instanceof Error) throw rows;
          return { rows };
        },
      })),
    withPatientTransaction: jest.fn(async (_authorization: unknown, _correlation: string,
      operation: (client: unknown) => Promise<unknown>) =>
      operation({
        query: async (sql: string, values: unknown[]) => {
          calls.push({ sql, values: values ?? [] });
          if (rows instanceof Error) throw rows;
          return { rows };
        },
      })),
  } as unknown as DatabaseService;
  return { database, calls };
}

const identity = {
  authorizeSelf: jest.fn(async () => ({ patientId, accountId, subject: 'patient:test', sessionId: 'session-1',
    expiresAt: new Date(Date.now() + 30_000).toISOString() })),
} as unknown as IdentityApiService;

async function validate<T>(type: new () => T, value: unknown, kind: ArgumentMetadata['type'] = 'body'): Promise<T> {
  return createValidationPipe().transform(value, { type: kind, metatype: type }) as Promise<T>;
}

async function problemOf(promise: Promise<unknown> | (() => unknown)): Promise<DomainProblem> {
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainProblem);
    return error as DomainProblem;
  }
  throw new Error('expected a refusal');
}

function staffRequest(permissions: string[], purpose: string | undefined = 'direct-care'): HidRequest {
  return {
    header: (name: string) => (name.toLowerCase() === 'x-purpose-of-use' ? purpose : undefined),
    correlationId: 'correlation-123456', facilityId, method: 'POST',
    actor: { kind: 'staff', id: accountId, subject: 'staff:test', accountId, permissions, roles: ['doctor'],
      facilityIds: [facilityId], facilities: [], facility: { id: facilityId, membershipId } },
  } as unknown as HidRequest;
}

function patientRequest(): HidRequest {
  return {
    header: () => undefined, correlationId: 'correlation-123456', method: 'GET',
    actor: { kind: 'patient', id: accountId, subject: 'patient:test', accountId, patientId, sessionId: 'session-1',
      permissions: [], roles: [], facilityIds: [], facilities: [] },
  } as unknown as HidRequest;
}

describe('REF-1 referrals between facilities (0191-0193)', () => {
  const original = { ...process.env };
  const base = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://ehr:test@localhost:5432/hid',
    CORS_ORIGINS: 'http://localhost:3000', STORAGE_MODE: 'disabled' };
  beforeEach(() => {
    Object.assign(process.env, base, { REFERRALS_ENABLED: 'true' });
    resetEnvironmentForTests();
  });
  afterEach(() => {
    for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  it('is off unless set to true', () => {
    delete process.env.REFERRALS_ENABLED;
    resetEnvironmentForTests();
    expect(getEnvironment().REFERRALS_ENABLED).toBe(false);
  });

  describe('routes', () => {
    it('serves the contract paths and methods', () => {
      expect(Reflect.getMetadata(PATH_METADATA, ReferralsController)).toBe('ehr');
      expect(Reflect.getMetadata(PATH_METADATA, PatientReferralsController)).toBe('ehr/me/referrals');
      const routes: [keyof ReferralsController, string, RequestMethod, number | undefined][] = [
        ['attestation', 'referral-attestation', RequestMethod.GET, undefined],
        ['send', 'patients/:patientId/encounters/:encounterId/referrals', RequestMethod.POST, 201],
        ['sent', 'referrals/sent', RequestMethod.GET, undefined],
        ['withdraw', 'referrals/:referralId/withdraw', RequestMethod.POST, 200],
        ['letter', 'referrals/:referralId/letter', RequestMethod.GET, undefined],
        ['read', 'referrals/:referralId', RequestMethod.GET, undefined],
        ['patient', 'patients/:patientId/referrals', RequestMethod.GET, undefined],
        ['incoming', 'referrals/incoming', RequestMethod.GET, undefined],
        ['received', 'referrals/received', RequestMethod.GET, undefined],
        ['accept', 'referrals/:referralId/accept', RequestMethod.POST, 200],
        ['decline', 'referrals/:referralId/decline', RequestMethod.POST, 200],
        ['expected', 'referrals/expected', RequestMethod.GET, undefined],
        ['arrive', 'referrals/:referralId/arrive', RequestMethod.POST, 200],
        ['complete', 'referrals/:referralId/complete', RequestMethod.POST, 200],
      ];
      for (const [method, path, verb, status] of routes) {
        const handler = ReferralsController.prototype[method];
        expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
        expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(verb);
        expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(status);
      }
      // The fixed list paths are declared before referrals/:referralId, so "sent" is never taken for an id.
      const order = Object.getOwnPropertyNames(ReferralsController.prototype);
      expect(order.indexOf('sent')).toBeLessThan(order.indexOf('read'));
      expect(order.indexOf('expected')).toBeLessThan(order.indexOf('read'));
      expect(Reflect.getMetadata(PATH_METADATA, PatientReferralsController.prototype.withdraw)).toBe(':referralId/withdraw');
    });

    it('answers 503 REFERRALS_NOT_AVAILABLE on every route while the flag is off, before anything else', async () => {
      process.env.REFERRALS_ENABLED = 'false';
      resetEnvironmentForTests();
      const { database, calls } = fakeDatabase([]);
      const service = new ReferralsService(database, identity);
      const controller = new ReferralsController(service);
      const patients = new PatientReferralsController(service);
      const request = staffRequest([]);
      const attempts: (() => unknown)[] = [
        () => controller.attestation(request, { destinationKind: 'health_id' }),
        () => controller.send(request, patientId, encounterId, key, sendBody() as unknown as SendReferralDto),
        () => controller.sent(request, {}),
        () => controller.withdraw(request, referralId, key, { expectedRowVersion: 1, reasonCode: 'no_longer_needed' }),
        () => controller.letter(request, referralId),
        () => controller.read(request, referralId),
        () => controller.patient(request, patientId, {}),
        () => controller.incoming(request),
        () => controller.received(request, {}),
        () => controller.accept(request, referralId, key, { expectedRowVersion: 1 }),
        () => controller.decline(request, referralId, key, { expectedRowVersion: 1, reasonCode: 'other' }),
        () => controller.expected(request),
        () => controller.arrive(request, referralId, key, { expectedRowVersion: 1, matchRef }),
        () => controller.complete(request, referralId, key,
          { expectedRowVersion: 1, outcome: 'admitted', feedbackNote: 'Admitted to the ward.' }),
        () => patients.list(patientRequest()),
        () => patients.withdraw(patientRequest(), referralId, { expectedRowVersion: 1 }),
      ];
      for (const attempt of attempts) {
        const problem = await problemOf(attempt);
        expect([problem.getStatus(), problem.code, problem.message]).toEqual([503, 'REFERRALS_NOT_AVAILABLE',
          'Referrals are not available yet.']);
      }
      expect(calls).toEqual([]);
    });

    it('needs direct care and the route\'s code, in plain words', async () => {
      const { database } = fakeDatabase([]);
      const controller = new ReferralsController(new ReferralsService(database, identity));
      expect((await problemOf(() => controller.incoming(staffRequest(DOCTOR, undefined)))).code)
        .toBe('PURPOSE_OF_USE_REQUIRED');
      expect((await problemOf(() => controller.incoming(staffRequest(DOCTOR, 'emergency')))).code)
        .toBe('REFERRAL_NOT_ALLOWED');
      const nurse = await problemOf(() => controller.incoming(staffRequest(NURSE)));
      expect([nurse.getStatus(), nurse.code, nurse.message]).toEqual([403, 'REFERRAL_NOT_ALLOWED',
        'Only doctors and clinicians can send, answer or read referrals.']);
      expect((await problemOf(() => controller.incoming(staffRequest(DESK)))).code).toBe('REFERRAL_NOT_ALLOWED');
      const desk = await problemOf(() => controller.arrive(staffRequest(NURSE), referralId, key,
        { expectedRowVersion: 1, matchRef }));
      expect([desk.getStatus(), desk.code]).toEqual([403, 'REFERRAL_ARRIVAL_NOT_ALLOWED']);
      expect(() => requireReferralAccess(staffRequest(DESK), 'arrive')).not.toThrow();
      expect(() => requireReferralAccess(staffRequest(['ehr.referral.receive']), 'readOrReceive')).not.toThrow();
      const sender = staffRequest(['ehr.referral.send']);
      expect((await problemOf(() => controller.send(sender, patientId, encounterId, key,
        sendBody() as unknown as SendReferralDto))).code).toBe('REFERRAL_NOT_ALLOWED');
      for (const message of Object.values(REFERRAL_MESSAGES)) expect(message.toLowerCase()).not.toContain('permission');
    });

    it('needs an Idempotency-Key on every staff write', async () => {
      const { database } = fakeDatabase([]);
      const controller = new ReferralsController(new ReferralsService(database, identity));
      const problem = await problemOf(() => controller.accept(staffRequest(DOCTOR), referralId, undefined,
        { expectedRowVersion: 1 }));
      expect([problem.getStatus(), problem.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
    });
  });

  describe('bodies', () => {
    it('takes a well-formed send and refuses unknown fields', async () => {
      await expect(validate(SendReferralDto, sendBody())).resolves.toBeInstanceOf(SendReferralDto);
      await expect(validate(SendReferralDto, sendBody({ healthId: 'HID-ABCDEF' }))).rejects
        .toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(validate(SendReferralDto, sendBody({ urgency: 'emergency' }))).rejects
        .toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(validate(SendReferralDto, sendBody({ departmentCode: 'neurology' }))).rejects
        .toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(validate(SendReferralDto, sendBody({ reason: 'short' }))).rejects
        .toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(validate(SendReferralDto, sendBody({ reason: 'Line one\nline two of reason' }))).rejects
        .toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(validate(SendReferralDto, sendBody({ letterText: 'Dear colleague,\nplease see this patient.' })))
        .resolves.toBeInstanceOf(SendReferralDto);
      await expect(validate(SendReferralDto, sendBody({ package: { diagnosisIds: ['not-a-uuid'] } }))).rejects
        .toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(validate(SendReferralDto, sendBody({ destination: { kind: 'printed', facilityName: 'Outside Clinic',
        town: 'Ibadan', nin: '12345678901' } }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('takes the writes\' bodies', async () => {
      await expect(validate(WithdrawReferralDto, { expectedRowVersion: 1, reasonCode: 'sent_in_error',
        note: 'Sent to the wrong hospital.' })).resolves.toBeInstanceOf(WithdrawReferralDto);
      await expect(validate(AcceptReferralDto, { expectedRowVersion: 0 })).rejects
        .toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(validate(DeclineReferralDto, { expectedRowVersion: 1, reasonCode: 'too_busy', note: 'x'.repeat(10) }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(validate(ArriveReferralDto, { expectedRowVersion: 1, matchRef: 'HID-ABCDEF' })).rejects
        .toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(validate(CompleteReferralDto, { expectedRowVersion: 1, outcome: 'seen_care_returned',
        feedbackNote: 'short' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(validate(ReferralListQueryDto, { state: 'sent,accepted', limit: '50' }, 'query')).resolves
        .toBeInstanceOf(ReferralListQueryDto);
      await expect(validate(ReferralListQueryDto, { limit: '201' }, 'query')).rejects
        .toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  describe('send', () => {
    it('sends what the clinician ticked, with the destination, and answers the card and package', async () => {
      const { database, calls } = fakeDatabase([{ outcome: 'sent', replayed: false, referral: card,
        package: packageValue }]);
      const service = new ReferralsService(database, identity);
      const answer = await service.send(context, patientId, encounterId,
        await validate(SendReferralDto, sendBody()), key);
      expect(answer).toEqual({ referral: card, package: packageValue, replayed: false });
      expect(calls[0].sql).toBe(SEND_SQL);
      expect(calls[0].values.slice(0, 11)).toEqual([patientId, encounterId, 'health_id', receivingId, null, null,
        'cardiology', 'Cardiology clinic', 'routine', 'New heart murmur with breathlessness',
        'Dear colleague, please see this patient about a new heart murmur.']);
      expect(calls[0].values.slice(11, 16)).toEqual([[diagnosisId], [], [], [], []]);
      expect(calls[0].values.slice(16, 19)).toEqual(['referral-health-id-attestation-v1', true, key]);
      expect(calls[0].values[19]).toMatch(/^[0-9a-f]{64}$/);
    });

    it('records a printed letter with the typed facility name and town', async () => {
      const { database, calls } = fakeDatabase([{ outcome: 'printed', replayed: false, referral: card,
        package: packageValue }]);
      const service = new ReferralsService(database, identity);
      await service.send(context, patientId, encounterId, await validate(SendReferralDto, sendBody({
        destination: { kind: 'printed', facilityName: 'Fictional Outside Clinic', town: '' },
        attestationTextVersion: 'referral-printed-attestation-v1' })), key);
      expect(calls[0].values.slice(2, 6)).toEqual(['printed', null, 'Fictional Outside Clinic', null]);
    });

    it('refuses before the database what the contract answers in 400s', async () => {
      const { database, calls } = fakeDatabase([]);
      const service = new ReferralsService(database, identity);
      const send = async (body: Record<string, unknown>) => problemOf(service.send(context, patientId, encounterId,
        body as unknown as SendReferralDto, key));
      expect((await send(sendBody({ destination: undefined }))).code).toBe('REFERRAL_DESTINATION_REQUIRED');
      expect((await send(sendBody({ destination: { kind: 'health_id', facilityId: receivingId,
        facilityName: 'Both kinds' } }))).code).toBe('REFERRAL_DESTINATION_REQUIRED');
      expect((await send(sendBody({ destination: { kind: 'printed' } }))).code).toBe('REFERRAL_DESTINATION_REQUIRED');
      expect((await send(sendBody({ patientAgreed: false }))).code).toBe('REFERRAL_ATTESTATION_REQUIRED');
      expect((await send(sendBody({ package: { diagnosisIds: [diagnosisId, diagnosisId.toUpperCase()] } }))).code)
        .toBe('REFERRAL_PACKAGE_INVALID');
      expect((await send(sendBody({ package: { vitalIds: Array.from({ length: 11 }, (_, n) =>
        `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`) } }))).code).toBe('REFERRAL_PACKAGE_INVALID');
      const outdated = await send(sendBody({ attestationTextVersion: 'referral-printed-attestation-v1' }));
      expect([outdated.getStatus(), outdated.code]).toEqual([409, 'REFERRAL_ATTESTATION_OUTDATED']);
      expect(calls).toEqual([]);
    });

    it('answers each refusal of the database in the contract\'s words', async () => {
      const cases: [string, number, string][] = [
        ['control_off', 423, 'CROSS_FACILITY_REFERRALS_UNAVAILABLE'], ['consent_required', 403, 'CONSENT_REQUIRED'],
        ['visit_invalid', 400, 'REFERRAL_VISIT_INVALID'], ['visit_not_signed', 409, 'REFERRAL_VISIT_NOT_SIGNED'],
        ['patient_not_identified', 409, 'REFERRAL_PATIENT_NOT_IDENTIFIED'],
        ['attestation_outdated', 409, 'REFERRAL_ATTESTATION_OUTDATED'],
        ['patient_app_required', 409, 'REFERRAL_PATIENT_APP_REQUIRED'], ['patient_denied', 409, 'REFERRAL_PATIENT_DENIED'],
        ['destination_unavailable', 409, 'REFERRAL_DESTINATION_UNAVAILABLE'],
        ['destination_busy', 409, 'REFERRAL_DESTINATION_BUSY'], ['send_limited', 429, 'REFERRAL_SEND_LIMITED'],
        ['visit_limit', 409, 'REFERRAL_VISIT_LIMIT'], ['package_invalid', 400, 'REFERRAL_PACKAGE_INVALID'],
        ['key_reused', 409, 'IDEMPOTENCY_KEY_REUSED'], ['changed', 412, 'REFERRAL_VERSION_CONFLICT'],
        ['closed', 409, 'REFERRAL_CLOSED'], ['not_pending', 409, 'REFERRAL_NOT_PENDING'],
        ['expired', 409, 'REFERRAL_EXPIRED'], ['reason_required', 400, 'REFERRAL_REASON_REQUIRED'],
        ['not_accepted', 409, 'REFERRAL_NOT_ACCEPTED'], ['not_arrived', 409, 'REFERRAL_NOT_ARRIVED'],
        ['outcome_invalid', 400, 'REFERRAL_OUTCOME_INVALID'], ['needs_search', 403, 'REFERRAL_ARRIVAL_NEEDS_SEARCH'],
        ['not_found', 404, 'REFERRAL_NOT_FOUND'],
      ];
      for (const [outcome, status, code] of cases) {
        const problem = refusal(outcome);
        expect([outcome, problem.getStatus(), problem.code]).toEqual([outcome, status, code]);
      }
    });
  });

  describe('the writes', () => {
    it('passes the version, the key and the request digest; a replay answers replayed', async () => {
      const { database, calls } = fakeDatabase([{ outcome: 'accepted', replayed: true, referral: card,
        package: packageValue }]);
      const service = new ReferralsService(database, identity);
      const answer = await service.accept(context, referralId, { expectedRowVersion: 1, note: '' }, key);
      expect(answer.replayed).toBe(true);
      expect(calls[0].sql).toBe(ACCEPT_SQL);
      expect(calls[0].values.slice(0, 4)).toEqual([referralId, 1, null, key]);
    });

    it('needs a reason note where the contract does, before the database', async () => {
      const { database, calls } = fakeDatabase([]);
      const service = new ReferralsService(database, identity);
      expect((await problemOf(service.withdraw(context, referralId, { expectedRowVersion: 1,
        reasonCode: 'sent_in_error' }, key))).code).toBe('REFERRAL_REASON_REQUIRED');
      expect((await problemOf(service.withdraw(context, referralId, { expectedRowVersion: 1, reasonCode: 'other',
        note: 'short' }, key))).code).toBe('REFERRAL_REASON_REQUIRED');
      expect((await problemOf(service.decline(context, referralId, { expectedRowVersion: 1,
        reasonCode: 'no_capacity' }, key))).code).toBe('REFERRAL_REASON_REQUIRED');
      expect(calls).toEqual([]);
      const ok = fakeDatabase([{ outcome: 'withdrawn', replayed: false, referral: card }]);
      await new ReferralsService(ok.database, identity).withdraw(context, referralId, { expectedRowVersion: 1,
        reasonCode: 'no_longer_needed' }, key);
      expect(ok.calls[0].sql).toBe(WITHDRAW_SQL);
      expect(ok.calls[0].values.slice(0, 4)).toEqual([referralId, 1, 'no_longer_needed', null]);
      const declined = fakeDatabase([{ outcome: 'declined', replayed: false, referral: card }]);
      await new ReferralsService(declined.database, identity).decline(context, referralId, { expectedRowVersion: 2,
        reasonCode: 'no_capacity', note: 'No slots for two months.' }, key);
      expect(declined.calls[0].sql).toBe(DECLINE_SQL);
    });

    it('arrival needs exactly one patient and answers 0135\'s waiting-list card', async () => {
      const empty = fakeDatabase([]);
      const service = new ReferralsService(empty.database, identity);
      expect((await problemOf(service.arrive(context, referralId, { expectedRowVersion: 2 }, key))).code)
        .toBe('REFERRAL_ARRIVAL_NEEDS_ONE_PATIENT');
      expect((await problemOf(service.arrive(context, referralId, { expectedRowVersion: 2, matchRef, patientId }, key)))
        .code).toBe('REFERRAL_ARRIVAL_NEEDS_ONE_PATIENT');
      expect(empty.calls).toEqual([]);
      const entry = { ord: 1, entry_id: '123e4567-e89b-42d3-a456-426614174051', patient_id: patientId,
        full_name: 'Ngozi Referone', sex: 'female', date_of_birth: '1979-04-02', health_id_last4: 'RF21',
        stage: 'waiting', triage_level: null, assigned_membership_id: null, check_in_basis: 'search',
        checked_in_at: '2026-12-03T09:10:00+00:00', queue_day: '2026-12-03', stage_changed_at: '2026-12-03T09:10:00+00:00',
        closed_at: null, row_version: 1, chart_blocked: false };
      const { database, calls } = fakeDatabase([{ outcome: 'checked_in', replayed: false, referral: card, entry }]);
      const answer = await new ReferralsService(database, identity).arrive(context, referralId,
        { expectedRowVersion: 2, matchRef }, key);
      expect(calls[0].sql).toBe(ARRIVE_SQL);
      expect(calls[0].values.slice(0, 4)).toEqual([referralId, 2, matchRef, null]);
      expect(answer.outcome).toBe('checked_in');
      expect(answer.entry).toMatchObject({ entryId: entry.entry_id, checkInBasis: 'search',
        checkedInAt: '2026-12-03T09:10:00.000Z', checkInDay: '2026-12-03', rowVersion: 1, healthIdLast4: 'RF21' });
      expect(queueEntry({ ...entry, check_in_basis: 'own_facility' })?.checkInBasis).toBe('own-facility');
    });
  });

  describe('the patient', () => {
    it('refuses a staff session on the patient routes', async () => {
      const { database } = fakeDatabase([]);
      const patients = new PatientReferralsController(new ReferralsService(database, identity));
      const problem = await problemOf(patients.list(staffRequest(DOCTOR)));
      expect([problem.getStatus(), problem.code]).toEqual([403, 'PATIENT_SESSION_REQUIRED']);
    });

    it('lists and withdraws in a patient transaction', async () => {
      const listed = fakeDatabase([{ item: { referralId, canWithdraw: true } }]);
      const patients = new PatientReferralsController(new ReferralsService(listed.database, identity));
      await expect(patients.list(patientRequest())).resolves.toEqual({ items: [{ referralId, canWithdraw: true }] });
      const withdrawn = fakeDatabase([{ outcome: 'withdrawn', row_version: '2', state: 'withdrawn',
        effective_state: 'withdrawn' }]);
      await expect(new PatientReferralsController(new ReferralsService(withdrawn.database, identity))
        .withdraw(patientRequest(), referralId, { expectedRowVersion: 1 }))
        .resolves.toEqual({ rowVersion: 2, state: 'withdrawn', effectiveState: 'withdrawn' });
      const late = fakeDatabase([{ outcome: 'not_pending', row_version: null, state: null, effective_state: null }]);
      expect((await problemOf(new ReferralsService(late.database, identity).myWithdraw(patientRequest(), referralId, 1)))
        .code).toBe('REFERRAL_NOT_PENDING');
    });
  });

  describe('the database\'s raised refusals', () => {
    it('answers them in plain words, and a schema without 0191 or 0192 as not available', () => {
      const problem = (code: string, message = '') => translate(Object.assign(new Error(message), { code })) as DomainProblem;
      expect(problem('42501', 'REFERRAL_NOT_ALLOWED').code).toBe('REFERRAL_NOT_ALLOWED');
      expect(problem('42501', 'REFERRAL_ARRIVAL_NOT_ALLOWED').code).toBe('REFERRAL_ARRIVAL_NOT_ALLOWED');
      expect(problem('42501', 'PATIENT_SESSION_REQUIRED').code).toBe('PATIENT_SESSION_REQUIRED');
      expect(problem('22023', 'REFERRAL_ARRIVAL_NEEDS_ONE_PATIENT').code).toBe('REFERRAL_ARRIVAL_NEEDS_ONE_PATIENT');
      expect(problem('22023', 'REFERRAL_INVALID').code).toBe('VALIDATION_FAILED');
      expect(problem('42883').code).toBe('REFERRALS_NOT_AVAILABLE');
      expect(problem('42P01').code).toBe('REFERRALS_NOT_AVAILABLE');
      expect(problem('40P01').code).toBe('REFERRAL_VERSION_CONFLICT');
      const other = new Error('boom');
      expect(translate(other)).toBe(other);
    });
  });

  it('puts no Health ID in a route path or query', () => {
    const directory = __dirname;
    const files = readdirSync(directory).filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts')
      && statSync(join(directory, name)).isFile());
    for (const name of files) {
      const source = readFileSync(join(directory, name), 'utf8');
      expect(source).not.toMatch(/@(Get|Post)\([^)]*health[-_]?id/i);
      expect(source).not.toMatch(/@Query\('health/i);
    }
  });
});
