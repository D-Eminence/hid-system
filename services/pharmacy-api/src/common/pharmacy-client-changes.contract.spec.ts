import { PharmacyApiClient, type PharmacyChangeAfterDispensing,
  type PharmacyChangedAfterDispensing } from '@hid/api-client';
import { CHANGES_AFTER_DISPENSING } from '../pharmacy/changes-after-dispensing';
import { orderRouteCard } from '../pharmacy/order-route-cards';

// Q132 A (Release B, 0148): a dispensed work item's changedAfterDispensing as packages/api-client parses it
// (parseChangedAfterDispensing). Lenient for a value: absent is left out, and a `change` the client does not
// know keeps the notice without `change` (unlike ORD-4's steps, which are dropped: a notice that tells the
// pharmacist to contact the patient is better shown without its reason than not at all; open point 5, accepted).
// Strict for a type only: 502. The two types are imported from the package's entry point, so this file also
// stops compiling if they are no longer exported there. It runs in pharmacy-api's jest, beside
// pharmacy-client-steps.contract.spec.ts, because packages/api-client has no test runner of its own and the root
// `npm test` builds the client first. Own items, and (C9) an item from another facility's order route: the client
// accepts such items, without the source ids they never carry and with their route card, since 2a9aa2f3 (in
// Release B; SPEC decision 26). The service side of route-backed notices is in pharmacy-changes-after-dispensing.spec.ts.

const context = {
  authorization: 'Bearer propagated-user', correlationId: 'client-contract-q132-1234',
  facilityId: '123e4567-e89b-42d3-a456-426614174001', purposeOfUse: 'direct-care',
};
const base = { id: '123e4567-e89b-42d3-a456-426614174003', patientId: '123e4567-e89b-42d3-a456-426614174004',
  facilityId: context.facilityId, sourceEhrPrescriptionId: '123e4567-e89b-42d3-a456-426614174005',
  sourceEncounterId: '123e4567-e89b-42d3-a456-426614174006', sourceEhrPrescriptionVersion: 1, status: 'accepted',
  medication: { codeSystem: null, code: null, display: 'Amoxicillin 500 mg capsule' }, doseQuantity: 1,
  doseUnit: 'capsule', routeCode: 'oral', frequency: 'Every 8 hours', instructions: 'After food',
  acceptedAt: '2026-11-20T09:00:00.000Z', version: 1,
  dispensing: { id: '123e4567-e89b-42d3-a456-426614174007', status: 'dispensed', reversed: false },
  pharmacyStep: 'dispensed', pharmacistAcceptance: null };
const changedAt = '2026-11-20T09:15:00.000Z';
const notice = (change: unknown, changeCount = 2) => ({ change, changedAt, changeCount });

