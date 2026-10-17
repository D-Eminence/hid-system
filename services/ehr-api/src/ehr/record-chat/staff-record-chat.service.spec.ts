import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AuditService } from '../../audit/audit.service';
import { requestDigest } from '../../common/idempotency';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import type { DatabaseService } from '../../database/database.service';
import type { ClinicalRepository, SemanticEvent } from '../shared/clinical.repository';
import { RecordChatProcessorError, type ProcessorResult, type RecordChatProcessor } from './claude-record-chat.client';
import { releasedBindings } from './evidence-extract';
import { HISTORY_LIMIT, PRIOR_TURNS } from './patient-record-chat.service';
import { ANSWER_DETAIL_KEYS, DISCLOSURE_DETAIL_KEYS, HISTORY_DETAIL_KEYS } from './record-chat-audit';
import type { RecordChatConfig } from './record-chat.config';
import { readStaffEvidence } from './staff-evidence';
import { STAFF_FIXED_REPLIES, StaffRecordChatService } from './staff-record-chat.service';
import { STAFF_SYSTEM_PROMPT } from './system-prompt';

// A placeholder that is clearly not a real model id.
const MODEL = 'synthetic-test-model';
const QUESTION = 'What was the last blood pressure reading?';
const NOTE_TEXT = 'Synthetic note: blood pressure stable at 118 over 76.';
const ANSWER_TEXT = 'The last blood pressure was 118 over 76.';
const KEY = 'staff-chat-key-00000000001';
const PATIENT = '5c4b7c00-0000-4000-8000-000000000001';
const FACILITY = '5c4b7c00-0000-4000-8000-0000000000fa';
const MEMBERSHIP = '5c4b7c00-0000-4000-8000-0000000000ab';
const ENCOUNTER = '5c4b7c00-0000-4000-8000-0000000000e1';
const NOTE = '5c4b7c00-0000-4000-8000-0000000000a1';
const VITAL = '5c4b7c00-0000-4000-8000-0000000000b1';
const RESERVATION = '5c4b7c00-0000-4000-8000-0000000000f1';
const CONVERSATION = '5c4b7c00-0000-4000-8000-0000000000c1';
const ALL_READS = ['ehr.record-chat.use', 'ehr.encounter.read', 'ehr.note.read', 'ehr.vital.read', 'ehr.diagnosis.read',
  'ehr.prescription.read', 'ehr.document.read'];

const enabled: RecordChatConfig = {
  patientEnabled: false, staffEnabled: true, modelId: MODEL, apiKey: 'synthetic-api-key-0123456789abcdef',
  baseUrl: 'https://api.anthropic.com', inferenceGeo: 'us', maxOutputTokens: 4096, deadlineMs: 25_000, maxRetries: 0,
  maxEvidenceChars: 40_000, dailyTokenBudget: 2_000_000, noticeVersion: 'notice-1', auditDigestKey: Buffer.alloc(32, 9),
};

const contextFor = (permissions: readonly string[]): DataAccessContext => ({
  correlationId: 'staff-record-chat-test', facilityId: FACILITY, membershipId: MEMBERSHIP, purposeOfUse: 'direct-care',
  actor: { kind: 'staff', id: 'actor-1', subject: 'subject-1', accountId: 'account-1', roles: ['doctor'], permissions,
    facilityIds: [FACILITY], facilities: [], authenticationMethod: 'local',
    facility: { id: FACILITY, membershipId: MEMBERSHIP, organizationId: 'organization-1', name: 'Facility', roles: ['doctor'],
      permissions, isPrimary: true } },
});
const requestFor = (permissions: readonly string[] = ALL_READS, purpose: string | undefined = 'direct-care') => {
  const context = contextFor(permissions);
  return { actor: context.actor, facilityId: FACILITY, correlationId: context.correlationId,
    header: (name: string) => (name === 'x-purpose-of-use' ? purpose : undefined) } as unknown as HidRequest;
};

const answerJson = (references = [2]) => JSON.stringify({ status: 'answered', blocks: [
  { kind: 'record', text: ANSWER_TEXT, references }] });
