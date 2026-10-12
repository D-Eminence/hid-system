import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { IdentityService } from '../identity/identity.service';
import type { AuthorizationDecision,AuthorizationRequest,IdentityProvider } from '../identity/identity.types';
import { LabExecutionsService } from './lab-executions.service';

// Released Lab results for readers who hold lab.result.released.read without
// lab.execution.read (the doctor, clinician and nurse roles, 0021): they get the
// released revisions of a result and nothing of a correction that is not yet
// released, by result (history) or by the EHR order they placed.

const facilityId='10000000-0000-4000-8000-000000000001',membershipId='40000000-0000-4000-8000-000000000001';
const accountId='20000000-0000-4000-8000-000000000001',patientId='60000000-0000-4000-8000-000000000001';
const executionId='70000000-0000-4000-8000-000000000001',pendingExecutionId='70000000-0000-4000-8000-000000000002';
const resultId='a0000000-0000-4000-8000-000000000001',pendingResultId='a0000000-0000-4000-8000-000000000002';
const workItemId='b0000000-0000-4000-8000-000000000001',sourceEhrOrderId='c0000000-0000-4000-8000-000000000001';
const grantId='e0000000-0000-4000-8000-000000000001';
// The doctor role's Lab permissions (0017, 0018, 0021): no execution or accession read.
const DOCTOR=['lab.import.read','lab.import.write','lab.work-item.read','lab.work-item.accept','lab.result.released.read'];
const LAB_STAFF=['lab.execution.read','lab.result.released.read','lab.result.enter','lab.result.correct'];
const contextWith=(permissions:string[],purposeOfUse:DataAccessContext['purposeOfUse']='direct-care'):DataAccessContext=>({
 correlationId:'released-results-correlation',facilityId,membershipId,purposeOfUse,
 actor:{id:'actor',subject:'staff:doctor',accountId,roles:['doctor'],permissions,facilityIds:[facilityId],facilities:[],authenticationMethod:'local'}});
const doctor=contextWith(DOCTOR),labStaff=contextWith(LAB_STAFF);

const enteredAt=new Date('2026-10-02T10:30:00.000Z'),verifiedAt=new Date('2026-10-02T12:30:00.000Z');
const releasedAt=new Date('2026-10-02T13:00:00.000Z'),invalidatedAt=new Date('2026-10-02T15:00:00.000Z');
const acceptedAt=new Date('2026-10-01T09:05:00.000Z');
const CORRECTION_REASON='Synthetic transcription correction';
interface Revision {version:number;value:number;verified?:boolean;released?:boolean;invalidated?:boolean}
interface StoredResult {executionId:string;currentVersion:number;revisions:Revision[]}
const revisionRow=(id:string,result:StoredResult,r:Revision)=>({id:`revision-${id}-${r.version}`,result_id:id,execution_id:result.executionId,
 patient_id:patientId,facility_id:facilityId,version:String(r.version),result_type:'numeric',numeric_value:String(r.value),text_value:null,
 unit:'g/dL',reference_range:'12.0-16.0',abnormal_flag:'normal',entry_source:'manual',verification_status:'unverified',entered_at:enteredAt,
 correction_reason:r.version===1?null:CORRECTION_REASON,request_sha256:'a'.repeat(64),verified_at:r.verified?verifiedAt:null,
 released_at:r.released?releasedAt:null,invalidated_at:r.invalidated?invalidatedAt:null});
/** The revision as a released-only reader receives it. */
const released=(version:number,value:number,verificationStatus:'verified'|'entered_in_error'='verified')=>({version,resultType:'numeric',
 numericValue:value,textValue:null,unit:'g/dL',referenceRange:'12.0-16.0',abnormalFlag:'normal',entrySource:'manual',verificationStatus,
 releaseStatus:'released',enteredAt,releasedAt,correctionReason:version===1?null:CORRECTION_REASON});

// Version 1 (12.5) released; version 2 (7.1), a correction, entered and not verified.
const correctedAfterRelease:StoredResult={executionId,currentVersion:2,revisions:[{version:1,value:12.5,verified:true,released:true},{version:2,value:7.1}]};
// Never released (9.9).
const neverReleased:StoredResult={executionId:pendingExecutionId,currentVersion:1,revisions:[{version:1,value:9.9,verified:true}]};
const workItem={id:workItemId,patient_id:patientId,facility_id:facilityId,source_ehr_order_id:sourceEhrOrderId,source_ehr_order_version:'1',
 test_code_system:'http://loinc.org',test_code:'718-7',test_name:'Haemoglobin',accepted_at:acceptedAt};
