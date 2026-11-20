import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import type { DataAccessContext } from '../common/request-context';
import { requestDigest } from '../common/idempotency';
import { DatabaseService } from '../database/database.service';
import { IdentityService } from '../identity/identity.service';
import { basisDetails, PharmacyOrderRouteAccess } from './order-route-access';
import { PharmacyOrderRouteCards } from './order-route-cards';
import { OWN_WORK_OFF, PharmacyOwnWork } from './own-work-access';
import { PharmacyOwnWorkPatientCards } from './own-work-patient-cards';
import { PharmacyModule } from './pharmacy.module';
import { PharmacyService, WORK_LIST_QUERY, WORK_LIST_QUERY_0133 } from './pharmacy.service';
import { PRESCRIPTION_DETAILS_OFF } from './prescription-dispensing-details';
import { workListSince } from './work-list-window';

/*
 * This facility's own work for its pharmacy staff (0133; owner, 18 November
 * 2026: "pharmacy and lab staff get their own facility's work items only,
 * never the chart"; finding F2). A command on an own work item or its
 * dispensing first asks pharmacy.own_work_access_for (in a savepoint); a row
 * means basis 'own-work' and Identity is not asked; no row, a schema without
 * 0133 or any refusal falls back to Identity's consent as before. The work
 * list records each own patient shown with the basis the reader gives, and an
 * own item whose automatic send was withdrawn carries `withdrawn: true` with
 * `withdrawnReason: 'changed'`; one sent to another facility's pharmacy (D14,
 * owner's Q121 A) carries `withdrawnReason: 'sent_elsewhere'`.
 *
 * ORD-4 asks pharmacy.own_work_item_steps first, in the same savepoint; these
 * tests run on a Release A schema, where it is not there (42883), so 0133's
 * reader answers exactly as before (pharmacist-acceptance.spec.ts covers the
 * schema with ORD-4).
 */

