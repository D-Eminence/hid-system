import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { AuditService } from '../../audit/audit.service';
import { DomainProblem } from '../../common/problem';
import type { HidRequest } from '../../common/request-context';
import { getEnvironment } from '../../config/environment';
import { DatabaseService } from '../../database/database.service';
import { BedrockAiService } from './bedrock-ai.service';
import { PatientRecordsService } from './patient-records.service';

interface NoteRow extends QueryResultRow {
  noteId: string;
  revisionNo: number;
  title: string;
  content: string;
  contentLength: number;
  contentSha256: string;
  signedAt: Date;
  indexed: boolean;
  facilityId: string;
}

interface SourceRow extends QueryResultRow {
  noteId: string;
  revisionNo: number;
  title: string;
  content: string;
  contentSha256: string;
  signedAt: Date;
}

const NO_RECORDS = 'I could not find released clinical notes in your authorized records.';
const NO_GROUNDED_ANSWER = 'I could not verify an answer from the available records.';

@Injectable()
export class PatientChatService {
  // Per-task admission limit plus gateway limits bound staging requests. This
  // is not a distributed billing limit; multiple replicas have separate quotas.
  private readonly admissions = new Map<string, { until: number; count: number; busy: boolean }>();
  private globalWindow = { until: 0, count: 0, busy: 0 };
  constructor(
    private readonly database: DatabaseService,
    private readonly records: PatientRecordsService,
    private readonly bedrock: BedrockAiService,
    private readonly audit: AuditService,
  ) {}

  async answer(request: HidRequest, rawQuestion: string) {
    const environment = getEnvironment();
    if (!environment.AI_ENABLED) throw new DomainProblem(503, 'PATIENT_CHAT_DISABLED', 'Patient chat is not enabled');
    const question = rawQuestion.trim();
    if (!question || question.length > 500) {
      throw new DomainProblem(400, 'INVALID_QUESTION', 'A question of 1 to 500 characters is required');
    }
    const authorization = await this.records.authorizeSelf(request);
    const release = this.admit(authorization.patientId);
    try {
      return await this.answerAuthorized(request, question, authorization, environment, AbortSignal.timeout(35_000));
    } catch (error) {
      if (error instanceof DomainProblem) throw error;
      throw new DomainProblem(503, 'PATIENT_CHAT_UNAVAILABLE', 'Patient chat is temporarily unavailable');
    } finally { release(); }
  }

  private admit(patientId: string): () => void {
    const now = Date.now();
    for (const [key, value] of this.admissions) {
      if (value.until <= now && !value.busy) this.admissions.delete(key);
    }
    const value = this.admissions.get(patientId) ?? { until: now + 300_000, count: 0, busy: false };
    if (this.globalWindow.until <= now) { this.globalWindow.until = now + 300_000; this.globalWindow.count = 0; }
    if (value.busy || value.count >= 10 || this.globalWindow.busy >= 4 || this.globalWindow.count >= 50
      || (!this.admissions.has(patientId) && this.admissions.size >= 1000)) {
      throw new DomainProblem(429, 'PATIENT_CHAT_RATE_LIMITED', 'Please wait before asking another question');
    }
    value.count += 1; value.busy = true; this.admissions.set(patientId, value);
    this.globalWindow.count += 1; this.globalWindow.busy += 1;
    return () => { value.busy = false; this.globalWindow.busy -= 1; };
  }

