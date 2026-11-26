import { RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { ArgumentMetadata } from '@nestjs/common';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { createValidationPipe } from '../../common/validation-pipe';
import { getEnvironment, resetEnvironmentForTests } from '../../config/environment';
import type { DatabaseService } from '../../database/database.service';
import { InpatientChargesController, InpatientController } from './inpatient.controller';
import {
  AdmitDto, BedStatusDto, CreateWardDto, DischargeDto, RequestAdmissionDto, TransferDto, WardStaffDto,
} from './inpatient.dto';
import {
  INPATIENT_MESSAGES, InpatientBedDaySweeper, InpatientService, refusal, requireInpatientAccess, translate,
  translateBilling,
} from './inpatient.service';

// Fictional identifiers only.
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const patientId = '123e4567-e89b-42d3-a456-426614174001';
const admissionId = '123e4567-e89b-42d3-a456-426614174071';
const wardId = '123e4567-e89b-42d3-a456-426614174081';
const bedId = '123e4567-e89b-42d3-a456-426614174091';
const billId = '123e4567-e89b-42d3-a456-426614174099';
const key = 'inpatient-test-key-0001';

const NURSE = ['ehr.ward.read', 'ehr.admission.read', 'ehr.bed.allocate', 'ehr.wristband.print'];
const DOCTOR = [...NURSE, 'ehr.admission.decide'];
const ADMIN = ['ehr.ward.manage', 'workforce.manage'];
const DESK = ['ehr.encounter.read', 'identity.patient.read'];

const context = { correlationId: 'correlation-123456', facilityId, membershipId, purposeOfUse: 'direct-care',
  actor: { id: accountId, subject: 'staff:test', accountId, permissions: [] } } as unknown as DataAccessContext;

const card = (overrides: Record<string, unknown> = {}) => ({
  admissionId, admissionNumber: 'A-2026-000123', patientId, fullName: 'Ada Wardone', nameHidden: false,
  recordKind: 'standard', unknownLabel: null, sex: 'female', status: 'admitted', source: 'direct',
  reason: 'Community-acquired pneumonia (fictional)', reasonHidden: false, wardId, bedId, billId: null, rowVersion: 5,
  ...overrides,
});

function fakeDatabase(answers: readonly unknown[] | Error) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const contexts: DataAccessContext[] = [];
  let index = 0;
  const database = {
    withTransaction: jest.fn(async (given: DataAccessContext, operation: (client: unknown) => Promise<unknown>) => {
      contexts.push(given);
      return operation({
        query: async (sql: string, values: unknown[]) => {
          calls.push({ sql, values });
          if (answers instanceof Error) throw answers;
          const answer = answers[Math.min(index, answers.length - 1)];
          index += 1;
          if (answer instanceof Error) throw answer;
          return { rows: Array.isArray(answer) ? answer : [{ answer }] };
        },
      });
    }),
    withSystemTransaction: jest.fn(async (_correlation: string, operation: (client: unknown) => Promise<unknown>) =>
      operation({ query: async () => ({ rows: [{ added: 2 }] }) })),
  } as unknown as DatabaseService;
  return { database, calls, contexts };
}

const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

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

function staffRequest(permissions: string[], purpose = 'direct-care'): HidRequest {
  return {
    header: (name: string) => (name.toLowerCase() === 'x-purpose-of-use' ? purpose : undefined),
    correlationId: 'correlation-123456', facilityId, method: 'POST',
    actor: { kind: 'staff', id: accountId, subject: 'staff:test', accountId, permissions, roles: ['nurse'],
      facilityIds: [facilityId], facilities: [], facility: { id: facilityId, membershipId } },
  } as unknown as HidRequest;
}

