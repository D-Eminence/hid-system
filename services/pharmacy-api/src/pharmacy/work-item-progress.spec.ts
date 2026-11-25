import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { INTERNAL_CALLER, READ_ONLY_POST, REQUIRED_PERMISSIONS } from '../common/decorators';
import type { DataAccessContext } from '../common/request-context';
import { WORK_ITEM_PROGRESS_MAX_IDS, WorkItemProgressDto } from './dto/work-item-progress.dto';
import { PharmacyWorkItemProgressController } from './work-item-progress.controller';
import { PharmacyOwnWork } from './own-work-access';
import { PharmacyRefills } from './prescription-refills';
import { OWN_PROGRESS_ACCEPTED_HEADER, OWN_PROGRESS_ACCEPTED_VERSION, OWN_PROGRESS_HEADER, OWN_PROGRESS_VERSION,
  PharmacyWorkItemProgressService, WORK_ITEM_PROGRESS_QUERY } from './work-item-progress.service';

// Fictional ids only.
const ids = {
  patient: '7a1c0d2e-0000-4000-8000-000000000001', facility: '7a1c0d2e-0000-4000-8000-000000000002',
  account: '7a1c0d2e-0000-4000-8000-000000000003', membership: '7a1c0d2e-0000-4000-8000-000000000004',
  rxA: '7a1c0d2e-0000-4000-8000-00000000000a', rxB: '7a1c0d2e-0000-4000-8000-00000000000b',
  rxC: '7a1c0d2e-0000-4000-8000-00000000000c', rxD: '7a1c0d2e-0000-4000-8000-00000000000d',
  workA: '7a1c0d2e-0000-4000-8000-0000000000a1', workB: '7a1c0d2e-0000-4000-8000-0000000000b1',
  workC: '7a1c0d2e-0000-4000-8000-0000000000c1', workD: '7a1c0d2e-0000-4000-8000-0000000000d1',
};
const doctorPermissions = ['ehr.prescription.read', 'ehr.prescription.write'];
const context: DataAccessContext = {
  correlationId: 'progress-correlation-1', facilityId: ids.facility, membershipId: ids.membership,
  purposeOfUse: 'direct-care', authorization: 'Bearer doctor', actor: {
    id: ids.account, subject: 'staff:doctor', accountId: ids.account, authenticationMethod: 'local',
    roles: ['doctor'], permissions: doctorPermissions, facilityIds: [ids.facility], facilities: [],
    facility: { id: ids.facility, membershipId: ids.membership, organizationId: ids.facility, name: 'Test Clinic',
      roles: ['doctor'], permissions: doctorPermissions, isPrimary: true } },
};
const allowed = { allowed: true, patientId: ids.patient, facilityId: ids.facility, membershipId: ids.membership,
  scope: 'read_records', purpose: 'direct-care', breakGlass: false };

const STATES = /from pharmacy\.own_work_item_states\(\$1::uuid\[\]\)/;
const STEPS = /from pharmacy\.own_work_item_steps\(\$1::uuid\[\]\)/;
/** The pharmacist who accepted (ORD-4); the progress never names them. */
const acceptor = '7a1c0d2e-0000-4000-8000-000000000005';

/** ORD-4's reader per work item: sent automatically or handed in, and the acceptance, if any. */
type Steps = Record<string, { sent: boolean; acceptedAt?: Date; acceptedWith?: 'accept' | 'dispensing' }>;

/**
 * The read's database. `own` turns 0133's (and ORD-4's) reader on. Without
 * `own.steps`, ORD-4's reader is not there (42883: a Release A schema) and
 * 0133's answers; with it, ORD-4's answers 0133's columns and the steps.
 */
function harness(rows: unknown[], decision: unknown = allowed,
  own?: { withdrawn?: string[]; reasons?: Record<string, string>; error?: Error & { code?: string }; steps?: Steps;
    stepsError?: Error & { code?: string } }) {
  const query = jest.fn(async (sql: string, values: unknown[] = []) => {
    if (sql === WORK_ITEM_PROGRESS_QUERY) return { rows };
    if (STEPS.test(sql)) {
      if (own?.stepsError) throw own.stepsError;
      if (!own?.steps) throw Object.assign(new Error('function pharmacy.own_work_item_steps(uuid[]) does not exist'),
        { code: '42883' });
      const steps = own.steps;
      return { rows: (values[0] as string[]).map((item) => {
        const withdrawn = own.withdrawn?.includes(item) ?? false;
        const step = steps[item] ?? { sent: true };
        return { work_item_id: item, basis: 'consent', withdrawn,
          withdrawn_reason: withdrawn ? own.reasons?.[item] ?? 'changed' : null, sent_automatically: step.sent,
          accepted_at: step.acceptedAt ?? null, accepted_by_membership_id: step.acceptedAt ? acceptor : null,
          accepted_with: step.acceptedAt ? step.acceptedWith ?? 'accept' : null };
      }) };
    }
    if (STATES.test(sql)) {
      if (own?.error) throw own.error;
      return { rows: (values[0] as string[]).map((item) => {
        const withdrawn = own?.withdrawn?.includes(item) ?? false;
        return { work_item_id: item, basis: 'consent', withdrawn,
          withdrawn_reason: withdrawn ? own?.reasons?.[item] ?? 'changed' : null };
      }) };
    }
    return { rows: [] };
  });
  const database = { withTransaction: jest.fn(async (_context: unknown, operation: (client: unknown) => unknown) =>
    operation({ query })) };
  const identity = { authorize: jest.fn().mockResolvedValue(decision) };
  const audit = { recordWithClient: jest.fn() };
  const service = new PharmacyWorkItemProgressService(database as never, identity as never, audit as never,
    own ? new PharmacyOwnWork(true) : undefined);
  return { service, query, database, identity, audit };
}

