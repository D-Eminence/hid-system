import 'reflect-metadata';
import { Logger, RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { PoolClient } from 'pg';
import { INTERNAL_CALLER, PUBLIC_ROUTE, REQUIRED_PERMISSIONS } from '../common/decorators';
import { requestDigest } from '../common/idempotency';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { AcceptOrderRouteDto, DeclineOrderRouteDto, ListOrderRoutesQueryDto, SearchOrderRoutesDto } from './dto/order-route.dto';
import { PharmacyOrderRoutesController } from './pharmacy-order-routes.controller';
import { PharmacyOrderRoutesService, normalizedIdentifier, normalizedReference } from './pharmacy-order-routes.service';
import { PharmacyService } from './pharmacy.service';
import { PharmacyOrderRouteAccess } from './order-route-access';
import { PharmacyOrderRouteCards, receivingFacts } from './order-route-cards';

const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const patientId = '123e4567-e89b-42d3-a456-426614174001';
const routeId = '123e4567-e89b-42d3-a456-426614174010';
const workItemId = '123e4567-e89b-42d3-a456-426614174007';
const dispensingId = '123e4567-e89b-42d3-a456-426614174008';
const prescriptionId = '123e4567-e89b-42d3-a456-426614174005';
const encounterId = '123e4567-e89b-42d3-a456-426614174006';
const key = 'pharmacy-route-key-0001';
const context = { correlationId: 'correlation-123456', facilityId, membershipId: '123e4567-e89b-42d3-a456-426614174004',
  purposeOfUse: 'direct-care', actor: { id: 'a', subject: 'staff:pharmacist', accountId: '123e4567-e89b-42d3-a456-426614174003',
    authenticationMethod: 'local', roles: ['pharmacist'], permissions: ['pharmacy.order-route.receive'], facilityIds: [facilityId],
    facilities: [] } } satisfies DataAccessContext;
const databaseError = (code: string, message: string) => Object.assign(new Error(message), { code });

describe('Pharmacy order-route routes (SPEC-FINAL §10.2)', () => {
  it('serves eight browser routes, all needing pharmacy.order-route.receive, none internal or public', () => {
    const base = Reflect.getMetadata(PATH_METADATA, PharmacyOrderRoutesController) as string;
    const routes = Object.getOwnPropertyNames(PharmacyOrderRoutesController.prototype).filter((name) => name !== 'constructor')
      .map((name) => {
        const handler = (PharmacyOrderRoutesController.prototype as unknown as Record<string, object>)[name]!;
        return [Reflect.getMetadata(METHOD_METADATA, handler), `${base}/${Reflect.getMetadata(PATH_METADATA, handler)}`.replace(/\/\/?$/, ''),
          Reflect.getMetadata(HTTP_CODE_METADATA, handler), Reflect.getMetadata(REQUIRED_PERMISSIONS, handler),
          Reflect.getMetadata(INTERNAL_CALLER, handler), Reflect.getMetadata(PUBLIC_ROUTE, handler)];
      });
    const permission = ['pharmacy.order-route.receive'];
    expect(routes).toEqual([
      [RequestMethod.GET, 'pharmacy/order-routes', undefined, permission, undefined, undefined],
      // Find by Health ID with the Health ID in the body (CODEX §26).
      [RequestMethod.POST, 'pharmacy/order-routes/search', 200, permission, undefined, undefined],
      // D17 (C30): an accepted prescription by its reference, declared before the :routeId routes.
      [RequestMethod.POST, 'pharmacy/order-routes/correctable', 200, permission, undefined, undefined],
      [RequestMethod.GET, 'pharmacy/order-routes/:routeId', undefined, permission, undefined, undefined],
      [RequestMethod.POST, 'pharmacy/order-routes/:routeId/accept', 201, permission, undefined, undefined],
      [RequestMethod.POST, 'pharmacy/order-routes/:routeId/decline', 200, permission, undefined, undefined],
      // Item 3 (C25): accepted for someone who was not the prescription's patient.
      [RequestMethod.POST, 'pharmacy/order-routes/:routeId/wrong-patient', 200, permission, undefined, undefined],
      // D17 (C29): the late correction, after the prescription ended.
      [RequestMethod.POST, 'pharmacy/order-routes/:routeId/wrong-patient-correction', 200, permission, undefined, undefined],
    ]);
  });

  it('requires an Idempotency-Key to accept, and an acceptance reason of 8-500 characters', async () => {
    const controller = new PharmacyOrderRoutesController({ accept: jest.fn() } as never);
    expect(() => controller.accept(routeId, {} as AcceptOrderRouteDto, undefined, {} as never))
      .toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REQUIRED' }));
    const errors = async (type: new () => object, input: unknown) =>
      (await validate(plainToInstance(type, input), { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true }))
        .map((error) => error.property).sort();
    const accept = { expectedVersion: 1, patientIdentifier: { kind: 'date_of_birth', value: '1990-01-01' },
      reason: 'Patient at the counter' };
    expect(await errors(AcceptOrderRouteDto, accept)).toEqual([]);
    expect(await errors(AcceptOrderRouteDto, { ...accept, reason: '  short  ' })).toEqual(['reason']);
    expect(await errors(AcceptOrderRouteDto, { ...accept, reason: undefined })).toEqual(['reason']);
    expect(await errors(AcceptOrderRouteDto, { ...accept, patientIdentifier: { kind: 'phone', value: '080' } }))
      .toEqual(['patientIdentifier']);
    expect(await errors(DeclineOrderRouteDto, { expectedVersion: 1, reason: 'medicine_unavailable' })).toEqual([]);
    expect(await errors(DeclineOrderRouteDto, { expectedVersion: 1, reason: 'Out of stock' })).toEqual(['reason']);
    expect(await errors(AcceptOrderRouteDto, { ...accept, reference: '123e4567' })).toEqual([]);
    expect(await errors(AcceptOrderRouteDto, { ...accept, reference: 7 })).toEqual(['reference']);
    // The GET takes no Health ID (CODEX §26): the middleware refuses it first (health-id-in-url.spec.ts), and
    // validation would still refuse it as an unknown key.
    expect(await errors(ListOrderRoutesQueryDto, { view: 'incoming', healthId: 'HID-ABC234' })).toEqual(['healthId']);
    expect(await errors(SearchOrderRoutesDto, { view: 'recent', healthId: 'HID-ABC234' })).toEqual([]);
    expect(await errors(SearchOrderRoutesDto, { view: 'incoming' })).toEqual(['healthId']);
  });
});

/** Item 4 (0089): the one statement that reads whether this facility receives, and its savepoint. */
const RECEIVES = 'select pharmacy.order_route_receives_here() as receives, pharmacy.order_routes_here() as routes_here';
const RECEIVES_STATEMENTS = [{ sql: 'savepoint pharmacy_order_route_receives', values: [] }, { sql: RECEIVES, values: [] },
  { sql: 'release savepoint pharmacy_order_route_receives', values: [] }];

/** `receiving` answers the read of whether this facility receives (item 4): the database's NULLs by default. */
function routesHarness(answers: Record<string, unknown[] | Error> = {},
  receiving: unknown[] | Error = [{ receives: null, routes_here: null }]) {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const client = { query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
    statements.push({ sql, values });
    if (sql === RECEIVES) { if (receiving instanceof Error) throw receiving; return { rows: receiving }; }
    if (sql.includes('from pharmacy.work_items where id = $1')) return { rows: [{ patient_id: patientId }] };
    const name = /from\s+([a-z_]+\.[a-z_]+)\(/i.exec(sql)?.[1] ?? '';
    const answer = answers[name];
    if (answer instanceof Error) throw answer;
    return { rows: answer ?? [] };
  }) };
  const options: unknown[] = [];
  const database = {
    withTransaction: jest.fn(async <T>(_c: DataAccessContext, fn: (c: PoolClient) => Promise<T>, option?: unknown) => {
      options.push(option); return fn(client as unknown as PoolClient);
    }),
    query: jest.fn(async () => ({ rows: [{ orders: true, work: true }] })),
  };
  const audits: Array<[string, Record<string, unknown>, Record<string, unknown>, string | undefined]> = [];
  const audit = { recordWithClient: jest.fn(async (_c: unknown, _ctx: unknown, action: string, resource: Record<string, unknown>,
    details: Record<string, unknown> = {}, outcome?: string) => { audits.push([action, resource, details, outcome]); }) };
  const service = new PharmacyOrderRoutesService(database as never, audit as never, new PharmacyOrderRouteCards(database as never));
  return { service, statements, audits, options, database, client, audit };
}

