import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { IdentityService } from '../identity/identity.service';
import { basisDetails, PharmacyOrderRouteAccess } from './order-route-access';
import { PharmacyOrderRouteCards } from './order-route-cards';
import { OWN_WORK_OFF, PharmacyOwnWork } from './own-work-access';
import { PharmacyOwnWorkPatientCards } from './own-work-patient-cards';
import { PharmacyModule } from './pharmacy.module';
import { PharmacyService, WORK_LIST_QUERY } from './pharmacy.service';
import { PRESCRIPTION_DETAILS_OFF } from './prescription-dispensing-details';

/*
 * This facility's own work for its pharmacy staff (0133; owner, 18 November
 * 2026: "pharmacy and lab staff get their own facility's work items only,
 * never the chart"; finding F2). A command on an own work item or its
 * dispensing first asks pharmacy.own_work_access_for (in a savepoint); a row
 * means basis 'own-work' and Identity is not asked; no row, a schema without
 * 0133 or any refusal falls back to Identity's consent as before. The work
 * list records each own patient shown with the basis the reader gives, and an
 * own item whose automatic send was withdrawn carries `withdrawn: true`.
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
const CARDS = /from pharmacy\.work_item_patient_cards\(\$1::uuid\[\]\)/;

interface Options {
  ownWork?: boolean;
  accessRows?: { work_item_id: string }[];
  accessError?: Error & { code?: string };
  statesError?: Error & { code?: string };
  identityAllowed?: boolean;
}

const harness = (options: Options = {}) => {
  const rows = [row(1, ada), row(2, bisi), row(3, ada)];
  const statements: string[] = [];
  const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
    statements.push(sql);
    if (sql === WORK_LIST_QUERY) return { rows };
    if (/where w\.id=\$1/.test(sql)) return { rows: rows.filter((r) => r.id === values[0]) };
    if (/from pharmacy\.order_route_access_for/.test(sql)) {
      return { rows: [{ outcome: 'none', route_id: null, work_item_id: null }] };
    }
    if (ACCESS.test(sql)) {
      if (options.accessError) throw options.accessError;
      return { rows: options.accessRows ?? [{ work_item_id: values[1] }] };
    }
    if (STATES.test(sql)) {
      if (options.statesError) throw options.statesError;
      return { rows: (values[0] as string[]).map((item) => ({ work_item_id: item,
        basis: item === id(2) ? 'consent' : 'own-work', withdrawn: item === id(3) })) };
    }
    if (CARDS.test(sql)) {
      return { rows: (values[0] as string[]).map((item) => ({ work_item_id: item,
        patient_full_name: item === id(2) ? 'Bisi Own' : 'Ada Own', patient_sex: null, patient_date_of_birth: null,
        patient_health_id_last4: 'AAA2' })) };
    }
    if (/insert into pharmacy\.dispensings/.test(sql)) {
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
    new PharmacyOwnWorkPatientCards(true), PRESCRIPTION_DETAILS_OFF, ownWork);
  const audited = () => audit.recordWithClient.mock.calls.map((call) => {
    const [, , action, resource, details] = call as unknown as [unknown, unknown, string,
      { patientId?: string; resourceType: string; resourceId: string }, Record<string, unknown> | undefined];
    return { action, patientId: resource.patientId ?? null, resourceType: resource.resourceType, details };
  });
  return { service, statements, identity, audited };
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
    const { service, audited } = harness();
    const page = await service.listWorkItems(pharmacist);
    expect(page.items.map((item) => [item.id, 'withdrawn' in item ? item.withdrawn : false])).toEqual([
      [id(1), false], [id(2), false], [id(3), true]]);
    expect(audited().map((event) => [event.patientId, event.details])).toEqual([
      [null, { returnedCount: 3 }],
      [ada, { basis: 'own-work', workItemIds: [id(1), id(3)] }],
      [bisi, { basis: 'consent', workItemIds: [id(2)] }]]);
  });

  it('keeps basis consent and no withdrawn flag when the states cannot be read', async () => {
    const missing = Object.assign(new Error('function pharmacy.own_work_item_states does not exist'), { code: '42883' });
    const { service, audited } = harness({ statesError: missing });
    const page = await service.listWorkItems(pharmacist);
    expect(page.items.some((item) => 'withdrawn' in item)).toBe(false);
    expect(audited().slice(1).map((event) => event.details?.basis)).toEqual(['consent', 'consent']);
  });

  it('off, asks nothing new and keeps Identity\'s consent', async () => {
    const { service, statements, identity } = harness({ ownWork: false });
    await service.getWorkItem(pharmacist, id(1));
    expect(statements.some((sql) => ACCESS.test(sql) || STATES.test(sql))).toBe(false);
    expect(identity.authorize).toHaveBeenCalledTimes(1);
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