const RESULT_READS=/\blab\.(test_executions|results|result_revisions|result_verifications|result_releases|result_invalidations)\b/;
const decision=(overrides:Partial<AuthorizationDecision>={}):AuthorizationDecision=>({allowed:true,patientId,facilityId,membershipId,
 scope:'read_records',purpose:'direct-care',consentGrantId:grantId,breakGlass:false,...overrides});

interface ReleasedOrderResults {workItemId:string;sourceEhrOrderId:string;sourceEhrOrderVersion:number;patientId:string;acceptedAt:Date;
 test:{codeSystem:string;code:string;name:string};results:unknown[]}
/** The released-results read by EHR order; absent before LAB5-A. */
const byOrder=(service:LabExecutionsService)=>service as unknown as {
 listReleasedForEhrOrder(context:DataAccessContext,sourceEhrOrderId:string):Promise<ReleasedOrderResults>};

const harness=({results={[resultId]:correctedAfterRelease} as Record<string,StoredResult>,listed=undefined as string[]|undefined,
 item=workItem as typeof workItem|null}={},authorize:(request:AuthorizationRequest)=>Promise<AuthorizationDecision>=async()=>decision())=>{
 const order=listed??Object.keys(results);
 const client={query:jest.fn(async(sql:string,values:readonly unknown[]=[])=>{
  if(/\bfrom lab\.work_items\b/.test(sql))return {rows:item?[item]:[]};
  if(/\bjoin lab\.test_executions\b/.test(sql))return {rows:order.map(id=>({id,execution_id:results[id]?.executionId}))};
  const stored=results[String(values[0])];
  if(sql.includes('select patient_id::text from lab.results'))return {rows:stored?[{patient_id:patientId}]:[]};
  if(sql.includes('from lab.results where id=$1'))return {rows:stored?[{id:String(values[0]),execution_id:stored.executionId,status:'entered_unverified',current_version:String(stored.currentVersion)}]:[]};
  if(/\bfrom lab\.result_revisions rr\b/.test(sql))return {rows:stored?stored.revisions.map(r=>revisionRow(String(values[0]),stored,r)):[]};
  return {rows:[]};
 })};
 const database={withTransaction:async<T>(_c:DataAccessContext,fn:(c:PoolClient)=>Promise<T>)=>fn(client as unknown as PoolClient)} as unknown as DatabaseService;
 const audit={record:jest.fn().mockResolvedValue(undefined),recordWithClient:jest.fn().mockResolvedValue(undefined)};
 const provider={authorize:jest.fn(authorize),lookupExactHid:jest.fn(),consentStatus:jest.fn()} satisfies IdentityProvider;
 const service=new LabExecutionsService(database,new IdentityService(provider,audit as unknown as AuditService),audit as unknown as AuditService);
 const statements=()=>client.query.mock.calls.map(call=>String(call[0]));
 const resultReads=()=>statements().filter(sql=>RESULT_READS.test(sql));
 const firstResultRead=()=>{const index=client.query.mock.calls.findIndex(call=>RESULT_READS.test(String(call[0])));return index<0?Infinity:client.query.mock.invocationCallOrder[index]??Infinity;};
 const authorizationOutcomes=()=>audit.record.mock.calls.map(([event])=>event as {action:string;outcome:string}).filter(event=>event.action==='identity.authorization.check');
 return {service,client,provider,audit,statements,resultReads,firstResultRead,authorizationOutcomes};
};
const rejection=async(promise:Promise<unknown>)=>{try{await promise;}catch(error){return error;}throw new Error('Expected the read to be refused');};
const auditEvent=(fields:Record<string,unknown>)=>expect.objectContaining({correlationId:'released-results-correlation',actorType:'staff',
 actorSubject:'staff:doctor',actorAccountId:accountId,actorMembershipId:membershipId,facilityId,patientId,outcome:'success',
 purposeOfUse:'direct-care',sourceSystem:'lab-api',...fields});

