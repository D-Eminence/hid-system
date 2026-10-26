import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { AUDIT_ACTION, INTERNAL_CALLER, PUBLIC_ROUTE, REQUIRED_PERMISSIONS } from '../common/decorators';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import { requestDigest } from '../common/idempotency';
import type { DataAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import type { IdentityService } from '../identity/identity.service';
import { AcceptOrderRouteDto, DeclineOrderRouteDto, ListOrderRoutesQueryDto, SearchOrderRoutesDto } from './dto/order-route.dto';
import { labOrderRouteProblem } from './lab-order-route.mapping';
import { LabOrderRoutesController } from './lab-order-routes.controller';
import { LabOrderRoutesService, normalizedIdentifier, normalizedReference } from './lab-order-routes.service';
import { LabWorkItemsService } from './lab-work-items.service';
import { LabOrderRouteAccess } from './order-route-access';
import { LabOrderRouteCards, orderRouteCard } from './order-route-cards';

const facilityId = '10000000-0000-4000-8000-000000000001';
const patientId = '50000000-0000-4000-8000-000000000001';
const routeId = 'b0000000-0000-4000-8000-000000000001';
const workItemId = '60000000-0000-4000-8000-000000000001';
const sourceOrderId = 'c0000000-0000-4000-8000-000000000001';
const key = 'route-accept-key-0001';
const context = { correlationId: 'lab-route-correlation', facilityId, membershipId: '40000000-0000-4000-8000-000000000001',
  purposeOfUse: 'direct-care', actor: { id: 'actor', subject: 'staff:lab', accountId: '20000000-0000-4000-8000-000000000001',
    roles: ['lab'], permissions: ['lab.order-route.receive', 'lab.work-item.read'], facilityIds: [facilityId], facilities: [],
    authenticationMethod: 'local' } } satisfies DataAccessContext;

const databaseError = (code: string, message: string) => Object.assign(new Error(message), { code });

/** The service over a fake client: `answers` maps a function name to its rows or error. */
function harness(answers: Record<string, unknown[] | Error> = {}, flags = { orders: true, work: true }) {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const client = { query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
    statements.push({ sql, values });
    if (sql.includes('from lab.work_items where id = $1')) return { rows: [{ patient_id: patientId }] };
    const name = /from\s+([a-z_]+\.[a-z_]+)\(/i.exec(sql)?.[1] ?? '';
    const answer = answers[name];
    if (answer instanceof Error) throw answer;
    return { rows: answer ?? [] };
  }) };
  const options: unknown[] = [];
  const database = {
    withTransaction: jest.fn(async <T>(_c: DataAccessContext, fn: (c: PoolClient) => Promise<T>, option?: unknown) => {
      options.push(option);
      return fn(client as unknown as PoolClient);
    }),
    query: jest.fn(async () => ({ rows: [flags] })),
  } as unknown as DatabaseService & { query: jest.Mock; withTransaction: jest.Mock };
  const audits: Array<Record<string, unknown>> = [];
  const audit = { recordWithClient: jest.fn(async (_c: unknown, event: Record<string, unknown>) => { audits.push(event); }) } as
    unknown as AuditService;
  const service = new LabOrderRoutesService(database, audit, new LabOrderRouteCards(database));
  return { service, statements, audits, database, options };
}

const incoming = { route_id: routeId, reference: 'B0000000', row_version: '1', effective_state: 'sent',
  ordering_facility_name: 'Ordering Hospital', orderer_name: 'Dr Ada Obi', orderer_licence_body: 'MDCN',
  test_code_system: 'loinc', test_code: '718-7', test_display: 'Hemoglobin', priority: 'stat', specimen_type_code: 'blood',
  created_at: new Date('2026-10-25T09:00:00Z'), respond_by: new Date('2026-11-01T09:00:00Z'), accept_locked: false,
  attempts_left: 5,
  // Never answered, whatever the database returns (PRIV P4.3, P11).
  patient_id: patientId, source_lab_request_id: sourceOrderId, orderer_account_id: 'x', clinical_information: null };

