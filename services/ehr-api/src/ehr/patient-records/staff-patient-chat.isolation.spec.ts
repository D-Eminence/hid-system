// Staff chat ("Ask about this patient"): one patient per chat, current access
// re-checked on every turn and source view, and full staff access (no
// patient-chat safeguards). Wired end to end through the real controller,
// scope, evidence, history, document-text and chat services; only the
// database, Identity, Lab, storage, Bedrock and Claude are fakes.
// Fictional patients and records only.
import type { PoolClient } from 'pg';
import { DomainProblem } from '../../common/problem';
import { PatientChatService } from './patient-chat.service';
import { PatientAttachmentTextService } from './patient-attachment-text.service';
import { patientEvidence } from './patient-evidence.policy';
import { evidenceQuery } from './patient-evidence.query';
import type { Evidence } from './patient-evidence.types';
import { StaffChatHistoryService } from './staff-chat-history.service';
import { STAFF_SOURCE_PERMISSIONS, StaffChatScopeService } from './staff-chat-scope.service';
import { STAFF_ATTACHMENT_TEXT_QUERY, StaffEvidenceService } from './staff-evidence.service';
import { StaffPatientChatController } from './staff-patient-chat.controller';

// PATIENT_ENTRIES_ENABLED is on by default (0116): the staff chat reads with the records patients add.
const STAFF_EVIDENCE_QUERY = evidenceQuery('staff', true);
jest.mock('../../config/environment', () => ({ getEnvironment: () => ({ AI_ENABLED: true,
  AI_EMBEDDING_MODEL_ID: 'synthetic-embedding-model', S3_REGION: 'eu-west-1' }) }));

// Patient A is the open record. Patient B is another fictional patient the clinician must never reach from A's chat.
const A = '11111111-1111-4111-8111-111111111111';
const B = '99999999-9999-4999-8999-999999999999';
const B_HEALTH_ID = 'HID-B2C3D4E5F6';
const B_NOTE = '99999999-9999-4999-8999-000000000001';
const FACILITY = '33333333-3333-4333-8333-333333333333', MEMBERSHIP = '44444444-4444-4444-8444-444444444444';
const ids = { note: '22222222-2222-4222-8222-000000000001', refuted: '22222222-2222-4222-8222-000000000002',
  confirmed: '22222222-2222-4222-8222-000000000003', request: '22222222-2222-4222-8222-000000000004',
  cancelledRx: '22222222-2222-4222-8222-000000000005', activeRx: '22222222-2222-4222-8222-000000000006',
  document: '22222222-2222-4222-8222-000000000007', lab: '22222222-2222-4222-8222-000000000008' };
const PERMISSIONS = [...new Set(Object.values(STAFF_SOURCE_PERMISSIONS).flat())];
const profileA = { patientId: A, version: 3, firstName: 'Ngozi', lastName: 'Eze', fullName: 'Ngozi Eze',
  dateOfBirth: '1990-04-12', gender: 'female' };
const at = '2026-10-01T10:00:00.000Z';
const row = (kind: string, id: string, title: string, quality: string, fields: Record<string, unknown>) => ({
  kind, id, version: '1', title, recorded_at: at, effective_at: null, provenance: 'Synthetic staff source', quality,
  fields, origin_hint: null, patient_id: A });
