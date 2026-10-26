import type { PoolClient } from 'pg';
import type { DataAccessContext } from '../../common/request-context';
import { orderRouteSummary, orderRouteView, patientOrderRoute, wrongPatientOverview } from './order-route.mapping';
import { OrderRouteReader } from './order-route-reader';
import { OrderRoutesService } from './order-routes.service';

// D17 (SPEC-FINAL §5.2, §8.3, §10.2): what the ordering facility (A) and the
// patient read of a late correction. C3/C4's summary gains wrongPatient and
// correctableUntil, C5 three trailing columns, C28's items reportedAt, late
// and endedKindBefore; each is passed on only when the database answers it.
const facilityId = '30000000-0000-4000-8000-000000000001';
const membershipId = '40000000-0000-4000-8000-000000000001';
const accountId = '20000000-0000-4000-8000-0000000000b1';
const patientId = '60000000-0000-4000-8000-000000000001';
const routeId = '70000000-0000-4000-8000-000000000001';
const encounterId = '80000000-0000-4000-8000-000000000001';
const orderId = '90000000-0000-4000-8000-000000000001';
const laboratoryId = '30000000-0000-4000-8000-000000000003';

/** C4's jsonb before 0090 (0086's keys), as the database renders timestamps in jsonb. */
const before0090 = { id: routeId, reference: '70000000', kind: 'lab_request', version: 9, effectiveState: 'completed',
  receivingFacility: { id: laboratoryId, name: 'Synthetic Laboratory', available: true },
  createdAt: '2026-10-20T09:00:00+00:00', respondBy: '2026-10-27T09:00:00+00:00', acceptedAt: '2026-10-20T10:00:00.5+00:00',
  completedAt: '2026-10-21T10:00:00+00:00', endedAt: '2026-10-22T08:00:00+00:00', endedKind: 'support', declineReason: null,
  acceptLocked: false, resendAllowed: false };

