import type { AttachmentAccess,ChatAuthorization } from './chat-access';
import { Inject,Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TextractClient,StartDocumentTextDetectionCommand,GetDocumentTextDetectionCommand,type Block } from '@aws-sdk/client-textract';
import { S3Client,GetObjectCommand } from '@aws-sdk/client-s3';
import { STORAGE_PROVIDER,type StorageProvider } from '../../storage/storage.types';
import { DatabaseService } from '../../database/database.service';
import { PatientRecordsService } from './patient-records.service';
import { getEnvironment } from '../../config/environment';
import type { HidRequest } from '../../common/request-context';
import { evidence,type Evidence } from './patient-evidence.types';
import { DomainProblem } from '../../common/problem';

export const ATTACHMENT_TEXT_QUERY=`with files as (select 'attachment' kind,null::uuid facility_id,f.id,f.patient_id,f.source_created_at,
 f.source_payload->>'original_file_name' title,b.storage_bucket,b.storage_key,b.object_version_id,b.sha256_hex,b.size_bytes,
 s.result scan_result,s.detected_media_type,s.sequence_id scan_sequence,
 x.status,x.job_id,x.next_token,x.extracted_text,x.minimum_confidence,x.unclear_lines,x.page_count,x.started_at,x.updated_at,x.updated_at::text updated_at_token
 from ehr.imported_medical_record_files f left join ehr.imported_attachment_bindings b on b.file_id=f.id and b.patient_id=f.patient_id
 left join lateral(select result,detected_media_type,sequence_id from ehr.imported_attachment_scan_events
 where file_id=b.file_id and patient_id=b.patient_id and sha256_hex=b.sha256_hex and object_version_id=b.object_version_id
 order by sequence_id desc limit 1) s on true
 left join ehr.patient_attachment_extractions x on x.file_id=b.file_id and x.patient_id=b.patient_id
 and x.object_version_id=b.object_version_id and x.sha256_hex=b.sha256_hex and x.extractor_version=1
 where f.patient_id=$1
 union all select 'document' kind,d.facility_id,d.id,d.patient_id,d.created_at,d.original_file_name,
 d.storage_bucket,d.storage_key,d.object_version_id,d.sha256_hex,d.size_bytes,
 case when d.scan_status='clean' then 'clean' else d.scan_status end,d.detected_media_type,null::bigint,
 x.status,x.job_id,x.next_token,x.extracted_text,x.minimum_confidence,x.unclear_lines,x.page_count,x.started_at,x.updated_at,x.updated_at::text
 from ehr.documents_effective d left join ehr.patient_document_extractions x on x.file_id=d.id and x.patient_id=d.patient_id
 and x.object_version_id=d.object_version_id and x.sha256_hex=d.sha256_hex and x.extractor_version=1
 where d.patient_id=$1 and d.status='available') select * from files where($2::uuid[] is null or id=any($2::uuid[])) order by source_created_at desc,kind,id desc limit 201`;