/** The list statements alone (each list also reads whether this facility receives, item 4). */
const listStatements = (statements: ReadonlyArray<{ sql: string; values: readonly unknown[] }>) =>
  statements.filter((statement) => statement.sql.includes('pharmacy.list_order_routes'));

const incoming = { route_id: routeId, reference: '123E4567', row_version: 1, effective_state: 'sent',
  ordering_facility_name: 'Ordering Hospital', orderer_name: 'Dr Ada Obi', orderer_licence_body: null,
  medication_code_system: 'rxnorm', medication_code: '723', medication_display: 'Amoxicillin 500 mg', dose_quantity: '1',
  dose_unit: 'capsule', route_code: 'oral', frequency: 'tds', starts_on: '2026-10-25', ends_on: '2026-11-01',
  prescribed_at: '2026-10-25T08:00:00Z', created_at: '2026-10-25T09:00:00Z', respond_by: '2026-11-01T09:00:00Z',
  accept_locked: false, attempts_left: 5, patient_id: patientId, source_prescription_id: prescriptionId, instructions: null };

describe('PharmacyOrderRoutesService (C13-C16)', () => {
  it('lists Incoming previews without the patient, the instructions or source ids, with the flags', async () => {
    const h = routesHarness({ 'pharmacy.list_order_routes': [incoming] });
    const answer = await h.service.list(context, { view: 'incoming' });
    expect(h.statements).toEqual([{ sql: 'select * from pharmacy.list_order_routes($1, $2)', values: ['incoming', null] },
      ...RECEIVES_STATEMENTS]);
    expect(h.options).toEqual([{ isolationLevel: 'READ COMMITTED' }]);
    expect(answer).toEqual({ crossFacilityOrders: true, crossFacilityWork: true, items: [{ id: routeId, reference: '123E4567',
      version: 1, effectiveState: 'sent', orderingFacilityName: 'Ordering Hospital', orderer: { name: 'Dr Ada Obi', licenceBody: null },
      medication: { codeSystem: 'rxnorm', code: '723', display: 'Amoxicillin 500 mg' }, doseQuantity: '1', doseUnit: 'capsule',
      routeCode: 'oral', frequency: 'tds', startsOn: '2026-10-25', endsOn: '2026-11-01', prescribedAt: '2026-10-25T08:00:00.000Z',
      sentAt: '2026-10-25T09:00:00.000Z', respondBy: '2026-11-01T09:00:00.000Z', acceptLocked: false, attemptsLeft: 5 }] });
    expect(JSON.stringify(answer)).not.toMatch(new RegExp(`${patientId}|${prescriptionId}`));
    expect(h.audits).toEqual([['pharmacy.order-route.list', { resourceType: 'order-route-collection', resourceId: facilityId },
      { view: 'incoming', resultCount: 1, byHealthId: false }, undefined]]);
  });

  it('finds by the Health ID from the body, never the URL, and audits no Health ID', async () => {
    const h = routesHarness({ 'pharmacy.list_order_routes': [incoming] });
    await h.service.search(context, { healthId: ' hid-abc234 ' });
    expect(listStatements(h.statements)[0]?.values).toEqual(['incoming', 'HID-ABC234']);
    expect(h.audits[0]?.[2]).toEqual({ view: 'incoming', resultCount: 1, byHealthId: true });
    expect(JSON.stringify(h.audits)).not.toContain('ABC234');
    const before = h.statements.length;
    await expect(h.service.search(context, { view: 'recent', healthId: 'HID-0O1I' }))
      .rejects.toMatchObject({ status: 400, code: 'ORDER_ROUTE_INVALID' });
    expect(h.statements).toHaveLength(before);
    expect(listStatements(h.statements)).toHaveLength(1);
    // The GET's list never filters by a Health ID, whatever reaches it.
    await h.service.list(context, { view: 'incoming', healthId: 'HID-ABC234' } as never);
    expect(listStatements(h.statements)[1]?.values).toEqual(['incoming', null]);
  });

  it('shows an accepted route\'s instructions and patient only as the database gives them, naming the patient on the row', async () => {
    const h = routesHarness({ 'pharmacy.get_order_route': [{ ...incoming, effective_state: 'accepted', instructions: 'After food',
      work_item_id: workItemId, patient_full_name: 'Ngozi Eze', patient_sex: 'female', patient_date_of_birth: '1990-01-01',
      patient_health_id_last4: '2345' }] });
    const answer = await h.service.get(context, routeId);
    expect(answer).toMatchObject({ instructions: 'After food', workItemId, patient: { fullName: 'Ngozi Eze', healthIdLast4: '2345' } });
    expect(h.audits[0]?.[1]).toEqual({ resourceType: 'order-route', resourceId: routeId, patientId });
  });

  it('accepts with the identifier and the reason, the digest covering both', async () => {
    const h = routesHarness({ 'pharmacy.accept_order_route': [{ result: 'accepted', route_row_version: '2', work_item_id: workItemId,
      patient_full_name: 'Ngozi Eze', patient_sex: 'female', patient_date_of_birth: '1990-01-01', patient_health_id_last4: '2345',
      instructions: 'After food', orderer_licence_body: 'MDCN', orderer_licence_number: 'MDCN/1', replayed: false }] });
    const input = { expectedVersion: 1, patientIdentifier: { kind: 'date_of_birth' as const, value: '1990-01-01' },
      reason: 'Patient at the counter' };
    const answer = await h.service.accept(context, routeId, input, key);
    expect(h.statements[0]).toEqual({ sql: 'select * from pharmacy.accept_order_route($1, $2, $3, $4, $5, $6, $7, $8)',
      values: [routeId, 1, 'date_of_birth', '1990-01-01', 'Patient at the counter', key, requestDigest('pharmacy.order-route.accept',
        { routeId, expectedVersion: 1, identifierKind: 'date_of_birth', identifier: '1990-01-01', reason: 'Patient at the counter' }),
      null] });
    expect(answer).toEqual({ route: { id: routeId, version: 2, effectiveState: 'accepted' }, workItemId,
      patient: { fullName: 'Ngozi Eze', sex: 'female', dateOfBirth: '1990-01-01', healthIdLast4: '2345' }, instructions: 'After food',
      orderer: { licenceBody: 'MDCN', licenceNumber: 'MDCN/1' }, replayed: false });
    expect(h.audits[0]).toEqual(['pharmacy.order-route.accept', { resourceType: 'order-route', resourceId: routeId, patientId },
      { routeId, kind: 'prescription', state: 'accepted', workItemId, identifierKind: 'date_of_birth', withReference: false,
        replayed: false }, undefined]);
    // With the order's reference: passed upper-cased and covered by the digest, never audited itself.
    const withReference = routesHarness({ 'pharmacy.accept_order_route': [{ result: 'accepted', route_row_version: '2',
      work_item_id: workItemId, replayed: false }] });
    await withReference.service.accept(context, routeId, { ...input, reference: ' 123e4567 ' }, key);
    expect(withReference.statements[0]?.values.slice(-2)).toEqual([requestDigest('pharmacy.order-route.accept',
      { routeId, expectedVersion: 1, identifierKind: 'date_of_birth', identifier: '1990-01-01', reason: 'Patient at the counter',
        reference: '123E4567' }), '123E4567']);
    expect(withReference.audits[0]?.[2]).toMatchObject({ withReference: true });
    expect(JSON.stringify(withReference.audits)).not.toContain('123E4567');
    await expect(withReference.service.accept(context, routeId, { ...input, reference: 'REF-1' }, key))
      .rejects.toMatchObject({ status: 400, code: 'ORDER_ROUTE_INVALID' });
    expect(normalizedReference(undefined)).toBeNull();
  });

  it('commits a mismatch with a denied row and answers 409 with attemptsLeft after the commit', async () => {
    const h = routesHarness({ 'pharmacy.accept_order_route': [{ result: 'patient_mismatch', attempts_left: 2, route_row_version: '1' }] });
    const refusal = await h.service.accept(context, routeId, { expectedVersion: 1,
      patientIdentifier: { kind: 'health_id', value: 'HID-ABC234' }, reason: 'Patient at the counter' }, key).catch((e: unknown) => e);
    expect(refusal).toMatchObject({ status: 409, code: 'ORDER_ROUTE_PATIENT_MISMATCH', extensions: { attemptsLeft: 2 } });
    await expect(h.database.withTransaction.mock.results[0]?.value).resolves.toEqual({ refusal });
    expect(h.audits).toEqual([['pharmacy.order-route.accept', { resourceType: 'order-route', resourceId: routeId },
      { routeId, kind: 'prescription', state: 'sent', result: 'patient_mismatch', identifierKind: 'health_id',
        withReference: false, attemptsLeft: 2 }, 'denied']]);
  });

  it.each([
    ['P0001', 'ORDER_ROUTE_NOT_PENDING', 409, 'ORDER_ROUTE_NOT_PENDING'],
    ['P0001', 'ORDER_ROUTE_ACCEPT_LIMITED', 429, 'ORDER_ROUTE_ACCEPT_LIMITED'],
    ['P0001', 'ORDER_ROUTE_REFERENCE_MISMATCH', 409, 'ORDER_ROUTE_REFERENCE_MISMATCH'],
    ['P0001', 'ORDER_ROUTE_VERSION_CONFLICT', 412, 'VERSION_CONFLICT'],
    ['P0002', 'ORDER_ROUTE_NOT_FOUND', 404, 'ORDER_ROUTE_NOT_FOUND'],
    ['55000', 'PLATFORM_CONTROL_DISABLED:cross_facility_orders_enabled', 423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE'],
    ['42501', 'ORDER_ROUTE_PERMISSION_DENIED', 403, 'PERMISSION_DENIED'],
    ['22023', 'ORDER_ROUTE_INVALID', 400, 'ORDER_ROUTE_INVALID'],
    ['XX000', 'internal', 503, 'ORDER_ROUTE_UNAVAILABLE'],
  ])('answers %s %s as %i %s', async (state, message, status, code) => {
    const h = routesHarness({ 'pharmacy.decline_order_route': databaseError(state, message) });
    await expect(h.service.decline(context, routeId, { expectedVersion: 1, reason: 'medicine_unavailable' }))
      .rejects.toMatchObject({ status, code });
    expect(h.audits).toEqual([]);
  });

  it('declines with a reason code and no patient on the row', async () => {
    const h = routesHarness({ 'pharmacy.decline_order_route': [{ row_version: 2, state: 'declined' }] });
    await expect(h.service.decline(context, routeId, { expectedVersion: 1, reason: 'medicine_unavailable' }))
      .resolves.toEqual({ route: { id: routeId, version: 2, effectiveState: 'declined' } });
    expect(h.audits).toEqual([['pharmacy.order-route.decline', { resourceType: 'order-route', resourceId: routeId },
      { routeId, kind: 'prescription', state: 'declined', reason: 'medicine_unavailable' }, undefined]]);
  });

  it('normalizes identifiers and refuses malformed ones before the database', () => {
    expect(normalizedIdentifier('health_id', ' hid-abc234 ')).toBe('HID-ABC234');
    expect(() => normalizedIdentifier('date_of_birth', '2026-02-29')).toThrow(expect.objectContaining({ code: 'ORDER_ROUTE_INVALID' }));
  });

  it('sends attemptsLeft with the problem', () => {
    const json = jest.fn();
    const response: { status: jest.Mock; type: jest.Mock; json: jest.Mock } = { status: jest.fn(), type: jest.fn(), json };
    response.status.mockReturnValue(response);
    response.type.mockReturnValue(response);
    const host = { switchToHttp: () => ({ getRequest: () => ({ correlationId: 'c' }), getResponse: () => response }) };
    new ProblemDetailsFilter().catch(new DomainProblem(409, 'ORDER_ROUTE_PATIENT_MISMATCH', 'No match', undefined,
      { extensions: { attemptsLeft: 1, type: 'x' } }), host as never);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ORDER_ROUTE_PATIENT_MISMATCH', attemptsLeft: 1,
      type: 'https://healthidentitydirectory.com/problems/order-route-patient-mismatch' }));
  });
});

