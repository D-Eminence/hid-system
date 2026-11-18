import { ValidationPipe } from '@nestjs/common';
import type { DataAccessContext } from '../../common/request-context';
import { matchAllergies } from '../allergies/allergy-match';
import { warningToken } from '../allergies/allergy-reader';
import { ClinicalNotesService } from '../clinical-notes/clinical-notes.service';
import { EncountersService } from '../encounters/encounters.service';
import { LabRequestsService } from '../lab-requests/lab-requests.service';
import { PrescriptionsService } from '../prescriptions/prescriptions.service';
import {
  CHANGE_REASON_REQUIRED_MESSAGE,
  DRAFT_EDIT_REASON,
  FIRST_ACTIVATION_REASON,
  FIRST_SIGNATURE_REASON,
  VISIT_FINISH_REASON,
  VISIT_START_REASON,
  neverReachedBefore,
  resolveChangeReason,
} from './change-reason';
import {
  CreateClinicalNoteRevisionDto,
  CreateVitalCorrectionDto,
  EncounterStatus,
  NoteStatus,
  OrderStatus,
  UpdateClinicalNoteDto,
  UpdateDiagnosisDto,
  UpdateEncounterDto,
  UpdateLabRequestDto,
  UpdatePrescriptionDto,
} from './clinical.dto';

// Fictional identifiers only.
const patientId = '123e4567-e89b-42d3-a456-426614174001';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const resourceId = '123e4567-e89b-42d3-a456-426614174005';
const encounterId = '123e4567-e89b-42d3-a456-426614174006';
const allergyId = '123e4567-e89b-42d3-a456-426614174010';

const context = { correlationId: 'correlation-123456', facilityId, membershipId, purposeOfUse: 'direct-care',
  authorization: 'Bearer user', actor: { id: accountId, subject: 'staff:test', accountId, authenticationMethod: 'local',
    roles: ['doctor'], permissions: [], facilityIds: [facilityId], facilities: [],
    facility: { id: facilityId, membershipId, organizationId: facilityId, name: 'Test', roles: ['doctor'],
      permissions: [], isPrimary: true } } } as unknown as DataAccessContext;

const REQUIRED = { status: 400, code: 'CHANGE_REASON_REQUIRED', message: CHANGE_REASON_REQUIRED_MESSAGE };

/** The version history the fake database answers: whether the create version is visible, and how often a status was reached. */
interface History { createdSeen: number; reached: number }
const CLEAN: History = { createdSeen: 1, reached: 0 };

function fakeClient(answers: [RegExp, unknown[]][]) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const query = jest.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    const answer = [...answers, [/ehr\.context_allows\(/, [{ allowed: true }]] as [RegExp, unknown[]]]
      .find(([pattern]) => pattern.test(sql));
    return { rows: answer ? answer[1] : [], rowCount: answer ? answer[1].length : 0 };
  });
  return { client: { query }, calls };
}

function repositoryWith(client: unknown) {
  const audits: Record<string, unknown>[] = [];
  const reasons: string[] = [];
  const repository = {
    run: jest.fn(async (_c, _p, _a, event, operation) => {
      const result = await operation(client);
      audits.push({ action: event.action, details: { ...event.details, ...result.details } });
      return result.value;
    }),
    setChangeReason: jest.fn(async (_client: unknown, reason: string) => { reasons.push(reason); }),
  };
  return { repository, audits, reasons };
}

