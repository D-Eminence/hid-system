import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../../audit/audit.service';
import { requestDigest, requireIdempotencyKey } from '../../common/idempotency';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { DatabaseService } from '../../database/database.service';
import { clinicalContext } from '../shared/clinical-context';
import { ClinicalRepository, type OperationResult } from '../shared/clinical.repository';
import { hasUnsafeCharacter, joinBlocks, validateAnswer } from './answer-validator';
import {
  RECORD_CHAT_PROCESSOR, RecordChatProcessorError, processorFailure, type ProcessorResult, type RecordChatProcessor,
} from './claude-record-chat.client';
import {
  EXTRACT_LIMITS, bindingsStillReleased, buildPatientExtract, releasedBindings, userTurnBlocks,
  type PatientExtract, type PriorTurn, type SourceBinding,
} from './evidence-extract';
import {
  HISTORY_LIMIT, MAX_QUESTION_LENGTH, PRIOR_TURNS, type ChatAnswer, type StoredReply,
} from './patient-record-chat.service';
import {
  ANSWER_DETAIL_KEYS, DISCLOSURE_DETAIL_KEYS, HISTORY_DETAIL_KEYS, auditDetails, disclosureDigest,
} from './record-chat-audit';
import { RECORD_CHAT_CONFIG, enabledRecordChatConfig, type EnabledRecordChatConfig, type RecordChatConfig } from './record-chat.config';
import { readStaffEvidence, staffEvidenceCategories, STAFF_ALWAYS_WITHHELD, STAFF_EVIDENCE_PERMISSIONS } from './staff-evidence';
import { STAFF_SYSTEM_PROMPT } from './system-prompt';

/**
 * Staff record chat (ADR-069; owner decision 1 of 2026-10-16). A clinician who
 * may read a patient's record for direct care asks a question about that
 * patient and reads the answer: POST /ehr/patients/:patientId/chat, with the
 * clinician's own history of that patient beside it. It is the patient's chat
 * (PatientRecordChatService) with a different reader, a different evidence
 * source and a different history:
 * - Evidence: what this member may already read at the facility they selected
 *   (readStaffEvidence), category by category by their permissions. Never the
 *   imported legacy history, Lab or other facilities' records.
 * - Authorization: Identity's decision for this staff member, patient, facility
 *   and purpose before the read and again after the model call (ClinicalRepository.run),
 *   direct care only and never break-glass (403 BREAK_GLASS_EXCLUDED).
 *   Row-level security and ehr.staff_record_chat_context repeat both in the
 *   database.
 * - History: the member's own exchanges about that patient, at that facility
 *   (ehr.staff_record_chat_*). Nobody else reads it, the patient included.
 * - Limits: the same commands as the patient's (ehr.reserve_record_chat with
 *   the audience 'staff'): one question at a time and a daily token budget
 *   shared with the patients', the kill switch record_chat_enabled, and 20
 *   questions an hour and 100 a day per staff account (proposed).
 * Everything the model returns is validated before it is kept, the disclosure
 * is audited before anything is sent (audience 'staff'), and no question,
 * answer or record text reaches an audit row.
 */
const MAX_CONCURRENT_CALLS = 4;
const BUSY_RETRY_SECONDS = 5;

export const STAFF_FIXED_REPLIES = {
  declined: 'This question could not be answered here. Please review the record directly.',
  unverified: 'An answer could not be checked against the records, so it is not shown. Please ask in another way, or '
    + 'review the record directly.',
  noRecords: 'The records you may read for this patient at this facility do not hold information to answer this question yet.',
} as const;

interface Prepared {
  conversationId: string;
  messageId: string;
  reservationId: string;
  extract: PatientExtract;
  userBlocks: string[];
}

type FirstOutcome = { replay: MessageRow } | { answered: ChatAnswer } | { prepared: Prepared };
type SecondOutcome =
  | { kind: 'saved'; reply: StoredReply; createdAt: Date }
  | { kind: 'failed' }
  | { kind: 'conflict'; code: 'CHAT_SOURCES_CHANGED' | 'CHAT_CONVERSATION_CHANGED' };

