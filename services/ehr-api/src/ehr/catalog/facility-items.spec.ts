import { type INestApplication, Logger, Module, RequestMethod } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';
import { HEADERS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'node:net';
import { AUDIT_FAILURES_ONLY, PATIENT_ALLOWED, REQUIRED_PERMISSIONS } from '../../common/decorators';
import { requestDigest } from '../../common/idempotency';
import { DomainProblem, ProblemDetailsFilter } from '../../common/problem';
import type { HidRequest } from '../../common/request-context';
import { createValidationPipe } from '../../common/validation-pipe';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../../audit/audit.service';
import { CatalogController } from './catalog.controller';
import { CreateFacilityItemDto, ListFacilityItemsQueryDto, UpdateFacilityItemDto } from './catalog.dto';
import { CatalogService, type CatalogCaller } from './catalog.service';
import {
  FACILITY_ITEMS_LIST_SQL, FACILITY_ITEM_BY_KEY_SQL, FACILITY_ITEM_CREATE_OPERATION, FACILITY_ITEM_INSERT_SQL,
  FACILITY_ITEM_LOCK_SQL, FACILITY_ITEM_MISSING_SQL, FACILITY_ITEM_UPDATE_SQL, FacilityItemsService,
} from './facility-items.service';

// ORD-7, third slice (0155): a facility's own medicines and lab tests. Fictional identifiers and items only.
const facilityId = '123e4567-e89b-42d3-a456-426614174001';
const accountId = '123e4567-e89b-42d3-a456-426614174002';
const organizationId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const itemId = '7d1c3a52-5f0e-4c1b-9a63-2b8e4f6a9c01';
const testId = '7d1c3a52-5f0e-4c1b-9a63-2b8e4f6a9c02';
const key = 'facility-item-key-0001';
const caller: CatalogCaller = { subject: 'staff:test-admin', accountId, organizationId, facilityId, membershipId,
  correlationId: 'correlation-0155' };
const PERMISSION = 'ehr.catalog.facility-item.write';
const addedAt = new Date('2026-11-26T09:00:00.000Z');

const medicineRow = (overrides: Record<string, unknown> = {}) => ({ id: itemId, kind: 'medicine',
  display: 'Artemether + lumefantrine 20/120 mg dispersible tablet', generic_name: 'Artemether + lumefantrine',
  strength: '20/120 mg', dose_form: 'tablet', routes: ['oral'], specimen: null, category: null, active: true,
  row_version: '1', created_at: addedAt, changed_at: null, ...overrides });
const testRow = (overrides: Record<string, unknown> = {}) => ({ id: testId, kind: 'lab_test', display: 'Malaria RDT (own kit)',
  generic_name: null, strength: null, dose_form: null, routes: [], specimen: 'Blood', category: 'parasitology',
  active: true, row_version: '1', created_at: addedAt, changed_at: null, ...overrides });

const medicineBody = (overrides: Record<string, unknown> = {}) => ({ kind: 'medicine',
  display: 'Artemether + lumefantrine 20/120 mg dispersible tablet', genericName: 'Artemether + lumefantrine',
  strength: '20/120 mg', doseForm: 'tablet', routes: ['oral'], ...overrides });

async function validate<T>(type: new () => T, value: unknown, kind: ArgumentMetadata['type'] = 'body'): Promise<T> {
  return createValidationPipe().transform(value, { type: kind, metatype: type }) as Promise<T>;
}

async function problemOf(promise: Promise<unknown>): Promise<DomainProblem> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainProblem) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

function databaseError(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`database error ${code}`), { code, ...extra });
}

type Answer = readonly Record<string, unknown>[] | Error;
/** Answers given in turn to the same statement (the last one again after that). */
class InTurn { constructor(readonly answers: Answer[]) {} }
const inTurn = (...answers: Answer[]) => new InTurn(answers);

/**
 * withStaffTransaction with one client whose statements are answered by SQL text; the audit row is written with that
 * client.
 */
