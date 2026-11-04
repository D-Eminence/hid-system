import type { PoolClient } from 'pg';
import { PatientChatService } from './patient-chat.service';
import { PatientEvidenceService } from './patient-evidence.service';
import { PATIENT_EVIDENCE_QUERY } from './patient-evidence.query';
import { evidence, type Evidence, type SourceKind } from './patient-evidence.types';
import { RESULT_LINE } from './patient-chat-safety';
import { StaffEvidenceService } from './staff-evidence.service';
import { STAFF_SOURCE_PERMISSIONS, type StaffChatScope } from './staff-chat-scope.service';
jest.mock('../../config/environment', () => ({ getEnvironment: () => ({ AI_ENABLED: true, AI_EMBEDDING_MODEL_ID: 'amazon.titan-embed-text-v2:0' }) }));

/*
 * Every exclusion is checked twice: the excluded data never reaches Claude,
 * Bedrock or the reply, and the chat still answers normally from what remains.
 * The database mock returns every row, as if the patient SQL filter had
 * regressed, so this exercises the policy layer on its own. Fictional data only.
 */
const patientId = '11111111-1111-4111-8111-111111111111';
const auth = { patientId, subject: 'subject-a', accountId: 'account-a', sessionId: 'session-a', expiresAt: new Date(Date.now() + 60000).toISOString() };
const request = { actor: { kind: 'patient', patientId }, correlationId: 'synthetic-policy-chat', header: () => undefined } as never;
const encounterId = '60000000-0000-4000-8000-000000000001';
let n = 0;
const id = () => `22222222-2222-4222-8222-${String(++n).padStart(12, '0')}`;
const row = (kind: string, title: string, fields: Record<string, unknown>, quality = 'recorded') => ({ kind, id: id(), version: '1', title,
  recorded_at: new Date(`2026-09-${String(n % 28 + 1).padStart(2, '0')}T10:00:00Z`), effective_at: null, provenance: 'Synthetic provenance',
  quality, fields: { _encounterId: encounterId, ...fields }, origin_hint: null, patient_id: patientId });
const visit = { _encounterStatus: 'completed' };
const diagnosis = (condition: string, verificationStatus: string, notes: string, code = 'I10') => row('diagnosis', condition,
  { codeSystem: 'ICD-10', code, condition, clinicalStatus: 'active', verificationStatus, onsetAt: null, abatementAt: null, notes }, verificationStatus);
const request_ = (test: string, status: string, more = visit) => row('investigation', test,
  { ...more, test, codeSystem: 'LOCAL', code: test.slice(0, 3).toUpperCase(), status, priority: 'urgent', information: 'Synthetic request reason' }, status);
const prescription = (medication: string, status: string, more = visit) => row('prescription', medication,
  { ...more, medication, doseQuantity: 1, doseUnit: 'tablet(s)', route: 'Oral', frequency: 'Once a day', instructions: 'Synthetic instruction text',
    startsOn: '2026-09-01', endsOn: null, status }, status);
