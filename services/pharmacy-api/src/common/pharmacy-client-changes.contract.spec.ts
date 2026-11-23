import { PharmacyApiClient, type PharmacyChangeAfterDispensing,
  type PharmacyChangedAfterDispensing } from '@hid/api-client';
import { CHANGES_AFTER_DISPENSING } from '../pharmacy/changes-after-dispensing';

// Q132 A (Release B, 0148): a dispensed work item's changedAfterDispensing as packages/api-client parses it
// (parseChangedAfterDispensing). Lenient for a value: absent is left out, and a `change` the client does not
// know keeps the notice without `change` (unlike ORD-4's steps, which are dropped: a notice that tells the
// pharmacist to contact the patient is better shown without its reason than not at all; open point 5, accepted).
// Strict for a type only: 502. The two types are imported from the package's entry point, so this file also
// stops compiling if they are no longer exported there. It runs in pharmacy-api's jest, beside
// pharmacy-client-steps.contract.spec.ts, because packages/api-client has no test runner of its own and the root
// `npm test` builds the client first. Own items only: the client still refuses an item from another facility
// (it requires the ids such an item never carries), which a separate fix comes first for (SPEC decision 26);
// route-backed notices are tested on the service side (pharmacy-changes-after-dispensing.spec.ts).

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
});
