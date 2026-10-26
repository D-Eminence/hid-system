import { type INestApplication, Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { IdentityActorContext } from '@hid/api-client';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AuditInterceptor } from '../../audit/audit.interceptor';
import { AuditService } from '../../audit/audit.service';
import { RemoteSecurityGuard } from '../../auth/remote-security.guard';
import { CorrelationMiddleware } from '../../common/correlation.middleware';
import { DomainProblem, ProblemDetailsFilter } from '../../common/problem';
import type { DataAccessContext } from '../../common/request-context';
import { DatabaseService } from '../../database/database.service';
import { IdentityApiService } from '../../integrations/identity-api.service';
import { ClinicalRepository } from '../shared/clinical.repository';
import { orderRouteSummary, orderRouteView, patientOrderRoute, wrongPatientOverview } from './order-route.mapping';
import { OrderRoutesController } from './order-routes.controller';
import { OrderRoutesService } from './order-routes.service';

// Item 3: what the ordering facility (A) and the patient read of an order the
// receiver ended as accepted for the wrong person (C3, C4, C5 pass endedKind
// through), and the Overview card's read (C28, D10's alternative (a)).
const facilityId = '30000000-0000-4000-8000-000000000001';
const organizationId = '50000000-0000-4000-8000-000000000001';
const membershipId = '40000000-0000-4000-8000-000000000001';
const accountId = '20000000-0000-4000-8000-0000000000b1';
const patientId = '60000000-0000-4000-8000-000000000001';
const otherPatientId = '60000000-0000-4000-8000-000000000002';
const routeId = '70000000-0000-4000-8000-000000000001';
const secondRouteId = '70000000-0000-4000-8000-000000000002';
const encounterId = '80000000-0000-4000-8000-000000000001';
const orderId = '90000000-0000-4000-8000-000000000001';
const laboratoryId = '30000000-0000-4000-8000-000000000003';

describe('endedKind wrong_patient passes through C3, C4 and C5 (item 3 §5.3)', () => {
  const summary = { id: routeId, reference: '70000000', kind: 'lab_request', version: 9, effectiveState: 'completed',
    receivingFacility: { id: laboratoryId, name: 'Synthetic Laboratory', available: true }, createdAt: '2026-10-20T09:00:00Z',
    respondBy: '2026-10-27T09:00:00Z', acceptedAt: '2026-10-20T10:00:00Z', completedAt: '2026-10-21T10:00:00Z',
    endedAt: '2026-10-26T08:00:00Z', endedKind: 'wrong_patient', declineReason: null, acceptLocked: false, resendAllowed: false };

  it('C4: the summary keeps endedKind and resendAllowed false', () => {
    expect(orderRouteSummary(summary)).toMatchObject({ effectiveState: 'completed', endedKind: 'wrong_patient',
      endedAt: '2026-10-26T08:00:00.000Z', resendAllowed: false });
    expect(orderRouteSummary({ ...summary, effectiveState: 'cancelled', completedAt: null })).toMatchObject({
      effectiveState: 'cancelled', endedKind: 'wrong_patient' });
  });

  it('C3: the released row and its entered-in-error row (no value), and the receiving side\'s events', () => {
    const view = orderRouteView({ route_id: routeId, summary, attestation: { textVersion: 'v1' },
      events: [{ type: 'completed', side: 'receiving', occurredAt: '2026-10-21T10:00:00Z', reasonCode: null, stateAfter: 'completed' },
        { type: 'result_marked_in_error', side: 'receiving', occurredAt: '2026-10-26T08:00:00Z', reasonCode: null,
          stateAfter: 'completed' },
        { type: 'access_ended', side: 'receiving', occurredAt: '2026-10-26T08:00:00Z', reasonCode: 'wrong_patient',
          stateAfter: 'completed' }],
      reports: [{ resultId: 'r1', resultVersion: 1, kind: 'released', test: { codeSystem: 'loinc', code: '4548-4', name: 'HbA1c' },
        resultType: 'numeric', numericValue: 6.8, unit: '%', occurredAt: '2026-10-21T10:00:00Z' },
      { resultId: 'r1', resultVersion: 1, kind: 'entered_in_error', test: { codeSystem: 'loinc', code: '4548-4', name: 'HbA1c' },
        resultType: null, numericValue: null, unit: null, occurredAt: '2026-10-26T08:00:00Z' }] }, 'lab_request');
    expect(view).toMatchObject({ endedKind: 'wrong_patient', effectiveState: 'completed', resendAllowed: false });
    expect('results' in view && view.results.map((item) => [item.kind, item.numericValue])).toEqual([['released', 6.8],
      ['entered_in_error', null]]);
    expect(view.events.at(-1)).toEqual({ type: 'access_ended', side: 'receiving', occurredAt: '2026-10-26T08:00:00.000Z',
      reasonCode: 'wrong_patient', stateAfter: 'completed' });
  });

  it('C5: the patient keeps the order in full (D13), with no Stop', () => {
    const mine = patientOrderRoute({ route_id: routeId, reference: '70000000', kind: 'lab_request', row_version: 9,
      effective_state: 'cancelled', ended_at: '2026-10-26T08:00:00Z', ended_kind: 'wrong_patient', actions: ['withdraw'],
      content: { testDisplay: 'HbA1c', clinicalInformation: 'Thirst' }, entered_in_error: false });
    expect(mine).toMatchObject({ endedKind: 'wrong_patient', effectiveState: 'cancelled', actions: [], enteredInError: false,
      content: expect.objectContaining({ testDisplay: 'HbA1c', clinicalInformation: 'Thirst' }) });
  });
});

