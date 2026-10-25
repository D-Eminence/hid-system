import type { DataAccessContext } from '../../common/request-context';
import { OrderStatus } from '../shared/clinical.dto';
import type { OrderRouteSummary } from '../order-routes/order-route.mapping';
import { PrescriptionsService } from '../prescriptions/prescriptions.service';
import { LabRequestsService, type LabRequestRow } from './lab-requests.service';

// P4c (SPEC-FINAL §7.5, §9.1, §14.1): the EHR's same-facility Lab and
// Pharmacy paths with routes to other facilities.
const patientId = '123e4567-e89b-42d3-a456-426614174001';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const requestId = '123e4567-e89b-42d3-a456-426614174005';
const encounterId = '123e4567-e89b-42d3-a456-426614174006';
const routeId = '123e4567-e89b-42d3-a456-426614174008';

const context = { correlationId: 'correlation-123456', facilityId, membershipId, purposeOfUse: 'direct-care',
  actor: { id: accountId, subject: 'staff:test', accountId, authenticationMethod: 'local', roles: ['doctor'],
    permissions: ['ehr.lab-request.write', 'lab.work-item.accept'], facilityIds: [facilityId], facilities: [],
    facility: { id: facilityId, membershipId, organizationId: facilityId, name: 'Test', roles: ['doctor'],
      permissions: [], isPrimary: true } } } as DataAccessContext;

const createdAtExact = '2026-10-01T09:00:00.123456Z';
const row = (status: OrderStatus, rowVersion = '1'): LabRequestRow => ({
  id: requestId, encounterId, patientId, facilityId, createdBy: accountId, createdByMembershipId: membershipId,
  testCodeSystem: 'loinc', testCode: '718-7', testDisplay: 'Hemoglobin', priority: 'routine', status,
  specimenTypeCode: null, clinicalInformation: 'Fatigue', externalOrderReference: null, rowVersion,
  createdAt: new Date('2026-10-01T09:00:00.123Z'), updatedAt: new Date('2026-10-01T09:00:00.123Z'),
});
const route = (effectiveState: string, acceptedAt: string | null = null): OrderRouteSummary => ({
  id: routeId, reference: '123E4567', kind: 'lab_request', version: 1, effectiveState,
  receivingFacility: { id: facilityId, name: 'Receiving Laboratory', available: true }, createdAt: null,
  respondBy: null, acceptedAt, completedAt: null, endedAt: null, endedKind: null, declineReason: null,
  acceptLocked: false, resendAllowed: false,
});

/**
 * A fake EHR: the stored row (`before`) and what the UPDATE returns
 * (`after`); a reader answering `routes` (one per call, the last repeated);
 * and a log of what ran inside the clinical transaction and what ran outside.
 */
function fake(before: LabRequestRow, after: LabRequestRow = before, routes: Array<OrderRouteSummary | null | undefined> = [null]) {
  const log: string[] = [];
  let inTransaction = false;
  const query = jest.fn(async (sql: string) => {
    log.push(`${inTransaction ? 'tx' : 'pool'}: ${sql.trim().split(/\s+/).slice(0, 3).join(' ')}`);
    const stored = /^\s*update\s+ehr\.lab_requests\b/i.test(sql) ? after : before;
    return { rows: [{ ...stored, ...(sql.includes('as "createdAtExact"') ? { createdAtExact } : {}), cursorAt: createdAtExact }] };
  });
  const repository = {
    run: jest.fn(async (_c: unknown, _p: unknown, _a: unknown, _e: unknown,
      operation: (client: unknown) => Promise<{ value: unknown }>) => {
      inTransaction = true;
      try { return (await operation({ query })).value; } finally { inTransaction = false; }
    }),
    setChangeReason: jest.fn(async () => undefined),
    exists: jest.fn(async () => true),
  };
  let call = 0;
  const next = () => routes[Math.min(call++, routes.length - 1)];
  const reader = {
    summaries: jest.fn(async (_client: unknown, ctx: DataAccessContext, _kind: string, _patient: string, ids: string[]) => {
      log.push(`${inTransaction ? 'tx' : 'pool'}: C4`);
      if (ctx.purposeOfUse !== 'direct-care') return undefined;
      const found = next();
      if (found === undefined) return undefined;
      return new Map(found ? ids.map((id) => [id, found] as const) : []);
    }),
    summary: jest.fn(async (_client: unknown, ctx: DataAccessContext) => {
      log.push(`${inTransaction ? 'tx' : 'pool'}: C4`);
      if (ctx.purposeOfUse !== 'direct-care') return undefined;
      return next();
    }),
    crossFacilityOrdersEnabled: jest.fn(async () => {
      log.push(`${inTransaction ? 'tx' : 'pool'}: control`);
      return true;
    }),
  };
  const labApi = { acceptEhrOrder: jest.fn().mockResolvedValue({ id: 'work-item' }) };
  const service = new LabRequestsService(repository as never, labApi as never, reader as never);
  return { service, query, log, labApi, reader, repository };
}