const ROWS = [
  diagnosis('Essential hypertension', 'confirmed', 'Synthetic confirmed note'),
  diagnosis('Type 2 diabetes mellitus', 'refuted', 'Synthetic refuted note', 'E11'),
  diagnosis('Chronic kidney disease', 'differential', 'Synthetic differential note', 'N18'),
  diagnosis('Asthma', 'provisional', 'Synthetic provisional note', 'J45'),
  diagnosis('Gout', 'unconfirmed', 'Synthetic unconfirmed note', 'M10'),
  diagnosis('HIV disease', 'confirmed', 'Synthetic sensitive note', 'B20'),
  request_('Full blood count', 'active'),
  request_('Lipid profile', 'cancelled'),
  request_('Hepatitis B surface antigen', 'active'),
  request_('Urinalysis', 'active', { _encounterStatus: 'in_progress' }),
  prescription('Amlodipine 5 mg tablets', 'active'),
  prescription('Ciprofloxacin 500 mg tablets', 'cancelled'),
  prescription('Metformin 500 mg tablets', 'draft'),
  prescription('Lisinopril 10 mg tablets', 'entered_in_error'),
  prescription('Artemether-lumefantrine tablets', 'active', { _encounterStatus: 'cancelled' }),
  prescription('Tenofovir/lamivudine/dolutegravir tablets', 'active'),
  row('note', 'Blood pressure review', { ...visit, noteType: 'consultation', text: 'Blood pressure reviewed with Adaeze Okafor. Emergency contact: Chinedu Okafor, 0803 123 4567.',
    signedAt: '2026-09-02T10:00:00Z', revisionRecordedAt: '2026-09-02T10:00:00Z' }),
  row('note', 'Fever today', { _encounterStatus: 'in_progress', noteType: 'consultation', text: 'Synthetic open-visit note', signedAt: null }),
  row('vital', 'Vital measurements', { recorded_at: '2026-09-02T10:00:00Z', systolic_mmhg: 138, diastolic_mmhg: 86, source: 'manual', created_by: 'synthetic-account' }),
];
const PROFILE = { patientId, version: 5, firstName: 'Adaeze', lastName: 'Okafor', fullName: 'Adaeze Okafor', dateOfBirth: '1994-03-12', gender: 'female',
  country: 'NG', state: 'Lagos' };
const LAB = [
  { id: '33333333-3333-4333-8333-000000000001', version: '1:release-a', title: 'Haemoglobin', recordedAt: '2026-09-03T12:00:00.000Z', effectiveAt: '2026-09-03T09:00:00.000Z',
    fields: { test: 'Haemoglobin', codeSystem: 'LOCAL', code: 'HB', specimen: 'blood', resultType: 'numeric', numericValue: '12.5', unit: 'g/dL',
      referenceRange: '12-16', recordedFlag: 'normal', collectedAt: '2026-09-03T09:00:00Z', correctionReason: 'Synthetic correction reason' } },
  { id: '33333333-3333-4333-8333-000000000002', version: '2:pending:release-b', title: 'Fasting blood sugar', recordedAt: '2026-09-04T12:00:00.000Z', effectiveAt: null,
    fields: { test: 'Fasting blood sugar', codeSystem: 'LOCAL', code: 'FBS', specimen: 'blood', correctionPending: true, status: 'The lab is correcting this result.', numericValue: '99.9' } },
  { id: '33333333-3333-4333-8333-000000000003', version: '1:release-c', title: 'HIV 1/2 antibody', recordedAt: '2026-09-04T12:00:00.000Z', effectiveAt: null,
    fields: { test: 'HIV 1/2 antibody', textValue: 'Synthetic sensitive result' } },
];
const DOCUMENT = evidence({ kind: 'document', id: '44444444-4444-4444-8444-000000000001', version: 'v1', title: 'okafor_adaeze_referral_letter.pdf',
  recordedAt: '2026-09-05T10:00:00.000Z', effectiveAt: null, provenance: 'Machine extracted clinical document; not clinician verified',
  quality: 'machine extracted, unverified', fields: { text: 'Page 1: Referral for blood pressure follow-up. Contact adaeze.synthetic@example.test.' } });
const FORBIDDEN = /Adaeze|Okafor|Chinedu|1994|0803|example\.test|referral_letter|Synthetic (refuted|differential|provisional|unconfirmed|confirmed|sensitive) note|Synthetic request reason|Synthetic instruction text|Synthetic open-visit note|Synthetic correction reason|Synthetic sensitive result|99\.9|HIV|Hepatitis|Tenofovir|Lipid profile|Urinalysis|Ciprofloxacin|Metformin|Lisinopril|Artemether|diabetes|kidney|Asthma|Gout|created_by|Lagos/i;

