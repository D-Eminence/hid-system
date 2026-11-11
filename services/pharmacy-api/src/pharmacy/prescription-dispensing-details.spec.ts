import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import type { DataAccessContext } from '../common/request-context';
import { getEnvironment, resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { IdentityService } from '../identity/identity.service';
import { PharmacyModule } from './pharmacy.module';
import { PharmacyService, WORK_LIST_QUERY } from './pharmacy.service';
import { PharmacyOrderRouteAccess } from './order-route-access';
import { PharmacyOrderRouteCards } from './order-route-cards';
import { OWN_WORK_PATIENT_CARDS_OFF, PharmacyOwnWorkPatientCards } from './own-work-patient-cards';
import { inclusiveDays, PharmacyPrescriptionDetails, PRESCRIPTION_DETAILS_OFF,
  type PrescriptionDetailsRow } from './prescription-dispensing-details';

/*
 * The prescriber's priority, strength, form, duration and quantity to
 * dispense on this facility's own work (0122, owner decision 25 of
 * 2026-11-01, "all recommended except D5", items 3b and 4): behind
 * PRESCRIPTION_DISPENSING_DETAILS_ENABLED. Off, nothing is read and the
 * answers are exactly as before. On, own rows carry what
 * pharmacy.work_item_prescription_details gives, read in a savepoint, and a
 * duration from their dates when the prescription gave none; route-backed
 * rows get nothing; no audit row is added.
 */

const facilityId = '10000000-0000-4000-8000-000000000001';
const otherFacilityId = '10000000-0000-4000-8000-000000000002';
const accountId = '20000000-0000-4000-8000-000000000001';
const ngozi = '50000000-0000-4000-8000-000000000001';
const femi = '50000000-0000-4000-8000-000000000002';
const routeId = '80000000-0000-4000-8000-000000000001';
const id = (n: number) => `63000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reader: DataAccessContext = { correlationId: 'prescription-details-correlation', facilityId,
  membershipId: '40000000-0000-4000-8000-000000000001', purposeOfUse: 'direct-care', actor: { id: 'actor',
    subject: 'staff:pharmacist', accountId, roles: ['pharmacist'], permissions: ['pharmacy.work-item.read'],
    facilityIds: [facilityId], facilities: [], authenticationMethod: 'local' } };
/** node-postgres gives a date column as local midnight. */
const local = (date: string) => { const [y, m, d] = date.split('-').map(Number); return new Date(y!, m! - 1, d!); };

/** A work-list row: own work unless routed (then from another facility, on route `routeId`). */
const row = (n: number, patient: string, options: { routed?: boolean; startsOn?: string; endsOn?: string } = {}) => ({
  id: id(n), patient_id: patient, facility_id: facilityId,
  ordering_facility_id: options.routed ? otherFacilityId : facilityId,
  source_ehr_prescription_id: `30000000-0000-4000-8000-00000000000${n}`, source_ehr_prescription_version: '1',
  source_encounter_id: '70000000-0000-4000-8000-000000000001', source_status: 'active', status: 'accepted',
  medication_code_system: null, medication_code: null, medication_display: 'Amoxicillin 500 mg capsule',
  dose_quantity: '1', dose_unit: 'capsule', route_code: 'oral', frequency: 'Every 8 hours', instructions: 'After food',
  starts_on: options.startsOn ? local(options.startsOn) : null, ends_on: options.endsOn ? local(options.endsOn) : null,
  prescribed_by: accountId, prescribed_at: new Date(Date.UTC(2026, 10, 1, 9, n)),
  accepted_by: accountId, accepted_at: new Date(Date.UTC(2026, 10, 1, 9, n)), row_version: '1',
  created_at: new Date(Date.UTC(2026, 10, 1, 9, n)), dispensing_id: null, dispensing_status: null, reversal_id: null,
  order_route_id: options.routed ? routeId : null });

const DETAILS = /from pharmacy\.work_item_prescription_details\(\$1::uuid\[\]\)/;
const CARDS = /from pharmacy\.order_route_cards\(\$1::uuid\[\]\)/;

const none = { priority: null, medication_strength: null, medication_dose_form: null, duration_value: null,
  duration_unit: null, quantity_to_dispense: null, quantity_unit: null };
const found: Record<string, Omit<PrescriptionDetailsRow, 'work_item_id'>> = {
  [id(1)]: { priority: 'urgent', medication_strength: '500 mg', medication_dose_form: 'capsule', duration_value: 7,
    duration_unit: 'day', quantity_to_dispense: '21.0000', quantity_unit: 'capsule' },
  // Written before 0122, or without the details: nothing but its dates.
  [id(2)]: none,
  [id(5)]: { ...none, priority: 'stat', quantity_to_dispense: '100.5000', quantity_unit: 'mL' },
};

const rows = () => [row(1, ngozi, { startsOn: '2026-11-02', endsOn: '2026-11-04' }),
  row(2, femi, { startsOn: '2026-11-02', endsOn: '2026-11-08' }), row(3, femi),
  row(4, ngozi, { routed: true, startsOn: '2026-11-02', endsOn: '2026-11-08' }), row(5, ngozi, { startsOn: '2026-11-02' })];

const harness = (options: { enabled?: boolean; detailsError?: Error } = {}) => {
  const list = rows();
  const statements: { sql: string; values: unknown[] }[] = [];
  const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    if (sql === WORK_LIST_QUERY) return { rows: list };
    if (/where w\.id=\$1/.test(sql)) return { rows: list.filter((r) => r.id === values[0]) };
    if (/from pharmacy\.order_route_access_for/.test(sql)) {
      return { rows: [{ outcome: 'none', route_id: null, work_item_id: null }] };
    }
    if (CARDS.test(sql)) {
      return { rows: (values[0] as string[]).filter((item) => item === id(4)).map((item) => ({ work_item_id: item,
        route_id: routeId, reference: 'RX-4', effective_state: 'accepted', access: 'work', ordering_facility_name: 'Annex',
        orderer_name: 'Dr Annex', orderer_licence_body: null, orderer_licence_number: null,
        patient_full_name: 'Ngozi Details', patient_sex: 'female', patient_date_of_birth: '1990-04-05',
        patient_health_id_last4: 'AAA2', row_version: '3', ended_kind: null })) };
    }
    if (DETAILS.test(sql)) {
      if (options.detailsError) throw options.detailsError;
      return { rows: (values[0] as string[]).filter((item) => found[item]).map((item) => ({ work_item_id: item, ...found[item] })) };
    }
    return { rows: [] };
  }) } as unknown as PoolClient;
  const database = { withTransaction: async <T>(_c: DataAccessContext, fn: (c: PoolClient) => Promise<T>) => fn(client),
    query: jest.fn(async () => ({ rows: [{ orders: false, work: false }] })) } as unknown as DatabaseService;
  const identity = { authorize: jest.fn().mockResolvedValue({ allowed: true, breakGlass: false }) } as unknown as IdentityService;
  const audit = { recordWithClient: jest.fn(async () => undefined) };
  const details = options.enabled === undefined ? undefined : new PharmacyPrescriptionDetails(options.enabled);
  const args = [database, identity, audit as unknown as AuditService, new PharmacyOrderRouteAccess(identity),
    new PharmacyOrderRouteCards(database)] as const;
  const service = details ? new PharmacyService(...args, OWN_WORK_PATIENT_CARDS_OFF, details) : new PharmacyService(...args);
  const audited = () => audit.recordWithClient.mock.calls.map((call) => (call as unknown[]).slice(2));
  return { service, statements, audited };
};

const ITEM_KEYS = ['id', 'patientId', 'facilityId', 'sourceEhrPrescriptionId', 'sourceEncounterId',
  'sourceEhrPrescriptionVersion', 'status', 'medication', 'doseQuantity', 'doseUnit', 'routeCode', 'frequency',
  'instructions', 'acceptedAt', 'version', 'dispensing'];
const ROUTED_KEYS = ['id', 'patientId', 'facilityId', 'sourceEhrPrescriptionVersion', 'status', 'orderRoute', 'patient',
  'medication', 'doseQuantity', 'doseUnit', 'routeCode', 'frequency', 'instructions', 'acceptedAt', 'version', 'dispensing'];

describe('prescription details on own work: off (the default)', () => {
  it.each([['no setting passed (every existing caller)', undefined], ['PRESCRIPTION_DISPENSING_DETAILS_ENABLED=false', false]])(
    'with %s, the list and the work item read nothing new and answer exactly as before', async (_label, enabled) => {
      const { service, statements } = harness({ enabled });
      const page = await service.listWorkItems(reader);
      expect(statements.some(({ sql }) => DETAILS.test(sql) || /pharmacy_prescription_details/.test(sql))).toBe(false);
      expect(page.items.map((item) => Object.keys(item))).toEqual([ITEM_KEYS, ITEM_KEYS, ITEM_KEYS, ROUTED_KEYS, ITEM_KEYS]);
      expect(page.items.map((item) => Object.keys(item.medication))).toEqual(Array(5).fill(['codeSystem', 'code', 'display']));
      const item = await service.getWorkItem(reader, id(1));
      expect(Object.keys(item)).toEqual(ITEM_KEYS);
      expect(statements.some(({ sql }) => DETAILS.test(sql))).toBe(false);
    });

  it('is the shared off instance, and reads and adds nothing', async () => {
    expect(PRESCRIPTION_DETAILS_OFF.enabled).toBe(false);
    const client = { query: jest.fn() } as unknown as PoolClient;
    expect((await PRESCRIPTION_DETAILS_OFF.details(client, [id(1)], 'c')).size).toBe(0);
    expect(client.query).not.toHaveBeenCalled();
    expect(PRESCRIPTION_DETAILS_OFF.forRow(row(1, ngozi, { startsOn: '2026-11-02', endsOn: '2026-11-04' }), undefined))
      .toBeUndefined();
  });
});

describe('prescription details on own work: on', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('merges the accepted version\'s values into own rows, with the dates as a fallback duration', async () => {
    const { service, statements } = harness({ enabled: true });
    const page = await service.listWorkItems(reader);
    expect(statements.filter(({ sql }) => DETAILS.test(sql)).map(({ values }) => values))
      .toEqual([[[id(1), id(2), id(3), id(5)]]]);
    const sqls = statements.map(({ sql }) => sql);
    const at = sqls.findIndex((sql) => DETAILS.test(sql));
    expect(sqls[at - 1]).toBe('savepoint pharmacy_prescription_details');
    expect(sqls[at + 1]).toBe('release savepoint pharmacy_prescription_details');
    const [one, two, three, four, five] = page.items as Record<string, unknown>[];
    // The prescriber's values; its own 7-day duration wins over its dates (3 days).
    expect(one).toMatchObject({ medication: { codeSystem: null, code: null, display: 'Amoxicillin 500 mg capsule',
      strength: '500 mg', doseForm: 'capsule' }, priority: 'urgent', duration: { value: 7, unit: 'day' },
      quantityToDispense: 21, quantityUnit: 'capsule' });
    expect(Object.keys(one!)).toEqual([...ITEM_KEYS, 'priority', 'duration', 'quantityToDispense', 'quantityUnit']);
    expect(Object.keys(one!.medication as object)).toEqual(['codeSystem', 'code', 'display', 'strength', 'doseForm']);
    // No details given: only the duration from its dates, 2 to 8 November inclusive.
    expect(Object.keys(two!)).toEqual([...ITEM_KEYS, 'duration']);
    expect(two!.duration).toEqual({ value: 7, unit: 'day' });
    expect(Object.keys(two!.medication as object)).toEqual(['codeSystem', 'code', 'display']);
    // No reader row and no dates: exactly as before.
    expect(Object.keys(three!)).toEqual(ITEM_KEYS);
    // Route-backed: nothing, though it has dates (item 4b).
    expect(Object.keys(four!)).toEqual(ROUTED_KEYS);
    // A start date only: no duration; the quantity with its unit.
    expect(Object.keys(five!)).toEqual([...ITEM_KEYS, 'priority', 'quantityToDispense', 'quantityUnit']);
    expect(five).toMatchObject({ priority: 'stat', quantityToDispense: 100.5, quantityUnit: 'mL' });
  });

  it('writes exactly the audit rows it writes while off', async () => {
    const off = harness({ enabled: false });
    await off.service.listWorkItems(reader);
    await off.service.getWorkItem(reader, id(1));
    const on = harness({ enabled: true });
    await on.service.listWorkItems(reader);
    await on.service.getWorkItem(reader, id(1));
    expect(on.audited()).toEqual(off.audited());
  });

  it('answers the rows without the reader\'s values when it fails', async () => {
    const failure = Object.assign(new Error('function pharmacy.work_item_prescription_details(uuid[]) does not exist'),
      { code: '42883' });
    const { service, statements } = harness({ enabled: true, detailsError: failure });
    const page = await service.listWorkItems(reader);
    const sqls = statements.map(({ sql }) => sql);
    expect(sqls).toContain('rollback to savepoint pharmacy_prescription_details');
    expect(sqls).not.toContain('release savepoint pharmacy_prescription_details');
    expect(page.items.map((item) => Object.keys(item).slice(ITEM_KEYS.length))).toEqual([['duration'], ['duration'], [],
      [], []]);
    expect(Logger.prototype.warn).toHaveBeenCalledWith({ message: 'Prescription details on own work could not be read',
      sqlState: '42883', correlationId: reader.correlationId });
  });

  it('gives a single own work item its details, and reads none for a routed one', async () => {
    const { service, statements } = harness({ enabled: true });
    expect(await service.getWorkItem(reader, id(1))).toMatchObject({ priority: 'urgent', duration: { value: 7, unit: 'day' } });
    expect(statements.filter(({ sql }) => DETAILS.test(sql)).map(({ values }) => values)).toEqual([[[id(1)]]]);
    const routed = await service.getWorkItem(reader, id(4));
    expect(Object.keys(routed)).toEqual(ROUTED_KEYS);
    expect(statements.filter(({ sql }) => DETAILS.test(sql))).toHaveLength(1);
  });

  it('reads at most 200 ids a statement', async () => {
    const batches: unknown[][] = [];
    const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
      if (DETAILS.test(sql)) batches.push(values[0] as unknown[]);
      return { rows: [] };
    }) } as unknown as PoolClient;
    await new PharmacyPrescriptionDetails(true).details(client, Array.from({ length: 201 }, (_, n) => id(n)), 'c');
    expect(batches.map((batch) => batch.length)).toEqual([200, 1]);
  });

  it('takes a duration only with both its value and unit, else the dates', () => {
    const details = new PharmacyPrescriptionDetails(true);
    const dated = row(1, ngozi, { startsOn: '2026-11-30', endsOn: '2026-12-01' });
    expect(details.forRow(dated, { work_item_id: id(1), ...none, duration_value: 3, duration_unit: null }))
      .toEqual({ duration: { value: 2, unit: 'day' } });
    expect(details.forRow(row(1, ngozi), { work_item_id: id(1), ...none, quantity_to_dispense: '5.0000' })).toEqual({});
    expect(details.forRow({ ...dated, starts_on: '2026-11-30', ends_on: '2026-11-30' } as never, undefined))
      .toEqual({ duration: { value: 1, unit: 'day' } });
  });
});

describe('inclusiveDays', () => {
  it.each([
    ['2026-11-02', '2026-11-08', 7], ['2026-11-02', '2026-11-02', 1], ['2026-02-28', '2026-03-01', 2],
    ['2026-03-28', '2026-03-30', 3], ['2026-11-08', '2026-11-02', null], [null, '2026-11-02', null],
    ['2026-11-02', null, null], ['2026-11-02T00:00:00Z', '2026-11-08', null],
  ])('%s to %s is %p', (start, end, days) => {
    expect(inclusiveDays(start, end)).toBe(days);
  });
});

describe('PRESCRIPTION_DISPENSING_DETAILS_ENABLED', () => {
  const original = { ...process.env };
  const base = { NODE_ENV: 'test', PHARMACY_DATABASE_URL: 'postgresql://pharmacy:test@localhost:5432/hid',
    DATABASE_SSL: 'false', CORS_ORIGINS: 'http://localhost:3000', PHARMACY_INTERNAL_SERVICE_TOKEN: 'z'.repeat(32) };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });
  const provider = () => (Reflect.getMetadata('providers', PharmacyModule) as unknown[]).find((entry) =>
    typeof entry === 'object' && entry !== null && (entry as { provide?: unknown }).provide === PharmacyPrescriptionDetails) as
    { useFactory: () => PharmacyPrescriptionDetails };

  it('is off unless set to true, and PharmacyModule gives the service a reader that follows it', () => {
    Object.assign(process.env, base);
    delete process.env.PRESCRIPTION_DISPENSING_DETAILS_ENABLED;
    resetEnvironmentForTests();
    expect(getEnvironment().PRESCRIPTION_DISPENSING_DETAILS_ENABLED).toBe(false);
    expect(provider().useFactory().enabled).toBe(false);
    process.env.PRESCRIPTION_DISPENSING_DETAILS_ENABLED = 'true';
    resetEnvironmentForTests();
    expect(getEnvironment().PRESCRIPTION_DISPENSING_DETAILS_ENABLED).toBe(true);
    expect(provider().useFactory().enabled).toBe(true);
    expect((Reflect.getMetadata('design:paramtypes', PharmacyService) as unknown[])[6]).toBe(PharmacyPrescriptionDetails);
  });

  it('is what Nest injects into the service', async () => {
    const details = new PharmacyPrescriptionDetails(true);
    const moduleRef = await Test.createTestingModule({ providers: [PharmacyService,
      { provide: DatabaseService, useValue: {} }, { provide: IdentityService, useValue: {} },
      { provide: AuditService, useValue: {} }, { provide: PharmacyOrderRouteAccess, useValue: {} },
      { provide: PharmacyOrderRouteCards, useValue: {} },
      { provide: PharmacyOwnWorkPatientCards, useValue: OWN_WORK_PATIENT_CARDS_OFF },
      { provide: PharmacyPrescriptionDetails, useValue: details }] }).compile();
    expect((moduleRef.get(PharmacyService) as unknown as { prescriptionDetails: unknown }).prescriptionDetails).toBe(details);
  });

  it('refuses any value but true or false', () => {
    Object.assign(process.env, base, { PRESCRIPTION_DISPENSING_DETAILS_ENABLED: 'on' });
    resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/PRESCRIPTION_DISPENSING_DETAILS_ENABLED/);
  });
});
