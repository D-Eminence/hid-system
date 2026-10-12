import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../../audit/audit.service';
import { DomainProblem } from '../../common/problem';
import type { HidRequest } from '../../common/request-context';
import { PatientRecordsService } from './patient-records.service';

type Authorization = Awaited<ReturnType<PatientRecordsService['authorizeSelf']>>;
export interface ChatReply {
  status: 'ready' | 'preparing'; answer: string;
  sources: Array<{ number: number; noteId: string; revisionNo: number; title: string; signedAt: Date | string }>;
}
@Injectable()
export class PatientChatHistoryService {
  constructor(private readonly database: DatabaseService, private readonly records: PatientRecordsService,
    private readonly audit: AuditService) {}

  private async lock(client: PoolClient, patientId: string): Promise<string> {
    await client.query('insert into ehr.patient_chat_state(patient_id) values ($1) on conflict do nothing', [patientId]);
    const row = await client.query<{ generation: string }>('select generation from ehr.patient_chat_state where patient_id=$1 for update', [patientId]);
    if (!row.rows[0]) throw new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'Patient authorization changed');
    return row.rows[0].generation;
  }
  private async prune(client: PoolClient, patientId: string) {
    await client.query(`delete from ehr.patient_chat_messages where patient_id=$1 and
      (created_at <= statement_timestamp()-interval '30 days' or id in
        (select id from ehr.patient_chat_messages where patient_id=$1 order by created_at desc,id desc offset 10))`, [patientId]);
  }
  async start(request: HidRequest, authorization: Authorization): Promise<string> {
    return this.database.withPatientTransaction(authorization, request.correlationId,
      client => this.lock(client, authorization.patientId));
  }
  async save(request: HidRequest, generation: string, question: string, reply: ChatReply) {
    if (!reply.answer.trim() || reply.answer.length > 4000) {
      throw new DomainProblem(503, 'PATIENT_CHAT_UNAVAILABLE', 'Patient chat is temporarily unavailable');
    }
    const auth = await this.records.authorizeSelf(request);
    await this.database.withPatientTransaction(auth, request.correlationId, async client => {
      if (await this.lock(client, auth.patientId) !== generation) {
        throw new DomainProblem(409, 'CHAT_CONVERSATION_CHANGED', 'The conversation was cleared. Please ask again.');
      }
      const bindings: Array<{ noteId: string; revisionNo: number; hash: string }> = [];
      for (const source of reply.sources) {
        const found = await client.query<{ hash: string }>(`select r.content_sha256 as hash from ehr.clinical_notes n
          join ehr.clinical_note_revisions r on r.clinical_note_id=n.id and r.revision_no=n.current_revision_no
          and r.patient_id=n.patient_id and r.facility_id=n.facility_id
          where n.id=$1 and n.patient_id=$2 and n.current_revision_no=$3 and n.status in ('signed','amended')`,
        [source.noteId, auth.patientId, source.revisionNo]);
        if (!found.rows[0]) throw new DomainProblem(409, 'CHAT_SOURCES_CHANGED', 'The source records changed during this request');
        bindings.push({ noteId: source.noteId, revisionNo: source.revisionNo, hash: found.rows[0].hash });
      }
      await client.query(`insert into ehr.patient_chat_messages(patient_id,generation,question,reply,source_bindings)
        values ($1,$2,$3,$4::jsonb,$5::jsonb)`, [auth.patientId, generation, question, JSON.stringify(reply), JSON.stringify(bindings)]);
      await this.prune(client, auth.patientId);
      await this.audit.recordWithClient(client, { correlationId: request.correlationId, actorType: 'patient',
        actorSubject: auth.subject, actorAccountId: auth.accountId, patientId: auth.patientId,
        action: 'ehr.patient.chat.history.save', resourceType: 'patient-chat-history', outcome: 'success',
        purposeOfUse: 'patient-self', details: { sourceCount: reply.sources.length } });
    });
  }
  async read(request: HidRequest) {
    const auth = await this.records.authorizeSelf(request);
    return this.database.withPatientTransaction(auth, request.correlationId, async client => {
      await this.lock(client, auth.patientId);
      await this.prune(client, auth.patientId);
      const result = await client.query<{ id: string; question: string; reply: ChatReply; createdAt: Date }>(
        `select h.id,h.question,h.reply,h.created_at as "createdAt" from ehr.patient_chat_messages h
         where h.patient_id=$1 and h.created_at > statement_timestamp()-interval '30 days'
         and not exists (
           select 1 from jsonb_array_elements(h.source_bindings) b where not exists (
             select 1 from ehr.clinical_notes n join ehr.clinical_note_revisions r
               on r.clinical_note_id=n.id and r.revision_no=n.current_revision_no
               and r.patient_id=n.patient_id and r.facility_id=n.facility_id
             where n.patient_id=h.patient_id and n.id::text=b->>'noteId'
               and n.current_revision_no=(b->>'revisionNo')::integer
               and r.content_sha256=b->>'hash' and n.status in ('signed','amended')))
         order by h.created_at desc,h.id desc limit 10`, [auth.patientId]);
      await this.audit.recordWithClient(client, { correlationId: request.correlationId, actorType: 'patient',
        actorSubject: auth.subject, actorAccountId: auth.accountId, patientId: auth.patientId,
        action: 'ehr.patient.chat.history.read', resourceType: 'patient-chat-history', outcome: 'success',
        purposeOfUse: 'patient-self', details: { exchangeCount: result.rows.length } });
      return { exchanges: result.rows.reverse(), retentionDays: 30, limit: 10 };
    });
  }
  async clear(request: HidRequest) {
    const auth = await this.records.authorizeSelf(request);
    return this.database.withPatientTransaction(auth, request.correlationId, async client => {
      await this.lock(client, auth.patientId);
      await client.query('delete from ehr.patient_chat_messages where patient_id=$1', [auth.patientId]);
      await client.query('update ehr.patient_chat_state set generation=$2 where patient_id=$1', [auth.patientId, randomUUID()]);
      await this.audit.recordWithClient(client, { correlationId: request.correlationId, actorType: 'patient',
        actorSubject: auth.subject, actorAccountId: auth.accountId, patientId: auth.patientId,
        action: 'ehr.patient.chat.history.clear', resourceType: 'patient-chat-history', outcome: 'success',
        purposeOfUse: 'patient-self', details: {} });
      return { cleared: true };
    });
  }
}
