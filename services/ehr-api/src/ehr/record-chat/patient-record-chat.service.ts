import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../../audit/audit.service';
import { requestDigest, requireIdempotencyKey } from '../../common/idempotency';
import { DomainProblem } from '../../common/problem';
import type { HidRequest } from '../../common/request-context';
import { DatabaseService } from '../../database/database.service';
import { PATIENT_ALWAYS_RELEASED, PATIENT_RELEASABLE, PatientRecordRelease } from '../patient-records/patient-release';
import { PatientRecordsService } from '../patient-records/patient-records.service';
import { joinBlocks, validateAnswer, type AnswerBlock } from './answer-validator';
import {
  RECORD_CHAT_PROCESSOR, RecordChatProcessorError, processorFailure, type ProcessorResult, type RecordChatProcessor,
} from './claude-record-chat.client';
import {
  EXTRACT_LIMITS, bindingKey, buildPatientExtract, releasedBindings, userTurnBlocks, type ChatCoverage, type ChatSource,
  type PatientExtract, type PriorTurn, type SourceBinding,
} from './evidence-extract';
import {
  ANSWER_DETAIL_KEYS, DISCLOSURE_DETAIL_KEYS, HISTORY_DETAIL_KEYS, auditDetails, disclosureDigest,
} from './record-chat-audit';
import { RECORD_CHAT_CONFIG, enabledRecordChatConfig, type EnabledRecordChatConfig, type RecordChatConfig } from './record-chat.config';
import { PATIENT_SYSTEM_PROMPT } from './system-prompt';

/**
 * Patient record chat (owner decision 1 of 2026-10-16; POST /ehr/me/chat and
 * the patient's own history). The order of one question:
 * 1. The deploy flag (503 RECORD_CHAT_DISABLED, nothing read), the platform
 *    kill switch record_chat_enabled (503 RECORD_CHAT_PAUSED), the notice
 *    version (428), the Idempotency-Key and a process-local cap of four
 *    calls in flight.
 * 2. Identity's patient-self authorization of this request's own session.
 * 3. One patient-self transaction: an idempotent replay answers the stored
 *    reply; otherwise the history cap, the released records
 *    (PatientRecordRelease.read, the only evidence source), the extract, the
 *    lease and quotas (ehr.reserve_record_chat) and the disclosure audit row
 *    naming the processor commit together. Any failure there means no call.
 * 4. One Messages API request.
 * 5. Identity's authorization again: a change discards the answer.
 * 6. A second patient-self transaction: the answer is validated, the cited
 *    records are read again from the release (409 CHAT_SOURCES_CHANGED when
 *    one changed or is gone), the exchange is stored (409
 *    CHAT_CONVERSATION_CHANGED when the history was cleared meanwhile), the
 *    lease is settled with the processor's usage and the answer audit row is
 *    written.
 * The history stays readable and deletable while chat is off.
 */
export const HISTORY_LIMIT = 50;
export const PRIOR_TURNS = 4;
export const MAX_QUESTION_LENGTH = 1000;
const MAX_CONCURRENT_CALLS = 4;
const BUSY_RETRY_SECONDS = 5;

export const FIXED_REPLIES = {
  declined: 'This question could not be answered here. For questions about your health, please contact your care team.',
  unverified: 'An answer could not be checked against your records, so it is not shown. Please try asking in another '
    + 'way, or contact your care team.',
  noRecords: 'Your released records do not hold information to answer this question yet.',
} as const;

type ReplyStatus = 'answered' | 'no_evidence' | 'declined' | 'unverified';

export interface StoredReply {
  status: ReplyStatus;
  answer: string;
  blocks: AnswerBlock[];
  sources: ChatSource[];
  coverage: ChatCoverage;
}

export interface ChatAnswer extends StoredReply {
  conversationId: string;
  messageId: string;
  processor: 'anthropic';
  createdAt: string;
  idempotentReplay: boolean;
}

interface Prepared {
  conversationId: string;
  messageId: string;
  reservationId: string;
  extract: PatientExtract;
  priorMessageIds: string[];
  userBlocks: string[];
}

interface MessageRow extends QueryResultRow {
  id: string;
  conversationId: string;
  question: string;
  reply: StoredReply;
  sourceBindings: SourceBinding[];
  requestSha256: string;
  createdAt: Date;
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function databaseCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

@Injectable()
export class PatientRecordChatService {
  private inFlight = 0;

