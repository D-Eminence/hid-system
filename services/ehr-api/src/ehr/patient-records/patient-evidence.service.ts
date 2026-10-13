import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { DomainProblem } from '../../common/problem';
import type { HidRequest } from '../../common/request-context';
import { PatientRecordsService } from './patient-records.service';
import { LabApiService } from '../../integrations/lab-api.service';
import { AuditService } from '../../audit/audit.service';
import { LOCAL_EVIDENCE_QUERY } from './patient-evidence.query';
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
      const rows=(await client.query(LOCAL_EVIDENCE_QUERY,[patientId,kind,id])).rows;
      for(const r of rows.slice(0,200)) records.push(evidence({kind:r.kind as SourceKind,id:r.id,version:r.version,
        title:r.title,recordedAt:iso(r.recorded_at),effectiveAt:iso(r.effective_at),provenance:r.provenance,quality:r.quality,fields:r.fields}));
      if(rows.length<=200){complete=true;break;}
      const last=rows[199];kind=last.kind;id=last.id;
    }
    return {records,complete};
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
    const profile=await this.identity.patientProfile(request);
    if(profile.patientId!==auth.patientId)throw new DomainProblem(403,'PATIENT_ACCESS_DENIED','Patient profile authorization changed');
    local.records.push(evidence({kind:'profile',id:auth.patientId,version:String(profile.version),title:'Patient profile',recordedAt:null,effectiveAt:null,
      provenance:'Health ID patient profile',quality:'recorded',fields:{dateOfBirth:profile.dateOfBirth??null,gender:profile.gender??null,
        firstName:profile.firstName??null,lastName:profile.lastName??null,fullName:profile.fullName??null,
        country:profile.country??null,state:profile.state??null}}));
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
    return {records:local.records,coverage:{complete:local.complete&&labComplete&&documents.complete&&documents.pending===0,
      unavailable,pendingDocuments:documents.pending,recordCount:local.records.length,selectedCount:0}};
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
  async source(request:HidRequest,kind:string,id:string) {
    const snapshot=await this.snapshot(request,undefined,['document','attachment'].includes(kind)?[id]:[]);
    const source=snapshot.records.find(r=>r.kind===kind&&r.id===id);
    if(!source)throw new DomainProblem(404,'CHAT_SOURCE_UNAVAILABLE','This source is unavailable');
    await this.records.authorizeSelf(request);
    return source;
  }
}
