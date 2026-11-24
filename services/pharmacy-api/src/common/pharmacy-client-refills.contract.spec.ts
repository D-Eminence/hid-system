import { PharmacyApiClient, type CreatePharmacyDispensingInput, type PharmacyDispensing,
  type PharmacyWorkItem, type PharmacyWorkItemRefills, type PharmacyWorkQueue } from '@hid/api-client';

// ORD-12 (refills, 0152): a work item's `refills` (`endsOn` among them, the refills' last day: the clinical owner's
// D9 of 24 November 2026), `lastFilledAt` and its dispensing's `fillNumber`, and a
// dispensing's `fillNumber`, as packages/api-client parses them, and the dispensing body's `fillNumber` as it sends
// it. Lenient: absent (an older pharmacy-api, or PRESCRIPTION_REFILLS_ENABLED off) or malformed, each is left out and
// the rest reads as before, never a 502 (the work list parses every item). The types are imported from the package's
// entry point, so this file also stops compiling if they are no longer exported there. It runs in pharmacy-api's
// jest, beside the other client contracts, because packages/api-client has no test runner of its own.

const context = {
  authorization: 'Bearer propagated-user', correlationId: 'client-contract-ord12-1234',
  facilityId: '123e4567-e89b-42d3-a456-426614174001', purposeOfUse: 'direct-care',
};
const base = { id: '123e4567-e89b-42d3-a456-426614174003', patientId: '123e4567-e89b-42d3-a456-426614174004',
  facilityId: context.facilityId, sourceEhrPrescriptionId: '123e4567-e89b-42d3-a456-426614174005',
  sourceEncounterId: '123e4567-e89b-42d3-a456-426614174006', sourceEhrPrescriptionVersion: 1, status: 'accepted',
  medication: { codeSystem: null, code: null, display: 'Amlodipine 5 mg tablet' }, doseQuantity: 1,
  doseUnit: 'tablet', routeCode: 'oral', frequency: 'Once daily', instructions: 'In the morning',
  acceptedAt: '2026-11-20T09:00:00.000Z', version: 1,
  dispensing: { id: '123e4567-e89b-42d3-a456-426614174007', status: 'dispensed', reversed: false },
  pharmacyStep: 'dispensed', pharmacistAcceptance: null };
const refills: PharmacyWorkItemRefills = { allowed: 2, recorded: 1, open: true, closedReason: null,
  nextFillOn: '2026-11-21', endsOn: '2026-12-30' };
const dispensing = { id: '123e4567-e89b-42d3-a456-426614174007', workItemId: base.id, patientId: base.patientId,
  facilityId: context.facilityId, status: 'dispensed', effectiveStatus: 'dispensed',
  medication: { codeSystem: null, code: null, display: 'Amlodipine 5 mg tablet' }, quantityDispensed: 30,
  quantityUnit: 'tablet', dispensedAt: '2026-11-20T09:55:00.000Z', reversalId: null, version: 1 };