function fakeStaff(answers: Partial<Record<string, Answer | InTurn>>, auditFailure?: Error) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const used = new Map<string, number>();
  const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    const answer = answers[sql];
    if (answer === undefined) throw new Error(`unexpected statement: ${sql.slice(0, 60)}`);
    const list = answer instanceof InTurn ? answer.answers : [answer];
    const index = Math.min(used.get(sql) ?? 0, list.length - 1);
    used.set(sql, index + 1);
    const rows = list[index]!;
    if (rows instanceof Error) throw rows;
    return { rows };
  }) };
  const transactions: { staff: unknown; options: unknown }[] = [];
  const database = {
    withStaffTransaction: jest.fn(async (staff: unknown, operation: (c: typeof client) => Promise<unknown>,
      options?: unknown) => {
      transactions.push({ staff, options });
      return operation(client);
    }),
    query: jest.fn(async () => { throw new Error('facility items never use the pool'); }),
    withTransaction: jest.fn(async () => { throw new Error('facility items take no purpose of use'); }),
  } as unknown as DatabaseService;
  const audits: { client: unknown; event: Record<string, unknown> }[] = [];
  const audit = { recordWithClient: jest.fn(async (with_: unknown, event: Record<string, unknown>) => {
    if (auditFailure) throw auditFailure;
    audits.push({ client: with_, event });
  }) };
  return { service: new FacilityItemsService(database, audit as unknown as AuditService), calls, audits, transactions,
    client };
}

const auditEvent = (action: string, details: Record<string, unknown>, resourceId?: string) => ({
  correlationId: 'correlation-0155', actorType: 'staff', actorSubject: 'staff:test-admin', actorAccountId: accountId,
  actorMembershipId: membershipId, organizationId, facilityId, action,
  resourceType: resourceId === undefined ? 'catalog-facility-items' : 'catalog-facility-item',
  ...(resourceId === undefined ? {} : { resourceId }), outcome: 'success', details });

const medicineAnswer = {
  itemId, kind: 'medicine', codeSystem: 'HID-FACILITY', code: itemId,
  display: 'Artemether + lumefantrine 20/120 mg dispersible tablet', genericName: 'Artemether + lumefantrine',
  strength: '20/120 mg', doseForm: 'tablet', doseFormText: null, routes: ['oral'], atcCode: null, commonAdultDose: null,
  matchedName: null, scope: 'facility', source: 'facility', active: true, rowVersion: 1,
  addedAt: '2026-11-26T09:00:00.000Z', changedAt: null,
};

