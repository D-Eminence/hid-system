import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AuditService } from '../../audit/audit.service';
import { DomainProblem } from '../../common/problem';
import type { HidRequest } from '../../common/request-context';
import type { DatabaseService } from '../../database/database.service';
import { PatientRecordRelease, type PatientReleaseCategory } from '../patient-records/patient-release';
import { requestDigest } from '../../common/idempotency';
import type { PatientRecordsService } from '../patient-records/patient-records.service';
import { RecordChatProcessorError, type ProcessorResult, type RecordChatProcessor } from './claude-record-chat.client';
import { releasedBindings } from './evidence-extract';
import { FIXED_REPLIES, HISTORY_LIMIT, PRIOR_TURNS, PatientRecordChatService } from './patient-record-chat.service';
import { ANSWER_DETAIL_KEYS, DISCLOSURE_DETAIL_KEYS, HISTORY_DETAIL_KEYS } from './record-chat-audit';
import type { RecordChatConfig } from './record-chat.config';

// A placeholder that is clearly not a real model id.
const MODEL = 'synthetic-test-model';
const QUESTION = 'What was my last blood pressure reading?';
const NOTE_TEXT = 'Synthetic note: blood pressure stable at 118 over 76.';
const ANSWER_TEXT = 'Your last blood pressure was 118 over 76.';
const KEY = 'record-chat-key-0000000001';
const PATIENT = '5c4a7c00-0000-4000-8000-000000000001';
const ENCOUNTER = '5c4a7c00-0000-4000-8000-0000000000e1';
const NOTE = '5c4a7c00-0000-4000-8000-0000000000a1';
const VITAL = '5c4a7c00-0000-4000-8000-0000000000b1';
const RESERVATION = '5c4a7c00-0000-4000-8000-0000000000f1';
const CONVERSATION = '5c4a7c00-0000-4000-8000-0000000000c1';

const enabled: RecordChatConfig = {
  patientEnabled: true, staffEnabled: false, modelId: MODEL, apiKey: 'synthetic-api-key-0123456789abcdef', baseUrl: 'https://api.anthropic.com',
  inferenceGeo: 'us', maxOutputTokens: 4096, deadlineMs: 25_000, maxRetries: 0, maxEvidenceChars: 40_000,
  dailyTokenBudget: 2_000_000, noticeVersion: 'notice-1', auditDigestKey: Buffer.alloc(32, 9),
};

const actor = { kind: 'patient', patientId: PATIENT, accountId: 'account-1', subject: 'subject-1', sessionId: 'session-1' };
const request = { actor, correlationId: 'record-chat-test', header: () => undefined } as unknown as HidRequest;
const authorization = { patientId: PATIENT, accountId: 'account-1', subject: 'subject-1', sessionId: 'session-1',
  expiresAt: new Date(Date.now() + 30_000).toISOString(), allowed: true };

const answerJson = (references = [2]) => JSON.stringify({ status: 'answered', blocks: [
  { kind: 'record', text: ANSWER_TEXT, references }] });
const usage = { inputTokens: 1500, outputTokens: 120, cacheReadTokens: 300, cacheWriteTokens: 0, servedGeo: 'us' };
const answered = (text = answerJson()): ProcessorResult => ({ kind: 'answer', text, stopReason: 'end_turn',
  processorMessageId: 'msg_synthetic_1', usage });

const CLINICAL = /from ehr\.(encounters|clinical_notes|vitals|diagnoses|prescriptions|lab_requests|documents|patient_released_lab_results)/;

interface Options {
  config?: RecordChatConfig;
  categories?: PatientReleaseCategory[];
  control?: boolean | Error;
  stored?: Record<string, unknown> | null;
  storedCount?: number;
  reserveError?: { code: string; detail?: string; message?: string };
  auditFails?: boolean;
  insertError?: { code: string };
  result?: ProcessorResult | Error;
  secondAuthorization?: Error;
  vitalsOnSecondRead?: Record<string, unknown>[];
  noRecords?: boolean;
  history?: Record<string, unknown>[];
  prior?: Record<string, unknown>[];
  hold?: boolean;
  holdDuringDelete?: boolean;
}

