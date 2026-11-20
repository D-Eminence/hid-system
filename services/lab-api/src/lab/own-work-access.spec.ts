import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { IdentityService } from '../identity/identity.service';
import { LabImportsService } from './lab-imports.service';
import { LabModule } from './lab.module';
import { LabWorkItemsService, WORK_LIST_QUERY } from './lab-work-items.service';
import { basisDetails, LabOrderRouteAccess } from './order-route-access';
import { LabOrderRouteCards } from './order-route-cards';
import { LabOwnWork, OWN_WORK_OFF } from './own-work-access';
import { LabOwnWorkPatientCards } from './own-work-patient-cards';

/*
 * This facility's own work for its lab staff (0133; owner, 18 November 2026:
 * "pharmacy and lab staff get their own facility's work items only, never
 * the chart"; finding F2). A command on an own work item or its chain (an
 * accession, specimen, execution or result) first asks lab.own_work_access_for
 * (in a savepoint); a row means basis 'own-work' and Identity is not asked;
 * no row, a schema without 0133 or any refusal falls back to Identity's
 * consent as before. The work list records each own patient shown with the
 * basis lab.own_work_item_bases gives.
 */

const facilityId = '10000000-0000-4000-8000-000000000001';
const accountId = '20000000-0000-4000-8000-000000000001';
const ada = '50000000-0000-4000-8000-000000000001';
const bisi = '50000000-0000-4000-8000-000000000002';
const id = (n: number) => `65000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scientist = { correlationId: 'own-lab-work-correlation', facilityId,
  membershipId: '40000000-0000-4000-8000-000000000001', purposeOfUse: 'direct-care', actor: { id: 'actor',
    subject: 'staff:lab', accountId, roles: ['lab'], permissions: ['lab.work-item.read'], facilityIds: [facilityId],
    facilities: [], authenticationMethod: 'local' } } satisfies DataAccessContext;

const row = (n: number, patient: string) => ({ id: id(n), patient_id: patient, facility_id: facilityId,
  ordering_facility_id: facilityId, source_ehr_order_id: `30000000-0000-4000-8000-00000000000${n}`,
  source_ehr_order_version: '1', source_encounter_id: '70000000-0000-4000-8000-000000000001', status: 'accepted',
  priority: 'routine', accepted_by: accountId, accepted_at: new Date(Date.UTC(2026, 10, 18, 9, n)), row_version: '1',
  created_at: new Date(Date.UTC(2026, 10, 18, 9, n)), order_route_id: null, test_name: `Test ${n}`,
  accession_id: null, accession_number: null, specimen_statuses: null });

const ACCESS = /from lab\.own_work_access_for\(\$1, \$2::uuid, \$3\)/;
const BASES = /from lab\.own_work_item_bases\(\$1::uuid\[\]\)/;
const CARDS = /from lab\.work_item_patient_cards\(\$1::uuid\[\]\)/;
const RECEIVES = 'select lab.order_route_receives_here() as receives, lab.order_routes_here() as routes_here';

interface Options {
  ownWork?: boolean; accessRows?: { work_item_id: string; basis: string }[]; accessError?: Error;
  /** 0133's bases: a failure, or the ids answered (default: every one asked). */
  basesError?: Error & { code?: string }; basesFor?: (ids: string[]) => string[];
  /** 0124's OWN_WORK_PATIENT_CARD_ENABLED (default on). */
  cards?: boolean;
}

const harness = (options: Options = {}) => {
  const rows = [row(1, ada), row(2, bisi), row(3, ada)];
  const statements: string[] = [];
  const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
    statements.push(sql);
    if (sql === WORK_LIST_QUERY) return { rows };
    if (/from lab\.work_items where id=\$1/.test(sql)) return { rows: rows.filter((r) => r.id === values[0]) };
    if (/from lab\.order_route_access_for/.test(sql)) return { rows: [{ outcome: 'none', route_id: null, work_item_id: null }] };
    if (ACCESS.test(sql)) {
      if (options.accessError) throw options.accessError;
      return { rows: options.accessRows ?? [{ work_item_id: values[1], basis: 'own-work' }] };
    }
    if (BASES.test(sql)) {
      if (options.basesError) throw options.basesError;
      const asked = values[0] as string[];
      return { rows: (options.basesFor ? options.basesFor(asked) : asked).map((item) => ({ work_item_id: item,
        basis: item === id(2) ? 'consent' : 'own-work' })) };
    }
    if (CARDS.test(sql)) {
      return { rows: (values[0] as string[]).map((item) => ({ work_item_id: item,
        patient_full_name: item === id(2) ? 'Bisi Own' : 'Ada Own', patient_sex: null, patient_date_of_birth: null,
        patient_health_id_last4: 'AAA2' })) };
    }
    if (sql === RECEIVES) return { rows: [{ receives: null, routes_here: null }] };
    return { rows: [] };
  }) } as unknown as PoolClient;
  const database = { withTransaction: async <T>(_c: DataAccessContext, fn: (c: PoolClient) => Promise<T>) => fn(client),
    query: jest.fn(async () => ({ rows: [{ orders: false, work: false }] })) } as unknown as DatabaseService;
  const identity = { authorize: jest.fn().mockResolvedValue({ allowed: true, breakGlass: false }) } as unknown as IdentityService;
  const audit = { recordWithClient: jest.fn(async () => undefined) };
  const ownWork = options.ownWork === false ? OWN_WORK_OFF : new LabOwnWork(true);
  const routeAccess = new LabOrderRouteAccess(identity, ownWork);
  const service = new LabWorkItemsService(database, identity, audit as unknown as AuditService, routeAccess,
    new LabOrderRouteCards(database), new LabOwnWorkPatientCards(options.cards ?? true), ownWork);
  const audited = () => audit.recordWithClient.mock.calls.map((call) => {
    const event = (call as unknown[])[1] as { action: string; patientId?: string; details?: Record<string, unknown> };
    return { action: event.action, patientId: event.patientId ?? null, details: event.details };
  });
  return { service, routeAccess, client, statements, identity, audited };
};

describe('own lab work (0133)', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('reads an own work item on the own-work basis without asking Identity, and audits it', async () => {
    const { service, identity, audited } = harness();
    await service.get(scientist, id(1));
    expect(identity.authorize).not.toHaveBeenCalled();
    expect(audited()).toEqual([{ action: 'lab.work-item.read', patientId: ada, details: { basis: 'own-work' } }]);
  });

  it.each(['accession', 'specimen', 'execution', 'result'] as const)(
    'authorizes a %s of an own work item on the own-work basis', async (resource) => {
      const { routeAccess, client, identity } = harness();
      const denied = () => new Error('denied');
      await expect(routeAccess.authorize(client, scientist, resource, id(9), ada, 'write_records', denied as never))
        .resolves.toEqual({ basis: 'own-work' });
      expect(identity.authorize).not.toHaveBeenCalled();
    });

  it('keeps the basis consent, without asking Identity, for a member holding its own consent (as the list does)',
    async () => {
      const { service, routeAccess, client, identity, audited } = harness({ accessRows: [{ work_item_id: id(1),
        basis: 'consent' }] });
      await service.get(scientist, id(1));
      const denied = () => new Error('denied');
      await expect(routeAccess.authorize(client, scientist, 'result', id(9), ada, 'write_records', denied as never))
        .resolves.toEqual({ basis: 'consent' });
      expect(identity.authorize).not.toHaveBeenCalled();
      expect(audited()).toEqual([{ action: 'lab.work-item.read', patientId: ada, details: {} }]);
    });

  it('falls back to Identity\'s consent when the database answers no own-work basis', async () => {
    const { service, identity, audited } = harness({ accessRows: [] });
    await service.get(scientist, id(1));
    expect(identity.authorize).toHaveBeenCalledWith(ada, 'read_records', 'direct-care', scientist);
    expect(audited()[0]!.details).toEqual({});
  });

  it('falls back to Identity on a schema without 0133, after rolling back its savepoint', async () => {
    const missing = Object.assign(new Error('function lab.own_work_access_for does not exist'), { code: '42883' });
    const { service, statements, identity } = harness({ accessError: missing });
    await service.get(scientist, id(1));
    expect(statements).toContain('rollback to savepoint lab_own_work_access');
    expect(identity.authorize).toHaveBeenCalledTimes(1);
  });

  it('passes a serialization failure on, so the whole transaction is retried', async () => {
    const conflict = Object.assign(new Error('could not serialize access'), { code: '40001' });
    const { service } = harness({ accessError: conflict });
    await expect(service.get(scientist, id(1))).rejects.toBe(conflict);
  });

  it('lists own rows and records each patient shown with the reader\'s basis', async () => {
    const { service, audited } = harness();
    await service.list(scientist);
    expect(audited().filter((event) => event.patientId).map((event) => [event.patientId, event.details])).toEqual([
      [ada, { basis: 'own-work', workItemIds: [id(1), id(3)] }],
      [bisi, { basis: 'consent', workItemIds: [id(2)] }]]);
  });

  it('records every own patient listed with 0133\'s basis while the patient card is off (0124 flag off)', async () => {
    const { service, statements, audited } = harness({ cards: false });
    await service.list(scientist);
    expect(statements.some((sql) => CARDS.test(sql))).toBe(false);
    expect(audited().filter((event) => event.patientId).map((event) => [event.patientId, event.details])).toEqual([
      [ada, { basis: 'own-work', workItemIds: [id(1), id(3)] }],
      [bisi, { basis: 'consent', workItemIds: [id(2)] }]]);
  });

  it('records a row 0133 no longer answers (a grant ended meanwhile) with the list read\'s basis, consent', async () => {
    const { service, audited } = harness({ cards: false, basesFor: (ids) => ids.filter((item) => item !== id(3)) });
    await service.list(scientist);
    expect(audited().filter((event) => event.patientId).map((event) => [event.patientId, event.details])).toEqual([
      [ada, { basis: 'own-work', workItemIds: [id(1)] }],
      [bisi, { basis: 'consent', workItemIds: [id(2)] }],
      [ada, { basis: 'consent', workItemIds: [id(3)] }]]);
  });

  it('on a schema without 0133 records as 0124 did: shown patients with basis consent, none while cards are off',
    async () => {
      const missing = Object.assign(new Error('function lab.own_work_item_bases does not exist'), { code: '42883' });
      const shown = harness({ basesError: missing });
      await shown.service.list(scientist);
      expect(shown.statements).toContain('rollback to savepoint lab_own_work_bases');
      expect(shown.audited().filter((event) => event.patientId).map((event) => [event.patientId, event.details]))
        .toEqual([[ada, { basis: 'consent', workItemIds: [id(1), id(3)] }], [bisi, { basis: 'consent', workItemIds: [id(2)] }]]);
      const hidden = harness({ basesError: missing, cards: false });
      await hidden.service.list(scientist);
      expect(hidden.audited().filter((event) => event.patientId)).toEqual([]);
    });

  it('fails the list rather than record a basis it could not read', async () => {
    const timeout = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const { service, statements, audited } = harness({ basesError: timeout, cards: false });
    await expect(service.list(scientist)).rejects.toBe(timeout);
    expect(statements).toContain('rollback to savepoint lab_own_work_bases');
    expect(audited().filter((event) => event.patientId)).toEqual([]);
  });

  it('passes a serialization failure of the bases on, so the list is run again', async () => {
    const conflict = Object.assign(new Error('could not serialize access'), { code: '40001' });
    const { service, statements } = harness({ basesError: conflict });
    await expect(service.list(scientist)).rejects.toBe(conflict);
    expect(statements).not.toContain('rollback to savepoint lab_own_work_bases');
  });

  it('never gives a new acceptance on the own-work basis: Identity\'s consent decides', async () => {
    const { service, statements, identity } = harness();
    (identity.authorize as jest.Mock).mockResolvedValue({ allowed: false, breakGlass: false });
    const accepting = { ...scientist, actor: { ...scientist.actor, permissions: ['lab.work-item.read', 'lab.work-item.accept'] } };
    await expect(service.acceptEhrOrder(accepting, { sourceEhrOrderId: '30000000-0000-4000-8000-000000000009',
      sourceEhrOrderVersion: 1, sourceEncounterId: '70000000-0000-4000-8000-000000000001', patientId: ada,
      orderingFacilityId: facilityId, testCodeSystem: 'http://loinc.org', testCode: '718-7', testName: 'Haemoglobin',
      priority: 'routine', requestedBy: accountId, requestedAt: '2026-11-18T09:00:00Z' } as never))
      .rejects.toMatchObject({ status: 403 });
    expect(identity.authorize).toHaveBeenCalledWith(ada, 'write_records', 'direct-care', accepting);
    expect(statements.some((sql) => ACCESS.test(sql) || BASES.test(sql))).toBe(false);
  });

  it('never gives imported Lab evidence on the own-work basis: the imports service has no such check at all', async () => {
    expect(Reflect.getMetadata('design:paramtypes', LabImportsService)).not.toContain(LabOwnWork);
    expect(Reflect.getMetadata('design:paramtypes', LabImportsService)).not.toContain(LabOrderRouteAccess);
    const client = { query: jest.fn(async () => ({ rows: [{ id: id(9), patient_id: ada, facility_id: facilityId }] })) };
    const database = { withTransaction: async <T>(_c: DataAccessContext, fn: (c: PoolClient) => Promise<T>) =>
      fn(client as unknown as PoolClient) } as unknown as DatabaseService;
    const identity = { authorize: jest.fn().mockResolvedValue({ allowed: false, breakGlass: false }) } as unknown as
      IdentityService;
    const audit = { recordWithClient: jest.fn() };
    const imports = new LabImportsService(database, identity, audit as unknown as AuditService);
    await expect(imports.get(scientist, id(9))).rejects.toMatchObject({ status: 403, code: 'LAB_IMPORT_ACCESS_DENIED' });
    await expect(imports.listForPatient(scientist, { patientId: ada } as never))
      .rejects.toMatchObject({ status: 403, code: 'LAB_IMPORT_ACCESS_DENIED' });
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('off, asks nothing new', async () => {
    const { service, statements, identity } = harness({ ownWork: false });
    await service.get(scientist, id(1));
    expect(statements.some((sql) => ACCESS.test(sql) || BASES.test(sql))).toBe(false);
    expect(identity.authorize).toHaveBeenCalledTimes(1);
  });

  it('records basis own-work in the audit details', () => {
    expect(basisDetails({ basis: 'own-work' })).toEqual({ basis: 'own-work' });
    expect(basisDetails({ basis: 'consent' })).toEqual({});
  });

  it('is provided on by the Lab module and injected into the work items and the access check', () => {
    const provider = (Reflect.getMetadata('providers', LabModule) as unknown[]).find((entry) =>
      typeof entry === 'object' && entry !== null && (entry as { provide?: unknown }).provide === LabOwnWork) as
      { useFactory: () => LabOwnWork };
    expect(provider.useFactory().enabled).toBe(true);
    expect(OWN_WORK_OFF.enabled).toBe(false);
    expect((Reflect.getMetadata('design:paramtypes', LabWorkItemsService) as unknown[])[6]).toBe(LabOwnWork);
    expect((Reflect.getMetadata('design:paramtypes', LabOrderRouteAccess) as unknown[])[1]).toBe(LabOwnWork);
  });
});
