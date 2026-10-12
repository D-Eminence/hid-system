import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { requestDigest } from '../common/idempotency';
import type { DataAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import type { IdentityService } from '../identity/identity.service';
import { LabWorkItemsService } from './lab-work-items.service';
import type { AcceptEhrLabOrderCommand } from './lab-work-items.types';

const facilityId = '10000000-0000-4000-8000-000000000001';
const accountId = '20000000-0000-4000-8000-000000000001';
const orderId = '30000000-0000-4000-8000-000000000001';
const patientId = '50000000-0000-4000-8000-000000000001';
const workItemId = '60000000-0000-4000-8000-000000000001';
const context = { correlationId: 'lab-work-item-correlation', facilityId,
  membershipId: '40000000-0000-4000-8000-000000000001', purposeOfUse: 'direct-care', actor: { id: 'actor',
    subject: 'staff:lab', accountId, roles: ['doctor'], permissions: ['lab.work-item.accept'], facilityIds: [facilityId],
    facilities: [], authenticationMethod: 'local' } } satisfies DataAccessContext;
const command = (version: number, priority: AcceptEhrLabOrderCommand['priority'] = 'routine'): AcceptEhrLabOrderCommand => ({
  sourceEhrOrderId: orderId, sourceEhrOrderVersion: version, sourceEncounterId: '70000000-0000-4000-8000-000000000001',
  patientId, orderingFacilityId: facilityId, testCodeSystem: 'http://loinc.org', testCode: '718-7', testName: 'Haemoglobin',
  priority, clinicalIndication: 'Fatigue', requestedBy: accountId, requestedAt: '2026-10-01T09:00:00.123456Z' });

// The work item Lab accepted from version 1 of the EHR order. lab.work_items has
// unique(source_ehr_order_id) (0018): one work item per EHR order, ever.
const stored = { id: workItemId, patient_id: patientId, facility_id: facilityId, ordering_facility_id: facilityId,
  source_ehr_order_id: orderId, source_ehr_order_version: '1', source_encounter_id: '70000000-0000-4000-8000-000000000001',
  status: 'accepted', priority: 'routine', accepted_by: accountId, accepted_at: new Date('2026-10-01T09:00:01Z'),
  row_version: '1', created_at: new Date('2026-10-01T09:00:01Z'),
  request_sha256: requestDigest('lab.work-item.accept-ehr-order', command(1)) };

/**
 * A fake database holding `rows`. The replay lookup returns the stored work
 * item when its predicate would select it: the same idempotency key, or the
 * same EHR order (and, if the statement also binds the version, that version).
 * An insert behaves as the database does: `insertError` if given (a guard
 * refusal), else the unique violation on source_ehr_order_id when a work item
 * of the order exists.
 */
const harness = (rows: (typeof stored)[], insertError?: Error) => {
  const queries: string[] = [];
  const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
    queries.push(sql);
    if (/^\s*select\b/i.test(sql) && /from lab\.work_items/.test(sql)) {
      const byVersion = /source_ehr_order_version\s*=\s*\$5/.test(sql);
      return { rows: rows.filter((row) => row.source_ehr_order_id === values[3]
        && (!byVersion || row.source_ehr_order_version === String(values[4]))) };
    }
    if (/insert into lab\.work_items\b/.test(sql)) {
      if (insertError) throw insertError;
      if (rows.some((row) => row.source_ehr_order_id === values[4])) {
        throw Object.assign(new Error('duplicate key value violates unique constraint "work_items_source_ehr_order_id_key"'),
          { code: '23505' });
      }
      return { rows: [{ ...stored, source_ehr_order_version: String(values[5]), priority: values[7] }] };
    }
    return { rows: [], rowCount: 1 };
  }) } as unknown as PoolClient;
  const database = { withTransaction: async <T>(_context: DataAccessContext, operation: (c: PoolClient) => Promise<T>) =>
    operation(client) } as unknown as DatabaseService;
  const identity = { authorize: jest.fn().mockResolvedValue({ allowed: true, breakGlass: false }) } as unknown as IdentityService;
  const audit = { recordWithClient: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  return { service: new LabWorkItemsService(database, identity, audit), queries };
};
const inserts = (queries: string[]) => queries.filter((sql) => /insert into lab\./.test(sql));

describe('LabWorkItemsService.acceptEhrOrder', () => {
  it('refuses a later version of an EHR order it accepted with 409 LAB_ORDER_ALREADY_ACCEPTED, writing nothing', async () => {
    const { service, queries } = harness([stored]);
    await expect(service.acceptEhrOrder(context, command(2, 'stat'))).rejects.toMatchObject({
      code: 'LAB_ORDER_ALREADY_ACCEPTED', status: 409 });
    expect(inserts(queries)).toEqual([]);
  });

  // Two EHR updates commit v2 and then v3 and each sends its version after its
  // commit; the v3 call reaches Lab first. The late v2 is not the current EHR
  // order (EHR is at v3 or later), and Lab holds a version that already carries
  // its change, so ALREADY_ACCEPTED ("Lab holds an earlier version, the change
  // is not in Lab") would be false.
  it('refuses an earlier version of an EHR order than the one it holds with 409 LAB_ORDER_NOT_CURRENT, writing nothing', async () => {
    const later = { ...stored, source_ehr_order_version: '3', request_sha256: requestDigest('lab.work-item.accept-ehr-order', command(3)) };
    const { service, queries } = harness([later]);
    await expect(service.acceptEhrOrder(context, command(2))).rejects.toMatchObject({
      code: 'LAB_ORDER_NOT_CURRENT', status: 409 });
    expect(inserts(queries)).toEqual([]);
  });

  it('replays the same version of the same order without writing', async () => {
    const { service, queries } = harness([stored]);
    await expect(service.acceptEhrOrder(context, command(1))).resolves.toMatchObject({ id: workItemId,
      sourceEhrOrderId: orderId, sourceEhrOrderVersion: 1, status: 'accepted' });
    expect(inserts(queries)).toEqual([]);
  });

  it('refuses the same version with a different body with 409 IDEMPOTENCY_CONFLICT', async () => {
    const { service, queries } = harness([stored]);
    await expect(service.acceptEhrOrder(context, command(1, 'urgent'))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT', status: 409 });
    expect(inserts(queries)).toEqual([]);
  });

  it('accepts a new order, reading it without a lock', async () => {
    const { service, queries } = harness([]);
    await expect(service.acceptEhrOrder(context, command(1))).resolves.toMatchObject({ sourceEhrOrderVersion: 1 });
    expect(inserts(queries).filter((sql) => /insert into lab\.work_items\b/.test(sql))).toHaveLength(1);
    expect(queries.filter((sql) => /\bfor\s+(update|share|no key update|key share)\b/i.test(sql))).toEqual([]);
  });

  it('answers the acceptance guard refusal (23514) with 409 LAB_ORDER_NOT_CURRENT, keeping the SQLSTATE as its cause', async () => {
    const guard = Object.assign(new Error('Lab work item does not match the exact active EHR order version and actor context'),
      { code: '23514' });
    const { service } = harness([], guard);
    const refusal = await service.acceptEhrOrder(context, command(1)).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: 'LAB_ORDER_NOT_CURRENT', status: 409 });
    expect((refusal as { getResponse?: () => unknown }).getResponse?.()).not.toMatch(/does not match/);
    expect((refusal as { cause?: unknown }).cause).toBe(guard);
  });
});