  constructor(private readonly database: DatabaseService, private readonly audit: AuditService,
    private readonly records: PatientRecordsService, private readonly release: PatientRecordRelease,
    @Inject(RECORD_CHAT_CONFIG) private readonly config: RecordChatConfig,
    @Inject(RECORD_CHAT_PROCESSOR) private readonly processor: RecordChatProcessor) {}

  /** Whether chat is offered now; no Identity, model or audit call. */
  async availability() {
    if (!this.config.patientEnabled || !(await this.controlEnabled().catch(() => false))) return { available: false };
    const config = enabledRecordChatConfig(this.config);
    return {
      available: true, processor: this.processor.processor, inferenceGeo: config.inferenceGeo,
      noticeVersion: config.noticeVersion, historyLimit: HISTORY_LIMIT, maxQuestionLength: MAX_QUESTION_LENGTH,
      released: [...PATIENT_ALWAYS_RELEASED, ...PATIENT_RELEASABLE.filter((category) => this.release.releases(category))],
    };
  }

  async ask(request: HidRequest, body: { question: string; noticeVersion: string },
    idempotencyHeader: string | undefined): Promise<ChatAnswer> {
    if (!this.config.patientEnabled) {
      throw new DomainProblem(503, 'RECORD_CHAT_DISABLED', 'Record chat is not available');
    }
    await this.requireControl();
    const config = enabledRecordChatConfig(this.config);
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question || question.length > MAX_QUESTION_LENGTH) {
      throw new DomainProblem(400, 'INVALID_QUESTION', 'The question must hold 1 to 1000 characters');
    }
    if (body.noticeVersion !== config.noticeVersion) {
      throw new DomainProblem(428, 'CHAT_NOTICE_REQUIRED', 'The current record chat notice must be acknowledged');
    }
    const idempotencyKey = requireIdempotencyKey(idempotencyHeader);
    const requestSha256 = requestDigest('ehr.record-chat.ask', { question, noticeVersion: body.noticeVersion });
    if (this.inFlight >= MAX_CONCURRENT_CALLS) {
      throw new DomainProblem(429, 'RECORD_CHAT_BUSY', 'Record chat is busy; try again shortly', undefined, undefined,
        BUSY_RETRY_SECONDS);
    }
    this.inFlight += 1;
    try {
      return await this.answer(request, config, question, idempotencyKey, requestSha256);
    } finally {
      this.inFlight -= 1;
    }
  }