function setup(labRecords: unknown[] = LAB) {
  const query = jest.fn(async (sql: string) => ({ rows: sql === PATIENT_EVIDENCE_QUERY ? ROWS : [] }));
  const database = { withPatientTransaction: async (_a: unknown, _c: string, work: (c: PoolClient) => Promise<unknown>) => work({ query } as unknown as PoolClient) };
  const records = { authorizeSelf: jest.fn().mockResolvedValue(auth) };
  const lab = { patientReleasedResults: jest.fn().mockResolvedValue({ records: labRecords, nextCursor: null }) };
  const attachments = { read: jest.fn().mockResolvedValue({ records: [DOCUMENT], pending: 0, complete: true }), prepare: jest.fn().mockResolvedValue(undefined) };
  const identity = { patientProfile: jest.fn().mockResolvedValue(PROFILE) };
  const audit = { recordWithClient: jest.fn() };
  const evidenceService = new PatientEvidenceService(database as never, records as never, lab as never, audit as never, attachments as never, identity as never);
  const embed = jest.fn().mockResolvedValue(Array(1024).fill(0));
  const plan = jest.fn(), answer = jest.fn().mockResolvedValue('Your record lists this [1].');
  const history = { start: jest.fn().mockResolvedValue('generation'), context: jest.fn().mockResolvedValue({ exchanges: [], bindings: [] }), save: jest.fn() };
  const chat = new PatientChatService(database as never, records as never, { embed } as never, { plan, answer } as never, audit as never,
    history as never, evidenceService);
  return { chat, plan, answer, embed, history };
}

describe('The patient chat still answers normally with what the policy leaves', () => {
  it.each([
    ['Do I have hypertension?', 'condition', 'hypertension', 'diagnosis', 'Essential hypertension'],            // A1
    ['What tests were ordered?', 'labs', 'tests ordered', 'investigation', 'Full blood count'],                  // A2
    ['What medicines am I on?', 'medications', 'current medication', 'prescription', 'Amlodipine 5 mg tablets'], // A3
    ['What were my lab results?', 'labs', 'lab results', 'lab_result', 'Haemoglobin'],                           // A6
    ['Summarise my record', 'summary', 'summary', 'vital', 'Vital measurements'],                                // A4, A5, A7, A9
  ])('%s', async (question, recordIntent, searchQuery, kind, title) => {
    const s = setup();
    s.plan.mockResolvedValue({ intent: 'records', recordIntent, query: searchQuery });
    const reply = await s.chat.answer(request, question);
    expect(s.answer).toHaveBeenCalledTimes(1);
    const sources = s.answer.mock.calls[0][1] as Evidence[];
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.some(source => source.kind === kind && source.title === title)).toBe(true);
    expect(JSON.stringify(sources)).not.toMatch(FORBIDDEN);
    expect(JSON.stringify(s.answer.mock.calls[0])).not.toMatch(FORBIDDEN);
    expect(reply.status).toBe('ready');
    expect(reply.answer.startsWith('Your record lists this [1].')).toBe(true);
    expect(reply.sources.length).toBeGreaterThan(0);
    expect(reply.sources.every(source => reply.answer.includes(`[${source.number}]`))).toBe(true);
    expect(JSON.stringify(reply)).not.toMatch(FORBIDDEN);
    expect(JSON.stringify(s.history.save.mock.calls)).not.toMatch(FORBIDDEN);
  });

  it('keeps the cleaned document, note, placeholder and profile, and only those', async () => {
    const s = setup();
    s.plan.mockResolvedValue({ intent: 'records', recordIntent: 'summary', query: 'summary' });
    await s.chat.answer(request, 'Summarise my record');
    const sources = s.answer.mock.calls[0][1] as Evidence[];
    const titles = sources.map(source => `${source.kind}:${source.title}`).sort();
    expect(titles).toEqual(['diagnosis:Essential hypertension', 'document:Clinical document', 'investigation:Full blood count',
      'lab_result:Fasting blood sugar', 'lab_result:Haemoglobin', 'note:Blood pressure review', 'prescription:Amlodipine 5 mg tablets',
      'profile:Age and sex', 'vital:Vital measurements'].sort());
    expect(sources.find(source => source.kind === 'note')!.fields.text)
      .toBe('Blood pressure reviewed with the patient. Emergency contact: [name removed], [phone removed].');
    expect(sources.find(source => source.kind === 'lab_result' && source.title === 'Fasting blood sugar')!.fields)
      .toMatchObject({ correctionPending: true, status: 'The lab is correcting this result.' });
    expect(sources.find(source => source.kind === 'profile')!.fields).toEqual({ ageYears: expect.any(Number), sex: 'female' });
  });

  it('never sends the name, date of birth or excluded records to Bedrock, and still answers a search question', async () => {
    const s = setup();
    s.plan.mockResolvedValue({ intent: 'records', recordIntent: 'search', query: 'blood pressure' });
    const reply = await s.chat.answer(request, 'What did they say about my blood pressure?');
    expect(s.embed).toHaveBeenCalled();
    for (const [input] of s.embed.mock.calls) expect(String(input)).not.toMatch(FORBIDDEN);
    expect(reply.status).toBe('ready');
    expect(reply.sources.length).toBeGreaterThan(0);
    expect(JSON.stringify(s.answer.mock.calls[0][1])).not.toMatch(FORBIDDEN);
  });
});

