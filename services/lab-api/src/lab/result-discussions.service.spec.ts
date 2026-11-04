import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import { RecordResultDiscussionDto, WithdrawResultDiscussionDto } from './dto/result-discussion.dto';
import { RESULT_DISCUSSION_LIST_LIMIT, ResultDiscussionsService, resultDiscussionProblem } from './result-discussions.service';

// Synthetic identifiers only.
const PATIENT = '5a000000-0000-4000-8000-000000000001';
const RESULT = '5b000000-0000-4000-8000-000000000001';
const KEY = 'synthetic-discussion-key-0001';
const REASON = 'Synthetic withdrawal reason text';

function staffRequest(headers: Record<string, string | undefined> = {}, actor: Record<string, unknown> = {}) {
  const all: Record<string, string | undefined> = { 'x-purpose-of-use': 'direct-care', cookie: 'synthetic-session', ...headers };
  return { correlationId: 'synthetic-discussion-correlation', facilityId: 'facility-a', method: 'POST',
    actor: { kind: 'staff', id: 'staff-a', subject: 'staff:synthetic-a', accountId: 'account-a', sessionId: 'session-a',
      roles: ['doctor'], permissions: ['lab.result.discuss', 'lab.result.released.read'], facilityIds: ['facility-a'], facilities: [],
      facility: { id: 'facility-a', membershipId: 'membership-a', organizationId: 'org-a' }, authenticationMethod: 'local', ...actor },
    header: (name: string) => all[name.toLowerCase()] } as never;
}

function setup(rows: unknown[] = [], error?: unknown) {
  const query = jest.fn(async (sql: string) => {
    if (error) throw error;
    return { rows: sql.includes('insert into audit') ? [] : rows };
  });
  const client = { query };
  const withTransaction = jest.fn(async (_context: unknown, work: (c: unknown) => Promise<unknown>) => work(client));
  const audit = { recordWithClient: jest.fn(async () => undefined), record: jest.fn(async () => undefined) };
  const service = new ResultDiscussionsService({ withTransaction } as never, audit as never);
  return { service, query, withTransaction, audit };
}

const recorded = { event_id: 'e1', event_no: 1, state: 'discussed', occurred_at: new Date('2026-11-04T09:00:00Z'),
  finished_visit: true, replayed: false };
const withdrawn = { event_id: 'e2', event_no: '2', state: 'withdrawn', occurred_at: '2026-11-04T10:00:00Z',
  finished_visit: true, replayed: false };