describe('the summary passes D17\'s two keys on when present, and only then (C3, C4)', () => {
  it('a correctable order: no report, the deadline', () => {
    const summary = orderRouteSummary({ ...before0090, wrongPatient: null, correctableUntil: '2027-04-18T10:00:00.5+00:00' });
    expect(summary).toMatchObject({ endedKind: 'support', wrongPatient: null, correctableUntil: '2027-04-18T10:00:00.500Z' });
    expect(Object.keys(summary).slice(-2)).toEqual(['wrongPatient', 'correctableUntil']);
  });

  it('a late report: wrongPatient { reportedAt, late }, no deadline; an in-window one late false', () => {
    expect(orderRouteSummary({ ...before0090, wrongPatient: { reportedAt: '2026-10-26T08:00:00.123456+00:00', late: true,
      note: 'never answered' }, correctableUntil: null })).toMatchObject({ wrongPatient: { reportedAt: '2026-10-26T08:00:00.123Z',
      late: true }, correctableUntil: null });
    const inWindow = orderRouteSummary({ ...before0090, endedKind: 'wrong_patient',
      wrongPatient: JSON.stringify({ reportedAt: '2026-10-21T12:00:00+00:00', late: false }), correctableUntil: null });
    expect(inWindow.wrongPatient).toEqual({ reportedAt: '2026-10-21T12:00:00.000Z', late: false });
    expect(JSON.stringify(inWindow)).not.toContain('never answered');
  });

  it('an earlier schema: neither key, so the answer is the same as before 0090', () => {
    const summary = orderRouteSummary(before0090);
    expect(summary).not.toHaveProperty('wrongPatient');
    expect(summary).not.toHaveProperty('correctableUntil');
    expect(Object.keys(summary)).toEqual(['id', 'reference', 'kind', 'version', 'effectiveState', 'receivingFacility', 'createdAt',
      'respondBy', 'acceptedAt', 'completedAt', 'endedAt', 'endedKind', 'declineReason', 'acceptLocked', 'resendAllowed']);
  });

  it('an unreadable report is null, never a made-up one; an unreadable deadline is null', () => {
    for (const wrongPatient of ['not json', { late: true }, { reportedAt: 'soon', late: true }, [], 5]) {
      expect(orderRouteSummary({ ...before0090, wrongPatient }).wrongPatient).toBeNull();
    }
    expect(orderRouteSummary({ ...before0090, correctableUntil: 'soon' }).correctableUntil).toBeNull();
    expect(orderRouteSummary({ ...before0090, wrongPatient: { reportedAt: '2026-10-26T08:00:00Z', late: 'yes' } }).wrongPatient)
      .toEqual({ reportedAt: '2026-10-26T08:00:00.000Z', late: false });
  });

  it('C3\'s view carries them from its summary jsonb, with the released and entered-in-error reports', () => {
    const view = orderRouteView({ route_id: routeId, summary: { ...before0090, wrongPatient: { reportedAt: '2026-10-26T08:00:00Z',
      late: true }, correctableUntil: null }, attestation: {}, events: [], reports: [
      { resultId: 'r1', resultVersion: 1, kind: 'released', numericValue: 6.8, occurredAt: '2026-10-21T10:00:00Z' },
      { resultId: 'r1', resultVersion: 1, kind: 'entered_in_error', numericValue: null, occurredAt: '2026-10-26T08:00:00Z' }] },
    'lab_request');
    expect(view).toMatchObject({ endedKind: 'support', wrongPatient: { reportedAt: '2026-10-26T08:00:00.000Z', late: true },
      correctableUntil: null });
    expect('results' in view && view.results.map((item) => item.kind)).toEqual(['released', 'entered_in_error']);
  });

  it('C4 through the reader: the summaries keep both keys', async () => {
    const client = { query: jest.fn(async (sql: string) => (sql.includes('order_route_summaries')
      ? { rows: [{ order_id: orderId, summary: { ...before0090, wrongPatient: null, correctableUntil: '2027-04-18T10:00:00+00:00' } }] }
      : { rows: [] })) };
    const context = { purposeOfUse: 'direct-care', correlationId: 'c' } as DataAccessContext;
    const found = await new OrderRouteReader({} as never).summaries(client as unknown as PoolClient, context, 'lab_request',
      patientId, [orderId]);
    expect(found?.get(orderId)).toMatchObject({ wrongPatient: null, correctableUntil: '2027-04-18T10:00:00.000Z' });
  });
});

describe('the patient\'s list passes C5\'s three trailing columns on when present (C5)', () => {
  const row = { route_id: routeId, reference: '70000000', kind: 'lab_request', row_version: 9, effective_state: 'completed',
    ended_at: '2026-10-22T08:00:00Z', ended_kind: 'support', actions: [], content: { testDisplay: 'HbA1c' },
    entered_in_error: false };

  it('a late report, a correctable order, and an earlier schema', () => {
    expect(patientOrderRoute({ ...row, wrong_patient_reported_at: new Date('2026-10-26T08:00:00.123Z'),
      wrong_patient_late: true, correctable_until: null })).toMatchObject({ wrongPatient: {
      reportedAt: '2026-10-26T08:00:00.123Z', late: true }, correctableUntil: null, endedKind: 'support' });
    expect(patientOrderRoute({ ...row, wrong_patient_reported_at: null, wrong_patient_late: null,
      correctable_until: new Date('2027-04-18T10:00:00Z') })).toMatchObject({ wrongPatient: null,
      correctableUntil: '2027-04-18T10:00:00.000Z' });
    const earlier = patientOrderRoute(row);
    expect(earlier).not.toHaveProperty('wrongPatient');
    expect(earlier).not.toHaveProperty('correctableUntil');
  });

  it('an in-window report reads late false, whatever the late column is when it is not true', () => {
    expect(patientOrderRoute({ ...row, ended_kind: 'wrong_patient', wrong_patient_reported_at: '2026-10-21T12:00:00Z',
      wrong_patient_late: false, correctable_until: null }).wrongPatient).toEqual({ reportedAt: '2026-10-21T12:00:00.000Z',
      late: false });
  });
});