/** What the staff evidence query returns for patient A: everything the patient chat would leave out is here. */
function evidenceRowsA() {
  return [
    row('note', ids.note, 'Synthetic review note', 'released', { noteType: 'progress', text: 'Synthetic: reviewed fever, malaria treated.' }),
    row('diagnosis', ids.refuted, 'Essential hypertension', 'refuted', { codeSystem: 'ICD-10', code: 'I10',
      condition: 'Essential hypertension', clinicalStatus: 'inactive', verificationStatus: 'refuted',
      notes: 'Synthetic clinician note: home readings normal, hypertension refuted' }),
    row('diagnosis', ids.confirmed, 'Malaria (uncomplicated)', 'confirmed', { codeSystem: 'ICD-10', code: 'B54',
      condition: 'Malaria (uncomplicated)', clinicalStatus: 'active', verificationStatus: 'confirmed', notes: null }),
    row('investigation', ids.request, 'Full blood count', 'cancelled', { test: 'Full blood count', status: 'cancelled',
      priority: 'routine', information: 'Synthetic request reason: fatigue for two weeks' }),
    row('prescription', ids.cancelledRx, 'Amlodipine 5 mg', 'cancelled', { medication: 'Amlodipine 5 mg', status: 'cancelled',
      instructions: 'Synthetic instructions: take at night' }),
    row('prescription', ids.activeRx, 'Artemether-lumefantrine', 'active', { medication: 'Artemether-lumefantrine', status: 'active' }),
  ];
}
const RESTRICTED_FILE = 'synthetic-restricted-referral-letter.pdf';
function documentRowsA() {
  return [{ kind: 'document', facility_id: FACILITY, id: ids.document, patient_id: A, source_created_at: at, title: RESTRICTED_FILE,
    storage_bucket: 'synthetic-bucket', storage_key: 'synthetic/key', object_version_id: 'v1', sha256_hex: 'a'.repeat(64), size_bytes: 10,
    scan_result: 'clean', detected_media_type: 'application/pdf', scan_sequence: 1, status: 'ready', job_id: 'job', next_token: null,
    extracted_text: 'Synthetic restricted referral letter text', minimum_confidence: 99, unclear_lines: 0, page_count: 1,
    started_at: at, updated_at: at, updated_at_token: '2026-10-01 10:00:00+00' }];
}
const labResultA = { id: ids.lab, version: '2:rel', title: 'Haemoglobin', recordedAt: at, effectiveAt: at,
  fields: { test: 'Haemoglobin', numericValue: '12.5', unit: 'g/dL', correctionReason: 'Synthetic correction reason: transcription error' } };