function setup(options: Options = {}) {
  const events: string[] = [];
  const violations: string[] = [];
  // Statements that name the imported legacy history (0099's tables or its
  // binding): record chat must never run one.
  const importedReads: string[] = [];
  let inRelease = false;
  let releaseReads = 0;
  const vital = { id: VITAL, encounterId: ENCOUNTER, facilityId: 'facility-1', recordedAt: new Date('2026-09-30T09:00:00Z'),
    heightCm: null, weightKg: null, temperatureC: null, pulseBpm: 64, respiratoryRate: null, systolicMmhg: 118,
    diastolicMmhg: 76, oxygenSaturationPercent: null, source: 'manual' };
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    const text = sql.replace(/\s+/g, ' ');
    if (CLINICAL.test(text) && !inRelease) violations.push(text);
    if (/imported_medical_record|imported_history/.test(text)) {
      importedReads.push(text);
      return { rows: [{ id: 'imported-legacy-row', sourcePayload: { text: 'IMPORTED-LEGACY-HISTORY-TEXT' } }] };
    }
    if (/set_config\('app\.patient_release'/.test(text)) { events.push('bind'); return { rows: [] }; }
    if (/from ehr\.encounters/.test(text)) {
      return { rows: options.noRecords ? [] : [{ id: ENCOUNTER, facilityId: 'facility-1', encounterType: 'ambulatory',
        status: 'completed', startedAt: new Date('2026-09-30T08:00:00Z'), endedAt: new Date('2026-09-30T10:00:00Z') }] };
    }
    if (/from ehr\.clinical_notes/.test(text)) {
      return { rows: options.noRecords ? [] : [{ id: NOTE, encounterId: ENCOUNTER, facilityId: 'facility-1',
        noteType: 'progress', title: 'Follow-up', status: 'signed', revisionNo: 1, content: NOTE_TEXT,
        signedAt: new Date('2026-09-30T10:05:00Z') }] };
    }
    if (/from ehr\.vitals/.test(text)) {
      return { rows: releaseReads > 1 && options.vitalsOnSecondRead ? options.vitalsOnSecondRead : [vital] };
    }
    if (CLINICAL.test(text)) return { rows: [] };
    if (/where patient_id=\$1 and idempotency_key=\$2/.test(text)) {
      events.push('replay-check');
      return { rows: options.stored ? [options.stored] : [] };
    }
    if (/select count\(\*\)::text as count from ehr\.patient_chat_messages/.test(text)) {
      return { rows: [{ count: String(options.storedCount ?? 0) }] };
    }
    if (/reply->>'answer' as answer/.test(text)) return { rows: options.prior ?? [] };
    if (/ehr\.record_chat_history_on_hold/.test(text) && !/with deleted/.test(text)) {
      events.push('hold-check');
      return { rows: [{ held: options.hold ?? false }] };
    }
    if (/with deleted_messages as \(delete from ehr\.patient_chat_messages/.test(text)) {
      events.push('delete');
      return { rows: [{ count: options.holdDuringDelete ? '0' : String(options.storedCount ?? 0),
        existing: 1, deleted: options.holdDuringDelete ? 0 : 1 }] };
    }
    if (/insert into ehr\.patient_chat_conversations/.test(text)) {
      events.push('conversation');
      return { rows: [{ id: CONVERSATION }] };
    }
    if (/ehr\.reserve_record_chat/.test(text)) {
      events.push('reserve');
      if (options.reserveError) throw Object.assign(new Error('raised'), options.reserveError);
      return { rows: [{ id: RESERVATION }] };
    }
    if (/ehr\.settle_record_chat/.test(text)) { events.push(`settle:${String(params?.[5])}`); return { rows: [] }; }
    if (/^savepoint|^release savepoint|^rollback to savepoint/.test(text)) { events.push(text.split(' ')[0]!); return { rows: [] }; }
    if (/insert into ehr\.patient_chat_messages/.test(text)) {
      events.push('insert');
      if (options.insertError) throw Object.assign(new Error('fk'), options.insertError);
      return { rows: [{ createdAt: new Date('2026-10-16T12:00:00Z') }] };
    }
    if (/select id from ehr\.patient_chat_conversations/.test(text)) {
      return { rows: options.history ? [{ id: CONVERSATION }] : [] };
    }
    if (/from ehr\.patient_chat_messages where patient_id=\$1 order by/.test(text)) {
      return { rows: options.history ?? [] };
    }
    if (/delete from ehr\.patient_chat_conversations/.test(text)) { events.push('delete'); return { rows: [] }; }
    throw new Error(`unexpected statement: ${text}`);
  });
  const client = { query } as unknown as PoolClient;
  let transactions = 0;
  const withPatientTransaction = jest.fn(async (_auth: unknown, _correlation: string,
    work: (c: PoolClient) => Promise<unknown>) => {
    transactions += 1;
    events.push(`begin:${transactions}`);
    try {
      const value = await work(client);
      events.push(`commit:${transactions}`);
      return value;
    } catch (error) {
      events.push(`rollback:${transactions}`);
      throw error;
    }
  });
  const databaseQuery = jest.fn(async () => {
    events.push('control');
    if (options.control instanceof Error) throw options.control;
    return { rows: [{ enabled: options.control ?? true }] };
  });
  let authorizations = 0;
  const authorizeOwnSession = jest.fn(async () => {
    authorizations += 1;
    events.push(`authorize:${authorizations}`);
    if (authorizations > 1 && options.secondAuthorization) throw options.secondAuthorization;
    return { actor, authorization };
  });
  const recordWithClient = jest.fn(async (_client: unknown, event: { action: string }) => {
    events.push(`audit:${event.action}`);
    if (options.auditFails && event.action === 'ehr.record-chat.disclosure') throw new Error('audit unavailable');
  });
  const record = jest.fn(async (event: { action: string }) => { events.push(`audit-pool:${event.action}`); });
  const processor: RecordChatProcessor = {
    processor: 'anthropic',
    ensureReady: jest.fn(async () => { events.push('ready'); }),
    ask: jest.fn(async () => {
      events.push('ask');
      if (options.result instanceof Error) throw options.result;
      return options.result ?? answered();
    }),
  };
  const release = new PatientRecordRelease(options.categories ?? ['vitals']);
  const read = release.read.bind(release);
  jest.spyOn(release, 'read').mockImplementation(async (c, patientId) => {
    inRelease = true;
    releaseReads += 1;
    events.push('read');
    try { return await read(c, patientId); } finally { inRelease = false; }
  });
  const service = new PatientRecordChatService(
    { withPatientTransaction, query: databaseQuery } as unknown as DatabaseService,
    { recordWithClient, record } as unknown as AuditService,
    { authorizeOwnSession } as unknown as PatientRecordsService, release, options.config ?? enabled, processor);
  return { service, events, violations, importedReads, query, processor, authorizeOwnSession, recordWithClient, record,
    withPatientTransaction, databaseQuery, release };
}