  private async answer(request: HidRequest, config: EnabledRecordChatConfig, question: string, idempotencyKey: string,
    requestSha256: string): Promise<ChatAnswer> {
    const { actor, authorization } = await this.records.authorizeOwnSession(request);
    const patientId = authorization.patientId;
    const auditBase = {
      correlationId: request.correlationId, actorType: 'patient' as const, actorSubject: actor.subject,
      actorAccountId: actor.accountId, patientId, resourceType: 'patient-record-chat', purposeOfUse: 'patient-self',
    };

    const first = await this.database.withPatientTransaction(authorization, request.correlationId, async (client) => {
      const replay = await this.storedByKey(client, patientId, idempotencyKey);
      if (replay) {
        if (replay.requestSha256 !== requestSha256) {
          throw new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used for another question');
        }
        // A stored answer is shown again only while every record it cites is still released.
        if (replay.sourceBindings.length > 0) {
          const visible = releasedBindings(await this.release.read(client, patientId));
          if (replay.sourceBindings.some((binding) => !visible.has(bindingKey(binding)))) {
            throw new DomainProblem(409, 'CHAT_SOURCES_CHANGED', 'A record this answer cites is no longer available');
          }
        }
        await this.audit.recordWithClient(client, { ...auditBase, action: 'ehr.record-chat.replay', outcome: 'success',
          resourceId: replay.id, details: {} });
        return { replay };
      }
      const stored = await client.query<{ count: string }>(
        'select count(*)::text as count from ehr.patient_chat_messages where patient_id=$1', [patientId]);
      if (Number(stored.rows[0]?.count ?? 0) >= HISTORY_LIMIT) {
        throw new DomainProblem(409, 'CHAT_HISTORY_FULL',
          'The record chat history is full; delete it to ask another question');
      }
      const released = await this.release.read(client, patientId);
      const extract = buildPatientExtract(released, question, { ...EXTRACT_LIMITS, maxTotalChars: config.maxEvidenceChars });
      const prior = await client.query<{ id: string; question: string; answer: string }>(
        `select id, question, reply->>'answer' as answer from ehr.patient_chat_messages
          where patient_id=$1 order by created_at desc, id desc limit ${PRIOR_TURNS}`, [patientId]);
      const priorTurns: PriorTurn[] = [...prior.rows].reverse().map((row) => ({ question: row.question, answer: row.answer }));
      const conversationId = await this.conversation(client, patientId);
      const messageId = randomUUID();
      const userBlocks = userTurnBlocks(extract, priorTurns, question);
      const estimatedInput = Math.ceil((PATIENT_SYSTEM_PROMPT.length + userBlocks.join('').length) / 3);
      const reservedTokens = Math.min(1_000_000, estimatedInput + config.maxOutputTokens);
      const reservationId = await this.reserve(client, patientId, reservedTokens, config.dailyTokenBudget);
      if (extract.sources.length === 0) {
        // Nothing released to answer from: a fixed reply, and nothing is sent.
        const reply: StoredReply = { status: 'no_evidence', answer: FIXED_REPLIES.noRecords, blocks: [
          { kind: 'explanation', text: FIXED_REPLIES.noRecords, references: [] }], sources: [], coverage: extract.coverage };
        const createdAt = await this.insertMessage(client, { messageId, conversationId, patientId, idempotencyKey,
          requestSha256, question, reply, bindings: [] });
        await this.settle(client, reservationId, null, 'no_evidence');
        await this.audit.recordWithClient(client, { ...auditBase, action: 'ehr.record-chat.answer', outcome: 'success',
          resourceId: messageId, details: auditDetails(ANSWER_DETAIL_KEYS, { status: 'no_evidence',
            reason: 'no_released_records', citedSourceCount: 0 }) });
        return { answered: { ...reply, conversationId, messageId, processor: this.processor.processor,
          createdAt: createdAt.toISOString(), idempotentReplay: false } satisfies ChatAnswer };
      }
      // Committed with the lease before any call: no row, no disclosure.
      await this.audit.recordWithClient(client, { ...auditBase, action: 'ehr.record-chat.disclosure', outcome: 'success',
        resourceId: messageId, details: auditDetails(DISCLOSURE_DETAIL_KEYS, {
          processor: this.processor.processor, model: config.modelId, inferenceGeo: config.inferenceGeo,
          audience: 'patient', sourceCount: extract.sources.length, sourceCounts: extract.sourceCounts,
          priorExchangeCount: priorTurns.length, withheldCategories: extract.coverage.withheld,
          truncated: extract.coverage.truncated, noticeVersion: config.noticeVersion, reservedTokens,
          maxOutputTokens: config.maxOutputTokens,
          disclosureDigest: disclosureDigest(config.auditDigestKey, { messageId, model: config.modelId,
            inferenceGeo: config.inferenceGeo, bindings: extract.bindings, questionSha256: sha256(question),
            priorMessageIds: prior.rows.map((row) => row.id) }),
        }) });
      return { prepared: { conversationId, messageId, reservationId, extract, priorMessageIds: prior.rows.map((row) => row.id),
        userBlocks } satisfies Prepared };
    });
    if ('replay' in first && first.replay) return this.replayed(first.replay);
    if ('answered' in first && first.answered) return first.answered;
    const prepared = (first as { prepared: Prepared }).prepared;

    // One request to the processor.
    const started = Date.now();
    const deadlineAt = started + config.deadlineMs;
    let result: ProcessorResult | undefined;
    let failure: RecordChatProcessorError | undefined;
    try {
      await this.processor.ensureReady(deadlineAt);
      result = await this.processor.ask({ systemPrompt: PATIENT_SYSTEM_PROMPT, userBlocks: prepared.userBlocks }, deadlineAt);
    } catch (error) {
      failure = processorFailure(error);
    }
    const durationMs = Date.now() - started;
    const answerBase = { ...auditBase, action: 'ehr.record-chat.answer', resourceId: prepared.messageId };
    const usageDetails = result ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens, cacheWriteTokens: result.usage.cacheWriteTokens,
      servedGeo: result.usage.servedGeo, processorMessageId: result.processorMessageId, stopReason: result.stopReason } : {};