describe('Marking a result as discussed with the patient', () => {
  it('calls the 0107 command with the patient, result, version, key and a stable digest, and audits ids only', async () => {
    const s = setup([recorded]);
    const answer = await s.service.record(staffRequest(), PATIENT, RESULT, { resultVersion: 2 }, KEY);
    expect(answer).toEqual({ resultId: RESULT, resultVersion: 2, state: 'discussed', eventNo: 1,
      discussedAt: '2026-11-04T09:00:00.000Z', visibleToPatient: true, replayed: false });
    const [sql, values] = s.query.mock.calls[0]! as unknown as [string, unknown[]];
    expect(sql).toBe('select * from lab.record_result_discussion($1,$2,$3,$4,$5)');
    const digest = requestDigest('lab.result.discussion.record', { patientId: PATIENT, resultId: RESULT, resultVersion: 2 });
    expect(values).toEqual([PATIENT, RESULT, 2, KEY, digest]);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // Key order does not change the digest.
    expect(requestDigest('lab.result.discussion.record', { resultVersion: 2, resultId: RESULT, patientId: PATIENT })).toBe(digest);
    expect(s.withTransaction.mock.calls[0]![0]).toMatchObject({ facilityId: 'facility-a', membershipId: 'membership-a', purposeOfUse: 'direct-care' });
    expect(s.audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'lab.result.discussion.record', outcome: 'success', resourceType: 'lab-result', resourceId: RESULT, patientId: PATIENT,
      actorMembershipId: 'membership-a', facilityId: 'facility-a', purposeOfUse: 'direct-care', sourceSystem: 'lab-api',
      details: { resultVersion: 2, eventNo: 1, replayed: false, finishedVisit: true } }));
    expect(s.audit.record).not.toHaveBeenCalled();
  });

  it('answers a replay and says the result stays hidden while its visit is not finished', async () => {
    const s = setup([{ ...recorded, replayed: true, finished_visit: false }]);
    await expect(s.service.record(staffRequest(), PATIENT, RESULT, { resultVersion: 1 }, KEY)).resolves
      .toMatchObject({ replayed: true, visibleToPatient: false, state: 'discussed' });
  });

  it('refuses a patient actor and a missing or other purpose before the database', async () => {
    const s = setup([recorded]);
    await expect(s.service.record(staffRequest({}, { kind: 'patient' }), PATIENT, RESULT, { resultVersion: 1 }, KEY))
      .rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    await expect(s.service.record(staffRequest({ 'x-purpose-of-use': undefined }), PATIENT, RESULT, { resultVersion: 1 }, KEY))
      .rejects.toMatchObject({ status: 400, code: 'PURPOSE_OF_USE_REQUIRED' });
    await expect(s.service.record(staffRequest({ 'x-purpose-of-use': 'emergency' }), PATIENT, RESULT, { resultVersion: 1 }, KEY))
      .rejects.toMatchObject({ status: 400, code: 'PURPOSE_OF_USE_REQUIRED' });
    expect(s.withTransaction).not.toHaveBeenCalled();
  });

  it('maps a database refusal, audits it after the rollback, and never sends the database text', async () => {
    const error = Object.assign(new Error('RESULT_VERSION_CHANGED'), { code: 'P0001' });
    const s = setup([], error);
    const refusal = await s.service.record(staffRequest(), PATIENT, RESULT, { resultVersion: 1 }, KEY).catch(e => e);
    expect(refusal).toBeInstanceOf(DomainProblem);
    expect(refusal).toMatchObject({ status: 409, code: 'RESULT_VERSION_CHANGED' });
    expect(s.audit.recordWithClient).not.toHaveBeenCalled();
    expect(s.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'lab.result.discussion.record', outcome: 'failure',
      resourceId: RESULT, patientId: PATIENT, details: { resultVersion: 1, code: 'RESULT_VERSION_CHANGED', status: 409 } }));
  });

  it('audits a permission or consent refusal as denied', async () => {
    const s = setup([], Object.assign(new Error('PATIENT_ACCESS_DENIED'), { code: '42501' }));
    await expect(s.service.record(staffRequest(), PATIENT, RESULT, { resultVersion: 1 }, KEY))
      .rejects.toMatchObject({ status: 403, code: 'PATIENT_ACCESS_DENIED' });
    expect(s.audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied' }));
  });

  it('treats an empty or unexpected answer from the command as unavailable', async () => {
    for (const rows of [[], [{ ...recorded, state: 'withdrawn' }]]) {
      const s = setup(rows);
      await expect(s.service.record(staffRequest(), PATIENT, RESULT, { resultVersion: 1 }, KEY))
        .rejects.toMatchObject({ status: 503, code: 'LAB_SERVICE_UNAVAILABLE' });
    }
  });
});

