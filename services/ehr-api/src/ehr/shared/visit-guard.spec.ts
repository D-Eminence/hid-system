import type { DataAccessContext } from '../../common/request-context';
import { ClinicalNotesService } from '../clinical-notes/clinical-notes.service';
import { LabRequestsService } from '../lab-requests/lab-requests.service';
import { PrescriptionsService } from '../prescriptions/prescriptions.service';
import { NoteStatus, OrderStatus } from './clinical.dto';
import { requireVisitOpenForWork, VISIT_ENTERED_IN_ERROR_MESSAGE } from './visit-guard';

// Fictional identifiers only.
const patientId = '123e4567-e89b-42d3-a456-426614174001';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const resourceId = '123e4567-e89b-42d3-a456-426614174005';
const encounterId = '123e4567-e89b-42d3-a456-426614174006';

const context = { correlationId: 'correlation-123456', facilityId, membershipId, purposeOfUse: 'direct-care',
  authorization: 'Bearer user', actor: { id: accountId, subject: 'staff:test', accountId, authenticationMethod: 'local',
    roles: ['doctor'], permissions: ['lab.work-item.accept'], facilityIds: [facilityId], facilities: [],
    facility: { id: facilityId, membershipId, organizationId: facilityId, name: 'Test', roles: ['doctor'],
      permissions: [], isPrimary: true } } } as unknown as DataAccessContext;

const IN_ERROR = { status: 409, code: 'VISIT_ENTERED_IN_ERROR', message: VISIT_ENTERED_IN_ERROR_MESSAGE };
const VISIT_LOCK = /^select status from ehr\.encounters\s+where id = \$1 and patient_id = \$2 and facility_id = \$3 for share$/;
const VISIT_READ = /^select status from ehr\.encounters\s+where id = \$1 and patient_id = \$2 and facility_id = \$3$/;
const WRITE = /^\s*(insert into|update) ehr\.(prescriptions|lab_requests|clinical_notes)\b/;