    // Identity's authorization again, after the call: a change discards the answer.
    let second;
    try {
      second = await this.records.authorizeOwnSession(request);
    } catch (error) {
      await this.audit.record({ ...answerBase, outcome: error instanceof DomainProblem && error.getStatus() < 500
        ? 'denied' : 'failure', details: auditDetails(ANSWER_DETAIL_KEYS, { processor: this.processor.processor,
        model: config.modelId, reason: 'authorization_changed', durationMs, ...usageDetails }) });
      throw error;
    }

    const outcome = await this.database.withPatientTransaction(second.authorization, request.correlationId,
      async (client) => {
        if (failure || !result) {
          await this.settle(client, prepared.reservationId, null, 'failed',
            failure && ['timeout', 'output_too_large', 'processor_error'].includes(failure.reason)
              ? (await this.reservedTokens(prepared)) : 0);
          await this.audit.recordWithClient(client, { ...answerBase, outcome: 'failure', details: auditDetails(
            ANSWER_DETAIL_KEYS, { processor: this.processor.processor, model: config.modelId,
              reason: failure?.reason ?? 'processor_error', durationMs }) });
          return { kind: 'failed' as const };
        }
        const { reply, reason, citationsValid, bindings } = this.reply(result, prepared.extract);
        if (bindings.length > 0) {
          const current = releasedBindings(await this.release.read(client, patientId));
          if (bindings.some((binding) => current.get(bindingKey(binding)) !== binding.hash)) {
            await this.settle(client, prepared.reservationId, result, 'sources_changed');
            await this.audit.recordWithClient(client, { ...answerBase, outcome: 'denied', details: auditDetails(
              ANSWER_DETAIL_KEYS, { processor: this.processor.processor, model: config.modelId, status: reply.status,
                reason: 'sources_changed', durationMs, ...usageDetails }) });
            return { kind: 'conflict' as const, code: 'CHAT_SOURCES_CHANGED' as const };
          }
        }
        let createdAt: Date;
        try {
          await client.query('savepoint record_chat_message');
          createdAt = await this.insertMessage(client, { messageId: prepared.messageId,
            conversationId: prepared.conversationId, patientId, idempotencyKey, requestSha256, question, reply, bindings });
          await client.query('release savepoint record_chat_message');
        } catch (error) {
          if (databaseCode(error) !== '23503') throw error;
          await client.query('rollback to savepoint record_chat_message');
          await this.settle(client, prepared.reservationId, result, 'conversation_changed');
          await this.audit.recordWithClient(client, { ...answerBase, outcome: 'denied', details: auditDetails(
            ANSWER_DETAIL_KEYS, { processor: this.processor.processor, model: config.modelId, status: reply.status,
              reason: 'conversation_changed', durationMs, ...usageDetails }) });
          return { kind: 'conflict' as const, code: 'CHAT_CONVERSATION_CHANGED' as const };
        }
        await this.settle(client, prepared.reservationId, result, reply.status);
        await this.audit.recordWithClient(client, { ...answerBase, outcome: 'success', details: auditDetails(
          ANSWER_DETAIL_KEYS, { processor: this.processor.processor, model: config.modelId, status: reply.status,
            reason, refusalCategory: result.kind === 'refusal' ? result.refusalCategory : undefined, citationsValid,
            citedSourceCount: reply.sources.length, durationMs, ...usageDetails }) });
        return { kind: 'saved' as const, reply, createdAt };
      });
    if (outcome.kind === 'failed') {
      throw new DomainProblem(503, 'RECORD_CHAT_UNAVAILABLE', 'Record chat is temporarily unavailable');
    }
    if (outcome.kind === 'conflict') {
      throw new DomainProblem(409, outcome.code, outcome.code === 'CHAT_SOURCES_CHANGED'
        ? 'A record this answer cites changed; ask again' : 'The conversation was cleared during this question');
    }
    return { ...outcome.reply, conversationId: prepared.conversationId, messageId: prepared.messageId,
      processor: this.processor.processor, createdAt: outcome.createdAt.toISOString(), idempotentReplay: false };
  }

  /** The patient's own exchanges, newest first; an exchange citing a record no longer released is left out. */
  async history(request: HidRequest) {
    const { actor, authorization } = await this.records.authorizeOwnSession(request);
    return this.database.withPatientTransaction(authorization, request.correlationId, async (client) => {
      const conversation = await client.query<{ id: string }>(
        'select id from ehr.patient_chat_conversations where patient_id=$1', [authorization.patientId]);
      const rows = conversation.rows[0] ? (await client.query<MessageRow>(
        `select id, question, reply, source_bindings as "sourceBindings", created_at as "createdAt"
           from ehr.patient_chat_messages where patient_id=$1
          order by created_at desc, id desc limit ${HISTORY_LIMIT}`, [authorization.patientId])).rows : [];
      const visible = rows.length ? releasedBindings(await this.release.read(client, authorization.patientId)) : new Map();
      const exchanges = rows.filter((row) => row.sourceBindings.every((binding) => visible.has(bindingKey(binding))))
        .map((row) => ({ messageId: row.id, question: row.question, reply: { status: row.reply.status,
          answer: row.reply.answer, blocks: row.reply.blocks, sources: row.reply.sources },
        createdAt: new Date(row.createdAt).toISOString() }));
      await this.audit.recordWithClient(client, { correlationId: request.correlationId, actorType: 'patient',
        actorSubject: actor.subject, actorAccountId: actor.accountId, patientId: authorization.patientId,
        action: 'ehr.record-chat.history.read', resourceType: 'patient-record-chat-history', outcome: 'success',
        purposeOfUse: 'patient-self', details: auditDetails(HISTORY_DETAIL_KEYS, { exchangeCount: exchanges.length,
          hiddenCount: rows.length - exchanges.length }) });
      return { conversationId: conversation.rows[0]?.id ?? null, exchanges, limit: HISTORY_LIMIT };
    });
  }

  /** Deletes the patient's whole conversation and its exchanges; idempotent. */
  async clear(request: HidRequest) {
    const { actor, authorization } = await this.records.authorizeOwnSession(request);
    return this.database.withPatientTransaction(authorization, request.correlationId, async (client) => {
      const counted = await client.query<{ count: string }>(
        'select count(*)::text as count from ehr.patient_chat_messages where patient_id=$1', [authorization.patientId]);
      await client.query('delete from ehr.patient_chat_conversations where patient_id=$1', [authorization.patientId]);
      const deletedCount = Number(counted.rows[0]?.count ?? 0);
      await this.audit.recordWithClient(client, { correlationId: request.correlationId, actorType: 'patient',
        actorSubject: actor.subject, actorAccountId: actor.accountId, patientId: authorization.patientId,
        action: 'ehr.record-chat.history.clear', resourceType: 'patient-record-chat-history', outcome: 'success',
        purposeOfUse: 'patient-self', details: auditDetails(HISTORY_DETAIL_KEYS, { deletedCount }) });
      return { cleared: true, deletedCount };
    });
  }

  /** The reply for the processor's result; nothing from the model is kept unless it validates. */
  private reply(result: ProcessorResult, extract: PatientExtract): {
    reply: StoredReply; reason?: string; citationsValid?: boolean; bindings: SourceBinding[];
  } {
    const fixed = (status: 'declined' | 'unverified', text: string): StoredReply => ({ status, answer: text,
      blocks: [{ kind: 'explanation', text, references: [] }], sources: [], coverage: extract.coverage });
    if (result.kind === 'refusal') return { reply: fixed('declined', FIXED_REPLIES.declined), reason: 'refusal', bindings: [] };
    if (result.kind === 'incomplete') {
      return { reply: fixed('unverified', FIXED_REPLIES.unverified), reason: result.stopReason === 'max_tokens'
        ? 'max_tokens' : 'unexpected_stop', bindings: [] };
    }
    const validated = validateAnswer(result.text, extract.sources.length);
    if (!validated.ok) {
      return { reply: fixed('unverified', FIXED_REPLIES.unverified), reason: validated.reason, citationsValid: false,
        bindings: [] };
    }
    const cited = new Set(validated.cited);
    const sources = extract.sources.filter((source) => cited.has(source.number));
    const bindings = extract.bindings.filter((_, index) => cited.has(index + 1));
    return { reply: { status: validated.status, answer: joinBlocks(validated.blocks), blocks: validated.blocks, sources,
      coverage: extract.coverage }, citationsValid: true, bindings };
  }

  private replayed(row: MessageRow): ChatAnswer {
    return { status: row.reply.status, answer: row.reply.answer, blocks: row.reply.blocks, sources: row.reply.sources,
      coverage: row.reply.coverage, conversationId: row.conversationId, messageId: row.id, processor: 'anthropic',
      createdAt: new Date(row.createdAt).toISOString(), idempotentReplay: true };
  }

  private async storedByKey(client: PoolClient, patientId: string, idempotencyKey: string): Promise<MessageRow | undefined> {
    const result = await client.query<MessageRow>(
      `select id, conversation_id as "conversationId", question, reply, source_bindings as "sourceBindings",
              request_sha256 as "requestSha256", created_at as "createdAt"
         from ehr.patient_chat_messages where patient_id=$1 and idempotency_key=$2`, [patientId, idempotencyKey]);
    return result.rows[0];
  }

  /** The patient's conversation, created on the first question. */
  private async conversation(client: PoolClient, patientId: string): Promise<string> {
    const inserted = await client.query<{ id: string }>(
      'insert into ehr.patient_chat_conversations(patient_id) values ($1) on conflict (patient_id) do nothing returning id',
      [patientId]);
    if (inserted.rows[0]) return inserted.rows[0].id;
    const existing = await client.query<{ id: string }>(
      'select id from ehr.patient_chat_conversations where patient_id=$1', [patientId]);
    if (!existing.rows[0]) throw new DomainProblem(409, 'CHAT_CONVERSATION_CHANGED', 'The conversation changed');
    return existing.rows[0].id;
  }

  private async insertMessage(client: PoolClient, input: { messageId: string; conversationId: string; patientId: string;
    idempotencyKey: string; requestSha256: string; question: string; reply: StoredReply; bindings: SourceBinding[] }) {
    const result = await client.query<{ createdAt: Date }>(
      `insert into ehr.patient_chat_messages(id, conversation_id, patient_id, idempotency_key, request_sha256, question,
         reply, source_bindings)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb) returning created_at as "createdAt"`,
      [input.messageId, input.conversationId, input.patientId, input.idempotencyKey, input.requestSha256, input.question,
        JSON.stringify(input.reply), JSON.stringify(input.bindings)]);
    return new Date(result.rows[0]!.createdAt);
  }

  private async reserve(client: PoolClient, patientId: string, tokens: number, dailyBudget: number): Promise<string> {
    try {
      const result = await client.query<{ id: string }>(
        "select ehr.reserve_record_chat('patient', $1, $2, $3) as id", [patientId, tokens, dailyBudget]);
      return result.rows[0]!.id;
    } catch (error) {
      const code = databaseCode(error);
      if (code === 'P4290') {
        const seconds = Number((error as { detail?: unknown }).detail);
        throw new DomainProblem(429, 'RECORD_CHAT_RATE_LIMITED', 'The record chat question limit was reached', undefined,
          undefined, Number.isInteger(seconds) && seconds > 0 && seconds <= 86_400 ? seconds : 3600);
      }
      if (code === 'P4091') {
        throw new DomainProblem(429, 'RECORD_CHAT_BUSY', 'Another question is being answered', undefined, undefined,
          BUSY_RETRY_SECONDS);
      }
      if (code === 'P5030') {
        throw new DomainProblem(503, 'RECORD_CHAT_BUDGET_EXHAUSTED', 'Record chat is unavailable until tomorrow');
      }
      if (code === '42501') throw new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'Patient authorization changed');
      throw error;
    }
  }

  private async settle(client: PoolClient, reservationId: string, result: ProcessorResult | null, outcome: string,
    conservativeTokens = 0): Promise<void> {
    const usage = result?.usage;
    await client.query('select ehr.settle_record_chat($1, $2, $3, $4, $5, $6)', [reservationId,
      usage?.inputTokens ?? conservativeTokens, usage?.outputTokens ?? 0, usage?.cacheReadTokens ?? 0,
      usage?.cacheWriteTokens ?? 0, outcome]);
  }

  /** What a failed call is charged when its usage is unknown: the input it may have consumed. */
  private async reservedTokens(prepared: Prepared): Promise<number> {
    return Math.ceil((PATIENT_SYSTEM_PROMPT.length + prepared.userBlocks.join('').length) / 3);
  }

  private async controlEnabled(): Promise<boolean> {
    const result = await this.database.query<{ enabled: boolean }>(
      "select platform.control_enabled('record_chat_enabled') as enabled");
    return result.rows[0]?.enabled === true;
  }

  private async requireControl(): Promise<void> {
    let enabled: boolean;
    try {
      enabled = await this.controlEnabled();
    } catch {
      throw new DomainProblem(503, 'PLATFORM_CONTROL_UNAVAILABLE', 'Platform runtime controls are unavailable');
    }
    if (!enabled) throw new DomainProblem(503, 'RECORD_CHAT_PAUSED', 'Record chat is paused');
  }
}