interface MessageRow extends QueryResultRow {
  id: string;
  conversationId: string;
  question: string;
  reply: StoredReply;
  sourceBindings: SourceBinding[];
  requestSha256: string;
  createdAt: Date;
}

/** The member's scope of one history: this patient, at the selected facility, by this staff account. */
interface Scope {
  patientId: string;
  facilityId: string;
  accountId: string;
  membershipId: string;
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function databaseCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

@Injectable()
export class StaffRecordChatService {
  private inFlight = 0;

  constructor(private readonly database: DatabaseService, private readonly audit: AuditService,
    private readonly clinical: ClinicalRepository,
    @Inject(RECORD_CHAT_CONFIG) private readonly config: RecordChatConfig,
    @Inject(RECORD_CHAT_PROCESSOR) private readonly processor: RecordChatProcessor) {}

  /**
   * Whether staff chat is offered now, and which categories this member's
   * permissions let it read; no Identity, model or audit call. It names no
   * patient: the authorization is per question.
   */
  async availability(request: HidRequest) {
    if (!this.config.staffEnabled || !(await this.controlEnabled().catch(() => false))) return { available: false };
    const config = enabledRecordChatConfig(this.config);
    const permissions: readonly string[] = request.actor?.permissions ?? [];
    const read = staffEvidenceCategories(permissions);
    return {
      available: true, processor: this.processor.processor, inferenceGeo: config.inferenceGeo,
      noticeVersion: config.noticeVersion, historyLimit: HISTORY_LIMIT, maxQuestionLength: MAX_QUESTION_LENGTH,
      released: read,
      withheld: [...(Object.keys(STAFF_EVIDENCE_PERMISSIONS) as Array<keyof typeof STAFF_EVIDENCE_PERMISSIONS>)
        .filter((category) => !read.includes(category)), ...STAFF_ALWAYS_WITHHELD],
    };
  }

  async ask(request: HidRequest, patientId: string, body: { question: string; noticeVersion: string },
    idempotencyHeader: string | undefined): Promise<ChatAnswer> {
    if (!this.config.staffEnabled) {
      throw new DomainProblem(503, 'RECORD_CHAT_DISABLED', 'Record chat is not available');
    }
    await this.requireControl();
    const config = enabledRecordChatConfig(this.config);
    const context = clinicalContext(request);
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question || question.length > MAX_QUESTION_LENGTH || hasUnsafeCharacter(question)) {
      throw new DomainProblem(400, 'INVALID_QUESTION',
        'The question must hold 1 to 1000 characters and no control characters');
    }
    if (body.noticeVersion !== config.noticeVersion) {
      throw new DomainProblem(428, 'CHAT_NOTICE_REQUIRED', 'The current record chat notice must be acknowledged');
    }
    const idempotencyKey = requireIdempotencyKey(idempotencyHeader);
    const requestSha256 = requestDigest('ehr.record-chat.staff.ask', { patientId, question, noticeVersion: body.noticeVersion });
    if (this.inFlight >= MAX_CONCURRENT_CALLS) {
      throw new DomainProblem(429, 'RECORD_CHAT_BUSY', 'Record chat is busy; try again shortly', undefined, undefined,
        BUSY_RETRY_SECONDS);
    }
    this.inFlight += 1;
    try {
      return await this.answer(context, patientId, config, question, idempotencyKey, requestSha256);
    } finally {
      this.inFlight -= 1;
    }
  }