describe('ORD-7 facility items (0155): routes', () => {
  const handlers = CatalogController.prototype as unknown as Record<string, object>;

  it.each([
    ['listFacilityItems', 'facility-items', RequestMethod.GET, undefined],
    ['createFacilityItem', 'facility-items', RequestMethod.POST, 201],
    ['updateFacilityItem', 'facility-items/:itemId', RequestMethod.PATCH, undefined],
  ])('%s: %s, the new code only, refusals audited by the interceptor, not kept', (name, path, method, status) => {
    const handler = handlers[name] as object;
    expect(Reflect.getMetadata(PATH_METADATA, CatalogController)).toBe('ehr/catalog');
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(method);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual([PERMISSION]);
    expect(Reflect.getMetadata(AUDIT_FAILURES_ONLY, handler)).toBe(true);
    expect(Reflect.getMetadata(PATIENT_ALLOWED, handler)).toBeUndefined();
    expect(Reflect.getMetadata(HEADERS_METADATA, handler)).toBeUndefined();
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(status);
  });

  it('passes the guards\' actor at this facility, and requires an Idempotency-Key to add', async () => {
    const service = { list: jest.fn(async () => ({ items: [], more: false })), create: jest.fn(async () => ({})),
      update: jest.fn(async () => ({})) };
    const controller = new CatalogController({} as CatalogService, service as unknown as FacilityItemsService);
    const setHeader = jest.fn();
    const request = { correlationId: 'correlation-0155', facilityId, res: { setHeader },
      actor: { subject: 'staff:test-admin', accountId, facility: { membershipId, organizationId } } } as unknown as HidRequest;
    const input = Object.assign(new CreateFacilityItemDto(), medicineBody());
    await controller.listFacilityItems(request, Object.assign(new ListFacilityItemsQueryDto(), { kind: 'lab_test' }));
    await controller.createFacilityItem(request, key, input);
    const change = Object.assign(new UpdateFacilityItemDto(), { expectedRowVersion: 1, active: false });
    await controller.updateFacilityItem(request, itemId, change);
    expect(service.list).toHaveBeenCalledWith(caller, 'lab_test');
    expect(service.create).toHaveBeenCalledWith(caller, input, key);
    expect(service.update).toHaveBeenCalledWith(caller, itemId, change);
    expect(setHeader).not.toHaveBeenCalled();
    for (const missing of [undefined, '', 'short-key', 'has space in it 123456']) {
      expect(() => controller.createFacilityItem(request, missing, input)).toThrow(DomainProblem);
      try {
        controller.createFacilityItem(request, missing, input);
      } catch (error) {
        expect([(error as DomainProblem).getStatus(), (error as DomainProblem).code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
      }
    }
    expect(service.create).toHaveBeenCalledTimes(1);
    expect(() => controller.listFacilityItems({ ...request, actor: undefined } as unknown as HidRequest,
      new ListFacilityItemsQueryDto())).toThrow('Request context was not established by security guards');
  });
});

describe('ORD-7 facility items (0155): what a request may carry', () => {
  it('takes a medicine, trimmed, with its routes in lower case', async () => {
    await expect(validate(CreateFacilityItemDto, medicineBody({ display: '  Artemether + lumefantrine 20/120 mg dispersible tablet ',
      genericName: ' Artemether + lumefantrine ', routes: [' Oral ', 'nasogastric tube'] }))).resolves.toEqual(
      Object.assign(new CreateFacilityItemDto(), medicineBody({ routes: ['oral', 'nasogastric tube'] })));
    await expect(validate(CreateFacilityItemDto, { kind: 'medicine', display: 'Gentian violet paint', genericName: 'Gentian violet' }))
      .resolves.toMatchObject({ kind: 'medicine', display: 'Gentian violet paint' });
  });

  it('takes a lab test with or without its specimen and category', async () => {
    await expect(validate(CreateFacilityItemDto, { kind: 'lab_test', display: 'Malaria RDT (own kit)', specimen: 'Blood',
      category: 'parasitology' })).resolves.toMatchObject({ kind: 'lab_test', specimen: 'Blood', category: 'parasitology' });
    await expect(validate(CreateFacilityItemDto, { kind: 'lab_test', display: 'Sickling test' }))
      .resolves.toMatchObject({ display: 'Sickling test' });
  });

  it.each([
    ['no kind', { display: 'Sickling test' }, 'kind'],
    ['another kind', { kind: 'device', display: 'Glucometer strip' }, 'kind'],
    ['no display', { kind: 'lab_test' }, 'display'],
    ['a display of spaces', { kind: 'lab_test', display: '   ' }, 'display'],
    ['a display of 501 characters', { kind: 'lab_test', display: 'a'.repeat(501) }, 'display'],
    // 251 hearts with their presentation selectors: the validator's own count is 251, the database's 502.
    ['a display over 500 characters as the database counts them', { kind: 'lab_test', display: '❤️'.repeat(251) },
      'display'],
    ['a display with a line feed', { kind: 'lab_test', display: 'Sickling\ntest' }, 'display'],
    ['a display with U+0000', { kind: 'lab_test', display: 'Sickling test\u0000' }, 'display'],
    ['a null display', { kind: 'lab_test', display: null }, 'display'],
    ['a medicine with no generic name', { kind: 'medicine', display: 'Gentian violet paint' }, 'genericName'],
    ['a generic name of 201 characters', medicineBody({ genericName: 'g'.repeat(201) }), 'genericName'],
    ['a strength of 81 characters', medicineBody({ strength: 's'.repeat(81) }), 'strength'],
    ['a null strength', medicineBody({ strength: null }), 'strength'],
    ['an unknown dose form', medicineBody({ doseForm: 'pessary' }), 'doseForm'],
    ['six routes', medicineBody({ routes: ['oral', 'rectal', 'topical', 'nasal', 'buccal', 'vaginal'] }), 'routes'],
    ['a route twice', medicineBody({ routes: ['oral', ' Oral'] }), 'routes'],
    ['a route with a digit', medicineBody({ routes: ['oral2'] }), 'routes'],
    ['an empty route', medicineBody({ routes: [' '] }), 'routes'],
    ['a route that is not text', medicineBody({ routes: [5] }), 'routes'],
    ['routes that are not a list', medicineBody({ routes: 'oral' }), 'routes'],
    ['a specimen on a medicine', medicineBody({ specimen: 'Blood' }), 'specimen'],
    ['a category on a medicine', medicineBody({ category: 'serology' }), 'category'],
    ['a generic name on a lab test', { kind: 'lab_test', display: 'Sickling test', genericName: 'sickling' }, 'genericName'],
    ['a strength on a lab test', { kind: 'lab_test', display: 'Sickling test', strength: '1 mL' }, 'strength'],
    ['a dose form on a lab test', { kind: 'lab_test', display: 'Sickling test', doseForm: 'liquid' }, 'doseForm'],
    ['routes on a lab test', { kind: 'lab_test', display: 'Sickling test', routes: [] }, 'routes'],
    ['a specimen of 101 characters', { kind: 'lab_test', display: 'Sickling test', specimen: 'b'.repeat(101) }, 'specimen'],
    ['an unknown category', { kind: 'lab_test', display: 'Sickling test', category: 'radiology' }, 'category'],
    ['an unknown field', medicineBody({ code: 'MED-00001' }), 'code'],
    ['an id', medicineBody({ id: itemId }), 'id'],
  ])('%s is VALIDATION_FAILED on %s', async (_name, body, field) => {
    const problem = await problemOf(validate(CreateFacilityItemDto, body));
    expect([problem.getStatus(), problem.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(problem.errors?.map((error) => error.field)).toContain(field);
  });

  it('a change is a whole row version and a true or false, nothing else', async () => {
    await expect(validate(UpdateFacilityItemDto, { expectedRowVersion: 3, active: false }))
      .resolves.toEqual(Object.assign(new UpdateFacilityItemDto(), { expectedRowVersion: 3, active: false }));
    for (const body of [{ active: false }, { expectedRowVersion: 3 }, { expectedRowVersion: 0, active: true },
      { expectedRowVersion: 2.5, active: true }, { expectedRowVersion: '3', active: true },
      { expectedRowVersion: 3, active: 'false' }, { expectedRowVersion: 3, active: null },
      { expectedRowVersion: 3, active: true, display: 'Renamed' }]) {
      const problem = await problemOf(validate(UpdateFacilityItemDto, body));
      expect([JSON.stringify(body), problem.code]).toEqual([JSON.stringify(body), 'VALIDATION_FAILED']);
    }
  });

  it('the list takes a kind or none, and no other parameter', async () => {
    await expect(validate(ListFacilityItemsQueryDto, {}, 'query')).resolves.toEqual(new ListFacilityItemsQueryDto());
    await expect(validate(ListFacilityItemsQueryDto, { kind: 'medicine' }, 'query')).resolves.toMatchObject({ kind: 'medicine' });
    for (const query of [{ kind: 'device' }, { kind: ['medicine', 'lab_test'] }, { q: 'amox' }]) {
      await expect(validate(ListFacilityItemsQueryDto, query, 'query')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });
});

describe('ORD-7 facility items (0155): the list', () => {
  it('reads this facility\'s items of a kind in a staff transaction, and audits the read with the count only', async () => {
    const { service, calls, audits, transactions, client } = fakeStaff({ [FACILITY_ITEMS_LIST_SQL]: [testRow(),
      testRow({ id: '7d1c3a52-5f0e-4c1b-9a63-2b8e4f6a9c03', display: 'Old sickling test', active: false, row_version: '2',
        changed_at: new Date('2026-11-26T10:00:00.000Z'), specimen: null, category: null })] });
    await expect(service.list(caller, 'lab_test')).resolves.toEqual({ more: false, items: [
      { itemId: testId, kind: 'lab_test', codeSystem: 'HID-FACILITY', code: testId, display: 'Malaria RDT (own kit)',
        otherNames: [], specimen: 'Blood', category: 'parasitology', matchedName: null, scope: 'facility', active: true,
        rowVersion: 1, addedAt: '2026-11-26T09:00:00.000Z', changedAt: null },
      expect.objectContaining({ display: 'Old sickling test', active: false, rowVersion: 2,
        changedAt: '2026-11-26T10:00:00.000Z', specimen: null, category: null }),
    ] });
    expect(transactions).toEqual([{ staff: caller, options: undefined }]);
    expect(calls).toEqual([{ sql: FACILITY_ITEMS_LIST_SQL, values: [facilityId, 'lab_test'] }]);
    expect(FACILITY_ITEMS_LIST_SQL).toContain('limit 1001');
    expect(audits).toEqual([{ client, event: auditEvent('ehr.catalog.facility-item.list-read',
      { kind: 'lab_test', resultCount: 2 }) }]);
    expect(JSON.stringify(audits)).not.toMatch(/Malaria|sickling/i);
  });

  it('reads both kinds when none is asked, and answers at most 1,000 with more', async () => {
    const rows = Array.from({ length: 1001 }, (_, index) => medicineRow({ id: `7d1c3a52-5f0e-4c1b-9a63-${String(index).padStart(12, '0')}` }));
    const { service, calls, audits } = fakeStaff({ [FACILITY_ITEMS_LIST_SQL]: rows });
    const answer = await service.list(caller, undefined);
    expect([answer.items.length, answer.more]).toEqual([1000, true]);
    expect(calls[0]!.values).toEqual([facilityId, null]);
    expect(audits[0]!.event.details).toEqual({ kind: 'all', resultCount: 1000 });
  });
});

describe('ORD-7 facility items (0155): adding an item', () => {
  const input = () => Object.assign(new CreateFacilityItemDto(), medicineBody());
  const digest = () => requestDigest(FACILITY_ITEM_CREATE_OPERATION, input());

  it('adds it with the session\'s account and membership, keeps the key and digest, and audits it in the same transaction',
    async () => {
      const { service, calls, audits, transactions, client } = fakeStaff({ [FACILITY_ITEM_BY_KEY_SQL]: [],
        [FACILITY_ITEM_INSERT_SQL]: [medicineRow()] });
      await expect(service.create(caller, input(), key)).resolves.toEqual(medicineAnswer);
      expect(transactions).toEqual([{ staff: caller, options: undefined }]);
      expect(calls).toEqual([
        { sql: FACILITY_ITEM_BY_KEY_SQL, values: [facilityId, key] },
        { sql: FACILITY_ITEM_INSERT_SQL, values: [facilityId, 'medicine', 'Artemether + lumefantrine 20/120 mg dispersible tablet',
          'Artemether + lumefantrine', '20/120 mg', 'tablet', ['oral'], null, null, key, digest()] },
      ]);
      expect(FACILITY_ITEM_INSERT_SQL).toContain('platform.current_account_id(),\n  platform.current_membership_id())');
      expect(FACILITY_ITEM_INSERT_SQL).toContain('on conflict on constraint catalog_facility_items_key_uq do nothing');
      expect(FACILITY_ITEM_BY_KEY_SQL).toContain('created_by = platform.current_account_id()');
      expect(audits).toEqual([{ client, event: auditEvent('ehr.catalog.facility-item.created',
        { kind: 'medicine', idempotentReplay: false }, itemId) }]);
      expect(JSON.stringify(audits)).not.toMatch(/Artemether/);
    });

  it('adds a lab test with no medicine fields', async () => {
    const { service, calls } = fakeStaff({ [FACILITY_ITEM_BY_KEY_SQL]: [], [FACILITY_ITEM_INSERT_SQL]: [testRow()] });
    const test = Object.assign(new CreateFacilityItemDto(), { kind: 'lab_test', display: 'Malaria RDT (own kit)', specimen: 'Blood',
      category: 'parasitology' });
    await expect(service.create(caller, test, key)).resolves.toMatchObject({ kind: 'lab_test', code: testId,
      codeSystem: 'HID-FACILITY', otherNames: [] });
    expect(calls[1]!.values.slice(1, 9)).toEqual(['lab_test', 'Malaria RDT (own kit)', null, null, null, [], 'Blood',
      'parasitology']);
  });

  it('the same key with the same body answers the item it made, as it is now, and inserts nothing', async () => {
    const { service, calls, audits } = fakeStaff({ [FACILITY_ITEM_BY_KEY_SQL]: [{ ...medicineRow({ active: false,
      row_version: '2', changed_at: addedAt }), request_sha256: digest() }] });
    await expect(service.create(caller, input(), key)).resolves.toMatchObject({ itemId, active: false, rowVersion: 2 });
    expect(calls.map((call) => call.sql)).toEqual([FACILITY_ITEM_BY_KEY_SQL]);
    expect(audits.map((entry) => entry.event.details)).toEqual([{ kind: 'medicine', idempotentReplay: true }]);
  });

  it('the same key with another body is 409 IDEMPOTENCY_KEY_REUSED, and nothing is added or audited', async () => {
    const { service, calls, audits } = fakeStaff({ [FACILITY_ITEM_BY_KEY_SQL]: [{ ...medicineRow(), request_sha256: 'f'.repeat(64) }] });
    const problem = await problemOf(service.create(caller, input(), key));
    expect([problem.getStatus(), problem.code, problem.message]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED',
      'Idempotency-Key was already used with a different request']);
    expect(calls).toHaveLength(1);
    expect(audits).toEqual([]);
  });

  it('a request with the same key that committed while this one waited is answered as a replay', async () => {
    const { service, calls, audits } = fakeStaff({ [FACILITY_ITEM_BY_KEY_SQL]: inTurn([], [{ ...medicineRow(),
      request_sha256: digest() }]), [FACILITY_ITEM_INSERT_SQL]: [] });
    await expect(service.create(caller, input(), key)).resolves.toEqual(medicineAnswer);
    expect(calls.map((call) => call.sql)).toEqual([FACILITY_ITEM_BY_KEY_SQL, FACILITY_ITEM_INSERT_SQL, FACILITY_ITEM_BY_KEY_SQL]);
    expect(audits.map((entry) => entry.event.details)).toEqual([{ kind: 'medicine', idempotentReplay: true }]);
  });

  it.each([
    ['an active item of that name (23505, the name index)', databaseError('23505',
      { constraint: 'catalog_facility_items_active_name_uq' }), 409, 'FACILITY_ITEM_EXISTS',
    'This facility already has an active item with this name.'],
    ['the 501st active item (P0001)', databaseError('P0001', { message: 'FACILITY_ITEM_LIMIT' }), 409, 'FACILITY_ITEM_LIMIT',
      'This facility already has 500 items of this kind. Withdraw one first.'],
    ['row security refusing the write (42501)', databaseError('42501'), 403, 'PERMISSION_DENIED',
      'Required permission is missing'],
    ['a table check (23514)', databaseError('23514'), 400, 'VALIDATION_FAILED', 'One or more request fields are invalid.'],
  ])('%s is %s %s', async (_name, error, status, code, message) => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, audits } = fakeStaff({ [FACILITY_ITEM_BY_KEY_SQL]: [], [FACILITY_ITEM_INSERT_SQL]: error });
    const problem = await problemOf(service.create(caller, input(), key));
    expect([problem.getStatus(), problem.code, problem.message]).toEqual([status, code, message]);
    expect(audits).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it.each(['42P01', '42883', '57014', '23503'])('%s is 503 CATALOG_UNAVAILABLE; only a failure other than a missing 0155 '
    + 'is logged, by its SQLSTATE, never the name', async (code) => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service } = fakeStaff({ [FACILITY_ITEM_BY_KEY_SQL]: databaseError(code) });
    const problem = await problemOf(service.create(caller, input(), key));
    expect([problem.getStatus(), problem.code]).toEqual([503, 'CATALOG_UNAVAILABLE']);
    const logged = warn.mock.calls.map((call) => String(call[0]));
    expect(logged).toEqual(code === '42P01' || code === '42883' ? [] : [`Facility items failed (${code})`]);
    warn.mockRestore();
  });

  it('an add whose audit row cannot be written is refused (503), never answered unaudited', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service } = fakeStaff({ [FACILITY_ITEM_BY_KEY_SQL]: [], [FACILITY_ITEM_INSERT_SQL]: [medicineRow()] },
      databaseError('53300'));
    const problem = await problemOf(service.create(caller, input(), key));
    expect([problem.getStatus(), problem.code]).toEqual([503, 'CATALOG_UNAVAILABLE']);
    warn.mockRestore();
  });
});

describe('ORD-7 facility items (0155): withdrawing an item or bringing it back', () => {
  const change = (expectedRowVersion: number, active: boolean) =>
    Object.assign(new UpdateFacilityItemDto(), { expectedRowVersion, active });

  it('withdraws it at the loaded row version, as the session\'s member, and audits the change', async () => {
    const { service, calls, audits, client } = fakeStaff({ [FACILITY_ITEM_LOCK_SQL]: [medicineRow()],
      [FACILITY_ITEM_UPDATE_SQL]: [medicineRow({ active: false, row_version: '2',
        changed_at: new Date('2026-11-26T11:00:00.000Z') })] });
    await expect(service.update(caller, itemId, change(1, false))).resolves.toEqual({ ...medicineAnswer, active: false,
      rowVersion: 2, changedAt: '2026-11-26T11:00:00.000Z' });
    expect(calls).toEqual([{ sql: FACILITY_ITEM_LOCK_SQL, values: [itemId, facilityId] },
      { sql: FACILITY_ITEM_UPDATE_SQL, values: [itemId, facilityId, false, 1] }]);
    expect(FACILITY_ITEM_LOCK_SQL).toContain('for update');
    expect(FACILITY_ITEM_UPDATE_SQL).toContain('set active = $3, row_version = row_version + 1, '
      + 'changed_by = platform.current_account_id()');
    expect(FACILITY_ITEM_UPDATE_SQL).toContain('changed_by_membership_id = platform.current_membership_id()');
    expect(audits).toEqual([{ client, event: auditEvent('ehr.catalog.facility-item.changed',
      { kind: 'medicine', active: false, rowVersion: 2, previousRowVersion: 1 }, itemId) }]);
  });

  it('brings a withdrawn item back with the same id', async () => {
    const { service, audits } = fakeStaff({ [FACILITY_ITEM_LOCK_SQL]: [testRow({ active: false, row_version: '2' })],
      [FACILITY_ITEM_UPDATE_SQL]: [testRow({ active: true, row_version: '3', changed_at: addedAt })] });
    await expect(service.update(caller, testId, change(2, true))).resolves.toMatchObject({ itemId: testId, code: testId,
      active: true, rowVersion: 3 });
    expect(audits[0]!.event.details).toEqual({ kind: 'lab_test', active: true, rowVersion: 3, previousRowVersion: 2 });
  });

  it('another row version is 412 VERSION_CONFLICT, and nothing changes', async () => {
    const { service, calls, audits } = fakeStaff({ [FACILITY_ITEM_LOCK_SQL]: [medicineRow({ row_version: '4' })] });
    const problem = await problemOf(service.update(caller, itemId, change(3, false)));
    expect([problem.getStatus(), problem.code, problem.message]).toEqual([412, 'VERSION_CONFLICT',
      'This item changed since it was loaded. Reload and try again.']);
    expect(calls).toHaveLength(1);
    expect(audits).toEqual([]);
  });

  it('an update that finds no row at that version is 412 too', async () => {
    const { service, audits } = fakeStaff({ [FACILITY_ITEM_LOCK_SQL]: [medicineRow()], [FACILITY_ITEM_UPDATE_SQL]: [] });
    expect((await problemOf(service.update(caller, itemId, change(1, false)))).code).toBe('VERSION_CONFLICT');
    expect(audits).toEqual([]);
  });

  it('asked for the state it is in, it answers the item unchanged and writes nothing', async () => {
    const { service, calls, audits } = fakeStaff({ [FACILITY_ITEM_LOCK_SQL]: [medicineRow()] });
    await expect(service.update(caller, itemId, change(1, true))).resolves.toEqual(medicineAnswer);
    expect(calls.map((call) => call.sql)).toEqual([FACILITY_ITEM_LOCK_SQL]);
    expect(audits).toEqual([]);
  });

  it('an item not at this facility (or no item) is 404 CATALOG_ITEM_NOT_FOUND', async () => {
    const { service, calls } = fakeStaff({ [FACILITY_ITEM_LOCK_SQL]: [],
      [FACILITY_ITEM_MISSING_SQL]: [{ found: false, allowed: true }] });
    const problem = await problemOf(service.update(caller, itemId, change(1, false)));
    expect([problem.getStatus(), problem.code, problem.message]).toEqual([404, 'CATALOG_ITEM_NOT_FOUND',
      'This list item was not found at this facility.']);
    expect(calls[1]).toEqual({ sql: FACILITY_ITEM_MISSING_SQL, values: [itemId, facilityId] });
  });

  it('an item the session may read but the database no longer lets it write is 403 PERMISSION_DENIED', async () => {
    const { service } = fakeStaff({ [FACILITY_ITEM_LOCK_SQL]: [], [FACILITY_ITEM_MISSING_SQL]: [{ found: true, allowed: false }] });
    const problem = await problemOf(service.update(caller, itemId, change(1, false)));
    expect([problem.getStatus(), problem.code]).toEqual([403, 'PERMISSION_DENIED']);
  });

  it.each([
    [databaseError('P0001', { message: 'FACILITY_ITEM_LIMIT' }), 'FACILITY_ITEM_LIMIT'],
    [databaseError('23505', { constraint: 'catalog_facility_items_active_name_uq' }), 'FACILITY_ITEM_EXISTS'],
  ])('bringing an item back past 500, or beside an active item of its name, is 409 %s', async (error, code) => {
    const { service, audits } = fakeStaff({ [FACILITY_ITEM_LOCK_SQL]: [medicineRow({ active: false, row_version: '2' })],
      [FACILITY_ITEM_UPDATE_SQL]: error });
    const problem = await problemOf(service.update(caller, itemId, change(2, true)));
    expect([problem.getStatus(), problem.code]).toEqual([409, code]);
    expect(audits).toEqual([]);
  });

  it('a schema without 0155 is 503 CATALOG_UNAVAILABLE', async () => {
    const { service } = fakeStaff({ [FACILITY_ITEM_LOCK_SQL]: databaseError('42P01') });
    expect((await problemOf(service.update(caller, itemId, change(1, false)))).code).toBe('CATALOG_UNAVAILABLE');
  });
});

// What is sent, through the app's validation pipe and ProblemDetailsFilter.
describe('ORD-7 facility items (0155) over HTTP', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const start = async (answers: Partial<Record<string, Answer | InTurn>>) => {
    const { service, calls } = fakeStaff(answers);
    @Module({ controllers: [CatalogController],
      providers: [{ provide: CatalogService, useValue: {} }, { provide: FacilityItemsService, useValue: service }] })
    class TestModule {}
    const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((request: Request & Record<string, unknown>, _response: Response, next: NextFunction) => {
      request.actor = { subject: 'staff:test-admin', accountId, facility: { membershipId, organizationId } };
      request.facilityId = facilityId;
      request.correlationId = 'correlation-0155';
      next();
    });
    app.useGlobalPipes(createValidationPipe());
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const send = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}/ehr/catalog${path}`, { method,
        headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    return { send, calls };
  };

  it('adds an item (201) and answers it in the search\'s shape', async () => {
    const { send } = await start({ [FACILITY_ITEM_BY_KEY_SQL]: [], [FACILITY_ITEM_INSERT_SQL]: [medicineRow()] });
    const answer = await send('POST', '/facility-items', medicineBody(), { 'idempotency-key': key });
    expect([answer.status, answer.body]).toEqual([201, medicineAnswer]);
  });

  it('refuses an add without an Idempotency-Key (400), or with an unknown field (400), before the database', async () => {
    const { send, calls } = await start({});
    const noKey = await send('POST', '/facility-items', medicineBody());
    expect([noKey.status, noKey.body.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
    const unknown = await send('POST', '/facility-items', medicineBody({ atcCode: 'P01BF01' }), { 'idempotency-key': key });
    expect([unknown.status, unknown.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(calls).toEqual([]);
  });

  it('withdraws an item (200), refuses an item id that is not a UUID (400), and sends 409 and 412 as the service gives them',
    async () => {
      const { send } = await start({ [FACILITY_ITEM_LOCK_SQL]: inTurn([medicineRow()], [medicineRow({ row_version: '2' })],
        [medicineRow({ active: false })]),
      [FACILITY_ITEM_UPDATE_SQL]: inTurn([medicineRow({ active: false, row_version: '2' })],
        databaseError('P0001', { message: 'FACILITY_ITEM_LIMIT' })) });
      const withdrawn = await send('PATCH', `/facility-items/${itemId}`, { expectedRowVersion: 1, active: false });
      expect([withdrawn.status, withdrawn.body.active, withdrawn.body.rowVersion]).toEqual([200, false, 2]);
      const stale = await send('PATCH', `/facility-items/${itemId}`, { expectedRowVersion: 1, active: false });
      expect([stale.status, stale.body.code, stale.body.detail]).toEqual([412, 'VERSION_CONFLICT',
        'This item changed since it was loaded. Reload and try again.']);
      const full = await send('PATCH', `/facility-items/${itemId}`, { expectedRowVersion: 1, active: true });
      expect([full.status, full.body.code]).toEqual([409, 'FACILITY_ITEM_LIMIT']);
      const notUuid = await send('PATCH', '/facility-items/MED-00001', { expectedRowVersion: 1, active: false });
      expect(notUuid.status).toBe(400);
    });

  it('lists this facility\'s items (200) and refuses an unknown kind (400)', async () => {
    const { send, calls } = await start({ [FACILITY_ITEMS_LIST_SQL]: [medicineRow()] });
    const listed = await send('GET', '/facility-items?kind=medicine');
    expect([listed.status, listed.body]).toEqual([200, { items: [medicineAnswer], more: false }]);
    const refused = await send('GET', '/facility-items?kind=device');
    expect([refused.status, refused.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(calls).toHaveLength(1);
  });
});