/** C28's jsonb, as the database answers it (timestamps as Postgres renders them in jsonb). */
const ownItem = { routeId, reference: '70000000', kind: 'lab_request',
  receivingFacility: { id: laboratoryId, name: 'Synthetic Laboratory' }, patient: { name: 'Ngozi Eze' },
  endedAt: '2026-10-26T08:00:00.239123+00:00', resultsWithdrawn: 1, dispensingReversed: false,
  link: { patientId, encounterId, kind: 'lab_request', orderId } };
const rxItem = { ...ownItem, routeId: secondRouteId, reference: '70000002', kind: 'prescription', patient: { name: 'Bayo Ade' },
  resultsWithdrawn: 0, dispensingReversed: true, link: { patientId: otherPatientId, encounterId, kind: 'prescription', orderId } };
const answer = { windowDays: 30, items: [ownItem, rxItem], others: { count: 2, references: ['AB12CD34', '9F00E1A2'] } };
const empty = { windowDays: 30, items: [], others: { count: 0, references: [] } };

describe('wrongPatientOverview (C28)', () => {
  it('builds the card field by field: the member\'s own orders in full, the rest as a count and references', () => {
    expect(wrongPatientOverview({ ...answer, extra: 'x', items: [{ ...ownItem, patientHealthId: 'HID-X', note: 'x' }, rxItem] }))
      .toEqual({ windowDays: 30, items: [{ routeId, reference: '70000000', kind: 'lab_request',
        receivingFacility: { id: laboratoryId, name: 'Synthetic Laboratory' }, patient: { name: 'Ngozi Eze' },
        endedAt: '2026-10-26T08:00:00.239Z', resultsWithdrawn: 1, dispensingReversed: false,
        link: { patientId, encounterId, kind: 'lab_request', orderId } },
      { routeId: secondRouteId, reference: '70000002', kind: 'prescription',
        receivingFacility: { id: laboratoryId, name: 'Synthetic Laboratory' }, patient: { name: 'Bayo Ade' },
        endedAt: '2026-10-26T08:00:00.239Z', resultsWithdrawn: 0, dispensingReversed: true,
        link: { patientId: otherPatientId, encounterId, kind: 'prescription', orderId } }],
      others: { count: 2, references: ['AB12CD34', '9F00E1A2'] } });
    expect(wrongPatientOverview(JSON.stringify(empty))).toEqual(empty);
  });

  it.each([null, 'not json', [], { items: [] }, { items: {}, others: {} },
    { ...answer, items: [{ ...ownItem, link: { ...ownItem.link, patientId: null } }] },
    { ...answer, items: [{ ...ownItem, kind: 'imaging' }] }, { ...answer, items: [{ ...ownItem, routeId: null }] }])(
    'refuses an answer it cannot audit (%o)', (value) => {
      expect(wrongPatientOverview(value)).toBeUndefined();
    });
});