const facilityId = '10000000-0000-4000-8000-000000000001';
const accountId = '20000000-0000-4000-8000-000000000001';
const ada = '50000000-0000-4000-8000-000000000001';
const bisi = '50000000-0000-4000-8000-000000000002';
const id = (n: number) => `63000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pharmacist: DataAccessContext = { correlationId: 'own-work-access-correlation', facilityId,
  membershipId: '40000000-0000-4000-8000-000000000001', purposeOfUse: 'direct-care', actor: { id: 'actor',
    subject: 'staff:pharmacist', accountId, roles: ['pharmacist'],
    permissions: ['pharmacy.work-item.read', 'pharmacy.dispensing.create'], facilityIds: [facilityId], facilities: [],
    authenticationMethod: 'local' } };

const row = (n: number, patient: string) => ({ id: id(n), patient_id: patient, facility_id: facilityId,
  ordering_facility_id: facilityId, source_ehr_prescription_id: `30000000-0000-4000-8000-00000000000${n}`,
  source_ehr_prescription_version: '2', source_encounter_id: '70000000-0000-4000-8000-000000000001',
  source_status: 'active', status: 'accepted', medication_code_system: null, medication_code: null,
  medication_display: 'Amoxicillin 500 mg capsule', dose_quantity: '1', dose_unit: 'capsule', route_code: 'oral',
  frequency: 'Every 8 hours', instructions: 'After food', starts_on: null, ends_on: null, prescribed_by: accountId,
  prescribed_at: new Date(Date.UTC(2026, 10, 18, 9, n)), accepted_by: accountId,
  accepted_at: new Date(Date.UTC(2026, 10, 18, 9, n)), row_version: '1', created_at: new Date(Date.UTC(2026, 10, 18, 9, n)),
  dispensing_id: null, dispensing_status: null, reversal_id: null, order_route_id: null });

const ACCESS = /from pharmacy\.own_work_access_for\(\$1, \$2::uuid, \$3\)/;
const STATES = /from pharmacy\.own_work_item_states\(\$1::uuid\[\]\)/;
const STEPS = /from pharmacy\.own_work_item_steps\(\$1::uuid\[\]\)/;
/** ORD-4's reader on a Release A schema. */
const noStepsReader = () => Object.assign(new Error('function pharmacy.own_work_item_steps(uuid[]) does not exist'),
  { code: '42883' });
const CARDS = /from pharmacy\.work_item_patient_cards\(\$1::uuid\[\]\)/;

interface Options {
  ownWork?: boolean;
  accessRows?: { work_item_id: string; basis: string }[];
  accessError?: Error & { code?: string };
  statesError?: Error & { code?: string };
  /** The ids 0133's states answer (default: every one asked). */
  statesFor?: (ids: string[]) => string[];
  /** withdrawn_reason per withdrawn id (default: id(3) withdrawn, 'changed'). */
  reasons?: Record<string, string | null>;
  /** What 0133's list query (WORK_LIST_QUERY_0133) raises, e.g. 42883 on a schema without its reader. */
  listError?: Error & { code?: string };
  identityAllowed?: boolean;
  /** 0124's OWN_WORK_PATIENT_CARD_ENABLED (default on). */
  cards?: boolean;
  dispenseError?: Error & { code?: string };
}

const DISPENSING_ID = '64000000-0000-4000-8000-000000000001';
const dispensingRow = (workItemId: string) => ({ id: DISPENSING_ID, work_item_id: workItemId, work_item_version: '1',
  patient_id: ada, facility_id: facilityId, medication_code_system: null, medication_code: null,
  medication_display: 'Amoxicillin 500 mg capsule', quantity_dispensed: '21', quantity_unit: 'capsule',
  status: 'dispensed', dispensed_by: accountId, dispensed_at: new Date(), row_version: '1', created_at: new Date(),
  request_sha256: 'x', reversal_id: null, reversed_at: null });

const harness = (options: Options = {}) => {
  const rows = [row(1, ada), row(2, bisi), row(3, ada)];
  const statements: string[] = [];
  /** The parameters each list query was sent, in order (Q123 A: the window's first day). */
  const listValues: unknown[][] = [];
  const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
    statements.push(sql);
    if (sql === WORK_LIST_QUERY || sql === WORK_LIST_QUERY_0133) listValues.push(values);
    if (sql === WORK_LIST_QUERY) return { rows };
    if (sql === WORK_LIST_QUERY_0133) {
      if (options.listError) throw options.listError;
      return { rows };
    }
    if (/where w\.id=\$1/.test(sql)) return { rows: rows.filter((r) => r.id === values[0]) };
    if (/from pharmacy\.order_route_access_for/.test(sql)) {
      return { rows: [{ outcome: 'none', route_id: null, work_item_id: null }] };
    }
    if (ACCESS.test(sql)) {
      if (options.accessError) throw options.accessError;
      return { rows: options.accessRows ?? [{ work_item_id: values[1], basis: 'own-work' }] };
    }
    if (STEPS.test(sql)) throw noStepsReader();
    if (STATES.test(sql)) {
      if (options.statesError) throw options.statesError;
      const asked = values[0] as string[];
      const reasons = options.reasons ?? { [id(3)]: 'changed' };
      return { rows: (options.statesFor ? options.statesFor(asked) : asked).map((item) => ({ work_item_id: item,
        basis: item === id(2) ? 'consent' : 'own-work', withdrawn: Object.hasOwn(reasons, item),
        withdrawn_reason: reasons[item] ?? null })) };
    }
    if (/from pharmacy\.dispensings d left join/.test(sql) && /where d\.id=\$1/.test(sql)) {
      return { rows: values[0] === DISPENSING_ID ? [dispensingRow(id(1))] : [] };
    }
    if (/insert into pharmacy\.dispensing_reversals/.test(sql)) {
      return { rows: [{ id: '65000000-0000-4000-8000-000000000001', dispensing_id: values[1], dispensing_version: '1',
        work_item_id: values[3], patient_id: values[4], facility_id: values[5], status: 'reversed', reversed_by: accountId,
        reversed_at: new Date(), row_version: '1', created_at: new Date() }] };
    }
    if (/from pharmacy\.imported_medication_evidence where id=\$1/.test(sql)) {
      return { rows: [{ id: '66000000-0000-4000-8000-000000000001', patient_id: ada, facility_id: facilityId }] };
    }
    if (CARDS.test(sql)) {
      return { rows: (values[0] as string[]).map((item) => ({ work_item_id: item,
        patient_full_name: item === id(2) ? 'Bisi Own' : 'Ada Own', patient_sex: null, patient_date_of_birth: null,
        patient_health_id_last4: 'AAA2' })) };
    }
    if (/insert into pharmacy\.dispensings/.test(sql)) {
      if (options.dispenseError) throw options.dispenseError;
      return { rows: [{ id: '64000000-0000-4000-8000-000000000001', work_item_id: values[1], work_item_version: '1',
        patient_id: values[3], facility_id: values[4], medication_code_system: null, medication_code: null,
        medication_display: 'Amoxicillin 500 mg capsule', quantity_dispensed: '21', quantity_unit: 'capsule',
        status: 'dispensed', dispensed_by: accountId, dispensed_at: new Date(), row_version: '1',
        created_at: new Date() }] };
    }
    return { rows: [] };
  }) } as unknown as PoolClient;
  const database = { withTransaction: async <T>(_c: DataAccessContext, fn: (c: PoolClient) => Promise<T>) => fn(client),
    query: jest.fn(async () => ({ rows: [{ orders: false, work: false }] })) } as unknown as DatabaseService;
  const identity = { authorize: jest.fn().mockResolvedValue({ allowed: options.identityAllowed ?? true,
    breakGlass: false }) } as unknown as IdentityService;
  const audit = { recordWithClient: jest.fn(async () => undefined) };
  const ownWork = options.ownWork === false ? OWN_WORK_OFF : new PharmacyOwnWork(true);
  const service = new PharmacyService(database, identity, audit as unknown as AuditService,
    new PharmacyOrderRouteAccess(identity, ownWork), new PharmacyOrderRouteCards(database),
    new PharmacyOwnWorkPatientCards(options.cards ?? true), PRESCRIPTION_DETAILS_OFF, ownWork);
  const audited = () => audit.recordWithClient.mock.calls.map((call) => {
    const [, , action, resource, details] = call as unknown as [unknown, unknown, string,
      { patientId?: string; resourceType: string; resourceId: string }, Record<string, unknown> | undefined];
    return { action, patientId: resource.patientId ?? null, resourceType: resource.resourceType, details };
  });
  return { service, statements, identity, audited, listValues };
};

describe('own pharmacy work (0133)', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('reads an own work item on the own-work basis without asking Identity, and audits it', async () => {
    const { service, statements, identity, audited } = harness();
    const item = await service.getWorkItem(pharmacist, id(1));
    expect(item.id).toBe(id(1));
    expect(identity.authorize).not.toHaveBeenCalled();
    expect(statements.filter((sql) => /savepoint pharmacy_own_work_access/.test(sql))).toEqual([
      'savepoint pharmacy_own_work_access', 'release savepoint pharmacy_own_work_access']);
    expect(audited()).toEqual([{ action: 'pharmacy.work-item.read', patientId: ada, resourceType: 'pharmacy-work-item',
      details: { basis: 'own-work' } }]);
  });

  it('dispenses an own work item on the own-work basis and records it', async () => {
    const { service, identity, audited } = harness();
    await service.dispense(pharmacist, id(1), { expectedWorkItemVersion: 1, quantityDispensed: 21,
      quantityUnit: 'capsule', reason: 'Dispensed to the patient' }, 'own-work-dispense-key-0001');
    expect(identity.authorize).not.toHaveBeenCalled();
    expect(audited()).toEqual([{ action: 'pharmacy.dispensing.create', patientId: ada,
      resourceType: 'medication-dispensing', details: { workItemId: id(1), workItemVersion: 1, status: 'dispensed',
        basis: 'own-work' } }]);
  });

  it('keeps the basis consent, without asking Identity, for a pharmacist holding its own consent (as the list does)',
    async () => {
      const { service, identity, audited } = harness({ accessRows: [{ work_item_id: id(1), basis: 'consent' }] });
      await service.getWorkItem(pharmacist, id(1));
      await service.dispense(pharmacist, id(1), { expectedWorkItemVersion: 1, quantityDispensed: 21,
        quantityUnit: 'capsule', reason: 'Dispensed to the patient' }, 'own-work-dispense-key-0002');
      expect(identity.authorize).not.toHaveBeenCalled();
      expect(audited().map((entry) => [entry.action, entry.details])).toEqual([
        ['pharmacy.work-item.read', {}],
        ['pharmacy.dispensing.create', { workItemId: id(1), workItemVersion: 1, status: 'dispensed' }]]);
    });

  it('falls back to Identity\'s consent when the database answers no own-work basis', async () => {
    const { service, identity, audited } = harness({ accessRows: [] });
    await service.getWorkItem(pharmacist, id(1));
    expect(identity.authorize).toHaveBeenCalledWith(ada, 'read_records', pharmacist);
    expect(audited()[0]!.details).toEqual({});
  });

  it('is refused 403 when neither applies', async () => {
    const { service } = harness({ accessRows: [], identityAllowed: false });
    await expect(service.getWorkItem(pharmacist, id(1))).rejects.toMatchObject({ status: 403,
      code: 'PHARMACY_ACCESS_DENIED' });
  });

  it('falls back to Identity on a schema without 0133, after rolling back its savepoint', async () => {
    const missing = Object.assign(new Error('function pharmacy.own_work_access_for does not exist'), { code: '42883' });
    const { service, statements, identity } = harness({ accessError: missing });
    await service.getWorkItem(pharmacist, id(1));
    expect(statements).toContain('rollback to savepoint pharmacy_own_work_access');
    expect(identity.authorize).toHaveBeenCalledTimes(1);
  });

  it('passes a serialization failure on, so the whole transaction is retried', async () => {
    const conflict = Object.assign(new Error('could not serialize access'), { code: '40001' });
    const { service, identity } = harness({ accessError: conflict });
    await expect(service.getWorkItem(pharmacist, id(1))).rejects.toBe(conflict);
    expect(identity.authorize).not.toHaveBeenCalled();
  });

  it('lists own rows with the reader\'s basis per patient, and marks a withdrawn send', async () => {
    const { service, statements, audited } = harness();
    const page = await service.listWorkItems(pharmacist);
    expect(page.items.map((item) => [item.id, 'withdrawn' in item ? item.withdrawn : false,
      'withdrawnReason' in item ? item.withdrawnReason : undefined])).toEqual([
      [id(1), false, undefined], [id(2), false, undefined], [id(3), true, 'changed']]);
    expect(statements.filter((sql) => /from pharmacy\.work_items w/.test(sql))).toEqual([WORK_LIST_QUERY_0133]);
    expect(statements.filter((sql) => /savepoint pharmacy_work_list/.test(sql))).toEqual([
      'savepoint pharmacy_work_list', 'release savepoint pharmacy_work_list']);
    expect(audited().map((event) => [event.patientId, event.details])).toEqual([
      [null, { returnedCount: 3 }],
      [ada, { basis: 'own-work', workItemIds: [id(1), id(3)] }],
      [bisi, { basis: 'consent', workItemIds: [id(2)] }]]);
  });

  it('records every own patient listed with 0133\'s basis while the patient card is off (0124 flag off)', async () => {
    const { service, statements, audited } = harness({ cards: false });
    const page = await service.listWorkItems(pharmacist);
    expect(statements.some((sql) => CARDS.test(sql))).toBe(false);
    expect(page.items.map((item) => 'patient' in item)).toEqual([false, false, false]);
    expect(audited().map((event) => [event.patientId, event.details])).toEqual([
      [null, { returnedCount: 3 }],
      [ada, { basis: 'own-work', workItemIds: [id(1), id(3)] }],
      [bisi, { basis: 'consent', workItemIds: [id(2)] }]]);
  });

  it('records a row 0133 no longer answers (a grant ended meanwhile) with the list read\'s basis, consent', async () => {
    const { service, audited } = harness({ cards: false, statesFor: (ids) => ids.filter((item) => item !== id(3)) });
    await service.listWorkItems(pharmacist);
    expect(audited().slice(1).map((event) => [event.patientId, event.details])).toEqual([
      [ada, { basis: 'own-work', workItemIds: [id(1)] }],
      [bisi, { basis: 'consent', workItemIds: [id(2)] }],
      [ada, { basis: 'consent', workItemIds: [id(3)] }]]);
  });

  it('on a schema without 0133 records as 0124 did: shown patients with basis consent, no withdrawn flag', async () => {
    const missing = Object.assign(new Error('function pharmacy.own_work_item_states does not exist'), { code: '42883' });
    const noReader = Object.assign(new Error('function pharmacy.own_withdrawn_work_items does not exist'),
      { code: '42883' });
    const shown = harness({ statesError: missing, listError: noReader });
    const page = await shown.service.listWorkItems(pharmacist);
    expect(page.items.map((item) => item.id)).toEqual([id(1), id(2), id(3)]);
    expect(page.items.some((item) => 'withdrawn' in item)).toBe(false);
    expect(shown.statements.filter((sql) => /from pharmacy\.work_items w|savepoint pharmacy_work_list/.test(sql)))
      .toEqual(['savepoint pharmacy_work_list', WORK_LIST_QUERY_0133, 'rollback to savepoint pharmacy_work_list',
        WORK_LIST_QUERY]);
    expect(shown.statements).toContain('rollback to savepoint pharmacy_own_work_states');
    expect(shown.audited().slice(1).map((event) => [event.patientId, event.details])).toEqual([
      [ada, { basis: 'consent', workItemIds: [id(1), id(3)] }], [bisi, { basis: 'consent', workItemIds: [id(2)] }]]);
    const hidden = harness({ statesError: missing, cards: false });
    await hidden.service.listWorkItems(pharmacist);
    expect(hidden.audited().map((event) => event.patientId)).toEqual([null]);
  });

  it('fails the list rather than record a basis it could not read', async () => {
    const timeout = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const { service, statements, audited } = harness({ statesError: timeout, cards: false });
    await expect(service.listWorkItems(pharmacist)).rejects.toBe(timeout);
    expect(statements).toContain('rollback to savepoint pharmacy_own_work_states');
    expect(audited().filter((event) => event.patientId)).toEqual([]);
  });

  it('passes a serialization failure of the states on, so the list is run again', async () => {
    const conflict = Object.assign(new Error('could not serialize access'), { code: '40001' });
    const { service, statements } = harness({ statesError: conflict });
    await expect(service.listWorkItems(pharmacist)).rejects.toBe(conflict);
    // The only rollback is ORD-4's fallback to 0133's reader (42883), before the conflict: none after it.
    const reader = statements.findIndex((sql) => STATES.test(sql));
    expect(statements.slice(reader - 2, reader)).toEqual([expect.stringMatching(STEPS),
      'rollback to savepoint pharmacy_own_work_states']);
    expect(statements.slice(reader + 1)).not.toContain('rollback to savepoint pharmacy_own_work_states');
  });

  it('reads one withdrawn own item with the flag, and without it (still answering) when the states fail', async () => {
    await expect(harness().service.getWorkItem(pharmacist, id(3))).resolves.toMatchObject({ id: id(3), withdrawn: true });
    const failing = harness({ statesError: Object.assign(new Error('timeout'), { code: '57014' }) });
    const item = await failing.service.getWorkItem(pharmacist, id(3));
    expect('withdrawn' in item).toBe(false);
    expect(failing.audited().map((event) => event.details)).toEqual([{ basis: 'own-work' }]);
  });

  it('answers 409 PHARMACY_PRESCRIPTION_NOT_DISPENSABLE when a withdrawn item is dispensed (0101)', async () => {
    const { service, identity, audited } = harness({ dispenseError: Object.assign(
      new Error('PRESCRIPTION_SOURCE_NOT_DISPENSABLE'), { code: '23514' }) });
    await expect(service.dispense(pharmacist, id(3), { expectedWorkItemVersion: 1, quantityDispensed: 21,
      quantityUnit: 'capsule', reason: 'Dispensed to the patient' }, 'own-work-dispense-key-0003'))
      .rejects.toMatchObject({ status: 409, code: 'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE',
        message: 'This prescription can no longer be dispensed here' });
    expect(identity.authorize).not.toHaveBeenCalled();
    expect(audited()).toEqual([]);
  });

  // 0133 D14 (owner's Q121 A): the database refuses the dispensing of an own item sent to another facility's
  // pharmacy, whichever image asks, with 23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE and DETAIL sent_elsewhere.
  it('answers a dispensing refused as sent elsewhere with its own detail and withdrawnReason, writing nothing', async () => {
    const { service, statements, audited } = harness({ reasons: { [id(3)]: 'sent_elsewhere' },
      dispenseError: Object.assign(new Error('PRESCRIPTION_SOURCE_NOT_DISPENSABLE'), { code: '23514',
        detail: 'sent_elsewhere' }) });
    const refusal = await service.dispense(pharmacist, id(3), { expectedWorkItemVersion: 1, quantityDispensed: 21,
      quantityUnit: 'capsule', reason: 'Dispensed to the patient' }, 'own-work-dispense-key-0004')
      .catch((error: unknown) => error);
    expect(refusal).toMatchObject({ status: 409, code: 'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE',
      message: 'This prescription was sent to another pharmacy, so it can no longer be dispensed here',
      extensions: { withdrawnReason: 'sent_elsewhere' } });
    // The database decides: nothing asks the states before the insert.
    expect(statements.some((sql) => STATES.test(sql))).toBe(false);
    expect(audited()).toEqual([]);
  });

  it.each([['not_claimed', 'not_claimed'], ['no detail', undefined], ['another detail', 'Sent_Elsewhere']])(
    'answers a same-facility refusal with %s as today, without withdrawnReason', async (_name, detail) => {
      const { service } = harness({ dispenseError: Object.assign(new Error('PRESCRIPTION_SOURCE_NOT_DISPENSABLE'),
        { code: '23514', ...(detail === undefined ? {} : { detail }) }) });
      const refusal = await service.dispense(pharmacist, id(1), { expectedWorkItemVersion: 1, quantityDispensed: 21,
        quantityUnit: 'capsule', reason: 'Dispensed to the patient' }, 'own-work-dispense-key-0005')
        .catch((error: unknown) => error) as { extensions?: unknown; message: string };
      expect(refusal).toMatchObject({ status: 409, code: 'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE',
        message: 'This prescription can no longer be dispensed here' });
      expect(refusal.extensions).toBeUndefined();
    });

  it('reads an item sent elsewhere by id: withdrawn, with withdrawnReason sent_elsewhere', async () => {
    const { service, audited } = harness({ reasons: { [id(3)]: 'sent_elsewhere' } });
    await expect(service.getWorkItem(pharmacist, id(3))).resolves.toMatchObject({ id: id(3), withdrawn: true,
      withdrawnReason: 'sent_elsewhere' });
    expect(audited()).toEqual([{ action: 'pharmacy.work-item.read', patientId: ada, resourceType: 'pharmacy-work-item',
      details: { basis: 'own-work' } }]);
  });

  it('answers withdrawnReason only together with withdrawn', async () => {
    const { service } = harness({ reasons: {} });
    const item = await service.getWorkItem(pharmacist, id(3));
    expect('withdrawn' in item || 'withdrawnReason' in item).toBe(false);
    const page = await harness({ reasons: { [id(1)]: null } }).service.listWorkItems(pharmacist);
    expect(page.items.map((entry) => ['withdrawn' in entry ? entry.withdrawn : false,
      'withdrawnReason' in entry ? entry.withdrawnReason : undefined])).toEqual([[true, 'changed'],
      [false, undefined], [false, undefined]]);
  });

  it('falls back to today\'s list on a schema without 0133\'s reader (42883), after rolling back its savepoint', async () => {
    const noReader = Object.assign(new Error('function pharmacy.own_withdrawn_work_items does not exist'),
      { code: '42883' });
    const { service, statements, listValues } = harness({ listError: noReader });
    const page = await service.listWorkItems(pharmacist);
    expect(page.items.map((item) => item.id)).toEqual([id(1), id(2), id(3)]);
    expect(statements.filter((sql) => /from pharmacy\.work_items w|savepoint pharmacy_work_list/.test(sql))).toEqual([
      'savepoint pharmacy_work_list', WORK_LIST_QUERY_0133, 'rollback to savepoint pharmacy_work_list', WORK_LIST_QUERY]);
    // Both queries reach back to the same day (Q123 A), and the answer says which.
    expect(listValues).toEqual([[page.since], [page.since]]);
    expect(page.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('sends 0133\'s list query the window\'s first day, and answers it (Q123 A)', async () => {
    const { service, listValues } = harness();
    const before = workListSince();
    const page = await service.listWorkItems(pharmacist);
    expect([before, workListSince()]).toContain(page.since);
    expect(listValues).toEqual([[page.since]]);
  });

  it.each(['40001', '40P01', '42501', '57014'])('passes a %s of 0133\'s list query on: no fallback, no list', async (code) => {
    const error = Object.assign(new Error(`synthetic ${code}`), { code });
    const { service, statements, audited } = harness({ listError: error });
    await expect(service.listWorkItems(pharmacist)).rejects.toBe(error);
    expect(statements).not.toContain(WORK_LIST_QUERY);
    expect(statements).not.toContain('rollback to savepoint pharmacy_work_list');
    expect(audited()).toEqual([]);
  });

  it('off, lists with today\'s query and no savepoint', async () => {
    const { service, statements, listValues } = harness({ ownWork: false });
    const page = await service.listWorkItems(pharmacist);
    expect(statements.filter((sql) => /from pharmacy\.work_items w|savepoint pharmacy_work_list/.test(sql)))
      .toEqual([WORK_LIST_QUERY]);
    expect(listValues).toEqual([[page.since]]);
  });

  it('reads and reverses an own dispensing on the own-work basis, asking about the dispensing', async () => {
    const read = harness();
    await read.service.getDispensing(pharmacist, DISPENSING_ID);
    expect(read.identity.authorize).not.toHaveBeenCalled();
    expect(read.audited()).toEqual([{ action: 'pharmacy.dispensing.read', patientId: ada,
      resourceType: 'medication-dispensing', details: { basis: 'own-work' } }]);
    const reverse = harness();
    await reverse.service.reverse(pharmacist, DISPENSING_ID, { expectedDispensingVersion: 1,
      reason: 'Dispensed to the wrong patient' }, 'own-work-reverse-key-0001');
    expect(reverse.identity.authorize).not.toHaveBeenCalled();
    expect(reverse.audited()).toEqual([{ action: 'pharmacy.dispensing.reverse', patientId: ada,
      resourceType: 'medication-dispensing-reversal', details: { dispensingId: DISPENSING_ID, dispensingVersion: 1,
        status: 'reversed', basis: 'own-work' } }]);
  });

  it.each([
    ['getWorkItem', 'work_item', id(1), 'read_records', (service: PharmacyService) => service.getWorkItem(pharmacist, id(1))],
    ['dispense', 'work_item', id(1), 'write_records', (service: PharmacyService) => service.dispense(pharmacist, id(1),
      { expectedWorkItemVersion: 1, quantityDispensed: 21, quantityUnit: 'capsule', reason: 'Dispensed' }, 'own-key-0002')],
    ['getDispensing', 'dispensing', DISPENSING_ID, 'read_records', (service: PharmacyService) =>
      service.getDispensing(pharmacist, DISPENSING_ID)],
    ['reverse', 'dispensing', DISPENSING_ID, 'write_records', (service: PharmacyService) =>
      service.reverse(pharmacist, DISPENSING_ID, { expectedDispensingVersion: 1, reason: 'Reversed' }, 'own-key-0003')],
  ] as const)('%s asks pharmacy.own_work_access_for about its %s', async (_name, resource, resourceId, action, call) => {
    const { service, identity } = harness();
    const asked: unknown[][] = [];
    const client = (service as unknown as { database: { withTransaction: (c: unknown, fn: (c: PoolClient) => unknown) =>
      unknown } }).database;
    const original = client.withTransaction;
    client.withTransaction = async (c, fn) => original(c, (pool: PoolClient) => fn({ query: async (sql: string,
      values?: unknown[]) => {
      if (ACCESS.test(sql)) asked.push(values ?? []);
      return (pool.query as unknown as (s: string, v?: unknown[]) => Promise<unknown>)(sql, values);
    } } as unknown as PoolClient));
    await call(service);
    expect(asked).toEqual([[resource, resourceId, action]]);
    expect(identity.authorize).not.toHaveBeenCalled();
  });

  it('never gives imported medication evidence or a new acceptance on the own-work basis (consent decides)', async () => {
    const { service, statements, identity, audited } = harness({ identityAllowed: false });
    await expect(service.getImport(pharmacist, '66000000-0000-4000-8000-000000000001'))
      .rejects.toMatchObject({ status: 403, code: 'PHARMACY_ACCESS_DENIED' });
    await expect(service.listImports(pharmacist, { patientId: ada } as never))
      .rejects.toMatchObject({ status: 403, code: 'PHARMACY_ACCESS_DENIED' });
    await expect(service.acceptPrescription(pharmacist, { patientId: ada, orderingFacilityId: facilityId,
      sourceEhrPrescriptionId: '30000000-0000-4000-8000-000000000009', sourceEhrPrescriptionVersion: 2,
      sourceEncounterId: '70000000-0000-4000-8000-000000000001', sourceStatus: 'active',
      medicationDisplay: 'Amoxicillin 500 mg capsule', frequency: 'Every 8 hours', instructions: 'After food',
      prescribedBy: accountId, prescribedAt: '2026-11-18T09:00:00Z', acceptanceReason: 'Accepted' } as never, 'own-key-0004'))
      .rejects.toMatchObject({ status: 403, code: 'PHARMACY_ACCESS_DENIED' });
    expect(statements.some((sql) => ACCESS.test(sql) || STATES.test(sql) || STEPS.test(sql))).toBe(false);
    expect(identity.authorize).toHaveBeenCalledTimes(3);
    expect(audited()).toEqual([]);
  });

  it('a replayed acceptance answers an own item as the single-item read does: withdrawn and why (D14)', async () => {
    const input = { patientId: ada, orderingFacilityId: facilityId,
      sourceEhrPrescriptionId: row(3, ada).source_ehr_prescription_id, sourceEhrPrescriptionVersion: 2,
      sourceEncounterId: '70000000-0000-4000-8000-000000000001', sourceStatus: 'active',
      medicationDisplay: 'Amoxicillin 500 mg capsule', frequency: 'Every 8 hours', instructions: 'After food',
      prescribedBy: accountId, prescribedAt: '2026-11-18T09:00:00Z', acceptanceReason: 'Accepted' };
    const stored = { ...row(3, ada), request_sha256: requestDigest('pharmacy.work-item.accept-ehr-prescription', input) };
    const replay = async (reasons: Record<string, string | null>, existing: typeof stored) => {
      const { service, statements } = harness({ reasons });
      const database = (service as unknown as { database: DatabaseService }).database;
      const original = database.withTransaction.bind(database);
      database.withTransaction = (async (c: DataAccessContext, fn: (client: PoolClient) => Promise<unknown>) =>
        original(c, (pool: PoolClient) => fn({ query: async (sql: string, values?: unknown[]) => {
          if (/or w\.source_ehr_prescription_id=\$4/.test(sql)) {
            statements.push(sql);
            return { rows: [existing] };
          }
          return (pool.query as unknown as (s: string, v?: unknown[]) => Promise<unknown>)(sql, values);
        } } as unknown as PoolClient))) as typeof database.withTransaction;
      const answer = await service.acceptPrescription(pharmacist, input as never, 'own-key-replay');
      return { answer: answer as Record<string, unknown>, statements };
    };
    const sentElsewhere = await replay({ [id(3)]: 'sent_elsewhere' }, stored);
    expect(sentElsewhere.answer).toMatchObject({ id: id(3), withdrawn: true, withdrawnReason: 'sent_elsewhere' });
    expect(sentElsewhere.statements.some((sql) => /insert into pharmacy\.work_items/.test(sql))).toBe(false);
    expect((await replay({ [id(3)]: 'changed' }, stored)).answer)
      .toMatchObject({ withdrawn: true, withdrawnReason: 'changed' });
    const live = (await replay({}, stored)).answer;
    expect(live).not.toHaveProperty('withdrawn');
    expect(live).not.toHaveProperty('withdrawnReason');
    // A route-backed item is never an own item: its states are not asked.
    const routed = await replay({ [id(3)]: 'sent_elsewhere' },
      { ...stored, order_route_id: '80000000-0000-4000-8000-000000000001' } as never);
    expect(routed.answer).not.toHaveProperty('withdrawn');
    expect(routed.statements.some((sql) => STATES.test(sql) || STEPS.test(sql))).toBe(false);
  });

  it('off, asks nothing new and keeps Identity\'s consent', async () => {
    const { service, statements, identity } = harness({ ownWork: false });
    await service.getWorkItem(pharmacist, id(1));
    expect(statements.some((sql) => ACCESS.test(sql) || STATES.test(sql) || STEPS.test(sql))).toBe(false);
    expect(identity.authorize).toHaveBeenCalledTimes(1);
  });

  it('parses withdrawn_reason: sent_elsewhere only for exactly that text; none or any other is changed', async () => {
    const rows = [
      { work_item_id: id(1), basis: 'own-work', withdrawn: true, withdrawn_reason: 'sent_elsewhere' },
      { work_item_id: id(2), basis: 'consent', withdrawn: true, withdrawn_reason: 'changed' },
      { work_item_id: id(3), basis: 'own-work', withdrawn: true, withdrawn_reason: null },
      { work_item_id: id(4), basis: 'own-work', withdrawn: true, withdrawn_reason: 'returned' },
      { work_item_id: id(5), basis: 'own-work', withdrawn: true, withdrawn_reason: 'SENT_ELSEWHERE' },
      { work_item_id: id(6), basis: 'own-work', withdrawn: false, withdrawn_reason: 'sent_elsewhere' },
      { work_item_id: id(7), basis: 'own-work', withdrawn: false, withdrawn_reason: null },
    ];
    const asked: string[] = [];
    const client = { query: jest.fn(async (sql: string) => {
      asked.push(sql);
      if (STEPS.test(sql)) throw noStepsReader();
      return { rows: STATES.test(sql) ? rows : [] };
    }) } as unknown as PoolClient;
    const states = await new PharmacyOwnWork(true).states(client, rows.map((row) => row.work_item_id), 'correlation', 'flag');
    expect(asked.find((sql) => STATES.test(sql))).toMatch(/select work_item_id::text as work_item_id, basis, withdrawn, withdrawn_reason/);
    // ORD-4's reader first, then 0133's in the same savepoint.
    expect(asked).toEqual(['savepoint pharmacy_own_work_states', expect.stringMatching(STEPS),
      'rollback to savepoint pharmacy_own_work_states', expect.stringMatching(STATES), 'release savepoint pharmacy_own_work_states']);
    expect([...states.entries()]).toEqual([
      [id(1), { basis: 'own-work', withdrawn: true, withdrawnReason: 'sent_elsewhere' }],
      [id(2), { basis: 'consent', withdrawn: true, withdrawnReason: 'changed' }],
      [id(3), { basis: 'own-work', withdrawn: true, withdrawnReason: 'changed' }],
      [id(4), { basis: 'own-work', withdrawn: true, withdrawnReason: 'changed' }],
      [id(5), { basis: 'own-work', withdrawn: true, withdrawnReason: 'changed' }],
      [id(6), { basis: 'own-work', withdrawn: false }],
      [id(7), { basis: 'own-work', withdrawn: false }]]);
  });

  it('records basis own-work in the audit details', () => {
    expect(basisDetails({ basis: 'own-work' })).toEqual({ basis: 'own-work' });
    expect(basisDetails({ basis: 'consent' })).toEqual({});
  });

  it('is provided on by the Pharmacy module and injected into the service and the access check', () => {
    const provider = (Reflect.getMetadata('providers', PharmacyModule) as unknown[]).find((entry) =>
      typeof entry === 'object' && entry !== null && (entry as { provide?: unknown }).provide === PharmacyOwnWork) as
      { useFactory: () => PharmacyOwnWork };
    expect(provider.useFactory().enabled).toBe(true);
    expect(OWN_WORK_OFF.enabled).toBe(false);
    expect((Reflect.getMetadata('design:paramtypes', PharmacyService) as unknown[])[7]).toBe(PharmacyOwnWork);
    expect((Reflect.getMetadata('design:paramtypes', PharmacyOrderRouteAccess) as unknown[])[1]).toBe(PharmacyOwnWork);
  });
});