describe('POST pharmacy/work-items/progress (ORD-3)', () => {
  it('is for ehr-api only, with the EHR read permission, not a pharmacist permission', () => {
    const handler = PharmacyWorkItemProgressController.prototype.read;
    expect(Reflect.getMetadata(INTERNAL_CALLER, handler)).toBe('ehr-api');
    expect(Reflect.getMetadata(READ_ONLY_POST, handler)).toBe(true);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual(['ehr.prescription.read']);
    expect(Reflect.getMetadata('path', PharmacyWorkItemProgressController)).toBe('pharmacy/work-items');
    expect(Reflect.getMetadata('path', handler)).toBe('progress');
  });

  it('takes 1 to 100 distinct prescription ids and one patient, and nothing else', async () => {
    const check = (body: unknown) => validate(plainToInstance(WorkItemProgressDto, body),
      { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
    const many = (count: number) => Array.from({ length: count }, (_, index) =>
      `7a1c0d2e-0000-4000-8000-${String(index).padStart(12, '0')}`);
    expect(await check({ patientId: ids.patient, sourceEhrPrescriptionIds: many(WORK_ITEM_PROGRESS_MAX_IDS) })).toEqual([]);
    expect(await check({ patientId: ids.patient, sourceEhrPrescriptionIds: [] })).not.toEqual([]);
    expect(await check({ patientId: ids.patient, sourceEhrPrescriptionIds: many(101) })).not.toEqual([]);
    expect(await check({ patientId: ids.patient, sourceEhrPrescriptionIds: [ids.rxA, ids.rxA] })).not.toEqual([]);
    expect(await check({ patientId: ids.patient, sourceEhrPrescriptionIds: ['HID-ABC123'] })).not.toEqual([]);
    expect(await check({ patientId: 'HID-ABC123', sourceEhrPrescriptionIds: [ids.rxA] })).not.toEqual([]);
    expect(await check({ patientId: ids.patient, sourceEhrPrescriptionIds: [ids.rxA], healthId: 'HID-ABC123' }))
      .not.toEqual([]);
  });

  it('answers every id asked, in order: not received, received, dispensed and reversed', async () => {
    const { service, query, audit } = harness([
      { work_item_id: ids.workA, source_ehr_prescription_id: ids.rxA, accepted_at: new Date('2026-11-18T10:40:00Z'),
        dispensed_at: null, reversed_at: null },
      { work_item_id: ids.workB, source_ehr_prescription_id: ids.rxB, accepted_at: new Date('2026-11-18T10:41:00Z'),
        dispensed_at: new Date('2026-11-18T11:05:00Z'), reversed_at: null },
      { work_item_id: ids.workC, source_ehr_prescription_id: ids.rxC, accepted_at: new Date('2026-11-18T10:42:00Z'),
        dispensed_at: new Date('2026-11-18T11:06:00Z'), reversed_at: new Date('2026-11-18T11:30:00Z') },
    ]);
    const answer = await service.read(context, { patientId: ids.patient,
      sourceEhrPrescriptionIds: [ids.rxD, ids.rxC, ids.rxB, ids.rxA] });
    expect(answer.items).toEqual([
      { sourceEhrPrescriptionId: ids.rxD, status: 'not_received', receivedAt: null, dispensedAt: null, reversedAt: null },
      { sourceEhrPrescriptionId: ids.rxC, status: 'dispensing_reversed', receivedAt: '2026-11-18T10:42:00.000Z',
        dispensedAt: '2026-11-18T11:06:00.000Z', reversedAt: '2026-11-18T11:30:00.000Z' },
      { sourceEhrPrescriptionId: ids.rxB, status: 'dispensed', receivedAt: '2026-11-18T10:41:00.000Z',
        dispensedAt: '2026-11-18T11:05:00.000Z', reversedAt: null },
      { sourceEhrPrescriptionId: ids.rxA, status: 'received', receivedAt: '2026-11-18T10:40:00.000Z',
        dispensedAt: null, reversedAt: null },
    ]);
    expect(query).toHaveBeenCalledWith(WORK_ITEM_PROGRESS_QUERY,
      [ids.patient, ids.facility, [ids.rxD, ids.rxC, ids.rxB, ids.rxA]]);
    expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), context, 'pharmacy.work-item.progress.read',
      { patientId: ids.patient, resourceType: 'pharmacy-work-item-collection', resourceId: ids.facility },
      { requestedCount: 4, foundCount: 3, workItemIds: [ids.workA, ids.workB, ids.workC], breakGlass: false });
    expect(JSON.stringify(answer)).not.toMatch(/unverified/i);
  });

  it('answers withdrawn (0133) for an item whose automatic send was withdrawn before it was dispensed', async () => {
    const { service } = harness([
      { work_item_id: ids.workA, source_ehr_prescription_id: ids.rxA, accepted_at: new Date('2026-11-18T10:40:00Z'),
        dispensed_at: null, reversed_at: null },
      { work_item_id: ids.workB, source_ehr_prescription_id: ids.rxB, accepted_at: new Date('2026-11-18T10:41:00Z'),
        dispensed_at: new Date('2026-11-18T11:05:00Z'), reversed_at: null },
    ], allowed, { withdrawn: [ids.workA, ids.workB] });
    const answer = await service.read(context, { patientId: ids.patient, sourceEhrPrescriptionIds: [ids.rxA, ids.rxB] },
      true);
    expect(answer.items).toEqual([
      { sourceEhrPrescriptionId: ids.rxA, status: 'withdrawn', receivedAt: '2026-11-18T10:40:00.000Z',
        dispensedAt: null, reversedAt: null },
      { sourceEhrPrescriptionId: ids.rxB, status: 'dispensed', receivedAt: '2026-11-18T10:41:00.000Z',
        dispensedAt: '2026-11-18T11:05:00.000Z', reversedAt: null },
    ]);
  });

  // 0133 D14 (owner's Q121 A): sent to another facility's pharmacy before it was dispensed. The status order is a
  // reversal, a dispensing, sent elsewhere, withdrawn, else received.
  const progressRows = [
    { work_item_id: ids.workA, source_ehr_prescription_id: ids.rxA, accepted_at: new Date('2026-11-19T09:00:00Z'),
      dispensed_at: null, reversed_at: null },
    { work_item_id: ids.workB, source_ehr_prescription_id: ids.rxB, accepted_at: new Date('2026-11-19T09:01:00Z'),
      dispensed_at: null, reversed_at: null },
    { work_item_id: ids.workC, source_ehr_prescription_id: ids.rxC, accepted_at: new Date('2026-11-19T09:02:00Z'),
      dispensed_at: new Date('2026-11-19T10:00:00Z'), reversed_at: null },
    { work_item_id: ids.workD, source_ehr_prescription_id: ids.rxD, accepted_at: new Date('2026-11-19T09:03:00Z'),
      dispensed_at: new Date('2026-11-19T10:01:00Z'), reversed_at: new Date('2026-11-19T10:30:00Z') },
  ];
  const progressOwn = { withdrawn: [ids.workA, ids.workB, ids.workC, ids.workD],
    reasons: { [ids.workA]: 'sent_elsewhere', [ids.workB]: 'changed', [ids.workC]: 'sent_elsewhere',
      [ids.workD]: 'sent_elsewhere' } };
  const asked = { patientId: ids.patient, sourceEhrPrescriptionIds: [ids.rxA, ids.rxB, ids.rxC, ids.rxD] };

  it('with X-HID-Own-Progress: 0133, answers sent_elsewhere and withdrawn, after a reversal and a dispensing', async () => {
    const { service } = harness(progressRows, allowed, progressOwn);
    const answer = await service.read(context, asked, true);
    expect(answer.items).toEqual([
      { sourceEhrPrescriptionId: ids.rxA, status: 'sent_elsewhere', receivedAt: '2026-11-19T09:00:00.000Z',
        dispensedAt: null, reversedAt: null },
      { sourceEhrPrescriptionId: ids.rxB, status: 'withdrawn', receivedAt: '2026-11-19T09:01:00.000Z',
        dispensedAt: null, reversedAt: null },
      { sourceEhrPrescriptionId: ids.rxC, status: 'dispensed', receivedAt: '2026-11-19T09:02:00.000Z',
        dispensedAt: '2026-11-19T10:00:00.000Z', reversedAt: null },
      { sourceEhrPrescriptionId: ids.rxD, status: 'dispensing_reversed', receivedAt: '2026-11-19T09:03:00.000Z',
        dispensedAt: '2026-11-19T10:01:00.000Z', reversedAt: '2026-11-19T10:30:00.000Z' },
    ]);
  });

  it('without the header (an ehr-api from before 0133), answers only the four statuses that image knows', async () => {
    const { service } = harness(progressRows, allowed, progressOwn);
    const answer = await service.read(context, asked);
    expect(answer.items).toEqual([
      { sourceEhrPrescriptionId: ids.rxA, status: 'not_received', receivedAt: null, dispensedAt: null, reversedAt: null },
      { sourceEhrPrescriptionId: ids.rxB, status: 'received', receivedAt: '2026-11-19T09:01:00.000Z',
        dispensedAt: null, reversedAt: null },
      { sourceEhrPrescriptionId: ids.rxC, status: 'dispensed', receivedAt: '2026-11-19T09:02:00.000Z',
        dispensedAt: '2026-11-19T10:00:00.000Z', reversedAt: null },
      { sourceEhrPrescriptionId: ids.rxD, status: 'dispensing_reversed', receivedAt: '2026-11-19T09:03:00.000Z',
        dispensedAt: '2026-11-19T10:01:00.000Z', reversedAt: '2026-11-19T10:30:00.000Z' },
    ]);
    expect(answer.items.every((item) => ['not_received', 'received', 'dispensed', 'dispensing_reversed']
      .includes(item.status))).toBe(true);
    expect((await harness(progressRows, allowed, progressOwn).service.read(context, asked, false)).items)
      .toEqual(answer.items);
  });

  it('passes X-HID-Own-Progress: 0133 and (ORD-4) X-HID-Own-Progress-Accepted: ord4 from the request, each matched '
    + 'exactly, the second only with the first', async () => {
    expect([OWN_PROGRESS_HEADER, OWN_PROGRESS_VERSION]).toEqual(['x-hid-own-progress', '0133']);
    expect([OWN_PROGRESS_ACCEPTED_HEADER, OWN_PROGRESS_ACCEPTED_VERSION]).toEqual(['x-hid-own-progress-accepted', 'ord4']);
    const read = jest.fn(async () => ({ items: [] }));
    const controller = new PharmacyWorkItemProgressController({ read } as never);
    const request = (own: Record<string, string>) => {
      const headers: Record<string, string> = { authorization: 'Bearer doctor', 'x-purpose-of-use': 'direct-care', ...own };
      return { correlationId: 'progress-correlation-1', actor: context.actor, facilityId: ids.facility, method: 'POST',
        headers, header: (name: string) => headers[name.toLowerCase()] } as never;
    };
    const body = { patientId: ids.patient, sourceEhrPrescriptionIds: [ids.rxA] };
    const both = { 'x-hid-own-progress': '0133', 'x-hid-own-progress-accepted': 'ord4' };
    for (const [headers, current, accepted] of [
      [{ 'x-hid-own-progress': '0133' }, true, false], [{}, false, false],
      [{ 'x-hid-own-progress': '0134' }, false, false], [{ 'x-hid-own-progress': '0133 ' }, false, false],
      // ORD-4: both headers, each exactly.
      [both, true, true],
      [{ 'x-hid-own-progress-accepted': 'ord4' }, false, false],
      [{ 'x-hid-own-progress': '0134', 'x-hid-own-progress-accepted': 'ord4' }, false, false],
      [{ ...both, 'x-hid-own-progress-accepted': 'ORD4' }, true, false],
      [{ ...both, 'x-hid-own-progress-accepted': 'ord4 ' }, true, false],
      [{ ...both, 'x-hid-own-progress-accepted': 'ord5' }, true, false],
      [{ ...both, 'x-hid-own-progress-accepted': '0133' }, true, false],
      [{ ...both, 'x-hid-own-progress-accepted': 'ord4, ord4' }, true, false],
      [{ 'x-hid-own-progress': 'ord4', 'x-hid-own-progress-accepted': '0133' }, false, false],
    ] as const) {
      read.mockClear();
      await controller.read(body as never, request(headers));
      expect(read).toHaveBeenCalledWith(expect.objectContaining({ facilityId: ids.facility }), body, current, accepted);
    }
  });

  it('gets 0133\'s own-work reader injected by the Pharmacy module', () => {
    expect((Reflect.getMetadata('design:paramtypes', PharmacyWorkItemProgressService) as unknown[])[3]).toBe(PharmacyOwnWork);
  });

  it('answers received when the withdrawal cannot be read (the answer never fails because of it)', async () => {
    const { service } = harness([
      { work_item_id: ids.workA, source_ehr_prescription_id: ids.rxA, accepted_at: new Date('2026-11-18T10:40:00Z'),
        dispensed_at: null, reversed_at: null },
    ], allowed, { error: Object.assign(new Error('function does not exist'), { code: '42883' }) });
    const answer = await service.read(context, { patientId: ids.patient, sourceEhrPrescriptionIds: [ids.rxA] });
    expect(answer.items[0]!.status).toBe('received');
  });

  it('audits the lookup even when nothing is found', async () => {
    const { service, audit } = harness([]);
    const answer = await service.read(context, { patientId: ids.patient, sourceEhrPrescriptionIds: [ids.rxA] });
    expect(answer.items).toEqual([{ sourceEhrPrescriptionId: ids.rxA, status: 'not_received', receivedAt: null,
      dispensedAt: null, reversedAt: null }]);
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), context, 'pharmacy.work-item.progress.read',
      expect.objectContaining({ patientId: ids.patient }), expect.objectContaining({ requestedCount: 1, foundCount: 0 }));
  });

  it('refuses with 403 and an audited denial when Identity does not allow the read, before any read', async () => {
    const { service, query, audit } = harness([], { ...allowed, allowed: false });
    await expect(service.read(context, { patientId: ids.patient, sourceEhrPrescriptionIds: [ids.rxA] }))
      .rejects.toMatchObject({ status: 403, code: 'PHARMACY_ACCESS_DENIED' });
    expect(query).not.toHaveBeenCalledWith(WORK_ITEM_PROGRESS_QUERY, expect.anything());
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), context, 'pharmacy.work-item.progress.read',
      expect.objectContaining({ patientId: ids.patient }), expect.objectContaining({ reason: 'identity_authorization' }),
      'denied');
  });

  it('asks Identity as a GET read, whatever the internal call\'s method, and keeps the clinician\'s cookie', async () => {
    const { service, identity } = harness([]);
    const cookieOnly: DataAccessContext = { ...context, authorization: undefined, userCookie: 'hid_access=opaque',
      requestMethod: 'POST' };
    await service.read(cookieOnly, { patientId: ids.patient, sourceEhrPrescriptionIds: [ids.rxA] });
    expect(identity.authorize).toHaveBeenCalledWith(ids.patient, 'read_records',
      expect.objectContaining({ requestMethod: 'GET', userCookie: 'hid_access=opaque' }));
    expect(identity.authorize.mock.calls[0][2]).not.toHaveProperty('csrfToken', expect.anything());
    expect(cookieOnly.requestMethod).toBe('POST');
  });

  it('audits Identity\'s own 403 as a denied read of the patient, and passes it on', async () => {
    const { DomainProblem } = await import('../common/problem');
    const { service, identity, query, audit } = harness([]);
    identity.authorize.mockRejectedValue(new DomainProblem(403, 'CONSENT_REQUIRED', 'Consent is required'));
    await expect(service.read(context, { patientId: ids.patient, sourceEhrPrescriptionIds: [ids.rxA] }))
      .rejects.toMatchObject({ status: 403, code: 'CONSENT_REQUIRED' });
    expect(query).not.toHaveBeenCalledWith(WORK_ITEM_PROGRESS_QUERY, expect.anything());
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), context, 'pharmacy.work-item.progress.read',
      expect.objectContaining({ patientId: ids.patient }), expect.objectContaining({ reason: 'identity_refusal' }),
      'denied');
  });

  it('does not audit an unreachable Identity as a denial', async () => {
    const { DomainProblem } = await import('../common/problem');
    const { service, identity, audit } = harness([]);
    identity.authorize.mockRejectedValue(new DomainProblem(503, 'IDENTITY_SERVICE_UNAVAILABLE', 'Unavailable'));
    await expect(service.read(context, { patientId: ids.patient, sourceEhrPrescriptionIds: [ids.rxA] }))
      .rejects.toMatchObject({ status: 503 });
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('reads this facility\'s own work only, read-only, under row-level security', () => {
    expect(WORK_ITEM_PROGRESS_QUERY).toMatch(/w\.order_route_id is null/);
    expect(WORK_ITEM_PROGRESS_QUERY).toMatch(/w\.facility_id=\$2::uuid/);
    expect(WORK_ITEM_PROGRESS_QUERY).toMatch(/w\.patient_id=\$1::uuid/);
    expect(WORK_ITEM_PROGRESS_QUERY).not.toMatch(/\b(insert|update|delete|for update|for share)\b/i);
  });
});