export function readableLines(blocks:readonly Block[]) {
  let confidence=100,unclear=0,pages=0;const lines:string[]=[];
  const words=new Map(blocks.filter(b=>b.BlockType==='WORD'&&b.Id).map(b=>[b.Id!,b]));
  for(const block of blocks) {
    if(block.BlockType==='PAGE')pages++;
    if(block.BlockType!=='LINE')continue;
    const c=block.Confidence;
    const children=block.Relationships?.filter(r=>r.Type==='CHILD').flatMap(r=>r.Ids??[])??[];
    const wordUncertain=children.some(id=>{const w=words.get(id);return !w||typeof w.Confidence!=='number'||!Number.isFinite(w.Confidence)||w.Confidence<90;});
    if(typeof c!=='number'||!Number.isFinite(c)||c<90||wordUncertain){unclear++;lines.push('[Unclear line omitted]');continue;}
    confidence=Math.min(confidence,c);
    lines.push(`Page ${block.Page??'?'}: ${block.Text??''}`);
  }
  return {text:lines.join('\n'),confidence,unclear,pages};
}
@Injectable()
export class PatientAttachmentTextService {
  private readonly client=new TextractClient({region:getEnvironment().S3_REGION,maxAttempts:1});
  private readonly s3=new S3Client({region:getEnvironment().S3_REGION,maxAttempts:1});
  constructor(private readonly database:DatabaseService,private readonly records:PatientRecordsService,
    @Inject(STORAGE_PROVIDER) private readonly storage:StorageProvider) {}
  async read(request:HidRequest,signal?:AbortSignal,ids?:readonly string[],access:AttachmentAccess=this.selfAccess()):Promise<{records:Evidence[];pending:number;complete:boolean}> {
    const auth=await access.authorize(request);
    const rows=await access.transaction(auth,request.correlationId,async client=>(await client.query(access.query,[auth.patientId,ids??null])).rows);
    const eligible=rows.slice(0,200).filter(r=>r.scan_result==='clean'&&['ready','partial'].includes(r.status)&&r.extracted_text);
    const limit=ids?64:8;
    if(ids&&ids.length>64)throw new DomainProblem(409,'CHAT_CONTEXT_TOO_LARGE','Please start a new conversation to narrow the document context');
    const ready:typeof eligible=[];
    for(let offset=0;offset<Math.min(limit,eligible.length);offset+=4) {
      const batch=await Promise.all(eligible.slice(offset,Math.min(offset+4,limit)).map(async row=>{
        try {
          if(row.storage_bucket!==this.storage.bucket())return null;
          const actual=await this.storage.inspectVersion(row.storage_key,row.object_version_id,signal);
          return actual.versionId===row.object_version_id&&actual.sha256Hex===String(row.sha256_hex).trim()&&actual.sizeBytes===Number(row.size_bytes)?row:null;
        } catch {signal?.throwIfAborted();return null;}
      }));
      ready.push(...batch.filter((r):r is typeof eligible[number]=>r!==null));
    }
    await access.authorize(request);
    return {records:ready.map(r=>evidence({kind:r.kind,id:r.id,version:createHash('sha256').update(`${r.object_version_id}:1:${r.updated_at_token}`).digest('hex'),
      title:r.title??'Imported attachment',recordedAt:new Date(r.source_created_at).toISOString(),effectiveAt:null,
      provenance:r.kind==='document'?'Machine extracted clinical document; not clinician verified':'Machine extracted imported attachment; not clinician verified',quality:r.status==='partial'||r.unclear_lines?'uncertain or partial extraction':'machine extracted, unverified',
      fields:{text:r.extracted_text,extractionStatus:r.status,extractedAt:r.updated_at_token,unclearLines:r.unclear_lines,pages:r.page_count,minimumAcceptedLineConfidence:r.minimum_confidence}})),
      pending:rows.filter(r=>!ready.some(a=>a.id===r.id)).length,complete:rows.length<=200&&eligible.length<=limit};
  }
  async prepare(request:HidRequest,signal:AbortSignal,access:AttachmentAccess=this.selfAccess()) {
    const auth=await access.authorize(request);
    const rows=await access.transaction(auth,request.correlationId,async client=>(await client.query(access.query,[auth.patientId,null])).rows);
    const candidates=rows.filter(r=>r.scan_result==='clean'&&['application/pdf','image/png','image/jpeg','image/tiff','text/plain'].includes(r.detected_media_type)
      &&(!r.status||r.status==='processing')).slice(0,2);
    for(const row of candidates) {
      signal.throwIfAborted();
      if(row.storage_bucket!==this.storage.bucket())throw new DomainProblem(409,'ATTACHMENT_STORAGE_MISMATCH','Attachment storage is unavailable');
      const actual=await this.storage.inspectVersion(row.storage_key,row.object_version_id,signal);
      if(actual.sha256Hex!==String(row.sha256_hex).trim()||actual.sizeBytes!==Number(row.size_bytes)||actual.versionId!==row.object_version_id)
        throw new DomainProblem(409,'ATTACHMENT_INTEGRITY_MISMATCH','Attachment failed integrity verification');
      await access.authorize(request);
      if(!row.status) {
        const token=createHash('sha256').update(`${row.kind}:${row.id}:${row.object_version_id}:${row.sha256_hex}:extractor1`).digest('hex');
        if(row.detected_media_type==='text/plain') {
          const object=await this.s3.send(new GetObjectCommand({Bucket:row.storage_bucket,Key:row.storage_key,VersionId:row.object_version_id}),{abortSignal:signal});
          if(!object.Body||object.VersionId!==row.object_version_id)throw new Error('Invalid text object');
          const parts:Buffer[]=[];let size=0;const digest=createHash('sha256');
          for await(const part of object.Body as AsyncIterable<Uint8Array>) {
            signal.throwIfAborted();size+=part.length;if(size>20971520)throw new Error('Text object too large');
            digest.update(part);parts.push(Buffer.from(part));
          }
          if(size!==Number(row.size_bytes)||digest.digest('hex')!==String(row.sha256_hex).trim())throw new Error('Text integrity mismatch');
          const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts));
          const fresh=await access.authorize(request);
          await this.insert(request,row,fresh,access,{status:text.length>200000?'partial':text.trim()?'ready':'unreadable',job_id:'text-'+token.slice(0,59),extracted_text:text.slice(0,200000),page_count:1});
          continue;
        }
        const start=await this.client.send(new StartDocumentTextDetectionCommand({ClientRequestToken:token,
          DocumentLocation:{S3Object:{Bucket:row.storage_bucket,Name:row.storage_key,Version:row.object_version_id}}}),{abortSignal:signal});
        if(!start.JobId)throw new Error('Invalid extraction response');
        const fresh=await access.authorize(request);
        await this.insert(request,row,fresh,access,{status:'processing',job_id:start.JobId});
        continue;
      }
      if(Date.now()-new Date(row.started_at).getTime()>6*86400000) {
        const fresh=await access.authorize(request);
        await access.transaction(fresh,request.correlationId,client=>client.query(
          `update ${access.table(row.kind)} set status='failed',updated_at=clock_timestamp()
           where file_id=$1 and patient_id=$2 and job_id=$3`,[row.id,fresh.patientId,row.job_id]));
        continue;
      }
      const result=await this.client.send(new GetDocumentTextDetectionCommand({JobId:row.job_id,NextToken:row.next_token??undefined,MaxResults:1000}),{abortSignal:signal});
      if(result.JobStatus==='IN_PROGRESS')continue;
      const extracted=readableLines(result.Blocks??[]);
      const text=[row.extracted_text,extracted.text].filter(Boolean).join('\n');
      const status=result.JobStatus==='FAILED'?'failed':text.length>200000?'partial':result.NextToken?'processing':
        result.JobStatus==='PARTIAL_SUCCESS'?'partial':text.replace(/Page \S+:|\[Unclear line omitted\]/g,'').trim()?'ready':'unreadable';
      const fresh=await access.authorize(request);
      await access.transaction(fresh,request.correlationId,client=>client.query(
        `update ${access.table(row.kind)} set status=$4,next_token=$5,extracted_text=$6,
         minimum_confidence=$7,unclear_lines=unclear_lines+$8,page_count=page_count+$9,updated_at=clock_timestamp()
         where file_id=$1 and patient_id=$2 and job_id=$3 and next_token is not distinct from $10
         and status='processing' and updated_at=$11::timestamptz`,
        [row.id,fresh.patientId,row.job_id,status,result.NextToken??null,text.slice(0,200000),Math.min(Number(row.minimum_confidence??100),extracted.confidence),extracted.unclear,extracted.pages,row.next_token,row.updated_at_token]));
    }
  }
  private selfAccess():AttachmentAccess {
    return {authorize:request=>this.records.authorizeSelf(request),
      transaction:(auth,correlationId,operation)=>this.database.withPatientTransaction(
        auth as Awaited<ReturnType<PatientRecordsService['authorizeSelf']>>,correlationId,operation),
      query:ATTACHMENT_TEXT_QUERY,table:kind=>{
        if(kind==='document')return 'ehr.patient_document_extractions';
        if(kind==='attachment')return 'ehr.patient_attachment_extractions';
        throw new Error('Unknown extraction source');
      }};
  }
  private async insert(request:HidRequest,row:Record<string,unknown>,auth:ChatAuthorization,access:AttachmentAccess,fields:Record<string,unknown>) {
    const columns=['file_id','patient_id','object_version_id','sha256_hex',...(row.kind==='document'?['facility_id']:[]),...Object.keys(fields)];
    const values=[row.id,auth.patientId,row.object_version_id,row.sha256_hex,...(row.kind==='document'?[row.facility_id]:[]),...Object.values(fields)];
    await access.transaction(auth,request.correlationId,client=>client.query(
      `insert into ${access.table(row.kind)}(${columns.join(',')}) values(${values.map((_,i)=>'$'+(i+1)).join(',')}) on conflict do nothing`,values));
  }

}