// The per-item Pharmacy routes authorize the resource they act on (C17, PRIV P12).
function pharmacyHarness(access: { outcome: string; route_id: string | null }, decision = { allowed: false, breakGlass: false },
  routed = true, dispensingInsert?: Error, receiving: unknown[] | Error = [{ receives: null, routes_here: null }]) {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const workRow = { id: workItemId, patient_id: patientId, facility_id: facilityId, ordering_facility_id: encounterId,
    source_ehr_prescription_id: prescriptionId, source_ehr_prescription_version: '2', source_encounter_id: encounterId,
    source_status: 'active', status: 'accepted', medication_code_system: null, medication_code: null, medication_display: 'Amoxicillin',
    dose_quantity: null, dose_unit: null, route_code: null, frequency: 'tds', instructions: 'After food', starts_on: null, ends_on: null,
    prescribed_by: 'x', prescribed_at: new Date(), accepted_by: 'y', accepted_at: new Date(), row_version: '1', created_at: new Date(),
    dispensing_id: null, reversal_id: null, order_route_id: routed ? routeId : null };
  const client = { query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
    statements.push({ sql, values });
    if (sql === RECEIVES) { if (receiving instanceof Error) throw receiving; return { rows: receiving }; }
    if (sql.includes('pharmacy.order_route_access_for')) return { rows: [{ work_item_id: workItemId, ...access }] };
    if (sql.includes('pharmacy.order_route_cards')) return { rows: [{ work_item_id: workItemId, route_id: routeId, reference: 'R',
      effective_state: 'accepted', access: 'work', ordering_facility_name: 'Ordering Hospital', orderer_name: 'Dr Ada Obi',
      orderer_licence_body: null, orderer_licence_number: null, patient_full_name: 'Ngozi Eze', patient_sex: 'female',
      patient_date_of_birth: '1990-01-01', patient_health_id_last4: '2345', row_version: '5', ended_kind: null }] };
    if (sql.includes('insert into pharmacy.dispensings')) { if (dispensingInsert) throw dispensingInsert; return { rows: [] }; }
    if (sql.includes('from pharmacy.work_items w')) return { rows: [workRow] };
    if (sql.includes('from pharmacy.dispensings d') && sql.includes('d.id=$1')) return { rows: [{ id: dispensingId, work_item_id: workItemId, patient_id: patientId,
      facility_id: facilityId, row_version: '1', quantity_dispensed: '1', status: 'dispensed' }] };
    return { rows: [] };
  }) };
  const database = { withTransaction: async <T>(_c: unknown, fn: (c: PoolClient) => Promise<T>) => fn(client as unknown as PoolClient),
    query: jest.fn(async () => ({ rows: [{ orders: false, work: false }] })) };
  const identity = { authorize: jest.fn().mockResolvedValue(decision) };
  const audits: Array<Record<string, unknown>> = [];
  const audit = { recordWithClient: jest.fn(async (_c: unknown, _x: unknown, action: string, resource: object, details = {}) => {
    audits.push({ action, ...resource, details });
  }) };
  const service = new PharmacyService(database as never, identity as never, audit as never,
    new PharmacyOrderRouteAccess(identity as never), new PharmacyOrderRouteCards(database as never));
  return { service, statements, identity, audits, audit, client };
}

