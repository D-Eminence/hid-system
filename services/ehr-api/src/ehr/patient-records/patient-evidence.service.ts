import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { DomainProblem } from '../../common/problem';
import type { HidRequest } from '../../common/request-context';
import { PatientRecordsService } from './patient-records.service';
import { LabApiService } from '../../integrations/lab-api.service';
import { AuditService } from '../../audit/audit.service';
import { PATIENT_EVIDENCE_QUERY } from './patient-evidence.query';
import { patientEvidence,type PatientProfileInput } from './patient-evidence.policy';
import { PatientAttachmentTextService } from './patient-attachment-text.service';
import { IdentityApiService } from '../../integrations/identity-api.service';
import { evidence,evidenceKey,type Evidence,type EvidenceSnapshot,type EvidenceBinding,type SourceKind } from './patient-evidence.types';

const iso=(value:unknown):string|null=>value instanceof Date?value.toISOString():typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
@Injectable()
export class PatientEvidenceService {
  constructor(private readonly database:DatabaseService,private readonly records:PatientRecordsService,
    private readonly lab:LabApiService,private readonly audit:AuditService,private readonly attachments:PatientAttachmentTextService,
    private readonly identity:IdentityApiService) {}

  async prepareDocuments(request:HidRequest,signal:AbortSignal):Promise<string[]> {
    try {await this.attachments.prepare(request,signal);return [];}
    catch(error) {
      if(signal.aborted || (error instanceof DomainProblem && [401,403].includes(error.getStatus())))throw error;
      return ['Document extraction unavailable; some attachment contents are not included'];
    }
  }

  async local(client:PoolClient,patientId:string):Promise<{records:Evidence[];complete:boolean}> {
    const records:Evidence[]=[];let kind='',id='';let complete=false;
    for(let page=0;page<10;page++) {
      const rows=(await client.query(PATIENT_EVIDENCE_QUERY,[patientId,kind,id])).rows;
      // Patient-self RLS already limits rows to this patient; a row of anyone else is refused, never shown.
      if(rows.some(r=>r.patient_id!==patientId))throw new DomainProblem(403,'PATIENT_ACCESS_DENIED','Patient evidence authorization changed');
      for(const r of rows.slice(0,200)) records.push(evidence({kind:r.kind as SourceKind,id:r.id,version:r.version,
        title:r.title,recordedAt:iso(r.recorded_at),effectiveAt:iso(r.effective_at),provenance:r.provenance,quality:r.quality,fields:r.fields,
        originHint:r.origin_hint}));
      if(rows.length<=200){complete=true;break;}
      const last=rows[199];kind=last.kind;id=last.id;
    }
    return {records,complete};
  }
  /**
   * The patient's name and date of birth, used only to clean free text (the
   * records, and the patient's own question) before it reaches a model, the
   * index or saved history. Never sent anywhere itself.
   */
  async redactionProfile(request:HidRequest):Promise<PatientProfileInput> {
    const auth=await this.records.authorizeSelf(request);
    return (await this.profile(request,auth.patientId)).identity;
  }
  private async profile(request:HidRequest,patientId:string) {
    const profile=await this.identity.patientProfile(request);
    if(profile.patientId!==patientId)throw new DomainProblem(403,'PATIENT_ACCESS_DENIED','Patient profile authorization changed');
    // Name and date of birth are used only to clean the records and the question; the
    // chat itself sees the patient's age and sex (patient-evidence.policy.ts).
    const identity:PatientProfileInput={firstName:profile.firstName,lastName:profile.lastName,fullName:profile.fullName,
      dateOfBirth:profile.dateOfBirth,gender:profile.gender};
    return {identity,profile};
  }
  async snapshot(request:HidRequest,signal?:AbortSignal,documentIds?:readonly string[]):Promise<EvidenceSnapshot> {
    const auth=await this.records.authorizeSelf(request);
    const local=await this.database.withPatientTransaction(auth,request.correlationId,async client=>{
      const value=await this.local(client,auth.patientId);
      await this.audit.recordWithClient(client,{correlationId:request.correlationId,actorType:'patient',actorSubject:auth.subject,
        actorAccountId:auth.accountId,patientId:auth.patientId,action:'ehr.patient.chat.evidence.read',resourceType:'patient-evidence',
        outcome:'success',purposeOfUse:'patient-self',details:{recordCount:value.records.length,complete:value.complete}});
      return value;
    });
    const unavailable:string[]=[];let cursor:string|undefined;let labComplete=false;
    const {identity,profile}=await this.profile(request,auth.patientId);
    local.records.push(evidence({kind:'profile',id:auth.patientId,version:String(profile.version),title:'Age and sex',recordedAt:null,effectiveAt:null,
      provenance:'Health ID patient profile',quality:'recorded',fields:{}}));
    try {
      const cursors=new Set<string>();
      for(let page=0;page<10;page++) {
        signal?.throwIfAborted();
        const result=await this.lab.patientReleasedResults(request,cursor,signal);
        for(const r of result.records) local.records.push(evidence({kind:'lab_result',id:r.id,version:r.version,
          title:r.title,recordedAt:r.recordedAt,effectiveAt:r.effectiveAt,provenance:'Released laboratory result',quality:'verified and released',fields:r.fields}));
        if(!result.nextCursor){labComplete=true;break;}
        if(cursors.has(result.nextCursor))throw new Error('Repeated Lab cursor');
        cursors.add(result.nextCursor);cursor=result.nextCursor;
      }
    } catch(error) {
      if(signal?.aborted)throw error;
      if(error instanceof DomainProblem && error.getStatus()<500 && error.getStatus()!==404)throw error;
      unavailable.push('Laboratory service unavailable; result coverage is unknown');
      // Do not use a partial, failed multi-page Lab response as a complete history.
      local.records=local.records.filter(r=>r.kind!=='lab_result');
    }
    const documents=await this.attachments.read(request,signal,documentIds);
    local.records.push(...documents.records);
    const records=patientEvidence(local.records,identity,new Date());
    return {records,coverage:{complete:local.complete&&labComplete&&documents.complete&&documents.pending===0,
      unavailable,pendingDocuments:documents.pending,recordCount:records.length,selectedCount:0}};
  }
  async assertCurrent(request:HidRequest,bindings:readonly EvidenceBinding[]) {
    if(!bindings.length){await this.records.authorizeSelf(request);return;}
    const snapshot=await this.snapshot(request,undefined,bindings.filter(b=>b.kind==='document'||b.kind==='attachment').map(b=>b.id));
    const current=new Map(snapshot.records.map(r=>[evidenceKey(r),r]));
    for(const b of bindings) {
      const value=current.get(evidenceKey(b));
      if(!value||value.version!==b.version||value.hash!==b.hash)throw new DomainProblem(409,'CHAT_SOURCES_CHANGED','The source records changed or became unavailable. Please ask again.');
    }
  }
}