  private async answer(context: DataAccessContext, patientId: string, config: EnabledRecordChatConfig, question: string,
    idempotencyKey: string, requestSha256: string): Promise<ChatAnswer> {
    const scope = this.scope(context, patientId);
    const permissions = context.actor.permissions;
    const auditBase = this.auditBase(context, patientId, 'staff-record-chat');
    const event = {
      resourceType: 'staff-record-chat', excludeBreakGlass: { code: 'BREAK_GLASS_EXCLUDED' },
    } as const;

    // Identity's decision, then one staff transaction: the replay, the cap, the
    // evidence, the extract, the earlier exchanges, the lease and the
    // disclosure audit row together. Any failure there means no call.
    const first = await this.clinical.run<FirstOutcome>(context, patientId, 'read_records',
      { ...event, action: 'ehr.record-chat.staff.read' }, async (client): Promise<OperationResult<FirstOutcome>> => {
        const replay = await this.storedByKey(client, scope, idempotencyKey);
        if (replay) {
          if (replay.requestSha256 !== requestSha256) {
            throw new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used for another question');
          }
          // A stored answer is shown again only while every record it cites is
          // still readable with the content it was answered from.
          if (replay.sourceBindings.length > 0 && !bindingsStillReleased(replay.sourceBindings,
            releasedBindings(await readStaffEvidence(client, patientId, context.facilityId, permissions)))) {
            throw new DomainProblem(409, 'CHAT_SOURCES_CHANGED', 'A record this answer cites changed or is no longer available');
          }
          await this.audit.recordWithClient(client, { ...auditBase, action: 'ehr.record-chat.replay', outcome: 'success',
            resourceId: replay.id, details: {} });
          return { value: { replay }, resourceId: replay.id };
        }
        const stored = await client.query<{ count: string }>(
          `select count(*)::text as count from ehr.staff_record_chat_messages
            where patient_id=$1 and facility_id=$2 and account_id=$3`, this.scopeValues(scope));
        if (Number(stored.rows[0]?.count ?? 0) >= HISTORY_LIMIT) {
          throw new DomainProblem(409, 'CHAT_HISTORY_FULL',
            'The record chat history is full; delete it to ask another question');
        }
        const read = await readStaffEvidence(client, patientId, context.facilityId, permissions);
        const extract = buildPatientExtract(read, question, { ...EXTRACT_LIMITS, maxTotalChars: config.maxEvidenceChars });
        // Earlier exchanges are context, never evidence, and are sent only
        // while every record they cite is still readable with the content
        // they were answered from. The newest four that pass.
        const visible = releasedBindings(read);
        const prior = await client.query<{ id: string; question: string; answer: string; sourceBindings: SourceBinding[] }>(
          `select id, question, reply->>'answer' as answer, source_bindings as "sourceBindings"
             from ehr.staff_record_chat_messages where patient_id=$1 and facility_id=$2 and account_id=$3
            order by created_at desc, id desc limit ${HISTORY_LIMIT}`, this.scopeValues(scope));
        const priorRows = prior.rows.filter((row) => bindingsStillReleased(row.sourceBindings, visible)).slice(0, PRIOR_TURNS);
        const priorTurns: PriorTurn[] = [...priorRows].reverse().map((row) => ({ question: row.question, answer: row.answer }));
        const conversationId = await this.conversation(client, scope);
        const messageId = randomUUID();
        const userBlocks = userTurnBlocks(extract, priorTurns, question, 'staff');
        const estimatedInput = Math.ceil((STAFF_SYSTEM_PROMPT.length + userBlocks.join('').length) / 3);
        const reservedTokens = Math.min(1_000_000, estimatedInput + config.maxOutputTokens);
        const reservationId = await this.reserve(client, patientId, reservedTokens, config.dailyTokenBudget);
        const details = { recordCount: extract.coverage.recordCount, selectedCount: extract.coverage.selectedCount };
        if (extract.sources.length === 0) {
          // Nothing readable to answer from: a fixed reply, and nothing is sent.
          const reply: StoredReply = { status: 'no_evidence', answer: STAFF_FIXED_REPLIES.noRecords, blocks: [
            { kind: 'explanation', text: STAFF_FIXED_REPLIES.noRecords, references: [] }], sources: [], coverage: extract.coverage };
          const createdAt = await this.insertMessage(client, scope, { messageId, conversationId, idempotencyKey,
            requestSha256, question, reply, bindings: [] });
          await this.settle(client, reservationId, null, 'no_evidence');
          await this.audit.recordWithClient(client, { ...auditBase, action: 'ehr.record-chat.answer', outcome: 'success',
            resourceId: messageId, details: auditDetails(ANSWER_DETAIL_KEYS, { status: 'no_evidence',
              reason: 'no_readable_records', citedSourceCount: 0 }) });
          return { value: { answered: { ...reply, conversationId, messageId, processor: this.processor.processor,
            createdAt: createdAt.toISOString(), idempotentReplay: false } }, resourceId: messageId, details };
        }
        // Committed with the lease before any call: no row, no disclosure.
        await this.audit.recordWithClient(client, { ...auditBase, action: 'ehr.record-chat.disclosure', outcome: 'success',
          resourceId: messageId, details: auditDetails(DISCLOSURE_DETAIL_KEYS, {
            processor: this.processor.processor, model: config.modelId, inferenceGeo: config.inferenceGeo,
            audience: 'staff', sourceCount: extract.sources.length, sourceCounts: extract.sourceCounts,
            priorExchangeCount: priorTurns.length, withheldCategories: extract.coverage.withheld,
            truncated: extract.coverage.truncated, noticeVersion: config.noticeVersion, reservedTokens,
            maxOutputTokens: config.maxOutputTokens,
            disclosureDigest: disclosureDigest(config.auditDigestKey, { messageId, model: config.modelId,
              inferenceGeo: config.inferenceGeo, bindings: extract.bindings, questionSha256: sha256(question),
              priorMessageIds: priorRows.map((row) => row.id) }),
          }) });
        return { value: { prepared: { conversationId, messageId, reservationId, extract, userBlocks } },
          resourceId: messageId, details };
      });
    if ('replay' in first) return this.replayed(first.replay);
    if ('answered' in first) return first.answered;
    const prepared = first.prepared;

    // One request to the processor.
    const started = Date.now();
    const deadlineAt = started + config.deadlineMs;
    let result: ProcessorResult | undefined;
    let failure: RecordChatProcessorError | undefined;
    try {
      await this.processor.ensureReady(deadlineAt);
      result = await this.processor.ask({ systemPrompt: STAFF_SYSTEM_PROMPT, userBlocks: prepared.userBlocks }, deadlineAt);
    } catch (error) {
      failure = processorFailure(error);
    }
    const durationMs = Date.now() - started;
    const answerBase = { ...auditBase, action: 'ehr.record-chat.answer', resourceId: prepared.messageId };
    const usageDetails = result ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens, cacheWriteTokens: result.usage.cacheWriteTokens,
      servedGeo: result.usage.servedGeo, processorMessageId: result.processorMessageId, stopReason: result.stopReason } : {};