const ITEM_ROUTES: Array<[string, string, string, 'read_records' | 'write_records',
  (service: PharmacyService) => Promise<unknown>]> = [
  ['GET work-items/:id', 'work_item', workItemId, 'read_records', (s) => s.getWorkItem(context, workItemId)],
  ['POST work-items/:id/dispensings', 'work_item', workItemId, 'write_records', (s) => s.dispense(context, workItemId,
    { expectedWorkItemVersion: 1, quantityDispensed: 21, quantityUnit: 'capsule', reason: 'Handed to the patient' }, key)],
  ['GET dispensings/:id', 'dispensing', dispensingId, 'read_records', (s) => s.getDispensing(context, dispensingId)],
  ['POST dispensings/:id/reversals', 'dispensing', dispensingId, 'write_records', (s) => s.reverse(context, dispensingId,
    { expectedDispensingVersion: 1, reason: 'Returned unopened' }, key)],
];

describe('Pharmacy per-item routes authorize the resource they act on (P12)', () => {
  it.each(ITEM_ROUTES)('%s asks C17 about its %s and, with no route and no consent, answers 403 PHARMACY_ACCESS_DENIED',
    async (_name, resource, resourceId, action, call) => {
      const h = pharmacyHarness({ outcome: 'none', route_id: null });
      await expect(call(h.service)).rejects.toMatchObject({ status: 403, code: 'PHARMACY_ACCESS_DENIED' });
      expect(h.statements.filter((s) => s.sql.includes('order_route_access_for')).map((s) => s.values))
        .toEqual([[resource, resourceId, action]]);
      expect(h.identity.authorize).toHaveBeenCalledWith(patientId, action, context);
    });

  it.each(ITEM_ROUTES)('%s answers closed 409 ORDER_ROUTE_CLOSED and paused 423, never asking Identity', async (...[, , , , call]) => {
    const closed = pharmacyHarness({ outcome: 'closed', route_id: routeId });
    await expect(call(closed.service)).rejects.toMatchObject({ status: 409, code: 'ORDER_ROUTE_CLOSED' });
    const paused = pharmacyHarness({ outcome: 'paused', route_id: routeId });
    await expect(call(paused.service)).rejects.toMatchObject({ status: 423, code: 'CROSS_FACILITY_ORDERS_UNAVAILABLE' });
    expect(closed.identity.authorize).not.toHaveBeenCalled();
    expect(paused.identity.authorize).not.toHaveBeenCalled();
  });

  it('reads an allowed route-backed work item without Identity: card, patient, no source ids, basis in the audit row', async () => {
    const h = pharmacyHarness({ outcome: 'allowed', route_id: routeId });
    const item = await h.service.getWorkItem(context, workItemId);
    expect(h.identity.authorize).not.toHaveBeenCalled();
    expect(item).toMatchObject({ id: workItemId, orderRoute: { id: routeId, access: 'work', version: 5, endedKind: null },
      patient: { fullName: 'Ngozi Eze', healthIdLast4: '2345' } });
    expect(item).not.toHaveProperty('sourceEhrPrescriptionId');
    expect(item).not.toHaveProperty('sourceEncounterId');
    expect(h.audits).toEqual([expect.objectContaining({ action: 'pharmacy.work-item.read', patientId,
      details: { basis: 'order-route', orderRouteId: routeId } })]);
  });

  it('answers the dispensing validator\'s refusal on a route-backed item as 409 PHARMACY_PRESCRIPTION_NOT_DISPENSABLE', async () => {
    const h = pharmacyHarness({ outcome: 'allowed', route_id: routeId }, undefined, true,
      databaseError('23514', 'Dispensing does not match its eligible Pharmacy work item and actor context'));
    await expect(ITEM_ROUTES[1]![4](h.service)).rejects.toMatchObject({ status: 409, code: 'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE' });
  });

  it('leaves the same refusal on a same-facility item unchanged', async () => {
    const h = pharmacyHarness({ outcome: 'none', route_id: null }, { allowed: true, breakGlass: false }, false,
      databaseError('23514', 'Dispensing does not match its eligible Pharmacy work item and actor context'));
    await expect(ITEM_ROUTES[1]![4](h.service)).rejects.toMatchObject({ code: '23514' });
  });

  it('answers the same-facility acceptance of a routed prescription 409 PRESCRIPTION_ROUTED, any other 23514 unchanged', async () => {
    const accept = { patientId, orderingFacilityId: facilityId, sourceEhrPrescriptionId: prescriptionId,
      sourceEhrPrescriptionVersion: 2, sourceEncounterId: encounterId, sourceStatus: 'active' as const,
      medicationDisplay: 'Amoxicillin', frequency: 'tds', instructions: 'After food', prescribedBy: patientId,
      prescribedAt: '2026-10-25T08:00:00.000Z', acceptanceReason: 'Accepted after review' };
    for (const [message, expected] of [['PRESCRIPTION_ROUTED', { status: 409, code: 'PRESCRIPTION_ROUTED' }],
      ['Pharmacy acceptance patient, facility, prescription status, or actor context is invalid', { code: '23514' }]] as const) {
      const query = jest.fn(async (sql: string) => {
        if (sql.includes('insert into pharmacy.work_items')) throw databaseError('23514', message);
        return { rows: [] };
      });
      const database = { withTransaction: async <T>(_c: unknown, fn: (c: PoolClient) => Promise<T>) =>
        fn({ query } as unknown as PoolClient) };
      const identity = { authorize: jest.fn().mockResolvedValue({ allowed: true, breakGlass: false }) };
      const service = new PharmacyService(database as never, identity as never, { recordWithClient: jest.fn() } as never,
        new PharmacyOrderRouteAccess(identity as never), new PharmacyOrderRouteCards(database as never));
      await expect(service.acceptPrescription({ ...context, actor: { ...context.actor,
        permissions: ['pharmacy.work-item.accept'] } }, accept, key)).rejects.toMatchObject(expected);
    }
  });

  it('passes a serialization failure of a route-backed dispensing on to the retry', async () => {
    const h = pharmacyHarness({ outcome: 'allowed', route_id: routeId }, undefined, true, databaseError('40001', 'serialize'));
    await expect(ITEM_ROUTES[1]![4](h.service)).rejects.toMatchObject({ code: '40001' });
  });

  it('lists route-backed rows with their card and the two flags, same-facility rows as before', async () => {
    const h = pharmacyHarness({ outcome: 'none', route_id: null });
    const answer = await h.service.listWorkItems(context);
    expect(answer).toMatchObject({ crossFacilityOrders: false, crossFacilityWork: false,
      items: [{ id: workItemId, orderRoute: { id: routeId }, patient: { fullName: 'Ngozi Eze' } }] });
    expect(answer.items[0]).not.toHaveProperty('sourceEhrPrescriptionId');
    // The collection row as before, and one row naming the patient the card shows (ids only, basis order-route).
    expect(h.audits).toEqual([
      expect.objectContaining({ action: 'pharmacy.work-item.list', resourceType: 'pharmacy-work-item-collection',
        details: { returnedCount: 1 } }),
      { action: 'pharmacy.work-item.list', patientId, resourceType: 'pharmacy-work-item', resourceId: workItemId,
        details: { basis: 'order-route', workItemIds: [workItemId], orderRouteIds: [routeId] } }]);
    expect(JSON.stringify(h.audits)).not.toMatch(/Ngozi|1990-01-01|2345/);
    const own = pharmacyHarness({ outcome: 'none', route_id: null }, undefined, false);
    const ownAnswer = await own.service.listWorkItems(context);
    expect(ownAnswer.items[0]).toMatchObject({ sourceEhrPrescriptionId: prescriptionId, sourceEncounterId: encounterId });
    expect(ownAnswer.items[0]).not.toHaveProperty('orderRoute');
    expect(own.statements.some((s) => s.sql.includes('order_route_cards'))).toBe(false);
    // A same-facility list names no patient: only the collection row.
    expect(own.audits).toEqual([expect.objectContaining({ resourceType: 'pharmacy-work-item-collection' })]);
  });

  it('says whether this facility receives and holds prescriptions, after the cards and the audit rows, adding no audit row (item 4)',
    async () => {
      const facts = pharmacyHarness({ outcome: 'none', route_id: null }, undefined, true, undefined,
        [{ receives: true, routes_here: { held: true, waiting: true } }]);
      const answer = await facts.service.listWorkItems(context);
      expect(answer).toMatchObject({ receives: true, routesHere: { waiting: true, held: true }, crossFacilityOrders: false,
        crossFacilityWork: false });
      // D17: to a member who may receive prescriptions the work list also says the late correction is served.
      expect(Object.keys(answer)).toEqual(['items', 'receives', 'routesHere', 'lateCorrection', 'crossFacilityOrders',
        'crossFacilityWork']);
      expect(answer.lateCorrection).toBe(true);
      const sql = facts.statements.map((statement) => statement.sql);
      expect(sql.filter((text) => text === RECEIVES)).toHaveLength(1);
      expect(sql.slice(-3)).toEqual(['savepoint pharmacy_order_route_receives', RECEIVES,
        'release savepoint pharmacy_order_route_receives']);
      expect(sql.findIndex((text) => text.includes('pharmacy.order_route_cards'))).toBeLessThan(sql.indexOf(RECEIVES));
      const savepointCall = facts.client.query.mock.calls.findIndex(([text]) => text === 'savepoint pharmacy_order_route_receives');
      expect(Math.max(...facts.audit.recordWithClient.mock.invocationCallOrder))
        .toBeLessThan(facts.client.query.mock.invocationCallOrder[savepointCall]!);
      const without = pharmacyHarness({ outcome: 'none', route_id: null });
      await without.service.listWorkItems(context);
      expect(facts.audits).toEqual(without.audits);
      expect(JSON.stringify(facts.audits)).not.toMatch(/receives|routesHere|held|waiting|lateCorrection/);
    });

  it('leaves both out of the work list when NULL or unreadable, and asks nothing of a member who cannot receive', async () => {
    const nulls = await pharmacyHarness({ outcome: 'none', route_id: null }).service.listWorkItems(context);
    // D17's lateCorrection reads nothing: a member who may receive prescriptions gets it whatever the facts say.
    expect(Object.keys(nulls)).toEqual(['items', 'lateCorrection', 'crossFacilityOrders', 'crossFacilityWork']);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const failing = pharmacyHarness({ outcome: 'none', route_id: null }, undefined, true, undefined,
        databaseError('42883', 'function pharmacy.order_routes_here() does not exist'));
      const answer = await failing.service.listWorkItems(context);
      expect(answer.items).toHaveLength(1);
      expect(Object.keys(answer)).toEqual(['items', 'lateCorrection', 'crossFacilityOrders', 'crossFacilityWork']);
      expect(failing.statements.map((statement) => statement.sql).slice(-3)).toEqual(['savepoint pharmacy_order_route_receives',
        RECEIVES, 'rollback to savepoint pharmacy_order_route_receives']);
      expect(warn).toHaveBeenCalledWith({ message: 'Whether this facility receives orders could not be read', sqlState: '42883',
        correlationId: context.correlationId });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('does not exist');
    } finally {
      warn.mockRestore();
    }
    const reader = pharmacyHarness({ outcome: 'none', route_id: null }, undefined, true, undefined,
      [{ receives: true, routes_here: { held: true, waiting: true } }]);
    const readerAnswer = await reader.service.listWorkItems({ ...context, actor: { ...context.actor,
      permissions: ['pharmacy.work-item.read'] } });
    expect(readerAnswer).not.toHaveProperty('receives');
    expect(readerAnswer).not.toHaveProperty('routesHere');
    // D17: nor does a member who cannot receive prescriptions learn that the late correction is served.
    expect(readerAnswer).not.toHaveProperty('lateCorrection');
    expect(reader.statements.some((statement) => statement.sql.includes('order_route_receives'))).toBe(false);
  });
});

