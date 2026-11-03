import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient,QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import type { CompleteExecutionDto,CorrectResultDto,EnterResultDto,GovernResultDto,StartExecutionDto,VerifyResultDto } from './dto/execution.dto';
import { LabOrderRouteAccess,basisDetails,type LabRouteResource,type RecordAction } from './order-route-access';

interface ExecutionRow extends QueryResultRow {id:string;accession_id:string;specimen_id:string;requested_test_id:string;patient_id:string;
 facility_id:string;status:'in_progress'|'completed';method:string|null;started_at:Date;completed_at:Date|null;row_version:string;
 idempotency_key:string;request_sha256:string;completed_idempotency_key:string|null;completed_request_sha256:string|null;test_name:string;test_code:string;test_code_system:string}
interface RevisionRow extends QueryResultRow {id:string;result_id:string;execution_id:string;patient_id:string;facility_id:string;version:string;
 result_type:'numeric'|'text';numeric_value:string|null;text_value:string|null;unit:string|null;reference_range:string|null;abnormal_flag:string;
 entry_source:'manual';verification_status:'unverified';entered_at:Date;correction_reason:string|null;request_sha256:string}
const EXEC=`e.id::text,e.accession_id::text,e.specimen_id::text,e.requested_test_id::text,e.patient_id::text,e.facility_id::text,
 e.status,e.method,e.started_at,e.completed_at,e.row_version::text,e.idempotency_key,e.request_sha256,e.completed_idempotency_key,
 e.completed_request_sha256,t.name as test_name,t.code as test_code,t.code_system as test_code_system`;
interface WorkItemOrderRow extends QueryResultRow {id:string;patient_id:string;source_ehr_order_id:string;source_ehr_order_version:string;
 test_code_system:string;test_code:string;test_name:string;accepted_at:Date}
type OnePersonRead=()=>Promise<boolean>;
const REV=`rr.id::text,rr.result_id::text,rr.execution_id::text,rr.patient_id::text,rr.facility_id::text,rr.version::text,
 rr.result_type,rr.numeric_value::text,rr.text_value,rr.unit,rr.reference_range,rr.abnormal_flag,rr.entry_source,
 rr.verification_status,rr.entered_at,rr.correction_reason,rr.request_sha256`;

const executionDenied=()=>new DomainProblem(403,'LAB_EXECUTION_ACCESS_DENIED','Lab execution/result access is not authorized');

/**
 * The Lab return trigger refuses a release on an order route from another facility that is cancelled, or accepted and
 * past its work window (P4c, SPEC-FINAL §6, P3): 23514 with the message ORDER_ROUTE_CLOSED, answered 409. Any other
 * error of the insert is passed on unchanged (a serialization failure reaches DatabaseService's retry).
 */
function releaseRefusal(error:unknown):DomainProblem|undefined{
 const {code,message}=(typeof error==='object'&&error!==null?error:{}) as {code?:unknown;message?:unknown};
 if(code!=='23514'||message!=='ORDER_ROUTE_CLOSED')return undefined;
 return new DomainProblem(409,'ORDER_ROUTE_CLOSED','This order from another facility is closed: its result cannot be released',undefined,{cause:error});
}

/**
 * The governance trigger's refusals of a verification under owner decision 33.3 (migration 0111), each a bare code:
 * the person who entered a version may check it only as a self-check in a One-person lab. Mapped by SQLSTATE and
 * message, with the database error kept as the cause (the filter logs only its SQLSTATE); anything else passes on
 * unchanged.
 */
const VERIFY_REFUSALS:Readonly<Record<string,readonly [sqlState:string,status:number,detail:string]>>=Object.freeze({
 LAB_RESULT_SECOND_CHECK_REQUIRED:['23514',409,'A second person must check this result'],
 LAB_RESULT_SELF_CHECK_REASON_REQUIRED:['23514',409,'You entered this result: type why you are checking it yourself'],
 LAB_RESULT_SELF_CHECK_REASON_INVALID:['22023',400,'The reason must be 10 to 500 characters'],
 LAB_RESULT_SELF_CHECK_NOT_YOURS:['23514',409,'Someone else entered this result: check it normally'],
});
export function verifyRefusal(error:unknown):DomainProblem|undefined{
 const {code,message}=(typeof error==='object'&&error!==null?error:{}) as {code?:unknown;message?:unknown};
 if(typeof message!=='string'||!Object.hasOwn(VERIFY_REFUSALS,message))return undefined;
 const refusal=VERIFY_REFUSALS[message];
 if(!refusal||code!==refusal[0])return undefined;
 return new DomainProblem(refusal[1],message,refusal[2],undefined,{cause:error});
}
const selfCheckReasonInvalid=()=>new DomainProblem(400,'LAB_RESULT_SELF_CHECK_REASON_INVALID','The reason must be 10 to 500 characters');