describe('Lab order-route routes (SPEC-FINAL §10.2)', () => {
  it('serves six browser routes, all needing lab.order-route.receive, none internal or public', () => {
    const base = Reflect.getMetadata(PATH_METADATA, LabOrderRoutesController) as string;
    const routes = Object.getOwnPropertyNames(LabOrderRoutesController.prototype).filter((name) => name !== 'constructor')
      .map((name) => {
        const handler = (LabOrderRoutesController.prototype as unknown as Record<string, object>)[name]!;
        return [Reflect.getMetadata(METHOD_METADATA, handler), `${base}/${Reflect.getMetadata(PATH_METADATA, handler)}`.replace(/\/\/?$/, ''),
          Reflect.getMetadata(HTTP_CODE_METADATA, handler), Reflect.getMetadata(REQUIRED_PERMISSIONS, handler),
          Reflect.getMetadata(AUDIT_ACTION, handler), Reflect.getMetadata(INTERNAL_CALLER, handler),
          Reflect.getMetadata(PUBLIC_ROUTE, handler)];
      });
    expect(routes).toEqual([
      [RequestMethod.GET, 'lab/order-routes', undefined, ['lab.order-route.receive'], 'lab.order-route.list.request', undefined, undefined],
      // Find by Health ID with the Health ID in the body (CODEX §26).
      [RequestMethod.POST, 'lab/order-routes/search', 200, ['lab.order-route.receive'], 'lab.order-route.list.request',
        undefined, undefined],
      [RequestMethod.GET, 'lab/order-routes/:routeId', undefined, ['lab.order-route.receive'], 'lab.order-route.read.request',
        undefined, undefined],
      [RequestMethod.POST, 'lab/order-routes/:routeId/accept', 201, ['lab.order-route.receive'], 'lab.order-route.accept.request',
        undefined, undefined],
      [RequestMethod.POST, 'lab/order-routes/:routeId/decline', 200, ['lab.order-route.receive'], 'lab.order-route.decline.request',
        undefined, undefined],
      // Item 3 (C25): accepted for someone who was not the order's patient.
      [RequestMethod.POST, 'lab/order-routes/:routeId/wrong-patient', 200, ['lab.order-route.receive'],
        'lab.order-route.wrong-patient.request', undefined, undefined],
    ]);
  });

  it('requires an Idempotency-Key to accept', () => {
    const service = { accept: jest.fn() };
    const controller = new LabOrderRoutesController(service as never);
    expect(() => controller.accept(routeId, {} as AcceptOrderRouteDto, undefined, {} as never))
      .toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REQUIRED' }));
    expect(service.accept).not.toHaveBeenCalled();
  });

  it('validates the bodies and the query', async () => {
    const errors = async (type: new () => object, input: unknown) =>
      (await validate(plainToInstance(type, input), { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true }))
        .map((error) => error.property).sort();
    expect(await errors(AcceptOrderRouteDto, { expectedVersion: 1, patientIdentifier: { kind: 'health_id', value: 'HID-ABC234' } }))
      .toEqual([]);
    expect(await errors(AcceptOrderRouteDto, { expectedVersion: 1, patientIdentifier: { kind: 'nin', value: '1' } }))
      .toEqual(['patientIdentifier']);
    expect(await errors(AcceptOrderRouteDto, { expectedVersion: 1 })).toEqual(['patientIdentifier']);
    expect(await errors(AcceptOrderRouteDto, { expectedVersion: 1, patientIdentifier: { kind: 'date_of_birth', value: '1990-01-01' },
      reason: 'x' })).toEqual(['reason']);
    expect(await errors(DeclineOrderRouteDto, { expectedVersion: 2, reason: 'test_not_offered' })).toEqual([]);
    expect(await errors(DeclineOrderRouteDto, { expectedVersion: 2, reason: 'busy' })).toEqual(['reason']);
    expect(await errors(ListOrderRoutesQueryDto, { view: 'recent' })).toEqual([]);
    expect(await errors(ListOrderRoutesQueryDto, { view: 'all' })).toEqual(['view']);
    expect(await errors(ListOrderRoutesQueryDto, { view: 'incoming', dateOfBirth: '1990-01-01' })).toEqual(['dateOfBirth']);
    // The GET takes no Health ID (CODEX §26): the middleware refuses it first (health-id-in-url.spec.ts), and
    // validation would still refuse it as an unknown key.
    expect(await errors(ListOrderRoutesQueryDto, { view: 'incoming', healthId: 'HID-ABC234' })).toEqual(['healthId']);
    expect(await errors(SearchOrderRoutesDto, { view: 'incoming', healthId: 'HID-ABC234' })).toEqual([]);
    expect(await errors(SearchOrderRoutesDto, { healthId: 'HID-ABC234' })).toEqual([]);
    expect(await errors(SearchOrderRoutesDto, { view: 'incoming' })).toEqual(['healthId']);
    expect(await errors(SearchOrderRoutesDto, { healthId: 'HID-ABC234', dateOfBirth: '1990-01-01' })).toEqual(['dateOfBirth']);
    expect(await errors(AcceptOrderRouteDto, { expectedVersion: 1, patientIdentifier: { kind: 'date_of_birth', value: '1990-01-01' },
      reference: 'b0000000' })).toEqual([]);
    expect(await errors(AcceptOrderRouteDto, { expectedVersion: 1, patientIdentifier: { kind: 'date_of_birth', value: '1990-01-01' },
      reference: 7 })).toEqual(['reference']);
  });
});

