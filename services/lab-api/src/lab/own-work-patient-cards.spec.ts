import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import type { DataAccessContext } from '../common/request-context';
import { getEnvironment, resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { IdentityService } from '../identity/identity.service';
import { LabModule } from './lab.module';
import { LabWorkItemsService, WORK_LIST_QUERY } from './lab-work-items.service';
import { LabOrderRouteAccess } from './order-route-access';
import { LabOrderRouteCards } from './order-route-cards';
import { LabOwnWorkPatientCards, OWN_WORK_PATIENT_CARDS_OFF } from './own-work-patient-cards';

/*
 * The patient on this facility's own work (0121, owner decision 25 of
 * 2026-11-01, "all recommended except D5"): behind OWN_WORK_PATIENT_CARD_ENABLED.
 * Off, nothing is read and the answers and audit rows are exactly as before.
 * On, own rows carry the patient lab.work_item_patient_cards gives, read in a
 * savepoint, and each patient shown on the list gets one lab.work-item.list
 * row (basis 'consent'); a single work item's read row already names it.
 */

const facilityId = '10000000-0000-4000-8000-000000000001';
const otherFacilityId = '10000000-0000-4000-8000-000000000002';
const accountId = '20000000-0000-4000-8000-000000000001';
const amaka = '50000000-0000-4000-8000-000000000001';
const bode = '50000000-0000-4000-8000-000000000002';
const chidi = '50000000-0000-4000-8000-000000000003';
const routeId = '80000000-0000-4000-8000-000000000001';
const id = (n: number) => `61000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reader = { correlationId: 'own-work-cards-correlation', facilityId,
  membershipId: '40000000-0000-4000-8000-000000000001', purposeOfUse: 'direct-care', actor: { id: 'actor',
    subject: 'staff:lab', accountId, roles: ['lab'], permissions: ['lab.work-item.read'], facilityIds: [facilityId],
    facilities: [], authenticationMethod: 'local' } } satisfies DataAccessContext;

/** A work-list row: own work unless routed (then from another facility, on route `routeId`). */
const row = (n: number, patient: string, routed = false) => ({ id: id(n), patient_id: patient, facility_id: facilityId,
  ordering_facility_id: routed ? otherFacilityId : facilityId, source_ehr_order_id: `30000000-0000-4000-8000-00000000000${n}`,
  source_ehr_order_version: '1', source_encounter_id: '70000000-0000-4000-8000-000000000001', status: 'accepted',
  priority: 'routine', accepted_by: accountId, accepted_at: new Date(Date.UTC(2026, 10, 1, 9, n)), row_version: '1',
  created_at: new Date(Date.UTC(2026, 10, 1, 9, n)), order_route_id: routed ? routeId : null, test_name: `Test ${n}`,
  accession_id: null, accession_number: null, specimen_statuses: null });

const OWN = /from lab\.work_item_patient_cards\(\$1::uuid\[\]\)/;
const CARDS = /from lab\.order_route_cards\(\$1::uuid\[\]\)/;
const RECEIVES = 'select lab.order_route_receives_here() as receives, lab.order_routes_here() as routes_here';

/** What lab.work_item_patient_cards answers for the ids it is given (here: Amaka's and Bode's own rows only). */
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
    if (/from lab\.work_items where id=\$1/.test(sql)) return { rows: rows.filter((r) => r.id === values[0]) };
    if (/from lab\.order_route_access_for/.test(sql)) return { rows: [{ outcome: 'none', route_id: null, work_item_id: null }] };
    if (CARDS.test(sql)) {
      return { rows: (values[0] as string[]).filter((item) => item === id(4)).map((item) => ({ work_item_id: item,
        route_id: routeId, reference: 'LAB-4', effective_state: 'accepted', access: 'work', ordering_facility_name: 'Annex',
        orderer_name: 'Dr Annex', orderer_licence_body: null, orderer_licence_number: null,
        patient_full_name: 'Amaka Card', patient_sex: 'female', patient_date_of_birth: '1991-02-03',
        patient_health_id_last4: 'AAA2', row_version: '3', ended_kind: null })) };
    }
    if (OWN.test(sql)) {
      if (options.ownError) throw options.ownError;
      return { rows: (values[0] as string[]).filter((item) => ownCards[item])
        .map((item) => ({ work_item_id: item, ...ownCards[item] })) };
    }
    if (sql === RECEIVES) return { rows: [{ receives: null, routes_here: null }] };
    return { rows: [] };
  }) } as unknown as PoolClient;
  const database = { withTransaction: async <T>(_c: DataAccessContext, fn: (c: PoolClient) => Promise<T>) => fn(client),
    query: jest.fn(async () => ({ rows: [{ orders: false, work: false }] })) } as unknown as DatabaseService;
  const identity = { authorize: jest.fn().mockResolvedValue({ allowed: true, breakGlass: false }) } as unknown as IdentityService;
  const audit = { recordWithClient: jest.fn(async (_client: PoolClient, event: { action: string }) => {
    statements.push({ sql: `audit ${event.action}`, values: [] });
  }) };
  const own = options.enabled === undefined ? undefined : new LabOwnWorkPatientCards(options.enabled);
  const service = own
    ? new LabWorkItemsService(database, identity, audit as unknown as AuditService, new LabOrderRouteAccess(identity),
      new LabOrderRouteCards(database), own)
    : new LabWorkItemsService(database, identity, audit as unknown as AuditService, new LabOrderRouteAccess(identity),
      new LabOrderRouteCards(database));
  const audited = () => audit.recordWithClient.mock.calls.map(([, event]) => event as unknown as {
    action: string; patientId: string; resourceId: string; details?: Record<string, unknown> });
  return { service, statements, audited };
};

describe('own-work patient cards: off (the default)', () => {
  it.each([['no setting passed (every existing caller)', undefined], ['OWN_WORK_PATIENT_CARD_ENABLED=false', false]])(
    'with %s, the list and the work item read nothing new and answer exactly as before', async (_label, enabled) => {
      const { service, statements, audited } = harness({ enabled });
      const page = await service.list(reader);
      expect(statements.some(({ sql }) => OWN.test(sql))).toBe(false);
      expect(statements.some(({ sql }) => /savepoint lab_own_work_patient_cards/.test(sql))).toBe(false);
      // Own rows: no patient; the routed row keeps its card's patient (C12), as before.
      expect(page.items.map((item) => [item.id, 'patient' in item])).toEqual([[id(1), false], [id(2), false],
        [id(3), false], [id(4), true], [id(5), false]]);
      expect(Object.keys(page.items[0]!)).toEqual(['id', 'patientId', 'facilityId', 'sourceEhrOrderVersion', 'status',
        'priority', 'acceptedAt', 'version', 'sourceEhrOrderId', 'testName', 'accessionId', 'accessionNumber',
        'specimenStatuses']);
      // Only the routed row's patient is audited, as before.
      expect(audited().map((event) => [event.action, event.patientId, event.details])).toEqual([
        ['lab.work-item.list', amaka, { basis: 'order-route', workItemIds: [id(4)], orderRouteIds: [routeId] }]]);
      const item = await service.get(reader, id(1));
      expect('patient' in item).toBe(false);
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
    const page = await service.list(reader);
    // One reader statement, for the own rows only, in its savepoint.
    const own = statements.filter(({ sql }) => OWN.test(sql));
    expect(own.map(({ values }) => values)).toEqual([[[id(1), id(2), id(3), id(5)]]]);
    const sqls = statements.map(({ sql }) => sql);
    const at = sqls.findIndex((sql) => OWN.test(sql));
    expect(sqls[at - 1]).toBe('savepoint lab_own_work_patient_cards');
    expect(sqls[at + 1]).toBe('release savepoint lab_own_work_patient_cards');
    expect(page.items.map((item) => [item.id, item.patient ?? null])).toEqual([
      [id(1), { fullName: 'Amaka Card', sex: 'female', dateOfBirth: '1991-02-03', healthIdLast4: 'AAA2' }],
      [id(2), { fullName: 'Bode Card', sex: null, dateOfBirth: null, healthIdLast4: 'XYZ7' }],
      // Chidi: the reader gave nothing (no grant now), so no patient.
      [id(3), null],
      // The routed row's patient is still its route card's.
      [id(4), { fullName: 'Amaka Card', sex: 'female', dateOfBirth: '1991-02-03', healthIdLast4: 'AAA2' }],
      [id(5), { fullName: 'Amaka Card', sex: 'female', dateOfBirth: '1991-02-03', healthIdLast4: 'AAA2' }]]);
    // An own row keeps its order id; the routed row still has none (PRIV P4.3).
    expect(page.items[0]).toMatchObject({ sourceEhrOrderId: '30000000-0000-4000-8000-000000000001' });
    expect('sourceEhrOrderId' in page.items[3]!).toBe(false);
    // The routed row's audit as before, then one row per own-row patient shown, ids only.
    expect(audited().map((event) => [event.action, event.patientId, event.resourceId, event.details])).toEqual([
      ['lab.work-item.list', amaka, id(4), { basis: 'order-route', workItemIds: [id(4)], orderRouteIds: [routeId] }],
      ['lab.work-item.list', amaka, id(1), { basis: 'consent', workItemIds: [id(1), id(5)] }],
      ['lab.work-item.list', bode, id(2), { basis: 'consent', workItemIds: [id(2)] }]]);
    expect(JSON.stringify(audited())).not.toMatch(/Amaka|Bode|AAA2|XYZ7|1991/);
    // Every audit row is written before the answer is made, in the list's transaction.
    expect(sqls.indexOf('audit lab.work-item.list')).toBeGreaterThan(at);
  });

  it('answers the rows without a patient when the reader fails, and audits none of them', async () => {
    const failure = Object.assign(new Error('function lab.work_item_patient_cards(uuid[]) does not exist'), { code: '42883' });
    const { service, statements, audited } = harness({ enabled: true, ownError: failure });
    const page = await service.list(reader);
    const sqls = statements.map(({ sql }) => sql);
    expect(sqls).toContain('rollback to savepoint lab_own_work_patient_cards');
    expect(sqls).not.toContain('release savepoint lab_own_work_patient_cards');
    expect(page.items.filter((item) => item.patient).map((item) => item.id)).toEqual([id(4)]);
    expect(audited().map((event) => event.details?.basis)).toEqual(['order-route']);
    expect(Logger.prototype.warn).toHaveBeenCalledWith({ message: 'Patients on own work could not be read',
      sqlState: '42883', correlationId: reader.correlationId });
  });

  it('reads no patient when the page has no own rows', async () => {
    const { service, statements } = harness({ enabled: true, rows: [row(4, amaka, true)] });
    await service.list(reader);
    expect(statements.some(({ sql }) => OWN.test(sql) || /lab_own_work_patient_cards/.test(sql))).toBe(false);
  });

  it('gives a single own work item its patient after the read row, which names the patient', async () => {
    const { service, statements, audited } = harness({ enabled: true });
    const item = await service.get(reader, id(1));
    expect(item.patient).toEqual({ fullName: 'Amaka Card', sex: 'female', dateOfBirth: '1991-02-03', healthIdLast4: 'AAA2' });
    const sqls = statements.map(({ sql }) => sql);
    expect(sqls.indexOf('audit lab.work-item.read')).toBeLessThan(sqls.findIndex((sql) => OWN.test(sql)));
    expect(statements.filter(({ sql }) => OWN.test(sql)).map(({ values }) => values)).toEqual([[[id(1)]]]);
    // No extra audit row: the read row is the one there was.
    expect(audited().map((event) => [event.action, event.patientId])).toEqual([['lab.work-item.read', amaka]]);
  });

  it('leaves a single own work item without a patient the reader does not give', async () => {
    const { service } = harness({ enabled: true });
    expect('patient' in (await service.get(reader, id(3)))).toBe(false);
  });

  it('reads a routed work item\'s patient from its route card only', async () => {
    const { service, statements } = harness({ enabled: true });
    const item = await service.get(reader, id(4));
    expect(item.patient).toMatchObject({ fullName: 'Amaka Card' });
    expect(statements.some(({ sql }) => OWN.test(sql))).toBe(false);
  });

  it('reads at most 200 ids a statement', async () => {
    const statements: unknown[][] = [];
    const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
      if (OWN.test(sql)) statements.push(values[0] as unknown[]);
      return { rows: [] };
    }) } as unknown as PoolClient;
    await new LabOwnWorkPatientCards(true).patients(client, Array.from({ length: 201 }, (_, n) => id(n)), 'c');
    expect(statements.map((ids) => ids.length)).toEqual([200, 1]);
  });
});

describe('OWN_WORK_PATIENT_CARD_ENABLED', () => {
  const original = { ...process.env };
  const base = { NODE_ENV: 'test', LAB_DATABASE_URL: 'postgresql://lab:test@localhost:5432/hid', DATABASE_SSL: 'false',
    CORS_ORIGINS: 'http://localhost:3000', LAB_INTERNAL_SERVICE_TOKEN: 'z'.repeat(32) };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });
  const provider = () => (Reflect.getMetadata('providers', LabModule) as unknown[]).find((entry) =>
    typeof entry === 'object' && entry !== null && (entry as { provide?: unknown }).provide === LabOwnWorkPatientCards) as
    { useFactory: () => LabOwnWorkPatientCards };

  it('is off unless set to true, and LabModule gives the work items service a reader that follows it', () => {
    Object.assign(process.env, base);
    delete process.env.OWN_WORK_PATIENT_CARD_ENABLED;
    resetEnvironmentForTests();
    expect(getEnvironment().OWN_WORK_PATIENT_CARD_ENABLED).toBe(false);
    expect(provider().useFactory().enabled).toBe(false);
    process.env.OWN_WORK_PATIENT_CARD_ENABLED = 'true';
    resetEnvironmentForTests();
    expect(getEnvironment().OWN_WORK_PATIENT_CARD_ENABLED).toBe(true);
    expect(provider().useFactory().enabled).toBe(true);
    // Nest injects it by its class: the service's sixth constructor parameter.
    expect((Reflect.getMetadata('design:paramtypes', LabWorkItemsService) as unknown[])[5]).toBe(LabOwnWorkPatientCards);
  });

  it('is what Nest injects into the service', async () => {
    const reader = new LabOwnWorkPatientCards(true);
    const moduleRef = await Test.createTestingModule({ providers: [LabWorkItemsService,
      { provide: DatabaseService, useValue: {} }, { provide: IdentityService, useValue: {} },
      { provide: AuditService, useValue: {} }, { provide: LabOrderRouteAccess, useValue: {} },
      { provide: LabOrderRouteCards, useValue: {} }, { provide: LabOwnWorkPatientCards, useValue: reader }] }).compile();
    expect((moduleRef.get(LabWorkItemsService) as unknown as { ownPatients: unknown }).ownPatients).toBe(reader);
  });

  it('refuses any value but true or false', () => {
    Object.assign(process.env, base, { OWN_WORK_PATIENT_CARD_ENABLED: 'yes' });
    resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/OWN_WORK_PATIENT_CARD_ENABLED/);
  });
});