describe('LabExecutionsService.getResultHistory for released-only readers',()=>{
 it('returns only the released revision while a correction awaits verification and release',async()=>{
  const {service}=harness();
  const history=await service.getResultHistory(doctor,resultId);
  expect(history).toEqual({id:resultId,executionId,status:'released',verificationStatus:'verified',currentVersion:1,
   currentReleasedVersion:1,revisions:[released(1,12.5)]});
  const body=JSON.stringify(history);
  expect(body).not.toContain('7.1');
  expect(body).not.toContain(CORRECTION_REASON);
  expect(body).not.toMatch(/hasUnreleased|unreleased/i);
 });

 it('hides a correction that is verified but not released',async()=>{
  const {service}=harness({results:{[resultId]:{...correctedAfterRelease,revisions:[{version:1,value:12.5,verified:true,released:true},{version:2,value:7.1,verified:true}]}}});
  const history=await service.getResultHistory(doctor,resultId);
  expect(history.revisions.map(r=>r.version)).toEqual([1]);
  expect(history).toMatchObject({status:'released',verificationStatus:'verified',currentVersion:1,currentReleasedVersion:1});
  expect(JSON.stringify(history)).not.toContain('7.1');
 });

 it('keeps every released revision, marking one later entered in error',async()=>{
  const superseded=harness({results:{[resultId]:{executionId,currentVersion:3,revisions:[{version:1,value:12.5,verified:true,released:true,invalidated:true},
   {version:2,value:13.4,verified:true,released:true},{version:3,value:7.1}]}}});
  await expect(superseded.service.getResultHistory(doctor,resultId)).resolves.toEqual({id:resultId,executionId,status:'released',
   verificationStatus:'verified',currentVersion:2,currentReleasedVersion:2,revisions:[released(1,12.5,'entered_in_error'),released(2,13.4)]});
  const withdrawn=harness({results:{[resultId]:{executionId,currentVersion:2,revisions:[{version:1,value:12.5,verified:true,released:true,invalidated:true},{version:2,value:7.1}]}}});
  await expect(withdrawn.service.getResultHistory(doctor,resultId)).resolves.toEqual({id:resultId,executionId,status:'entered_in_error',
   verificationStatus:'entered_in_error',currentVersion:1,currentReleasedVersion:1,revisions:[released(1,12.5,'entered_in_error')]});
 });

 it('keeps the full history for Lab staff who hold lab.execution.read',async()=>{
  const {service}=harness();
  const history=await service.getResultHistory(labStaff,resultId);
  expect(history).toMatchObject({status:'entered_unverified',currentVersion:2,currentReleasedVersion:1});
  expect(history.revisions.map(r=>[r.version,r.numericValue,r.releaseStatus])).toEqual([[1,12.5,'released'],[2,7.1,'not_released']]);
 });

 it('still answers 404 when no revision is released, writing no read audit',async()=>{
  const {service,audit}=harness({results:{[resultId]:neverReleased}});
  await expect(service.getResultHistory(doctor,resultId)).rejects.toMatchObject({status:404,code:'LAB_RESULT_NOT_FOUND'});
  expect(audit.recordWithClient).not.toHaveBeenCalled();
 });

 it('records a patient-linked read audit naming the versions returned',async()=>{
  const reader=harness();
  await reader.service.getResultHistory(doctor,resultId);
  expect(reader.audit.recordWithClient).toHaveBeenCalledTimes(1);
  expect(reader.audit.recordWithClient).toHaveBeenCalledWith(reader.client,auditEvent({action:'lab.result.released.read',
   resourceType:'lab-result',resourceId:resultId,details:{versionsReturned:[1]}}));
  const staff=harness();
  await staff.service.getResultHistory(labStaff,resultId);
  expect(staff.audit.recordWithClient).toHaveBeenCalledTimes(1);
  expect(staff.audit.recordWithClient).toHaveBeenCalledWith(staff.client,auditEvent({action:'lab.result.history.read',
   resourceType:'lab-result',resourceId:resultId,details:{versionsReturned:[1,2]}}));
 });

 it('fails the read when its audit cannot be written',async()=>{
  const {service,audit}=harness();
  const outage=new Error('audit insert failed');
  audit.recordWithClient.mockRejectedValueOnce(outage);
  await expect(service.getResultHistory(doctor,resultId)).rejects.toBe(outage);
 });

 it('refuses with 403 when Identity denies the read, reading no revision',async()=>{
  const {service,statements}=harness({},async()=>decision({allowed:false,consentGrantId:undefined}));
  await expect(service.getResultHistory(doctor,resultId)).rejects.toMatchObject({status:403,code:'LAB_EXECUTION_ACCESS_DENIED'});
  expect(statements().filter(sql=>/\blab\.result_revisions\b/.test(sql))).toEqual([]);
 });
});

