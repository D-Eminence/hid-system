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
import { PharmacyPrescriptionDetails, PRESCRIPTION_DETAILS_OFF } from './prescription-dispensing-details';

/*
 * The patient on this facility's own work (0113, owner decision 25 of
 * 2026-11-01, "all recommended except D5"): behind OWN_WORK_PATIENT_CARD_ENABLED.
 * Off, nothing is read and the answers and audit rows are exactly as before.
 * On, own rows carry the patient pharmacy.work_item_patient_cards gives, read
 * in a savepoint; the list keeps its collection row and adds one
 * pharmacy.work-item.list row per patient shown (basis 'consent'); a single
 * work item's read row already names it.
 */

const facilityId = '10000000-0000-4000-8000-000000000001';
const otherFacilityId = '10000000-0000-4000-8000-000000000002';
const accountId = '20000000-0000-4000-8000-000000000001';
const amaka = '50000000-0000-4000-8000-000000000001';
const bode = '50000000-0000-4000-8000-000000000002';
const chidi = '50000000-0000-4000-8000-000000000003';
const routeId = '80000000-0000-4000-8000-000000000001';
const id = (n: number) => `62000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reader: DataAccessContext = { correlationId: 'own-work-cards-correlation', facilityId,
  membershipId: '40000000-0000-4000-8000-000000000001', purposeOfUse: 'direct-care', actor: { id: 'actor',
    subject: 'staff:pharmacist', accountId, roles: ['pharmacist'], permissions: ['pharmacy.work-item.read'],
    facilityIds: [facilityId], facilities: [], authenticationMethod: 'local' } };

/** A work-list row: own work unless routed (then from another facility, on route `routeId`). */
const row = (n: number, patient: string, routed = false) => ({ id: id(n), patient_id: patient, facility_id: facilityId,
  ordering_facility_id: routed ? otherFacilityId : facilityId,
  source_ehr_prescription_id: `30000000-0000-4000-8000-00000000000${n}`, source_ehr_prescription_version: '1',
  source_encounter_id: '70000000-0000-4000-8000-000000000001', source_status: 'active', status: 'accepted',
  medication_code_system: null, medication_code: null, medication_display: 'Amoxicillin 500 mg capsule',
  dose_quantity: '1', dose_unit: 'capsule', route_code: 'oral', frequency: 'Every 8 hours', instructions: 'After food',
  starts_on: null, ends_on: null, prescribed_by: accountId, prescribed_at: new Date(Date.UTC(2026, 10, 1, 9, n)),
  accepted_by: accountId, accepted_at: new Date(Date.UTC(2026, 10, 1, 9, n)), row_version: '1',
  created_at: new Date(Date.UTC(2026, 10, 1, 9, n)), dispensing_id: null, dispensing_status: null, reversal_id: null,
  order_route_id: routed ? routeId : null });

const OWN = /from pharmacy\.work_item_patient_cards\(\$1::uuid\[\]\)/;
const CARDS = /from pharmacy\.order_route_cards\(\$1::uuid\[\]\)/;

const ownCards: Record<string, { patient_full_name: string; patient_sex: string | null;
  patient_date_of_birth: string | null; patient_health_id_last4: string }> = {
  [id(1)]: { patient_full_name: 'Amaka Card', patient_sex: 'female', patient_date_of_birth: '1991-02-03',
    patient_health_id_last4: 'AAA2' },
  [id(2)]: { patient_full_name: 'Bode Card', patient_sex: null, patient_date_of_birth: null, patient_health_id_last4: 'XYZ7' },
  [id(5)]: { patient_full_name: 'Amaka Card', patient_sex: 'female', patient_date_of_birth: '1991-02-03',
    patient_health_id_last4: 'AAA2' },
};

const harness = (options: { enabled?: boolean; rows?: ReturnType<typeof row>[]; ownError?: Error } = {}) => {
  const rows = options.rows ?? [row(1, amaka), row(2, bode), row(3, chidi), row(4, amaka, true), row(5, amaka)];
  const statements: { sql: string; values: unknown[] }[] = [];
  const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    if (sql === WORK_LIST_QUERY) return { rows };
    if (/where w\.id=\$1/.test(sql)) return { rows: rows.filter((r) => r.id === values[0]) };
    if (/from pharmacy\.order_route_access_for/.test(sql)) {
      return { rows: [{ outcome: 'none', route_id: null, work_item_id: null }] };
    }
    if (CARDS.test(sql)) {
      return { rows: (values[0] as string[]).filter((item) => item === id(4)).map((item) => ({ work_item_id: item,
        route_id: routeId, reference: 'RX-4', effective_state: 'accepted', access: 'work', ordering_facility_name: 'Annex',
        orderer_name: 'Dr Annex', orderer_licence_body: null, orderer_licence_number: null,
        patient_full_name: 'Amaka Card', patient_sex: 'female', patient_date_of_birth: '1991-02-03',
        patient_health_id_last4: 'AAA2', row_version: '3', ended_kind: null })) };
    }
    if (OWN.test(sql)) {
      if (options.ownError) throw options.ownError;
      return { rows: (values[0] as string[]).filter((item) => ownCards[item])
        .map((item) => ({ work_item_id: item, ...ownCards[item] })) };
    }
    return { rows: [] };
  }) } as unknown as PoolClient;
  const database = { withTransaction: async <T>(_c: DataAccessContext, fn: (c: PoolClient) => Promise<T>) => fn(client),
    query: jest.fn(async () => ({ rows: [{ orders: false, work: false }] })) } as unknown as DatabaseService;
  const identity = { authorize: jest.fn().mockResolvedValue({ allowed: true, breakGlass: false }) } as unknown as IdentityService;
  const audit = { recordWithClient: jest.fn(async (_client: PoolClient, _context: DataAccessContext, action: string,
    _resource?: unknown, _details?: unknown) => {
    statements.push({ sql: `audit ${action}`, values: [] });
  }) };
  const own = options.enabled === undefined ? undefined : new PharmacyOwnWorkPatientCards(options.enabled);
  const service = own
    ? new PharmacyService(database, identity, audit as unknown as AuditService, new PharmacyOrderRouteAccess(identity),
      new PharmacyOrderRouteCards(database), own)
    : new PharmacyService(database, identity, audit as unknown as AuditService, new PharmacyOrderRouteAccess(identity),
      new PharmacyOrderRouteCards(database));
  const audited = () => audit.recordWithClient.mock.calls.map(([, , action, resource, details]) => ({ action,
    ...(resource as unknown as { patientId?: string; resourceType: string; resourceId: string }),
    details: details as unknown as Record<string, unknown> | undefined }));
  return { service, statements, audited };
};

const ITEM_KEYS = ['id', 'patientId', 'facilityId', 'sourceEhrPrescriptionId', 'sourceEncounterId',
  'sourceEhrPrescriptionVersion', 'status', 'medication', 'doseQuantity', 'doseUnit', 'routeCode', 'frequency',
  'instructions', 'acceptedAt', 'version', 'dispensing'];

describe('own-work patient cards: off (the default)', () => {
  it.each([['no setting passed (every existing caller)', undefined], ['OWN_WORK_PATIENT_CARD_ENABLED=false', false]])(
    'with %s, the list and the work item read nothing new and answer exactly as before', async (_label, enabled) => {
      const { service, statements, audited } = harness({ enabled });
      const page = await service.listWorkItems(reader);
      expect(statements.some(({ sql }) => OWN.test(sql))).toBe(false);
      expect(statements.some(({ sql }) => /pharmacy_own_work_patient_cards/.test(sql))).toBe(false);
      expect(page.items.map((item) => [item.id, 'patient' in item])).toEqual([[id(1), false], [id(2), false],
        [id(3), false], [id(4), true], [id(5), false]]);
      expect(Object.keys(page.items[0]!)).toEqual(ITEM_KEYS);
      // The collection row and the routed row's patient, as before.
      expect(audited().map((event) => [event.action, event.patientId ?? null, event.resourceType, event.details])).toEqual([
        ['pharmacy.work-item.list', null, 'pharmacy-work-item-collection', { returnedCount: 5 }],
        ['pharmacy.work-item.list', amaka, 'pharmacy-work-item',
          { basis: 'order-route', workItemIds: [id(4)], orderRouteIds: [routeId] }]]);
      const item = await service.getWorkItem(reader, id(1));
      expect('patient' in item).toBe(false);
      expect(Object.keys(item)).toEqual(ITEM_KEYS);
      expect(statements.some(({ sql }) => OWN.test(sql))).toBe(false);
    });

  it('is the shared off instance', () => {
    expect(OWN_WORK_PATIENT_CARDS_OFF.enabled).toBe(false);
  });
});

describe('own-work patient cards: on', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('attaches the patient to own rows the reader answers, only them, and audits each patient shown once', async () => {
    const { service, statements, audited } = harness({ enabled: true });
    const page = await service.listWorkItems(reader);
    const own = statements.filter(({ sql }) => OWN.test(sql));
    expect(own.map(({ values }) => values)).toEqual([[[id(1), id(2), id(3), id(5)]]]);
    const sqls = statements.map(({ sql }) => sql);
    const at = sqls.findIndex((sql) => OWN.test(sql));
    expect(sqls[at - 1]).toBe('savepoint pharmacy_own_work_patient_cards');
    expect(sqls[at + 1]).toBe('release savepoint pharmacy_own_work_patient_cards');
    expect(page.items.map((item) => [item.id, item.patient ?? null])).toEqual([
      [id(1), { fullName: 'Amaka Card', sex: 'female', dateOfBirth: '1991-02-03', healthIdLast4: 'AAA2' }],
      [id(2), { fullName: 'Bode Card', sex: null, dateOfBirth: null, healthIdLast4: 'XYZ7' }],
      [id(3), null],
      [id(4), { fullName: 'Amaka Card', sex: 'female', dateOfBirth: '1991-02-03', healthIdLast4: 'AAA2' }],
      [id(5), { fullName: 'Amaka Card', sex: 'female', dateOfBirth: '1991-02-03', healthIdLast4: 'AAA2' }]]);
    // An own row keeps its prescription and encounter ids and gains only `patient`, after `status` (where a
    // route-backed row's card goes); the routed row still has neither id (PRIV P4.3).
    expect(Object.keys(page.items[0]!)).toEqual([...ITEM_KEYS.slice(0, 7), 'patient', ...ITEM_KEYS.slice(7)]);
    expect(Object.keys(page.items[2]!)).toEqual(ITEM_KEYS);
    expect('sourceEhrPrescriptionId' in page.items[3]!).toBe(false);
    expect(audited().map((event) => [event.action, event.patientId ?? null, event.resourceId, event.details])).toEqual([
      ['pharmacy.work-item.list', null, facilityId, { returnedCount: 5 }],
      ['pharmacy.work-item.list', amaka, id(4), { basis: 'order-route', workItemIds: [id(4)], orderRouteIds: [routeId] }],
      ['pharmacy.work-item.list', amaka, id(1), { basis: 'consent', workItemIds: [id(1), id(5)] }],
      ['pharmacy.work-item.list', bode, id(2), { basis: 'consent', workItemIds: [id(2)] }]]);
    expect(JSON.stringify(audited())).not.toMatch(/Amaka|Bode|AAA2|XYZ7|1991/);
  });

  it('answers the rows without a patient when the reader fails, and audits none of them', async () => {
    const failure = Object.assign(new Error('permission denied for function work_item_patient_cards'), { code: '42501' });
    const { service, statements, audited } = harness({ enabled: true, ownError: failure });
    const page = await service.listWorkItems(reader);
    const sqls = statements.map(({ sql }) => sql);
    expect(sqls).toContain('rollback to savepoint pharmacy_own_work_patient_cards');
    expect(sqls).not.toContain('release savepoint pharmacy_own_work_patient_cards');
    expect(page.items.filter((item) => item.patient).map((item) => item.id)).toEqual([id(4)]);
    expect(audited().map((event) => event.details?.basis ?? 'collection')).toEqual(['collection', 'order-route']);
    expect(Logger.prototype.warn).toHaveBeenCalledWith({ message: 'Patients on own work could not be read',
      sqlState: '42501', correlationId: reader.correlationId });
  });

  it('reads no patient when the page has no own rows', async () => {
    const { service, statements } = harness({ enabled: true, rows: [row(4, amaka, true)] });
    await service.listWorkItems(reader);
    expect(statements.some(({ sql }) => OWN.test(sql) || /pharmacy_own_work_patient_cards/.test(sql))).toBe(false);
  });

  it('gives a single own work item its patient after the read row, which names the patient', async () => {
    const { service, statements, audited } = harness({ enabled: true });
    const item = await service.getWorkItem(reader, id(2));
    expect(item.patient).toEqual({ fullName: 'Bode Card', sex: null, dateOfBirth: null, healthIdLast4: 'XYZ7' });
    const sqls = statements.map(({ sql }) => sql);
    expect(sqls.indexOf('audit pharmacy.work-item.read')).toBeLessThan(sqls.findIndex((sql) => OWN.test(sql)));
    expect(audited().map((event) => [event.action, event.patientId])).toEqual([['pharmacy.work-item.read', bode]]);
  });

  it('leaves a single own work item without a patient the reader does not give', async () => {
    const { service } = harness({ enabled: true });
    expect('patient' in (await service.getWorkItem(reader, id(3)))).toBe(false);
  });

  it('reads a routed work item\'s patient from its route card only', async () => {
    const { service, statements } = harness({ enabled: true });
    const item = await service.getWorkItem(reader, id(4));
    expect(item.patient).toMatchObject({ fullName: 'Amaka Card' });
    expect(statements.some(({ sql }) => OWN.test(sql))).toBe(false);
  });

  it('reads at most 200 ids a statement', async () => {
    const batches: unknown[][] = [];
    const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
      if (OWN.test(sql)) batches.push(values[0] as unknown[]);
      return { rows: [] };
    }) } as unknown as PoolClient;
    await new PharmacyOwnWorkPatientCards(true).patients(client, Array.from({ length: 201 }, (_, n) => id(n)), 'c');
    expect(batches.map((batch) => batch.length)).toEqual([200, 1]);
  });
});

describe('OWN_WORK_PATIENT_CARD_ENABLED', () => {
  const original = { ...process.env };
  const base = { NODE_ENV: 'test', PHARMACY_DATABASE_URL: 'postgresql://pharmacy:test@localhost:5432/hid',
    DATABASE_SSL: 'false', CORS_ORIGINS: 'http://localhost:3000', PHARMACY_INTERNAL_SERVICE_TOKEN: 'z'.repeat(32) };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });
  const provider = () => (Reflect.getMetadata('providers', PharmacyModule) as unknown[]).find((entry) =>
    typeof entry === 'object' && entry !== null && (entry as { provide?: unknown }).provide === PharmacyOwnWorkPatientCards) as
    { useFactory: () => PharmacyOwnWorkPatientCards };

  it('is off unless set to true, and PharmacyModule gives the service a reader that follows it', () => {
    Object.assign(process.env, base);
    delete process.env.OWN_WORK_PATIENT_CARD_ENABLED;
    resetEnvironmentForTests();
    expect(getEnvironment().OWN_WORK_PATIENT_CARD_ENABLED).toBe(false);
    expect(provider().useFactory().enabled).toBe(false);
    process.env.OWN_WORK_PATIENT_CARD_ENABLED = 'true';
    resetEnvironmentForTests();
    expect(getEnvironment().OWN_WORK_PATIENT_CARD_ENABLED).toBe(true);
    expect(provider().useFactory().enabled).toBe(true);
    expect((Reflect.getMetadata('design:paramtypes', PharmacyService) as unknown[])[5]).toBe(PharmacyOwnWorkPatientCards);
  });

  it('is what Nest injects into the service', async () => {
    const reader = new PharmacyOwnWorkPatientCards(true);
    const moduleRef = await Test.createTestingModule({ providers: [PharmacyService,
      { provide: DatabaseService, useValue: {} }, { provide: IdentityService, useValue: {} },
      { provide: AuditService, useValue: {} }, { provide: PharmacyOrderRouteAccess, useValue: {} },
      { provide: PharmacyOrderRouteCards, useValue: {} }, { provide: PharmacyOwnWorkPatientCards, useValue: reader },
      // 0114's reader, which the service takes after this one.
      { provide: PharmacyPrescriptionDetails, useValue: PRESCRIPTION_DETAILS_OFF }] }).compile();
    expect((moduleRef.get(PharmacyService) as unknown as { ownPatients: unknown }).ownPatients).toBe(reader);
  });

  it('refuses any value but true or false', () => {
    Object.assign(process.env, base, { OWN_WORK_PATIENT_CARD_ENABLED: '1' });
    resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/OWN_WORK_PATIENT_CARD_ENABLED/);
  });
});