  private async answerAuthorized(request: HidRequest, question: string,
    authorization: Awaited<ReturnType<PatientRecordsService['authorizeSelf']>>,
    environment: ReturnType<typeof getEnvironment>, signal: AbortSignal) {
    const notes = await this.database.withPatientTransaction(authorization, request.correlationId, async (client) => {
      const result = await client.query<NoteRow>(
        `select note.id as "noteId", note.current_revision_no as "revisionNo", note.title,
           left(revision.content, 6000) as content, char_length(revision.content) as "contentLength",
           revision.content_sha256 as "contentSha256", note.signed_at as "signedAt",
           note.facility_id as "facilityId", (embedding.note_id is not null) as indexed
         from ehr.clinical_notes note
         join ehr.clinical_note_revisions revision
           on revision.clinical_note_id = note.id and revision.revision_no = note.current_revision_no
           and revision.patient_id = note.patient_id and revision.facility_id = note.facility_id
         left join ehr.patient_record_embeddings embedding
           on embedding.note_id = note.id and embedding.revision_no = note.current_revision_no
           and embedding.patient_id = note.patient_id and embedding.facility_id = note.facility_id
           and embedding.content_sha256 = revision.content_sha256 and embedding.model_id = $2
         where note.patient_id = $1 and note.status in ('signed', 'amended')
         order by note.signed_at desc, note.id desc limit 51`,
        [authorization.patientId, environment.AI_EMBEDDING_MODEL_ID],
      );
      await this.audit.recordWithClient(client, {
        correlationId: request.correlationId, actorType: 'patient', actorSubject: authorization.subject,
        actorAccountId: authorization.accountId, patientId: authorization.patientId,
        action: 'ehr.patient.chat.records.read', resourceType: 'clinical-note-collection',
        outcome: 'success', purposeOfUse: 'patient-self', details: { noteCount: result.rows.length },
      });
      return result.rows;
    });
    if (notes.length === 0) return { status: 'ready', answer: NO_RECORDS, sources: [] };
    if (notes.length > 50 || notes.some((note) => note.contentLength > 6000)) {
      throw new DomainProblem(409, 'CHAT_RECORD_SCOPE_EXCEEDED', 'These records need preparation before chat can answer safely');
    }

    const missing = notes.filter((note) => !note.indexed);
    const indexed = await Promise.all(missing.slice(0, 4).map(async (note) => ({
      note,
      vector: await this.bedrock.embed(`${note.title}\n${note.content}`, signal),
    })));
    if (indexed.length) {
      const refreshed = await this.records.authorizeSelf(request);
      await this.database.withPatientTransaction(refreshed, request.correlationId, async (client) => {
        for (const { note, vector } of indexed) {
          await client.query(
            `insert into ehr.patient_record_embeddings
               (note_id, revision_no, patient_id, facility_id, content_sha256, model_id, embedding)
             values ($1, $2, $3, $4, $5, $6, $7::vector)
             on conflict (note_id, revision_no, model_id) do nothing`,
            [note.noteId, note.revisionNo, refreshed.patientId, note.facilityId,
              note.contentSha256, environment.AI_EMBEDDING_MODEL_ID, JSON.stringify(vector)],
          );
        }
      });
    }
    if (missing.length > indexed.length) {
      return { status: 'preparing', answer: 'Preparing your records. Please try again shortly.', sources: [] };
    }

    signal.throwIfAborted();
    const questionVector = await this.bedrock.embed(question, signal);
    const current = await this.records.authorizeSelf(request);
    const sources = await this.database.withPatientTransaction(current, request.correlationId, async (client) => {
      const result = await client.query<SourceRow>(
        `select note.id as "noteId", note.current_revision_no as "revisionNo", note.title,
           left(revision.content, 6000) as content, revision.content_sha256 as "contentSha256",
           note.signed_at as "signedAt"
         from ehr.patient_record_embeddings embedding
         join ehr.clinical_notes note on note.id = embedding.note_id
           and note.patient_id = embedding.patient_id and note.facility_id = embedding.facility_id
         join ehr.clinical_note_revisions revision
           on revision.clinical_note_id = note.id and revision.revision_no = note.current_revision_no
           and revision.patient_id = note.patient_id and revision.facility_id = note.facility_id
         where embedding.patient_id = $1 and embedding.model_id = $2
           and note.status in ('signed', 'amended')
           and embedding.revision_no = note.current_revision_no
           and embedding.content_sha256 = revision.content_sha256
         order by embedding.embedding <=> $3::vector limit 5`,
        [current.patientId, environment.AI_EMBEDDING_MODEL_ID, JSON.stringify(questionVector)],
      );
      return result.rows;
    });
    if (!sources.length) return { status: 'ready', answer: NO_RECORDS, sources: [] };

    signal.throwIfAborted();
    const generated = await this.bedrock.answer(question, sources, signal);
    const citations = [...generated.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
    // This validates citation references, not the factual support of a claim.
    // Real answer evaluation remains an activation gate for the selected model.
    const citationsValid = citations.length > 0 && citations.every((number) => number >= 1 && number <= sources.length);
    const finalAuthorization = await this.records.authorizeSelf(request);
    await this.database.withPatientTransaction(finalAuthorization, request.correlationId, async (client) => {
      await this.assertSourcesCurrent(client, finalAuthorization.patientId, sources);
      await this.audit.recordWithClient(client, {
        correlationId: request.correlationId, actorType: 'patient', actorSubject: finalAuthorization.subject,
        actorAccountId: finalAuthorization.accountId, patientId: finalAuthorization.patientId,
        action: 'ehr.patient.chat.answer', resourceType: 'clinical-note-collection',
        outcome: citationsValid ? 'success' : 'failure', purposeOfUse: 'patient-self',
        details: { sourceCount: sources.length, citationsValid },
      });
    });
    return {
      status: 'ready',
      answer: citationsValid ? generated : NO_GROUNDED_ANSWER,
      sources: citationsValid ? sources.map((source, index) => ({
        number: index + 1, noteId: source.noteId, revisionNo: source.revisionNo,
        title: source.title, signedAt: source.signedAt,
      })) : [],
    };
  }

  private async assertSourcesCurrent(client: PoolClient, patientId: string, sources: readonly SourceRow[]) {
    const result = await client.query<{ count: string }>(
      `select count(*)::text as count from ehr.clinical_notes note
       join ehr.clinical_note_revisions revision
         on revision.clinical_note_id = note.id and revision.revision_no = note.current_revision_no
         and revision.patient_id = note.patient_id and revision.facility_id = note.facility_id
       where note.patient_id = $1 and note.status in ('signed', 'amended')
         and (note.id, note.current_revision_no, revision.content_sha256) in (
           select * from unnest($2::uuid[], $3::integer[], $4::text[]))`,
      [patientId, sources.map((source) => source.noteId), sources.map((source) => source.revisionNo),
        sources.map((source) => source.contentSha256)],
    );
    if (Number(result.rows[0]?.count) !== sources.length) {
      throw new DomainProblem(409, 'CHAT_SOURCES_CHANGED', 'The source records changed during this request');
    }
  }
}
