import { PharmacyApiClient, type PharmacistAcceptance, type PharmacyStep } from '@hid/api-client';

// ORD-4: a work item's pharmacyStep and pharmacistAcceptance as packages/api-client parses them (parseWorkItemStep).
// Lenient for a value: an absent step, or a step or acceptedWith the client does not know, leaves both fields out,
// so one newer value from pharmacy-api never fails the pharmacist's whole work list. Strict for a type only: 502.
// The two types are imported from the package's entry point, so this file also stops compiling if they are no
// longer exported there. It runs in pharmacy-api's jest, beside pharmacy-client.contract.spec.ts, because
// packages/api-client has no test runner of its own and the root `npm test` builds the client first.

const context = {
  authorization: 'Bearer propagated-user', correlationId: 'client-contract-ord4-1234',
  facilityId: '123e4567-e89b-42d3-a456-426614174001', purposeOfUse: 'direct-care',
};
const base = { id: '123e4567-e89b-42d3-a456-426614174003', patientId: '123e4567-e89b-42d3-a456-426614174004',
  facilityId: context.facilityId, sourceEhrPrescriptionId: '123e4567-e89b-42d3-a456-426614174005',
  sourceEncounterId: '123e4567-e89b-42d3-a456-426614174006', sourceEhrPrescriptionVersion: 1, status: 'accepted',
  medication: { codeSystem: null, code: null, display: 'Amoxicillin 500 mg capsule' }, doseQuantity: 1,
  doseUnit: 'capsule', routeCode: 'oral', frequency: 'Every 8 hours', instructions: 'After food',
  acceptedAt: '2026-11-20T09:00:00.000Z', version: 1, dispensing: null };
const membership = '123e4567-e89b-42d3-a456-426614174010';
const acceptance = (acceptedWith: PharmacistAcceptance['acceptedWith']): PharmacistAcceptance => ({
  acceptedAt: '2026-11-20T09:05:00.000Z', acceptedByMembershipId: membership, acceptedWith });

describe('PharmacyApiClient work item steps (ORD-4)', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });
  const respond = (payload: unknown) => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(payload),
      { status: 200, headers: { 'content-type': 'application/json' } }));
  };
  const client = new PharmacyApiClient({ baseUrl: 'https://pharmacy.test' });

  it('keeps a known step with its acceptance: null while received, and each of the four ways an item is accepted',
    async () => {
      const sent: [PharmacyStep, PharmacistAcceptance | null][] = [
        ['received', null],
        ['accepted', acceptance('accept')],
        ['dispensed', acceptance('dispensing')],
        ['accepted', acceptance('order_route')],
        ['dispensing_reversed', acceptance('hand_off')],
      ];
      respond({ items: sent.map(([pharmacyStep, pharmacistAcceptance]) => ({ ...base, pharmacyStep,
        pharmacistAcceptance })) });
      const items = await client.listWorkItems(context);
      expect(items.map((item) => [item.pharmacyStep, item.pharmacistAcceptance])).toStrictEqual(sent);
      // The rest of the item reads as before: `status` and `acceptedAt` keep their Release A meaning.
      for (const item of items) {
        expect(item).toMatchObject({ id: base.id, status: 'accepted', acceptedAt: base.acceptedAt });
      }
      respond({ ...base, pharmacyStep: 'dispensed', pharmacistAcceptance: acceptance('hand_off') });
      await expect(client.getWorkItem(base.id, context)).resolves.toMatchObject({ pharmacyStep: 'dispensed',
        pharmacistAcceptance: acceptance('hand_off') });
    });

  it('leaves both out for an older pharmacy-api, an unknown step and an unknown acceptedWith, and keeps the list',
    async () => {
      respond({ items: [
        // An older pharmacy-api, or a database without 0145: neither field.
        base,
        // A newer step, with or without an acceptance: not looked at further.
        { ...base, pharmacyStep: 'on_hold_at_counter', pharmacistAcceptance: null },
        { ...base, pharmacyStep: 'on_hold_at_counter' },
        // A newer acceptedWith, with another shape (no member): left out, not refused.
        { ...base, pharmacyStep: 'accepted', pharmacistAcceptance: { acceptedAt: '2026-11-20T09:05:00.000Z',
          acceptedByMembershipId: null, acceptedWith: 'transfer' } },
        // An acceptance without a step.
        { ...base, pharmacistAcceptance: acceptance('accept') },
        // A known step next to them, kept.
        { ...base, pharmacyStep: 'accepted', pharmacistAcceptance: acceptance('accept') },
      ] });
      const items = await client.listWorkItems(context);
      expect(items).toHaveLength(6);
      expect(items.map((item) => ['pharmacyStep' in item, 'pharmacistAcceptance' in item])).toStrictEqual([
        [false, false], [false, false], [false, false], [false, false], [false, false], [true, true]]);
      expect(items[5]).toMatchObject({ pharmacyStep: 'accepted', pharmacistAcceptance: acceptance('accept') });
    });

  it('refuses a wrong type with 502, on a read and on the list', async () => {
    const known = acceptance('accept');
    for (const malformed of [
      { pharmacyStep: 1, pharmacistAcceptance: null },
      { pharmacyStep: null, pharmacistAcceptance: null },
      // The acceptance missing next to a known step: pharmacy-api always sends the two together.
      { pharmacyStep: 'accepted' },
      { pharmacyStep: 'accepted', pharmacistAcceptance: 'accept' },
      { pharmacyStep: 'accepted', pharmacistAcceptance: [known] },
      { pharmacyStep: 'accepted', pharmacistAcceptance: { ...known, acceptedWith: 1 } },
      { pharmacyStep: 'accepted', pharmacistAcceptance: { acceptedByMembershipId: membership, acceptedWith: 'accept' } },
      { pharmacyStep: 'accepted', pharmacistAcceptance: { ...known, acceptedAt: '' } },
      { pharmacyStep: 'received', pharmacistAcceptance: { ...known, acceptedAt: 1763629500000 } },
      { pharmacyStep: 'accepted', pharmacistAcceptance: { ...known, acceptedByMembershipId: null } },
      { pharmacyStep: 'accepted', pharmacistAcceptance: { ...known, acceptedByMembershipId: 123 } },
    ]) {
      respond({ ...base, ...malformed });
      await expect(client.getWorkItem(base.id, context)).rejects.toMatchObject({ status: 502 });
    }
    respond({ items: [base, { ...base, pharmacyStep: 'accepted', pharmacistAcceptance: { ...known, acceptedAt: '' } }] });
    await expect(client.listWorkItems(context)).rejects.toMatchObject({ status: 502 });
  });
});