describe('FR-1 and Q105 DTOs: the reason may be left out on notes, note text, prescriptions, lab requests and visits', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true, transform: true });
  const run = (metatype: new () => object, body: Record<string, unknown>) =>
    pipe.transform(body, { type: 'body', metatype });

  it.each([
    [UpdateClinicalNoteDto, { expectedRowVersion: 1, status: 'signed' }],
    [UpdatePrescriptionDto, { expectedRowVersion: 1, status: 'active' }],
    [UpdateLabRequestDto, { expectedRowVersion: 1, status: 'active' }],
    [UpdateEncounterDto, { expectedRowVersion: 1, status: 'completed' }],
    [CreateClinicalNoteRevisionDto, { expectedRowVersion: 1, content: 'Draft text' }],
  ])('%p accepts a body with no changeReason', async (metatype, body) => {
    const dto = await run(metatype, body) as { changeReason?: string };
    expect(dto.changeReason).toBeUndefined();
  });

  it.each([UpdateClinicalNoteDto, UpdatePrescriptionDto, UpdateLabRequestDto, UpdateEncounterDto])(
    '%p still refuses a null, too short or too long reason, and trims it', async (metatype) => {
      for (const changeReason of [null, 'ab', '   ', 'x'.repeat(501), 7]) {
        await expect(run(metatype, { expectedRowVersion: 1, status: 'entered_in_error', changeReason }))
          .rejects.toMatchObject({ status: 400 });
      }
      await expect(run(metatype, { expectedRowVersion: 1, status: 'entered_in_error', changeReason: '  Wrong patient  ' }))
        .resolves.toMatchObject({ changeReason: 'Wrong patient' });
    });

  it('a note revision still refuses a null or too short reason', async () => {
    for (const changeReason of [null, 'ab', 7]) {
      await expect(run(CreateClinicalNoteRevisionDto, { expectedRowVersion: 1, content: 'Text', changeReason }))
        .rejects.toMatchObject({ status: 400 });
    }
  });

  it.each([
    [UpdateDiagnosisDto, { expectedRowVersion: 1, clinicalStatus: 'resolved' }],
    [CreateVitalCorrectionDto, { expectedRowVersion: 1, replacementValues: { pulseBpm: 80 } }],
  ])('%p still requires changeReason (unchanged)', async (metatype, body) => {
    await expect(run(metatype, body)).rejects.toMatchObject({ status: 400 });
  });
});

describe('resolveChangeReason and neverReachedBefore', () => {
  it('prefers the typed reason and adds nothing to the audit', () => {
    expect(resolveChangeReason('Signed after review', 'first_signature')).toEqual({ reason: 'Signed after review', details: {} });
  });

  it('records the fixed reasons word for word', () => {
    expect(resolveChangeReason(undefined, 'first_signature'))
      .toEqual({ reason: 'First signature (no reason needed)', details: { fixedReason: 'first_signature' } });
    expect(resolveChangeReason(undefined, 'first_activation'))
      .toEqual({ reason: 'First activation (no reason needed)', details: { fixedReason: 'first_activation' } });
    expect(resolveChangeReason(undefined, 'draft_edit'))
      .toEqual({ reason: 'Draft edit (no reason needed)', details: { fixedReason: 'draft_edit' } });
    expect(resolveChangeReason(undefined, 'visit_start'))
      .toEqual({ reason: 'Visit started (no reason needed)', details: { fixedReason: 'visit_start' } });
    expect(resolveChangeReason(undefined, 'visit_finish'))
      .toEqual({ reason: 'Visit finished (no reason needed)', details: { fixedReason: 'visit_finish' } });
    // Every fixed reason passes the database's 3 to 500 character CHECK.
    for (const text of [DRAFT_EDIT_REASON, VISIT_START_REASON, VISIT_FINISH_REASON]) {
      expect(text.trim().length).toBeGreaterThanOrEqual(3);
      expect(text.length).toBeLessThanOrEqual(500);
    }
  });

  it('treats a blank typed reason as none', () => {
    expect(() => resolveChangeReason('   ', undefined)).toThrow(expect.objectContaining(REQUIRED));
    expect(resolveChangeReason('   ', 'draft_edit').reason).toBe(DRAFT_EDIT_REASON);
  });

  it('answers 400 CHANGE_REASON_REQUIRED in plain words otherwise', () => {
    expect(() => resolveChangeReason(undefined, undefined)).toThrow(expect.objectContaining(REQUIRED));
    expect(CHANGE_REASON_REQUIRED_MESSAGE).toBe('Please say why you are changing this.');
    expect(`${CHANGE_REASON_REQUIRED_MESSAGE} ${FIRST_SIGNATURE_REASON} ${FIRST_ACTIVATION_REASON} ${DRAFT_EDIT_REASON} `
      + `${VISIT_START_REASON} ${VISIT_FINISH_REASON}`).not.toMatch(/unverified/i);
  });

  it.each([
    [{ createdSeen: 1, reached: 0 }, true],
    [{ createdSeen: 1, reached: 1 }, false],
    [{ createdSeen: 0, reached: 0 }, false],
    [undefined, false],
  ])('history %p gives %p (fails closed when the create version is not visible)', async (history, expected) => {
    const fake = fakeClient([[/from ehr\.record_versions/, history ? [history] : []]]);
    await expect(neverReachedBefore(fake.client as never, 'prescriptions', resourceId, ['active'])).resolves.toBe(expected);
    expect(fake.calls[0]?.values).toEqual(['prescriptions', resourceId, ['active']]);
    expect(fake.calls[0]?.sql).toMatch(/resulting_state->>'signed_at' is not null/);
  });
});