/** The hash the release set gives the fixture vital now, as a stored binding records it. */
async function currentVitalHash(): Promise<string> {
  const probe = setup();
  const visible = releasedBindings(await probe.release.read({ query: probe.query } as unknown as PoolClient, PATIENT));
  return visible.get(`vital:${VITAL}`)!;
}

/** key null sends no Idempotency-Key header. */
const ask = (setupResult: ReturnType<typeof setup>, body: Record<string, unknown> = {}, key: string | null = KEY) =>
  setupResult.service.ask(request, { question: QUESTION, noticeVersion: 'notice-1', ...body } as never, key ?? undefined);

async function problem(promise: Promise<unknown>): Promise<DomainProblem> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainProblem) return error;
    throw error;
  }
  throw new Error('expected a DomainProblem');
}

describe('PatientRecordChatService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('answers 503 RECORD_CHAT_DISABLED with the flag off, with no Identity, database or processor call', async () => {
    const chat = setup({ config: { ...enabled, patientEnabled: false } });
    const refused = await problem(ask(chat));
    expect([refused.getStatus(), refused.code]).toEqual([503, 'RECORD_CHAT_DISABLED']);
    expect(chat.events).toEqual([]);
    expect(chat.databaseQuery).not.toHaveBeenCalled();
    expect(chat.processor.ask).not.toHaveBeenCalled();
  });

  it('answers 503 RECORD_CHAT_PAUSED while the platform control is off, before Identity', async () => {
    const chat = setup({ control: false });
    const refused = await problem(ask(chat));
    expect([refused.getStatus(), refused.code]).toEqual([503, 'RECORD_CHAT_PAUSED']);
    expect(chat.events).toEqual(['control']);
    const unknown = await problem(ask(setup({ control: new Error('down') })));
    expect([unknown.getStatus(), unknown.code]).toEqual([503, 'PLATFORM_CONTROL_UNAVAILABLE']);
  });

  it('requires the current notice, a question of 1 to 1000 characters and an Idempotency-Key', async () => {
    const notice = await problem(ask(setup(), { noticeVersion: 'notice-0' }));
    expect([notice.getStatus(), notice.code]).toEqual([428, 'CHAT_NOTICE_REQUIRED']);
    const long = await problem(ask(setup(), { question: 'q'.repeat(1001) }));
    expect([long.getStatus(), long.code]).toEqual([400, 'INVALID_QUESTION']);
    const blank = await problem(ask(setup(), { question: '   ' }));
    expect(blank.code).toBe('INVALID_QUESTION');
    const keyless = setup();
    const missing = await problem(ask(keyless, {}, null));
    expect([missing.getStatus(), missing.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
    expect(keyless.authorizeOwnSession).not.toHaveBeenCalled();
  });

  it('authorizes, reads, reserves and audits the disclosure before the one call, then authorizes again and saves', async () => {
    const chat = setup();
    const reply = await ask(chat);
    expect(chat.events).toEqual(['control', 'authorize:1', 'begin:1', 'replay-check', 'read', 'bind', 'conversation',
      'reserve', 'audit:ehr.record-chat.disclosure', 'commit:1', 'ready', 'ask', 'authorize:2', 'begin:2', 'read', 'bind',
      'savepoint', 'insert', 'release', 'settle:answered', 'audit:ehr.record-chat.answer', 'commit:2']);
    expect(reply).toMatchObject({ status: 'answered', answer: ANSWER_TEXT, processor: 'anthropic', conversationId: CONVERSATION,
      idempotentReplay: false, blocks: [{ kind: 'record', text: ANSWER_TEXT, references: [2] }],
      sources: [{ number: 2, kind: 'note', id: NOTE }] });
    expect(reply.coverage).toMatchObject({ released: ['encounters', 'notes', 'vitals'], withheld: expect.arrayContaining(
      ['diagnoses', 'labRequests']) });
    expect(chat.processor.ask).toHaveBeenCalledTimes(1);
  });

  it('reads records only through the patient release set, and only its configured categories', async () => {
    const chat = setup({ categories: [] });
    await ask(chat, {}, KEY);
    expect(chat.violations).toEqual([]);
    expect(chat.release.read).toHaveBeenCalledTimes(2);
    const statements = chat.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => /from ehr\.(vitals|diagnoses|prescriptions|documents|lab_requests)/.test(sql))).toBe(false);
    const sent = (chat.processor.ask as jest.Mock).mock.calls[0][0].userBlocks.join('\n');
    expect(sent).not.toContain('"vital"');
    const withVitals = setup({ categories: ['vitals'] });
    await ask(withVitals);
    expect((withVitals.processor.ask as jest.Mock).mock.calls[0][0].userBlocks.join('\n')).toContain('"vital"');
  });

  it('never sends the imported legacy history to the processor, even with its release flag on', async () => {
    // EHR_PATIENT_RELEASE_IMPORTED_HISTORY on: the release set names
    // importedHistory, and the database would admit the patient's imported
    // rows in this transaction. Record chat reads only PatientRecordRelease.read,
    // whose summary categories never include it, and never calls
    // readImportedHistory: the imported history is not evidence (the record
    // chat ADR, Proposed defaults).
    const chat = setup({ categories: ['vitals', 'importedHistory'] });
    const readImported = jest.spyOn(chat.release, 'readImportedHistory');
    expect(chat.release.releases('importedHistory')).toBe(true);
    const reply = await ask(chat);
    expect(reply.status).toBe('answered');
    const bindings = chat.query.mock.calls.filter(([sql]) => /set_config\('app\.patient_release'/.test(String(sql)));
    expect(bindings.length).toBeGreaterThan(0);
    for (const [, params] of bindings) expect(params).toEqual(['vitals,importedHistory']);
    expect(readImported).not.toHaveBeenCalled();
    expect(chat.importedReads).toEqual([]);
    const sentRequest = (chat.processor.ask as jest.Mock).mock.calls[0][0] as { systemPrompt: string; userBlocks: string[] };
    const sent = sentRequest.userBlocks.join('\n');
    expect(sent).toContain('"vital"');
    expect(sent).not.toMatch(/imported|IMPORTED-LEGACY-HISTORY-TEXT|imported-legacy-row/i);
    expect(reply.coverage.released).toEqual(['encounters', 'notes', 'vitals']);
    expect([...reply.coverage.released, ...reply.coverage.withheld]).not.toContain('importedHistory');
    expect(reply.sources.map((source) => source.kind)).not.toContain('importedHistory');
    // Availability lists the categories chat reads: not the imported history.
    await expect(chat.service.availability()).resolves.toMatchObject({ released: ['encounters', 'notes', 'vitals'] });
    // Nor does the history read it.
    await chat.service.history(request);
    expect(readImported).not.toHaveBeenCalled();
    expect(chat.importedReads).toEqual([]);
  });

  it('makes no call when the disclosure audit cannot be written', async () => {
    const chat = setup({ auditFails: true });
    await expect(ask(chat)).rejects.toThrow('audit unavailable');
    expect(chat.events).toContain('rollback:1');
    expect(chat.processor.ask).not.toHaveBeenCalled();
    expect(chat.processor.ensureReady).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: 'P4290', detail: '1234' }, 429, 'RECORD_CHAT_RATE_LIMITED', 1234],
    [{ code: 'P4290', detail: 'not a number' }, 429, 'RECORD_CHAT_RATE_LIMITED', 3600],
    [{ code: 'P4091' }, 429, 'RECORD_CHAT_BUSY', 5],
    [{ code: 'P5030' }, 503, 'RECORD_CHAT_BUDGET_EXHAUSTED', undefined],
    [{ code: '42501' }, 403, 'PATIENT_ACCESS_DENIED', undefined],
    // The kill switch, read again by the reservation in the same transaction as the disclosure audit.
    [{ code: '55000', message: 'RECORD_CHAT_PAUSED' }, 503, 'RECORD_CHAT_PAUSED', undefined],
    [{ code: '55000', message: 'PLATFORM_CONTROL_UNAVAILABLE' }, 503, 'PLATFORM_CONTROL_UNAVAILABLE', undefined],
  ])('answers the limit refusal %j as %s %s, with no call', async (error, status, code, retryAfter) => {
    const chat = setup({ reserveError: error });
    const refused = await problem(ask(chat));
    expect([refused.getStatus(), refused.code, refused.retryAfterSeconds]).toEqual([status, code, retryAfter]);
    expect(chat.processor.ask).not.toHaveBeenCalled();
    expect(chat.events).not.toContain('audit:ehr.record-chat.disclosure');
  });

  it('refuses a full history before any call', async () => {
    const chat = setup({ storedCount: HISTORY_LIMIT });
    const refused = await problem(ask(chat));
    expect([refused.getStatus(), refused.code]).toEqual([409, 'CHAT_HISTORY_FULL']);
    expect(chat.processor.ask).not.toHaveBeenCalled();
  });

  it('discards the answer when the patient-self authorization changed during the call', async () => {
    const changed = new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'Patient authorization changed');
    const chat = setup({ secondAuthorization: changed });
    const refused = await problem(ask(chat));
    expect([refused.getStatus(), refused.code]).toEqual([403, 'PATIENT_ACCESS_DENIED']);
    expect(chat.events).not.toContain('insert');
    expect(chat.withPatientTransaction).toHaveBeenCalledTimes(1);
    expect(chat.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'ehr.record-chat.answer', outcome: 'denied',
      details: expect.objectContaining({ reason: 'authorization_changed', processor: 'anthropic' }) }));
  });

  it('answers 409 CHAT_SOURCES_CHANGED when a cited record changed before the save', async () => {
    const chat = setup({ result: answered(answerJson([3])), vitalsOnSecondRead: [{ id: VITAL, encounterId: ENCOUNTER,
      facilityId: 'facility-1', recordedAt: new Date('2026-09-30T09:00:00Z'), systolicMmhg: 150, diastolicMmhg: 95 }] });
    const refused = await problem(ask(chat));
    expect([refused.getStatus(), refused.code]).toEqual([409, 'CHAT_SOURCES_CHANGED']);
    expect(chat.events).toContain('settle:sources_changed');
    expect(chat.events).not.toContain('insert');
  });

  it('answers 409 CHAT_CONVERSATION_CHANGED when the history was cleared during the call', async () => {
    const chat = setup({ insertError: { code: '23503' } });
    const refused = await problem(ask(chat));
    expect([refused.getStatus(), refused.code]).toEqual([409, 'CHAT_CONVERSATION_CHANGED']);
    expect(chat.events).toEqual(expect.arrayContaining(['rollback', 'settle:conversation_changed', 'commit:2']));
  });

  it('replays a stored answer for the same key and question, with no call; another question is refused', async () => {
    const reply = { status: 'answered', answer: ANSWER_TEXT, blocks: [], sources: [], coverage: {} };
    const stored = (sha: string) => ({ id: 'message-1', conversationId: CONVERSATION, question: QUESTION, reply,
      sourceBindings: [], requestSha256: sha, createdAt: new Date('2026-10-16T12:00:00Z') });
    const { requestDigest } = jest.requireActual('../../common/idempotency') as typeof import('../../common/idempotency');
    const same = setup({ stored: stored(requestDigest('ehr.record-chat.ask', { question: QUESTION, noticeVersion: 'notice-1' })) });
    await expect(ask(same)).resolves.toMatchObject({ idempotentReplay: true, messageId: 'message-1', answer: ANSWER_TEXT });
    expect(same.processor.ask).not.toHaveBeenCalled();
    expect(same.events).toContain('audit:ehr.record-chat.replay');
    const other = setup({ stored: stored('0'.repeat(64)) });
    const refused = await problem(ask(other));
    expect([refused.getStatus(), refused.code]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
    expect(other.processor.ask).not.toHaveBeenCalled();
  });

  it('stores fixed texts for a refusal and for an answer that fails validation, keeping nothing from the model', async () => {
    const declined = setup({ result: { kind: 'refusal', stopReason: 'refusal', refusalCategory: 'bio',
      processorMessageId: 'msg_2', usage } });
    await expect(ask(declined)).resolves.toMatchObject({ status: 'declined', answer: FIXED_REPLIES.declined, sources: [] });
    expect(declined.events).toContain('settle:declined');
    const invented = 'Your NIN is 12345678901.';
    const invalid = setup({ result: answered(JSON.stringify({ status: 'answered', blocks: [
      { kind: 'record', text: invented, references: [2] }] })) });
    const reply = await ask(invalid);
    expect(reply).toMatchObject({ status: 'unverified', answer: FIXED_REPLIES.unverified, sources: [] });
    expect(JSON.stringify((invalid.query.mock.calls.find(([sql]) => /insert into ehr\.patient_chat_messages/.test(String(sql)))
      ?? [])[1])).not.toContain(invented);
    const truncated = setup({ result: { kind: 'incomplete', stopReason: 'max_tokens', processorMessageId: 'msg_3', usage } });
    await expect(ask(truncated)).resolves.toMatchObject({ status: 'unverified' });
    expect(truncated.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'ehr.record-chat.answer', details: expect.objectContaining({ reason: 'max_tokens' }) }));
  });

  it('answers 503 RECORD_CHAT_UNAVAILABLE on a processor failure, settling the lease and auditing the reason only', async () => {
    const chat = setup({ result: new RecordChatProcessorError('timeout') });
    const refused = await problem(ask(chat));
    expect([refused.getStatus(), refused.code]).toEqual([503, 'RECORD_CHAT_UNAVAILABLE']);
    expect(chat.events).toEqual(expect.arrayContaining(['settle:failed', 'audit:ehr.record-chat.answer', 'commit:2']));
    expect(chat.events).not.toContain('insert');
    expect(chat.recordWithClient).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ outcome: 'failure',
      details: expect.objectContaining({ reason: 'timeout' }) }));
  });

  it('answers a fixed no-evidence reply with no call when nothing is released', async () => {
    const chat = setup({ categories: [], noRecords: true });
    const reply = await ask(chat);
    expect(reply).toMatchObject({ status: 'no_evidence', answer: FIXED_REPLIES.noRecords, sources: [] });
    expect(chat.processor.ask).not.toHaveBeenCalled();
    expect(chat.events).toEqual(expect.arrayContaining(['reserve', 'insert', 'settle:no_evidence']));
    expect(chat.events).not.toContain('audit:ehr.record-chat.disclosure');
  });

  it('audits codes, counts and digests only, naming the processor, model and geography', async () => {
    const chat = setup();
    await ask(chat);
    const audited = chat.recordWithClient.mock.calls.map(([, event]) => event as unknown as {
      action: string; details: Record<string, unknown>; resourceType: string });
    const disclosure = audited.find((event) => event.action === 'ehr.record-chat.disclosure')!;
    const answer = audited.find((event) => event.action === 'ehr.record-chat.answer')!;
    expect(Object.keys(disclosure.details).every((key) => (DISCLOSURE_DETAIL_KEYS as readonly string[]).includes(key))).toBe(true);
    expect(Object.keys(answer.details).every((key) => (ANSWER_DETAIL_KEYS as readonly string[]).includes(key))).toBe(true);
    expect(disclosure.details).toMatchObject({ processor: 'anthropic', model: MODEL, inferenceGeo: 'us', audience: 'patient',
      sourceCount: 3, sourceCounts: { encounter: 1, note: 1, vital: 1 }, disclosureDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(answer.details).toMatchObject({ processor: 'anthropic', model: MODEL, status: 'answered', inputTokens: 1500,
      outputTokens: 120, cacheReadTokens: 300, servedGeo: 'us', processorMessageId: 'msg_synthetic_1', citationsValid: true });
    const serialized = JSON.stringify(audited);
    for (const text of [QUESTION, ANSWER_TEXT, NOTE_TEXT, 'blood pressure']) expect(serialized).not.toContain(text);
  });

  it('never hands the question, the records or the answer to a logger', async () => {
    const spies = [...(['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const).map((method) =>
      jest.spyOn(Logger.prototype, method).mockImplementation(() => undefined)),
    ...(['log', 'error', 'warn', 'info', 'debug'] as const).map((method) =>
      jest.spyOn(console, method).mockImplementation(() => undefined))];
    await ask(setup());
    await problem(ask(setup({ result: new RecordChatProcessorError('processor_error') })));
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    for (const text of [QUESTION, ANSWER_TEXT, NOTE_TEXT]) expect(logged).not.toContain(text);
  });

  it('caps the calls in flight in this process at four', async () => {
    let releaseCalls: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseCalls = resolve; });
    const chat = setup();
    (chat.processor.ask as jest.Mock).mockImplementation(async () => { await gate; return answered(); });
    const pending = [1, 2, 3, 4].map((n) => ask(chat, {}, `record-chat-key-000000000${n}`));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const busy = await problem(ask(chat, {}, 'record-chat-key-0000000005'));
    expect([busy.getStatus(), busy.code, busy.retryAfterSeconds]).toEqual([429, 'RECORD_CHAT_BUSY', 5]);
    releaseCalls();
    await Promise.all(pending);
  });

  it('reads the history newest first without any call, leaving out exchanges whose records are no longer released', async () => {
    const reply = { status: 'answered', answer: ANSWER_TEXT, blocks: [], sources: [], coverage: {} };
    const hash = await currentVitalHash();
    const chat = setup({ config: { ...enabled, patientEnabled: false }, history: [
      { id: 'message-2', question: QUESTION, reply, sourceBindings: [{ kind: 'vital', id: VITAL, hash }],
        createdAt: new Date('2026-10-16T12:00:00Z') },
      { id: 'message-1', question: QUESTION, reply, sourceBindings: [{ kind: 'diagnosis', id: 'gone', hash: 'h' }],
        createdAt: new Date('2026-10-15T12:00:00Z') }] });
    const history = await chat.service.history(request);
    expect(history).toMatchObject({ conversationId: CONVERSATION, limit: HISTORY_LIMIT,
      exchanges: [{ messageId: 'message-2', question: QUESTION, reply: { answer: ANSWER_TEXT } }] });
    expect(history.exchanges).toHaveLength(1);
    expect(chat.processor.ask).not.toHaveBeenCalled();
    const audit = chat.recordWithClient.mock.calls.at(-1)![1] as unknown as { action: string; details: Record<string, unknown> };
    expect(audit).toMatchObject({ action: 'ehr.record-chat.history.read', details: { exchangeCount: 1, hiddenCount: 1 } });
    expect(Object.keys(audit.details).every((key) => (HISTORY_DETAIL_KEYS as readonly string[]).includes(key))).toBe(true);
  });

  it('deletes the whole history on request, while chat is off too, counting the exchanges its own statement deleted', async () => {
    const chat = setup({ config: { ...enabled, patientEnabled: false }, storedCount: 3 });
    await expect(chat.service.clear(request)).resolves.toEqual({ cleared: true, deletedCount: 3 });
    expect(chat.events).toEqual(['authorize:1', 'begin:1', 'hold-check', 'delete', 'audit:ehr.record-chat.history.clear',
      'commit:1']);
    // The messages and the conversation go in one statement, which also returns how many it deleted.
    const deleting = chat.query.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' '))
      .filter((sql) => /delete from ehr\.patient_chat/.test(sql));
    expect(deleting).toHaveLength(1);
    expect(deleting[0]).toMatch(/with deleted_messages as \(delete from ehr\.patient_chat_messages where patient_id=\$1 returning 1\)/);
    expect(deleting[0]).toMatch(/delete from ehr\.patient_chat_conversations where patient_id=\$1 returning 1/);
  });

  it('keeps the history while a legal hold names the patient or the account: 409 CHAT_HISTORY_ON_HOLD, audited', async () => {
    const held = setup({ hold: true, storedCount: 3 });
    const refused = await problem(held.service.clear(request));
    expect([refused.getStatus(), refused.code]).toEqual([409, 'CHAT_HISTORY_ON_HOLD']);
    expect(held.events).toEqual(['authorize:1', 'begin:1', 'hold-check', 'audit:ehr.record-chat.history.clear', 'commit:1']);
    expect(held.recordWithClient).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      action: 'ehr.record-chat.history.clear', outcome: 'denied', details: { reason: 'legal_hold' } }));
    // A hold placed after the check: the delete policy keeps every row and nothing is reported cleared.
    const raced = setup({ holdDuringDelete: true, storedCount: 3 });
    const late = await problem(raced.service.clear(request));
    expect([late.getStatus(), late.code]).toEqual([409, 'CHAT_HISTORY_ON_HOLD']);
    expect(raced.events).toEqual(['authorize:1', 'begin:1', 'hold-check', 'delete', 'rollback:1',
      'audit-pool:ehr.record-chat.history.clear']);
    expect(raced.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'denied',
      details: { reason: 'legal_hold' } }));
  });

  it('sends earlier exchanges only while every record they cite is still released with the same content', async () => {
    const hash = await currentVitalHash();
    const chat = setup({ prior: [
      { id: 'message-4', question: 'PRIOR-QUESTION-MATCHING', answer: 'PRIOR-ANSWER-MATCHING',
        sourceBindings: [{ kind: 'vital', id: VITAL, hash }] },
      { id: 'message-3', question: 'PRIOR-QUESTION-CHANGED', answer: 'PRIOR-ANSWER-CHANGED',
        sourceBindings: [{ kind: 'vital', id: VITAL, hash: 'superseded-content' }] },
      { id: 'message-2', question: 'PRIOR-QUESTION-RETRACTED', answer: 'PRIOR-ANSWER-RETRACTED',
        sourceBindings: [{ kind: 'note', id: '5c4a7c00-0000-4000-8000-0000000000a9', hash: 'h' }] },
      { id: 'message-1', question: 'PRIOR-QUESTION-DECLINED', answer: FIXED_REPLIES.declined, sourceBindings: [] },
    ] });
    await ask(chat);
    const sent = ((chat.processor.ask as jest.Mock).mock.calls[0][0].userBlocks as string[]).join('\n');
    for (const text of ['PRIOR-QUESTION-CHANGED', 'PRIOR-ANSWER-CHANGED', 'PRIOR-QUESTION-RETRACTED',
      'PRIOR-ANSWER-RETRACTED']) expect(sent).not.toContain(text);
    expect(sent).toContain('PRIOR-ANSWER-MATCHING');
    // Oldest first, as a conversation reads.
    expect(sent.indexOf('PRIOR-QUESTION-DECLINED')).toBeGreaterThan(-1);
    expect(sent.indexOf('PRIOR-QUESTION-DECLINED')).toBeLessThan(sent.indexOf('PRIOR-QUESTION-MATCHING'));
    const disclosure = chat.recordWithClient.mock.calls.map(([, event]) => event as unknown as {
      action: string; details: Record<string, unknown> }).find((event) => event.action === 'ehr.record-chat.disclosure')!;
    expect(disclosure.details.priorExchangeCount).toBe(2);
    // The query reads the bindings it filters on.
    const prior = chat.query.mock.calls.map(([sql]) => String(sql)).find((sql) => /reply->>'answer' as answer/.test(sql))!;
    expect(prior).toMatch(/source_bindings/);
  });

  it(`sends at most ${PRIOR_TURNS} earlier exchanges, the newest that still match the release`, async () => {
    const hash = await currentVitalHash();
    const prior = [6, 5, 4, 3, 2, 1].map((n) => ({ id: `message-${n}`, question: `PRIOR-Q-${n}`, answer: `PRIOR-A-${n}`,
      sourceBindings: n === 6 ? [{ kind: 'vital', id: VITAL, hash: 'superseded-content' }]
        : [{ kind: 'vital', id: VITAL, hash }] }));
    const chat = setup({ prior });
    await ask(chat);
    const sent = ((chat.processor.ask as jest.Mock).mock.calls[0][0].userBlocks as string[]).join('\n');
    expect([1, 2, 3, 4, 5, 6].filter((n) => sent.includes(`PRIOR-Q-${n}`))).toEqual([2, 3, 4, 5]);
  });

  it('answers 409 CHAT_SOURCES_CHANGED on a replay whose cited record changed or is gone, with no call', async () => {
    const hash = await currentVitalHash();
    const reply = { status: 'answered', answer: ANSWER_TEXT, blocks: [], sources: [], coverage: {} };
    const stored = (sourceBindings: unknown[]) => ({ id: 'message-1', conversationId: CONVERSATION, question: QUESTION,
      reply, sourceBindings, requestSha256: requestDigest('ehr.record-chat.ask', { question: QUESTION,
        noticeVersion: 'notice-1' }), createdAt: new Date('2026-10-16T12:00:00Z') });
    for (const bindings of [[{ kind: 'vital', id: VITAL, hash: 'superseded-content' }],
      [{ kind: 'diagnosis', id: '5c4a7c00-0000-4000-8000-0000000000d9', hash: 'h' }]]) {
      const chat = setup({ stored: stored(bindings) });
      const refused = await problem(ask(chat));
      expect([refused.getStatus(), refused.code]).toEqual([409, 'CHAT_SOURCES_CHANGED']);
      expect(chat.processor.ask).not.toHaveBeenCalled();
    }
    const unchanged = setup({ stored: stored([{ kind: 'vital', id: VITAL, hash }]) });
    await expect(ask(unchanged)).resolves.toMatchObject({ idempotentReplay: true, messageId: 'message-1' });
  });

  it('leaves out of the history an exchange whose cited record changed since it was answered', async () => {
    const hash = await currentVitalHash();
    const reply = { status: 'answered', answer: ANSWER_TEXT, blocks: [], sources: [], coverage: {} };
    const chat = setup({ history: [
      { id: 'message-2', question: QUESTION, reply, sourceBindings: [{ kind: 'vital', id: VITAL, hash }],
        createdAt: new Date('2026-10-16T12:00:00Z') },
      { id: 'message-1', question: QUESTION, reply, sourceBindings: [{ kind: 'vital', id: VITAL, hash: 'superseded-content' }],
        createdAt: new Date('2026-10-15T12:00:00Z') }] });
    const history = await chat.service.history(request);
    expect(history.exchanges.map((exchange) => exchange.messageId)).toEqual(['message-2']);
    expect(chat.recordWithClient.mock.calls.at(-1)![1]).toMatchObject({ details: { exchangeCount: 1, hiddenCount: 1 } });
  });

  it('refuses a question holding a NUL, another control character or a lone surrogate, before Identity', async () => {
    for (const question of ['what\u0000is my pulse', 'my pulse\u0007?', 'pulse \u001b[2J', 'pulse\u007f', 'pulse\u0085',
      'pulse \ud800 now']) {
      const chat = setup();
      const refused = await problem(ask(chat, { question }));
      expect([refused.getStatus(), refused.code]).toEqual([400, 'INVALID_QUESTION']);
      expect(chat.authorizeOwnSession).not.toHaveBeenCalled();
    }
    await expect(ask(setup(), { question: 'First line\nsecond line\twith a tab' })).resolves.toMatchObject({
      status: 'answered' });
  });

  it('settles the lease with the known usage and audits the failure when the answer cannot be saved, answering 503', async () => {
    const chat = setup({ insertError: { code: '22021' } });
    const refused = await problem(ask(chat));
    expect([refused.getStatus(), refused.code]).toEqual([503, 'RECORD_CHAT_UNAVAILABLE']);
    expect(chat.events.slice(chat.events.indexOf('rollback:2'))).toEqual(['rollback:2', 'begin:3', 'settle:failed',
      'audit:ehr.record-chat.answer', 'commit:3']);
    const settled = chat.query.mock.calls.filter(([sql]) => /ehr\.settle_record_chat/.test(String(sql))).at(-1)![1];
    expect(settled).toEqual([RESERVATION, 1500, 120, 300, 0, 'failed']);
    expect(chat.recordWithClient).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      action: 'ehr.record-chat.answer', outcome: 'failure', details: expect.objectContaining({ reason: 'save_failed',
        inputTokens: 1500, processor: 'anthropic' }) }));
  });

  it('says chat is unavailable when the flag or the control is off, and what it is otherwise, without Identity', async () => {
    await expect(setup({ config: { ...enabled, patientEnabled: false } }).service.availability()).resolves.toEqual({ available: false });
    await expect(setup({ control: false }).service.availability()).resolves.toEqual({ available: false });
    await expect(setup({ control: new Error('down') }).service.availability()).resolves.toEqual({ available: false });
    const chat = setup({ categories: ['vitals', 'diagnoses'] });
    await expect(chat.service.availability()).resolves.toEqual({ available: true, processor: 'anthropic', inferenceGeo: 'us',
      noticeVersion: 'notice-1', historyLimit: HISTORY_LIMIT, maxQuestionLength: 1000,
      released: ['encounters', 'notes', 'vitals', 'diagnoses'] });
    expect(chat.authorizeOwnSession).not.toHaveBeenCalled();
  });
});