/*
 * ORD-4: the pharmacy item may read 'accepted' (a pharmacist here accepted it, by the accept route or its first
 * dispensing, or handed it in by hand) with `acceptedAt`, from ORD-4's steps reader in the same single reader
 * statement as 0133's withdrawn flag; WORK_ITEM_PROGRESS_QUERY is unchanged. Which status wins: a reversal, a
 * dispensing, sent elsewhere, withdrawn, accepted, received. Answered only to a caller sending both headers;
 * otherwise 'accepted' reads 'received' and `acceptedAt` is left out, so an ehr-api from before ORD-4 (which treats a
 * whole answer with an unknown status as unknown) reads every answer as before, whichever image goes first.
 */
describe('ORD-4: accepted in the prescriber\'s progress', () => {
  const rx = (n: number) => `7a1c0d2e-0000-4000-8000-1000000000${String(n).padStart(2, '0')}`;
  const work = (n: number) => `7a1c0d2e-0000-4000-8000-2000000000${String(n).padStart(2, '0')}`;
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 20, 9, minute));
  const iso = (minute: number) => at(minute).toISOString();
  const progressRow = (n: number, times: { dispensed?: number; reversed?: number } = {}) => ({ work_item_id: work(n),
    source_ehr_prescription_id: rx(n), accepted_at: at(n), dispensed_at: times.dispensed === undefined ? null
      : at(times.dispensed), reversed_at: times.reversed === undefined ? null : at(times.reversed) });
  // 1 received (sent automatically, no acceptance); 2 accepted (09:21); 3 handed in by hand (accepted when it was
  // made, 09:03); 4 accepted, then held (withdrawn, changed); 5 accepted, then sent to another
  // facility's pharmacy; 6 accepted, then dispensed; 7 accepted by its dispensing, dispensed and reversed;
  // 8 dispensed before ORD-4 (sent automatically, no acceptance); 9 received, then held; 10 not here; 11 handed in by
  // hand (09:11), then dispensed, as a hand-off usually is: its acceptedAt is still the time it was handed in.
  const rows = [progressRow(1), progressRow(2), progressRow(3), progressRow(4), progressRow(5),
    progressRow(6, { dispensed: 40 }), progressRow(7, { dispensed: 41, reversed: 50 }), progressRow(8, { dispensed: 42 }),
    progressRow(9), progressRow(11, { dispensed: 43 })];
  const own = { withdrawn: [work(4), work(5), work(9)], reasons: { [work(4)]: 'changed', [work(5)]: 'sent_elsewhere',
    [work(9)]: 'changed' }, steps: {
    [work(1)]: { sent: true }, [work(2)]: { sent: true, acceptedAt: at(21) }, [work(3)]: { sent: false },
    [work(4)]: { sent: true, acceptedAt: at(24) }, [work(5)]: { sent: true, acceptedAt: at(25) },
    [work(6)]: { sent: true, acceptedAt: at(26) },
    [work(7)]: { sent: true, acceptedAt: at(41), acceptedWith: 'dispensing' as const },
    [work(8)]: { sent: true }, [work(9)]: { sent: true }, [work(11)]: { sent: false } } };
  const asked = { patientId: ids.patient, sourceEhrPrescriptionIds: Array.from({ length: 11 }, (_, i) => rx(i + 1)) };
  const item = (n: number, status: string, times: { dispensed?: number; reversed?: number; accepted?: number | null } = {}) =>
    ({ sourceEhrPrescriptionId: rx(n), status, receivedAt: status === 'not_received' ? null : iso(n),
      dispensedAt: times.dispensed === undefined ? null : iso(times.dispensed),
      reversedAt: times.reversed === undefined ? null : iso(times.reversed),
      ...(times.accepted === undefined ? {} : { acceptedAt: times.accepted === null ? null : iso(times.accepted) }) });

  it('with both headers answers accepted and acceptedAt, in the order reversal, dispensing, sent elsewhere, '
    + 'withdrawn, accepted, received', async () => {
    const { service, query } = harness(rows, allowed, own);
    const answer = await service.read(context, asked, true, true);
    expect(answer.items).toEqual([
      item(1, 'received', { accepted: null }),
      item(2, 'accepted', { accepted: 21 }),
      // Handed in by hand: accepted by that pharmacist when it was made.
      item(3, 'accepted', { accepted: 3 }),
      item(4, 'withdrawn', { accepted: 24 }),
      item(5, 'sent_elsewhere', { accepted: 25 }),
      item(6, 'dispensed', { dispensed: 40, accepted: 26 }),
      item(7, 'dispensing_reversed', { dispensed: 41, reversed: 50, accepted: 41 }),
      item(8, 'dispensed', { dispensed: 42, accepted: null }),
      item(9, 'withdrawn', { accepted: null }),
      { sourceEhrPrescriptionId: rx(10), status: 'not_received', receivedAt: null, dispensedAt: null, reversedAt: null,
        acceptedAt: null },
      // Dispensed, the hand-off keeps the acceptance it was made with (no un-accept).
      item(11, 'dispensed', { dispensed: 43, accepted: 11 })]);
    // One reader statement (ORD-4's), and today's progress query, unchanged.
    expect(query.mock.calls.filter(([sql]) => STEPS.test(sql) || STATES.test(sql)).map(([sql]) => STEPS.test(sql)))
      .toEqual([true]);
    expect(WORK_ITEM_PROGRESS_QUERY).not.toMatch(/acceptance|own_work_item_steps|own_prescription_sends/);
    // The progress never names the pharmacist.
    expect(JSON.stringify(answer)).not.toContain(acceptor);
  });

  it('with X-HID-Own-Progress: 0133 only (a Release A ehr-api), answers accepted as received, with no acceptedAt', async () => {
    const answer = await harness(rows, allowed, own).service.read(context, asked, true);
    expect(answer.items).toEqual([item(1, 'received'), item(2, 'received'), item(3, 'received'), item(4, 'withdrawn'),
      item(5, 'sent_elsewhere'), item(6, 'dispensed', { dispensed: 40 }),
      item(7, 'dispensing_reversed', { dispensed: 41, reversed: 50 }), item(8, 'dispensed', { dispensed: 42 }),
      item(9, 'withdrawn'), item(10, 'not_received'), item(11, 'dispensed', { dispensed: 43 })]);
    expect(answer.items.some((entry) => 'acceptedAt' in entry)).toBe(false);
    expect((await harness(rows, allowed, own).service.read(context, asked, true, false)).items).toEqual(answer.items);
  });

  it('with no header (an ehr-api from before 0133), answers only the four statuses that image knows', async () => {
    const expected = [item(1, 'received'), item(2, 'received'), item(3, 'received'), item(4, 'received'),
      item(5, 'not_received'), item(6, 'dispensed', { dispensed: 40 }),
      item(7, 'dispensing_reversed', { dispensed: 41, reversed: 50 }), item(8, 'dispensed', { dispensed: 42 }),
      item(9, 'received'), item(10, 'not_received'), item(11, 'dispensed', { dispensed: 43 })];
    expect((await harness(rows, allowed, own).service.read(context, asked)).items).toEqual(expected);
    // The ORD-4 header alone is not enough: it is taken only with 0133's.
    expect((await harness(rows, allowed, own).service.read(context, asked, false, true)).items).toEqual(expected);
  });

  it('on a schema without ORD-4\'s reader (42883) never answers accepted: 0133\'s reader answers the withdrawn flag, '
    + 'and acceptedAt is null', async () => {
    const { service, query } = harness(rows, allowed, { withdrawn: own.withdrawn, reasons: own.reasons });
    const answer = await service.read(context, asked, true, true);
    expect(answer.items).toEqual([item(1, 'received', { accepted: null }), item(2, 'received', { accepted: null }),
      item(3, 'received', { accepted: null }), item(4, 'withdrawn', { accepted: null }),
      item(5, 'sent_elsewhere', { accepted: null }), item(6, 'dispensed', { dispensed: 40, accepted: null }),
      item(7, 'dispensing_reversed', { dispensed: 41, reversed: 50, accepted: null }),
      item(8, 'dispensed', { dispensed: 42, accepted: null }), item(9, 'withdrawn', { accepted: null }),
      item(10, 'not_received', { accepted: null }), item(11, 'dispensed', { dispensed: 43, accepted: null })]);
    expect(query.mock.calls.map(([sql]) => sql).filter((sql) => STEPS.test(sql) || STATES.test(sql) || /savepoint/.test(sql)))
      .toEqual(['savepoint pharmacy_own_work_states', expect.stringMatching(STEPS),
        'rollback to savepoint pharmacy_own_work_states', expect.stringMatching(STATES),
        'release savepoint pharmacy_own_work_states']);
  });

  it('answers received with acceptedAt null when the steps cannot be read, and never fails because of them',
    async () => {
      const { service } = harness(rows.slice(0, 3), allowed, { ...own,
        stepsError: Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }) });
      const answer = await service.read(context, { patientId: ids.patient, sourceEhrPrescriptionIds: [rx(1), rx(2), rx(3)] },
        true, true);
      expect(answer.items).toEqual([item(1, 'received', { accepted: null }), item(2, 'received', { accepted: null }),
        item(3, 'received', { accepted: null })]);
    });

  it('passes a serialization failure of the steps on, so the read is run again', async () => {
    const conflict = Object.assign(new Error('could not serialize access'), { code: '40001' });
    const { service } = harness(rows, allowed, { ...own, stepsError: conflict });
    await expect(service.read(context, asked, true, true)).rejects.toBe(conflict);
  });

  it('keeps the audit row as it was: the prescriptions asked about and the work items found', async () => {
    const { service, audit } = harness(rows, allowed, own);
    await service.read(context, asked, true, true);
    expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), context, 'pharmacy.work-item.progress.read',
      { patientId: ids.patient, resourceType: 'pharmacy-work-item-collection', resourceId: ids.facility },
      { requestedCount: 11, foundCount: 10, workItemIds: rows.map((row) => row.work_item_id), breakGlass: false });
  });
});