describe('FR-1 clinical notes: first signature needs no typed reason', () => {
  const note = (status: string) => ({ id: resourceId, encounterId, patientId, facilityId, status, rowVersion: '1',
    currentRevisionNo: 1, title: 'Visit note' });

  function setup(status: string, history: History | null = CLEAN) {
    const fake = fakeClient([
      [/for update/, [note(status)]],
      [/from ehr\.record_versions/, history ? [history] : []],
      [/^\s*update ehr\.clinical_notes/, [{ ...note('signed'), rowVersion: '2' }]],
    ]);
    const { repository, audits, reasons } = repositoryWith(fake.client);
    return { service: new ClinicalNotesService(repository as never), audits, reasons, calls: fake.calls };
  }
  const sign = { expectedRowVersion: 1, status: NoteStatus.Signed };

  it('signs a draft with no reason and records the fixed reason', async () => {
    const { service, audits, reasons, calls } = setup('draft');
    await service.update(context, patientId, encounterId, resourceId, sign);
    expect(reasons).toEqual([FIRST_SIGNATURE_REASON]);
    expect(audits[0]).toMatchObject({ action: 'ehr.note.update', details: { rowVersion: '2', fixedReason: 'first_signature' } });
    const history = calls.find((call) => /from ehr\.record_versions/.test(call.sql));
    expect(history?.values).toEqual(['clinical_notes', resourceId, ['signed', 'amended']]);
  });

  it('keeps a typed reason when one is given', async () => {
    const { service, audits, reasons } = setup('draft');
    await service.update(context, patientId, encounterId, resourceId, { ...sign, changeReason: 'Reviewed with consultant' });
    expect(reasons).toEqual(['Reviewed with consultant']);
    expect(audits[0]?.details).toEqual({ rowVersion: '2' });
  });

  it.each([
    ['a title edit of a draft', { expectedRowVersion: 1, title: 'New title' }, DRAFT_EDIT_REASON, 'draft_edit'],
    ['a draft kept as a draft with a new title', { expectedRowVersion: 1, status: NoteStatus.Draft, title: 'New title' },
      DRAFT_EDIT_REASON, 'draft_edit'],
    ['a title change with the first signature', { ...sign, title: 'New title' }, FIRST_SIGNATURE_REASON, 'first_signature'],
  ])('Q105: accepts %s with no reason and records the fixed reason', async (_label, input, text, kind) => {
    const { service, audits, reasons } = setup('draft');
    await service.update(context, patientId, encounterId, resourceId, input);
    expect(reasons).toEqual([text]);
    expect(audits[0]).toMatchObject({ details: { fixedReason: kind } });
  });

  it('Q105: needs a reason to edit a draft whose history shows it was signed before', async () => {
    const { service } = setup('draft', { createdSeen: 1, reached: 1 });
    await expect(service.update(context, patientId, encounterId, resourceId, { expectedRowVersion: 1, title: 'New title' }))
      .rejects.toMatchObject(REQUIRED);
  });

  it.each([
    ['entering a draft in error', 'draft', { expectedRowVersion: 1, status: NoteStatus.EnteredInError }],
    ['entering a signed note in error', 'signed', { expectedRowVersion: 1, status: NoteStatus.EnteredInError }],
    ['entering an amended note in error', 'amended', { expectedRowVersion: 1, status: NoteStatus.EnteredInError }],
  ])('refuses %s without a reason', async (_label, status, input) => {
    const { service, reasons, calls } = setup(status);
    await expect(service.update(context, patientId, encounterId, resourceId, input)).rejects.toMatchObject(REQUIRED);
    expect(reasons).toEqual([]);
    expect(calls.some((call) => /^\s*update ehr\.clinical_notes/.test(call.sql))).toBe(false);
  });

  it('needs a reason when the history shows the note was signed before', async () => {
    const { service } = setup('draft', { createdSeen: 1, reached: 1 });
    await expect(service.update(context, patientId, encounterId, resourceId, sign)).rejects.toMatchObject(REQUIRED);
  });

  it('needs a reason when the history cannot be seen', async () => {
    const { service } = setup('draft', null);
    await expect(service.update(context, patientId, encounterId, resourceId, sign)).rejects.toMatchObject(REQUIRED);
  });

  it('Q105: needs a reason for a title edit of a draft whose history cannot be seen', async () => {
    const { service, reasons } = setup('draft', null);
    await expect(service.update(context, patientId, encounterId, resourceId, { expectedRowVersion: 1, title: 'New title' }))
      .rejects.toMatchObject(REQUIRED);
    expect(reasons).toEqual([]);
  });
});