@Injectable()
export class LabExecutionsService {
 constructor(private readonly database:DatabaseService,private readonly audit:AuditService,private readonly routeAccess:LabOrderRouteAccess) {}

 async start(context:DataAccessContext,specimenId:string,input:StartExecutionDto,key:string) {
  this.permission(context,'lab.execution.start'); const normalized={expectedSpecimenVersion:input.expectedSpecimenVersion,
   startedAt:input.startedAt,method:input.method?.trim()||null,reason:input.reason.trim()};
  const digest=requestDigest('lab.execution.start',{specimenId,...normalized});
  return this.database.withTransaction(context,async client=>{
   const specimen=await client.query<{id:string;accession_id:string;patient_id:string;facility_id:string;status:string;row_version:string;work_item_id:string}>(
    `select s.id::text,s.accession_id::text,s.patient_id::text,s.facility_id::text,s.status,s.row_version::text,a.work_item_id::text
     from lab.specimens s join lab.accessions a on a.id=s.accession_id where s.id=$1 for update of s`,[specimenId]);
   const source=specimen.rows[0]; if(!source) throw new DomainProblem(404,'LAB_SPECIMEN_NOT_FOUND','Lab specimen was not found');
   const basis=await this.authorize(client,context,'specimen',source.id,source.patient_id,'write_records');
   if(source.status!=='received'||Number(source.row_version)!==input.expectedSpecimenVersion) throw new DomainProblem(412,'SPECIMEN_NOT_EXECUTABLE','Only the expected received specimen version can begin execution');
   const existing=await client.query<ExecutionRow>(`select ${EXEC} from lab.test_executions e join lab.work_item_requested_tests t on t.id=e.requested_test_id
    where e.specimen_id=$1 or (e.facility_id=$2 and e.started_by=$3 and e.idempotency_key=$4)`,[specimenId,context.facilityId,context.actor.accountId,key]);
   if(existing.rows[0]) {if(existing.rows[0].request_sha256!==digest) throw new DomainProblem(409,'IDEMPOTENCY_CONFLICT','Execution start conflicts with existing execution');return this.aggregate(client,existing.rows[0],context,this.onePersonReader(client));}
   const test=await client.query<{id:string}>(`select id::text from lab.work_item_requested_tests where work_item_id=$1 order by ordinal limit 2`,[source.work_item_id]);
   if(test.rows.length!==1||!test.rows[0]) throw new DomainProblem(409,'REQUESTED_TEST_AMBIGUOUS','Execution requires exactly one preserved requested test');
   const inserted=await client.query<ExecutionRow>(`insert into lab.test_executions(accession_id,specimen_id,requested_test_id,patient_id,facility_id,
    method,started_by,started_by_membership_id,started_at,idempotency_key,request_sha256,correlation_id)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id::text,accession_id::text,specimen_id::text,requested_test_id::text,
    patient_id::text,facility_id::text,status,method,started_at,completed_at,row_version::text,idempotency_key,request_sha256,
    completed_idempotency_key,completed_request_sha256,'' as test_name,'' as test_code,'' as test_code_system`,
   [source.accession_id,specimenId,test.rows[0].id,source.patient_id,source.facility_id,normalized.method,context.actor.accountId,
    context.membershipId,normalized.startedAt,key,digest,context.correlationId]);
   const row=inserted.rows[0]; if(!row) throw new DomainProblem(503,'LAB_EXECUTION_NOT_CREATED','Execution could not be started');
   const full=await this.find(client,row.id); await this.event(client,full,1,'execution_started',normalized.reason,context);
   await this.outbox(client,'LabTestExecutionStarted',full.id,1,full,context,{executionId:full.id,specimenId,requestedTestId:full.requested_test_id,status:'in_progress'});
   await this.audit.recordWithClient(client,this.auditEvent(context,full,'lab.execution.start',{accessionId:full.accession_id,specimenId,requestedTestId:full.requested_test_id,...basisDetails(basis)}));
   return this.aggregate(client,full,context,this.onePersonReader(client));
  },{isolationLevel:'SERIALIZABLE'});
 }