describe('Withdrawing the mark', () => {
  const input = { resultVersion: 3, reasonCode: 'not_yet_discussed' as const, reason: `  ${REASON}  ` };

  it('sends the trimmed reason to the database only; the audit, the answer and the digest inputs it logs carry only the code', async () => {
    const s = setup([withdrawn]);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const answer = await s.service.withdraw(staffRequest(), PATIENT, RESULT, input, KEY);
      expect(answer).toEqual({ resultId: RESULT, resultVersion: 3, state: 'withdrawn', eventNo: 2,
        withdrawnAt: '2026-11-04T10:00:00.000Z', visibleToPatient: false, replayed: false });
      const [sql, values] = s.query.mock.calls[0]! as unknown as [string, unknown[]];
      expect(sql).toBe('select * from lab.withdraw_result_discussion($1,$2,$3,$4,$5,$6,$7)');
      expect(values.slice(0, 6)).toEqual([PATIENT, RESULT, 3, 'not_yet_discussed', REASON, KEY]);
      expect(values[6]).toBe(requestDigest('lab.result.discussion.withdraw',
        { patientId: PATIENT, resultId: RESULT, resultVersion: 3, reasonCode: 'not_yet_discussed', reason: REASON }));
      expect(s.audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: 'lab.result.discussion.withdraw', outcome: 'success',
        details: { resultVersion: 3, eventNo: 2, replayed: false, reasonCode: 'not_yet_discussed' } }));
      const everything = JSON.stringify([s.audit.recordWithClient.mock.calls, s.audit.record.mock.calls, answer,
        log.mock.calls, warn.mock.calls, err.mock.calls]);
      expect(everything).not.toContain('Synthetic withdrawal reason');
    } finally { log.mockRestore(); warn.mockRestore(); err.mockRestore(); }
  });

  it('keeps the reason out of the refusal audit and the problem', async () => {
    const s = setup([], Object.assign(new Error('RESULT_NOT_DISCUSSED'), { code: 'P0001' }));
    const refusal = await s.service.withdraw(staffRequest(), PATIENT, RESULT, input, KEY).catch(e => e);
    expect(refusal).toMatchObject({ status: 409, code: 'RESULT_NOT_DISCUSSED' });
    expect(s.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'lab.result.discussion.withdraw', outcome: 'failure',
      details: { resultVersion: 3, reasonCode: 'not_yet_discussed', code: 'RESULT_NOT_DISCUSSED', status: 409 } }));
    expect(JSON.stringify([s.audit.record.mock.calls, refusal.message, refusal.getResponse()])).not.toContain('Synthetic withdrawal reason');
  });

  it('refuses a reason shorter than 8 or longer than 500 characters after trimming, before the database', async () => {
    for (const reason of ['  short  ', 'x'.repeat(501)]) {
      const s = setup([withdrawn]);
      await expect(s.service.withdraw(staffRequest(), PATIENT, RESULT, { ...input, reason }, KEY))
        .rejects.toMatchObject({ status: 400, code: 'RESULT_DISCUSSION_INVALID' });
      expect(s.withTransaction).not.toHaveBeenCalled();
    }
  });
});