describe('LabOrderRoutesService list and get (C7, C8)', () => {
  it('lists Incoming as previews, never the patient, clinical information, licence number or source ids', async () => {
    const h = harness({ 'lab.list_order_routes': [incoming] }, { orders: true, work: false });
    const answer = await h.service.search(context, { view: 'incoming', healthId: ' hid-abc234 ' });
    expect(h.statements[0]).toEqual({ sql: 'select * from lab.list_order_routes($1, $2)', values: ['incoming', 'HID-ABC234'] });
    expect(h.options).toEqual([{ isolationLevel: 'READ COMMITTED' }]);
    expect(answer).toEqual({ crossFacilityOrders: true, crossFacilityWork: false, items: [{ id: routeId, reference: 'B0000000',
      version: 1, effectiveState: 'sent', orderingFacilityName: 'Ordering Hospital', orderer: { name: 'Dr Ada Obi', licenceBody: 'MDCN' },
      test: { codeSystem: 'loinc', code: '718-7', name: 'Hemoglobin' }, priority: 'stat', specimenTypeCode: 'blood',
      sentAt: '2026-10-25T09:00:00.000Z', respondBy: '2026-11-01T09:00:00.000Z', acceptLocked: false, attemptsLeft: 5 }] });
    expect(JSON.stringify(answer)).not.toMatch(new RegExp(`${patientId}|${sourceOrderId}`));
    // The list's row names no patient and never the Health ID searched for (PRIV P4.1).
    expect(h.audits).toEqual([expect.objectContaining({ action: 'lab.order-route.list', facilityId,
      resourceType: 'order-route-collection', details: { view: 'incoming', resultCount: 1, byHealthId: true } })]);
    expect(h.audits[0]).not.toHaveProperty('patientId');
    expect(JSON.stringify(h.audits)).not.toContain('ABC234');
  });

  it('defaults to Incoming and refuses a malformed Health ID with 400 before the database', async () => {
    const h = harness({ 'lab.list_order_routes': [] });
    await h.service.list(context, {});
    expect(h.statements[0]?.values).toEqual(['incoming', null]);
    await h.service.search(context, { healthId: 'HID-ABC234' });
    expect(h.statements[1]?.values).toEqual(['incoming', 'HID-ABC234']);
    await expect(h.service.search(context, { healthId: 'HID-0O1I' })).rejects.toMatchObject({ status: 400, code: 'ORDER_ROUTE_INVALID' });
    expect(h.statements).toHaveLength(2);
    // The GET's list never filters by a Health ID, whatever reaches it.
    await h.service.list(context, { view: 'recent', healthId: 'HID-ABC234' } as never);
    expect(h.statements[2]?.values).toEqual(['recent', null]);
    expect(h.statements).toHaveLength(3);
  });

  it('lists Recent as metadata, with the work item and test name once accepted', async () => {
    const h = harness({ 'lab.list_order_routes': [{ route_id: routeId, reference: 'B0000000', row_version: 3,
      effective_state: 'completed', ordering_facility_name: 'Ordering Hospital', created_at: '2026-10-25T09:00:00Z',
      ended_at: null, work_item_id: workItemId, test_name: 'Hemoglobin', patient_id: patientId }] });
    const answer = await h.service.list(context, { view: 'recent' });
    expect(answer.items).toEqual([{ id: routeId, reference: 'B0000000', version: 3, effectiveState: 'completed',
      orderingFacilityName: 'Ordering Hospital', sentAt: '2026-10-25T09:00:00.000Z', endedAt: null, workItemId,
      testName: 'Hemoglobin' }]);
  });

  it('answers the controls closed when they cannot be read', async () => {
    const h = harness({ 'lab.list_order_routes': [] });
    h.database.query.mockRejectedValueOnce(databaseError('22023', 'PLATFORM_CONTROL_INVALID'));
    await expect(h.service.list(context, {})).resolves.toMatchObject({ crossFacilityOrders: false, crossFacilityWork: false });
  });

  it('shows a route before acceptance without the patient, and names no patient on the read row', async () => {
    const h = harness({ 'lab.get_order_route': [incoming] });
    const answer = await h.service.get(context, routeId);
    expect(answer).not.toHaveProperty('patient');
    expect(answer).not.toHaveProperty('clinicalInformation');
    expect(answer.orderer).toEqual({ name: 'Dr Ada Obi', licenceBody: 'MDCN' });
    expect(h.audits).toEqual([expect.objectContaining({ action: 'lab.order-route.read', resourceType: 'order-route',
      resourceId: routeId, details: { routeId, kind: 'lab_request', state: 'sent' } })]);
    expect(h.audits[0]).not.toHaveProperty('patientId');
  });

  it('shows an accepted route with what the database gives while readable, naming the patient on the row', async () => {
    const h = harness({ 'lab.get_order_route': [{ ...incoming, effective_state: 'accepted', clinical_information: 'Fatigue',
      orderer_licence_number: 'MDCN/12345', work_item_id: workItemId, patient_full_name: 'Ngozi Eze', patient_sex: 'female',
      patient_date_of_birth: '1990-01-01', patient_health_id_last4: '2345' }] });
    const answer = await h.service.get(context, routeId);
    expect(answer).toMatchObject({ clinicalInformation: 'Fatigue', workItemId,
      orderer: { name: 'Dr Ada Obi', licenceBody: 'MDCN', licenceNumber: 'MDCN/12345' },
      patient: { fullName: 'Ngozi Eze', sex: 'female', dateOfBirth: '1990-01-01', healthIdLast4: '2345' } });
    expect(answer).not.toHaveProperty('patientId');
    expect(h.audits).toEqual([expect.objectContaining({ action: 'lab.order-route.read', patientId })]);
  });

  it('answers a route not addressed here 404 ORDER_ROUTE_NOT_FOUND', async () => {
    const h = harness({ 'lab.get_order_route': databaseError('P0002', 'ORDER_ROUTE_NOT_FOUND') });
    await expect(h.service.get(context, routeId)).rejects.toMatchObject({ status: 404, code: 'ORDER_ROUTE_NOT_FOUND' });
    expect(h.audits).toEqual([]);
  });
});