describe('FR-1 prescriptions: first activation needs no typed reason', () => {
  const noRoutes = { summaries: async () => new Map(), summary: async () => null, crossFacilityOrdersEnabled: async () => false };
  const current = (status: OrderStatus) => ({ id: resourceId, encounterId, patientId, facilityId, status, rowVersion: '1',
    medicationDisplay: 'Amoxicillin 500 mg', medicationCode: null });
  const penicillin = { id: allergyId, substance: 'Penicillin', reaction: null, severity: 'severe' };

  function setup(status: OrderStatus, history: History | null = CLEAN, recorded: unknown[] = []) {
    const fake = fakeClient([
      [/for update/, [current(status)]],
      [/from ehr\.record_versions/, history ? [history] : []],
      [/^\s*update ehr\.prescriptions/, [{ ...current(OrderStatus.Active), rowVersion: '2' }]],
      [/insert into ehr\.prescription_allergy_acknowledgements/, [{}]],
      [/from ehr\.prescription_allergy_acknowledgements/, []],
      [/from ehr\.recorded_allergies/, recorded],
    ]);
    const { repository, audits, reasons } = repositoryWith(fake.client);
    return { service: new PrescriptionsService(repository as never, {} as never, noRoutes as never), audits, reasons,
      calls: fake.calls };
  }
  const activate = { expectedRowVersion: 1, status: OrderStatus.Active };
  const updated = (calls: { sql: string }[]) => calls.some((call) => /^\s*update ehr\.prescriptions/.test(call.sql));

  it('activates a draft with no reason and records the fixed reason', async () => {
    const { service, audits, reasons, calls } = setup(OrderStatus.Draft);
    await service.update(context, patientId, encounterId, resourceId, activate);
    expect(reasons).toEqual([FIRST_ACTIVATION_REASON]);
    expect(audits[0]).toMatchObject({ details: { rowVersion: '2', fixedReason: 'first_activation' } });
    const history = calls.find((call) => /from ehr\.record_versions/.test(call.sql));
    expect(history?.values).toEqual(['prescriptions', resourceId, ['active', 'on_hold', 'completed']]);
  });

  it.each([
    ['a resume after a hold', OrderStatus.OnHold, activate],
    ['a hold', OrderStatus.Active, { expectedRowVersion: 1, status: OrderStatus.OnHold }],
    ['a stop (cancel)', OrderStatus.Active, { expectedRowVersion: 1, status: OrderStatus.Cancelled }],
    ['entering an active one in error', OrderStatus.Active, { expectedRowVersion: 1, status: OrderStatus.EnteredInError }],
    ['entering a draft in error', OrderStatus.Draft, { expectedRowVersion: 1, status: OrderStatus.EnteredInError }],
    ['an amendment of an active one', OrderStatus.Active, { expectedRowVersion: 1, instructions: 'Take after food' }],
    ['a cancel of a draft', OrderStatus.Draft, { expectedRowVersion: 1, status: OrderStatus.Cancelled }],
    ['a completion', OrderStatus.Active, { expectedRowVersion: 1, status: OrderStatus.Completed }],
  ])('refuses %s without a reason', async (_label, status, input) => {
    const { service, reasons, calls } = setup(status);
    await expect(service.update(context, patientId, encounterId, resourceId, input)).rejects.toMatchObject(REQUIRED);
    expect(reasons).toEqual([]);
    expect(updated(calls)).toBe(false);
  });

  it.each([
    ['an edit of a draft', { expectedRowVersion: 1, frequency: 'Twice daily' }, DRAFT_EDIT_REASON, 'draft_edit'],
    ['a draft kept as a draft with new instructions',
      { expectedRowVersion: 1, status: OrderStatus.Draft, instructions: 'Take after food' }, DRAFT_EDIT_REASON, 'draft_edit'],
    ['an activation that also changes the frequency', { ...activate, frequency: 'Twice daily' },
      FIRST_ACTIVATION_REASON, 'first_activation'],
  ])('Q105: accepts %s with no reason and records the fixed reason', async (_label, input, text, kind) => {
    const { service, audits, reasons } = setup(OrderStatus.Draft);
    await service.update(context, patientId, encounterId, resourceId, input);
    expect(reasons).toEqual([text]);
    expect(audits[0]).toMatchObject({ details: { fixedReason: kind } });
  });

  it('Q105: needs a reason to edit a draft whose history shows it was active before', async () => {
    const { service } = setup(OrderStatus.Draft, { createdSeen: 1, reached: 1 });
    await expect(service.update(context, patientId, encounterId, resourceId, { expectedRowVersion: 1, frequency: 'Daily' }))
      .rejects.toMatchObject(REQUIRED);
  });

  it('needs a reason for a draft whose history shows it was active before (a second activation)', async () => {
    const { service } = setup(OrderStatus.Draft, { createdSeen: 1, reached: 2 });
    await expect(service.update(context, patientId, encounterId, resourceId, activate)).rejects.toMatchObject(REQUIRED);
  });

  it('needs a reason when the history cannot be seen', async () => {
    const { service } = setup(OrderStatus.Draft, null);
    await expect(service.update(context, patientId, encounterId, resourceId, activate)).rejects.toMatchObject(REQUIRED);
  });

  it('Q105: needs a reason for an edit of a draft whose history cannot be seen', async () => {
    const { service, calls } = setup(OrderStatus.Draft, null);
    await expect(service.update(context, patientId, encounterId, resourceId, { expectedRowVersion: 1, endsOn: '2026-11-25' }))
      .rejects.toMatchObject(REQUIRED);
    expect(updated(calls)).toBe(false);
  });

  it('still answers 409 for an allergy match on a first activation without a reason', async () => {
    const { service, calls } = setup(OrderStatus.Draft, CLEAN, [penicillin]);
    await expect(service.update(context, patientId, encounterId, resourceId, activate))
      .rejects.toMatchObject({ status: 409, code: 'ALLERGY_ACKNOWLEDGEMENT_REQUIRED' });
    expect(updated(calls)).toBe(false);
  });

  it('activates after the allergy acknowledgement with the fixed reason, the acknowledgement unchanged', async () => {
    const { service, audits, reasons } = setup(OrderStatus.Draft, CLEAN, [penicillin]);
    const token = warningToken(matchAllergies({ display: 'Amoxicillin 500 mg' },
      [{ source: 'recorded' as const, id: allergyId, substance: 'Penicillin' }]), { display: 'Amoxicillin 500 mg' });
    await service.update(context, patientId, encounterId, resourceId, { ...activate,
      allergyAcknowledgement: { reason: 'Reviewed with the patient; observe 30 minutes', warningToken: token } });
    expect(reasons).toEqual([FIRST_ACTIVATION_REASON]);
    expect(audits[0]).toMatchObject({ details: { fixedReason: 'first_activation', allergyOverride: true } });
  });
});


