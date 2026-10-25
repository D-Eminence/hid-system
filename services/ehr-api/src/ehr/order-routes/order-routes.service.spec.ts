import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { requestDigest } from '../../common/idempotency';
import { OrderRoutesService } from './order-routes.service';

const patientId = '123e4567-e89b-42d3-a456-426614174001';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const requestId = '123e4567-e89b-42d3-a456-426614174005';
const encounterId = '123e4567-e89b-42d3-a456-426614174006';
const receivingFacilityId = '123e4567-e89b-42d3-a456-426614174007';
const routeId = '123e4567-e89b-42d3-a456-426614174008';
const sessionId = '123e4567-e89b-42d3-a456-426614174009';

const context = (purposeOfUse: DataAccessContext['purposeOfUse'] = 'direct-care') => ({
  correlationId: 'correlation-123456', facilityId, membershipId, purposeOfUse, actor: { id: accountId,
    subject: 'staff:test', accountId, authenticationMethod: 'local', roles: ['doctor'], permissions: [],
    facilityIds: [facilityId], facilities: [], facility: { id: facilityId, membershipId, organizationId: facilityId,
      name: 'Ordering', roles: ['doctor'], permissions: [], isPrimary: true } },
}) as DataAccessContext;

const sendInput = { expectedRowVersion: 1, receivingFacilityId, patientAgreed: true as const,
  attestationTextVersion: 'order-route-lab-attestation-v1' };
const key = 'order-route-key-0001';

const databaseError = (code: string, message: string) => Object.assign(new Error(message), { code });

/**
 * The service with fake collaborators. `answers` maps a statement (matched by
 * its first function name) to the rows it returns or the error it throws.
 */
function harness(answers: Record<string, unknown[] | Error> = {}) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    query: jest.fn(async (sql: string, values: unknown[] = []) => {
      statements.push({ sql, values });
      const name = /from\s+([a-z_]+\.[a-z_]+)\(/i.exec(sql)?.[1] ?? sql;
      const answer = answers[name];
      if (answer instanceof Error) throw answer;
      return { rows: answer ?? [] };
    }),
  };
  const audits: Array<Record<string, unknown>> = [];
  const audit = { recordWithClient: jest.fn(async (_client: unknown, event: Record<string, unknown>) => {
    audits.push(event);
  }) };
  const repository = {
    run: jest.fn(async (ctx: DataAccessContext, patient: string, access: string, event: Record<string, unknown>,
      operation: (client: unknown) => Promise<{ value: unknown; resourceId?: string; details?: Record<string, unknown> }>,
      lookup?: (client: unknown) => Promise<boolean>) => {
      if (lookup && !(await lookup(client))) throw Object.assign(new Error('missing'), { code: 'CLINICAL_RESOURCE_NOT_FOUND' });
      const result = await operation(client);
      // As ClinicalRepository.record: the semantic row, with the operation's id and details merged.
      audits.push({ action: event.action, patientId: patient, access, purposeOfUse: ctx.purposeOfUse,
        resourceType: event.resourceType, resourceId: result.resourceId ?? event.resourceId,
        details: { ...(event.details as object), ...result.details } });
      return result.value;
    }),
    exists: jest.fn(async () => true),
  };
  const database = {
    withTransaction: jest.fn(async (_ctx: unknown, operation: (c: unknown) => Promise<unknown>) => operation(client)),
    withPatientTransaction: jest.fn(async (_auth: unknown, _correlation: unknown, operation: (c: unknown) => Promise<unknown>) =>
      operation(client)),
    query: jest.fn(),
  };
  const identity = { authorizeSelf: jest.fn(), authorize: jest.fn() };
  const service = new OrderRoutesService(repository as never, database as never, audit as never, identity as never);
  return { service, statements, audits, repository, database, identity, client };
}

const sendRow = { route_id: routeId, reference: '123E4567', state: 'sent', row_version: '1',
  created_at: new Date('2026-10-25T09:00:00.000Z'), respond_by: new Date('2026-11-01T09:00:00.000Z'),
  receiving_facility_name: 'Receiving Laboratory', order_row_version: '2', order_status: 'active', replayed: false };