/** A fake transaction: the visit has `visitStatus`; the order or note row is `row`. */
function fakeDatabase(visitStatus: string, row: Record<string, unknown>) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const query = jest.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (VISIT_LOCK.test(sql) || VISIT_READ.test(sql)) return { rows: [{ status: visitStatus }], rowCount: 1 };
    if (/ehr\.context_allows\(/.test(sql)) return { rows: [{ allowed: true }], rowCount: 1 };
    if (/from ehr\.record_versions/.test(sql)) return { rows: [{ createdSeen: 1, reached: 0 }], rowCount: 1 };
    if (/for (update|no key update)\s*$/.test(sql)) return { rows: [row], rowCount: 1 };
    if (WRITE.test(sql)) return { rows: [{ ...row, rowVersion: '2' }], rowCount: 1 };
    if (/from ehr\.(lab_requests|prescriptions|clinical_notes)\s+where id = \$1/.test(sql)) return { rows: [row], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const client = { query };
  const reasons: string[] = [];
  const repository = {
    run: jest.fn(async (_c, _p, _a, _e, operation) => (await operation(client)).value),
    executeCreate: jest.fn(async (_client, _c, _p, _k, _o, _d, _r, create) => {
      const created = await create();
      return { value: created.value, resourceId: created.id, details: created.details };
    }),
    setChangeReason: jest.fn(async (_client: unknown, reason: string) => { reasons.push(reason); }),
  };
  const writes = () => calls.filter((call) => WRITE.test(call.sql));
  const order = () => calls.map((call) => (VISIT_LOCK.test(call.sql) ? 'visit share'
    : /for (update|no key update)\s*$/.test(call.sql) ? 'row lock' : WRITE.test(call.sql) ? 'write' : 'other'))
    .filter((step) => step !== 'other');
  return { client, calls, repository, reasons, writes, order };
}

const noRoutes = { summaries: async () => new Map(), summary: async () => null, crossFacilityOrdersEnabled: async () => false };

describe('EHR-C8a requireVisitOpenForWork (review finding 1)', () => {
  it('locks the visit FOR SHARE and refuses a visit entered in error with 409 in plain words', async () => {
    const { client, calls } = fakeDatabase('entered_in_error', {});
    await expect(requireVisitOpenForWork(client as never, patientId, facilityId, encounterId))
      .rejects.toMatchObject(IN_ERROR);
    expect(calls[0]?.sql).toMatch(VISIT_LOCK);
    expect(calls[0]?.values).toEqual([encounterId, patientId, facilityId]);
    expect(VISIT_ENTERED_IN_ERROR_MESSAGE).not.toMatch(/unverified/i);
  });

  it.each(['planned', 'in_progress', 'on_hold', 'completed', 'cancelled'])('lets a %s visit through', async (status) => {
    const { client } = fakeDatabase(status, {});
    await expect(requireVisitOpenForWork(client as never, patientId, facilityId, encounterId)).resolves.toBeUndefined();
  });

  it('leaves a visit it cannot see to the caller\'s own 404', async () => {
    const client = { query: jest.fn(async () => ({ rows: [] })) };
    await expect(requireVisitOpenForWork(client as never, patientId, facilityId, encounterId)).resolves.toBeUndefined();
  });

  it('only reads (no lock) when asked', async () => {
    const { client, calls } = fakeDatabase('in_progress', {});
    await requireVisitOpenForWork(client as never, patientId, facilityId, encounterId, { lock: false });
    expect(calls[0]?.sql).toMatch(VISIT_READ);
  });
});

describe('EHR-C8a prescriptions on a visit entered in error', () => {
  const prescription = (status: OrderStatus) => ({ id: resourceId, encounterId, patientId, facilityId, status, rowVersion: '1',
    medicationDisplay: 'Paracetamol 500 mg', medicationCode: null, createdBy: accountId, createdAt: new Date() });
  const service = (repository: unknown, pharmacy: unknown = {}) =>
    new PrescriptionsService(repository as never, pharmacy as never, noRoutes as never);
  const body = { medicationDisplay: 'Paracetamol 500 mg', frequency: 'Three times daily', instructions: 'After food',
    status: OrderStatus.Draft };

  it('refuses a new prescription, writing nothing', async () => {
    const db = fakeDatabase('entered_in_error', prescription(OrderStatus.Draft));
    await expect(service(db.repository).create(context, patientId, encounterId, body as never, 'key-12345678'))
      .rejects.toMatchObject(IN_ERROR);
    expect(db.writes()).toEqual([]);
  });

  it('creates on an open visit, the visit locked before the insert', async () => {
    const db = fakeDatabase('in_progress', prescription(OrderStatus.Draft));
    await service(db.repository).create(context, patientId, encounterId, body as never, 'key-12345678');
    expect(db.order()).toEqual(['visit share', 'write']);
  });

  it.each([
    ['activating a draft (first activation, no reason)', OrderStatus.Draft, { status: OrderStatus.Active }],
    ['resuming a held one', OrderStatus.OnHold, { status: OrderStatus.Active, changeReason: 'Resume' }],
    ['completing an active one', OrderStatus.Active, { status: OrderStatus.Completed, changeReason: 'Course done' }],
    ['changing the instructions', OrderStatus.Active, { instructions: 'Before food', changeReason: 'Correction' }],
  ])('refuses %s, writing nothing', async (_label, status, input) => {
    const db = fakeDatabase('entered_in_error', prescription(status));
    await expect(service(db.repository).update(context, patientId, encounterId, resourceId,
      { expectedRowVersion: 1, ...input } as never)).rejects.toMatchObject(IN_ERROR);
    expect(db.writes()).toEqual([]);
    expect(db.reasons).toEqual([]);
  });

  it.each([OrderStatus.OnHold, OrderStatus.Cancelled, OrderStatus.EnteredInError])(
    'still lets it be stopped (%s), without waiting on the visit', async (status) => {
      const db = fakeDatabase('entered_in_error', prescription(OrderStatus.Active));
      await service(db.repository).update(context, patientId, encounterId, resourceId,
        { expectedRowVersion: 1, status, changeReason: 'Visit entered in error' });
      expect(db.order()).toEqual(['row lock', 'write']);
    });

  it('activates on an open visit with the visit locked before the prescription (one lock order everywhere)', async () => {
    const db = fakeDatabase('completed', prescription(OrderStatus.Draft));
    await service(db.repository).update(context, patientId, encounterId, resourceId,
      { expectedRowVersion: 1, status: OrderStatus.Active });
    expect(db.order()).toEqual(['visit share', 'row lock', 'write']);
  });

  it('refuses to send it to the pharmacy, before the pharmacy is called', async () => {
    const db = fakeDatabase('entered_in_error', prescription(OrderStatus.Active));
    const pharmacy = { acceptEhrPrescription: jest.fn() };
    await expect(service(db.repository, pharmacy).acceptForPharmacy(context, patientId, encounterId, resourceId,
      { expectedRowVersion: 1, reason: 'Dispense today' } as never, 'key-12345678')).rejects.toMatchObject(IN_ERROR);
    expect(pharmacy.acceptEhrPrescription).not.toHaveBeenCalled();
    expect(db.order()).toEqual(['visit share']);
  });
});

describe('EHR-C8a lab requests on a visit entered in error', () => {
  const request = (status: OrderStatus) => ({ id: resourceId, encounterId, patientId, facilityId, status, rowVersion: '1',
    testCodeSystem: 'LOCAL', testCode: 'FBC', testDisplay: 'Full blood count', priority: 'routine',
    createdAtExact: '2026-11-18T09:00:00.000000Z', createdBy: accountId });
  const lab = () => ({ acceptEhrOrder: jest.fn() });
  const service = (repository: unknown, labApi: unknown) =>
    new LabRequestsService(repository as never, labApi as never, noRoutes as never);

  it('refuses a new lab request, writing nothing and calling no laboratory', async () => {
    const db = fakeDatabase('entered_in_error', request(OrderStatus.Active));
    const labApi = lab();
    await expect(service(db.repository, labApi).create(context, patientId, encounterId, { testCodeSystem: 'LOCAL',
      testCode: 'FBC', testDisplay: 'Full blood count', priority: 'routine', status: OrderStatus.Active } as never,
    'key-12345678')).rejects.toMatchObject(IN_ERROR);
    expect(db.writes()).toEqual([]);
    expect(labApi.acceptEhrOrder).not.toHaveBeenCalled();
  });

  it.each([
    ['activating a draft', OrderStatus.Draft, { status: OrderStatus.Active }],
    ['resuming a held one', OrderStatus.OnHold, { status: OrderStatus.Active }],
    ['changing the priority', OrderStatus.Active, { priority: 'stat' }],
  ])('refuses %s, writing nothing and calling no laboratory', async (_label, status, input) => {
    const db = fakeDatabase('entered_in_error', request(status));
    const labApi = lab();
    await expect(service(db.repository, labApi).update(context, patientId, encounterId, resourceId,
      { expectedRowVersion: 1, changeReason: 'Needed now', ...input } as never)).rejects.toMatchObject(IN_ERROR);
    expect(db.writes()).toEqual([]);
    expect(labApi.acceptEhrOrder).not.toHaveBeenCalled();
  });

  it('still lets it be cancelled', async () => {
    const db = fakeDatabase('entered_in_error', request(OrderStatus.Active));
    await service(db.repository, lab()).update(context, patientId, encounterId, resourceId,
      { expectedRowVersion: 1, status: OrderStatus.Cancelled, changeReason: 'Visit entered in error' } as never);
    expect(db.order()).toEqual(['row lock', 'write']);
  });

  it('refuses to send it to the laboratory again', async () => {
    const db = fakeDatabase('entered_in_error', request(OrderStatus.Active));
    const labApi = lab();
    await expect(service(db.repository, labApi).sendToLab(context, patientId, encounterId, resourceId,
      { expectedRowVersion: 1 })).rejects.toMatchObject(IN_ERROR);
    expect(labApi.acceptEhrOrder).not.toHaveBeenCalled();
  });
});

describe('EHR-C8a notes on a visit entered in error', () => {
  const note = (status: string) => ({ id: resourceId, encounterId, patientId, facilityId, status, rowVersion: '1',
    currentRevisionNo: 1, title: 'Visit note' });

  it('refuses a new note, writing nothing', async () => {
    const db = fakeDatabase('entered_in_error', note('draft'));
    await expect(new ClinicalNotesService(db.repository as never).create(context, patientId, encounterId,
      { noteType: 'progress', title: 'Visit note', content: 'Fictional text', status: NoteStatus.Draft } as never,
      'key-12345678')).rejects.toMatchObject(IN_ERROR);
    expect(db.writes()).toEqual([]);
  });

  it('refuses to sign a draft (so it can never reach the patient), writing nothing', async () => {
    const db = fakeDatabase('entered_in_error', note('draft'));
    await expect(new ClinicalNotesService(db.repository as never).update(context, patientId, encounterId, resourceId,
      { expectedRowVersion: 1, status: NoteStatus.Signed })).rejects.toMatchObject(IN_ERROR);
    expect(db.writes()).toEqual([]);
  });

  it('still lets a note be entered in error', async () => {
    const db = fakeDatabase('entered_in_error', note('signed'));
    await new ClinicalNotesService(db.repository as never).update(context, patientId, encounterId, resourceId,
      { expectedRowVersion: 1, status: NoteStatus.EnteredInError, changeReason: 'Visit entered in error' });
    expect(db.order()).toEqual(['row lock', 'write']);
  });

  it('signs on an open visit with the visit locked before the note', async () => {
    const db = fakeDatabase('in_progress', note('draft'));
    await new ClinicalNotesService(db.repository as never).update(context, patientId, encounterId, resourceId,
      { expectedRowVersion: 1, status: NoteStatus.Signed });
    expect(db.order()).toEqual(['visit share', 'row lock', 'write']);
  });
});