describe('PharmacyOrderRoutesService: whether this facility receives, and orders waiting or held here (item 4, 0089)', () => {
  it.each([
    ['Incoming', (h: ReturnType<typeof routesHarness>) => h.service.list(context, { view: 'incoming' })],
    ['Recent', (h: ReturnType<typeof routesHarness>) => h.service.list(context, { view: 'recent' })],
    ['the search', (h: ReturnType<typeof routesHarness>) => h.service.search(context, { healthId: 'HID-ABC234' })],
  ])('answers them beside %s, read after the audit row in the list\'s one READ COMMITTED transaction', async (_name, run) => {
    for (const [receives, routesHere] of [[true, { waiting: false, held: false }], [false, { waiting: true, held: true }]] as const) {
      const h = routesHarness({ 'pharmacy.list_order_routes': [] }, [{ receives, routes_here: { ...routesHere } }]);
      const answer = await run(h);
      expect(answer).toEqual({ items: [], receives, routesHere, crossFacilityOrders: true, crossFacilityWork: true });
      expect(Object.keys(answer)).toEqual(['items', 'receives', 'routesHere', 'crossFacilityOrders', 'crossFacilityWork']);
      expect(h.statements.slice(1)).toEqual(RECEIVES_STATEMENTS);
      expect(h.options).toEqual([{ isolationLevel: 'READ COMMITTED' }]);
      expect(h.database.withTransaction).toHaveBeenCalledTimes(1);
      expect(h.audit.recordWithClient.mock.invocationCallOrder[0]).toBeLessThan(h.client.query.mock.invocationCallOrder[1]!);
      expect(h.audits).toEqual([['pharmacy.order-route.list', expect.anything(), expect.anything(), undefined]]);
      expect(JSON.stringify(h.audits)).not.toMatch(/receives|routesHere/);
    }
  });

  it('leaves both out when the database answers NULL or another type, never a made-up false', async () => {
    for (const row of [{ receives: null, routes_here: null }, { receives: 'false', routes_here: { waiting: true, held: 'no' } },
      { receives: 0, routes_here: { held: true } }]) {
      const answer = await routesHarness({ 'pharmacy.list_order_routes': [] }, [row]).service.list(context, {});
      expect(Object.keys(answer)).toEqual(['items', 'crossFacilityOrders', 'crossFacilityWork']);
    }
    expect(receivingFacts({ receives: true, routes_here: { held: false, waiting: true, routeId } }))
      .toEqual({ receives: true, routesHere: { waiting: true, held: false } });
    expect(receivingFacts({ receives: false, routes_here: '{"held": true, "waiting": false}' }))
      .toEqual({ receives: false, routesHere: { waiting: false, held: true } });
    expect(receivingFacts(undefined)).toEqual({});
  });

  it('rolls back to its savepoint on a failure, logs the SQLSTATE alone, and still answers the list', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const h = routesHarness({ 'pharmacy.list_order_routes': [incoming] }, databaseError('42501', 'Order route staff context is required'));
      const answer = await h.service.list(context, {});
      expect(answer.items).toHaveLength(1);
      expect(Object.keys(answer)).toEqual(['items', 'crossFacilityOrders', 'crossFacilityWork']);
      expect(h.statements.map((statement) => statement.sql)).toEqual(['select * from pharmacy.list_order_routes($1, $2)',
        'savepoint pharmacy_order_route_receives', RECEIVES, 'rollback to savepoint pharmacy_order_route_receives']);
      expect(warn).toHaveBeenCalledWith({ message: 'Whether this facility receives orders could not be read', sqlState: '42501',
        correlationId: context.correlationId });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('staff context');
      expect(h.audits).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('reads nothing for a member without pharmacy.order-route.receive, nor while route access is off (423 as before)', async () => {
    const reader = routesHarness({ 'pharmacy.list_order_routes': [] }, [{ receives: true, routes_here: { held: true, waiting: true } }]);
    const answer = await reader.service.list({ ...context, actor: { ...context.actor, permissions: ['pharmacy.work-item.read'] } }, {});
    expect(answer).toEqual({ items: [], crossFacilityOrders: true, crossFacilityWork: true });
    expect(reader.statements.map((statement) => statement.sql)).toEqual(['select * from pharmacy.list_order_routes($1, $2)']);
    const paused = routesHarness({ 'pharmacy.list_order_routes':
      databaseError('55000', 'PLATFORM_CONTROL_DISABLED:cross_facility_route_access_enabled') });
    const refusal = await paused.service.list(context, {}).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ status: 423, code: 'CROSS_FACILITY_ORDERS_UNAVAILABLE' });
    expect(paused.statements.map((statement) => statement.sql)).toEqual(['select * from pharmacy.list_order_routes($1, $2)']);
    expect(paused.audits).toEqual([]);
  });
});
