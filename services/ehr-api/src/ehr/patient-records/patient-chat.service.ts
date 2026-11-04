import type { ChatAccess,ChatAudience } from './chat-access';
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
import { binding,chunks,evidenceKey,originLabel,type Coverage,type Evidence,type EvidenceBinding } from './patient-evidence.types';
import { selectEvidence,answerCoverage,boundEvidence } from './patient-evidence.selection';
import { PatientChatHistoryService, type ChatReply } from './patient-chat-history.service';
import { citedNumbers,conversationLines,patientLines,withPatientLines } from './patient-chat-safety';
import { redactIdentifiers } from './patient-evidence.policy';

const NO_GROUNDED_ANSWER = 'I could not verify an answer from the available records.';
const unavailable = () => new DomainProblem(503, 'PATIENT_CHAT_UNAVAILABLE', 'Patient chat is temporarily unavailable');
/** Record kinds read by the local evidence query (everything except Lab and documents). */
const LOCAL_KINDS = ['note','encounter','diagnosis','prescription','investigation','vital','import','import_version','health_profile','profile'];
const LOCAL_PAGE_LIMIT = 2000;
/** A search question about the patient's age or sex, answered from the age-and-sex profile. */
const AGE_OR_SEX = /\b(?:age|aged|old|older|born|birthday|sex|gender|male|female|man|woman|boy|girl)\b/i;

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

  async answer(request: HidRequest, rawQuestion: string, access: ChatAccess = this.selfAccess()) {
    const environment = getEnvironment();
    if (!environment.AI_ENABLED) throw new DomainProblem(503, 'PATIENT_CHAT_DISABLED', 'Patient chat is not enabled');
    const typed = rawQuestion.trim();
    if (!typed || typed.length > 500) {
      throw new DomainProblem(400, 'INVALID_QUESTION', 'A question of 1 to 500 characters is required');
    }
    const audience = this.audienceOf(access);
    const authorization = await access.authorize(request);
    // One patient per turn: every later authorization must be for the same patient.
    const turn: ChatAccess = { ...access, authorize: async current => {
      const next = await access.authorize(current);
      if (next.patientId !== authorization.patientId) {
        throw new DomainProblem(409, 'CHAT_ACCESS_CHANGED', 'Patient access changed. Please ask again.');
      }
      return next;
    } };
    const release = this.admit(access.admissionKey || authorization.patientId);
    try {
      const generation = await turn.history.start(request, authorization);
      const saved = await turn.history.context(request, generation);
      // Patient chat: the question goes to Claude and Bedrock, and into history, without the
      // patient's identifiers; so do the earlier questions and answers replayed from history (an
      // answer saved before questions were cleaned may repeat the name). Staff keep theirs as typed.
      const clean = await this.identifierCleaner(request, turn, audience);
      // A removed identifier can be longer than what it replaces; the question stays within its 500-character limit.
      const question = clean(typed).slice(0, 500);
      const context = { ...saved, exchanges: saved.exchanges.map(e => ({ ...e, question: clean(e.question), answer: clean(e.answer) })) };
      const signal = AbortSignal.timeout(60_000);
      const plan = await this.claude.plan(question, context.exchanges, signal, audience);
      let reply: ChatReply; let selected: EvidenceBinding[] = [];
      if (plan.intent === 'conversation') {
        // A conversation reply after record answers may still speak about those results:
        // the lines follow the sources those answers cite, not every source they selected.
        const lines = audience === 'patient' ? conversationLines(context.exchanges.map(e => e.answer), context.cited ?? []) : [];
        reply = { status: 'ready', answer: withPatientLines(plan.answer, lines), sources: [] };
      } else {
        ({ reply, selected } = await this.answerAuthorized(request, question, plan.query, context.exchanges, environment, signal,plan.recordIntent,turn));
      }
      // Patients see only cited sources, but saved history stays bound to every selected one,
      // so the exchange is hidden once any of them changes or is withdrawn.
      await turn.history.save(request, generation, question, reply, [...context.bindings, ...selected]);
      await turn.authorize(request);
      return { ...reply,sources:reply.sources.map(source=>{const {hash:_hash,...safe}=source as unknown as Record<string,unknown>;return safe;}) };
    } catch (error) {
      if (error instanceof DomainProblem) throw error;
      throw unavailable();
    } finally { release(); }
  }

  /** The audience is set by the server's access strategy and must agree with who is auditing. */
  private audienceOf(access: ChatAccess): ChatAudience {
    const audience = access.audience;
    if ((audience !== 'patient' && audience !== 'staff') || (audience === 'staff') !== (access.audit.actorType === 'staff')) throw unavailable();
    return audience;
  }

  /** The profile is read for the authorized patient; the turn's authorize() then refuses a changed patient. */
  private async identifierCleaner(request: HidRequest, access: ChatAccess, audience: ChatAudience): Promise<(q: string) => string> {
    if (audience === 'staff') return q => q;
    if (!access.redactionProfile) throw unavailable();
    const profile = await access.redactionProfile(request);
    await access.authorize(request);
    return q => redactIdentifiers(q, profile);
  }

  private selfAccess(): ChatAccess {
    return {
      audience: 'patient', admissionKey: '', chunksTable: 'ehr.patient_evidence_chunks',
      audit: { actorType: 'patient', purposeOfUse: 'patient-self' },
      authorize: request => this.records.authorizeSelf(request),
      transaction: (auth, correlationId, operation) => this.database.withPatientTransaction(
        auth as Awaited<ReturnType<PatientRecordsService['authorizeSelf']>>, correlationId, operation),
      evidence: this.evidence,
      redactionProfile: request => this.evidence.redactionProfile(request),
      history: { context: this.history.context.bind(this.history), save: this.history.save.bind(this.history),
        start: (request, auth) => this.history.start(request, auth as Awaited<ReturnType<PatientRecordsService['authorizeSelf']>>) },
    };
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
    environment:ReturnType<typeof getEnvironment>,signal:AbortSignal,recordIntent:import('./patient-evidence.types').RecordIntent='search',access:ChatAccess=this.selfAccess()):Promise<{reply:ChatReply;selected:EvidenceBinding[]}> {
    const audience=this.audienceOf(access);
    const extractionWarnings=await access.evidence.prepareDocuments(request,signal);
    const snapshot=await access.evidence.snapshot(request,signal);
    snapshot.coverage.unavailable.push(...extractionWarnings);
    if(extractionWarnings.length)snapshot.coverage.complete=false;
    let selection=selectEvidence(snapshot.records,recordIntent,searchQuestion);
    if(recordIntent==='search'&&snapshot.records.length)selection=await this.semantic(request,snapshot.records,searchQuestion,environment,signal,access,snapshot.coverage);
    const coverage=answerCoverage(snapshot.coverage,selection.sources.length,selection.partial);
    await access.authorize(request);signal.throwIfAborted();
    // Who reads the answer decides the origin wording ("You added this" to the patient, "Added by the patient" to staff).
    const generated=await this.claude.answer(question,selection.sources,history,signal,coverage,audience);
    const citations=[...generated.matchAll(/\[(\d+)\]/g)].map(match=>Number(match[1]));
    const valid=selection.sources.length?citations.length>0&&citations.every(n=>n>=1&&n<=selection.sources.length):citations.length===0;
    // Currentness/authorization is checked before save and return; an index is
    // never evidence by itself. Citation validation does not prove model fidelity.
    await access.evidence.assertCurrent(request,selection.sources.map(binding));
    const auth=await access.authorize(request);
    await access.transaction(auth,request.correlationId,client=>this.audit.recordWithClient(client,{
      correlationId:request.correlationId,...access.audit,actorSubject:auth.subject,actorAccountId:auth.accountId,
      patientId:auth.patientId,action:'ehr.patient.chat.answer',resourceType:'patient-evidence',outcome:valid?'success':'failure',
      details:{sourceCount:selection.sources.length,citationsValid:valid,complete:coverage.complete}}));
    const sources=valid?selection.sources.map((source,index)=>({...binding(source),number:index+1,title:source.title,
        recordedAt:source.recordedAt,effectiveAt:source.effectiveAt,provenance:source.provenance,quality:source.quality,
        origin:source.origin,originLabel:originLabel(source.origin,audience)})):[];
    if(audience==='staff'||!valid)return {reply:{status:'ready',answer:valid?generated:NO_GROUNDED_ANSWER,coverage,sources},selected:[]};
    const selected=selection.sources.map(binding);
    // Patient: the server, not the model, adds the follow-up lines for what the answer cites,
    // and the reply lists only the cited sources, keeping their numbers.
    const cited=citedNumbers(generated);
    const answer=withPatientLines(generated,patientLines(selection.sources.filter((_,index)=>cited.has(index+1))));
    return {reply:{status:'ready',answer,coverage,sources:sources.filter(source=>cited.has(source.number))},selected};
  }

  private async semantic(request:HidRequest,all:Evidence[],question:string,
    env:ReturnType<typeof getEnvironment>,signal:AbortSignal,access:ChatAccess=this.selfAccess(),coverage?:Coverage) {
    const patient=access.audience==='patient';
    // The patient's Health ID profile is never sent to Bedrock; literal matching below still sees it,
    // and it is added for a question about age or sex.
    const records=patient?all.filter(r=>r.kind!=='profile'):all;
    const auth=await access.authorize(request);
    const currentKeys=records.map(r=>`${evidenceKey(r)}:${r.version}:${r.hash}`);
    const existing=await access.transaction(auth,request.correlationId,async client=>(await client.query(
      `select source_kind,source_id,source_version,source_hash,chunk_no from ${access.chunksTable}
       where patient_id=$1 and model_id=$2 and normalizer_version=1
       and source_kind||':'||source_id::text||':'||source_version||':'||source_hash=any($3::text[])`,
      [auth.patientId,env.AI_EMBEDDING_MODEL_ID,currentKeys])).rows);
    const keys=new Set(existing.map(r=>`${r.source_kind}:${r.source_id}:${r.source_version}:${String(r.source_hash).trim()}:${r.chunk_no}`));
    const missing=records.flatMap(source=>chunks(source).slice(0,1000).map((text,no)=>({source,text,no})))
      .filter(c=>!keys.has(`${evidenceKey(c.source)}:${c.source.version}:${c.source.hash}:${c.no}`));
    const fresh=await Promise.all(missing.slice(0,4).map(async c=>({...c,vector:await this.bedrock.embed(c.text,signal)})));
    if(fresh.length) {
      await access.evidence.assertCurrent(request,fresh.map(c=>binding(c.source)));
      const refreshed=await access.authorize(request);
      await access.transaction(refreshed,request.correlationId,async client=>{
        for(const c of fresh)await client.query(`insert into ${access.chunksTable}
          (patient_id,source_kind,source_id,source_version,source_hash,chunk_no,model_id,embedding)
          values($1,$2,$3,$4,$5,$6,$7,$8::vector) on conflict do nothing`,
          [refreshed.patientId,c.source.kind,c.source.id,c.source.version,c.source.hash,c.no,env.AI_EMBEDDING_MODEL_ID,JSON.stringify(c.vector)]);
        // Remove obsolete derived vectors only; authoritative clinical rows stay intact.
        if(!patient)await client.query(`delete from ${access.chunksTable} where patient_id=$1 and
          source_kind||':'||source_id::text=any($3::text[]) and
          not(source_kind||':'||source_id::text||':'||source_version||':'||source_hash=any($2::text[]))`,[refreshed.patientId,currentKeys,records.map(evidenceKey)]);
      });
    }
    if(patient)await this.purgePatientChunks(request,access,records,currentKeys,all,coverage);
    const vector=await this.bedrock.embed(question,signal);
    const current=await access.authorize(request);
    const ranked=await access.transaction(current,request.correlationId,async client=>(await client.query(
      `select source_kind,source_id,chunk_no from ${access.chunksTable}
       where patient_id=$1 and model_id=$2 and normalizer_version=1
       and source_kind||':'||source_id::text||':'||source_version||':'||source_hash=any($3::text[])
       order by embedding<=>$4::vector limit 12`,[current.patientId,env.AI_EMBEDDING_MODEL_ID,currentKeys,JSON.stringify(vector)])).rows);
    const byKey=new Map(all.map(r=>[evidenceKey(r),r]));const selected=new Map<string,Evidence>();
    if(patient&&AGE_OR_SEX.test(question))for(const r of all.filter(r=>r.kind==='profile'))selected.set(evidenceKey(r),r);
    for(const row of ranked) {
      const r=byKey.get(`${row.source_kind}:${row.source_id}`);if(!r)continue;
      const text=chunks(r)[row.chunk_no];if(!text)continue;
      const prior=selected.get(evidenceKey(r));selected.set(evidenceKey(r),{...r,content:prior?prior.content+'\n'+text:text});
    }
    // Unindexed current sources remain searchable through literal evidence
    // matching. Never describe a partially indexed collection as complete.
    const terms=question.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter(t=>t.length>3)??[];
    for(const r of all.filter(r=>terms.some(t=>r.content.toLowerCase().includes(t))).slice(0,5)) {
      if(!selected.has(evidenceKey(r)))selected.set(evidenceKey(r),{...r,content:r.content.slice(0,12000)});
    }
    const bounded=boundEvidence([...selected.values()],12);
    const sources=bounded.sources;
    return {sources,partial:bounded.partial||missing.length>fresh.length||sources.length<records.length||sources.some(r=>r.content!==byKey.get(evidenceKey(r))!.content)};
  }

  /**
   * Patient chat only, on every search: delete derived vectors that no longer
   * match the current, cleaned snapshot (records now withheld from the
   * patient, changed records and the never-embedded profile), so they are not
   * kept. A kind is purged in full only when its coverage is complete, so a
   * Lab outage or a partial document read does not delete every vector of
   * that kind; for the rest only stale versions of listed records go.
   * The staff index is left as it was, because the staff snapshot follows the
   * staff member's permissions.
   */
  private async purgePatientChunks(request:HidRequest,access:ChatAccess,records:Evidence[],currentKeys:string[],all:Evidence[],coverage?:Coverage) {
    const unavailable=coverage?.unavailable??[];
    const local=all.filter(r=>LOCAL_KINDS.includes(r.kind)&&r.kind!=='profile').length;
    const complete=[...(coverage&&local<LOCAL_PAGE_LIMIT?LOCAL_KINDS:['profile']),
      ...(coverage&&!unavailable.some(u=>u.startsWith('Laboratory'))?['lab_result']:[])];
    const auth=await access.authorize(request);
    await access.transaction(auth,request.correlationId,client=>client.query(`delete from ${access.chunksTable} where patient_id=$1 and
      not(source_kind||':'||source_id::text||':'||source_version||':'||source_hash=any($2::text[])) and
      (source_kind=any($3::text[]) or source_kind||':'||source_id::text=any($4::text[]))`,
    [auth.patientId,currentKeys,complete,records.map(evidenceKey)]));
  }
}