describe('LabOrderRoutesService accept (C9) and decline (C10)', () => {
  const input = (kind: 'health_id' | 'date_of_birth', value: string) => ({ expectedVersion: 1, patientIdentifier: { kind, value } });
  const accepted = { result: 'accepted', attempts_left: null, route_row_version: '2', work_item_id: workItemId,
    patient_full_name: 'Ngozi Eze', patient_sex: 'female', patient_date_of_birth: '1990-01-01', patient_health_id_last4: '2345',
    clinical_information: 'Fatigue', orderer_licence_body: 'MDCN', orderer_licence_number: 'MDCN/12345', replayed: false };

  it('accepts with the normalized identifier and a digest of it, naming the patient on the row and answering the card', async () => {
    const h = harness({ 'lab.accept_order_route': [accepted] });
    const answer = await h.service.accept(context, routeId, input('health_id', ' hid-abc234'), key);
    expect(h.statements[0]).toEqual({ sql: 'select * from lab.accept_order_route($1, $2, $3, $4, $5, $6, $7)',
      values: [routeId, 1, 'health_id', 'HID-ABC234', key, requestDigest('lab.order-route.accept',
        { routeId, expectedVersion: 1, identifierKind: 'health_id', identifier: 'HID-ABC234' }), null] });
    expect(h.options).toEqual([{ isolationLevel: 'READ COMMITTED' }]);
    expect(answer).toEqual({ route: { id: routeId, version: 2, effectiveState: 'accepted' }, workItemId,
      patient: { fullName: 'Ngozi Eze', sex: 'female', dateOfBirth: '1990-01-01', healthIdLast4: '2345' },
      clinicalInformation: 'Fatigue', orderer: { licenceBody: 'MDCN', licenceNumber: 'MDCN/12345' }, replayed: false });
    expect(h.audits).toEqual([expect.objectContaining({ action: 'lab.order-route.accept', outcome: 'success', patientId,
      details: { routeId, kind: 'lab_request', state: 'accepted', workItemId, identifierKind: 'health_id', withReference: false,
        replayed: false } })]);
    expect(JSON.stringify(h.audits)).not.toMatch(/ABC234|Ngozi|MDCN\/12345|Fatigue/);
  });

  it('passes the order\'s reference with a date of birth, upper-cased, and digests it', async () => {
    const h = harness({ 'lab.accept_order_route': [accepted] });
    await h.service.accept(context, routeId, { ...input('date_of_birth', '1990-01-01'), reference: ' b0000000 ' }, key);
    expect(h.statements[0]?.values).toEqual([routeId, 1, 'date_of_birth', '1990-01-01', key, requestDigest('lab.order-route.accept',
      { routeId, expectedVersion: 1, identifierKind: 'date_of_birth', identifier: '1990-01-01', reference: 'B0000000' }),
    'B0000000']);
    expect(h.audits[0]).toMatchObject({ details: expect.objectContaining({ withReference: true }) });
    expect(JSON.stringify(h.audits)).not.toContain('B0000000');
    await expect(h.service.accept(context, routeId, { ...input('date_of_birth', '1990-01-01'), reference: 'REF-1' }, key))
      .rejects.toMatchObject({ status: 400, code: 'ORDER_ROUTE_INVALID' });
    expect(h.statements).toHaveLength(2);
    expect(normalizedReference(undefined)).toBeNull();
  });

  it('commits a mismatch (V6) and answers it after the commit: 409 with attemptsLeft, no patient on the row', async () => {
    const h = harness({ 'lab.accept_order_route': [{ result: 'patient_mismatch', attempts_left: 4, route_row_version: '1' }] });
    const refusal = await h.service.accept(context, routeId, input('date_of_birth', '1990-01-02'), key).catch((e: unknown) => e);
    expect(refusal).toMatchObject({ status: 409, code: 'ORDER_ROUTE_PATIENT_MISMATCH', extensions: { attemptsLeft: 4 } });
    // The transaction returned (and so committed) before the refusal was raised.
    await expect(h.database.withTransaction.mock.results[0]?.value).resolves.toEqual({ refusal });
    expect(h.audits).toEqual([expect.objectContaining({ action: 'lab.order-route.accept', outcome: 'denied',
      details: { routeId, kind: 'lab_request', state: 'sent', result: 'patient_mismatch', identifierKind: 'date_of_birth',
        withReference: false, attemptsLeft: 4 } })]);
    expect(h.audits[0]).not.toHaveProperty('patientId');
    expect(JSON.stringify(h.audits)).not.toContain('1990');
  });

  it.each([['accept_locked', 'ORDER_ROUTE_ACCEPT_LOCKED', 'denied', 'sent'],
    ['order_in_work', 'ORDER_ROUTE_ORDER_IN_WORK', 'failure', 'withdrawn'], ['expired', 'ORDER_ROUTE_EXPIRED', 'failure', 'expired']])(
    'commits the result %s and answers 409 %s', async (result, code, outcome, state) => {
      const h = harness({ 'lab.accept_order_route': [{ result, attempts_left: 0, route_row_version: '2' }] });
      await expect(h.service.accept(context, routeId, input('health_id', 'HID-ABC234'), key)).rejects.toMatchObject({ status: 409, code });
      expect(h.audits).toEqual([expect.objectContaining({ outcome, details: expect.objectContaining({ result, state }) })]);
    });

  it('rolls back and answers 503 for an unknown result', async () => {
    const h = harness({ 'lab.accept_order_route': [{ result: 'perhaps' }] });
    await expect(h.service.accept(context, routeId, input('health_id', 'HID-ABC234'), key))
      .rejects.toMatchObject({ status: 503, code: 'ORDER_ROUTE_UNAVAILABLE' });
    expect(h.audits).toEqual([]);
  });

  it.each([
    ['P0001', 'ORDER_ROUTE_NOT_PENDING', 409], ['P0001', 'ORDER_ROUTE_EXPIRED', 409], ['P0001', 'ORDER_ROUTE_ACCEPT_LOCKED', 409],
    ['P0001', 'ORDER_ROUTE_DESTINATION_INELIGIBLE', 409], ['P0001', 'ORDER_ROUTE_ORDERING_FACILITY_UNAVAILABLE', 409],
    ['P0001', 'ORDER_ROUTE_PATIENT_DENIED', 409], ['P0001', 'ORDER_ROUTE_HEALTH_ID_REQUIRED', 409],
    ['P0001', 'ORDER_ROUTE_REFERENCE_MISMATCH', 409],
    ['P0001', 'IDEMPOTENCY_KEY_REUSED', 409], ['P0001', 'ORDER_ROUTE_ACCEPT_LIMITED', 429],
  ])('answers a raised %s %s as %i with that code', async (state, message, status) => {
    const h = harness({ 'lab.accept_order_route': databaseError(state, message) });
    await expect(h.service.accept(context, routeId, input('health_id', 'HID-ABC234'), key)).rejects.toMatchObject({ status, code: message });
  });

  it.each([
    ['P0001', 'ORDER_ROUTE_VERSION_CONFLICT', 412, 'VERSION_CONFLICT'],
    ['P0002', 'ORDER_ROUTE_NOT_FOUND', 404, 'ORDER_ROUTE_NOT_FOUND'],
    ['55000', 'PLATFORM_CONTROL_DISABLED:cross_facility_orders_enabled', 423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE'],
    ['55000', 'PLATFORM_CONTROL_DISABLED:cross_facility_route_access_enabled', 423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE'],
    ['42501', 'ORDER_ROUTE_PERMISSION_DENIED', 403, 'PERMISSION_DENIED'],
    ['22023', 'ORDER_ROUTE_INVALID', 400, 'ORDER_ROUTE_INVALID'],
    ['P0001', 'SOMETHING_ELSE', 503, 'ORDER_ROUTE_UNAVAILABLE'],
    ['40001', 'could not serialize', 503, 'ORDER_ROUTE_UNAVAILABLE'],
  ])('answers %s %s as %i %s', async (state, message, status, code) => {
    const h = harness({ 'lab.accept_order_route': databaseError(state, message) });
    await expect(h.service.accept(context, routeId, input('health_id', 'HID-ABC234'), key)).rejects.toMatchObject({ status, code });
  });

  it('refuses a malformed identifier with 400 before the database (not counted as a try)', async () => {
    const h = harness();
    await expect(h.service.accept(context, routeId, input('date_of_birth', '1990-02-30'), key))
      .rejects.toMatchObject({ status: 400, code: 'ORDER_ROUTE_INVALID' });
    await expect(h.service.accept(context, routeId, input('date_of_birth', '01/02/1990'), key))
      .rejects.toMatchObject({ status: 400, code: 'ORDER_ROUTE_INVALID' });
    await expect(h.service.accept(context, routeId, input('health_id', 'ABC234'), key))
      .rejects.toMatchObject({ status: 400, code: 'ORDER_ROUTE_INVALID' });
    expect(h.statements).toEqual([]);
    expect(normalizedIdentifier('date_of_birth', ' 1990-01-01 ')).toBe('1990-01-01');
    expect(normalizedIdentifier('health_id', 'hid-abcdef')).toBe('HID-ABCDEF');
  });

  it('declines with a reason code, naming no patient on the row', async () => {
    const h = harness({ 'lab.decline_order_route': [{ row_version: '2', state: 'declined' }] });
    await expect(h.service.decline(context, routeId, { expectedVersion: 1, reason: 'test_not_offered' }))
      .resolves.toEqual({ route: { id: routeId, version: 2, effectiveState: 'declined' } });
    expect(h.statements[0]).toEqual({ sql: 'select row_version, state from lab.decline_order_route($1, $2, $3)',
      values: [routeId, 1, 'test_not_offered'] });
    expect(h.audits).toEqual([expect.objectContaining({ action: 'lab.order-route.decline',
      details: { routeId, kind: 'lab_request', state: 'declined', reason: 'test_not_offered' } })]);
    expect(h.audits[0]).not.toHaveProperty('patientId');
  });

  it('sends attemptsLeft with the problem, and never lets an extension replace a standard member', () => {
    const json = jest.fn();
    const response: { status: jest.Mock; type: jest.Mock; json: jest.Mock } = { status: jest.fn(), type: jest.fn(), json };
    response.status.mockReturnValue(response);
    response.type.mockReturnValue(response);
    const host = { switchToHttp: () => ({ getRequest: () => ({ correlationId: 'c', method: 'POST' }), getResponse: () => response }) };
    new ProblemDetailsFilter().catch(new DomainProblem(409, 'ORDER_ROUTE_PATIENT_MISMATCH', 'No match', undefined,
      { extensions: { attemptsLeft: 3, code: 'HIJACK', status: 200 } }), host as never);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ status: 409, code: 'ORDER_ROUTE_PATIENT_MISMATCH', attemptsLeft: 3 }));
  });

  it('passes a domain problem and a non-database error through', () => {
    const problem = new DomainProblem(409, 'X', 'x');
    expect(labOrderRouteProblem(problem)).toBe(problem);
    const defect = new TypeError('defect');
    expect(labOrderRouteProblem(defect)).toBe(defect);
  });
});

