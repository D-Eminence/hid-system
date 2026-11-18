import { ValidationPipe } from '@nestjs/common';
import type { DataAccessContext } from '../../common/request-context';
import { matchAllergies } from '../allergies/allergy-match';
import { warningToken } from '../allergies/allergy-reader';
import { ClinicalNotesService } from '../clinical-notes/clinical-notes.service';
import { LabRequestsService } from '../lab-requests/lab-requests.service';
import { PrescriptionsService } from '../prescriptions/prescriptions.service';
import {
  CHANGE_REASON_REQUIRED_MESSAGE,
  FIRST_ACTIVATION_REASON,
  FIRST_SIGNATURE_REASON,
  neverReachedBefore,
  resolveChangeReason,
} from './change-reason';
import {
  CreateClinicalNoteRevisionDto,
  CreateVitalCorrectionDto,
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

describe('FR-1 DTOs: the reason may be left out on notes, prescriptions and lab requests only', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true, transform: true });
  const run = (metatype: new () => object, body: Record<string, unknown>) =>
    pipe.transform(body, { type: 'body', metatype });

  it.each([
    [UpdateClinicalNoteDto, { expectedRowVersion: 1, status: 'signed' }],
    [UpdatePrescriptionDto, { expectedRowVersion: 1, status: 'active' }],
    [UpdateLabRequestDto, { expectedRowVersion: 1, status: 'active' }],
  ])('%p accepts a body with no changeReason', async (metatype, body) => {
    const dto = await run(metatype, body) as { changeReason?: string };
    expect(dto.changeReason).toBeUndefined();
  });

  it.each([UpdateClinicalNoteDto, UpdatePrescriptionDto, UpdateLabRequestDto])(
    '%p still refuses a null, too short or too long reason, and trims it', async (metatype) => {
      for (const changeReason of [null, 'ab', '   ', 'x'.repeat(501), 7]) {
        await expect(run(metatype, { expectedRowVersion: 1, status: 'entered_in_error', changeReason }))
          .rejects.toMatchObject({ status: 400 });
      }
      await expect(run(metatype, { expectedRowVersion: 1, status: 'entered_in_error', changeReason: '  Wrong patient  ' }))
        .resolves.toMatchObject({ changeReason: 'Wrong patient' });
    });

  it.each([
    [UpdateEncounterDto, { expectedRowVersion: 1, status: 'completed' }],
    [UpdateDiagnosisDto, { expectedRowVersion: 1, clinicalStatus: 'resolved' }],
    [CreateClinicalNoteRevisionDto, { expectedRowVersion: 1, content: 'Amended text' }],
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
  });

  it('answers 400 CHANGE_REASON_REQUIRED in plain words otherwise', () => {
    expect(() => resolveChangeReason(undefined, undefined)).toThrow(expect.objectContaining(REQUIRED));
    expect(CHANGE_REASON_REQUIRED_MESSAGE).toBe('Please say why you are changing this.');
    expect(`${CHANGE_REASON_REQUIRED_MESSAGE} ${FIRST_SIGNATURE_REASON} ${FIRST_ACTIVATION_REASON}`)
      .not.toMatch(/unverified/i);
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
    ['a title change with the signature', 'draft', { ...sign, title: 'New title' }],
    ['entering a draft in error', 'draft', { expectedRowVersion: 1, status: NoteStatus.EnteredInError }],
    ['entering a signed note in error', 'signed', { expectedRowVersion: 1, status: NoteStatus.EnteredInError }],
    ['a title edit of a draft (owner question 6)', 'draft', { expectedRowVersion: 1, title: 'New title' }],
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
    ['an edit of a draft (owner question 6)', OrderStatus.Draft, { expectedRowVersion: 1, frequency: 'Twice daily' }],
    ['an activation that also changes the frequency', OrderStatus.Draft, { ...activate, frequency: 'Twice daily' }],
  ])('refuses %s without a reason', async (_label, status, input) => {
    const { service, reasons, calls } = setup(status);
    await expect(service.update(context, patientId, encounterId, resourceId, input)).rejects.toMatchObject(REQUIRED);
    expect(reasons).toEqual([]);
    expect(updated(calls)).toBe(false);
  });

  it('needs a reason for a draft whose history shows it was active before (a second activation)', async () => {
    const { service } = setup(OrderStatus.Draft, { createdSeen: 1, reached: 2 });
    await expect(service.update(context, patientId, encounterId, resourceId, activate)).rejects.toMatchObject(REQUIRED);
  });

  it('needs a reason when the history cannot be seen', async () => {
    const { service } = setup(OrderStatus.Draft, null);
    await expect(service.update(context, patientId, encounterId, resourceId, activate)).rejects.toMatchObject(REQUIRED);
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

describe('FR-1 lab requests: every change still needs a typed reason (owner question 6)', () => {
  it.each([
    ['a first activation', { expectedRowVersion: 1, status: OrderStatus.Active }],
    ['a priority change', { expectedRowVersion: 1, priority: 'stat' }],
    ['a cancel', { expectedRowVersion: 1, status: OrderStatus.Cancelled }],
  ])('refuses %s without a reason before touching the database', async (_label, input) => {
    const repository = { run: jest.fn(), setChangeReason: jest.fn() };
    const service = new LabRequestsService(repository as never, {} as never, {} as never);
    await expect(service.update(context, patientId, encounterId, resourceId, input as never)).rejects.toMatchObject(REQUIRED);
    expect(repository.run).not.toHaveBeenCalled();
  });
});