const usage = { inputTokens: 1500, outputTokens: 120, cacheReadTokens: 300, cacheWriteTokens: 0, servedGeo: 'us' };
const answered = (text = answerJson()): ProcessorResult => ({ kind: 'answer', text, stopReason: 'end_turn',
  processorMessageId: 'msg_synthetic_1', usage });

interface Options {
  config?: RecordChatConfig;
  permissions?: readonly string[];
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
  const statements: string[] = [];
  let evidenceReads = 0;
  const vital = { id: VITAL, encounterId: ENCOUNTER, facilityId: FACILITY, recordedAt: new Date('2026-09-30T09:00:00Z'),
    heightCm: null, weightKg: null, temperatureC: null, pulseBpm: 64, respiratoryRate: null, systolicMmhg: 118,
    diastolicMmhg: 76, oxygenSaturationPercent: null, source: 'manual' };
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    const text = sql.replace(/\s+/g, ' ');
    statements.push(text);
    if (/from ehr\.encounters e where/.test(text)) {
      evidenceReads += 1;
      events.push('read');
      return { rows: options.noRecords ? [] : [{ id: ENCOUNTER, facilityId: FACILITY, encounterType: 'ambulatory',
        status: 'completed', startedAt: new Date('2026-09-30T08:00:00Z'), endedAt: new Date('2026-09-30T10:00:00Z') }] };
    }
    if (/from ehr\.clinical_notes/.test(text)) {
      return { rows: options.noRecords ? [] : [{ id: NOTE, encounterId: ENCOUNTER, facilityId: FACILITY,
        noteType: 'progress', title: 'Follow-up', status: 'signed', revisionNo: 1, content: NOTE_TEXT,
        signedAt: new Date('2026-09-30T10:05:00Z') }] };
    }
    if (/from ehr\.vitals/.test(text)) {
      return { rows: evidenceReads > 1 && options.vitalsOnSecondRead ? options.vitalsOnSecondRead : [vital] };
    }
    if (/from ehr\.(diagnoses|prescriptions|documents_effective)/.test(text)) return { rows: [] };
    if (/from ehr\.staff_record_chat_messages where patient_id=\$1 and facility_id=\$2 and account_id=\$3 and idempotency_key=\$4/.test(text)) {
      events.push('replay-check');
      return { rows: options.stored ? [options.stored] : [] };
    }
    if (/select count\(\*\)::text as count from ehr\.staff_record_chat_messages/.test(text)) {
      return { rows: [{ count: String(options.storedCount ?? 0) }] };
    }
    if (/reply->>'answer' as answer/.test(text)) return { rows: options.prior ?? [] };
    if (/ehr\.staff_record_chat_history_on_hold/.test(text)) {
      events.push('hold-check');
      return { rows: [{ held: options.hold ?? false }] };
    }
    if (/with deleted_messages as \(delete from ehr\.staff_record_chat_messages/.test(text)) {
      events.push('delete');
      return { rows: [{ count: options.holdDuringDelete ? '0' : String(options.storedCount ?? 0),
        existing: 1, deleted: options.holdDuringDelete ? 0 : 1 }] };
    }
    if (/insert into ehr\.staff_record_chat_conversations/.test(text)) {
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
    if (/insert into ehr\.staff_record_chat_messages/.test(text)) {
      events.push('insert');
      if (options.insertError) throw Object.assign(new Error('fk'), options.insertError);
      return { rows: [{ createdAt: new Date('2026-10-16T12:00:00Z') }] };
    }
    if (/select id from ehr\.staff_record_chat_conversations/.test(text)) {
      return { rows: options.history ? [{ id: CONVERSATION }] : [] };
    }
    if (/from ehr\.staff_record_chat_messages where patient_id=\$1 and facility_id=\$2 and account_id=\$3 order by/.test(text)) {
      return { rows: options.history ?? [] };
    }
    throw new Error(`unexpected statement: ${text}`);
  });
  const client = { query } as unknown as PoolClient;
  let authorizations = 0;
  const runEvents: SemanticEvent[] = [];
  // ClinicalRepository.run: Identity's decision, then the operation in one transaction.
  const run = jest.fn(async (_context: DataAccessContext, patientId: string, access: string, event: SemanticEvent,
    operation: (c: PoolClient) => Promise<{ value: unknown }>) => {
    authorizations += 1;
    events.push(`authorize:${authorizations}`);
    runEvents.push(event);
    expect([patientId, access]).toEqual([PATIENT, 'read_records']);
    if (authorizations > 1 && options.secondAuthorization) throw options.secondAuthorization;
    events.push(`begin:${authorizations}`);
    try {
      const result = await operation(client);
      events.push(`commit:${authorizations}`);
      return result.value;
    } catch (error) {
      events.push(`rollback:${authorizations}`);
      throw error;
    }
  });
  const withTransaction = jest.fn(async (_context: unknown, work: (c: PoolClient) => Promise<unknown>) => {
    events.push('fallback:begin');
    const value = await work(client);
    events.push('fallback:commit');
    return value;
  });
  const databaseQuery = jest.fn(async () => {
    events.push('control');
    if (options.control instanceof Error) throw options.control;
    return { rows: [{ enabled: options.control ?? true }] };
  });
  const recordedAudits: Array<Record<string, unknown>> = [];
  const recordWithClient = jest.fn(async (_client: unknown, event: Record<string, unknown>) => {
    recordedAudits.push(event);
    events.push(`audit:${String(event.action)}`);
    if (options.auditFails && event.action === 'ehr.record-chat.disclosure') throw new Error('audit unavailable');
  });
  const record = jest.fn(async (event: Record<string, unknown>) => {
    recordedAudits.push(event);
    events.push(`audit-pool:${String(event.action)}:${String(event.outcome)}`);
  });
  const processor: RecordChatProcessor = {
    processor: 'anthropic',
    ensureReady: jest.fn(async () => { events.push('ready'); }),
    ask: jest.fn(async () => {
      events.push('ask');
      if (options.result instanceof Error) throw options.result;
      return options.result ?? answered();
    }),
  };
  const service = new StaffRecordChatService(
    { withTransaction, query: databaseQuery } as unknown as DatabaseService,
    { recordWithClient, record } as unknown as AuditService,
    { run } as unknown as ClinicalRepository, options.config ?? enabled, processor);
  const request = requestFor(options.permissions ?? ALL_READS);
  return { service, events, statements, query, processor, run, runEvents, recordWithClient, record, recordedAudits,
    withTransaction, databaseQuery, request };
}

