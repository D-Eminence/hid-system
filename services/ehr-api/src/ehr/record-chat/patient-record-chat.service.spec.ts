import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AuditService } from '../../audit/audit.service';
import { DomainProblem } from '../../common/problem';
import type { HidRequest } from '../../common/request-context';
import type { DatabaseService } from '../../database/database.service';
import { PatientRecordRelease, type PatientReleasable } from '../patient-records/patient-release';
import type { PatientRecordsService } from '../patient-records/patient-records.service';
import { RecordChatProcessorError, type ProcessorResult, type RecordChatProcessor } from './claude-record-chat.client';
import { FIXED_REPLIES, HISTORY_LIMIT, PatientRecordChatService } from './patient-record-chat.service';
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
  patientEnabled: true, modelId: MODEL, apiKey: 'synthetic-api-key-0123456789abcdef', baseUrl: 'https://api.anthropic.com',
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
  categories?: PatientReleasable[];
  control?: boolean | Error;
  stored?: Record<string, unknown> | null;
  storedCount?: number;
  reserveError?: { code: string; detail?: string };
  auditFails?: boolean;
  insertError?: { code: string };
  result?: ProcessorResult | Error;
  secondAuthorization?: Error;
  vitalsOnSecondRead?: Record<string, unknown>[];
  noRecords?: boolean;
  history?: Record<string, unknown>[];
}

function setup(options: Options = {}) {
  const events: string[] = [];
  const violations: string[] = [];
  let inRelease = false;
  let releaseReads = 0;
  const vital = { id: VITAL, encounterId: ENCOUNTER, facilityId: 'facility-1', recordedAt: new Date('2026-09-30T09:00:00Z'),
    heightCm: null, weightKg: null, temperatureC: null, pulseBpm: 64, respiratoryRate: null, systolicMmhg: 118,
    diastolicMmhg: 76, oxygenSaturationPercent: null, source: 'manual' };
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    const text = sql.replace(/\s+/g, ' ');
    if (CLINICAL.test(text) && !inRelease) violations.push(text);
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
    if (/reply->>'answer' as answer/.test(text)) return { rows: [] };
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
  return { service, events, violations, query, processor, authorizeOwnSession, recordWithClient, record,
    withPatientTransaction, databaseQuery, release };
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
    const chat = setup({ config: { ...enabled, patientEnabled: false }, history: [
      { id: 'message-2', question: QUESTION, reply, sourceBindings: [{ kind: 'vital', id: VITAL, hash: 'h' }],
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

  it('deletes the whole history on request, while chat is off too', async () => {
    const chat = setup({ config: { ...enabled, patientEnabled: false }, storedCount: 3 });
    await expect(chat.service.clear(request)).resolves.toEqual({ cleared: true, deletedCount: 3 });
    expect(chat.events).toEqual(['authorize:1', 'begin:1', 'delete', 'audit:ehr.record-chat.history.clear', 'commit:1']);
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