describe('Q105 note text: new text on a draft that was never signed needs no typed reason', () => {
  const note = (status: string) => ({ id: resourceId, encounterId, patientId, facilityId, status, rowVersion: '1',
    currentRevisionNo: 1, title: 'Visit note' });
  const revision = { id: '123e4567-e89b-42d3-a456-426614174020', clinicalNoteId: resourceId, revisionNo: 2 };

  function setup(status: string, history: History | null = CLEAN) {
    const fake = fakeClient([
      [/for update/, [note(status)]],
      [/from ehr\.record_versions/, history ? [history] : []],
      [/insert into ehr\.clinical_note_revisions/, [revision]],
    ]);
    const update = jest.fn(async () => ({ rows: [], rowCount: 1 }));
    const query = fake.client.query;
    const client = { query: jest.fn(async (sql: string, values: unknown[] = []) =>
      /^\s*update ehr\.clinical_notes/.test(sql) ? update() : query(sql, values)) };
    const { repository, audits, reasons } = repositoryWith(client);
    const executeCreate = jest.fn(async (_c, _ctx, _p, _k, _o, _d, _t,
      create: () => Promise<{ value: unknown; id: string; details?: Record<string, unknown> }>) => {
      const created = await create();
      return { value: created.value, resourceId: created.id, details: { ...created.details, idempotentReplay: false } };
    });
    return { service: new ClinicalNotesService({ ...repository, executeCreate } as never), audits, reasons,
      calls: fake.calls };
  }
  const text = { expectedRowVersion: 1, content: 'Patient seen; plan agreed.' };

  it('records the fixed reason on the revision row and on the version', async () => {
    const { service, audits, reasons, calls } = setup('draft');
    await service.addRevision(context, patientId, encounterId, resourceId, text, 'idempotency-key-0001');
    expect(reasons).toEqual([DRAFT_EDIT_REASON]);
    const insert = calls.find((call) => /insert into ehr\.clinical_note_revisions/.test(call.sql));
    expect(insert?.values[5]).toBe(DRAFT_EDIT_REASON);
    expect(audits[0]).toMatchObject({ action: 'ehr.note-revision.create',
      details: { fixedReason: 'draft_edit', idempotentReplay: false } });
  });

  it('keeps a typed reason on a draft', async () => {
    const { service, reasons, audits } = setup('draft');
    await service.addRevision(context, patientId, encounterId, resourceId,
      { ...text, changeReason: 'Added the plan' }, 'idempotency-key-0002');
    expect(reasons).toEqual(['Added the plan']);
    expect(audits[0]?.details).toEqual({ idempotentReplay: false });
  });

  it.each([
    ['an amendment of a signed note', 'signed', CLEAN],
    ['an amendment of an amended note', 'amended', CLEAN],
    ['a draft whose history shows it was signed', 'draft', { createdSeen: 1, reached: 1 }],
    ['a draft whose history cannot be seen', 'draft', null],
  ] as const)('refuses %s without a reason, writing nothing', async (_label, status, history) => {
    const { service, reasons, calls } = setup(status, history);
    await expect(service.addRevision(context, patientId, encounterId, resourceId, text, 'idempotency-key-0003'))
      .rejects.toMatchObject(REQUIRED);
    expect(reasons).toEqual([]);
    expect(calls.some((call) => /insert into ehr\.clinical_note_revisions/.test(call.sql))).toBe(false);
  });
});