describe('ADT-1 inpatient admission, wards and beds (0170-0173)', () => {
  const original = { ...process.env };
  const base = { NODE_ENV: 'test', DATABASE_URL: 'postgresql://ehr:test@localhost:5432/hid',
    CORS_ORIGINS: 'http://localhost:3000', STORAGE_MODE: 'disabled' };
  beforeEach(() => {
    Object.assign(process.env, base, { INPATIENT_ENABLED: 'true' });
    resetEnvironmentForTests();
  });
  afterEach(() => {
    for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  describe('the flag', () => {
    it('is off unless set to true', () => {
      delete process.env.INPATIENT_ENABLED;
      resetEnvironmentForTests();
      expect(getEnvironment().INPATIENT_ENABLED).toBe(false);
    });

    it('while off, every route answers 503 INPATIENT_NOT_AVAILABLE before reading anything', async () => {
      process.env.INPATIENT_ENABLED = 'false';
      resetEnvironmentForTests();
      const { database, calls } = fakeDatabase([{}]);
      const controller = new InpatientController(new InpatientService(database));
      const charges = new InpatientChargesController(new InpatientService(database));
      const request = staffRequest(DOCTOR);
      for (const call of [
        () => controller.wards(request, {}),
        () => controller.bedBoard(request, { wardId }),
        () => controller.census(request, {}),
        () => controller.request(request, key, {} as RequestAdmissionDto),
        () => controller.list(request, {}),
        () => controller.read(request, admissionId),
        () => controller.admit(request, admissionId, key, {} as AdmitDto),
        () => controller.discharge(request, admissionId, key, {} as DischargeDto),
        () => controller.wristband(request, admissionId, key, {}),
        () => controller.deathRecordRead(request, admissionId),
        () => charges.wardCharges(request),
      ]) {
        const problem = await problemOf(call);
        expect([problem.getStatus(), problem.code, problem.message])
          .toEqual([503, 'INPATIENT_NOT_AVAILABLE', INPATIENT_MESSAGES.notAvailable]);
      }
      expect(calls).toEqual([]);
    });
  });

  describe('who may (Q185 A, Q191 A)', () => {
    it('nurses see the wards, give beds and print bands, but cannot admit or discharge', () => {
      expect(() => requireInpatientAccess(staffRequest(NURSE), 'ward_read')).not.toThrow();
      expect(() => requireInpatientAccess(staffRequest(NURSE), 'bed_allocate')).not.toThrow();
      expect(() => requireInpatientAccess(staffRequest(NURSE), 'wristband')).not.toThrow();
      const problem = (() => { try { requireInpatientAccess(staffRequest(NURSE), 'admission_decide'); } catch (e) { return e; } })();
      expect([(problem as DomainProblem).code, (problem as DomainProblem).message])
        .toEqual(['ADMISSION_DECIDE_NOT_ALLOWED', INPATIENT_MESSAGES.decideNotAllowed]);
    });

    it('doctors and clinicians decide; admins only set up wards; the front desk has no wards', () => {
      expect(() => requireInpatientAccess(staffRequest(DOCTOR), 'admission_decide')).not.toThrow();
      expect(() => requireInpatientAccess(staffRequest(ADMIN), 'ward_manage')).not.toThrow();
      expect(() => requireInpatientAccess(staffRequest(ADMIN), 'ward_list')).not.toThrow();
      expect(() => requireInpatientAccess(staffRequest(ADMIN), 'bed_status')).not.toThrow();
      for (const [permissions, access, code] of [
        [ADMIN, 'ward_read', 'INPATIENT_NOT_ALLOWED'], [NURSE, 'ward_manage', 'WARD_SETUP_NOT_ALLOWED'],
        [DESK, 'ward_list', 'INPATIENT_NOT_ALLOWED'], [DESK, 'bed_status', 'BED_ALLOCATE_NOT_ALLOWED'],
      ] as const) {
        try {
          requireInpatientAccess(staffRequest([...permissions]), access);
          throw new Error('expected a refusal');
        } catch (error) {
          expect((error as DomainProblem).code).toBe(code);
        }
      }
    });

    it('no staff message uses the word "permission"', () => {
      for (const text of Object.values(INPATIENT_MESSAGES)) expect(text.toLowerCase()).not.toContain('permission');
    });

    it('ward setup is healthcare operations; the board is direct care', async () => {
      const { database } = fakeDatabase([{ outcome: 'created', ward: { wardId } }]);
      const controller = new InpatientController(new InpatientService(database));
      expect((await problemOf(() => controller.createWard(staffRequest(ADMIN, 'direct-care'), key,
        { name: 'ICU', wardType: 'icu' }))).code).toBe('PURPOSE_OF_USE_REQUIRED');
      expect((await problemOf(() => controller.bedBoard(staffRequest(NURSE, 'healthcare-operations'), { wardId }))).code)
        .toBe('PURPOSE_OF_USE_REQUIRED');
      await expect(controller.createWard(staffRequest(ADMIN, 'healthcare-operations'), key,
        { name: 'ICU', wardType: 'icu' })).resolves.toEqual({ ward: { wardId }, replayed: false });
    });
  });

  describe('routes', () => {
    it('declares the contract routes under ehr/ and commercial/, ids by UUID only', () => {
      const routes = Object.getOwnPropertyNames(InpatientController.prototype)
        .filter((name) => name !== 'constructor')
        .map((name) => {
          const handler = (InpatientController.prototype as unknown as Record<string, object>)[name]!;
          return `${RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number]} ${
            Reflect.getMetadata(PATH_METADATA, handler) as string}`;
        });
      expect(routes.sort()).toEqual([
        'GET admissions', 'GET admissions/:admissionId', 'GET admissions/:admissionId/death-record',
        'GET admissions/:admissionId/death-record/print', 'GET admissions/:admissionId/discharge-summary',
        'GET admissions/:admissionId/movements/:movementId/handover', 'GET bed-board', 'GET census', 'GET wards',
        'PATCH admissions/:admissionId', 'PATCH beds/:bedId', 'PATCH wards/:wardId', 'POST admissions',
        'POST admissions/:admissionId/admit', 'POST admissions/:admissionId/cancel',
        'POST admissions/:admissionId/death-record', 'POST admissions/:admissionId/death-record/amend',
        'POST admissions/:admissionId/discharge', 'POST admissions/:admissionId/newborn-band',
        'POST admissions/:admissionId/prepare-discharge', 'POST admissions/:admissionId/transfer',
        'POST admissions/:admissionId/wristband', 'POST beds/:bedId/status', 'POST wards', 'POST wards/:wardId/beds',
        'PUT wards/:wardId/staff',
      ].sort());
      expect(Reflect.getMetadata(PATH_METADATA, InpatientController)).toBe('ehr');
      expect(Reflect.getMetadata(PATH_METADATA, InpatientChargesController)).toBe('commercial');
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, InpatientController.prototype.request)).toBe(201);
      for (const route of routes) expect(route).not.toMatch(/hid|health-?id|nin/i);
    });
  });

  describe('bodies', () => {
    it('a ward: 2-80 characters, a type, who it takes', async () => {
      await expect(validate(CreateWardDto, { name: '  Female Medical Ward ', wardType: 'general', takes: 'female' }))
        .resolves.toMatchObject({ name: 'Female Medical Ward' });
      await expect(validate(CreateWardDto, { name: 'W', wardType: 'general' })).rejects.toBeDefined();
      await expect(validate(CreateWardDto, { name: 'Ward', wardType: 'surgical' })).rejects.toBeDefined();
    });

    it('the staff list: at most 200 UUIDs', async () => {
      await expect(validate(WardStaffDto, { expectedRowVersion: 1, membershipIds: [membershipId] })).resolves.toBeDefined();
      await expect(validate(WardStaffDto, { expectedRowVersion: 1, membershipIds: ['HID-AB12CD'] })).rejects.toBeDefined();
      await expect(validate(WardStaffDto, { expectedRowVersion: 1,
        membershipIds: Array.from({ length: 201 }, () => membershipId) })).rejects.toBeDefined();
    });

    it('a bed status by hand never sets occupied', async () => {
      await expect(validate(BedStatusDto, { expectedRowVersion: 2, status: 'cleaning' })).resolves.toBeDefined();
      await expect(validate(BedStatusDto, { expectedRowVersion: 2, status: 'occupied' })).rejects.toBeDefined();
    });

    it('a request: the patient by UUID, a source and a reason of 1-300 characters', async () => {
      await expect(validate(RequestAdmissionDto, { patientId, source: 'direct', reason: 'Pneumonia (fictional)',
        responsibleMembershipId: membershipId })).resolves.toBeDefined();
      await expect(validate(RequestAdmissionDto, { patientId: 'HID-AB12CD', source: 'direct', reason: 'x' }))
        .rejects.toBeDefined();
      await expect(validate(RequestAdmissionDto, { patientId, source: 'direct', reason: 'x'.repeat(301) }))
        .rejects.toBeDefined();
    });

    it('a transfer handover: 1-2000 characters, line breaks allowed', async () => {
      await expect(validate(TransferDto, { expectedRowVersion: 3, bedId, handover: 'Stable.\nOn oxygen.' }))
        .resolves.toBeDefined();
      await expect(validate(TransferDto, { expectedRowVersion: 3, bedId, handover: 'x'.repeat(2001) })).rejects.toBeDefined();
    });

    it('a discharge: one of the five outcomes, UTC times, a nested summary', async () => {
      await expect(validate(DischargeDto, { expectedRowVersion: 6, outcome: 'routine', signature: 'SIGN',
        summary: { presentingProblem: 'Cough', courseInHospital: 'Improved', conditionAtDischarge: 'improved' } }))
        .resolves.toBeDefined();
      await expect(validate(DischargeDto, { expectedRowVersion: 6, outcome: 'home', signature: 'SIGN' })).rejects.toBeDefined();
      await expect(validate(DischargeDto, { expectedRowVersion: 6, outcome: 'died', diedAt: '2026-12-06 10:00',
        signature: 'SIGN' })).rejects.toBeDefined();
      await expect(validate(DischargeDto, { expectedRowVersion: 6, outcome: 'routine', signature: 'SIGN',
        summary: { presentingProblem: '', courseInHospital: 'x' } })).rejects.toBeDefined();
    });
  });

  describe('the service', () => {
    it('a request: the source rules, then the database decides with the Idempotency-Key and digest', async () => {
      const { database, calls } = fakeDatabase([{ outcome: 'created', replayed: false, admission: card({ status: 'requested' }) },
        [{ admission_id: admissionId, bill_id: billId }]]);
      const service = new InpatientService(database);
      expect((await problemOf(service.request(context, { patientId, source: 'consultation', reason: 'x',
        responsibleMembershipId: membershipId } as RequestAdmissionDto, key))).code).toBe('ADMISSION_SOURCE_INVALID');
      expect((await problemOf(service.request(context, { patientId, source: 'direct', reason: 'x' } as RequestAdmissionDto,
        key))).code).toBe('RESPONSIBLE_DOCTOR_INVALID');
      const answer = await service.request(context, { patientId, source: 'direct', reason: 'Pneumonia (fictional)',
        responsibleMembershipId: membershipId } as RequestAdmissionDto, key);
      expect(answer).toEqual({ admission: card({ status: 'requested', billId }), replayed: false });
      expect(calls[0]!.sql).toContain('ehr.admission_request(');
      expect(calls[0]!.values.slice(0, 2)).toEqual([patientId, 'direct']);
      expect(calls[0]!.values[10]).toBe(key);
      expect(calls[0]!.values[11]).toMatch(/^[0-9a-f]{64}$/);
      expect(calls[1]!.sql).toContain('commercial.admission_bill_ids');
    });

    it('without billing (no 0172) the card keeps billId null', async () => {
      const { database } = fakeDatabase([{ outcome: 'found', admission: card(), movements: [] },
        pgError('42883', 'function commercial.admission_bill_ids(uuid[]) does not exist')]);
      await expect(new InpatientService(database).read(context, admissionId))
        .resolves.toEqual({ admission: card(), movements: [] });
    });

    it('a discharge: died needs its time, a summary for routine, DAMA and referred out, and SIGN', async () => {
      const { database, calls } = fakeDatabase([{ outcome: 'updated', admission: card({ status: 'discharged' }),
        summaryNoteId: null }, []]);
      const service = new InpatientService(database);
      const base = { expectedRowVersion: 6, signature: 'SIGN' };
      expect((await problemOf(service.discharge(context, admissionId, { ...base, outcome: 'died' } as DischargeDto, key))).code)
        .toBe('DIED_AT_REQUIRED');
      expect((await problemOf(service.discharge(context, admissionId, { ...base, outcome: 'dama' } as DischargeDto, key))).code)
        .toBe('DISCHARGE_SUMMARY_REQUIRED');
      expect((await problemOf(service.discharge(context, admissionId, { ...base, outcome: 'absconded', signature: 'ok' } as
        DischargeDto, key))).code).toBe('SIGNATURE_REQUIRED');
      expect((await problemOf(service.discharge(context, admissionId, { ...base, outcome: 'referred_out',
        summary: { presentingProblem: 'x', courseInHospital: 'y' } } as DischargeDto, key))).code).toBe('VALIDATION_FAILED');
      expect(calls).toEqual([]);
      await expect(service.discharge(context, admissionId, { ...base, outcome: 'absconded' } as DischargeDto, key))
        .resolves.toEqual({ admission: card({ status: 'discharged' }), summaryNoteId: null, replayed: false });
      expect(calls[0]!.sql).toContain('ehr.admission_discharge(');
    });

    it('the discharge never sends anything about a bill', async () => {
      const { database, calls } = fakeDatabase([{ outcome: 'updated', admission: card({ status: 'discharged' }) }, []]);
      await new InpatientService(database).discharge(context, admissionId, { expectedRowVersion: 6, outcome: 'absconded',
        signature: 'SIGN' } as DischargeDto, key);
      expect(calls[0]!.sql).not.toMatch(/commercial|bill/i);
    });

    it('the board answers the wards and who waits, or 404 for another facility\'s ward', async () => {
      const { database } = fakeDatabase([{ outcome: 'found', wards: [{ wardId, beds: [] }], waitingForBed: [] }]);
      await expect(new InpatientService(database).bedBoard(context, wardId, undefined))
        .resolves.toEqual({ wards: [{ wardId, beds: [] }], waitingForBed: [] });
      const other = fakeDatabase([{ outcome: 'not_found' }]);
      expect((await problemOf(new InpatientService(other.database).bedBoard(context, wardId, undefined))).code)
        .toBe('WARD_NOT_FOUND');
      expect((await problemOf(new InpatientService(other.database).bedBoard(context, undefined, undefined))).code)
        .toBe('VALIDATION_FAILED');
    });

    it('a band answers the print and its replay flag', async () => {
      const band = { fullName: 'Ada Wardone', healthId: 'HID-WARD12', admissionNumber: 'A-2026-000123', printNumber: 1 };
      const { database, calls } = fakeDatabase([{ outcome: 'printed', replayed: false, band }]);
      await expect(new InpatientService(database).wristband(context, admissionId, {}, key, false))
        .resolves.toEqual({ ...band, replayed: false });
      expect(calls[0]!.sql).toContain('ehr.wristband_print(');
      const reprint = fakeDatabase([{ outcome: 'reprint_reason_required' }]);
      expect((await problemOf(new InpatientService(reprint.database).wristband(context, admissionId, {}, key, true))).code)
        .toBe('REPRINT_REASON_REQUIRED');
      expect(reprint.calls[0]!.sql).toContain('ehr.newborn_band_print(');
    });

    it('the death record is switched off (503)', async () => {
      const { database } = fakeDatabase(pgError('55000', 'DEATH_RECORD_NOT_AVAILABLE'));
      const problem = await problemOf(new InpatientService(database).deathRecordRead(context, admissionId));
      expect([problem.getStatus(), problem.code]).toEqual([503, 'DEATH_RECORD_NOT_AVAILABLE']);
    });

    it('ward setup answers the ward', async () => {
      const { database, calls } = fakeDatabase([{ outcome: 'updated', replayed: true, ward: { wardId, staffCount: 2 } }]);
      await expect(new InpatientService(database).setWardStaff(context, wardId,
        { expectedRowVersion: 3, membershipIds: [membershipId, membershipId] }, key))
        .resolves.toEqual({ ward: { wardId, staffCount: 2 }, replayed: true });
      expect(calls[0]!.values[2]).toEqual([membershipId]);
    });
  });

  describe('refusals in plain words', () => {
    it.each([
      ['not_found', 'admission', 404, 'ADMISSION_NOT_FOUND'], ['not_found', 'ward', 404, 'WARD_NOT_FOUND'],
      ['name_taken', 'bed', 409, 'BED_NAME_TAKEN'], ['name_taken', 'ward', 409, 'WARD_NAME_TAKEN'],
      ['not_empty', 'ward', 409, 'WARD_NOT_EMPTY'], ['occupied', 'bed', 409, 'BED_OCCUPIED'],
      ['staff_invalid', 'ward', 400, 'WARD_STAFF_INVALID'], ['changed', 'admission', 412, 'ADMISSION_VERSION_CONFLICT'],
      ['changed', 'ward', 412, 'WARD_VERSION_CONFLICT'], ['key_reused', 'admission', 409, 'IDEMPOTENCY_KEY_REUSED'],
      ['chart_access_required', 'admission', 403, 'ADMISSION_CHART_ACCESS_REQUIRED'],
      ['already_open', 'admission', 409, 'ADMISSION_ALREADY_OPEN'],
      ['source_invalid', 'admission', 400, 'ADMISSION_SOURCE_INVALID'],
      ['responsible_invalid', 'admission', 400, 'RESPONSIBLE_DOCTOR_INVALID'],
      ['mother_invalid', 'admission', 400, 'MOTHER_ADMISSION_INVALID'],
      ['state_invalid', 'admission', 409, 'ADMISSION_STATE_INVALID'],
      ['bed_not_available', 'admission', 409, 'BED_NOT_AVAILABLE'], ['sex_mismatch', 'admission', 409, 'WARD_SEX_MISMATCH'],
      ['not_prepared', 'admission', 409, 'DISCHARGE_NOT_PREPARED'], ['time_invalid', 'admission', 400, 'DISCHARGE_TIME_INVALID'],
      ['reprint_reason_required', 'admission', 400, 'REPRINT_REASON_REQUIRED'],
    ] as const)('%s (%s) answers %i %s', (outcome, resource, status, code) => {
      const problem = refusal(outcome, resource, { openAdmissionId: admissionId });
      expect([problem.getStatus(), problem.code]).toEqual([status, code]);
      expect(problem.message.toLowerCase()).not.toContain('permission');
    });

    it('the already-open answer names the open admission', () => {
      expect(refusal('already_open', 'admission', { openAdmissionId: admissionId }).extensions)
        .toEqual({ admissionId });
    });

    it.each([
      ['42501', 'ADMISSION_DECIDE_NOT_ALLOWED', 403, 'ADMISSION_DECIDE_NOT_ALLOWED'],
      ['42501', 'WARD_SETUP_NOT_ALLOWED', 403, 'WARD_SETUP_NOT_ALLOWED'],
      ['42501', 'something else', 403, 'INPATIENT_NOT_ALLOWED'],
      ['22023', 'INPATIENT_PURPOSE_REQUIRED', 400, 'PURPOSE_OF_USE_REQUIRED'],
      ['22023', 'DIED_AT_REQUIRED', 400, 'DIED_AT_REQUIRED'], ['22023', 'INPATIENT_INVALID', 400, 'VALIDATION_FAILED'],
      ['22023', 'INPATIENT_IDEMPOTENCY_KEY_INVALID', 400, 'IDEMPOTENCY_KEY_REQUIRED'],
      ['40P01', 'deadlock detected', 412, 'ADMISSION_VERSION_CONFLICT'],
      ['23505', 'duplicate key', 409, 'BED_NOT_AVAILABLE'],
      ['42883', 'function ehr.bed_board(uuid, text) does not exist', 503, 'INPATIENT_NOT_AVAILABLE'],
      ['42P01', 'relation "ehr.wards" does not exist', 503, 'INPATIENT_NOT_AVAILABLE'],
    ])('a raised %s %s answers %i %s', (code, message, status, expected) => {
      const problem = translate(pgError(code, message)) as DomainProblem;
      expect([problem.getStatus(), problem.code]).toEqual([status, expected]);
    });

    it.each([
      ['HB403', 'BILLING_NOT_ALLOWED', 403, 'BILLING_NOT_ALLOWED'], ['HB404', 'WARD_NOT_FOUND', 404, 'WARD_NOT_FOUND'],
      ['HB404', 'BILL_NOT_FOUND', 404, 'BILL_NOT_FOUND'], ['HB412', 'VERSION_CONFLICT', 412, 'VERSION_CONFLICT'],
      ['42883', 'function commercial.ward_charges_list() does not exist', 503, 'BILLING_NOT_AVAILABLE'],
    ])('a billing %s %s answers %i %s', (code, message, status, expected) => {
      const problem = translateBilling(pgError(code, message)) as DomainProblem;
      expect([problem.getStatus(), problem.code]).toEqual([status, expected]);
    });
  });

  describe('the hourly bed-day sweep (Q-ADT-13 A)', () => {
    it('runs 0172\'s sweep as the system and answers what it added', async () => {
      const { database } = fakeDatabase([{}]);
      await expect(new InpatientBedDaySweeper(database).sweep()).resolves.toBe(2);
    });

    it('a database without 0172 adds nothing and does not throw', async () => {
      const database = { withSystemTransaction: jest.fn(async () => { throw pgError('42883', 'no such function'); }) } as
        unknown as DatabaseService;
      await expect(new InpatientBedDaySweeper(database).sweep()).resolves.toBe(0);
    });
  });

  describe('charges (Q189, BILL-1)', () => {
    it('ward charges and the interim statement are healthcare operations', async () => {
      const { database, contexts, calls } = fakeDatabase([{ wardId, version: 1 }]);
      const charges = new InpatientChargesController(new InpatientService(database));
      await expect(charges.setWardCharges(staffRequest(['billing.catalogue.manage'], 'direct-care'), wardId,
        { expectedVersion: 0, bedDayItemId: null, admissionFeeItemId: null })).resolves.toEqual({ wardId, version: 1 });
      expect(contexts[0]!.purposeOfUse).toBe('healthcare-operations');
      expect(calls[0]!.sql).toContain('commercial.ward_charges_set(');
    });
  });
});