describe('Listing the results a clinician may mark', () => {
  const base = { result_version: '1', test_code_system: 'http://loinc.org', released_at: new Date('2026-11-01T08:00:00Z'),
    finished_visit: true, discussion_state: null, discussion_event_no: null, discussion_at: null, discussion_by_membership_id: null,
    withdrawal_reason_code: null };
  const rows = [
    { ...base, result_id: 'r-hiv', test_code: '75622-1', test_name: 'HIV 1+2 Ab/Ag', abnormal_flag: 'normal',
      discussion_state: 'discussed', discussion_event_no: 1, discussion_at: '2026-11-02T08:00:00Z', discussion_by_membership_id: 'membership-a' },
    { ...base, result_id: 'r-k', test_code: '2823-3', test_name: 'Potassium', abnormal_flag: 'critical_candidate', finished_visit: false,
      discussion_state: 'discussed', discussion_event_no: 3, discussion_at: '2026-11-02T09:00:00Z', discussion_by_membership_id: 'membership-b' },
    { ...base, result_id: 'r-psa', test_code: 'x', test_code_system: 'LOCAL', test_name: 'PSA', abnormal_flag: null,
      discussion_state: 'withdrawn', discussion_event_no: 2, discussion_at: '2026-11-03T09:00:00Z', discussion_by_membership_id: 'membership-a',
      withdrawal_reason_code: 'marked_in_error' },
    { ...base, result_id: 'r-hb', test_code: '718-7', test_name: 'Haemoglobin', abnormal_flag: 'low' },
  ];

  it('keeps only sensitive or critical results, and is visible to the patient only when discussed and from a finished visit', async () => {
    const s = setup(rows);
    const { results, truncated } = await s.service.list(staffRequest(), PATIENT);
    expect(truncated).toBe(false);
    expect(s.query.mock.calls[0]).toEqual(['select * from lab.list_result_discussions($1)', [PATIENT]]);
    expect(results.map(r => r.resultId)).toEqual(['r-hiv', 'r-k', 'r-psa']);
    expect(results[0]).toEqual({ resultId: 'r-hiv', resultVersion: 1, test: { codeSystem: 'http://loinc.org', code: '75622-1', name: 'HIV 1+2 Ab/Ag' },
      releasedAt: '2026-11-01T08:00:00.000Z', gate: { sensitive: true, critical: false }, finishedVisit: true,
      discussion: { state: 'discussed', eventNo: 1, at: '2026-11-02T08:00:00.000Z', byMembershipId: 'membership-a', reasonCode: null },
      visibleToPatient: true });
    expect(results[1]).toMatchObject({ gate: { sensitive: false, critical: true }, finishedVisit: false, visibleToPatient: false });
    expect(results[2]).toMatchObject({ discussion: { state: 'withdrawn', reasonCode: 'marked_in_error' }, visibleToPatient: false });
    expect(s.audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'lab.result.discussion.list', outcome: 'success', patientId: PATIENT, details: { recordCount: 3, truncated: false } }));
  });

  it('gates every released row the database lists, so an older sensitive result behind 600 newer ones stays listed', async () => {
    const newer = Array.from({ length: 600 }, (_, n) => ({ ...base, result_id: `r-hb-${n}`, test_code: '718-7',
      test_name: 'Haemoglobin', abnormal_flag: 'normal' }));
    const s = setup([...newer, { ...base, result_id: 'r-hiv-old', test_code: '75622-1', test_name: 'HIV 1+2 Ab/Ag', abnormal_flag: 'normal' }]);
    const { results, truncated } = await s.service.list(staffRequest(), PATIENT);
    expect(results.map(r => r.resultId)).toEqual(['r-hiv-old']);
    expect(truncated).toBe(false);
  });

  it('keeps at most the newest 500 gated results and says it cut', async () => {
    const gated = Array.from({ length: RESULT_DISCUSSION_LIST_LIMIT + 1 }, (_, n) => ({ ...base, result_id: `r-k-${n}`,
      test_code: '2823-3', test_name: 'Potassium', abnormal_flag: 'critical_candidate' }));
    const s = setup(gated);
    const { results, truncated } = await s.service.list(staffRequest(), PATIENT);
    expect(RESULT_DISCUSSION_LIST_LIMIT).toBe(500);
    expect(results).toHaveLength(500);
    expect(results[499]!.resultId).toBe('r-k-499');
    expect(truncated).toBe(true);
    expect(s.audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'lab.result.discussion.list', details: { recordCount: 500, truncated: true } }));
  });

  it('shows no discussion for a result never marked', async () => {
    const s = setup([{ ...base, result_id: 'r-cd4', test_code: '24467-3', test_name: 'CD4 count', abnormal_flag: null }]);
    const { results } = await s.service.list(staffRequest({}, {}), PATIENT);
    expect(results).toEqual([expect.objectContaining({ discussion: null, visibleToPatient: false })]);
  });

  it('lists the Q28 sensitive tests (HPV DNA, HCV RNA, drug screen, NIPT, bone marrow, flow cytometry, AUDIT, MMSE) so they can be marked', async () => {
    const names = ['HPV DNA', 'Mycoplasma genitalium PCR', 'HBV DNA viral load', 'HCV RNA', 'Urine drug screen', 'Blood alcohol', 'NIPT',
      'Bone marrow aspirate', 'Flow cytometry', 'AUDIT-C', 'CAGE questionnaire', 'MMSE', 'Full blood count', 'GeneXpert MTB/RIF'];
    const s = setup(names.map((test_name, n) => ({ ...base, result_id: `r-q28-${n}`, test_code: 'x', test_code_system: 'LOCAL', test_name, abnormal_flag: 'normal' })));
    const { results } = await s.service.list(staffRequest(), PATIENT);
    expect(results.map(r => r.test.name)).toEqual(names.slice(0, -2));
    expect(results.every(r => r.gate.sensitive && !r.gate.critical)).toBe(true);
  });

  it('lists the Q28 review lab menu spellings (drug test, antenatal profile, BMA, Papanicolaou, R.V.S) so they can be marked', async () => {
    const names = ['Urine drug test', 'Alcohol, blood', 'ETOH', 'Antenatal profile', 'Quadruple test', 'BMA', 'Papanicolaou smear', 'R.V.S',
      'ANC', 'Drug level'];
    const s = setup(names.map((test_name, n) => ({ ...base, result_id: `r-q28r-${n}`, test_code: 'x', test_code_system: 'LOCAL', test_name, abnormal_flag: 'normal' })));
    const { results } = await s.service.list(staffRequest(), PATIENT);
    expect(results.map(r => r.test.name)).toEqual(names.slice(0, -2));
    expect(results.every(r => r.gate.sensitive && !r.gate.critical)).toBe(true);
  });

  it('keeps TB results visible (owner Q31): TB tests are not gated, so the list does not offer them for a mark', async () => {
    const names = ['GeneXpert MTB/RIF', 'AFB smear', 'Mantoux test', 'TST', 'IGRA', 'QuantiFERON-TB Gold Plus', 'Sputum culture for TB',
      'HIV 1/2 rapid test'];
    const s = setup(names.map((test_name, n) => ({ ...base, result_id: `r-q31-${n}`, test_code: 'x', test_code_system: 'LOCAL', test_name, abnormal_flag: 'normal' })));
    const { results } = await s.service.list(staffRequest(), PATIENT);
    expect(results.map(r => r.test.name)).toEqual(['HIV 1/2 rapid test']);
  });

  it('maps a missing consent to 403 PATIENT_ACCESS_DENIED', async () => {
    const s = setup([], Object.assign(new Error('PATIENT_ACCESS_DENIED'), { code: '42501' }));
    await expect(s.service.list(staffRequest(), PATIENT)).rejects.toMatchObject({ status: 403, code: 'PATIENT_ACCESS_DENIED' });
    expect(s.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'lab.result.discussion.list', outcome: 'denied',
      details: { code: 'PATIENT_ACCESS_DENIED', status: 403 } }));
  });
});

