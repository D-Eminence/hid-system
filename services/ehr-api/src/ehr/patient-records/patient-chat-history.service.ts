import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { createHash,randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../../audit/audit.service';
import { DomainProblem } from '../../common/problem';
import type { HidRequest } from '../../common/request-context';
import { PatientRecordsService } from './patient-records.service';

import { PatientEvidenceService } from './patient-evidence.service';
import { binding,evidenceKey,type Evidence,type EvidenceBinding,type EvidenceReference,type Coverage } from './patient-evidence.types';

type Authorization = Awaited<ReturnType<PatientRecordsService['authorizeSelf']>>;
export interface ChatReply {
  status: 'ready' | 'preparing'; answer: string;
  sources: Array<EvidenceReference | { number:number;noteId:string;revisionNo:number;title:string;signedAt:Date|string }>;
  coverage?:Coverage;
}
export type ContextBinding = EvidenceBinding | { noteId:string;revisionNo:number;hash:string };
interface HistoryRow { id: string; question: string; reply: ChatReply; createdAt: Date; sourceBindings: ContextBinding[] }
@Injectable()
export class PatientChatHistoryService {
  constructor(private readonly database: DatabaseService, private readonly records: PatientRecordsService,
    private readonly audit: AuditService,private readonly evidence:PatientEvidenceService) {}

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
  private async documentBindings(request:HidRequest):Promise<string[]> {
    const auth=await this.records.authorizeSelf(request);
    return this.database.withPatientTransaction(auth,request.correlationId,async client=>{
      const rows=(await client.query(`select source_bindings as bindings from ehr.patient_chat_messages where patient_id=$1
       and created_at>statement_timestamp()-interval '30 days' order by created_at desc,id desc limit 10`,[auth.patientId])).rows;
      return [...new Set(rows.flatMap(r=>(r.bindings as ContextBinding[]).filter(b=>'kind' in b&&['document','attachment'].includes(b.kind)).map(b=>(b as EvidenceBinding).id)))];
    });
  }
  async start(request: HidRequest, authorization: Authorization): Promise<string> {
    return this.database.withPatientTransaction(authorization, request.correlationId,
      client => this.lock(client, authorization.patientId));
  }
  async save(request: HidRequest, generation: string, question: string, reply: ChatReply,
    contextBindings: readonly ContextBinding[] = []) {
    if (!reply.answer.trim() || reply.answer.length > 4000) {
      throw new DomainProblem(503, 'PATIENT_CHAT_UNAVAILABLE', 'Patient chat is temporarily unavailable');
    }
    await this.records.authorizeSelf(request);
    const snapshot=await this.evidence.snapshot(request,undefined,[...new Set([...await this.documentBindings(request),
      ...contextBindings.filter(b=>'kind' in b&&['document','attachment'].includes(b.kind)).map(b=>(b as EvidenceBinding).id),
      ...reply.sources.filter(s=>'kind' in s&&['document','attachment'].includes(s.kind)).map(s=>(s as EvidenceBinding).id)])]);
    const auth=await this.records.authorizeSelf(request);
    const current=new Map(snapshot.records.map(r=>[evidenceKey(r),r]));
    await this.database.withPatientTransaction(auth, request.correlationId, async client => {
      if (await this.lock(client, auth.patientId) !== generation) {
        throw new DomainProblem(409, 'CHAT_CONVERSATION_CHANGED', 'The conversation was cleared. Please ask again.');
      }
      const bindings:EvidenceBinding[]=[];
      for(const previous of contextBindings) {
        const resolved=this.resolve(previous,current);
        if(!resolved)throw new DomainProblem(409,'CHAT_SOURCES_CHANGED','The source records changed during this request');
        if(!bindings.some(b=>evidenceKey(b)===evidenceKey(resolved)))bindings.push(resolved);
      }
      for(const source of reply.sources) {
        const kind='noteId' in source?'note':source.kind;
        const id='noteId' in source?source.noteId:source.id;
        const version='noteId' in source?String(source.revisionNo):source.version;
        const r=current.get(`${kind}:${id}`);
        if(!r||r.version!==version||('hash' in source&&source.hash!==r.hash))
          throw new DomainProblem(409,'CHAT_SOURCES_CHANGED','The source records changed during this request');
        const prior=bindings.find(b=>evidenceKey(b)===evidenceKey(r));
        if(prior&&prior.hash!==r.hash)throw new DomainProblem(409,'CHAT_SOURCES_CHANGED','The source records changed during this request');
        if(!prior)bindings.push(binding(r));
      }
      const storedReply={...reply,sources:reply.sources.map(source=>{const {hash:_hash,...safe}=source as unknown as Record<string,unknown>;return safe;})};
      await client.query(`insert into ehr.patient_chat_messages(patient_id,generation,question,reply,source_bindings)
        values ($1,$2,$3,$4::jsonb,$5::jsonb)`, [auth.patientId, generation, question, JSON.stringify(storedReply), JSON.stringify(bindings)]);
      await this.prune(client, auth.patientId);
      await this.audit.recordWithClient(client, { correlationId: request.correlationId, actorType: 'patient',
        actorSubject: auth.subject, actorAccountId: auth.accountId, patientId: auth.patientId,
        action: 'ehr.patient.chat.history.save', resourceType: 'patient-chat-history', outcome: 'success',
        purposeOfUse: 'patient-self', details: { sourceCount: reply.sources.length } });
    });
  }
  async read(request: HidRequest) {
    await this.records.authorizeSelf(request);
    const snapshot=await this.evidence.snapshot(request,undefined,await this.documentBindings(request));
    const auth=await this.records.authorizeSelf(request);
    return this.database.withPatientTransaction(auth, request.correlationId, async client => {
      await this.lock(client, auth.patientId);
      await this.prune(client, auth.patientId);
      const exchanges = await this.readCurrent(client, auth.patientId,snapshot.records,snapshot.coverage.unavailable);
      await this.audit.recordWithClient(client, { correlationId: request.correlationId, actorType: 'patient',
        actorSubject: auth.subject, actorAccountId: auth.accountId, patientId: auth.patientId,
        action: 'ehr.patient.chat.history.read', resourceType: 'patient-chat-history', outcome: 'success',
        purposeOfUse: 'patient-self', details: { exchangeCount: exchanges.length } });
      return { exchanges: exchanges.map(({ sourceBindings: _bindings, ...exchange }) => exchange), retentionDays: 30, limit: 10 };
    });
  }
  private resolve(raw:ContextBinding,current:Map<string,Evidence>):EvidenceBinding|null {
    const kind='noteId' in raw?'note':raw.kind,id='noteId' in raw?raw.noteId:raw.id;
    const version='noteId' in raw?String(raw.revisionNo):raw.version;
    const r=current.get(`${kind}:${id}`);
    if(!r||r.version!==version)return null;
    const hash='noteId' in raw?createHash('sha256').update(String(r.fields.text??'')).digest('hex'):r.hash;
    return raw.hash===hash?binding(r):null;
  }
  private async readCurrent(client:PoolClient,patientId:string,records:Evidence[],unavailable:readonly string[]=[]):Promise<HistoryRow[]> {
    const result=await client.query<HistoryRow>(`select h.id,h.question,h.reply,h.created_at as "createdAt",h.source_bindings as "sourceBindings"
      from ehr.patient_chat_messages h where h.patient_id=$1 and h.created_at>statement_timestamp()-interval '30 days'
      order by h.created_at desc,h.id desc limit 10`,[patientId]);
    const current=new Map(records.map(r=>[evidenceKey(r),r]));
    if(unavailable.length && result.rows.some(row=>row.sourceBindings.some(b=>'kind' in b&&b.kind==='lab_result')))
      throw new DomainProblem(503,'CHAT_HISTORY_SOURCE_UNAVAILABLE','Saved conversation evidence is temporarily unavailable. Please try again.');
    return result.rows.filter(row=>Array.isArray(row.sourceBindings)&&row.sourceBindings.every(b=>this.resolve(b,current)))
      .map(row=>({...row,sourceBindings:row.sourceBindings.map(b=>this.resolve(b,current)!)})).reverse();
  }
  async context(request: HidRequest, generation: string) {
    await this.records.authorizeSelf(request);
    const snapshot=await this.evidence.snapshot(request,undefined,await this.documentBindings(request));
    const auth=await this.records.authorizeSelf(request);
    return this.database.withPatientTransaction(auth, request.correlationId, async client => {
      if (await this.lock(client, auth.patientId) !== generation) {
        throw new DomainProblem(409, 'CHAT_CONVERSATION_CHANGED', 'The conversation was cleared. Please ask again.');
      }
      await this.prune(client, auth.patientId);
      const exchanges = (await this.readCurrent(client, auth.patientId,snapshot.records,snapshot.coverage.unavailable)).filter(exchange => exchange.reply.status === 'ready').slice(-4);
      const bindings = new Map<string, ContextBinding>();
      for (const exchange of exchanges) for (const binding of exchange.sourceBindings) bindings.set(evidenceKey(binding as EvidenceBinding), binding);
      await this.audit.recordWithClient(client, { correlationId: request.correlationId, actorType: 'patient',
        actorSubject: auth.subject, actorAccountId: auth.accountId, patientId: auth.patientId,
        action: 'ehr.patient.chat.context.read', resourceType: 'patient-chat-history', outcome: 'success',
        purposeOfUse: 'patient-self', details: { exchangeCount: exchanges.length } });
      return { exchanges: exchanges.map(exchange => ({ question: exchange.question, answer: exchange.reply.answer })),
        bindings: [...bindings.values()] };
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
