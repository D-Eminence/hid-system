import { PharmacyApiClient, PharmacyApiProblem } from '@hid/api-client';
import type { PharmacyWorkItem, PharmacyWorkItemOrderRoute } from '@hid/api-client';
import { orderRouteCard } from '../pharmacy/order-route-cards';

const context = {
  authorization: 'Bearer propagated-user', correlationId: 'client-contract-1234',
  facilityId: '123e4567-e89b-42d3-a456-426614174001', purposeOfUse: 'direct-care',
};

describe('PharmacyApiClient transport contract', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('keeps user and workload credentials separate and retries one transient idempotent failure', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'temporarily unavailable' }),
        { status: 503, headers: { 'content-type': 'application/problem+json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: '123e4567-e89b-42d3-a456-426614174002' }),
        { status: 201, headers: { 'content-type': 'application/json' } }));
    global.fetch = fetchMock;
    const workload = jest.fn()
      .mockResolvedValueOnce('Bearer pharmacy-workload-one')
      .mockResolvedValueOnce('Bearer pharmacy-workload-two');
    const client = new PharmacyApiClient({ baseUrl: 'https://pharmacy.test',
      serviceAuthorizationProvider: workload });
    await expect(client.acceptEhrPrescription({ sourceStatus: 'active' }, context,
      'pharmacy-client-key-1234')).resolves.toEqual({ id: '123e4567-e89b-42d3-a456-426614174002' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(workload).toHaveBeenCalledTimes(2);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const retry = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(request.headers).toMatchObject({ authorization: 'Bearer propagated-user',
      'x-hid-service-authorization': 'Bearer pharmacy-workload-one',
      'x-hid-internal-caller': 'ehr-api', 'idempotency-key': 'pharmacy-client-key-1234' });
    expect(retry.headers).toMatchObject({ authorization: 'Bearer propagated-user',
      'x-hid-service-authorization': 'Bearer pharmacy-workload-two',
      'x-hid-internal-caller': 'ehr-api', 'idempotency-key': 'pharmacy-client-key-1234' });
    expect(request.headers).not.toHaveProperty('x-hid-service-token');
  });

  it('does not retry a domain conflict and preserves Problem Details', async () => {
    const payload = { code: 'IDEMPOTENCY_CONFLICT', detail: 'Key belongs to another request' };
    const fetchMock = jest.fn().mockResolvedValue(new Response(JSON.stringify(payload),
      { status: 409, headers: { 'content-type': 'application/problem+json' } }));
    global.fetch = fetchMock;
    const client = new PharmacyApiClient({ baseUrl: 'https://pharmacy.test',
      internalServiceToken: 'local-pharmacy-service-token-123456' });
    await expect(client.createOcrImport({}, context, 'pharmacy-client-key-1234'))
      .rejects.toMatchObject<Partial<PharmacyApiProblem>>({ status: 409, payload });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads one patient\'s imported medications as a browser GET with patientId, limit and cursor in the query', async () => {
    const record = { id: '123e4567-e89b-42d3-a456-426614174003', patientId: '123e4567-e89b-42d3-a456-426614174004',
      facilityId: context.facilityId, sourceType: 'IMPORTED_MEDICATION_EVIDENCE', activityStatus: 'unknown',
      medicationText: 'Fictional medicine', strengthText: null, doseText: null, frequencyText: null,
      historicalContext: null, sourceDocumentId: '123e4567-e89b-42d3-a456-426614174005',
      ocrJobId: '123e4567-e89b-42d3-a456-426614174006', extractionId: '123e4567-e89b-42d3-a456-426614174007',
      validationId: '123e4567-e89b-42d3-a456-426614174008', validationVersion: 1,
      publicationId: '123e4567-e89b-42d3-a456-426614174009', version: 1, createdAt: '2026-11-05T10:00:00.000Z' };
    const fetchMock = jest.fn().mockResolvedValue(new Response(JSON.stringify({ items: [record], nextCursor: record.id }),
      { status: 200, headers: { 'content-type': 'application/json' } }));
    global.fetch = fetchMock;
    const client = new PharmacyApiClient({ baseUrl: 'https://pharmacy.test' });
    await expect(client.listImportedMedicationEvidence(record.patientId, context, { limit: 20, cursor: record.id }))
      .resolves.toEqual({ items: [record], nextCursor: record.id });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`https://pharmacy.test/api/v1/pharmacy/imports?patientId=${
      record.patientId}&limit=20&cursor=${record.id}`);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.method).toBe('GET');
    expect(request.headers).not.toHaveProperty('x-hid-internal-caller');
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ items: [record] }),
      { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(client.listImportedMedicationEvidence(record.patientId, context))
      .rejects.toMatchObject({ status: 502 });
    // A page holding another patient's record is refused, never passed to the chart.
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ items: [record], nextCursor: null }),
      { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(client.listImportedMedicationEvidence('50000000-0000-4000-8000-0000000000ff', context))
      .rejects.toMatchObject({ status: 502 });
  });

  // 0124: an own work item may carry its patient (OWN_WORK_PATIENT_CARD_ENABLED on); the client keeps it, and
  // answers exactly as before when it is absent.
  it('keeps a work item\'s optional patient, and leaves it out when absent', async () => {
    const base = { id: '123e4567-e89b-42d3-a456-426614174003', patientId: '123e4567-e89b-42d3-a456-426614174004',
      facilityId: context.facilityId, sourceEhrPrescriptionId: '123e4567-e89b-42d3-a456-426614174005',
      sourceEncounterId: '123e4567-e89b-42d3-a456-426614174006', sourceEhrPrescriptionVersion: 1, status: 'accepted',
      medication: { codeSystem: null, code: null, display: 'Amoxicillin 500 mg capsule' }, doseQuantity: 1,
      doseUnit: 'capsule', routeCode: 'oral', frequency: 'Every 8 hours', instructions: 'After food',
      acceptedAt: '2026-11-01T09:00:00.000Z', version: 1, dispensing: null };
    const patient = { fullName: 'Amaka Card', sex: null, dateOfBirth: '1991-02-03', healthIdLast4: 'AAA2' };
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ items: [{ ...base, patient }, base] }),
      { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new PharmacyApiClient({ baseUrl: 'https://pharmacy.test' });
    const [own, plain] = await client.listWorkItems(context);
    expect(own?.patient).toEqual(patient);
    expect(plain).not.toHaveProperty('patient');
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ ...base, patient: { sex: 'female' } }),
      { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(client.getWorkItem(base.id, context)).rejects.toMatchObject({ status: 502 });
  });

  // 0125: an own work item may carry the prescription details (PRESCRIPTION_DISPENSING_DETAILS_ENABLED on); the
  // client keeps each one sent, leaves out each one not sent, and refuses a malformed one.
  it('keeps a work item\'s optional prescription details, and leaves them out when absent', async () => {
    const base = { id: '123e4567-e89b-42d3-a456-426614174003', patientId: '123e4567-e89b-42d3-a456-426614174004',
      facilityId: context.facilityId, sourceEhrPrescriptionId: '123e4567-e89b-42d3-a456-426614174005',
      sourceEncounterId: '123e4567-e89b-42d3-a456-426614174006', sourceEhrPrescriptionVersion: 1, status: 'accepted',
      medication: { codeSystem: null, code: null, display: 'Amoxicillin 500 mg capsule' }, doseQuantity: 1,
      doseUnit: 'capsule', routeCode: 'oral', frequency: 'Every 8 hours', instructions: 'After food',
      acceptedAt: '2026-11-01T09:00:00.000Z', version: 1, dispensing: null };
    const detailed = { ...base, medication: { ...base.medication, strength: '500 mg', doseForm: 'capsule' },
      priority: 'urgent', duration: { value: 7, unit: 'day' }, quantityToDispense: 21, quantityUnit: 'capsule' };
    const respond = (payload: unknown) => {
      global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(payload),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    };
    const client = new PharmacyApiClient({ baseUrl: 'https://pharmacy.test' });
    respond({ items: [detailed, { ...base, duration: { value: 3, unit: 'day' } }, base] });
    const [own, dated, plain] = await client.listWorkItems(context);
    expect(own).toMatchObject({ medication: detailed.medication, priority: 'urgent', duration: { value: 7, unit: 'day' },
      quantityToDispense: 21, quantityUnit: 'capsule' });
    expect(dated?.duration).toEqual({ value: 3, unit: 'day' });
    expect(Object.keys(dated ?? {})).not.toEqual(expect.arrayContaining(['priority']));
    for (const key of ['priority', 'duration', 'quantityToDispense', 'quantityUnit']) expect(plain).not.toHaveProperty(key);
    expect(Object.keys(plain?.medication ?? {})).toEqual(['codeSystem', 'code', 'display']);
    for (const malformed of [{ priority: 1 }, { duration: { value: 1.5, unit: 'day' } }, { duration: '7 days' },
      { quantityToDispense: '21' }, { quantityUnit: '' }, { medication: { ...base.medication, strength: 500 } }]) {
      respond({ ...base, ...malformed });
      await expect(client.getWorkItem(base.id, context)).rejects.toMatchObject({ status: 502 });
    }
  });

  // 0133: an own item withdrawn before it was dispensed carries `withdrawn: true` and, since D14 (owner's Q121 A),
  // `withdrawnReason`: 'changed' or 'sent_elsewhere'. The client keeps the reason only for those two values and only
  // with `withdrawn: true`; anything else is left out, never refused.
  it('keeps a work item\'s withdrawnReason only for changed or sent_elsewhere, and only with withdrawn', async () => {
    const base = { id: '123e4567-e89b-42d3-a456-426614174003', patientId: '123e4567-e89b-42d3-a456-426614174004',
      facilityId: context.facilityId, sourceEhrPrescriptionId: '123e4567-e89b-42d3-a456-426614174005',
      sourceEncounterId: '123e4567-e89b-42d3-a456-426614174006', sourceEhrPrescriptionVersion: 1, status: 'accepted',
      medication: { codeSystem: null, code: null, display: 'Amoxicillin 500 mg capsule' }, doseQuantity: 1,
      doseUnit: 'capsule', routeCode: 'oral', frequency: 'Every 8 hours', instructions: 'After food',
      acceptedAt: '2026-11-19T09:00:00.000Z', version: 1, dispensing: null };
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ items: [
      { ...base, withdrawn: true, withdrawnReason: 'sent_elsewhere' },
      { ...base, withdrawn: true, withdrawnReason: 'changed' },
      { ...base, withdrawn: true },
      { ...base, withdrawn: true, withdrawnReason: 'returned' },
      { ...base, withdrawnReason: 'sent_elsewhere' },
      { ...base, withdrawn: false, withdrawnReason: 'changed' },
      base,
    ] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new PharmacyApiClient({ baseUrl: 'https://pharmacy.test' });
    const items = await client.listWorkItems(context);
    expect(items.map((item) => [item.withdrawn, item.withdrawnReason])).toEqual([
      [true, 'sent_elsewhere'], [true, 'changed'], [true, undefined], [true, undefined],
      [undefined, undefined], [undefined, undefined], [undefined, undefined]]);
    expect(items.map((item) => 'withdrawnReason' in item)).toEqual([true, true, false, false, false, false, false]);
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ ...base, withdrawn: true,
      withdrawnReason: 'sent_elsewhere' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(client.getWorkItem(base.id, context)).resolves.toMatchObject({ withdrawn: true,
      withdrawnReason: 'sent_elsewhere' });
  });

  // PRIV P4.3: an item another facility sent here through an order route never carries that facility's
  // prescription or encounter id; it carries its route card (and its patient while the route allows a read)
  // instead. Before this, the client required both ids and answered 502 for the whole list.
  describe('an item from another facility\'s order route', () => {
    const routeId = '123e4567-e89b-42d3-a456-426614174020';
    const own = { id: '123e4567-e89b-42d3-a456-426614174003', patientId: '123e4567-e89b-42d3-a456-426614174004',
      facilityId: context.facilityId, sourceEhrPrescriptionId: '123e4567-e89b-42d3-a456-426614174005',
      sourceEhrPrescriptionVersion: 1, sourceEncounterId: '123e4567-e89b-42d3-a456-426614174006', status: 'accepted',
      medication: { codeSystem: null, code: null, display: 'Amoxicillin 500 mg capsule' }, doseQuantity: 1,
      doseUnit: 'capsule', routeCode: 'oral', frequency: 'Every 8 hours', instructions: 'After food',
      acceptedAt: '2026-11-19T09:00:00.000Z', version: 1, dispensing: null };
    // The card as pharmacy-api builds it from a C18 row (bigint version as text), so this follows the server's shape.
    const card = orderRouteCard({ work_item_id: '123e4567-e89b-42d3-a456-426614174021', route_id: routeId,
      reference: 'RX-7Q2K', effective_state: 'accepted', access: 'work', ordering_facility_name: 'Ordering Hospital',
      orderer_name: 'Dr Ada Obi', orderer_licence_body: 'Fictional Medical Board', orderer_licence_number: 'FMB-0042',
      patient_full_name: 'Bisi Route', patient_sex: 'female', patient_date_of_birth: '1988-04-05',
      patient_health_id_last4: 'RT42', row_version: '3', ended_kind: null });
    const routeCard: PharmacyWorkItemOrderRoute = { id: routeId, reference: 'RX-7Q2K', effectiveState: 'accepted',
      access: 'work', version: 3, endedKind: null, orderingFacilityName: 'Ordering Hospital', ordererName: 'Dr Ada Obi',
      ordererLicence: { body: 'Fictional Medical Board', number: 'FMB-0042' } };
    const routePatient = { fullName: 'Bisi Route', sex: 'female', dateOfBirth: '1988-04-05', healthIdLast4: 'RT42' };
    // As pharmacy-api projects a route-backed row: no source ids, the card and its patient.
    const { sourceEhrPrescriptionId: _prescription, sourceEncounterId: _encounter, ...unsourced } = own;
    const routed = { ...unsourced, id: '123e4567-e89b-42d3-a456-426614174021',
      patientId: '123e4567-e89b-42d3-a456-426614174022', orderRoute: card.orderRoute, patient: card.patient,
      medication: { codeSystem: null, code: null, display: 'Metformin 500 mg tablet' }, frequency: 'Twice a day',
      instructions: 'With meals' };
    // A fresh Response for every call: a body can be read only once.
    const respond = (payload: unknown) => {
      global.fetch = jest.fn().mockImplementation(async () => new Response(JSON.stringify(payload),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    };
    const client = new PharmacyApiClient({ baseUrl: 'https://pharmacy.test' });

    it('lists an own item and a route-backed item, the route-backed one with its card and without source ids',
      async () => {
        expect(card.orderRoute).toStrictEqual(routeCard);
        respond({ items: [own, routed] });
        const [first, second] = await client.listWorkItems(context);
        expect(first).toStrictEqual(own);
        expect(second).toStrictEqual({ ...unsourced, id: routed.id, patientId: routed.patientId,
          medication: routed.medication, frequency: 'Twice a day', instructions: 'With meals',
          orderRoute: routeCard, patient: routePatient });
        expect(second).not.toHaveProperty('sourceEhrPrescriptionId');
        expect(second).not.toHaveProperty('sourceEncounterId');
        expect(second?.orderRoute?.orderingFacilityName).toBe('Ordering Hospital');
      });

    it('reads one route-backed item by id, keeping only the card\'s own fields', async () => {
      // No licence on record (left out), and a key the card does not define (dropped, never shown).
      const ended = { ...card.orderRoute, access: 'read', effectiveState: 'completed', endedKind: 'support',
        reference: null, ordererName: null, ordererLicence: undefined,
        prescriptionId: '123e4567-e89b-42d3-a456-426614174099' };
      respond({ ...routed, orderRoute: ended });
      const item = await client.getWorkItem(routed.id, context);
      expect(item.orderRoute).toStrictEqual({ id: routeId, reference: null, effectiveState: 'completed', access: 'read',
        version: 3, endedKind: 'support', orderingFacilityName: 'Ordering Hospital', ordererName: null });
      expect(item).not.toHaveProperty('sourceEhrPrescriptionId');
      expect(item).not.toHaveProperty('sourceEncounterId');
      expect(item.patient).toEqual(routePatient);
      expect(String((global.fetch as jest.Mock).mock.calls[0]?.[0]))
        .toBe(`https://pharmacy.test/api/v1/pharmacy/work-items/${routed.id}`);
    });

    it('still reads a route-backed item whose card pharmacy-api could not read', async () => {
      const { orderRoute: _card, patient: _patient, ...cardless } = routed;
      respond({ items: [cardless] });
      const [listed] = await client.listWorkItems(context);
      respond(cardless);
      const read = await client.getWorkItem(cardless.id, context);
      for (const item of [listed, read]) {
        expect(item).toStrictEqual({ ...cardless, medication: routed.medication });
        for (const key of ['orderRoute', 'patient', 'sourceEhrPrescriptionId', 'sourceEncounterId']) {
          expect(item).not.toHaveProperty(key);
        }
      }
    });

    it('refuses a malformed route card, as any other malformed field', async () => {
      respond({ items: [own, { ...routed, orderRoute: null }] });
      await expect(client.listWorkItems(context)).rejects.toMatchObject({ status: 502 });
      const { id: _id, ...noId } = card.orderRoute;
      for (const orderRoute of [null, [card.orderRoute], 'Ordering Hospital', noId, { ...card.orderRoute, id: '' },
        { ...card.orderRoute, version: 3.5 }, { ...card.orderRoute, version: '3' }, { ...card.orderRoute, access: '' },
        { ...card.orderRoute, ordererLicence: null }, { ...card.orderRoute, ordererLicence: { number: 'FMB-0042' } }]) {
        respond({ ...routed, orderRoute });
        const refusal = await client.getWorkItem(routed.id, context).catch((error: unknown) => error);
        expect(refusal).toBeInstanceOf(PharmacyApiProblem);
        expect(refusal).toMatchObject({ status: 502 });
      }
    });

    it('still refuses a source id that is sent but not a non-empty string', async () => {
      for (const malformed of [{ sourceEhrPrescriptionId: '' }, { sourceEhrPrescriptionId: null },
        { sourceEncounterId: '' }, { sourceEncounterId: 7 }]) {
        respond({ ...own, ...malformed });
        await expect(client.getWorkItem(own.id, context)).rejects.toMatchObject({ status: 502 });
      }
    });

    it('reads this facility\'s own items exactly as before', async () => {
      const detailed = { ...own, medication: { ...own.medication, strength: '500 mg', doseForm: 'capsule' },
        patient: { fullName: 'Amaka Card', sex: null, dateOfBirth: '1991-02-03', healthIdLast4: 'AAA2' },
        priority: 'urgent', duration: { value: 7, unit: 'day' }, quantityToDispense: 21, quantityUnit: 'capsule',
        withdrawn: true, withdrawnReason: 'changed' };
      respond({ items: [own, detailed] });
      const [plain, rich] = await client.listWorkItems(context);
      // The objects the client answered for these two before the change, field for field and in the same order.
      const before: PharmacyWorkItem[] = [{ id: own.id, patientId: own.patientId, facilityId: context.facilityId,
        sourceEhrPrescriptionId: own.sourceEhrPrescriptionId, sourceEhrPrescriptionVersion: 1,
        sourceEncounterId: own.sourceEncounterId, status: 'accepted', medication: own.medication, doseQuantity: 1,
        doseUnit: 'capsule', routeCode: 'oral', frequency: 'Every 8 hours', instructions: 'After food',
        acceptedAt: own.acceptedAt, version: 1, dispensing: null }];
      before.push({ ...before[0]!, medication: detailed.medication, patient: detailed.patient, priority: 'urgent',
        duration: { value: 7, unit: 'day' }, quantityToDispense: 21, quantityUnit: 'capsule', withdrawn: true,
        withdrawnReason: 'changed' });
      expect([plain, rich]).toStrictEqual(before);
      expect(Object.keys(plain ?? {})).toEqual(Object.keys(before[0]!));
      expect(Object.keys(rich ?? {})).toEqual(Object.keys(before[1]!));
    });
  });
});