interface Stored { id: string; question: string; reply: unknown; createdAt: Date; sourceBindings: unknown[] }
function setup() {
  const calls: { sql: string; params: unknown[] }[] = [];
  const stored: Stored[] = [];
  const data = { evidence: evidenceRowsA() as Record<string, unknown>[], documents: documentRowsA() as Record<string, unknown>[] };
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    const rows = (value: unknown[]) => ({ rows: value });
    if (sql.includes('set_config(')) return rows([]);
    if (sql === STAFF_EVIDENCE_QUERY) return rows(params[1] === '' ? data.evidence : []);
    if (sql === STAFF_ATTACHMENT_TEXT_QUERY) return rows(data.documents);
    if (sql.startsWith('insert into ehr.staff_chat_state')) return rows([]);
    if (sql.includes('select generation from ehr.staff_chat_state')) return rows([{ generation: 'generation-a' }]);
    if (sql.includes('select source_bindings as bindings')) return rows(stored.map(s => ({ bindings: s.sourceBindings })));
    if (sql.includes('select id,question,reply')) return rows([...stored].reverse());
    if (sql.includes('insert into ehr.staff_chat_messages')) {
      stored.push({ id: `exchange-${stored.length + 1}`, question: String(params[2]), reply: JSON.parse(String(params[3])),
        createdAt: new Date(at), sourceBindings: JSON.parse(String(params[4])) });
      return rows([]);
    }
    if (sql.includes('order by embedding<=>')) return rows((params[2] as string[]).map(key => {
      const [kind, id] = key.split(':'); return { source_kind: kind, source_id: id, chunk_no: 0 };
    }));
    return rows([]);
  });
  const database = { withTransaction: jest.fn(async (_context: unknown, work: (client: PoolClient) => Promise<unknown>) =>
    work({ query } as unknown as PoolClient)) };
  const assignment = { id: FACILITY, membershipId: MEMBERSHIP, organizationId: 'organization-a', permissions: [...PERMISSIONS] };
  const actor = { kind: 'staff', subject: 'staff-subject-a', accountId: 'account-a', sessionId: 'session-a',
    facilities: [assignment], facility: assignment };
  const access = { revoked: false, permissions: [...PERMISSIONS] };
  const identity = {
    authenticateRequest: jest.fn(async () => ({ ...actor, facilities: [{ ...assignment, permissions: [...access.permissions] }] })),
    staffRecordRead: jest.fn(async (patientId: string) => ({ allowed: patientId === A && !access.revoked, patientId, facilityId: FACILITY,
      membershipId: MEMBERSHIP, scope: 'read_records', purpose: 'direct-care', breakGlass: false })),
    staffPatientProfile: jest.fn(async (patientId: string) => {
      if (patientId !== A) throw new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'Denied');
      return profileA;
    }),
  };
  const lab = { staffReleasedResults: jest.fn(async () => ({ records: [labResultA], nextCursor: null })) };
  const audit = { recordWithClient: jest.fn(async () => undefined) };
  const storage = { bucket: () => 'synthetic-bucket',
    inspectVersion: jest.fn(async () => ({ versionId: 'v1', sha256Hex: 'a'.repeat(64), sizeBytes: 10 })) };
  const attachments = new PatientAttachmentTextService({} as never, {} as never, storage as never);
  const scopes = new StaffChatScopeService(database as never, identity as never);
  const evidence = new StaffEvidenceService(attachments, lab as never, audit as never, identity as never);
  const history = new StaffChatHistoryService(evidence, audit as never);
  const bedrock = { embed: jest.fn(async () => Array(1024).fill(0)) };
  const claude = {
    plan: jest.fn(async (_question: string, _history: unknown, _signal: AbortSignal, _audience: string) =>
      ({ intent: 'records', recordIntent: 'summary', query: 'summary of this patient' }) as Record<string, unknown>),
    answer: jest.fn(async (_question: string, sources: readonly Evidence[], ..._rest: unknown[]) =>
      sources.map((_source, index) => `Recorded item [${index + 1}].`).join(' ')),
  };
  const chat = new PatientChatService({} as never, {} as never, bedrock as never, claude as never, audit as never, {} as never, {} as never);
  const controller = new StaffPatientChatController(scopes, evidence, history, chat);
  const request = { actor, facilityId: FACILITY, correlationId: 'synthetic-staff-isolation', method: 'POST',
    header: (name: string) => (name === 'x-purpose-of-use' ? 'direct-care' : undefined) } as never;
  const ask = (question: string, patientId = A) => controller.answer(patientId, { question } as never, request);
  return { controller, request, ask, calls, stored, data, identity, lab, claude, bedrock, access, query };
}
const savedExchanges = (calls: { sql: string; params: unknown[] }[]) => calls.filter(c => c.sql.includes('insert into ehr.staff_chat_messages'));