    // Identity's decision again, after the call (ClinicalRepository.run), then
    // one staff transaction: the answer is validated, the cited records are read
    // again, the exchange is stored, the lease is settled and the answer is
    // audited. A refusal of the decision discards the answer.
    let outcome: SecondOutcome;
    try {
      outcome = await this.clinical.run<SecondOutcome>(context, patientId, 'read_records',
        { ...event, action: 'ehr.record-chat.staff.save' }, async (client): Promise<OperationResult<SecondOutcome>> => {
          if (failure || !result) {
            await this.settle(client, prepared.reservationId, null, 'failed',
              failure && ['timeout', 'output_too_large', 'processor_error'].includes(failure.reason)
                ? this.reservedTokens(prepared) : 0);
            await this.audit.recordWithClient(client, { ...answerBase, outcome: 'failure', details: auditDetails(
              ANSWER_DETAIL_KEYS, { processor: this.processor.processor, model: config.modelId,
                reason: failure?.reason ?? 'processor_error', durationMs }) });
            return { value: { kind: 'failed' } };
          }
          const { reply, reason, citationsValid, bindings } = this.reply(result, prepared.extract);
          if (bindings.length > 0) {
            const current = releasedBindings(await readStaffEvidence(client, patientId, context.facilityId, permissions));
            if (!bindingsStillReleased(bindings, current)) {
              await this.settle(client, prepared.reservationId, result, 'sources_changed');
              await this.audit.recordWithClient(client, { ...answerBase, outcome: 'denied', details: auditDetails(
                ANSWER_DETAIL_KEYS, { processor: this.processor.processor, model: config.modelId, status: reply.status,
                  reason: 'sources_changed', durationMs, ...usageDetails }) });
              return { value: { kind: 'conflict', code: 'CHAT_SOURCES_CHANGED' } };
            }
          }
          let createdAt: Date;
          try {
            await client.query('savepoint staff_record_chat_message');
            createdAt = await this.insertMessage(client, scope, { messageId: prepared.messageId,
              conversationId: prepared.conversationId, idempotencyKey, requestSha256, question, reply, bindings });
            await client.query('release savepoint staff_record_chat_message');
          } catch (error) {
            if (databaseCode(error) !== '23503') throw error;
            await client.query('rollback to savepoint staff_record_chat_message');
            await this.settle(client, prepared.reservationId, result, 'conversation_changed');
            await this.audit.recordWithClient(client, { ...answerBase, outcome: 'denied', details: auditDetails(
              ANSWER_DETAIL_KEYS, { processor: this.processor.processor, model: config.modelId, status: reply.status,
                reason: 'conversation_changed', durationMs, ...usageDetails }) });
            return { value: { kind: 'conflict', code: 'CHAT_CONVERSATION_CHANGED' } };
          }
          await this.settle(client, prepared.reservationId, result, reply.status);
          await this.audit.recordWithClient(client, { ...answerBase, outcome: 'success', details: auditDetails(
            ANSWER_DETAIL_KEYS, { processor: this.processor.processor, model: config.modelId, status: reply.status,
              reason, refusalCategory: result.kind === 'refusal' ? result.refusalCategory : undefined, citationsValid,
              citedSourceCount: reply.sources.length, durationMs, ...usageDetails }) });
          return { value: { kind: 'saved', reply, createdAt }, resourceId: prepared.messageId,
            details: { citedSourceCount: reply.sources.length } };
        });
    } catch (error) {
      if (error instanceof DomainProblem && error.getStatus() < 500) {
        // Identity's decision changed during the call (or a refusal inside the
        // transaction): the answer is discarded, the lease expires and is
        // charged its estimate, and the outcome is audited.
        await this.audit.record({ ...answerBase, outcome: 'denied', details: auditDetails(ANSWER_DETAIL_KEYS, {
          processor: this.processor.processor, model: config.modelId, reason: 'authorization_changed', durationMs,
          ...usageDetails }) }).catch(() => undefined);
        throw error;
      }
      // The transaction rolled back whole. The disclosure is already audited,
      // so the lease is settled and the outcome audited in a short fallback
      // transaction; if that fails too, the lease expires and is charged its
      // estimate. Nothing from the model is kept.
      await this.database.withTransaction(context, async (client) => {
        await this.settle(client, prepared.reservationId, result ?? null, 'failed',
          result ? 0 : this.reservedTokens(prepared));
        await this.audit.recordWithClient(client, { ...answerBase, outcome: 'failure', details: auditDetails(
          ANSWER_DETAIL_KEYS, { processor: this.processor.processor, model: config.modelId, reason: 'save_failed',
            durationMs, ...usageDetails }) });
      }).catch(() => undefined);
      throw new DomainProblem(503, 'RECORD_CHAT_UNAVAILABLE', 'Record chat is temporarily unavailable');
    }
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