describe('Q105 lab requests: first activation and draft edits need no typed reason', () => {
  const current = (status: OrderStatus) => ({ id: resourceId, encounterId, patientId, facilityId, status, rowVersion: '1',
    testCodeSystem: 'HID-LAB', testCode: 'WIDAL', testDisplay: 'Widal test', priority: 'routine' });
  const noRoutes = { summaries: async () => new Map(), summary: async () => null, crossFacilityOrdersEnabled: async () => false };

  function setup(status: OrderStatus, history: History | null = CLEAN, result: OrderStatus = OrderStatus.Active) {
    const fake = fakeClient([
      [/for no key update/, [current(status)]],
      [/from ehr\.record_versions/, history ? [history] : []],
      [/^\s*update ehr\.lab_requests/, [{ ...current(result), rowVersion: '2', createdAtExact: '2026-11-18T08:00:00.000001Z' }]],
    ]);
    const { repository, audits, reasons } = repositoryWith(fake.client);
    const labApi = { acceptEhrOrder: jest.fn() };
    return { service: new LabRequestsService(repository as never, labApi as never, noRoutes as never),
      audits, reasons, calls: fake.calls, repository, labApi };
  }
  const activate = { expectedRowVersion: 1, status: OrderStatus.Active };
  const updated = (calls: { sql: string }[]) => calls.some((call) => /^\s*update ehr\.lab_requests/.test(call.sql));

  it('activates a draft with no reason, records the fixed reason and still goes on to Lab', async () => {
    const { service, audits, reasons, calls } = setup(OrderStatus.Draft);
    const answer = await service.update(context, patientId, encounterId, resourceId, activate);
    expect(reasons).toEqual([FIRST_ACTIVATION_REASON]);
    expect(audits[0]).toMatchObject({ action: 'ehr.lab-request.update',
      details: { rowVersion: '2', fixedReason: 'first_activation' } });
    const history = calls.find((call) => /from ehr\.record_versions/.test(call.sql));
    expect(history?.values).toEqual(['lab_requests', resourceId, ['active', 'on_hold', 'completed']]);
    // The member holds no lab.work-item.accept here, so the hand-off is reported as before.
    expect(answer.labHandoff).toEqual({ state: 'not_sent', code: 'LAB_PERMISSION_ABSENT' });
  });

  it.each([
    ['a priority change on a draft', { expectedRowVersion: 1, priority: 'stat' }, DRAFT_EDIT_REASON, 'draft_edit'],
    ['clinical information on a draft kept as a draft',
      { expectedRowVersion: 1, status: OrderStatus.Draft, clinicalInformation: 'Fever for 5 days' }, DRAFT_EDIT_REASON, 'draft_edit'],
    ['an activation with a priority change', { ...activate, priority: 'urgent' }, FIRST_ACTIVATION_REASON, 'first_activation'],
  ])('accepts %s with no reason', async (_label, input, text, kind) => {
    const { service, audits, reasons } = setup(OrderStatus.Draft, CLEAN,
      (input as { status?: OrderStatus }).status === OrderStatus.Active ? OrderStatus.Active : OrderStatus.Draft);
    await service.update(context, patientId, encounterId, resourceId, input as never);
    expect(reasons).toEqual([text]);
    expect(audits[0]).toMatchObject({ details: { fixedReason: kind } });
  });

  it('keeps a typed reason and adds nothing to the audit', async () => {
    const { service, audits, reasons } = setup(OrderStatus.Draft);
    await service.update(context, patientId, encounterId, resourceId, { ...activate, changeReason: 'Patient agreed' });
    expect(reasons).toEqual(['Patient agreed']);
    expect(audits[0]?.details).toEqual({ rowVersion: '2' });
  });

  it.each([
    ['a hold', OrderStatus.Active, { expectedRowVersion: 1, status: OrderStatus.OnHold }],
    ['a cancel', OrderStatus.Active, { expectedRowVersion: 1, status: OrderStatus.Cancelled }],
    ['entering in error', OrderStatus.Active, { expectedRowVersion: 1, status: OrderStatus.EnteredInError }],
    ['a completion', OrderStatus.Active, { expectedRowVersion: 1, status: OrderStatus.Completed }],
    ['a cancel of a draft', OrderStatus.Draft, { expectedRowVersion: 1, status: OrderStatus.Cancelled }],
    ['entering a draft in error', OrderStatus.Draft, { expectedRowVersion: 1, status: OrderStatus.EnteredInError }],
    ['a cancel of a draft with an edit', OrderStatus.Draft,
      { expectedRowVersion: 1, status: OrderStatus.Cancelled, priority: 'stat' }],
    ['a blank typed reason on a hold', OrderStatus.Active,
      { expectedRowVersion: 1, status: OrderStatus.OnHold, changeReason: '   ' }],
  ])('refuses %s without a reason before touching the database', async (_label, status, input) => {
    const { service, repository } = setup(status);
    await expect(service.update(context, patientId, encounterId, resourceId, input as never)).rejects.toMatchObject(REQUIRED);
    expect(repository.run).not.toHaveBeenCalled();
  });

  it.each([
    ['a resume after a hold', OrderStatus.OnHold, activate, CLEAN],
    ['a priority change on an active request', OrderStatus.Active, { expectedRowVersion: 1, priority: 'stat' }, CLEAN],
    ['a second activation (the history shows it was active)', OrderStatus.Draft, activate, { createdSeen: 1, reached: 1 }],
    ['a draft whose history cannot be seen', OrderStatus.Draft, activate, null],
    ['an edit of a draft that was active before', OrderStatus.Draft, { expectedRowVersion: 1, priority: 'stat' },
      { createdSeen: 1, reached: 1 }],
    ['an edit of a draft whose history cannot be seen', OrderStatus.Draft,
      { expectedRowVersion: 1, clinicalInformation: 'Fever for 5 days' }, null],
  ] as const)('refuses %s without a reason, writing nothing', async (_label, status, input, history) => {
    const { service, reasons, calls } = setup(status, history);
    await expect(service.update(context, patientId, encounterId, resourceId, input as never)).rejects.toMatchObject(REQUIRED);
    expect(reasons).toEqual([]);
    expect(updated(calls)).toBe(false);
  });
});