describe('LabRequestsService with routes to other facilities (P4c)', () => {
  it('locks the request FOR NO KEY UPDATE, never FOR UPDATE (FEAS K1)', async () => {
    const { service, query } = fake(row(OrderStatus.Draft), row(OrderStatus.Cancelled, '2'));
    await service.update(context, patientId, encounterId, requestId,
      { status: OrderStatus.Cancelled, expectedRowVersion: 1, changeReason: 'Not needed now' } as never);
    const locks = query.mock.calls.map(([sql]) => String(sql)).filter((sql) => /\bfor\b/i.test(sql));
    expect(locks).toEqual([expect.stringMatching(/for no key update\s*$/)]);
    expect(locks.join('\n')).not.toMatch(/for update/i);
  });

  it('never hands a request routed before the update to this facility\'s Lab (ORDER_ROUTED), answering the route after', async () => {
    const { service, labApi } = fake(row(OrderStatus.OnHold), row(OrderStatus.Active, '2'),
      [route('accepted', '2026-10-02T09:00:00Z'), route('accepted', '2026-10-02T09:00:00Z')]);
    const updated = await service.update(context, patientId, encounterId, requestId,
      { status: OrderStatus.Active, expectedRowVersion: 1, changeReason: 'Resume' } as never);
    expect(labApi.acceptEhrOrder).not.toHaveBeenCalled();
    expect(updated).toMatchObject({ status: OrderStatus.Active, labWorkItem: null,
      labHandoff: { state: 'not_sent', code: 'ORDER_ROUTED' }, orderRoute: { id: routeId, effectiveState: 'accepted' } });
  });

  it('reads the route before the UPDATE, under the row lock, and again after the order-change trigger ran', async () => {
    const { service, log } = fake(row(OrderStatus.Active), row(OrderStatus.Active, '2'), [route('sent'), route('withdrawn')]);
    const updated = await service.update(context, patientId, encounterId, requestId,
      { priority: 'stat', expectedRowVersion: 1, changeReason: 'Urgent' } as never);
    expect(log).toEqual(['tx: select id, encounter_id', 'tx: C4', 'tx: update ehr.lab_requests set', 'tx: C4']);
    expect(updated).toMatchObject({ labHandoff: { state: 'not_sent', code: 'ORDER_ROUTED' },
      orderRoute: { effectiveState: 'withdrawn' } });
  });

  it('hands off as before when the order has no route, answering orderRoute null', async () => {
    const { service, labApi } = fake(row(OrderStatus.Draft), row(OrderStatus.Active, '2'));
    const updated = await service.update(context, patientId, encounterId, requestId,
      { status: OrderStatus.Active, expectedRowVersion: 1, changeReason: 'Start' } as never);
    expect(labApi.acceptEhrOrder).toHaveBeenCalledTimes(1);
    expect(updated).toMatchObject({ labHandoff: { state: 'accepted' }, orderRoute: null });
  });

  it('hands off when the only route was declined, withdrawn or expired unaccepted', async () => {
    const { service, labApi } = fake(row(OrderStatus.Draft), row(OrderStatus.Active, '2'), [route('declined')]);
    await service.update(context, patientId, encounterId, requestId,
      { status: OrderStatus.Active, expectedRowVersion: 1, changeReason: 'Start' } as never);
    expect(labApi.acceptEhrOrder).toHaveBeenCalledTimes(1);
  });

  it.each([['sent', null], ['accepted', '2026-10-02T09:00:00Z'], ['completed', '2026-10-02T09:00:00Z'],
    ['cancelled', '2026-10-02T09:00:00Z']])('sendToLab refuses a request whose route is %s with 409 LAB_REQUEST_ROUTED, without contacting Lab',
    async (state, acceptedAt) => {
      const { service, labApi } = fake(row(OrderStatus.Active), row(OrderStatus.Active), [route(state, acceptedAt)]);
      await expect(service.sendToLab(context, patientId, encounterId, requestId, { expectedRowVersion: 1 }))
        .rejects.toMatchObject({ status: 409, code: 'LAB_REQUEST_ROUTED' });
      expect(labApi.acceptEhrOrder).not.toHaveBeenCalled();
    });

  it('sendToLab sends a request with no route as before', async () => {
    const { service, labApi } = fake(row(OrderStatus.Active));
    await expect(service.sendToLab(context, patientId, encounterId, requestId, { expectedRowVersion: 1 }))
      .resolves.toEqual({ id: 'work-item' });
    expect(labApi.acceptEhrOrder).toHaveBeenCalledTimes(1);
  });

  it('lists each request with its latest route, and the page with crossFacilityOrders read by a pool query after the transaction', async () => {
    const { service, log } = fake(row(OrderStatus.Active), row(OrderStatus.Active), [route('sent')]);
    const page = await service.list(context, patientId, encounterId, { limit: 10 } as never);
    expect(page).toMatchObject({ crossFacilityOrders: true, items: [{ id: requestId, orderRoute: { id: routeId } }] });
    expect(log).toEqual(['tx: select id, encounter_id', 'tx: C4', 'pool: control']);
  });

  it('gets a request with its latest route', async () => {
    const { service } = fake(row(OrderStatus.Active), row(OrderStatus.Active), [null]);
    await expect(service.get(context, patientId, encounterId, requestId)).resolves.toMatchObject({ id: requestId,
      orderRoute: null });
  });

  it('leaves orderRoute out of the list under emergency access (V7)', async () => {
    const { service } = fake(row(OrderStatus.Active), row(OrderStatus.Active), [route('sent')]);
    const page = await service.list({ ...context, purposeOfUse: 'emergency' }, patientId, encounterId, { limit: 10 } as never);
    expect(page.items[0]).not.toHaveProperty('orderRoute');
  });
});