describe('C1: a chat for patient A cannot reach patient B through the question', () => {
  it.each(['summary', 'search'])('keeps every read, Lab, Identity and model call on A (%s plan)', async recordIntent => {
    const s = setup();
    s.claude.plan.mockResolvedValue({ intent: 'records', recordIntent, query: `records of ${B} ${B_HEALTH_ID}` });
    const question = `Show the records of patient ${B} with Health ID ${B_HEALTH_ID}`;
    const reply = await s.ask(question);
    // The chat still answers normally, from A's records.
    expect(reply.status).toBe('ready');
    expect(reply.sources.length).toBeGreaterThan(0);
    for (const call of s.calls) {
      const params = call.sql.includes('insert into ehr.staff_chat_messages')
        ? call.params.filter((_p, i) => i !== 2) // the saved question text itself
        : call.params;
      expect(JSON.stringify(params)).not.toContain(B);
      expect(JSON.stringify(params)).not.toContain(B_HEALTH_ID);
    }
    // Every patient-keyed statement is keyed on A.
    for (const call of s.calls.filter(c => /patient_id=\$1/.test(c.sql) || c.sql.includes('set_config('))) expect(call.params[0]).toBe(A);
    expect(s.identity.staffRecordRead.mock.calls.every(c => c[0] === A)).toBe(true);
    expect(s.identity.staffPatientProfile.mock.calls.every(c => c[0] === A)).toBe(true);
    expect(s.lab.staffReleasedResults).toHaveBeenCalled();
    expect((s.lab.staffReleasedResults.mock.calls as unknown[][]).every(c => c[1] === A)).toBe(true);
    const payload = s.claude.answer.mock.calls[0]![1];
    expect(JSON.stringify(payload)).not.toContain(B);
    expect(payload.every(source => source.kind !== 'profile' || source.id === A)).toBe(true);
    if (recordIntent === 'search') {
      expect(s.bedrock.embed).toHaveBeenCalled();
      for (const [text] of s.bedrock.embed.mock.calls.slice(0, -1) as unknown as string[][]) expect(text).not.toContain(B);
    }
    expect(savedExchanges(s.calls)).toHaveLength(1);
  });

  it('refuses the whole turn with 403 when the evidence query returns a row for another patient', async () => {
    const s = setup();
    s.data.evidence.push({ ...evidenceRowsA()[0]!, id: B_NOTE, patient_id: B, fields: { text: 'Synthetic B note' } });
    await expect(s.ask('Summarise this patient')).rejects.toMatchObject({ code: 'CHAT_ACCESS_DENIED' });
    expect(s.claude.answer).not.toHaveBeenCalled();
    expect(savedExchanges(s.calls)).toHaveLength(0);
  });

  it('refuses the whole turn the same way when that row is a record the other patient added (0116)', async () => {
    const s = setup();
    s.data.evidence.push({ ...evidenceRowsA()[0]!, kind: 'patient_entry', id: B_NOTE, patient_id: B, origin_hint: null,
      fields: { type: 'visit', place: null, date: '2026-10-01', notes: 'Synthetic B record' } });
    await expect(s.ask('Summarise this patient')).rejects.toMatchObject({ code: 'CHAT_ACCESS_DENIED' });
    expect(s.claude.answer).not.toHaveBeenCalled();
    expect(savedExchanges(s.calls)).toHaveLength(0);
  });

  it('refuses the whole turn with 403 when the document query returns a row for another patient', async () => {
    const s = setup();
    s.data.documents.push({ ...documentRowsA()[0]!, id: B_NOTE, patient_id: B });
    await expect(s.ask('Summarise this patient')).rejects.toMatchObject({ code: 'CHAT_ACCESS_DENIED' });
    expect(s.claude.answer).not.toHaveBeenCalled();
    expect(savedExchanges(s.calls)).toHaveLength(0);
  });

  it('cannot open B through the URL without B\'s own consent decision', async () => {
    const s = setup();
    await expect(s.ask('Summarise this patient', B)).rejects.toMatchObject({ code: 'CHAT_ACCESS_DENIED' });
    expect(s.claude.plan).not.toHaveBeenCalled();
    expect(s.calls.filter(c => c.sql === STAFF_EVIDENCE_QUERY)).toHaveLength(0);
  });
});

describe('C2: a chat for patient A cannot reach patient B through the source viewer', () => {
  it('returns 404 for B\'s note, B\'s profile and an unknown kind, and the source itself for A', async () => {
    const s = setup();
    await expect(s.controller.source(A, 'note', B_NOTE, s.request)).rejects.toMatchObject({ code: 'CHAT_SOURCE_UNAVAILABLE' });
    await expect(s.controller.source(A, 'profile', B, s.request)).rejects.toMatchObject({ code: 'CHAT_SOURCE_UNAVAILABLE' });
    for (const kind of ['unknown', '__proto__', 'constructor', 'toString']) {
      await expect(s.controller.source(A, kind, ids.note, s.request)).rejects.toMatchObject({ code: 'CHAT_SOURCE_UNAVAILABLE' });
    }
    await expect(s.controller.source(A, 'note', ids.note, s.request)).resolves.toMatchObject({ id: ids.note, kind: 'note' });
    await expect(s.controller.source(A, 'profile', A, s.request)).resolves.toMatchObject({ id: A, kind: 'profile',
      fields: { firstName: 'Ngozi', dateOfBirth: '1990-04-12' } });
  });

  it('refuses B\'s source route with 403 before any read', async () => {
    const s = setup();
    await expect(s.controller.source(B, 'note', B_NOTE, s.request)).rejects.toMatchObject({ code: 'CHAT_ACCESS_DENIED' });
    expect(s.calls.filter(c => c.sql === STAFF_EVIDENCE_QUERY)).toHaveLength(0);
  });
});