 async complete(context:DataAccessContext,id:string,input:CompleteExecutionDto,key:string) {
  this.permission(context,'lab.execution.complete'); const payload={expectedVersion:input.expectedVersion,completedAt:input.completedAt,notes:input.notes?.trim()||null};
  const digest=requestDigest('lab.execution.complete',{executionId:id,...payload});
  return this.database.withTransaction(context,async client=>{
   const current=await this.find(client,id,true); const basis=await this.authorize(client,context,'execution',current.id,current.patient_id,'write_records');
   if(current.status==='completed'&&current.completed_idempotency_key===key) {if(current.completed_request_sha256!==digest) throw new DomainProblem(409,'IDEMPOTENCY_CONFLICT','Completion conflicts with existing command');return this.aggregate(client,current,context,this.onePersonReader(client));}
   const result=await client.query<ExecutionRow>(`update lab.test_executions set status='completed',completed_at=$2,completed_by=$3,
    completed_by_membership_id=$4,completion_notes=$5,completed_idempotency_key=$6,completed_request_sha256=$7,row_version=row_version+1
    where id=$1 and status='in_progress' and row_version=$8 returning id::text`,[id,payload.completedAt,context.actor.accountId,context.membershipId,payload.notes,key,digest,input.expectedVersion]);
   if(!result.rows[0]) throw new DomainProblem(412,'VERSION_CONFLICT','Execution changed or is not in progress');
   const row=await this.find(client,id); await this.event(client,row,Number(row.row_version),'execution_completed','Analytical execution completed',context);
   await this.outbox(client,'LabTestExecutionCompleted',row.id,Number(row.row_version),row,context,{executionId:row.id,status:'completed'});
   await this.audit.recordWithClient(client,this.auditEvent(context,row,'lab.execution.complete',{accessionId:row.accession_id,specimenId:row.specimen_id,...basisDetails(basis)}));
   return this.aggregate(client,row,context,this.onePersonReader(client));
  },{isolationLevel:'SERIALIZABLE'});
 }

 enterResult(context:DataAccessContext,id:string,input:EnterResultDto,key:string) {this.permission(context,'lab.result.enter');return this.writeResult(context,id,null,input,key,null);}
 correctResult(context:DataAccessContext,id:string,resultId:string,input:CorrectResultDto,key:string) {this.permission(context,'lab.result.correct');return this.writeResult(context,id,resultId,input,key,input.reason.trim());}