const context = (purposeOfUse: DataAccessContext['purposeOfUse'] = 'direct-care') => ({
  correlationId: 'correlation-123456', facilityId, membershipId, purposeOfUse, actor: { id: accountId, subject: 'staff:test',
    accountId, authenticationMethod: 'local', roles: ['doctor'], permissions: ['ehr.order-route.send'], facilityIds: [facilityId],
    facilities: [], facility: { id: facilityId, membershipId, organizationId, name: 'Ordering', roles: ['doctor'],
      permissions: ['ehr.order-route.send'], isPrimary: true } },
}) as DataAccessContext;

function serviceHarness(result: unknown | Error = answer) {
  const statements: string[] = [];
  const client = { query: jest.fn(async (sql: string) => {
    statements.push(sql);
    if (result instanceof Error) throw result;
    return { rows: [{ answer: result }] };
  }) };
  const audits: Array<Record<string, unknown>> = [];
  const audit = { recordWithClient: jest.fn(async (_client: unknown, event: Record<string, unknown>) => { audits.push(event); }) };
  const database = { withTransaction: jest.fn(async (_c: unknown, operation: (c: unknown) => Promise<unknown>) => operation(client)) };
  const repository = { run: jest.fn() };
  const service = new OrderRoutesService(repository as never, database as never, audit as never, {} as never);
  return { service, statements, audits, audit, database, repository };
}