describe('Q105 visits: starting and finishing need no typed reason', () => {
  const visit = (status: EncounterStatus) => ({ id: encounterId, patientId, facilityId, status, rowVersion: '1',
    encounterType: 'ambulatory', startedAt: new Date('2026-11-18T08:00:00Z'), endedAt: null, chiefComplaint: null,
    importedPaperRecords: false });

  function setup(status: EncounterStatus, history: History | null = CLEAN) {
    const fake = fakeClient([
      [/for update/, [visit(status)]],
      [/from ehr\.record_versions/, history ? [history] : []],
      [/^\s*update ehr\.encounters/, [{ ...visit(status), rowVersion: '2' }]],
    ]);
    const { repository, audits, reasons } = repositoryWith(fake.client);
    return { service: new EncountersService(repository as never), audits, reasons, calls: fake.calls };
  }
  const updated = (calls: { sql: string }[]) => calls.some((call) => /^\s*update ehr\.encounters/.test(call.sql));

  it.each([
    ['starting a planned visit', EncounterStatus.Planned, { expectedRowVersion: 1, status: EncounterStatus.InProgress },
      VISIT_START_REASON, 'visit_start', ['in_progress', 'on_hold', 'completed']],
    ['finishing a visit with its end time', EncounterStatus.InProgress,
      { expectedRowVersion: 1, status: EncounterStatus.Completed, endedAt: '2026-11-18T09:00:00Z' },
      VISIT_FINISH_REASON, 'visit_finish', ['completed']],
    ['finishing a visit that already has an end time', EncounterStatus.InProgress,
      { expectedRowVersion: 1, status: EncounterStatus.Completed }, VISIT_FINISH_REASON, 'visit_finish', ['completed']],
  ] as const)('accepts %s with no reason and records the fixed reason', async (_label, status, input, text, kind, reached) => {
    const { service, audits, reasons, calls } = setup(status);
    await service.update(context, patientId, encounterId, input as never);
    expect(reasons).toEqual([text]);
    expect(audits[0]).toMatchObject({ action: 'ehr.encounter.update', details: { rowVersion: '2', fixedReason: kind } });
    const history = calls.find((call) => /from ehr\.record_versions/.test(call.sql));
    expect(history?.values).toEqual(['encounters', encounterId, reached]);
  });

  it('keeps a typed reason', async () => {
    const { service, reasons, audits } = setup(EncounterStatus.Planned);
    await service.update(context, patientId, encounterId,
      { expectedRowVersion: 1, status: EncounterStatus.InProgress, changeReason: 'Patient arrived' } as never);
    expect(reasons).toEqual(['Patient arrived']);
    expect(audits[0]?.details).toEqual({ rowVersion: '2' });
  });

  it.each([
    ['a hold', EncounterStatus.InProgress, { status: EncounterStatus.OnHold }, CLEAN],
    ['a resume after a hold', EncounterStatus.OnHold, { status: EncounterStatus.InProgress }, CLEAN],
    ['a cancel', EncounterStatus.Planned, { status: EncounterStatus.Cancelled }, CLEAN],
    ['entering in error', EncounterStatus.InProgress, { status: EncounterStatus.EnteredInError }, CLEAN],
    ['a chief complaint edit', EncounterStatus.InProgress, { chiefComplaint: 'Headache' }, CLEAN],
    ['a start that also changes the chief complaint', EncounterStatus.Planned,
      { status: EncounterStatus.InProgress, chiefComplaint: 'Headache' }, CLEAN],
    ['a finish that also changes the chief complaint', EncounterStatus.InProgress,
      { status: EncounterStatus.Completed, chiefComplaint: 'Headache' }, CLEAN],
    ['a start the history shows happened before', EncounterStatus.Planned, { status: EncounterStatus.InProgress },
      { createdSeen: 1, reached: 1 }],
    ['a finish whose history cannot be seen', EncounterStatus.InProgress, { status: EncounterStatus.Completed }, null],
    ['a start that also sets an end time', EncounterStatus.Planned,
      { status: EncounterStatus.InProgress, endedAt: '2026-11-18T09:00:00Z' }, CLEAN],
    ['a start whose history cannot be seen', EncounterStatus.Planned, { status: EncounterStatus.InProgress }, null],
    ['a finish the history shows happened before', EncounterStatus.InProgress, { status: EncounterStatus.Completed },
      { createdSeen: 1, reached: 1 }],
    ['entering a planned visit in error', EncounterStatus.Planned, { status: EncounterStatus.EnteredInError }, CLEAN],
    ['cancelling a visit in progress', EncounterStatus.InProgress, { status: EncounterStatus.Cancelled }, CLEAN],
    ['an end time alone', EncounterStatus.InProgress, { endedAt: '2026-11-18T09:00:00Z' }, CLEAN],
  ] as const)('refuses %s without a reason, writing nothing', async (_label, status, change, history) => {
    const { service, reasons, calls } = setup(status, history);
    await expect(service.update(context, patientId, encounterId, { expectedRowVersion: 1, ...change } as never))
      .rejects.toMatchObject(REQUIRED);
    expect(reasons).toEqual([]);
    expect(updated(calls)).toBe(false);
  });
});