/*
 * ORD-12 (refills, 0154): an item may have several fills. The progress reads
 * each item once (WORK_ITEM_PROGRESS_QUERY, setting on or off): `dispensedAt`
 * the first fill (0133's claim time); 'dispensed' while any fill stands (is
 * not reversed), and 'dispensing_reversed' with `reversedAt` (the latest
 * fill's reversal) only once every fill is reversed; and while
 * PRESCRIPTION_REFILLS_ENABLED is on `lastFilledAt`, the latest fill's time.
 * (The same statement was run against PostgreSQL 16 with 0154: one row for an
 * item with two fills, the first and the latest times; the verifier reads it
 * through ehr-api after a refill is reversed.)
 */
describe('ORD-12: refills in the prescriber\'s progress', () => {
  const first = new Date('2026-11-18T11:05:00Z');
  const latest = new Date('2026-11-21T09:30:00Z');
  const rows = [
    { work_item_id: ids.workA, source_ehr_prescription_id: ids.rxA, accepted_at: new Date('2026-11-18T10:40:00Z'),
      dispensed_at: first, last_filled_at: latest, reversed_at: null },
    { work_item_id: ids.workB, source_ehr_prescription_id: ids.rxB, accepted_at: new Date('2026-11-18T10:41:00Z'),
      dispensed_at: first, last_filled_at: latest, reversed_at: new Date('2026-11-21T10:00:00Z'), fill_standing: false },
    { work_item_id: ids.workC, source_ehr_prescription_id: ids.rxC, accepted_at: new Date('2026-11-18T10:42:00Z'),
      dispensed_at: null, last_filled_at: null, reversed_at: null },
  ];
  const asked = { patientId: ids.patient, sourceEhrPrescriptionIds: [ids.rxA, ids.rxB, ids.rxC, ids.rxD] };
  const build = (on: boolean) => {
    const built = harness(rows);
    const service = new PharmacyWorkItemProgressService(built.database as never, built.identity as never,
      built.audit as never, undefined, new PharmacyRefills(on));
    return { ...built, service };
  };

  it('PR1 reads each item\'s fills once, in one lateral: the first fill, the latest fill and the latest fill\'s '
    + 'reversal, by fill number, and whether a fill stands', () => {
    const flat = WORK_ITEM_PROGRESS_QUERY.replace(/\s+/g, ' ');
    expect(flat).toContain('f.dispensed_at, f.last_filled_at, f.reversed_at, f.fill_standing from pharmacy.work_items w '
      + 'left join lateral (select (array_agg(df.dispensed_at order by df.fill_number asc))[1] as dispensed_at, '
      + '(array_agg(df.dispensed_at order by df.fill_number desc))[1] as last_filled_at, '
      + '(array_agg(rs.reversed_at order by df.fill_number desc))[1] as reversed_at, '
      + 'coalesce(bool_or(rs.id is null), false) as fill_standing from pharmacy.dispensings df '
      + 'left join pharmacy.dispensing_reversals rs on rs.dispensing_id=df.id where df.work_item_id=w.id) f on true');
    // The fills and their reversals once each: every row read runs the clinician's read policies.
    expect(flat.match(/pharmacy\.dispensings\b/g)).toHaveLength(1);
    expect(flat.match(/pharmacy\.dispensing_reversals\b/g)).toHaveLength(1);
    expect(flat).not.toMatch(/left join pharmacy\.dispensings d on/);
  });

  it('PR2 setting off: today\'s fields; dispensedAt the first fill; every fill reversed reads the latest reversal', async () => {
    const { service } = build(false);
    const answer = await service.read(context, asked, true, true);
    expect(answer.items).toEqual([
      { sourceEhrPrescriptionId: ids.rxA, status: 'dispensed', receivedAt: '2026-11-18T10:40:00.000Z',
        dispensedAt: first.toISOString(), reversedAt: null, acceptedAt: null },
      { sourceEhrPrescriptionId: ids.rxB, status: 'dispensing_reversed', receivedAt: '2026-11-18T10:41:00.000Z',
        dispensedAt: first.toISOString(), reversedAt: '2026-11-21T10:00:00.000Z', acceptedAt: null },
      { sourceEhrPrescriptionId: ids.rxC, status: 'received', receivedAt: '2026-11-18T10:42:00.000Z',
        dispensedAt: null, reversedAt: null, acceptedAt: null },
      { sourceEhrPrescriptionId: ids.rxD, status: 'not_received', receivedAt: null, dispensedAt: null, reversedAt: null,
        acceptedAt: null }]);
  });

  it('PR3 setting on: lastFilledAt after today\'s fields, the latest fill\'s time, null before the first fill', async () => {
    const { service } = build(true);
    const answer = await service.read(context, asked, true, true);
    expect(answer.items.map((item) => [item.status, item.dispensedAt, item.lastFilledAt])).toEqual([
      ['dispensed', first.toISOString(), latest.toISOString()],
      ['dispensing_reversed', first.toISOString(), latest.toISOString()],
      ['received', null, null], ['not_received', null, null]]);
    expect(Object.keys(answer.items[0]!)).toEqual(['sourceEhrPrescriptionId', 'status', 'receivedAt', 'dispensedAt',
      'reversedAt', 'acceptedAt', 'lastFilledAt']);
  });

  it('PR4 an older ehr-api (no headers) gets the same times, with the statuses it knows', async () => {
    const { service } = build(true);
    const answer = await service.read(context, asked);
    expect(answer.items.map((item) => [item.status, item.lastFilledAt])).toEqual([['dispensed', latest.toISOString()],
      ['dispensing_reversed', latest.toISOString()], ['received', null], ['not_received', null]]);
  });

  it('PR5 a refill reversed while an earlier fill stands reads dispensed, without reversedAt; so does a fill after a '
    + 'reversed one', async () => {
    const refillReversed = { work_item_id: ids.workA, source_ehr_prescription_id: ids.rxA,
      accepted_at: new Date('2026-11-18T10:40:00Z'), dispensed_at: first, last_filled_at: latest,
      reversed_at: new Date('2026-11-21T10:00:00Z'), fill_standing: true };
    const fillAfterReversal = { work_item_id: ids.workB, source_ehr_prescription_id: ids.rxB,
      accepted_at: new Date('2026-11-18T10:41:00Z'), dispensed_at: first, last_filled_at: latest, reversed_at: null,
      fill_standing: true };
    for (const on of [false, true]) {
      const built = harness([refillReversed, fillAfterReversal]);
      const service = new PharmacyWorkItemProgressService(built.database as never, built.identity as never,
        built.audit as never, undefined, new PharmacyRefills(on));
      const answer = await service.read(context, { patientId: ids.patient, sourceEhrPrescriptionIds: [ids.rxA, ids.rxB] },
        true, true);
      expect(answer.items.map((item) => [item.status, item.dispensedAt, item.reversedAt])).toEqual([
        ['dispensed', first.toISOString(), null], ['dispensed', first.toISOString(), null]]);
      // An ehr-api from before 0133 (no headers) reads the same.
      const older = await service.read(context, { patientId: ids.patient, sourceEhrPrescriptionIds: [ids.rxA] });
      expect(older.items.map((item) => [item.status, item.reversedAt])).toEqual([['dispensed', null]]);
    }
  });
});