  /**
   * The member's own exchanges about this patient at this facility, newest
   * first. An exchange is left out while a record it cites is no longer
   * readable by this member or no longer has the content it was answered from.
   */
  async history(request: HidRequest, patientId: string) {
    const context = clinicalContext(request);
    const scope = this.scope(context, patientId);
    return this.clinical.run(context, patientId, 'read_records', {
      action: 'ehr.record-chat.staff.history.read', resourceType: 'staff-record-chat-history',
      excludeBreakGlass: { code: 'BREAK_GLASS_EXCLUDED' },
    }, async (client) => {
      const conversation = await client.query<{ id: string }>(
        'select id from ehr.staff_record_chat_conversations where patient_id=$1 and facility_id=$2 and account_id=$3',
        this.scopeValues(scope));
      const rows = conversation.rows[0] ? (await client.query<MessageRow>(
        `select id, question, reply, source_bindings as "sourceBindings", created_at as "createdAt"
           from ehr.staff_record_chat_messages where patient_id=$1 and facility_id=$2 and account_id=$3
          order by created_at desc, id desc limit ${HISTORY_LIMIT}`, this.scopeValues(scope))).rows : [];
      const visible = rows.length
        ? releasedBindings(await readStaffEvidence(client, patientId, context.facilityId, context.actor.permissions))
        : new Map<string, string>();
      const exchanges = rows.filter((row) => bindingsStillReleased(row.sourceBindings, visible))
        .map((row) => ({ messageId: row.id, question: row.question, reply: { status: row.reply.status,
          answer: row.reply.answer, blocks: row.reply.blocks, sources: row.reply.sources },
        createdAt: new Date(row.createdAt).toISOString() }));
      return {
        value: { conversationId: conversation.rows[0]?.id ?? null, exchanges, limit: HISTORY_LIMIT },
        details: auditDetails(HISTORY_DETAIL_KEYS, { exchangeCount: exchanges.length, hiddenCount: rows.length - exchanges.length }),
      };
    });
  }