/** C28's items after 0090, as the database answers them. */
const lateItem = { routeId, reference: '70000000', kind: 'lab_request',
  receivingFacility: { id: laboratoryId, name: 'Synthetic Laboratory' }, patient: { name: 'Ngozi Eze' },
  endedAt: '2026-10-22T08:00:00+00:00', reportedAt: '2026-10-26T08:00:00.239123+00:00', late: true, endedKindBefore: 'support',
  resultsWithdrawn: 1, dispensingReversed: false, link: { patientId, encounterId, kind: 'lab_request', orderId } };

describe('the Overview card passes reportedAt, late and endedKindBefore on when present (C28)', () => {
  it('a late report on an order support had closed keeps support\'s ending in endedAt', () => {
    expect(wrongPatientOverview({ windowDays: 30, items: [lateItem], others: { count: 0, references: [] } })).toEqual({
      windowDays: 30, items: [{ routeId, reference: '70000000', kind: 'lab_request',
        receivingFacility: { id: laboratoryId, name: 'Synthetic Laboratory' }, patient: { name: 'Ngozi Eze' },
        endedAt: '2026-10-22T08:00:00.000Z', reportedAt: '2026-10-26T08:00:00.239Z', late: true, endedKindBefore: 'support',
        resultsWithdrawn: 1, dispensingReversed: false, link: { patientId, encounterId, kind: 'lab_request', orderId } }],
      others: { count: 0, references: [] } });
  });

  it('an in-window report: late false and no earlier ending; an earlier schema: none of the three', () => {
    const [inWindow] = wrongPatientOverview({ windowDays: 30, items: [{ ...lateItem, late: false, endedKindBefore: null,
      reportedAt: '2026-10-22T08:00:00.001+00:00' }], others: { count: 0, references: [] } })!.items;
    expect(inWindow).toMatchObject({ late: false, endedKindBefore: null, reportedAt: '2026-10-22T08:00:00.001Z' });
    const { reportedAt: _r, late: _l, endedKindBefore: _e, ...earlierItem } = lateItem;
    const [earlier] = wrongPatientOverview({ windowDays: 30, items: [earlierItem], others: { count: 0, references: [] } })!.items;
    for (const key of ['reportedAt', 'late', 'endedKindBefore']) expect(earlier).not.toHaveProperty(key);
  });

  it('the service answers lateCorrection: true and audits a late item as any other, naming its patient', async () => {
    const client = { query: jest.fn(async () => ({ rows: [{ answer: { windowDays: 30, items: [lateItem],
      others: { count: 0, references: [] } } }] })) };
    const audits: Array<Record<string, unknown>> = [];
    const audit = { recordWithClient: jest.fn(async (_c: unknown, event: Record<string, unknown>) => { audits.push(event); }) };
    const database = { withTransaction: jest.fn(async (_c: unknown, operation: (c: unknown) => Promise<unknown>) => operation(client)) };
    const service = new OrderRoutesService({} as never, database as never, audit as never, {} as never);
    const context = { correlationId: 'correlation-123456', facilityId, membershipId, purposeOfUse: 'direct-care',
      actor: { id: accountId, subject: 'staff:test', accountId, authenticationMethod: 'local', roles: ['doctor'],
        permissions: ['ehr.order-route.send'], facilityIds: [facilityId], facilities: [] } } as unknown as DataAccessContext;
    const answer = await service.wrongPatientOverview(context);
    expect(answer).toMatchObject({ lateCorrection: true, items: [{ routeId, late: true, endedKindBefore: 'support' }] });
    expect(Object.keys(answer)).toEqual(['windowDays', 'items', 'others', 'lateCorrection']);
    expect(audits.map((row) => [row.action, row.patientId, row.details])).toEqual([
      ['ehr.order-route.wrong-patient-overview', undefined, { itemCount: 1, otherCount: 0 }],
      ['ehr.order-route.wrong-patient-overview.item', patientId, { routeId, kind: 'lab_request' }]]);
  });
});