describe('OrderRoutesService.wrongPatientOverview (C28)', () => {
  const staffRow = { correlationId: 'correlation-123456', actorType: 'staff', actorSubject: 'staff:test', actorAccountId: accountId,
    actorMembershipId: membershipId, organizationId, facilityId, outcome: 'success', purposeOfUse: 'direct-care' };

  it('reads C28 in one staff transaction and audits the read and each order it shows in full, naming no one in details', async () => {
    const h = serviceHarness();
    const card = await h.service.wrongPatientOverview(context());
    expect(h.statements).toEqual(['select ehr.list_sent_wrong_patient_order_routes() as answer']);
    expect(h.database.withTransaction).toHaveBeenCalledTimes(1);
    expect(h.repository.run).not.toHaveBeenCalled();
    expect(card).toMatchObject({ items: [{ routeId, patient: { name: 'Ngozi Eze' } }, { routeId: secondRouteId }],
      others: { count: 2 } });
    expect(h.audits).toEqual([
      { ...staffRow, action: 'ehr.order-route.wrong-patient-overview', resourceType: 'order-route-collection',
        resourceId: facilityId, details: { itemCount: 2, otherCount: 2 } },
      { ...staffRow, patientId, action: 'ehr.order-route.wrong-patient-overview.item', resourceType: 'order-route',
        resourceId: routeId, details: { routeId, kind: 'lab_request' } },
      { ...staffRow, patientId: otherPatientId, action: 'ehr.order-route.wrong-patient-overview.item', resourceType: 'order-route',
        resourceId: secondRouteId, details: { routeId: secondRouteId, kind: 'prescription' } },
    ]);
    expect(JSON.stringify(h.audits)).not.toMatch(/Ngozi|Bayo|AB12CD34|70000002"/);
  });

  it('answers a colleague the count and references only, and audits the read without a patient', async () => {
    const h = serviceHarness({ windowDays: 30, items: [], others: { count: 3, references: ['70000000', 'AB12CD34', '9F00E1A2'] } });
    // D17: the answer also says this backend serves the late correction.
    await expect(h.service.wrongPatientOverview(context())).resolves.toEqual({ windowDays: 30, items: [],
      others: { count: 3, references: ['70000000', 'AB12CD34', '9F00E1A2'] }, lateCorrection: true });
    expect(h.audits).toEqual([expect.objectContaining({ action: 'ehr.order-route.wrong-patient-overview',
      details: { itemCount: 0, otherCount: 3 } })]);
    expect(h.audits[0]).not.toHaveProperty('patientId');
  });

  it('answers the empty card for a facility with no such order, or a member without ehr.order-route.send', async () => {
    const h = serviceHarness(empty);
    await expect(h.service.wrongPatientOverview(context())).resolves.toEqual({ ...empty, lateCorrection: true });
    expect(h.audits).toEqual([expect.objectContaining({ details: { itemCount: 0, otherCount: 0 } })]);
  });

  it.each(['emergency', 'healthcare-operations'] as const)('refuses %s 403 PERMISSION_DENIED before the database', async (purpose) => {
    const h = serviceHarness();
    await expect(h.service.wrongPatientOverview(context(purpose))).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(h.database.withTransaction).not.toHaveBeenCalled();
  });

  it.each([
    [Object.assign(new Error('Order route staff context is required'), { code: '42501' }), 403, 'PERMISSION_DENIED'],
    [Object.assign(new Error('function does not exist'), { code: '42883' }), 503, 'ORDER_ROUTE_UNAVAILABLE'],
    [{ items: 'x' }, 503, 'ORDER_ROUTE_UNAVAILABLE'],
    [null, 503, 'ORDER_ROUTE_UNAVAILABLE'],
  ])('answers %o with %i %s and audits nothing', async (result, status, code) => {
    const h = serviceHarness(result);
    await expect(h.service.wrongPatientOverview(context())).rejects.toMatchObject({ status, code });
    expect(h.audits).toEqual([]);
  });

  it('fails the read when an audit row fails (nothing is shown unaudited)', async () => {
    const h = serviceHarness();
    h.audit.recordWithClient.mockRejectedValueOnce(Object.assign(new Error('audit refused'), { code: '23514' }));
    await expect(h.service.wrongPatientOverview(context())).rejects.toMatchObject({ status: 503 });
  });
});

// Over HTTP with the real guard (the live session re-checked through Identity
// on every request, the facility and the permission), the audit interceptor
// and service, and the problem filter, as AppModule and main.ts register them;
// Identity and the database are fakes that record every call.
describe('GET ehr/order-routes/wrong-patient over HTTP', () => {
  const doctorFacility = { id: facilityId, membershipId, organizationId, name: 'Synthetic Hospital', roles: ['doctor'],
    permissions: ['ehr.order-route.send', 'ehr.lab-request.read'], isPrimary: true };
  const nurseFacility = { ...doctorFacility, roles: ['nurse'], permissions: ['ehr.lab-request.read'] };
  const actor = (facility: typeof doctorFacility): IdentityActorContext => ({ kind: 'staff', id: 'staff:doctor',
    subject: 'staff:doctor', accountId, roles: facility.roles, permissions: facility.permissions, platformRoles: [],
    platformPermissions: [], facilityIds: [facility.id], facilities: [facility], facility, role: facility.roles[0],
    authenticationMethod: 'local' });
  let liveActor: IdentityActorContext | undefined;
  let result: unknown;
  const rows: Array<{ action: string; patientId: unknown; resourceType: unknown; resourceId: unknown; details: unknown;
    outcome: unknown }> = [];
  const reads: unknown[] = [];
  const insert = (values: unknown[]) => {
    rows.push({ action: values[8] as string, patientId: values[7], resourceType: values[9], resourceId: values[10],
      details: JSON.parse(values[15] as string), outcome: values[11] });
    return { rows: [], rowCount: 1 };
  };
  const database = {
    query: jest.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.includes('platform.control_enabled')) return { rows: [{ enabled: values[0] !== 'maintenance_mode' }] };
      if (sql.includes('insert into audit.events')) return insert(values);
      throw new Error(`unexpected query: ${sql}`);
    }),
    withTransaction: jest.fn(async (transactionContext: DataAccessContext, operation: (c: unknown) => Promise<unknown>) => {
      reads.push({ facilityId: transactionContext.facilityId, membershipId: transactionContext.membershipId,
        purposeOfUse: transactionContext.purposeOfUse });
      return operation({ query: jest.fn(async (sql: string, values: unknown[] = []) => {
        if (sql.includes('insert into audit.events')) return insert(values);
        if (sql.includes('ehr.list_sent_wrong_patient_order_routes')) {
          if (result instanceof Error) throw result;
          return { rows: [{ answer: result }] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }) });
    }),
  };
  const identity = { authenticateRequest: jest.fn(async () => {
    if (!liveActor) throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required');
    return liveActor;
  }) };
  let app: INestApplication;
  let baseUrl: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    rows.length = 0;
    reads.length = 0;
    liveActor = actor(doctorFacility);
    result = answer;
    @Module({
      controllers: [OrderRoutesController],
      providers: [OrderRoutesService, AuditService,
        { provide: ClinicalRepository, useValue: { run: jest.fn() } },
        { provide: DatabaseService, useValue: database },
        { provide: IdentityApiService, useValue: identity },
        { provide: APP_GUARD, useClass: RemoteSecurityGuard },
        { provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
    })
    class OverviewModule implements NestModule {
      configure(consumer: MiddlewareConsumer): void { consumer.apply(CorrelationMiddleware).forRoutes('{*path}'); }
    }
    const module = await Test.createTestingModule({ imports: [OverviewModule] }).compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterEach(async () => { await app.close(); });

  const get = (headers: Record<string, string> = { 'X-Facility-ID': facilityId, 'X-Purpose-Of-Use': 'direct-care' }) =>
    new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const outgoing = httpRequest(`${baseUrl}/api/v1/ehr/order-routes/wrong-patient`,
        { headers: { Authorization: 'Bearer synthetic', ...headers } }, (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => { text += chunk; });
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> }));
        });
      outgoing.on('error', reject);
      outgoing.end();
    });

  it('answers the card to a member holding ehr.order-route.send, the session re-checked, read and items audited', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ windowDays: 30, others: { count: 2, references: ['AB12CD34', '9F00E1A2'] } });
    expect(identity.authenticateRequest).toHaveBeenCalledTimes(1);
    expect(reads).toEqual([{ facilityId, membershipId, purposeOfUse: 'direct-care' }]);
    expect(rows.map((row) => [row.action, row.patientId, row.outcome])).toEqual([
      ['ehr.order-route.wrong-patient-overview', null, 'success'],
      ['ehr.order-route.wrong-patient-overview.item', patientId, 'success'],
      ['ehr.order-route.wrong-patient-overview.item', otherPatientId, 'success'],
      ['api.get./api/v1/ehr/order-routes/wrong-patient', null, 'success'],
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/Ngozi|Bayo/);
  });

  it('refuses a member without ehr.order-route.send 403 before the database reads anything', async () => {
    liveActor = actor(nurseFacility);
    const response = await get();
    expect([response.status, response.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    expect(reads).toEqual([]);
    expect(rows.map((row) => row.action)).toEqual(['security.authorization.denied']);
  });

  it('refuses another facility, an ended session, no purpose and emergency access, never reading the card', async () => {
    const other = await get({ 'X-Facility-ID': '30000000-0000-4000-8000-000000000099', 'X-Purpose-Of-Use': 'direct-care' });
    expect([other.status, other.body.code]).toEqual([403, 'FACILITY_ACCESS_DENIED']);
    const noPurpose = await get({ 'X-Facility-ID': facilityId });
    expect([noPurpose.status, noPurpose.body.code]).toEqual([400, 'PURPOSE_OF_USE_REQUIRED']);
    const emergency = await get({ 'X-Facility-ID': facilityId, 'X-Purpose-Of-Use': 'emergency' });
    expect([emergency.status, emergency.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    liveActor = undefined;
    const signedOut = await get();
    expect([signedOut.status, signedOut.body.code]).toEqual([401, 'AUTHENTICATION_REQUIRED']);
    expect(reads).toEqual([]);
  });

  it('answers the database\'s 42501 (no live membership at this facility) 403, other faults 503', async () => {
    result = Object.assign(new Error('Order route staff context is required'), { code: '42501' });
    const refused = await get();
    expect([refused.status, refused.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    result = Object.assign(new Error('relation does not exist'), { code: '42P01' });
    const unavailable = await get();
    expect([unavailable.status, unavailable.body.code]).toEqual([503, 'ORDER_ROUTE_UNAVAILABLE']);
    expect(rows.filter((row) => row.action.startsWith('ehr.order-route.wrong-patient-overview'))).toEqual([]);
  });
});