 private async writeResult(context:DataAccessContext,executionId:string,resultId:string|null,input:EnterResultDto|CorrectResultDto,key:string,correctionReason:string|null) {
  this.validateValue(input); const payload={executionId,resultId,expectedExecutionVersion:input.expectedExecutionVersion,
   expectedResultVersion:'expectedResultVersion' in input?input.expectedResultVersion:null,resultType:input.resultType,numericValue:input.numericValue??null,textValue:input.textValue?.trim()||null,
   unit:input.unit?.trim()||null,referenceRange:input.referenceRange?.trim()||null,abnormalFlag:input.abnormalFlag??'unknown',correctionReason};
  const digest=requestDigest(resultId?'lab.result.correct':'lab.result.enter',payload);
  return this.database.withTransaction(context,async client=>{
   const execution=await this.find(client,executionId,true); const basis=await this.authorize(client,context,'execution',execution.id,execution.patient_id,'write_records');
   if(execution.status!=='completed'||Number(execution.row_version)!==input.expectedExecutionVersion) throw new DomainProblem(412,'EXECUTION_NOT_RESULT_ELIGIBLE','Result requires expected completed execution version');
   const replay=await client.query<RevisionRow>(`select ${REV} from lab.result_revisions rr where rr.facility_id=$1 and rr.entered_by=$2 and rr.idempotency_key=$3`,[context.facilityId,context.actor.accountId,key]);
   if(replay.rows[0]) {if(replay.rows[0].request_sha256!==digest) throw new DomainProblem(409,'IDEMPOTENCY_CONFLICT','Result command conflicts with existing revision');return this.resultAggregate(client,replay.rows[0].result_id,context,this.onePersonReader(client));}
   let headId=resultId; let version=1;
   if(!resultId) {const created=await client.query<{id:string}>(`insert into lab.results(execution_id,patient_id,facility_id,created_by,created_by_membership_id)
    values($1,$2,$3,$4,$5) returning id::text`,[executionId,execution.patient_id,execution.facility_id,context.actor.accountId,context.membershipId]);headId=created.rows[0]?.id??null;}
   else {const expected=(input as CorrectResultDto).expectedResultVersion;const updated=await client.query<{current_version:string}>(`update lab.results set current_version=current_version+1
    where id=$1 and execution_id=$2 and current_version=$3 and (not exists(select 1 from lab.result_releases where result_id=$1 and result_version=$3) or $4::boolean)
    returning current_version::text`,[resultId,executionId,expected,context.actor.permissions.includes('lab.result.revise-released')]);
    if(!updated.rows[0]) throw new DomainProblem(412,'VERSION_CONFLICT','Result changed since it was loaded');version=Number(updated.rows[0].current_version);}
   if(!headId) throw new DomainProblem(503,'LAB_RESULT_NOT_CREATED','Result head could not be created');
   const revisionKind=version===1?'original':(('revisionKind' in input&&input.revisionKind)||'correction');
   const revision=await client.query<RevisionRow>(`insert into lab.result_revisions(result_id,execution_id,patient_id,facility_id,version,result_type,
    numeric_value,text_value,unit,reference_range,abnormal_flag,entered_by,entered_by_membership_id,correction_reason,idempotency_key,request_sha256,correlation_id,revision_kind,supersedes_version)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) returning ${REV.replaceAll('rr.','')}`,
   [headId,executionId,execution.patient_id,execution.facility_id,version,payload.resultType,payload.numericValue,payload.textValue,payload.unit,
    payload.referenceRange,payload.abnormalFlag,context.actor.accountId,context.membershipId,correctionReason,key,digest,context.correlationId,revisionKind,version===1?null:version-1]);
   const rev=revision.rows[0]; if(!rev) throw new DomainProblem(503,'LAB_RESULT_NOT_CREATED','Result revision could not be created');
   const eventType=version===1?'result_entered':'result_corrected'; await client.query(`insert into lab.result_events(result_id,execution_id,patient_id,
    facility_id,event_version,event_type,actor_id,actor_membership_id,reason,correlation_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
   [headId,executionId,execution.patient_id,execution.facility_id,version,eventType,context.actor.accountId,context.membershipId,correctionReason??'Manual unverified result entered',context.correlationId]);
   const outboxType=version===1?'LabResultEntered':'LabResultCorrected'; await this.outbox(client,outboxType,headId,version,execution,context,
    {resultId:headId,executionId,version,status:'entered',verificationStatus:'unverified',entrySource:'manual'});
   await this.audit.recordWithClient(client,this.auditEvent(context,execution,version===1?'lab.result.enter':'lab.result.correct',{resultId:headId,version,correctionReason,...basisDetails(basis)}));
   return this.resultAggregate(client,headId,context,this.onePersonReader(client));
  },{isolationLevel:'SERIALIZABLE'});
 }

 /**
  * Verify an exact version. selfCheck true (owner decision 33.3) asks the One-person lab self-check of a version the
  * caller entered: its reason must be 10-500 characters after trimming (400 before the database); the database decides
  * whether the facility is a One-person lab and refuses with the codes of verifyRefusal.
  */
 async verifyResult(context:DataAccessContext,resultId:string,input:VerifyResultDto,key:string){this.permission(context,'lab.result.verify');
  const selfCheck=input.selfCheck===true;const reasonLength=[...input.reason.trim()].length;
  if(selfCheck&&(reasonLength<10||reasonLength>500))throw selfCheckReasonInvalid();
  return this.govern(context,resultId,{expectedResultVersion:input.expectedResultVersion,occurredAt:input.occurredAt,reason:input.reason},key,'verify',selfCheck);}
 async releaseResult(context:DataAccessContext,resultId:string,input:GovernResultDto,key:string){this.permission(context,'lab.result.release');return this.govern(context,resultId,input,key,'release',false);}
 private async govern(context:DataAccessContext,resultId:string,input:GovernResultDto,key:string,operation:'verify'|'release',selfCheck:boolean){
  // A self-check is part of the request's identity; an ordinary check digests exactly as before 0111, so its replays match.
  const digest=requestDigest(`lab.result.${operation}`,{resultId,...input,...(selfCheck?{selfCheck:true}:{})});
  return this.database.withTransaction(context,async client=>{
   const head=await client.query<{id:string;execution_id:string;patient_id:string;facility_id:string;current_version:string}>(`select id::text,execution_id::text,patient_id::text,facility_id::text,current_version::text from lab.results where id=$1 for update`,[resultId]);
   const row=head.rows[0];if(!row)throw new DomainProblem(404,'LAB_RESULT_NOT_FOUND','Lab result was not found');const basis=await this.authorize(client,context,'result',row.id,row.patient_id,'write_records');
   if(Number(row.current_version)!==input.expectedResultVersion)throw new DomainProblem(412,'VERSION_CONFLICT','Result version changed since review');
   const table=operation==='verify'?'lab.result_verifications':'lab.result_releases';
   const replay=await client.query<{request_sha256:string}>(`select request_sha256 from ${table} where facility_id=$1 and ${operation==='verify'?'verified_by':'released_by'}=$2 and idempotency_key=$3`,[context.facilityId,context.actor.accountId,key]);
   if(replay.rows[0]){if(replay.rows[0].request_sha256!==digest)throw new DomainProblem(409,'IDEMPOTENCY_CONFLICT','Governance command conflicts with existing request');return this.resultAggregate(client,resultId,context,this.onePersonReader(client));}
   let onePersonSettingId:string|null=null;
   if(operation==='verify'){await client.query(`insert into lab.result_verifications(result_id,execution_id,patient_id,facility_id,result_version,verified_by,verified_by_membership_id,verified_at,reason,idempotency_key,request_sha256,correlation_id,self_check) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[resultId,row.execution_id,row.patient_id,row.facility_id,input.expectedResultVersion,context.actor.accountId,context.membershipId,input.occurredAt,input.reason.trim(),key,digest,context.correlationId,selfCheck]).catch((error:unknown)=>{throw verifyRefusal(error)??error;});
    if(selfCheck)onePersonSettingId=(await client.query<{one_person_setting_id:string|null}>(`select one_person_setting_id::text from lab.result_verifications where result_id=$1 and result_version=$2`,[resultId,input.expectedResultVersion])).rows[0]?.one_person_setting_id??null;}
   else {const verification=await client.query<{id:string}>(`select id::text from lab.result_verifications where result_id=$1 and result_version=$2`,[resultId,input.expectedResultVersion]);if(!verification.rows[0])throw new DomainProblem(409,'RESULT_NOT_VERIFIED','Exact result version is not verified');await client.query(`insert into lab.result_releases(verification_id,result_id,execution_id,patient_id,facility_id,result_version,released_by,released_by_membership_id,released_at,reason,idempotency_key,request_sha256,correlation_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[verification.rows[0].id,resultId,row.execution_id,row.patient_id,row.facility_id,input.expectedResultVersion,context.actor.accountId,context.membershipId,input.occurredAt,input.reason.trim(),key,digest,context.correlationId]).catch((error:unknown)=>{throw releaseRefusal(error)??error;});}
   const execution=await this.find(client,row.execution_id);const event=operation==='verify'?'LabResultVerified':'LabResultReleased';await this.outbox(client,event,resultId,input.expectedResultVersion,execution,context,{resultId,resultVersion:input.expectedResultVersion,status:operation==='verify'?'verified_not_released':'released'});await this.audit.recordWithClient(client,this.auditEvent(context,execution,`lab.result.${operation}`,{resultId,resultVersion:input.expectedResultVersion,reason:input.reason.trim(),...(operation==='verify'?{selfCheck,...(selfCheck?{onePersonSettingId}:{})}:{}),...basisDetails(basis)}));return this.resultAggregate(client,resultId,context,this.onePersonReader(client));
  },{isolationLevel:'SERIALIZABLE'});
 }
 async getResultHistory(context:DataAccessContext,id:string){this.permission(context,'lab.result.released.read');return this.database.withTransaction(context,async client=>{
  const head=await client.query<{patient_id:string}>(`select patient_id::text from lab.results where id=$1`,[id]);const source=head.rows[0];
  if(!source)throw new DomainProblem(404,'LAB_RESULT_NOT_FOUND','Lab result was not found');const basis=await this.authorize(client,context,'result',id,source.patient_id,'read_records');
  // Lab staff who may read executions (and so unreleased values) keep the full history; every other reader gets the released view.
  const full=context.actor.permissions.includes('lab.execution.read');const result=await this.resultAggregate(client,id,context,full?this.onePersonReader(client):null);const view=full?result:this.releasedView(result);
  if(!view)throw new DomainProblem(404,'LAB_RESULT_NOT_FOUND','No released Lab result is available');
  await this.audit.recordWithClient(client,this.readAudit(context,source.patient_id,full?'lab.result.history.read':'lab.result.released.read','lab-result',id,{versionsReturned:view.revisions.map(r=>r.version),...basisDetails(basis)}));
  return view;});}

 /**
  * The released results of the Lab work item accepted from one EHR laboratory order, for the clinician who placed it
  * (lab.result.released.read). Row-level security binds the work item to the session facility and the member's consent,
  * and Identity authorizes the patient before any result is read. Every reader, Lab staff included, gets released
  * revisions only; a result with none is left out.
  */
 async listReleasedForEhrOrder(context:DataAccessContext,sourceEhrOrderId:string){this.permission(context,'lab.result.released.read');return this.database.withTransaction(context,async client=>{
  const found=await client.query<WorkItemOrderRow>(`select id::text,patient_id::text,source_ehr_order_id::text,source_ehr_order_version::text,
   test_code_system,test_code,test_name,accepted_at from lab.work_items where source_ehr_order_id=$1 and facility_id=$2`,[sourceEhrOrderId,context.facilityId]);
  const item=found.rows[0];if(!item)throw new DomainProblem(404,'LAB_WORK_ITEM_NOT_FOUND','Lab work item was not found');
  const basis=await this.authorize(client,context,'work_item',item.id,item.patient_id,'read_records');
  const heads=await client.query<{id:string}>(`select r.id::text from lab.results r join lab.test_executions e on e.id=r.execution_id
   join lab.work_item_requested_tests t on t.id=e.requested_test_id where t.work_item_id=$1 and r.patient_id=$2 and r.facility_id=$3
   order by e.started_at,r.id`,[item.id,item.patient_id,context.facilityId]);
  const results=[];for(const head of heads.rows){const view=this.releasedView(await this.resultAggregate(client,head.id,context,null));if(view)results.push(view);}
  await this.audit.recordWithClient(client,this.readAudit(context,item.patient_id,'lab.result.released.read','lab-work-item',item.id,
   {sourceEhrOrderId:item.source_ehr_order_id,results:results.map(r=>({resultId:r.id,versionsReturned:r.revisions.map(v=>v.version)})),...basisDetails(basis)}));
  return {workItemId:item.id,sourceEhrOrderId:item.source_ehr_order_id,sourceEhrOrderVersion:Number(item.source_ehr_order_version),patientId:item.patient_id,
   acceptedAt:item.accepted_at,test:{codeSystem:item.test_code_system,code:item.test_code,name:item.test_name},results};});}

 async get(context:DataAccessContext,id:string) {this.permission(context,'lab.execution.read');return this.database.withTransaction(context,async client=>{const row=await this.find(client,id);await this.authorize(client,context,'execution',row.id,row.patient_id,'read_records');return this.aggregate(client,row,context,this.onePersonReader(client));});}
 async listForSpecimen(context:DataAccessContext,specimenId:string) {this.permission(context,'lab.execution.read');return this.database.withTransaction(context,async client=>{
  // Authorize the specimen's patient, as get() does, before any execution or result value is read.
  const specimen=await client.query<{patient_id:string}>(`select patient_id::text from lab.specimens where id=$1`,[specimenId]);
  const source=specimen.rows[0];if(!source)throw new DomainProblem(404,'LAB_SPECIMEN_NOT_FOUND','Lab specimen was not found');
  await this.authorize(client,context,'specimen',specimenId,source.patient_id,'read_records');
  const rows=await client.query<ExecutionRow>(`select ${EXEC} from lab.test_executions e join lab.work_item_requested_tests t on t.id=e.requested_test_id where e.specimen_id=$1 and e.patient_id=$2 order by e.started_at`,[specimenId,source.patient_id]);
  const onePerson=this.onePersonReader(client);
  return {items:await Promise.all(rows.rows.map(row=>this.aggregate(client,row,context,onePerson)))};});}
 private async find(client:PoolClient,id:string,lock=false) {const result=await client.query<ExecutionRow>(`select ${EXEC} from lab.test_executions e join lab.work_item_requested_tests t on t.id=e.requested_test_id where e.id=$1${lock?' for update of e':''}`,[id]);const row=result.rows[0];if(!row)throw new DomainProblem(404,'LAB_EXECUTION_NOT_FOUND','Lab execution was not found');return row;}
 private async aggregate(client:PoolClient,row:ExecutionRow,context:DataAccessContext,onePerson:OnePersonRead) {const results=await client.query<{id:string}>(`select id::text from lab.results where execution_id=$1`,[row.id]);return {id:row.id,accessionId:row.accession_id,specimenId:row.specimen_id,requestedTestId:row.requested_test_id,
  test:{codeSystem:row.test_code_system,code:row.test_code,name:row.test_name},patientId:row.patient_id,facilityId:row.facility_id,status:row.status,
  method:row.method,startedAt:row.started_at,completedAt:row.completed_at,version:Number(row.row_version),onePersonLab:await onePerson(),result:results.rows[0]?await this.resultAggregate(client,results.rows[0].id,context,onePerson):null};}
 /** The caller's facility's One-person lab switch, read at most once for the request that holds this reader. */
 private onePersonReader(client:PoolClient):OnePersonRead {let read:Promise<boolean>|undefined;
  return ()=>read??=client.query<{enabled:boolean|null}>(`select lab.one_person_lab_enabled() as enabled`).then(result=>result.rows[0]?.enabled===true);}
 /**
  * A result with every revision, for Lab staff. Owner decision 33.3 (migration 0111): onePersonLab is the caller's own
  * facility's switch; per revision, enteredByYou (the caller entered it), checkedBySamePerson (null until checked) and
  * selfCheckReason (the typed reason of a self-check, else null). onePerson reads the switch (once per request, see
  * onePersonReader); null on the released-only paths, which never show it, so they neither read it nor depend on 0111's
  * function.
  */
 private async resultAggregate(client:PoolClient,id:string,context:DataAccessContext,onePerson:OnePersonRead|null) {const head=await client.query<{id:string;execution_id:string;status:string;current_version:string}>(`select id::text,execution_id::text,status,current_version::text from lab.results where id=$1`,[id]);const revisions=await client.query<RevisionRow & {verified_at:Date|null;released_at:Date|null;invalidated_at:Date|null;entered_by:string|null;self_check:boolean|null;verification_reason:string|null}>(`select ${REV},rr.entered_by::text as entered_by,v.verified_at,v.self_check,v.reason as verification_reason,l.released_at,i.occurred_at as invalidated_at from lab.result_revisions rr left join lab.result_verifications v on v.result_id=rr.result_id and v.result_version=rr.version left join lab.result_releases l on l.result_id=rr.result_id and l.result_version=rr.version left join lab.result_invalidations i on i.result_id=rr.result_id and i.result_version=rr.version where rr.result_id=$1 order by rr.version`,[id]);
  const onePersonLab=onePerson?await onePerson():false;
  const h=head.rows[0];const mapped=revisions.rows.map(r=>({version:Number(r.version),resultType:r.result_type,numericValue:r.numeric_value===null?null:Number(r.numeric_value),textValue:r.text_value,unit:r.unit,referenceRange:r.reference_range,abnormalFlag:r.abnormal_flag,entrySource:'manual',verificationStatus:r.invalidated_at?'entered_in_error':r.verified_at?'verified':'unverified',releaseStatus:r.released_at?'released':r.verified_at?'verified_not_released':'not_released',enteredAt:r.entered_at,releasedAt:r.released_at,correctionReason:r.correction_reason,
   enteredByYou:r.entered_by!==null&&r.entered_by===context.actor.accountId,checkedBySamePerson:r.verified_at?r.self_check===true:null,selfCheckReason:r.verified_at&&r.self_check===true?r.verification_reason:null}));
  const current=mapped.find(r=>r.version===Number(h?.current_version));return {id:h?.id,executionId:h?.execution_id,status:current?.verificationStatus==='entered_in_error'?'entered_in_error':current?.releaseStatus==='released'?'released':current?.verificationStatus==='verified'?'verified_not_released':'entered_unverified',verificationStatus:current?.verificationStatus,currentVersion:Number(h?.current_version),currentReleasedVersion:[...mapped].reverse().find(r=>r.releaseStatus==='released')?.version??null,onePersonLab,revisions:mapped};}
 /**
  * A result as a released-only reader may see it: its released revisions (one later marked entered in error stays, so
  * marked), with the head, status and verification of the latest of them. Nothing of a revision newer than the latest
  * released one. Versions keep their stored numbers, so a gap shows that an intermediate revision was never released;
  * its value and reason are never returned. Null when no revision is released.
  */
 private releasedView<R extends {version:number;verificationStatus:string;releaseStatus:string;enteredByYou?:boolean;selfCheckReason?:string|null}>(result:{id:string|undefined;executionId:string|undefined;revisions:R[]}) {
  // Other readers see whether a revision was checked by the person who entered it, never the typed reason (owner
  // decision 33.3, open item 4) nor who is reading.
  const revisions=result.revisions.filter(r=>r.releaseStatus==='released').map(r=>{const view:Omit<R,'enteredByYou'|'selfCheckReason'>&{enteredByYou?:boolean;selfCheckReason?:string|null}={...r};delete view.enteredByYou;delete view.selfCheckReason;return view;});const latest=revisions.at(-1);if(!latest)return null;
  return {id:result.id,executionId:result.executionId,status:latest.verificationStatus==='entered_in_error'?'entered_in_error':'released',
   verificationStatus:latest.verificationStatus,currentVersion:latest.version,currentReleasedVersion:latest.version,revisions};
 }
 private validateValue(input:EnterResultDto) {if((input.resultType==='numeric'&&(input.numericValue===undefined||input.textValue!==undefined))||(input.resultType==='text'&&(!input.textValue?.trim()||input.numericValue!==undefined)))throw new DomainProblem(400,'INVALID_RESULT_VALUE','Result value must match its declared type');}
 private permission(c:DataAccessContext,p:string){if(!c.actor.permissions.includes(p))throw new DomainProblem(403,'LAB_EXECUTION_ACCESS_DENIED','Required Lab permission is absent');}
 /**
  * The command's authorization on the resource it acts on (P4c, PRIV P12): an order route that allows it, or the
  * member's consent through Identity as before, refused with LAB_EXECUTION_ACCESS_DENIED.
  */
 private authorize(client:PoolClient,c:DataAccessContext,resource:LabRouteResource,resourceId:string,patientId:string,a:RecordAction){
  return this.routeAccess.authorize(client,c,resource,resourceId,patientId,a,executionDenied);
 }
 private event(client:PoolClient,row:ExecutionRow,v:number,t:string,reason:string,c:DataAccessContext){return client.query(`insert into lab.execution_events(execution_id,patient_id,facility_id,event_version,event_type,actor_id,actor_membership_id,reason,correlation_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[row.id,row.patient_id,row.facility_id,v,t,c.actor.accountId,c.membershipId,reason,c.correlationId]);}
 private outbox(client:PoolClient,type:string,id:string,v:number,row:{patient_id:string;facility_id:string},c:DataAccessContext,payload:Record<string,unknown>){return client.query(`insert into lab.outbox_events(event_type,aggregate_id,aggregate_version,facility_id,patient_id,correlation_id,payload) values($1,$2,$3,$4,$5,$6,$7::jsonb)`,[type,id,v,row.facility_id,row.patient_id,c.correlationId,JSON.stringify(payload)]);}
 private readAudit(c:DataAccessContext,patientId:string,action:string,resourceType:'lab-result'|'lab-work-item',resourceId:string,details:Record<string,unknown>){return {correlationId:c.correlationId,actorType:'staff' as const,actorSubject:c.actor.subject,actorAccountId:c.actor.accountId,actorMembershipId:c.membershipId,organizationId:c.actor.facility?.organizationId,facilityId:c.facilityId,patientId,action,resourceType,resourceId,outcome:'success' as const,purposeOfUse:c.purposeOfUse,details,sourceSystem:'lab-api'};}
 private auditEvent(c:DataAccessContext,row:ExecutionRow,action:string,details:Record<string,unknown>){return {correlationId:c.correlationId,actorType:'staff' as const,actorSubject:c.actor.subject,actorAccountId:c.actor.accountId,actorMembershipId:c.membershipId,organizationId:c.actor.facility?.organizationId,facilityId:row.facility_id,patientId:row.patient_id,action,resourceType:action.includes('result')?'lab-result':'lab-execution',resourceId:row.id,outcome:'success' as const,purposeOfUse:c.purposeOfUse,details,sourceSystem:'lab-api'};}
}