describe('LabExecutionsService.listReleasedForEhrOrder',()=>{
 it('returns the released results of the order to a doctor, without any unreleased correction or unreleased result',async()=>{
  const {service}=harness({results:{[resultId]:correctedAfterRelease,[pendingResultId]:neverReleased}});
  const found=await byOrder(service).listReleasedForEhrOrder(doctor,sourceEhrOrderId);
  expect(found).toEqual({workItemId,sourceEhrOrderId,sourceEhrOrderVersion:1,patientId,acceptedAt,
   test:{codeSystem:'http://loinc.org',code:'718-7',name:'Haemoglobin'},
   results:[{id:resultId,executionId,status:'released',verificationStatus:'verified',currentVersion:1,currentReleasedVersion:1,revisions:[released(1,12.5)]}]});
  const body=JSON.stringify(found);
  for(const hidden of ['7.1','9.9',CORRECTION_REASON,pendingResultId,pendingExecutionId])expect(body).not.toContain(hidden);
  expect(body).not.toMatch(/hasUnreleased|unreleased/i);
 });

 it('answers with no results while nothing of the order is released',async()=>{
  const {service}=harness({results:{[pendingResultId]:neverReleased}});
  await expect(byOrder(service).listReleasedForEhrOrder(doctor,sourceEhrOrderId)).resolves.toEqual({workItemId,sourceEhrOrderId,
   sourceEhrOrderVersion:1,patientId,acceptedAt,test:{codeSystem:'http://loinc.org',code:'718-7',name:'Haemoglobin'},results:[]});
  const empty=harness({results:{}});
  await expect(byOrder(empty.service).listReleasedForEhrOrder(doctor,sourceEhrOrderId)).resolves.toMatchObject({workItemId,results:[]});
 });

 it('refuses a reader without lab.result.released.read before any database call or Identity check',async()=>{
  const {service,client,provider}=harness();
  const error=await rejection(byOrder(service).listReleasedForEhrOrder(contextWith(['lab.work-item.read']),sourceEhrOrderId));
  expect(error).toMatchObject({status:403,code:'LAB_EXECUTION_ACCESS_DENIED'});
  expect(client.query).not.toHaveBeenCalled();
  expect(provider.authorize).not.toHaveBeenCalled();
 });

 it('answers 404 LAB_WORK_ITEM_NOT_FOUND for an order whose work item it cannot see, without asking Identity',async()=>{
  const {service,provider,resultReads,audit}=harness({item:null});
  const error=await rejection(byOrder(service).listReleasedForEhrOrder(doctor,sourceEhrOrderId));
  expect(error).toMatchObject({status:404,code:'LAB_WORK_ITEM_NOT_FOUND'});
  expect(provider.authorize).not.toHaveBeenCalled();
  expect(resultReads()).toEqual([]);
  expect(audit.recordWithClient).not.toHaveBeenCalled();
 });

 it('finds the work item by the order in the session facility and reads only that patient\'s results there',async()=>{
  const {service,client}=harness();
  await byOrder(service).listReleasedForEhrOrder(doctor,sourceEhrOrderId);
  const lookup=client.query.mock.calls.find(call=>/\bfrom lab\.work_items\b/.test(String(call[0])));
  expect(String(lookup?.[0])).toMatch(/source_ehr_order_id\s*=\s*\$1/);
  expect(String(lookup?.[0])).toMatch(/facility_id\s*=\s*\$2/);
  expect(lookup?.[1]).toEqual([sourceEhrOrderId,facilityId]);
  const listing=client.query.mock.calls.find(call=>/\bjoin lab\.test_executions\b/.test(String(call[0])));
  expect(String(listing?.[0])).toMatch(/work_item_id\s*=\s*\$1/);
  expect(String(listing?.[0])).toMatch(/patient_id\s*=\s*\$2/);
  expect(String(listing?.[0])).toMatch(/facility_id\s*=\s*\$3/);
  expect(listing?.[1]).toEqual([workItemId,patientId,facilityId]);
 });

 it('authorizes the work item\'s patient with Identity for read_records before reading any result',async()=>{
  const {service,provider,firstResultRead,authorizationOutcomes}=harness();
  await byOrder(service).listReleasedForEhrOrder(doctor,sourceEhrOrderId);
  expect(provider.authorize).toHaveBeenCalledTimes(1);
  expect(provider.authorize).toHaveBeenCalledWith({patientId,scope:'read_records',purpose:'direct-care',context:doctor});
  expect(firstResultRead()).toBeGreaterThan(provider.authorize.mock.invocationCallOrder[0]??Infinity);
  expect(authorizationOutcomes()).toEqual([expect.objectContaining({outcome:'success'})]);
 });

 it('refuses with 403 LAB_EXECUTION_ACCESS_DENIED when Identity denies the read, reading no result',async()=>{
  const {service,resultReads,audit,authorizationOutcomes}=harness({},async()=>decision({allowed:false,consentGrantId:undefined}));
  const error=await rejection(byOrder(service).listReleasedForEhrOrder(doctor,sourceEhrOrderId));
  expect(error).toMatchObject({status:403,code:'LAB_EXECUTION_ACCESS_DENIED'});
  expect(resultReads()).toEqual([]);
  expect(JSON.stringify(error)).not.toContain('12.5');
  expect(audit.recordWithClient).not.toHaveBeenCalled();
  expect(authorizationOutcomes()).toEqual([expect.objectContaining({outcome:'denied'})]);
 });

 it('fails closed when Identity is unavailable',async()=>{
  for(const outage of [new DomainProblem(503,'IDENTITY_SERVICE_UNAVAILABLE','Identity authorization service is unavailable'),new Error('connect ECONNREFUSED')]){
   const {service,resultReads}=harness({},async()=>{throw outage;});
   await expect(byOrder(service).listReleasedForEhrOrder(doctor,sourceEhrOrderId)).rejects.toBe(outage);
   expect(resultReads()).toEqual([]);
  }
 });

 it('records one patient-linked read audit naming the released versions returned',async()=>{
  const {service,client,audit}=harness({results:{[resultId]:correctedAfterRelease,[pendingResultId]:neverReleased}});
  await byOrder(service).listReleasedForEhrOrder(doctor,sourceEhrOrderId);
  expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
  expect(audit.recordWithClient).toHaveBeenCalledWith(client,auditEvent({action:'lab.result.released.read',resourceType:'lab-work-item',
   resourceId:workItemId,details:{sourceEhrOrderId,results:[{resultId,versionsReturned:[1]}]}}));
 });

 it('fails the read when its audit cannot be written',async()=>{
  const {service,audit}=harness();
  const outage=new Error('audit insert failed');
  audit.recordWithClient.mockRejectedValueOnce(outage);
  await expect(byOrder(service).listReleasedForEhrOrder(doctor,sourceEhrOrderId)).rejects.toBe(outage);
 });

 it('gives Lab staff the released view on this route too',async()=>{
  const {service}=harness();
  const found=await byOrder(service).listReleasedForEhrOrder(labStaff,sourceEhrOrderId);
  expect(found.results).toEqual([{id:resultId,executionId,status:'released',verificationStatus:'verified',currentVersion:1,currentReleasedVersion:1,revisions:[released(1,12.5)]}]);
 });

 it('allows an emergency read under an active break-glass grant, as the history read does',async()=>{
  const emergency=contextWith(DOCTOR,'emergency');
  const {service,provider}=harness({},async()=>decision({purpose:'emergency',breakGlass:true}));
  await expect(byOrder(service).listReleasedForEhrOrder(emergency,sourceEhrOrderId)).resolves.toMatchObject({workItemId,results:[{id:resultId}]});
  expect(provider.authorize).toHaveBeenCalledWith({patientId,scope:'read_records',purpose:'emergency',context:emergency});
 });
});
