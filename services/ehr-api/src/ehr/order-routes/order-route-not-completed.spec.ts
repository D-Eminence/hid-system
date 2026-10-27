import type { PoolClient } from 'pg';
import type { DataAccessContext } from '../../common/request-context';
import { orderRouteSummary, orderRouteView, patientOrderRoute } from './order-route.mapping';
import { OrderRouteReader } from './order-route-reader';

// D18 (SPEC-FINAL §5.2, §8.3, §10.2): what the ordering facility (A) reads of
// an order the receiving laboratory or pharmacy ended because it couldn't
// complete it. C3/C4's summary gains notCompleted, passed on only when the
// database answers it; C5 (the patient's list) is unchanged.
const patientId = '60000000-0000-4000-8000-000000000001';
const routeId = '70000000-0000-4000-8000-000000000001';
const orderId = '90000000-0000-4000-8000-000000000001';
const laboratoryId = '30000000-0000-4000-8000-000000000003';

/** C4's jsonb on 0090 (0086's keys and D17's two), for a lab request a laboratory ended as it couldn't complete it. */
const on0090 = { id: routeId, reference: '70000000', kind: 'lab_request', version: 3, effectiveState: 'cancelled',
  receivingFacility: { id: laboratoryId, name: 'Synthetic Laboratory', available: true },
  createdAt: '2026-10-20T09:00:00+00:00', respondBy: '2026-10-27T09:00:00+00:00', acceptedAt: '2026-10-20T10:00:00.5+00:00',
  completedAt: null, endedAt: '2026-10-22T08:00:00+00:00', endedKind: 'receiving_unable', declineReason: null,
  acceptLocked: false, resendAllowed: false, wrongPatient: null, correctableUntil: '2027-04-18T10:00:00.5+00:00' };

const ORDER_0090 = ['id', 'reference', 'kind', 'version', 'effectiveState', 'receivingFacility', 'createdAt', 'respondBy',
  'acceptedAt', 'completedAt', 'endedAt', 'endedKind', 'declineReason', 'acceptLocked', 'resendAllowed', 'wrongPatient',
  'correctableUntil'];

describe('the summary passes D18\'s notCompleted on when present, and only then (C3, C4)', () => {
  it('a lab request with a sample taken and a result recorded: the reason and both facts, as the last key', () => {
    const summary = orderRouteSummary({ ...on0090,
      notCompleted: { reason: 'equipment_unavailable', sampleTaken: true, resultRecorded: true } });
    expect(summary).toMatchObject({ effectiveState: 'cancelled', endedKind: 'receiving_unable',
      notCompleted: { reason: 'equipment_unavailable', sampleTaken: true, resultRecorded: true } });
    expect(Object.keys(summary)).toEqual([...ORDER_0090, 'notCompleted']);
  });

  it('a lab request with nothing recorded: false and false, never left out', () => {
    expect(orderRouteSummary({ ...on0090, notCompleted: { reason: 'test_not_offered', sampleTaken: false,
      resultRecorded: false } }).notCompleted).toEqual({ reason: 'test_not_offered', sampleTaken: false, resultRecorded: false });
  });

  it('a prescription: the reason, and null for the sample and the result', () => {
    expect(orderRouteSummary({ ...on0090, kind: 'prescription', notCompleted: { reason: 'out_of_stock', sampleTaken: null,
      resultRecorded: null } }).notCompleted).toEqual({ reason: 'out_of_stock', sampleTaken: null, resultRecorded: null });
  });

  it('every other route, and one with a wrong-patient report: null', () => {
    const reported = orderRouteSummary({ ...on0090, wrongPatient: { reportedAt: '2026-10-26T08:00:00Z', late: true },
      correctableUntil: null, notCompleted: null });
    expect(reported).toMatchObject({ endedKind: 'receiving_unable', wrongPatient: { late: true }, notCompleted: null });
    expect(orderRouteSummary({ ...on0090, endedKind: 'support', notCompleted: null }).notCompleted).toBeNull();
  });

  it('an earlier schema (0090): no key, so the answer is the same as before 0091', () => {
    const summary = orderRouteSummary(on0090);
    expect(summary).not.toHaveProperty('notCompleted');
    expect(Object.keys(summary)).toEqual(ORDER_0090);
  });

  it('an unreadable value is null, never a made-up reason; text jsonb is read; nothing else of it is answered', () => {
    for (const notCompleted of ['not json', [], 5, { sampleTaken: true }, { reason: 7 }, { reason: '' }]) {
      expect(orderRouteSummary({ ...on0090, notCompleted }).notCompleted).toBeNull();
    }
    expect(orderRouteSummary({ ...on0090, notCompleted: JSON.stringify({ reason: 'other', sampleTaken: 'yes',
      resultRecorded: 1, note: 'never answered', specimensCollected: 2 }) }).notCompleted)
      .toEqual({ reason: 'other', sampleTaken: null, resultRecorded: null });
  });

  it('C3\'s view carries it from its summary jsonb', () => {
    const view = orderRouteView({ route_id: routeId, summary: { ...on0090, notCompleted: { reason: 'sample_unusable',
      sampleTaken: true, resultRecorded: false } }, attestation: {}, events: [], reports: [] }, 'lab_request');
    expect(view).toMatchObject({ endedKind: 'receiving_unable', notCompleted: { reason: 'sample_unusable', sampleTaken: true,
      resultRecorded: false } });
  });

  it('C4 through the reader: the summaries keep it', async () => {
    const client = { query: jest.fn(async (sql: string) => (sql.includes('order_route_summaries')
      ? { rows: [{ order_id: orderId, summary: { ...on0090, notCompleted: { reason: 'supplies_unavailable', sampleTaken: false,
        resultRecorded: false } } }] }
      : { rows: [] })) };
    const context = { purposeOfUse: 'direct-care', correlationId: 'c' } as DataAccessContext;
    const found = await new OrderRouteReader({} as never).summaries(client as unknown as PoolClient, context, 'lab_request',
      patientId, [orderId]);
    expect(found?.get(orderId)).toMatchObject({ notCompleted: { reason: 'supplies_unavailable', sampleTaken: false,
      resultRecorded: false } });
  });
});

describe('the patient\'s list is unchanged (C5)', () => {
  it('a route ended receiving_unable reads cancelled, with D17\'s deadline and no notCompleted', () => {
    const route = patientOrderRoute({ route_id: routeId, reference: '70000000', kind: 'lab_request', row_version: 3,
      effective_state: 'cancelled', ended_at: '2026-10-22T08:00:00Z', ended_kind: 'receiving_unable', actions: [],
      content: { testDisplay: 'HbA1c' }, entered_in_error: false, wrong_patient_reported_at: null, wrong_patient_late: null,
      correctable_until: new Date('2027-04-18T10:00:00Z') });
    expect(route).toMatchObject({ effectiveState: 'cancelled', endedKind: 'receiving_unable', wrongPatient: null,
      correctableUntil: '2027-04-18T10:00:00.000Z' });
    expect(route).not.toHaveProperty('notCompleted');
  });
});