describe('Patient chat part 2: Lab results marked "Discussed with the patient" (0121)', () => {
  const result = (n: number, test: string, fields: Record<string, unknown>): { id: string; version: string; title: string; recordedAt: string; effectiveAt: string; fields: Record<string, unknown> } => ({ id: `33333333-3333-4333-8333-0000000001${String(n).padStart(2, '0')}`,
    version: `1:release-${n}`, title: test, recordedAt: '2026-09-06T12:00:00.000Z', effectiveAt: '2026-09-06T09:00:00.000Z',
    fields: { test, codeSystem: 'LOCAL', code: `T${n}`, specimen: 'blood', resultType: 'text', recordedFlag: 'normal', ...fields } });
  const discussedHiv = result(1, 'HIV 1/2 antibody', { textValue: 'Synthetic discussed result', _discussed: true });
  const undiscussedHiv = result(2, 'HIV 1/2 antibody', { textValue: 'Synthetic undiscussed result', _discussed: false });
  const criticalPotassium = result(3, 'Potassium', { resultType: 'numeric', numericValue: '6.9', unit: 'mmol/L', recordedFlag: 'critical_candidate', _discussed: false });
  const discussedCritical = result(4, 'Sodium', { resultType: 'numeric', numericValue: '118', unit: 'mmol/L', recordedFlag: 'critical_candidate', _discussed: true });
  const ordinary = result(5, 'Haemoglobin', { resultType: 'numeric', numericValue: '12.5', unit: 'g/dL', _discussed: false });
  const labSources = (s: ReturnType<typeof setup>) => (s.answer.mock.calls[0][1] as Evidence[]).filter(source => source.kind === 'lab_result');

  it('gives Claude a discussed sensitive result, and the answer citing it ends with the talk-to-your-doctor line once', async () => {
    const s = setup([discussedHiv]);
    s.plan.mockResolvedValue({ intent: 'records', recordIntent: 'labs', query: 'lab results' });
    // The model cites the result and writes the line itself; the server keeps exactly one copy, at the end.
    s.answer.mockImplementation(async (_q: string, sources: Evidence[]) =>
      `Your HIV 1/2 antibody result is recorded [${sources.findIndex(source => source.kind === 'lab_result') + 1}].\n\n${RESULT_LINE}`);
    const reply = await s.chat.answer(request, 'What were my lab results?');
    const sent = labSources(s);
    expect(sent.map(source => source.title)).toEqual(['HIV 1/2 antibody']);
    expect(JSON.stringify(s.answer.mock.calls[0])).not.toMatch(/_discussed/);
    expect(reply.answer.endsWith(RESULT_LINE)).toBe(true);
    expect(reply.answer.split(RESULT_LINE)).toHaveLength(2);
    expect(reply.sources.map(source => source.title)).toContain('HIV 1/2 antibody');
    expect(JSON.stringify(reply)).not.toMatch(/_discussed/);
    expect(JSON.stringify(s.history.save.mock.calls)).not.toMatch(/_discussed/);
  });

  it('drops an undiscussed sensitive result and an undiscussed critical one, and still answers from the rest', async () => {
    const s = setup([undiscussedHiv, criticalPotassium, ordinary]);
    s.plan.mockResolvedValue({ intent: 'records', recordIntent: 'labs', query: 'lab results' });
    const reply = await s.chat.answer(request, 'What were my lab results?');
    expect(labSources(s).map(source => source.title)).toEqual(['Haemoglobin']);
    const forbidden = /HIV|Synthetic undiscussed result|Potassium|6\.9/;
    expect(JSON.stringify(s.answer.mock.calls[0])).not.toMatch(forbidden);
    expect(JSON.stringify(s.embed.mock.calls)).not.toMatch(forbidden);
    expect(reply.status).toBe('ready');
    expect(reply.answer.startsWith('Your record lists this [1].')).toBe(true);
    expect(reply.sources.length).toBeGreaterThan(0);
    expect(JSON.stringify(reply)).not.toMatch(forbidden);
  });

  it('keeps a discussed critical result', async () => {
    const s = setup([discussedCritical, criticalPotassium]);
    s.plan.mockResolvedValue({ intent: 'records', recordIntent: 'labs', query: 'lab results' });
    await s.chat.answer(request, 'What were my lab results?');
    expect(labSources(s).map(source => [source.title, source.fields.recordedFlag])).toEqual([['Sodium', 'critical_candidate']]);
  });

  it('still drops sensitive requests, diagnoses and medicines alongside a discussed result', async () => {
    const s = setup([discussedHiv]);
    s.plan.mockResolvedValue({ intent: 'records', recordIntent: 'summary', query: 'summary' });
    await s.chat.answer(request, 'Summarise my record');
    const sources = s.answer.mock.calls[0][1] as Evidence[];
    expect(sources.some(source => source.kind === 'lab_result' && source.title === 'HIV 1/2 antibody')).toBe(true);
    expect(sources.some(source => source.kind !== 'lab_result' && /HIV|Hepatitis|Tenofovir/i.test(source.title))).toBe(false);
  });

  it('leaves the staff chat unchanged: staff evidence keeps undiscussed sensitive and critical results', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const permissions = ['lab.result.released.read'];
    const scope = { patientId, context: { actor: { accountId: 'staff-a' }, membershipId: 'member-a', facilityId: 'facility-a' }, permissions,
      authorize: jest.fn().mockResolvedValue({ patientId }),
      transaction: async (_a: unknown, _c: string, work: (client: unknown) => Promise<unknown>) => work({ query }),
      allows: (kind: SourceKind) => STAFF_SOURCE_PERMISSIONS[kind].every(p => permissions.includes(p)) } as unknown as StaffChatScope;
    const staffLab = [undiscussedHiv, criticalPotassium].map(r => { const { _discussed: _d, ...fields } = r.fields; return { ...r, fields }; });
    const service = new StaffEvidenceService({ prepare: jest.fn(), read: jest.fn().mockResolvedValue({ records: [], pending: 0, complete: true }) } as never,
      { staffReleasedResults: jest.fn().mockResolvedValue({ records: staffLab, nextCursor: null }) } as never, { recordWithClient: jest.fn() } as never,
      { staffPatientProfile: jest.fn() } as never);
    const snapshot = await service.bind(scope).snapshot({ correlationId: 'synthetic-staff-discussion' } as never);
    expect(snapshot.records.filter(r => r.kind === 'lab_result').map(r => r.title).sort()).toEqual(['HIV 1/2 antibody', 'Potassium']);
  });
});