describe('PharmacyApiClient work item changedAfterDispensing (Q132 A)', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });
  const respond = (payload: unknown) => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(payload),
      { status: 200, headers: { 'content-type': 'application/json' } }));
  };
  const client = new PharmacyApiClient({ baseUrl: 'https://pharmacy.test' });

  it('C1 absent: left out, and the item reads as before (an older pharmacy-api or database, or no change)', async () => {
    respond({ items: [base] });
    const [item] = await client.listWorkItems(context);
    expect(item).not.toHaveProperty('changedAfterDispensing');
    expect(item).toMatchObject({ id: base.id, pharmacyStep: 'dispensed', dispensing: { reversed: false } });
    respond(base);
    expect(await client.getWorkItem(base.id, context)).not.toHaveProperty('changedAfterDispensing');
  });

  it('C2 well formed: kept with each of the five codes, on listWorkItems and getWorkItem', async () => {
    const codes: PharmacyChangeAfterDispensing[] = ['on_hold', 'cancelled', 'entered_in_error', 'edited', 'resumed'];
    // The client knows exactly the codes pharmacy-api answers.
    expect([...codes].sort()).toEqual([...CHANGES_AFTER_DISPENSING].sort());
    respond({ items: codes.map((change, index) => ({ ...base, changedAfterDispensing: notice(change, index + 1) })) });
    const items = await client.listWorkItems(context);
    const expected: PharmacyChangedAfterDispensing[] = codes.map((change, index) => ({ change, changedAt,
      changeCount: index + 1 }));
    expect(items.map((item) => item.changedAfterDispensing)).toStrictEqual(expected);
    // The rest of the item reads as before; a reversed dispensing keeps its notice.
    respond({ ...base, dispensing: { ...base.dispensing, reversed: true }, pharmacyStep: 'dispensing_reversed',
      changedAfterDispensing: notice('cancelled', 1) });
    await expect(client.getWorkItem(base.id, context)).resolves.toMatchObject({ dispensing: { reversed: true },
      pharmacyStep: 'dispensing_reversed', changedAfterDispensing: { change: 'cancelled', changedAt, changeCount: 1 } });
  });

  it('C3 unknown change: the notice kept without change, and the list kept', async () => {
    respond({ items: [{ ...base, changedAfterDispensing: notice('stopped_at_the_counter', 3) },
      { ...base, changedAfterDispensing: notice('ON_HOLD') }, { ...base, changedAfterDispensing: notice('', 1) },
      // No change at all (absent): the same.
      { ...base, changedAfterDispensing: { changedAt, changeCount: 1 } },
      { ...base, changedAfterDispensing: notice('edited', 1) }] });
    const items = await client.listWorkItems(context);
    expect(items.map((item) => item.changedAfterDispensing)).toStrictEqual([{ changedAt, changeCount: 3 },
      { changedAt, changeCount: 2 }, { changedAt, changeCount: 1 }, { changedAt, changeCount: 1 },
      { change: 'edited', changedAt, changeCount: 1 }]);
    for (const item of items.slice(0, 4)) expect(item.changedAfterDispensing).not.toHaveProperty('change');
  });

  it('C4 change a number (or null, or an object): 502', async () => {
    for (const change of [1, null, true, { code: 'cancelled' }]) {
      respond({ ...base, changedAfterDispensing: notice(change) });
      await expect(client.getWorkItem(base.id, context)).rejects.toMatchObject({ status: 502,
        payload: { detail: 'Pharmacy field change is malformed.' } });
    }
  });

  it('C5 the notice null, an array or a string: 502, on a read and on the whole list', async () => {
    for (const changedAfterDispensing of [null, [notice('cancelled')], 'cancelled', 1, true]) {
      respond({ ...base, changedAfterDispensing });
      await expect(client.getWorkItem(base.id, context)).rejects.toMatchObject({ status: 502,
        payload: { detail: 'Pharmacy field changedAfterDispensing is malformed.' } });
    }
    respond({ items: [base, { ...base, changedAfterDispensing: null }] });
    await expect(client.listWorkItems(context)).rejects.toMatchObject({ status: 502 });
  });

  it('C6 changedAt missing, empty or not text: 502', async () => {
    for (const malformed of [{ change: 'cancelled', changeCount: 1 }, { ...notice('cancelled'), changedAt: '' },
      { ...notice('cancelled'), changedAt: 1763630100000 }, { ...notice('cancelled'), changedAt: null }]) {
      respond({ ...base, changedAfterDispensing: malformed });
      await expect(client.getWorkItem(base.id, context)).rejects.toMatchObject({ status: 502,
        payload: { detail: 'Pharmacy field changedAt is malformed.' } });
    }
  });

  it('C7 changeCount 0, 1.5, \'2\', missing, null or negative: 502', async () => {
    for (const changeCount of [0, 1.5, '2', undefined, null, -1, Number.NaN]) {
      respond({ ...base, changedAfterDispensing: { change: 'cancelled', changedAt, changeCount } });
      await expect(client.getWorkItem(base.id, context)).rejects.toMatchObject({ status: 502,
        payload: { detail: 'Pharmacy field changeCount is malformed.' } });
    }
  });

  it('C8 other keys dropped: only change, changedAt and changeCount reach the screen', async () => {
    respond({ ...base, changedAfterDispensing: { ...notice('on_hold', 1), prescriptionVersion: 7,
      sourceEhrPrescriptionId: '123e4567-e89b-42d3-a456-426614174099', changedBy: 'Dr Fictional', label: 'Held' } });
    const item = await client.getWorkItem(base.id, context);
    expect(item.changedAfterDispensing).toStrictEqual({ change: 'on_hold', changedAt, changeCount: 1 });
    expect(Object.keys(item).at(-1)).toBe('changedAfterDispensing');
  });

  it('C9 a route-backed item: the notice kept beside its route card, with no source ids, on the list and a read',
    async () => {
      // As pharmacy-api projects a route-backed row (PRIV P4.3): no sourceEhrPrescriptionId or sourceEncounterId, and
      // the card and its patient as pharmacy-api's own orderRouteCard() builds them; the notice is the last field.
      const card = orderRouteCard({ work_item_id: '123e4567-e89b-42d3-a456-426614174021',
        route_id: '123e4567-e89b-42d3-a456-426614174020', reference: 'RX-7Q2K', effective_state: 'accepted',
        access: 'read', ordering_facility_name: 'Ordering Hospital', orderer_name: 'Dr Ada Obi',
        orderer_licence_body: 'Fictional Medical Board', orderer_licence_number: 'FMB-0042',
        patient_full_name: 'Bisi Route', patient_sex: 'female', patient_date_of_birth: '1988-04-05',
        patient_health_id_last4: 'RT42', row_version: '3', ended_kind: null });
      const { sourceEhrPrescriptionId: _prescription, sourceEncounterId: _encounter, ...unsourced } = base;
      const routed = { ...unsourced, id: '123e4567-e89b-42d3-a456-426614174021',
        patientId: '123e4567-e89b-42d3-a456-426614174022', orderRoute: card.orderRoute, patient: card.patient,
        changedAfterDispensing: notice('on_hold', 1) };
      respond({ items: [{ ...base, changedAfterDispensing: notice('cancelled', 2) }, routed] });
      const [own, listed] = await client.listWorkItems(context);
      respond(routed);
      const read = await client.getWorkItem(routed.id, context);
      expect(own?.changedAfterDispensing).toStrictEqual({ change: 'cancelled', changedAt, changeCount: 2 });
      for (const item of [listed, read]) {
        expect(item?.changedAfterDispensing).toStrictEqual({ change: 'on_hold', changedAt, changeCount: 1 });
        expect(Object.keys(item!).at(-1)).toBe('changedAfterDispensing');
        expect(item?.orderRoute).toStrictEqual(card.orderRoute);
        expect(item?.orderRoute?.orderingFacilityName).toBe('Ordering Hospital');
        expect(item).not.toHaveProperty('sourceEhrPrescriptionId');
        expect(item).not.toHaveProperty('sourceEncounterId');
      }
      // A malformed notice on a route-backed item is refused as on an own item.
      respond({ ...routed, changedAfterDispensing: { change: 'on_hold', changedAt, changeCount: 0 } });
      await expect(client.getWorkItem(routed.id, context)).rejects.toMatchObject({ status: 502,
        payload: { detail: 'Pharmacy field changeCount is malformed.' } });
    });
});
