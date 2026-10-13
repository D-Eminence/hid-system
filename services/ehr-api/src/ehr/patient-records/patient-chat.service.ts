import { Injectable } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { DomainProblem } from '../../common/problem';
import type { HidRequest } from '../../common/request-context';
import { getEnvironment } from '../../config/environment';
import { DatabaseService } from '../../database/database.service';
import { BedrockAiService } from './bedrock-ai.service';
import { ClaudeAiService, type ConversationExchange } from './claude-ai.service';
import { PatientRecordsService } from './patient-records.service';
import { PatientEvidenceService } from './patient-evidence.service';
import { binding,chunks,evidenceKey,type Evidence } from './patient-evidence.types';
import { selectEvidence,answerCoverage,boundEvidence } from './patient-evidence.selection';
import { PatientChatHistoryService, type ChatReply } from './patient-chat-history.service';

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
    private readonly claude: ClaudeAiService,
    private readonly audit: AuditService,
    private readonly history: PatientChatHistoryService,
    private readonly evidence:PatientEvidenceService,
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
      const generation = await this.history.start(request, authorization);
      const context = await this.history.context(request, generation);
      const signal = AbortSignal.timeout(60_000);
      const plan = await this.claude.plan(question, context.exchanges, signal);
      const reply: ChatReply = plan.intent === 'conversation'
        ? { status: 'ready', answer: plan.answer, sources: [] }
        : await this.answerAuthorized(request, question, plan.query, context.exchanges, environment, signal,plan.recordIntent);
      await this.history.save(request, generation, question, reply, context.bindings);
      return { ...reply,sources:reply.sources.map(source=>{const {hash:_hash,...safe}=source as unknown as Record<string,unknown>;return safe;}) };
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

  private async answerAuthorized(request:HidRequest,question:string,searchQuestion:string,
    history:readonly ConversationExchange[],
    environment:ReturnType<typeof getEnvironment>,signal:AbortSignal,recordIntent:import('./patient-evidence.types').RecordIntent='search'):Promise<ChatReply> {
    const extractionWarnings=await this.evidence.prepareDocuments(request,signal);
    const snapshot=await this.evidence.snapshot(request,signal);
    snapshot.coverage.unavailable.push(...extractionWarnings);
    if(extractionWarnings.length)snapshot.coverage.complete=false;
    let selection=selectEvidence(snapshot.records,recordIntent,searchQuestion);
    if(recordIntent==='search'&&snapshot.records.length)selection=await this.semantic(request,snapshot.records,searchQuestion,environment,signal);
    const coverage=answerCoverage(snapshot.coverage,selection.sources.length,selection.partial);
    await this.records.authorizeSelf(request);signal.throwIfAborted();
    const generated=await this.claude.answer(question,selection.sources,history,signal,coverage);
    const citations=[...generated.matchAll(/\[(\d+)\]/g)].map(match=>Number(match[1]));
    const valid=selection.sources.length?citations.length>0&&citations.every(n=>n>=1&&n<=selection.sources.length):citations.length===0;
    // Currentness/authorization is checked before save and return; an index is
    // never evidence by itself. Citation validation does not prove model fidelity.
    await this.evidence.assertCurrent(request,selection.sources.map(binding));
    const auth=await this.records.authorizeSelf(request);
    await this.database.withPatientTransaction(auth,request.correlationId,client=>this.audit.recordWithClient(client,{
      correlationId:request.correlationId,actorType:'patient',actorSubject:auth.subject,actorAccountId:auth.accountId,
      patientId:auth.patientId,action:'ehr.patient.chat.answer',resourceType:'patient-evidence',outcome:valid?'success':'failure',
      purposeOfUse:'patient-self',details:{sourceCount:selection.sources.length,citationsValid:valid,complete:coverage.complete}}));
    return {status:'ready',answer:valid?generated:NO_GROUNDED_ANSWER,coverage,
      sources:valid?selection.sources.map((source,index)=>({...binding(source),number:index+1,title:source.title,
        recordedAt:source.recordedAt,effectiveAt:source.effectiveAt,provenance:source.provenance,quality:source.quality})):[]};
  }

  private async semantic(request:HidRequest,records:Evidence[],question:string,
    env:ReturnType<typeof getEnvironment>,signal:AbortSignal) {
    const auth=await this.records.authorizeSelf(request);
    const currentKeys=records.map(r=>`${evidenceKey(r)}:${r.version}:${r.hash}`);
    const existing=await this.database.withPatientTransaction(auth,request.correlationId,async client=>(await client.query(
      `select source_kind,source_id,source_version,source_hash,chunk_no from ehr.patient_evidence_chunks
       where patient_id=$1 and model_id=$2 and normalizer_version=1
       and source_kind||':'||source_id::text||':'||source_version||':'||source_hash=any($3::text[])`,
      [auth.patientId,env.AI_EMBEDDING_MODEL_ID,currentKeys])).rows);
    const keys=new Set(existing.map(r=>`${r.source_kind}:${r.source_id}:${r.source_version}:${String(r.source_hash).trim()}:${r.chunk_no}`));
    const missing=records.flatMap(source=>chunks(source).slice(0,1000).map((text,no)=>({source,text,no})))
      .filter(c=>!keys.has(`${evidenceKey(c.source)}:${c.source.version}:${c.source.hash}:${c.no}`));
    const fresh=await Promise.all(missing.slice(0,4).map(async c=>({...c,vector:await this.bedrock.embed(c.text,signal)})));
    if(fresh.length) {
      await this.evidence.assertCurrent(request,fresh.map(c=>binding(c.source)));
      const refreshed=await this.records.authorizeSelf(request);
      await this.database.withPatientTransaction(refreshed,request.correlationId,async client=>{
        for(const c of fresh)await client.query(`insert into ehr.patient_evidence_chunks
          (patient_id,source_kind,source_id,source_version,source_hash,chunk_no,model_id,embedding)
          values($1,$2,$3,$4,$5,$6,$7,$8::vector) on conflict do nothing`,
          [refreshed.patientId,c.source.kind,c.source.id,c.source.version,c.source.hash,c.no,env.AI_EMBEDDING_MODEL_ID,JSON.stringify(c.vector)]);
        // Remove obsolete derived vectors only; authoritative clinical rows stay intact.
        await client.query(`delete from ehr.patient_evidence_chunks where patient_id=$1 and
          source_kind||':'||source_id::text=any($3::text[]) and
          not(source_kind||':'||source_id::text||':'||source_version||':'||source_hash=any($2::text[]))`,[refreshed.patientId,currentKeys,records.map(evidenceKey)]);
      });
    }
    const vector=await this.bedrock.embed(question,signal);
    const current=await this.records.authorizeSelf(request);
    const ranked=await this.database.withPatientTransaction(current,request.correlationId,async client=>(await client.query(
      `select source_kind,source_id,chunk_no from ehr.patient_evidence_chunks
       where patient_id=$1 and model_id=$2 and normalizer_version=1
       and source_kind||':'||source_id::text||':'||source_version||':'||source_hash=any($3::text[])
       order by embedding<=>$4::vector limit 12`,[current.patientId,env.AI_EMBEDDING_MODEL_ID,currentKeys,JSON.stringify(vector)])).rows);
    const byKey=new Map(records.map(r=>[evidenceKey(r),r]));const selected=new Map<string,Evidence>();
    for(const row of ranked) {
      const r=byKey.get(`${row.source_kind}:${row.source_id}`);if(!r)continue;
      const text=chunks(r)[row.chunk_no];if(!text)continue;
      const prior=selected.get(evidenceKey(r));selected.set(evidenceKey(r),{...r,content:prior?prior.content+'\n'+text:text});
    }
    // Unindexed current sources remain searchable through literal evidence
    // matching. Never describe a partially indexed collection as complete.
    const terms=question.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter(t=>t.length>3)??[];
    for(const r of records.filter(r=>terms.some(t=>r.content.toLowerCase().includes(t))).slice(0,5)) {
      if(!selected.has(evidenceKey(r)))selected.set(evidenceKey(r),{...r,content:r.content.slice(0,12000)});
    }
    const bounded=boundEvidence([...selected.values()],12);
    const sources=bounded.sources;
    return {sources,partial:bounded.partial||missing.length>fresh.length||sources.length<records.length||sources.some(r=>r.content!==byKey.get(evidenceKey(r))!.content)};
  }
}