  /**
   * Deletes the member's whole conversation about this patient at this
   * facility and its exchanges; idempotent. While an active legal hold names
   * the patient or the staff account (platform.legal_holds), nothing is
   * deleted: 409 CHAT_HISTORY_ON_HOLD, audited by ClinicalRepository.run. The
   * delete policies enforce the same rule in the database.
   */
  async clear(request: HidRequest, patientId: string) {
    const context = clinicalContext(request);
    const scope = this.scope(context, patientId);
    const onHold = () => new DomainProblem(409, 'CHAT_HISTORY_ON_HOLD',
      'A legal hold keeps the record chat history; it cannot be deleted now');
    return this.clinical.run(context, patientId, 'read_records', {
      action: 'ehr.record-chat.staff.history.clear', resourceType: 'staff-record-chat-history',
      excludeBreakGlass: { code: 'BREAK_GLASS_EXCLUDED' },
    }, async (client) => {
      const hold = await client.query<{ held: boolean }>('select ehr.staff_record_chat_history_on_hold($1) as held', [patientId]);
      if (hold.rows[0]?.held !== false) throw onHold();
      // One statement, one snapshot: the exchanges and the conversation go
      // together, and a hold placed since the check keeps every row (the delete policies).
      const deleted = await client.query<{ count: string; existing: number; deleted: number }>(
        `with deleted_messages as (delete from ehr.staff_record_chat_messages
                                    where patient_id=$1 and facility_id=$2 and account_id=$3 returning 1),
              deleted_conversation as (delete from ehr.staff_record_chat_conversations
                                    where patient_id=$1 and facility_id=$2 and account_id=$3 returning 1)
         select (select count(*) from deleted_messages)::text as count,
                (select count(*) from ehr.staff_record_chat_conversations
                  where patient_id=$1 and facility_id=$2 and account_id=$3)::int as existing,
                (select count(*) from deleted_conversation)::int as deleted`, this.scopeValues(scope));
      const row = deleted.rows[0];
      if (row && row.deleted < row.existing) throw onHold();
      const deletedCount = Number(row?.count ?? 0);
      return { value: { cleared: true, deletedCount }, details: auditDetails(HISTORY_DETAIL_KEYS, { deletedCount }) };
    });
  }