/** The hash the staff evidence gives the fixture vital now, as a stored binding records it. */
async function currentVitalHash(): Promise<string> {
  const probe = setup();
  const visible = releasedBindings(await readStaffEvidence({ query: probe.query } as unknown as PoolClient, PATIENT, FACILITY,
    ALL_READS));
  return visible.get(`vital:${VITAL}`)!;
}

/** key null sends no Idempotency-Key header. */
const ask = (chat: ReturnType<typeof setup>, body: Record<string, unknown> = {}, key: string | null = KEY) =>
  chat.service.ask(chat.request, PATIENT, { question: QUESTION, noticeVersion: 'notice-1', ...body } as never, key ?? undefined);

async function problem(promise: Promise<unknown>): Promise<DomainProblem> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainProblem) return error;
    throw error;
  }
  throw new Error('expected a DomainProblem');
}

describe('StaffRecordChatService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('answers 503 RECORD_CHAT_DISABLED with the staff flag off (the patient flag does not turn it on), calling nothing', async () => {
    const chat = setup({ config: { ...enabled, staffEnabled: false, patientEnabled: true } });
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

  it('requires direct care, the current notice, a question of 1 to 1000 characters and an Idempotency-Key', async () => {
    const other = setup();
    const purpose = await problem(other.service.ask(requestFor(ALL_READS, 'emergency'), PATIENT,
      { question: QUESTION, noticeVersion: 'notice-1' } as never, KEY));
    expect([purpose.getStatus(), purpose.code]).toEqual([400, 'PURPOSE_OF_USE_REQUIRED']);
    expect(other.run).not.toHaveBeenCalled();
    const notice = await problem(ask(setup(), { noticeVersion: 'notice-0' }));
    expect([notice.getStatus(), notice.code]).toEqual([428, 'CHAT_NOTICE_REQUIRED']);
    const long = await problem(ask(setup(), { question: 'q'.repeat(1001) }));
    expect([long.getStatus(), long.code]).toEqual([400, 'INVALID_QUESTION']);
    expect((await problem(ask(setup(), { question: '   ' }))).code).toBe('INVALID_QUESTION');
    expect((await problem(ask(setup(), { question: 'a\u0000b' }))).code).toBe('INVALID_QUESTION');
    const keyless = setup();
    const missing = await problem(ask(keyless, {}, null));
    expect([missing.getStatus(), missing.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
    expect(keyless.run).not.toHaveBeenCalled();
  });

  it('is asked for direct care, never break-glass, with a distinct audit action for each transaction', async () => {
    const chat = setup();
    await ask(chat);
    expect(chat.runEvents).toEqual([
      { resourceType: 'staff-record-chat', excludeBreakGlass: { code: 'BREAK_GLASS_EXCLUDED' }, action: 'ehr.record-chat.staff.read' },
      { resourceType: 'staff-record-chat', excludeBreakGlass: { code: 'BREAK_GLASS_EXCLUDED' }, action: 'ehr.record-chat.staff.save' },
    ]);
  });

  it('authorizes, reads, reserves and audits the disclosure before the one call, then authorizes again and saves', async () => {
    const chat = setup();
    const reply = await ask(chat);
    expect(chat.events).toEqual(['control', 'authorize:1', 'begin:1', 'replay-check', 'read', 'conversation', 'reserve',
      'audit:ehr.record-chat.disclosure', 'commit:1', 'ready', 'ask', 'authorize:2', 'begin:2', 'read', 'savepoint', 'insert',
      'release', 'settle:answered', 'audit:ehr.record-chat.answer', 'commit:2']);
    expect(reply).toMatchObject({ status: 'answered', answer: ANSWER_TEXT, processor: 'anthropic', conversationId: CONVERSATION,
      idempotentReplay: false, blocks: [{ kind: 'record', text: ANSWER_TEXT, references: [2] }],
      sources: [{ number: 2, kind: 'note', id: NOTE, title: 'Follow-up' }] });
    expect(JSON.stringify(reply)).not.toMatch(/facility|patientId|account/i);
    expect(chat.processor.ask).toHaveBeenCalledTimes(1);
  });

  it('sends the staff prompt and an extract naming the staff audience, with the clinician\'s facility as an ordinal', async () => {
    const chat = setup();
    await ask(chat);
    const [input] = (chat.processor.ask as jest.Mock).mock.calls[0] as [{ systemPrompt: string; userBlocks: string[] }];
    expect(input.systemPrompt).toBe(STAFF_SYSTEM_PROMPT);
    const sent = input.userBlocks.join('\n');
    expect(JSON.parse(input.userBlocks[0]!).extract.audience).toBe('staff');
    expect(sent).toContain('"facility":"F1"');
    expect(sent).toContain(NOTE_TEXT);
    for (const id of [PATIENT, FACILITY, MEMBERSHIP, ENCOUNTER, NOTE, VITAL, 'account-1', 'subject-1']) expect(sent).not.toContain(id);
  });

  it('reads only this patient at this facility, and only the categories the member\'s permissions allow', async () => {
    const chat = setup({ permissions: ['ehr.record-chat.use', 'ehr.encounter.read', 'ehr.note.read'] });
    await ask(chat);
    const reads = chat.statements.filter((text) => /from ehr\.(encounters|clinical_notes|vitals|diagnoses|prescriptions|documents_effective)/.test(text));
    expect(reads.length).toBeGreaterThan(0);
    for (const text of reads) {
      expect(text).toContain('.patient_id=$1 and');
      expect(text).toContain('.facility_id=$2');
    }
    expect(chat.statements.some((text) => /from ehr\.vitals|from ehr\.diagnoses|from ehr\.prescriptions|from ehr\.documents_effective/.test(text)))
      .toBe(false);
    const [input] = (chat.processor.ask as jest.Mock).mock.calls[0] as [{ userBlocks: string[] }];
    const coverage = JSON.parse(input.userBlocks[0]!).extract.coverage;
    expect(coverage.released).toEqual(['encounters', 'notes']);
    expect(coverage.withheld).toEqual(['vitals', 'diagnoses', 'prescriptions', 'documents', 'labRequests', 'labResults']);
    expect(coverage.complete).toBe(true);
  });

  it('never reads imported history, Lab or another facility\'s records, and never a diagnosis note or file name', async () => {
    const chat = setup();
    await ask(chat);
    const sql = chat.statements.join('\n');
    expect(sql).not.toMatch(/imported_|lab\.|lab_requests|patient_released_lab_results/);
    expect(sql).not.toMatch(/\bd\.notes\b|\bnotes as/);
    const [input] = (chat.processor.ask as jest.Mock).mock.calls[0] as [{ userBlocks: string[] }];
    expect(input.userBlocks.join('')).not.toContain('fileName');
  });

  it('audits the disclosure before the call as the staff audience, holding no question, answer or record text', async () => {
    const chat = setup();
    await ask(chat);
    const disclosure = chat.recordedAudits.find((event) => event.action === 'ehr.record-chat.disclosure')!;
    expect(disclosure).toMatchObject({ actorType: 'staff', actorSubject: 'subject-1', actorAccountId: 'account-1',
      actorMembershipId: MEMBERSHIP, organizationId: 'organization-1', facilityId: FACILITY, patientId: PATIENT,
      purposeOfUse: 'direct-care', resourceType: 'staff-record-chat', outcome: 'success' });
    expect(Object.keys(disclosure.details as object).every((key) => (DISCLOSURE_DETAIL_KEYS as readonly string[]).includes(key))).toBe(true);
    expect(disclosure.details).toMatchObject({ audience: 'staff', processor: 'anthropic', model: MODEL, noticeVersion: 'notice-1' });
    const answer = chat.recordedAudits.find((event) => event.action === 'ehr.record-chat.answer')!;
    expect(Object.keys(answer.details as object).every((key) => (ANSWER_DETAIL_KEYS as readonly string[]).includes(key))).toBe(true);
    const everything = JSON.stringify(chat.recordedAudits);
    for (const text of [QUESTION, ANSWER_TEXT, NOTE_TEXT]) expect(everything).not.toContain(text);
  });

  it('sends nothing when the disclosure audit row cannot be written', async () => {
    const chat = setup({ auditFails: true });
    await expect(ask(chat)).rejects.toThrow('audit unavailable');
    expect(chat.processor.ask).not.toHaveBeenCalled();
    expect(chat.events).toContain('rollback:1');
  });

  it('maps the limit commands\' refusals', async () => {
    const limited = await problem(ask(setup({ reserveError: { code: 'P4290', detail: '1800' } })));
    expect([limited.getStatus(), limited.code]).toEqual([429, 'RECORD_CHAT_RATE_LIMITED']);
    expect(limited.retryAfterSeconds).toBe(1800);
    const busy = await problem(ask(setup({ reserveError: { code: 'P4091' } })));
    expect([busy.getStatus(), busy.code]).toEqual([429, 'RECORD_CHAT_BUSY']);
    const budget = await problem(ask(setup({ reserveError: { code: 'P5030' } })));
    expect([budget.getStatus(), budget.code]).toEqual([503, 'RECORD_CHAT_BUDGET_EXHAUSTED']);
    const paused = await problem(ask(setup({ reserveError: { code: '55000', message: 'RECORD_CHAT_PAUSED' } })));
    expect([paused.getStatus(), paused.code]).toEqual([503, 'RECORD_CHAT_PAUSED']);
    const consent = await problem(ask(setup({ reserveError: { code: '42501' } })));
    expect([consent.getStatus(), consent.code]).toEqual([403, 'CONSENT_REQUIRED']);
    const refused = setup({ reserveError: { code: 'P4290', detail: '1800' } });
    await problem(ask(refused));
    expect(refused.processor.ask).not.toHaveBeenCalled();
  });

  it('answers a replay of the same key and question from the stored reply while its records are unchanged', async () => {
    const hash = await currentVitalHash();
    const stored = { id: 'message-1', conversationId: CONVERSATION, question: QUESTION, requestSha256:
      requestDigest('ehr.record-chat.staff.ask', { patientId: PATIENT, question: QUESTION, noticeVersion: 'notice-1' }),
    createdAt: new Date('2026-10-16T12:00:00Z'), sourceBindings: [{ kind: 'vital', id: VITAL, hash }],
    reply: { status: 'answered', answer: ANSWER_TEXT, blocks: [{ kind: 'record', text: ANSWER_TEXT, references: [1] }],
      sources: [{ number: 1, kind: 'vital', id: VITAL, recordedOn: '2026-09-30', effectiveOn: null, title: 'Vital signs' }],
      coverage: { complete: true, released: [], withheld: [], truncated: false, selectedCount: 1, recordCount: 1 } } };
    const chat = setup({ stored });
    const reply = await ask(chat);
    expect(reply).toMatchObject({ idempotentReplay: true, messageId: 'message-1', answer: ANSWER_TEXT });
    expect(chat.processor.ask).not.toHaveBeenCalled();
    expect(chat.events).not.toContain('reserve');
    expect(chat.recordedAudits.map((event) => event.action)).toEqual(['ehr.record-chat.replay']);
    const changed = await problem(ask(setup({ stored: { ...stored, sourceBindings: [{ kind: 'vital', id: VITAL, hash: 'stale' }] } })));
    expect([changed.getStatus(), changed.code]).toEqual([409, 'CHAT_SOURCES_CHANGED']);
    const reused = await problem(ask(setup({ stored }), { question: 'A different question' }));
    expect([reused.getStatus(), reused.code]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
  });

  it('refuses another question at the history limit, before any read, lease or call', async () => {
    const chat = setup({ storedCount: HISTORY_LIMIT });
    const refused = await problem(ask(chat));
    expect([refused.getStatus(), refused.code]).toEqual([409, 'CHAT_HISTORY_FULL']);
    expect(chat.events).not.toContain('reserve');
    expect(chat.processor.ask).not.toHaveBeenCalled();
  });

  it('sends only earlier exchanges whose records are still readable unchanged, the newest four', async () => {
    const hash = await currentVitalHash();
    const row = (n: number, hashValue: string) => ({ id: `prior-${n}`, question: `Earlier question ${n}`,
      answer: `Earlier answer ${n}`, sourceBindings: [{ kind: 'vital', id: VITAL, hash: hashValue }] });
    const prior = [row(1, hash), row(2, 'stale'), row(3, hash), row(4, hash), row(5, hash), row(6, hash), row(7, hash)];
    const chat = setup({ prior });
    await ask(chat);
    const [input] = (chat.processor.ask as jest.Mock).mock.calls[0] as [{ userBlocks: string[] }];
    const sent = JSON.parse(input.userBlocks[1]!).priorTurns as Array<{ question: string }>;
    expect(sent).toHaveLength(PRIOR_TURNS);
    expect(sent.map((turn) => turn.question)).toEqual(['Earlier question 5', 'Earlier question 4', 'Earlier question 3',
      'Earlier question 1']);
  });

  it('answers a fixed reply and sends nothing when the member may read no record of the patient here', async () => {
    const chat = setup({ noRecords: true, permissions: ['ehr.record-chat.use', 'ehr.encounter.read', 'ehr.note.read'] });
    const reply = await ask(chat);
    expect(reply).toMatchObject({ status: 'no_evidence', answer: STAFF_FIXED_REPLIES.noRecords, sources: [] });
    expect(chat.processor.ask).not.toHaveBeenCalled();
    expect(chat.events).toEqual(expect.arrayContaining(['reserve', 'insert', 'settle:no_evidence']));
    expect(chat.recordedAudits.map((event) => event.action)).toEqual(['ehr.record-chat.answer']);
  });

  it('stores a fixed text, never the model\'s, for a refusal or an answer that fails validation', async () => {
    const refusal = setup({ result: { kind: 'refusal', refusalCategory: 'other', stopReason: 'refusal',
      processorMessageId: 'msg_2', usage } as ProcessorResult });
    expect(await ask(refusal)).toMatchObject({ status: 'declined', answer: STAFF_FIXED_REPLIES.declined, sources: [] });
    const invalid = setup({ result: answered(answerJson([9])) });
    expect(await ask(invalid)).toMatchObject({ status: 'unverified', answer: STAFF_FIXED_REPLIES.unverified, sources: [] });
    expect(JSON.stringify(invalid.recordedAudits)).not.toContain(ANSWER_TEXT);
  });

  it('settles a failed call as failed, charges the estimate for a timeout and answers 503 RECORD_CHAT_UNAVAILABLE', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const chat = setup({ result: new RecordChatProcessorError('timeout') });
    const unavailable = await problem(ask(chat));
    expect([unavailable.getStatus(), unavailable.code]).toEqual([503, 'RECORD_CHAT_UNAVAILABLE']);
    expect(chat.events).toContain('settle:failed');
    expect(chat.events).not.toContain('insert');
    expect(chat.recordedAudits.at(-1)).toMatchObject({ action: 'ehr.record-chat.answer', outcome: 'failure' });
  });

  it('discards the answer when Identity\'s decision changes during the call: nothing stored, the lease left to expire', async () => {
    const chat = setup({ secondAuthorization: new DomainProblem(403, 'CONSENT_REQUIRED', 'Consent ended') });
    const refused = await problem(ask(chat));
    expect([refused.getStatus(), refused.code]).toEqual([403, 'CONSENT_REQUIRED']);
    expect(chat.events).not.toContain('insert');
    expect(chat.events).not.toContain('settle:answered');
    expect(chat.events).toContain('audit-pool:ehr.record-chat.answer:denied');
    expect(chat.withTransaction).not.toHaveBeenCalled();
  });

  it('refuses to store an answer when a record it cites changed during the call (409 CHAT_SOURCES_CHANGED)', async () => {
    // Reference 3 is the vital; the answer cites it, and the vital changes during the call.
    const chat = setup({ result: answered(answerJson([3])), vitalsOnSecondRead: [{ id: VITAL, encounterId: ENCOUNTER, facilityId: FACILITY,
      recordedAt: new Date('2026-09-30T09:00:00Z'), heightCm: null, weightKg: null, temperatureC: null, pulseBpm: 70,
      respiratoryRate: null, systolicMmhg: 150, diastolicMmhg: 90, oxygenSaturationPercent: null, source: 'manual' }] });
    const conflict = await problem(ask(chat));
    expect([conflict.getStatus(), conflict.code]).toEqual([409, 'CHAT_SOURCES_CHANGED']);
    expect(chat.events).toContain('settle:sources_changed');
    expect(chat.events).not.toContain('insert');
  });

  it('answers 409 CHAT_CONVERSATION_CHANGED when the history was cleared during the call', async () => {
    const chat = setup({ insertError: { code: '23503' } });
    const conflict = await problem(ask(chat));
    expect([conflict.getStatus(), conflict.code]).toEqual([409, 'CHAT_CONVERSATION_CHANGED']);
    expect(chat.events).toEqual(expect.arrayContaining(['rollback', 'settle:conversation_changed']));
  });

  it('settles the lease in a fallback transaction when the save fails, and answers 503', async () => {
    const chat = setup({ insertError: { code: '57014' } });
    const unavailable = await problem(ask(chat));
    expect([unavailable.getStatus(), unavailable.code]).toEqual([503, 'RECORD_CHAT_UNAVAILABLE']);
    expect(chat.withTransaction).toHaveBeenCalledTimes(1);
    expect(chat.events).toEqual(expect.arrayContaining(['rollback:2', 'fallback:begin', 'settle:failed', 'fallback:commit']));
    expect(chat.recordedAudits.at(-1)).toMatchObject({ action: 'ehr.record-chat.answer', outcome: 'failure',
      details: expect.objectContaining({ reason: 'save_failed' }) });
  });

  it('offers chat only with the flag on and the control on, naming what this member\'s permissions let it read', async () => {
    const chat = setup({ permissions: ['ehr.record-chat.use', 'ehr.note.read', 'ehr.encounter.read'] });
    expect(await chat.service.availability(chat.request)).toMatchObject({ available: true, processor: 'anthropic',
      inferenceGeo: 'us', noticeVersion: 'notice-1', historyLimit: HISTORY_LIMIT, maxQuestionLength: 1000,
      released: ['encounters', 'notes'], withheld: ['vitals', 'diagnoses', 'prescriptions', 'documents', 'labRequests', 'labResults'] });
    expect(await setup({ control: false }).service.availability(chat.request)).toEqual({ available: false });
    expect(await setup({ config: { ...enabled, staffEnabled: false } }).service.availability(chat.request)).toEqual({ available: false });
    expect(await setup({ control: new Error('down') }).service.availability(chat.request)).toEqual({ available: false });
  });

  it('reads the member\'s history, leaving out an exchange whose records changed, and audits counts only', async () => {
    const hash = await currentVitalHash();
    const reply = { status: 'answered', answer: ANSWER_TEXT, blocks: [{ kind: 'record', text: ANSWER_TEXT, references: [1] }],
      sources: [{ number: 1, kind: 'vital', id: VITAL, recordedOn: '2026-09-30', effectiveOn: null, title: 'Vital signs' }] };
    const chat = setup({ history: [
      { id: 'm-1', question: 'Q1', reply, sourceBindings: [{ kind: 'vital', id: VITAL, hash }], createdAt: new Date('2026-10-16T12:00:00Z') },
      { id: 'm-2', question: 'Q2', reply, sourceBindings: [{ kind: 'vital', id: VITAL, hash: 'stale' }], createdAt: new Date('2026-10-16T11:00:00Z') },
    ] });
    const history = await chat.service.history(chat.request, PATIENT) as { conversationId: string; exchanges: Array<{ messageId: string }>; limit: number };
    expect(history.conversationId).toBe(CONVERSATION);
    expect(history.exchanges.map((exchange) => exchange.messageId)).toEqual(['m-1']);
    expect(history.limit).toBe(HISTORY_LIMIT);
    expect(chat.runEvents[0]).toMatchObject({ action: 'ehr.record-chat.staff.history.read', excludeBreakGlass: { code: 'BREAK_GLASS_EXCLUDED' } });
    const empty = setup();
    expect(await empty.service.history(empty.request, PATIENT)).toEqual({ conversationId: null, exchanges: [], limit: HISTORY_LIMIT });
    expect(Object.keys(HISTORY_DETAIL_KEYS).length).toBeGreaterThan(0);
  });

  it('deletes the member\'s history, and answers 409 CHAT_HISTORY_ON_HOLD while a legal hold keeps it', async () => {
    const chat = setup({ storedCount: 3 });
    expect(await chat.service.clear(chat.request, PATIENT)).toEqual({ cleared: true, deletedCount: 3 });
    expect(chat.events).toEqual(['authorize:1', 'begin:1', 'hold-check', 'delete', 'commit:1']);
    const held = await problem(setup({ hold: true }).service.clear(setup({ hold: true }).request, PATIENT));
    expect([held.getStatus(), held.code]).toEqual([409, 'CHAT_HISTORY_ON_HOLD']);
    const race = setup({ holdDuringDelete: true });
    const raced = await problem(race.service.clear(race.request, PATIENT));
    expect([raced.getStatus(), raced.code]).toEqual([409, 'CHAT_HISTORY_ON_HOLD']);
    expect(race.events).toContain('rollback:1');
  });

  it('keeps the history routes available while chat is off (no flag or control read)', async () => {
    const chat = setup({ config: { ...enabled, staffEnabled: false }, control: false });
    await chat.service.history(chat.request, PATIENT);
    await chat.service.clear(chat.request, PATIENT);
    expect(chat.databaseQuery).not.toHaveBeenCalled();
  });
});