describe('resultDiscussionProblem', () => {
  const db = (code: string, message: string) => Object.assign(new Error(message), { code });
  it.each([
    ['42501', 'PERMISSION_DENIED', 403, 'PERMISSION_DENIED'],
    ['42501', 'PATIENT_ACCESS_DENIED', 403, 'PATIENT_ACCESS_DENIED'],
    ['42501', 'PURPOSE_OF_USE_REQUIRED', 400, 'PURPOSE_OF_USE_REQUIRED'],
    ['42501', 'LAB_CONTEXT_REQUIRED', 503, 'LAB_SERVICE_UNAVAILABLE'],
    ['42501', 'permission denied for table result_discussion_events', 503, 'LAB_SERVICE_UNAVAILABLE'],
    ['22023', 'RESULT_DISCUSSION_INVALID', 400, 'RESULT_DISCUSSION_INVALID'],
    ['P0002', 'RESULT_NOT_FOUND', 404, 'RESULT_NOT_FOUND'],
    ['P0001', 'RESULT_VERSION_CHANGED', 409, 'RESULT_VERSION_CHANGED'],
    ['P0001', 'RESULT_NOT_RELEASED', 409, 'RESULT_NOT_RELEASED'],
    ['P0001', 'RESULT_ENTERED_IN_ERROR', 409, 'RESULT_ENTERED_IN_ERROR'],
    ['P0001', 'RESULT_NOT_DISCUSSED', 409, 'RESULT_NOT_DISCUSSED'],
    ['P0001', 'IDEMPOTENCY_KEY_REUSED', 409, 'IDEMPOTENCY_KEY_REUSED'],
    ['P0001', 'RESULT_DISCUSSION_CHANGED', 409, 'RESULT_DISCUSSION_CHANGED'],
    ['P0001', 'SOMETHING_ELSE', 503, 'LAB_SERVICE_UNAVAILABLE'],
    ['23505', 'duplicate key value violates unique constraint', 503, 'LAB_SERVICE_UNAVAILABLE'],
    ['40001', 'could not serialize access', 503, 'LAB_SERVICE_UNAVAILABLE'],
  ])('maps %s %s to %i %s, never with the database text', (sqlState, message, status, code) => {
    const problem = resultDiscussionProblem(db(sqlState, message));
    expect(problem).toMatchObject({ status, code });
    if (message.includes(' ')) expect(problem.message).not.toContain(message);
  });
  it('maps an error without a SQLSTATE to unavailable and keeps a domain problem', () => {
    expect(resultDiscussionProblem(new Error('socket hang up'))).toMatchObject({ status: 503, code: 'LAB_SERVICE_UNAVAILABLE' });
    const own = new DomainProblem(400, 'X', 'x');
    expect(resultDiscussionProblem(own)).toBe(own);
  });
});