describe('PrescriptionsService with routes to other facilities (P4c)', () => {
  const prescription = (status: OrderStatus) => ({ id: requestId, encounterId, patientId, facilityId,
    createdBy: accountId, createdByMembershipId: membershipId, medicationCodeSystem: null, medicationCode: null,
    medicationDisplay: 'Amoxicillin', doseQuantity: null, doseUnit: null, routeCode: null, frequency: 'tds',
    instructions: 'After food', startsOn: null, endsOn: null, status, rowVersion: '3',
    createdAt: new Date('2026-08-10T10:00:00Z'), updatedAt: new Date('2026-08-10T10:00:00Z'), cursorAt: createdAtExact });
  const build = (found: OrderRouteSummary | null) => {
    const pharmacyApi = { acceptEhrPrescription: jest.fn().mockResolvedValue({ id: 'pharmacy-work-item' }) };
    const repository = { run: jest.fn(async (_c: unknown, _p: unknown, _a: unknown, _e: unknown,
      operation: (client: unknown) => Promise<{ value: unknown }>) =>
      (await operation({ query: jest.fn().mockResolvedValue({ rows: [prescription(OrderStatus.Active)] }) })).value) };
    const reader = { summary: jest.fn(async () => found),
      summaries: jest.fn(async (_c: unknown, _x: unknown, _k: unknown, _p: unknown, ids: string[]) =>
        new Map(found ? ids.map((id) => [id, found] as const) : [])),
      crossFacilityOrdersEnabled: jest.fn(async () => false) };
    return { pharmacyApi, reader, service: new PrescriptionsService(repository as never, pharmacyApi as never, reader as never) };
  };

  it.each([['sent', null], ['accepted', '2026-10-02T09:00:00Z'], ['cancelled', '2026-10-02T09:00:00Z']])(
    'acceptForPharmacy refuses a prescription whose route is %s with 409 PRESCRIPTION_ROUTED, without contacting Pharmacy',
    async (state, acceptedAt) => {
      const { service, pharmacyApi } = build({ ...route(state, acceptedAt), kind: 'prescription' });
      await expect(service.acceptForPharmacy({ ...context, actor: { ...context.actor, permissions: ['pharmacy.work-item.accept'] } },
        patientId, encounterId, requestId, { expectedRowVersion: 3, reason: 'Reviewed for Pharmacy' }, 'handoff-key-1234'))
        .rejects.toMatchObject({ status: 409, code: 'PRESCRIPTION_ROUTED' });
      expect(pharmacyApi.acceptEhrPrescription).not.toHaveBeenCalled();
    });

  it('acceptForPharmacy hands off a prescription with no route as before', async () => {
    const { service, pharmacyApi } = build(null);
    await service.acceptForPharmacy(context, patientId, encounterId, requestId,
      { expectedRowVersion: 3, reason: 'Reviewed for Pharmacy' }, 'handoff-key-1234');
    expect(pharmacyApi.acceptEhrPrescription).toHaveBeenCalledTimes(1);
  });

  it('lists prescriptions with their latest route and the crossFacilityOrders flag', async () => {
    const { service, reader } = build({ ...route('declined'), kind: 'prescription' });
    const page = await service.list(context, patientId, encounterId, { limit: 10 } as never);
    expect(page).toMatchObject({ crossFacilityOrders: false, items: [{ id: requestId, orderRoute: { effectiveState: 'declined' } }] });
    expect(reader.summaries).toHaveBeenCalledWith(expect.anything(), context, 'prescription', patientId, [requestId]);
  });
});