describe('Lab work list with route-backed rows (C12)', () => {
  const card = { work_item_id: workItemId, route_id: routeId, reference: 'B0000000', effective_state: 'accepted', access: 'work',
    ordering_facility_name: 'Ordering Hospital', orderer_name: 'Dr Ada Obi', orderer_licence_body: 'MDCN',
    orderer_licence_number: 'MDCN/12345', patient_full_name: 'Ngozi Eze', patient_sex: 'female', patient_date_of_birth: '1990-01-01',
    patient_health_id_last4: '2345', row_version: '4', ended_kind: null };
  const row = (id: string, routed: boolean) => ({ id, patient_id: patientId, facility_id: facilityId,
    ordering_facility_id: routed ? sourceOrderId : facilityId, source_ehr_order_id: sourceOrderId, source_ehr_order_version: '1',
    source_encounter_id: sourceOrderId, status: 'accepted', priority: 'stat', accepted_by: 'a', accepted_at: new Date(),
    row_version: '1', created_at: new Date(), order_route_id: routed ? routeId : null, test_name: 'Hemoglobin', accession_id: null,
    accession_number: null, specimen_statuses: [] });
  const local = 'd0000000-0000-4000-8000-000000000001';

  const build = (cards: unknown[] | Error, rows = [row(workItemId, true), row(local, false)]) => {
    const statements: string[] = [];
    const client = { query: jest.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes('lab.order_route_cards')) { if (cards instanceof Error) throw cards; return { rows: cards }; }
      if (sql.includes('from lab.work_items w')) return { rows };
      return { rows: [] };
    }) };
    const database = { withTransaction: async <T>(_c: DataAccessContext, fn: (c: PoolClient) => Promise<T>) =>
      fn(client as unknown as PoolClient), query: jest.fn(async () => ({ rows: [{ orders: false, work: true }] })) } as unknown as DatabaseService;
    const identity = { authorize: jest.fn() } as unknown as IdentityService;
    const audits: Array<Record<string, unknown>> = [];
    const audit = { recordWithClient: jest.fn(async (_c: unknown, event: Record<string, unknown>) => { audits.push(event); }) };
    const service = new LabWorkItemsService(database, identity, audit as unknown as AuditService,
      new LabOrderRouteAccess(identity), new LabOrderRouteCards(database));
    return { service, statements, audits, audit };
  };

  it('names each patient the list shows on a route card in one row per patient, ids only, basis order-route', async () => {
    const second = '60000000-0000-4000-8000-000000000002';
    const secondRoute = 'b0000000-0000-4000-8000-000000000002';
    const otherPatient = '50000000-0000-4000-8000-000000000009';
    const third = '60000000-0000-4000-8000-000000000003';
    const { service, audits } = build([card, { ...card, work_item_id: second, route_id: secondRoute },
      { ...card, work_item_id: third, route_id: 'b0000000-0000-4000-8000-000000000003', access: 'none' }],
    [row(workItemId, true), row(second, true), { ...row(third, true), patient_id: otherPatient }, row(local, false)]);
    await service.list(context);
    expect(audits).toEqual([expect.objectContaining({ action: 'lab.work-item.list', patientId, facilityId,
      resourceType: 'lab-work-item', resourceId: workItemId, actorType: 'staff',
      details: { basis: 'order-route', workItemIds: [workItemId, second], orderRouteIds: [routeId, secondRoute] } })]);
    // The card without a patient (access none) and the same-facility row name no one.
    expect(JSON.stringify(audits)).not.toContain(otherPatient);
    expect(JSON.stringify(audits)).not.toMatch(/Ngozi|1990-01-01|2345|MDCN/);
  });

  it('writes no list row when no card shows a patient, and fails the list when its audit fails', async () => {
    const quiet = build(Object.assign(new Error('x'), { code: '42501' }));
    await quiet.service.list(context);
    expect(quiet.audits).toEqual([]);
    const failing = build([card]);
    failing.audit.recordWithClient.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(failing.service.list(context)).rejects.toThrow('audit unavailable');
  });

  it('adds the route card and patient to route-backed rows only, without the other facility\'s order id, and the two flags', async () => {
    const { service, statements } = build([card]);
    const answer = await service.list(context);
    expect(answer.crossFacilityOrders).toBe(false);
    expect(answer.crossFacilityWork).toBe(true);
    const [routed, own] = answer.items;
    expect(routed).toMatchObject({ id: workItemId, priority: 'stat', orderRoute: { id: routeId, reference: 'B0000000',
      effectiveState: 'accepted', access: 'work', version: 4, endedKind: null, orderingFacilityName: 'Ordering Hospital',
      ordererName: 'Dr Ada Obi', ordererLicence: { body: 'MDCN', number: 'MDCN/12345' } },
      patient: { fullName: 'Ngozi Eze', sex: 'female', dateOfBirth: '1990-01-01', healthIdLast4: '2345' } });
    expect(routed).not.toHaveProperty('sourceEhrOrderId');
    expect(own).toMatchObject({ id: local, sourceEhrOrderId: sourceOrderId });
    expect(own).not.toHaveProperty('orderRoute');
    expect(own).not.toHaveProperty('patient');
    expect(statements.filter((sql) => sql.includes('lab.order_route_cards'))).toHaveLength(1);
  });

  it('keeps the rows, without cards or patients, when C12 fails', async () => {
    const { service, statements } = build(Object.assign(new Error('x'), { code: '42501' }));
    const answer = await service.list(context);
    expect(answer.items[0]).not.toHaveProperty('patient');
    expect(answer.items[0]).not.toHaveProperty('orderRoute');
    expect(answer.items[0]).not.toHaveProperty('sourceEhrOrderId');
    expect(statements).toContain('rollback to savepoint lab_order_route_cards');
  });

  it('shows no patient on a card whose route allows no read now', () => {
    expect(orderRouteCard({ ...card, access: 'none', patient_full_name: 'Ngozi Eze' })).not.toHaveProperty('patient');
    expect(orderRouteCard({ ...card, access: 'read', patient_full_name: null })).not.toHaveProperty('patient');
    expect(orderRouteCard({ ...card, orderer_licence_body: null }).orderRoute).not.toHaveProperty('ordererLicence');
  });
});