describe('C3: a chat opened before access ended is refused afterwards', () => {
  it('refuses the question with 403 before Claude or history save when access ends after the chat is opened', async () => {
    const s = setup();
    // The first decision (opening the chat) is allowed; access ends before the turn starts.
    s.identity.staffRecordRead.mockImplementationOnce(async (patientId: string) => {
      const decision = { allowed: true, patientId, facilityId: FACILITY, membershipId: MEMBERSHIP, scope: 'read_records',
        purpose: 'direct-care', breakGlass: false };
      s.access.revoked = true; return decision;
    });
    await expect(s.ask('Summarise this patient')).rejects.toMatchObject({ code: 'CHAT_ACCESS_DENIED' });
    expect(s.claude.plan).not.toHaveBeenCalled();
    expect(s.claude.answer).not.toHaveBeenCalled();
    expect(savedExchanges(s.calls)).toHaveLength(0);
  });

  it('withholds the generated answer when access ends while Claude is answering', async () => {
    const s = setup();
    s.claude.answer.mockImplementationOnce(async () => { s.access.revoked = true; return 'Recorded item [1].'; });
    await expect(s.ask('Summarise this patient')).rejects.toMatchObject({ code: 'CHAT_ACCESS_DENIED' });
    expect(savedExchanges(s.calls)).toHaveLength(0);
  });

  it('refuses history and source reads with 403 once access has ended', async () => {
    const s = setup();
    await s.ask('Summarise this patient');
    s.access.revoked = true;
    const before = s.calls.length;
    await expect(s.controller.read(A, s.request)).rejects.toMatchObject({ code: 'CHAT_ACCESS_DENIED' });
    await expect(s.controller.source(A, 'note', ids.note, s.request)).rejects.toMatchObject({ code: 'CHAT_ACCESS_DENIED' });
    await expect(s.controller.clear(A, s.request)).rejects.toMatchObject({ code: 'CHAT_ACCESS_DENIED' });
    expect(s.calls.slice(before)).toHaveLength(0);
  });

  it('gives 409 CHAT_ACCESS_CHANGED when the staff member\'s permissions change mid-request, and saves nothing', async () => {
    const s = setup();
    s.claude.answer.mockImplementationOnce(async () => {
      s.access.permissions = s.access.permissions.filter(p => p !== 'ehr.diagnosis.read'); return 'Recorded item [1].';
    });
    await expect(s.ask('Summarise this patient')).rejects.toMatchObject({ code: 'CHAT_ACCESS_CHANGED' });
    expect(savedExchanges(s.calls)).toHaveLength(0);
  });

  it('re-checks identity and the record-read decision on every step of a turn', async () => {
    const s = setup();
    await s.ask('Summarise this patient');
    // Opening, each snapshot, each transaction and the final check all ask Identity again.
    expect(s.identity.authenticateRequest.mock.calls.length).toBeGreaterThan(5);
    expect(s.identity.staffRecordRead.mock.calls.length).toBe(s.identity.authenticateRequest.mock.calls.length);
  });
});