describe('OrderRoutesService send (C1)', () => {
  it('sends with the clinician\'s attestation and records it on the send\'s audit row with the patient', async () => {
    const { service, statements, audits, repository } = harness({ 'ehr.send_order_route': [sendRow] });
    const answer = await service.send(context(), 'lab_request', patientId, encounterId, requestId, sendInput, key);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toBe('select * from ehr.send_order_route($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)');
    const values = statements[0]!.values;
    expect(values.slice(1)).toEqual(['lab_request', patientId, requestId, encounterId, 1, receivingFacilityId,
      'order-route-lab-attestation-v1', key, requestDigest('order-route.send', { kind: 'lab_request', patientId,
        encounterId, orderId: requestId, ...sendInput })]);
    expect(values[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(String(values[9])).toMatch(/^[0-9a-f]{64}$/);
    expect(repository.run).toHaveBeenCalledWith(expect.anything(), patientId, 'write_records', expect.anything(),
      expect.any(Function));
    expect(audits).toEqual([{ action: 'ehr.order-route.send', patientId, access: 'write_records',
      purposeOfUse: 'direct-care', resourceType: 'order-route', resourceId: routeId,
      details: { kind: 'lab_request', receivingFacilityId, attestationTextVersion: 'order-route-lab-attestation-v1',
        patientAgreement: 'clinician_attested', routeId, replayed: false } }]);
    expect(answer).toEqual({
      route: { id: routeId, reference: '123E4567', kind: 'lab_request', version: 1, effectiveState: 'sent',
        receivingFacility: { id: receivingFacilityId, name: 'Receiving Laboratory', available: true },
        createdAt: '2026-10-25T09:00:00.000Z', respondBy: '2026-11-01T09:00:00.000Z', acceptedAt: null, completedAt: null,
        endedAt: null, endedKind: null, declineReason: null, acceptLocked: false, resendAllowed: false },
      order: { id: requestId, status: 'active', rowVersion: 2 },
      replayed: false,
    });
  });

  it('answers a replay with the stored route, its receiver\'s availability unknown', async () => {
    const { service } = harness({ 'ehr.send_order_route': [{ ...sendRow, replayed: true }] });
    const answer = await service.send(context(), 'lab_request', patientId, encounterId, requestId, sendInput, key);
    expect(answer).toMatchObject({ replayed: true, route: { receivingFacility: { available: null } } });
  });

  it.each(['emergency', 'healthcare-operations'] as const)('refuses %s with 403 PERMISSION_DENIED before anything is called',
    async (purpose) => {
      const { service, statements, repository } = harness();
      await expect(service.send(context(purpose), 'lab_request', patientId, encounterId, requestId, sendInput, key))
        .rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
      expect(repository.run).not.toHaveBeenCalled();
      expect(statements).toEqual([]);
    });

  it('refuses the other kind\'s attestation text with 400 ORDER_ROUTE_INVALID before anything is called', async () => {
    const { service, repository } = harness();
    await expect(service.send(context(), 'lab_request', patientId, encounterId, requestId,
      { ...sendInput, attestationTextVersion: 'order-route-prescription-attestation-v1' }, key))
      .rejects.toMatchObject({ status: 400, code: 'ORDER_ROUTE_INVALID' });
    await expect(service.send(context(), 'prescription', patientId, encounterId, requestId, sendInput, key))
      .rejects.toMatchObject({ status: 400, code: 'ORDER_ROUTE_INVALID' });
    expect(repository.run).not.toHaveBeenCalled();
  });

  it.each([
    ['P0001', 'ORDER_ROUTE_ATTESTATION_OUTDATED', 409, 'ORDER_ROUTE_ATTESTATION_OUTDATED'],
    ['P0001', 'ORDER_ROUTE_PATIENT_APP_REQUIRED', 409, 'ORDER_ROUTE_PATIENT_APP_REQUIRED'],
    ['P0001', 'ORDER_ROUTE_DESTINATION_INELIGIBLE', 409, 'ORDER_ROUTE_DESTINATION_INELIGIBLE'],
    ['P0001', 'ORDER_ROUTE_SEND_LIMIT', 429, 'ORDER_ROUTE_SEND_LIMIT'],
    ['P0001', 'ORDER_ROUTE_VERSION_CONFLICT', 412, 'VERSION_CONFLICT'],
    ['P0002', 'ORDER_NOT_FOUND', 404, 'ORDER_NOT_FOUND'],
    ['55000', 'PLATFORM_CONTROL_DISABLED:cross_facility_orders_enabled', 423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE'],
    ['22023', 'ORDER_ROUTE_INVALID', 400, 'ORDER_ROUTE_INVALID'],
    ['42501', 'ORDER_ROUTE_PERMISSION_DENIED', 403, 'PERMISSION_DENIED'],
  ])('answers %s %s as %i %s, with no audit row of its own', async (state, message, status, code) => {
    const { service, audits } = harness({ 'ehr.send_order_route': databaseError(state, message) });
    await expect(service.send(context(), 'lab_request', patientId, encounterId, requestId, sendInput, key))
      .rejects.toMatchObject({ status, code });
    expect(audits).toEqual([]);
  });

  it('answers 503 ORDER_ROUTE_UNAVAILABLE when the command answers no row', async () => {
    const { service } = harness({ 'ehr.send_order_route': [] });
    await expect(service.send(context(), 'prescription', patientId, encounterId, requestId,
      { ...sendInput, attestationTextVersion: 'order-route-prescription-attestation-v2' }, key))
      .rejects.toMatchObject({ status: 503, code: 'ORDER_ROUTE_UNAVAILABLE' });
  });
});

describe('OrderRoutesService list (C3)', () => {
  it('reads the order\'s routes under the patient\'s read consent, after the scoped lookup, and answers OrderRouteView', async () => {
    const view = { route_id: routeId, reference: '123E4567', kind: 'lab_request', row_version: '3',
      effective_state: 'completed', receiving_facility_id: receivingFacilityId, receiving_facility_name: 'Receiving Laboratory',
      receiving_available: true, created_at: '2026-10-25T09:00:00Z', respond_by: '2026-11-01T09:00:00Z',
      accepted_at: '2026-10-25T10:00:00Z', completed_at: '2026-10-26T10:00:00Z', ended_at: null, ended_kind: null,
      decline_reason: null, accept_locked: false, resend_allowed: false,
      // Never answered: patient, source order and staff ids (PRIV P4.3).
      patient_id: patientId, source_lab_request_id: requestId, sent_by_account_id: accountId,
      attestation: { textVersion: 'order-route-lab-attestation-v1', attestedByName: 'Dr Ada Obi',
        attestedAt: '2026-10-25T09:00:00Z', receivingFacilityName: 'Receiving Laboratory' },
      events: [{ type: 'created', side: 'ordering', occurredAt: '2026-10-25T09:00:00Z', reasonCode: null, stateAfter: 'sent',
        actorAccountId: accountId }],
      reports: [{ resultId: routeId, resultVersion: 1, kind: 'released', testCodeSystem: 'loinc', testCode: '718-7',
        testName: 'Hemoglobin', resultType: 'numeric', numericValue: 13.2, textValue: null, unit: 'g/dL',
        referenceRange: '12-16', abnormalFlag: 'normal', revisionKind: 'original', correctionReason: null,
        occurredAt: '2026-10-26T10:00:00Z' }] };
    const { service, statements, audits, repository } = harness({ 'ehr.list_order_routes_for_order': [view] });
    const answer = await service.list(context(), 'lab_request', patientId, encounterId, requestId);
    expect(statements.map((s) => [s.sql, s.values])).toEqual([[
      'select * from ehr.list_order_routes_for_order($1,$2,$3)', ['lab_request', patientId, requestId]]]);
    expect(repository.exists).toHaveBeenCalledWith(expect.anything(), 'lab_requests', requestId, patientId, facilityId,
      encounterId);
    expect(audits).toEqual([expect.objectContaining({ action: 'ehr.order-route.list', patientId, access: 'read_records',
      details: { kind: 'lab_request', resultCount: 1 } })]);
    expect(answer.items).toHaveLength(1);
    const [item] = answer.items;
    expect(item).toMatchObject({ id: routeId, version: 3, effectiveState: 'completed',
      attestation: { ...view.attestation, attestedAt: '2026-10-25T09:00:00.000Z' },
      events: [{ type: 'created', side: 'ordering', occurredAt: '2026-10-25T09:00:00.000Z', reasonCode: null, stateAfter: 'sent' }],
      results: [{ resultId: routeId, resultVersion: 1, kind: 'released', test: { codeSystem: 'loinc', code: '718-7',
        name: 'Hemoglobin' }, numericValue: 13.2, unit: 'g/dL' }] });
    const text = JSON.stringify(answer);
    expect(text).not.toContain(patientId);
    expect(text).not.toContain(requestId);
    expect(text).not.toContain(accountId);
  });

  it('reads C3\'s summary when it comes as one jsonb, with the receiver\'s availability now', async () => {
    const { service } = harness({ 'ehr.list_order_routes_for_order': [{ route_id: routeId,
      summary: { id: routeId, reference: '123E4567', kind: 'lab_request', version: 2, effectiveState: 'sent',
        receivingFacility: { id: receivingFacilityId, name: 'Receiving Laboratory', available: true },
        createdAt: '2026-10-25T09:00:00+00:00', respondBy: '2026-11-01T09:00:00+00:00', acceptedAt: null, completedAt: null,
        endedAt: null, endedKind: null, declineReason: null, acceptLocked: true, resendAllowed: false },
      attestation: { textVersion: 'order-route-lab-attestation-v1', attestedByName: 'Dr Ada Obi',
        attestedAt: '2026-10-25T09:00:00+00:00', receivingFacilityName: 'Receiving Laboratory' },
      receiving_available: false, events: [], reports: [] }] });
    const answer = await service.list(context(), 'lab_request', patientId, encounterId, requestId);
    expect(answer.items[0]).toEqual({ id: routeId, reference: '123E4567', kind: 'lab_request', version: 2,
      effectiveState: 'sent', receivingFacility: { id: receivingFacilityId, name: 'Receiving Laboratory', available: false },
      createdAt: '2026-10-25T09:00:00.000Z', respondBy: '2026-11-01T09:00:00.000Z', acceptedAt: null, completedAt: null,
      endedAt: null, endedKind: null, declineReason: null, acceptLocked: true, resendAllowed: false,
      attestation: { textVersion: 'order-route-lab-attestation-v1', attestedByName: 'Dr Ada Obi',
        attestedAt: '2026-10-25T09:00:00.000Z', receivingFacilityName: 'Receiving Laboratory' }, events: [], results: [] });
  });

  it('answers prescriptions with dispensings', async () => {
    const { service } = harness({ 'ehr.list_order_routes_for_order': [{ route_id: routeId, kind: 'prescription',
      row_version: 2, effective_state: 'completed', reports: [{ dispensing_id: routeId, kind: 'dispensed',
        medication_code_system: 'rxnorm', medication_code: '1', medication_display: 'Amoxicillin 500 mg',
        quantity_dispensed: '21', quantity_unit: 'capsule', occurred_at: '2026-10-26T10:00:00Z' }] }] });
    const answer = await service.list(context(), 'prescription', patientId, encounterId, requestId);
    expect(answer.items[0]).toMatchObject({ dispensings: [{ dispensingId: routeId, kind: 'dispensed',
      medication: { codeSystem: 'rxnorm', code: '1', display: 'Amoxicillin 500 mg' }, quantityDispensed: '21',
      quantityUnit: 'capsule', occurredAt: '2026-10-26T10:00:00.000Z' }] });
    expect(answer.items[0]).not.toHaveProperty('results');
  });

  it('refuses emergency access (PRIV P10.2)', async () => {
    const { service, repository } = harness();
    await expect(service.list(context('emergency'), 'lab_request', patientId, encounterId, requestId))
      .rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(repository.run).not.toHaveBeenCalled();
  });
});

describe('OrderRoutesService withdraw (C2)', () => {
  const input = { expectedVersion: 1, reason: 'sent_in_error' as const };

  it('withdraws without Identity\'s consent check, writing its own audit row at the ordering facility', async () => {
    const { service, statements, audits, repository, identity, database } = harness({ 'ehr.withdraw_order_route': [{
      row_version: '2', state: 'withdrawn', ended_at: new Date('2026-10-25T11:00:00.000Z') }] });
    const answer = await service.withdraw(context(), 'lab_request', patientId, requestId, routeId, input);
    expect(repository.run).not.toHaveBeenCalled();
    expect(identity.authorize).not.toHaveBeenCalled();
    expect(database.withTransaction).toHaveBeenCalledTimes(1);
    expect(statements.map((s) => [s.sql, s.values])).toEqual([['select * from ehr.withdraw_order_route($1,$2,$3,$4,$5)',
      [routeId, 'lab_request', requestId, 1, 'sent_in_error']]]);
    expect(audits).toEqual([expect.objectContaining({ actorType: 'staff', facilityId,
      actorMembershipId: membershipId, patientId, action: 'ehr.order-route.withdraw', resourceType: 'order-route',
      resourceId: routeId, outcome: 'success', purposeOfUse: 'direct-care',
      details: { routeId, kind: 'lab_request', reason: 'sent_in_error', state: 'withdrawn', version: 2 } })]);
    expect(answer).toEqual({ route: expect.objectContaining({ id: routeId, kind: 'lab_request', version: 2,
      effectiveState: 'withdrawn', endedAt: '2026-10-25T11:00:00.000Z', endedKind: 'orderer' }) });
  });

  it('refuses a route of another patient when C2 answers the route\'s patient, writing nothing', async () => {
    const otherPatient = '123e4567-e89b-42d3-a456-426614174010';
    const { service, audits } = harness({ 'ehr.withdraw_order_route': [{ row_version: '2', state: 'withdrawn',
      ended_at: null, patient_id: otherPatient }] });
    await expect(service.withdraw(context(), 'lab_request', patientId, requestId, routeId, input))
      .rejects.toMatchObject({ status: 404, code: 'ORDER_ROUTE_NOT_FOUND' });
    expect(audits).toEqual([]);
  });

  it.each([
    ['P0002', 'ORDER_ROUTE_NOT_FOUND', 404, 'ORDER_ROUTE_NOT_FOUND'],
    ['P0002', 'no data found', 404, 'ORDER_ROUTE_NOT_FOUND'],
    ['P0001', 'ORDER_ROUTE_NOT_PENDING', 409, 'ORDER_ROUTE_NOT_PENDING'],
    ['P0001', 'ORDER_ROUTE_VERSION_CONFLICT', 412, 'VERSION_CONFLICT'],
    ['42501', 'ORDER_ROUTE_PERMISSION_DENIED', 403, 'PERMISSION_DENIED'],
    ['22023', 'ORDER_ROUTE_INVALID', 400, 'ORDER_ROUTE_INVALID'],
  ])('answers %s %s as %i %s', async (state, message, status, code) => {
    const { service } = harness({ 'ehr.withdraw_order_route': databaseError(state, message) });
    await expect(service.withdraw(context(), 'prescription', patientId, requestId, routeId, input))
      .rejects.toMatchObject({ status, code });
  });

  it('refuses emergency access', async () => {
    const { service, database } = harness();
    await expect(service.withdraw(context('emergency'), 'lab_request', patientId, requestId, routeId, input))
      .rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(database.withTransaction).not.toHaveBeenCalled();
  });
});

describe('OrderRoutesService attestation text (C24)', () => {
  it('reads the current text of the kind and writes its own audit row without a patient', async () => {
    const { service, statements, audits } = harness({ 'ehr.order_route_attestation_text': [{
      version: 'order-route-lab-attestation-v1', text: 'I confirm that {patient} agreed that ...' }] });
    await expect(service.attestation(context(), 'lab_request')).resolves.toEqual({ kind: 'lab_request',
      version: 'order-route-lab-attestation-v1', text: 'I confirm that {patient} agreed that ...' });
    expect(statements.map((s) => [s.sql, s.values])).toEqual([['select version, text from ehr.order_route_attestation_text($1)',
      ['lab_request']]]);
    expect(audits).toEqual([expect.objectContaining({ actorType: 'staff', facilityId,
      action: 'ehr.order-route.attestation-text.read', resourceType: 'order-route-attestation-text',
      resourceId: 'order-route-lab-attestation-v1', details: { kind: 'lab_request', version: 'order-route-lab-attestation-v1' } })]);
    expect(audits[0]).not.toHaveProperty('patientId');
  });

  it.each([
    ['55000', 'PLATFORM_CONTROL_DISABLED:cross_facility_orders_enabled', 423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE'],
    ['55000', 'PLATFORM_CONTROL_UNAVAILABLE', 423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE'],
    ['22023', 'PLATFORM_CONTROL_INVALID', 423, 'CROSS_FACILITY_ORDERS_UNAVAILABLE'],
    ['42501', 'ORDER_ROUTE_PERMISSION_DENIED', 403, 'PERMISSION_DENIED'],
    ['22023', 'ORDER_ROUTE_INVALID', 400, 'ORDER_ROUTE_INVALID'],
  ])('answers %s %s as %i %s, with no audit row', async (state, message, status, code) => {
    const { service, audits } = harness({ 'ehr.order_route_attestation_text': databaseError(state, message) });
    await expect(service.attestation(context(), 'prescription')).rejects.toMatchObject({ status, code });
    expect(audits).toEqual([]);
  });

  it('refuses emergency access', async () => {
    const { service } = harness();
    await expect(service.attestation(context('emergency'), 'lab_request'))
      .rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
  });
});

describe('OrderRoutesService patient routes (C5, C6)', () => {
  const patientRequest = (kind: 'patient' | 'staff' = 'patient') => ({
    correlationId: 'correlation-123456',
    actor: { kind, patientId: kind === 'patient' ? patientId : undefined, subject: 'patient:test', accountId, sessionId,
      roles: [], permissions: [], facilityIds: [], facilities: [], id: accountId, authenticationMethod: 'local' },
  }) as unknown as HidRequest;
  const authorization = { subject: 'patient:test', accountId, sessionId, patientId,
    expiresAt: new Date(Date.now() + 30_000).toISOString() };
  const listed = { route_id: routeId, reference: '123E4567', kind: 'lab_request', row_version: 1, effective_state: 'sent',
    receiving_facility_id: receivingFacilityId, receiving_facility_name: 'Receiving Laboratory',
    ordering_facility_name: 'Ordering Hospital', receiving_registered_address: '1 Marina, Lagos',
    created_at: '2026-10-25T09:00:00Z', respond_by: '2026-11-01T09:00:00Z',
    test_code_system: 'loinc', test_code: '718-7', test_display: 'Hemoglobin', priority: 'routine',
    specimen_type_code: null, clinical_information: 'Fatigue', requested_at: '2026-10-25T08:00:00Z',
    attestation_text_version: 'order-route-lab-attestation-v1', attestation_text: 'I confirm that {patient} agreed ...',
    attested_by_name: 'Dr Ada Obi', actions: ['withdraw'] };

  it('lists the patient\'s sent orders in the patient-self transaction, with a patient audit row', async () => {
    const { service, identity, database, audits } = harness({ 'ehr.patient_list_order_routes': [listed] });
    identity.authorizeSelf.mockResolvedValue(authorization);
    const answer = await service.patientList(patientRequest());
    expect(database.withPatientTransaction).toHaveBeenCalledWith(authorization, 'correlation-123456', expect.any(Function));
    expect(answer).toEqual({ items: [expect.objectContaining({ id: routeId, effectiveState: 'sent',
      orderingFacilityName: 'Ordering Hospital', receivingFacilityName: 'Receiving Laboratory',
      receivingRegisteredAddress: '1 Marina, Lagos', attestationTextVersion: 'order-route-lab-attestation-v1',
      attestationText: 'I confirm that {patient} agreed ...', attestedByName: 'Dr Ada Obi', actions: ['withdraw'],
      content: { testCodeSystem: 'loinc', testCode: '718-7', testDisplay: 'Hemoglobin', priority: 'routine',
        specimenTypeCode: null, clinicalInformation: 'Fatigue', requestedAt: '2026-10-25T08:00:00.000Z',
        ordererName: null, ordererLicenceBody: null, ordererLicenceNumber: null } })] });
    expect(audits).toEqual([expect.objectContaining({ actorType: 'patient', patientId, action: 'ehr.order-route.patient-list',
      purposeOfUse: 'patient-self', details: { resultCount: 1 } })]);
    expect(audits[0]).not.toHaveProperty('facilityId');
  });

  it('shows what crossed about the orderer and reads dates as stored, whatever the time zone', async () => {
    const { service, identity } = harness({ 'ehr.patient_list_order_routes': [{ ...listed, kind: 'prescription',
      content: { reference: '123E4567', ordererName: 'Dr Ada Obi', ordererLicenceBody: 'MDCN', ordererLicenceNumber: 'MDCN/1',
        medicationDisplay: 'Amoxicillin 500 mg', doseQuantity: 1, startsOn: '2026-10-25', endsOn: '2026-11-01',
        prescribedAt: '2026-10-25T08:00:00+00:00' }, actions: [] }] });
    identity.authorizeSelf.mockResolvedValue(authorization);
    const answer = await service.patientList(patientRequest());
    expect(answer.items[0]?.content).toMatchObject({ ordererName: 'Dr Ada Obi', ordererLicenceBody: 'MDCN',
      ordererLicenceNumber: 'MDCN/1', medicationDisplay: 'Amoxicillin 500 mg', doseQuantity: 1, startsOn: '2026-10-25',
      endsOn: '2026-11-01', prescribedAt: '2026-10-25T08:00:00.000Z', instructions: null });
    expect(answer.items[0]?.content).not.toHaveProperty('reference');
  });

  it('offers Stop only while the route is sent', async () => {
    const { service, identity } = harness({ 'ehr.patient_list_order_routes': [
      { ...listed, effective_state: 'accepted', actions: ['withdraw'] }] });
    identity.authorizeSelf.mockResolvedValue(authorization);
    const answer = await service.patientList(patientRequest());
    expect(answer.items[0]?.actions).toEqual([]);
  });

  it('refuses a staff session with 403 PATIENT_SESSION_REQUIRED before Identity is asked', async () => {
    const { service, identity, database } = harness();
    await expect(service.patientList(patientRequest('staff'))).rejects.toMatchObject({ status: 403,
      code: 'PATIENT_SESSION_REQUIRED' });
    await expect(service.patientStop(patientRequest('staff'), routeId, 1)).rejects.toMatchObject({ status: 403,
      code: 'PATIENT_SESSION_REQUIRED' });
    expect(identity.authorizeSelf).not.toHaveBeenCalled();
    expect(database.withPatientTransaction).not.toHaveBeenCalled();
  });

  it('refuses when Identity\'s authorization names another session', async () => {
    const { service, identity } = harness();
    identity.authorizeSelf.mockResolvedValue({ ...authorization, sessionId: routeId });
    await expect(service.patientList(patientRequest())).rejects.toMatchObject({ status: 403, code: 'PATIENT_ACCESS_DENIED' });
  });

  it('stops a sent route (C6) and answers it as the list now shows it', async () => {
    const { service, identity, statements, audits } = harness({
      'ehr.patient_stop_order_route': [{ row_version: '2', state: 'withdrawn', effective_state: 'withdrawn' }],
      'ehr.patient_list_order_routes': [{ ...listed, row_version: 2, effective_state: 'withdrawn', ended_kind: 'patient',
        actions: [] }],
    });
    identity.authorizeSelf.mockResolvedValue(authorization);
    const answer = await service.patientStop(patientRequest(), routeId, 1);
    expect(statements[0]).toEqual({ sql: 'select * from ehr.patient_stop_order_route($1,$2)', values: [routeId, 1] });
    expect(answer.route).toMatchObject({ id: routeId, version: 2, effectiveState: 'withdrawn', endedKind: 'patient', actions: [] });
    expect(audits).toEqual([expect.objectContaining({ actorType: 'patient', patientId, action: 'ehr.order-route.patient-withdraw',
      resourceType: 'order-route', resourceId: routeId, details: { routeId, state: 'withdrawn', version: 2 } })]);
  });

  it.each([
    ['P0002', 'ORDER_ROUTE_NOT_FOUND', 404, 'ORDER_ROUTE_NOT_FOUND'],
    ['P0001', 'ORDER_ROUTE_NOT_PENDING', 409, 'ORDER_ROUTE_NOT_PENDING'],
    ['P0001', 'ORDER_ROUTE_VERSION_CONFLICT', 412, 'VERSION_CONFLICT'],
    ['42501', 'PATIENT_SESSION_REQUIRED', 403, 'PATIENT_SESSION_REQUIRED'],
  ])('answers the Stop\'s %s %s as %i %s, with no audit row', async (state, message, status, code) => {
    const { service, identity, audits } = harness({ 'ehr.patient_stop_order_route': databaseError(state, message) });
    identity.authorizeSelf.mockResolvedValue(authorization);
    await expect(service.patientStop(patientRequest(), routeId, 1)).rejects.toMatchObject({ status, code });
    expect(audits).toEqual([]);
  });
});