describe('PharmacyApiClient refills (ORD-12)', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });
  const respond = (payload: unknown, status = 200) => {
    const fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(payload),
      { status, headers: { 'content-type': 'application/json' } }));
    global.fetch = fetch;
    return fetch;
  };
  const client = new PharmacyApiClient({ baseUrl: 'https://pharmacy.test' });

  it('C1 absent (an older pharmacy-api, or the setting off): left out, and the item reads as before', async () => {
    respond({ items: [base] });
    const [item] = await client.listWorkItems(context);
    expect(item).not.toHaveProperty('refills');
    expect(item).not.toHaveProperty('lastFilledAt');
    expect(item!.dispensing).toEqual({ id: base.dispensing.id, status: 'dispensed', reversed: false });
  });

  it('C2 present: refills, lastFilledAt and the latest fill\'s number, on listWorkItems and getWorkItem', async () => {
    const shown = { ...base, dispensing: { ...base.dispensing, fillNumber: 2 }, lastFilledAt: '2026-11-21T09:30:00.000Z',
      refills: { allowed: 2, recorded: 2, open: true, closedReason: null, nextFillOn: '2026-11-22',
        endsOn: '2026-12-30' } };
    respond({ items: [shown, { ...base, dispensing: null, pharmacyStep: 'received', refills: { allowed: 1, recorded: 0,
      open: false, closedReason: null, nextFillOn: null, endsOn: '2026-12-20' } }] });
    const items: PharmacyWorkItem[] = await client.listWorkItems(context);
    expect(items[0]).toMatchObject({ dispensing: { fillNumber: 2 }, lastFilledAt: '2026-11-21T09:30:00.000Z',
      refills: { allowed: 2, recorded: 2, open: true, closedReason: null, nextFillOn: '2026-11-22', endsOn: '2026-12-30' } });
    expect(items[1]!.refills).toEqual({ allowed: 1, recorded: 0, open: false, closedReason: null, nextFillOn: null,
      endsOn: '2026-12-20' });
    respond({ ...shown, refills: { allowed: 0, recorded: 1, open: false, closedReason: 'none_left', extra: 'dropped' } });
    expect((await client.getWorkItem(base.id, context)).refills).toEqual({ allowed: 0, recorded: 1, open: false,
      closedReason: 'none_left', nextFillOn: null, endsOn: null });
  });

  it('C3 each closed reason is kept; one this client does not know reads as null', async () => {
    for (const closedReason of ['none_left', 'changed', 'stopped', 'ended', 'not_yet'] as const) {
      respond({ ...base, refills: { ...refills, open: false, closedReason } });
      expect((await client.getWorkItem(base.id, context)).refills?.closedReason).toBe(closedReason);
    }
    respond({ ...base, refills: { ...refills, open: false, closedReason: 'paused_by_owner' } });
    expect((await client.getWorkItem(base.id, context)).refills).toEqual({ ...refills, open: false, closedReason: null });
  });

  it('C3b the refill interval: not_yet with nextFillOn (the Lagos day it opens); a nextFillOn that is not a day, or '
    + 'absent (a pharmacy-api before the interval), reads as null', async () => {
    respond({ ...base, refills: { ...refills, open: false, closedReason: 'not_yet', nextFillOn: '2026-12-08' } });
    expect((await client.getWorkItem(base.id, context)).refills).toEqual({ ...refills, open: false,
      closedReason: 'not_yet', nextFillOn: '2026-12-08' });
    for (const nextFillOn of ['8 December', '2026-12-08T00:00:00Z', 20261208, undefined]) {
      respond({ ...base, refills: { ...refills, nextFillOn } });
      expect((await client.getWorkItem(base.id, context)).refills).toEqual({ ...refills, nextFillOn: null });
    }
  });

  it('C3c the refills\' last day: endsOn kept as the Lagos day (ended with the day it ended); anything but a day, or '
    + 'absent (a pharmacy-api before the expiry), reads as null and keeps the rest', async () => {
    respond({ ...base, refills: { ...refills, open: false, closedReason: 'ended', nextFillOn: null,
      endsOn: '2026-11-20' } });
    expect((await client.getWorkItem(base.id, context)).refills).toEqual({ ...refills, open: false,
      closedReason: 'ended', nextFillOn: null, endsOn: '2026-11-20' });
    for (const endsOn of ['20 November', '2026-11-20T00:00:00Z', 20261120, null, undefined]) {
      respond({ ...base, refills: { ...refills, endsOn } });
      expect((await client.getWorkItem(base.id, context)).refills).toEqual({ ...refills, endsOn: null });
    }
  });

  it('C4 malformed refills, lastFilledAt or fill number: left out, and the list kept (never a 502)', async () => {
    const malformed = [null, 'two', [], { ...refills, allowed: 12 }, { ...refills, allowed: -1 },
      { ...refills, recorded: 1.5 }, { ...refills, recorded: 13 }, { ...refills, open: 'yes' }, { allowed: 2 }];
    respond({ items: malformed.map((value) => ({ ...base, refills: value, lastFilledAt: 5,
      dispensing: { ...base.dispensing, fillNumber: 0 } })) });
    const items = await client.listWorkItems(context);
    expect(items).toHaveLength(malformed.length);
    for (const item of items) {
      expect(item).not.toHaveProperty('refills');
      expect(item).not.toHaveProperty('lastFilledAt');
      expect(item.dispensing).not.toHaveProperty('fillNumber');
    }
  });

  it('C5 a dispensing\'s fillNumber: kept when a whole number 1-12, left out otherwise', async () => {
    respond({ ...dispensing, fillNumber: 2 });
    const second: PharmacyDispensing = await client.getDispensing(dispensing.id, context);
    expect(second.fillNumber).toBe(2);
    for (const fillNumber of [undefined, 0, 13, 2.5, '2', null]) {
      respond({ ...dispensing, fillNumber });
      const answer = await client.getDispensing(dispensing.id, context);
      expect(answer).not.toHaveProperty('fillNumber');
      expect(answer).toMatchObject({ id: dispensing.id, quantityDispensed: 30 });
    }
  });

  it('C6 dispense sends fillNumber as given, and parses the answer\'s; without it, today\'s body', async () => {
    const fetch = respond({ ...dispensing, fillNumber: 3 }, 201);
    const input: CreatePharmacyDispensingInput = { expectedWorkItemVersion: 1, quantityDispensed: 30,
      quantityUnit: 'tablet', reason: 'Handed to the patient with counselling', fillNumber: 3 };
    await expect(client.dispense(base.id, input, context, 'ord12-client-key-0001')).resolves.toMatchObject({ fillNumber: 3 });
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual(input);
    const plain = respond(dispensing, 201);
    const { fillNumber: _left, ...today } = input;
    await expect(client.dispense(base.id, today, context, 'ord12-client-key-0002')).resolves.not.toHaveProperty('fillNumber');
    expect(JSON.parse(String((plain.mock.calls[0] as [string, RequestInit])[1].body))).toEqual(today);
  });

  it('C7 the refill refusals reach the caller as problems with their codes and extensions', async () => {
    for (const [code, extra] of [['PHARMACY_FILL_NUMBER_CHANGED', { fillsRecorded: 2 }], ['PHARMACY_NO_REFILLS_LEFT', {}],
      ['PHARMACY_REFILL_PRESCRIPTION_ENDED', { refillsEndedOn: '2026-11-20' }],
      ['PHARMACY_REFILL_TOO_SOON', { refillOpensOn: '2026-12-08' }],
      ['PHARMACY_DISPENSING_NOT_LATEST_FILL', {}]] as const) {
      respond({ status: 409, code, detail: 'refused', ...extra }, 409);
      await expect(client.dispense(base.id, { expectedWorkItemVersion: 1, quantityDispensed: 30, quantityUnit: 'tablet',
        reason: 'Handed to the patient with counselling', fillNumber: 2 }, context, 'ord12-client-key-0003'))
        .rejects.toMatchObject({ status: 409, payload: { code, ...extra } });
    }
  });

  it('C8 listWorkQueue: the items and refillsUnavailable (true only when the list says exactly true); listWorkItems '
    + 'the same items', async () => {
    respond({ items: [base], since: '2026-08-26', refillsUnavailable: true });
    const queue: PharmacyWorkQueue = await client.listWorkQueue(context);
    expect(queue.refillsUnavailable).toBe(true);
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]!.id).toBe(base.id);
    respond({ items: [base], since: '2026-08-26', refillsUnavailable: true });
    expect(await client.listWorkItems(context)).toEqual(queue.items);
    // Absent (refills off, an older pharmacy-api) or anything but true: false, and the list kept (never a 502).
    for (const payload of [{ items: [base] }, { items: [base], refillsUnavailable: 'true' },
      { items: [base], refillsUnavailable: 1 }, { items: [base], refillsUnavailable: null }]) {
      respond(payload);
      expect(await client.listWorkQueue(context)).toEqual({ items: queue.items, refillsUnavailable: false });
    }
    respond({ refillsUnavailable: true });
    await expect(client.listWorkQueue(context)).rejects.toMatchObject({ status: 502 });
  });
});