describe('C4: patient-chat exclusions do not affect staff answers', () => {
  it('sends the staff model everything the staff member may read, and adds no patient lines', async () => {
    const s = setup();
    const reply = await s.ask('Summarise this patient');
    const [, sources, , , , audience] = s.claude.answer.mock.calls[0]!;
    expect(audience).toBe('staff');
    expect(s.claude.plan.mock.calls[0]![3]).toBe('staff');
    const payload = JSON.stringify(sources);
    expect(payload).toContain('Synthetic clinician note: home readings normal, hypertension refuted');
    expect(sources.find(r => r.id === ids.refuted)).toMatchObject({ quality: 'refuted', fields: { verificationStatus: 'refuted' } });
    expect(payload).toContain('Synthetic request reason: fatigue for two weeks');
    expect(sources.find(r => r.id === ids.cancelledRx)).toMatchObject({ quality: 'cancelled', fields: { status: 'cancelled',
      instructions: 'Synthetic instructions: take at night' } });
    expect(sources.find(r => r.id === ids.document)).toMatchObject({ title: RESTRICTED_FILE });
    expect(payload).toContain('Synthetic restricted referral letter text');
    expect(payload).toContain('Synthetic correction reason: transcription error');
    expect(sources.find(r => r.kind === 'profile')).toMatchObject({ title: 'Patient profile',
      fields: { firstName: 'Ngozi', lastName: 'Eze', fullName: 'Ngozi Eze', dateOfBirth: '1990-04-12', gender: 'female' } });
    // The answer is exactly what was generated (no server-added lines), and every selected source is listed.
    expect(reply.answer).toBe(sources.map((_r, i) => `Recorded item [${i + 1}].`).join(' '));
    expect(reply.answer).not.toMatch(/Talk to your doctor|lab is correcting/i);
    expect(reply.sources.map(r => r.number)).toEqual(sources.map((_r, i) => i + 1));
    expect(reply.sources.map(r => (r as { originLabel?: string }).originLabel)).toContain("The patient's Health ID profile");
    expect(JSON.stringify(reply.sources)).not.toContain('"hash"');
  });

  it('keeps answering from cancelled items, labelled as cancelled, when they are all that matches', async () => {
    const s = setup();
    s.claude.plan.mockResolvedValue({ intent: 'records', recordIntent: 'medications', query: 'medicines' });
    const reply = await s.ask('Which medicines were stopped?');
    const sources = s.claude.answer.mock.calls[0]![1];
    expect(sources.find(r => r.id === ids.cancelledRx)?.quality).toBe('cancelled');
    expect(reply.status).toBe('ready');
    expect(reply.sources.find(r => r.id === ids.cancelledRx)?.quality).toBe('cancelled');
  });

  it('uses a fixture that the patient policy would clean, so the difference is real', async () => {
    const s = setup();
    await s.ask('Summarise this patient');
    const staff = s.claude.answer.mock.calls[0]![1] as Evidence[];
    const patient = patientEvidence(staff.map(r => ({ ...r })), { firstName: 'Ngozi', lastName: 'Eze', fullName: 'Ngozi Eze',
      dateOfBirth: '1990-04-12', gender: 'female' }, new Date('2026-10-05T09:00:00.000Z'));
    expect(patient.some(r => r.id === ids.refuted)).toBe(false);
    expect(JSON.stringify(patient)).not.toContain('Synthetic correction reason');
    expect(staff.some(r => r.id === ids.refuted)).toBe(true);
  });
});

describe('C5: staff history belongs to this patient only', () => {
  it('parameterises every history statement with A and keeps the generation per patient', async () => {
    const s = setup();
    await s.ask('Summarise this patient');
    const history = await s.controller.read(A, s.request);
    await s.controller.clear(A, s.request);
    const historyCalls = s.calls.filter(c => /ehr\.staff_chat_(state|messages)/.test(c.sql));
    expect(historyCalls.length).toBeGreaterThan(0);
    for (const call of historyCalls) expect(call.params[0]).toBe(A);
    const save = savedExchanges(s.calls)[0]!;
    expect(save.params[1]).toBe('generation-a');
    const reset = s.calls.find(c => c.sql.startsWith('update ehr.staff_chat_state set generation'))!;
    expect(reset.sql).toContain('where patient_id=$1');
    expect(reset.params[0]).toBe(A);
    expect(history.exchanges).toHaveLength(1);
    expect(history.exchanges[0]).toMatchObject({ question: 'Summarise this patient' });
    expect(JSON.stringify(history)).not.toContain('sourceBindings');
  });

  it('hides a saved exchange whose source is not one of this patient\'s current records', async () => {
    const s = setup();
    s.stored.push({ id: 'foreign', question: 'Synthetic question', reply: { status: 'ready', answer: 'Synthetic [1].', sources: [] },
      createdAt: new Date(at), sourceBindings: [{ kind: 'note', id: B_NOTE, version: '1', hash: 'b'.repeat(64) }] });
    const history = await s.controller.read(A, s.request);
    expect(history.exchanges).toEqual([]);
  });
});