describe('Request bodies (whitelist, forbidNonWhitelisted)', () => {
  const check = async (cls: new () => object, body: unknown) => (await validate(plainToInstance(cls, body) as object,
    { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true })).map(e => e.property);

  it('accepts only an integer resultVersion of at least 1 for a mark', async () => {
    expect(await check(RecordResultDiscussionDto, { resultVersion: 1 })).toEqual([]);
    expect(await check(RecordResultDiscussionDto, { resultVersion: 0 })).toEqual(['resultVersion']);
    expect(await check(RecordResultDiscussionDto, { resultVersion: 1.5 })).toEqual(['resultVersion']);
    expect(await check(RecordResultDiscussionDto, { resultVersion: '1' })).toEqual(['resultVersion']);
    expect(await check(RecordResultDiscussionDto, { resultVersion: 1, note: 'extra' })).toEqual(['note']);
  });

  it('requires a known reason code and a reason of 8 to 500 characters after trimming for a withdrawal', async () => {
    const ok = { resultVersion: 2, reasonCode: 'wrong_patient', reason: REASON };
    expect(await check(WithdrawResultDiscussionDto, ok)).toEqual([]);
    for (const code of ['marked_in_error', 'not_yet_discussed', 'wrong_patient', 'other'])
      expect(await check(WithdrawResultDiscussionDto, { ...ok, reasonCode: code })).toEqual([]);
    expect(await check(WithdrawResultDiscussionDto, { ...ok, reasonCode: 'changed_mind' })).toEqual(['reasonCode']);
    expect(await check(WithdrawResultDiscussionDto, { ...ok, reason: '   1234567   ' })).toEqual(['reason']);
    expect(await check(WithdrawResultDiscussionDto, { ...ok, reason: 'y'.repeat(501) })).toEqual(['reason']);
    expect(await check(WithdrawResultDiscussionDto, { ...ok, reason: 12345678 })).toEqual(['reason']);
    expect(await check(WithdrawResultDiscussionDto, { ...ok, extra: true })).toEqual(['extra']);
  });
});