  /** The reply for the processor's result; nothing from the model is kept unless it validates. */
  private reply(result: ProcessorResult, extract: PatientExtract): {
    reply: StoredReply; reason?: string; citationsValid?: boolean; bindings: SourceBinding[];
  } {
    const fixed = (status: 'declined' | 'unverified', text: string): StoredReply => ({ status, answer: text,
      blocks: [{ kind: 'explanation', text, references: [] }], sources: [], coverage: extract.coverage });
    if (result.kind === 'refusal') return { reply: fixed('declined', STAFF_FIXED_REPLIES.declined), reason: 'refusal', bindings: [] };
    if (result.kind === 'incomplete') {
      return { reply: fixed('unverified', STAFF_FIXED_REPLIES.unverified), reason: result.stopReason === 'max_tokens'
        ? 'max_tokens' : 'unexpected_stop', bindings: [] };
    }
    const validated = validateAnswer(result.text, extract.sources.length);
    if (!validated.ok) {
      return { reply: fixed('unverified', STAFF_FIXED_REPLIES.unverified), reason: validated.reason, citationsValid: false,
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

  private scope(context: DataAccessContext, patientId: string): Scope {
    return { patientId, facilityId: context.facilityId, accountId: context.actor.accountId,
      membershipId: context.membershipId };
  }

  private scopeValues(scope: Scope): [string, string, string] {
    return [scope.patientId, scope.facilityId, scope.accountId];
  }

  private auditBase(context: DataAccessContext, patientId: string, resourceType: string) {
    return {
      correlationId: context.correlationId, actorType: 'staff' as const, actorSubject: context.actor.subject,
      actorAccountId: context.actor.accountId, actorMembershipId: context.membershipId,
      organizationId: context.actor.facility?.organizationId, facilityId: context.facilityId, patientId, resourceType,
      purposeOfUse: 'direct-care' as const,
    };
  }

  private async storedByKey(client: PoolClient, scope: Scope, idempotencyKey: string): Promise<MessageRow | undefined> {
    const result = await client.query<MessageRow>(
      `select id, conversation_id as "conversationId", question, reply, source_bindings as "sourceBindings",
              request_sha256 as "requestSha256", created_at as "createdAt"
         from ehr.staff_record_chat_messages where patient_id=$1 and facility_id=$2 and account_id=$3
          and idempotency_key=$4`, [...this.scopeValues(scope), idempotencyKey]);
    return result.rows[0];
  }

  /** The member's conversation about this patient at this facility, created on the first question. */
  private async conversation(client: PoolClient, scope: Scope): Promise<string> {
    const inserted = await client.query<{ id: string }>(
      `insert into ehr.staff_record_chat_conversations(patient_id, facility_id, account_id, membership_id)
       values ($1, $2, $3, $4) on conflict (patient_id, facility_id, account_id) do nothing returning id`,
      [...this.scopeValues(scope), scope.membershipId]);
    if (inserted.rows[0]) return inserted.rows[0].id;
    const existing = await client.query<{ id: string }>(
      'select id from ehr.staff_record_chat_conversations where patient_id=$1 and facility_id=$2 and account_id=$3',
      this.scopeValues(scope));
    if (!existing.rows[0]) throw new DomainProblem(409, 'CHAT_CONVERSATION_CHANGED', 'The conversation changed');
    return existing.rows[0].id;
  }

  private async insertMessage(client: PoolClient, scope: Scope, input: { messageId: string; conversationId: string;
    idempotencyKey: string; requestSha256: string; question: string; reply: StoredReply; bindings: SourceBinding[] }) {
    const result = await client.query<{ createdAt: Date }>(
      `insert into ehr.staff_record_chat_messages(id, conversation_id, patient_id, facility_id, account_id, membership_id,
         idempotency_key, request_sha256, question, reply, source_bindings)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb) returning created_at as "createdAt"`,
      [input.messageId, input.conversationId, scope.patientId, scope.facilityId, scope.accountId, scope.membershipId,
        input.idempotencyKey, input.requestSha256, input.question, JSON.stringify(input.reply),
        JSON.stringify(input.bindings)]);
    return new Date(result.rows[0]!.createdAt);
  }

  private async reserve(client: PoolClient, patientId: string, tokens: number, dailyBudget: number): Promise<string> {
    try {
      const result = await client.query<{ id: string }>(
        "select ehr.reserve_record_chat('staff', $1, $2, $3) as id", [patientId, tokens, dailyBudget]);
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
      if (code === '42501') throw new DomainProblem(403, 'CONSENT_REQUIRED', 'Active consent and facility membership are required');
      // The kill switch, read again in this transaction, or its row missing.
      if (code === '55000') {
        throw (error as { message?: unknown }).message === 'RECORD_CHAT_PAUSED'
          ? new DomainProblem(503, 'RECORD_CHAT_PAUSED', 'Record chat is paused')
          : new DomainProblem(503, 'PLATFORM_CONTROL_UNAVAILABLE', 'Platform runtime controls are unavailable');
      }
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
  private reservedTokens(prepared: Prepared): number {
    return Math.ceil((STAFF_SYSTEM_PROMPT.length + prepared.userBlocks.join('').length) / 3);
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
