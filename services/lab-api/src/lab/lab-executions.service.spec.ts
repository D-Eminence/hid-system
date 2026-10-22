import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { IdentityService } from '../identity/identity.service';
import type { AuthorizationDecision,AuthorizationRequest,IdentityProvider } from '../identity/identity.types';
import { LabExecutionsService } from './lab-executions.service';

const context={correlationId:'execution-correlation',facilityId:'10000000-0000-4000-8000-000000000001',membershipId:'40000000-0000-4000-8000-000000000001',purposeOfUse:'direct-care',actor:{id:'actor',subject:'staff:lab',accountId:'20000000-0000-4000-8000-000000000001',roles:['lab'],permissions:['lab.execution.start','lab.execution.complete','lab.execution.read','lab.result.enter','lab.result.correct'],facilityIds:[],facilities:[],authenticationMethod:'local'}} satisfies DataAccessContext;
const specimenId='50000000-0000-4000-8000-000000000001',patientId='60000000-0000-4000-8000-000000000001',executionId='70000000-0000-4000-8000-000000000001';
const harness=(query:(sql:string)=>Promise<unknown>,decision={allowed:true,breakGlass:false})=>{const client={query:jest.fn(query)} as unknown as PoolClient;const database={withTransaction:async<T>(_c:DataAccessContext,fn:(c:PoolClient)=>Promise<T>)=>fn(client)} as unknown as DatabaseService;const identity={authorize:jest.fn().mockResolvedValue(decision)} as unknown as IdentityService;const audit={recordWithClient:jest.fn().mockResolvedValue(undefined)} as unknown as AuditService;return {service:new LabExecutionsService(database,identity,audit),client,audit};};

describe('LabExecutionsService',()=>{
 it('starts only from the received specimen and preserves the exact requested test',async()=>{const queries:string[]=[];const row={id:executionId,accession_id:'80000000-0000-4000-8000-000000000001',specimen_id:specimenId,requested_test_id:'90000000-0000-4000-8000-000000000001',patient_id:patientId,facility_id:context.facilityId,status:'in_progress',method:null,started_at:new Date(),completed_at:null,row_version:'1',idempotency_key:'execution-test-key-0001',request_sha256:'a'.repeat(64),completed_idempotency_key:null,completed_request_sha256:null,test_name:'Haemoglobin',test_code:'718-7',test_code_system:'http://loinc.org'};
  const {service}=harness(async sql=>{queries.push(sql);if(sql.includes('from lab.specimens s'))return {rows:[{id:specimenId,accession_id:row.accession_id,patient_id:patientId,facility_id:context.facilityId,status:'received',row_version:'3',work_item_id:'a0000000-0000-4000-8000-000000000001'}]};if(sql.includes('where e.specimen_id'))return {rows:[]};if(sql.includes('from lab.work_item_requested_tests where'))return {rows:[{id:row.requested_test_id}]};if(sql.includes('insert into lab.test_executions'))return {rows:[row]};if(sql.includes('where e.id='))return {rows:[row]};return {rows:[]};});
  await expect(service.start(context,specimenId,{expectedSpecimenVersion:3,startedAt:'2026-08-10T10:00:00Z',reason:'Begin manual method'},'execution-test-key-0001')).resolves.toMatchObject({status:'in_progress',requestedTestId:row.requested_test_id,result:null});
  expect(queries.some(q=>q.includes('insert into lab.execution_events'))).toBe(true);expect(queries.some(q=>q.includes('insert into lab.outbox_events'))).toBe(true);expect(queries.join('\n')).not.toMatch(/analyzer|instrument|reagent|calibration|\bqc\b|verified|released/i);
 });
 it('rejects required, collected, or rejected specimens',async()=>{for(const status of ['required','collected','rejected']){const {service}=harness(async sql=>sql.includes('from lab.specimens s')?{rows:[{id:specimenId,accession_id:'80000000-0000-4000-8000-000000000001',patient_id:patientId,facility_id:context.facilityId,status,row_version:'1',work_item_id:'a0000000-0000-4000-8000-000000000001'}]}:{rows:[]});await expect(service.start(context,specimenId,{expectedSpecimenVersion:1,startedAt:'2026-08-10T10:00:00Z',reason:'Start execution'},'execution-test-key-0001')).rejects.toMatchObject({code:'SPECIMEN_NOT_EXECUTABLE'});}});
 it('rejects unauthorized and break-glass mutations',async()=>{const noPermission={...context,actor:{...context.actor,permissions:[]}};const first=harness(async()=>({rows:[]}));await expect(first.service.start(noPermission,specimenId,{expectedSpecimenVersion:3,startedAt:'2026-08-10T10:00:00Z',reason:'Start execution'},'execution-test-key-0001')).rejects.toMatchObject({code:'LAB_EXECUTION_ACCESS_DENIED'});const second=harness(async sql=>sql.includes('from lab.specimens s')?{rows:[{id:specimenId,accession_id:'80000000-0000-4000-8000-000000000001',patient_id:patientId,facility_id:context.facilityId,status:'received',row_version:'3',work_item_id:'a0000000-0000-4000-8000-000000000001'}]}:{rows:[]},{allowed:true,breakGlass:true});await expect(second.service.start(context,specimenId,{expectedSpecimenVersion:3,startedAt:'2026-08-10T10:00:00Z',reason:'Start execution'},'execution-test-key-0001')).rejects.toMatchObject({code:'LAB_EXECUTION_ACCESS_DENIED'});});
 it('rejects contradictory numeric/text result representations before persistence',async()=>{const {service,client}=harness(async()=>({rows:[]}));await expect(service.enterResult(context,executionId,{expectedExecutionVersion:2,resultType:'numeric',numericValue:12,textValue:'twelve'},'result-entry-key-0001')).rejects.toMatchObject({code:'INVALID_RESULT_VALUE'});expect(client.query).not.toHaveBeenCalled();});
 it('hides an unreleased result from a normal released-result reader',async()=>{const reader={...context,actor:{...context.actor,permissions:['lab.result.released.read']}};const resultId='a0000000-0000-4000-8000-000000000001';const {service}=harness(async sql=>{if(sql.includes('select patient_id::text from lab.results'))return {rows:[{patient_id:patientId}]};if(sql.includes('select id::text,execution_id::text,status,current_version::text'))return {rows:[{id:resultId,execution_id:executionId,status:'entered_unverified',current_version:'1'}]};if(sql.includes('from lab.result_revisions rr'))return {rows:[{result_id:resultId,execution_id:executionId,patient_id:patientId,facility_id:context.facilityId,version:'1',result_type:'numeric',numeric_value:'12.5',text_value:null,unit:'g/dL',reference_range:null,abnormal_flag:null,entered_at:new Date(),correction_reason:null,request_sha256:'a'.repeat(64),verified_at:null,released_at:null,invalidated_at:null}]};return {rows:[]};});await expect(service.getResultHistory(reader,resultId)).rejects.toMatchObject({status:404,code:'LAB_RESULT_NOT_FOUND'});});
});

describe('LabExecutionsService.listForSpecimen patient authorization',()=>{
 const resultId='b0000000-0000-4000-8000-000000000001',grantId='c0000000-0000-4000-8000-000000000001';
 const specimen={id:specimenId,accession_id:'80000000-0000-4000-8000-000000000001',patient_id:patientId,facility_id:context.facilityId};
 const execution={id:executionId,accession_id:specimen.accession_id,specimen_id:specimenId,requested_test_id:'90000000-0000-4000-8000-000000000001',patient_id:patientId,facility_id:context.facilityId,status:'completed',method:null,started_at:new Date('2026-08-10T10:00:00Z'),completed_at:new Date('2026-08-10T11:00:00Z'),row_version:'2',idempotency_key:'execution-test-key-0001',request_sha256:'a'.repeat(64),completed_idempotency_key:'execution-complete-key-0001',completed_request_sha256:'b'.repeat(64),test_name:'Haemoglobin',test_code:'718-7',test_code_system:'http://loinc.org'};
 // An entered value that is neither verified nor released.
 const unreleased={id:'d0000000-0000-4000-8000-000000000001',result_id:resultId,execution_id:executionId,patient_id:patientId,facility_id:context.facilityId,version:'1',result_type:'numeric',numeric_value:'7.1',text_value:null,unit:'g/dL',reference_range:'12.0-16.0',abnormal_flag:'low',entry_source:'manual',verification_status:'unverified',entered_at:new Date('2026-08-10T10:30:00Z'),correction_reason:null,request_sha256:'c'.repeat(64),verified_at:null,released_at:null,invalidated_at:null};
 const RESULT_READS=/\blab\.(test_executions|results|result_revisions)\b/;
 const decision=(overrides:Partial<AuthorizationDecision>={}):AuthorizationDecision=>({allowed:true,patientId,facilityId:context.facilityId,membershipId:context.membershipId,scope:'read_records',purpose:'direct-care',consentGrantId:grantId,breakGlass:false,...overrides});
 const listHarness=(authorize:(request:AuthorizationRequest)=>Promise<AuthorizationDecision>,specimenRow:typeof specimen|null=specimen,executions=[execution])=>{
  const client={query:jest.fn(async(sql:string,_values?:readonly unknown[])=>{
   if(/\bfrom lab\.specimens\b/.test(sql))return {rows:specimenRow?[specimenRow]:[]};
   if(sql.includes('from lab.test_executions e'))return {rows:executions};
   if(sql.includes('select id::text from lab.results where execution_id'))return {rows:[{id:resultId}]};
   if(sql.includes('from lab.results where id=$1'))return {rows:[{id:resultId,execution_id:executionId,status:'entered_unverified',current_version:'1'}]};
   if(sql.includes('from lab.result_revisions rr'))return {rows:[unreleased]};
   return {rows:[]};
  })};
  const database={withTransaction:async<T>(_c:DataAccessContext,fn:(c:PoolClient)=>Promise<T>)=>fn(client as unknown as PoolClient)} as unknown as DatabaseService;
  const audit={record:jest.fn().mockResolvedValue(undefined),recordWithClient:jest.fn().mockResolvedValue(undefined)};
  const provider={authorize:jest.fn(authorize),lookupExactHid:jest.fn(),consentStatus:jest.fn()} satisfies IdentityProvider;
  const identity=new IdentityService(provider,audit as unknown as AuditService);
  const service=new LabExecutionsService(database,identity,audit as unknown as AuditService);
  const statements=()=>client.query.mock.calls.map(call=>String(call[0]));
  const resultReads=()=>statements().filter(sql=>RESULT_READS.test(sql));
  const authorizationOutcomes=()=>audit.record.mock.calls.map(([event])=>event as {action:string;outcome:string;patientId?:string}).filter(event=>event.action==='identity.authorization.check');
  return {service,client,provider,audit,resultReads,authorizationOutcomes};
 };
 const expectNoResultDisclosure=(harness:ReturnType<typeof listHarness>,error:unknown)=>{
  expect(harness.resultReads()).toEqual([]);
  expect(JSON.stringify(error)).not.toContain('7.1');
 };
 const rejection=async(promise:Promise<unknown>)=>{try{await promise;}catch(error){return error;}throw new Error('Expected the specimen execution list to be refused');};

 it('authorizes the specimen patient for read_records before reading any execution or result value',async()=>{
  const harness=listHarness(async()=>decision());
  const listed=await harness.service.listForSpecimen(context,specimenId);
  expect(harness.provider.authorize).toHaveBeenCalledTimes(1);
  expect(harness.provider.authorize).toHaveBeenCalledWith({patientId,scope:'read_records',purpose:'direct-care',context});
  const authorizedAt=harness.provider.authorize.mock.invocationCallOrder[0]??Infinity;
  const firstResultRead=harness.client.query.mock.calls.findIndex(call=>RESULT_READS.test(String(call[0])));
  expect(firstResultRead).toBeGreaterThanOrEqual(0);
  expect(harness.client.query.mock.invocationCallOrder[firstResultRead]).toBeGreaterThan(authorizedAt);
  expect(listed.items).toHaveLength(1);
  expect(listed.items[0]).toMatchObject({id:executionId,patientId,result:{id:resultId,status:'entered_unverified'}});
  expect(listed.items[0]?.result?.revisions?.[0]).toMatchObject({numericValue:7.1,releaseStatus:'not_released'});
  expect(harness.authorizationOutcomes()).toEqual([expect.objectContaining({outcome:'success',patientId})]);
  const specimenLookup=harness.client.query.mock.calls.find(call=>/\bfrom lab\.specimens\b/.test(String(call[0])));
  expect(specimenLookup?.[1]).toEqual([specimenId]);
 });

 it('authorizes a visible specimen with no executions yet and returns an empty list',async()=>{
  const harness=listHarness(async()=>decision(),specimen,[]);
  await expect(harness.service.listForSpecimen(context,specimenId)).resolves.toEqual({items:[]});
  expect(harness.provider.authorize).toHaveBeenCalledWith({patientId,scope:'read_records',purpose:'direct-care',context});
  expect(harness.authorizationOutcomes()).toEqual([expect.objectContaining({outcome:'success',patientId})]);
 });

 // Lab row-level security applies the same consent check (lab.context_allows), so at
 // runtime an absent or revoked grant usually hides the specimen and returns 404 before
 // Identity is asked. These cases cover a row that is still visible while Identity refuses,
 // e.g. a grant that ends between the two checks or an Identity-only policy.

 it('reads executions only for the patient that was authorized',async()=>{
  const harness=listHarness(async()=>decision());
  await harness.service.listForSpecimen(context,specimenId);
  const executionQuery=harness.client.query.mock.calls.find(call=>String(call[0]).includes('from lab.test_executions e'));
  expect(String(executionQuery?.[0])).toMatch(/e\.patient_id\s*=\s*\$2/);
  expect(executionQuery?.[1]).toEqual([specimenId,patientId]);
 });

 it('refuses with 403 LAB_EXECUTION_ACCESS_DENIED when Identity denies the read',async()=>{
  const harness=listHarness(async()=>decision({allowed:false,consentGrantId:undefined}));
  const error=await rejection(harness.service.listForSpecimen(context,specimenId));
  expect(error).toMatchObject({status:403,code:'LAB_EXECUTION_ACCESS_DENIED'});
  expectNoResultDisclosure(harness,error);
  expect(harness.authorizationOutcomes()).toEqual([expect.objectContaining({outcome:'denied',patientId})]);
 });

 it('refuses when the clinician holds no grant for the patient',async()=>{
  // Identity reports an absent grant as a decision with no grant behind it.
  const harness=listHarness(async()=>({allowed:false,patientId,facilityId:context.facilityId,membershipId:context.membershipId,scope:'read_records',purpose:'direct-care',breakGlass:false}));
  const error=await rejection(harness.service.listForSpecimen(context,specimenId));
  expect(error).toMatchObject({status:403,code:'LAB_EXECUTION_ACCESS_DENIED'});
  expectNoResultDisclosure(harness,error);
 });

 it('refuses as soon as the grant is revoked, without reusing an earlier decision',async()=>{
  const harness=listHarness(async()=>decision());
  await expect(harness.service.listForSpecimen(context,specimenId)).resolves.toMatchObject({items:[{id:executionId}]});
  harness.provider.authorize.mockImplementation(async()=>decision({allowed:false,consentGrantId:undefined}));
  harness.client.query.mockClear();
  const error=await rejection(harness.service.listForSpecimen(context,specimenId));
  expect(error).toMatchObject({status:403,code:'LAB_EXECUTION_ACCESS_DENIED'});
  expect(harness.provider.authorize).toHaveBeenCalledTimes(2);
  expectNoResultDisclosure(harness,error);
 });

 it('propagates an explicit Identity refusal without reading results',async()=>{
  const harness=listHarness(async()=>{throw new DomainProblem(403,'IDENTITY_AUTHORIZATION_DENIED','Patient access is not authorized');});
  const error=await rejection(harness.service.listForSpecimen(context,specimenId));
  expect(error).toMatchObject({status:403,code:'IDENTITY_AUTHORIZATION_DENIED'});
  expectNoResultDisclosure(harness,error);
 });

 it('fails closed when the Identity authorization service is unavailable',async()=>{
  for(const outage of [new DomainProblem(503,'IDENTITY_SERVICE_UNAVAILABLE','Identity authorization service is unavailable'),new Error('connect ECONNREFUSED')]){
   const harness=listHarness(async()=>{throw outage;});
   const error=await rejection(harness.service.listForSpecimen(context,specimenId));
   expect(error).toBe(outage);
   expectNoResultDisclosure(harness,error);
   expect(harness.authorizationOutcomes()).toEqual([expect.objectContaining({outcome:'failure',patientId})]);
  }
 });

 it('allows an emergency read under an active break-glass grant, as get() does',async()=>{
  const emergency={...context,purposeOfUse:'emergency'} satisfies DataAccessContext;
  const harness=listHarness(async()=>decision({purpose:'emergency',breakGlass:true}));
  await expect(harness.service.listForSpecimen(emergency,specimenId)).resolves.toMatchObject({items:[{id:executionId,result:{id:resultId}}]});
  expect(harness.provider.authorize).toHaveBeenCalledWith({patientId,scope:'read_records',purpose:'emergency',context:emergency});
 });

 it('applies the same authorization outcome as the single execution read',async()=>{
  const cases:[string,()=>Promise<AuthorizationDecision>][]=[
   ['granted',async()=>decision()],
   ['break-glass',async()=>decision({breakGlass:true})],
   ['denied',async()=>decision({allowed:false,consentGrantId:undefined})],
   ['unavailable',async()=>{throw new DomainProblem(503,'IDENTITY_SERVICE_UNAVAILABLE','Identity authorization service is unavailable');}],
  ];
  for(const [label,authorize] of cases){
   const settle=(promise:Promise<unknown>)=>promise.then(()=>'allowed',(error:{code?:string})=>error.code);
   const single=listHarness(authorize),list=listHarness(authorize);
   const outcomes=[await settle(single.service.get(context,executionId)),await settle(list.service.listForSpecimen(context,specimenId))];
   expect({label,single:outcomes[0],list:outcomes[1]}).toEqual({label,single:outcomes[0],list:outcomes[0]});
   expect(list.provider.authorize.mock.calls[0]?.[0]).toEqual(single.provider.authorize.mock.calls[0]?.[0]);
  }
 });

 it('returns 404 LAB_SPECIMEN_NOT_FOUND without consulting Identity for a specimen it cannot see',async()=>{
  const harness=listHarness(async()=>decision(),null);
  const error=await rejection(harness.service.listForSpecimen(context,specimenId));
  expect(error).toMatchObject({status:404,code:'LAB_SPECIMEN_NOT_FOUND'});
  expect(harness.provider.authorize).not.toHaveBeenCalled();
  expectNoResultDisclosure(harness,error);
 });

 it('still requires lab.execution.read before any lookup',async()=>{
  const harness=listHarness(async()=>decision());
  const reader={...context,actor:{...context.actor,permissions:['lab.execution.start']}};
  const error=await rejection(harness.service.listForSpecimen(reader,specimenId));
  expect(error).toMatchObject({status:403,code:'LAB_EXECUTION_ACCESS_DENIED'});
  expect(harness.client.query).not.toHaveBeenCalled();
  expect(harness.provider.authorize).not.toHaveBeenCalled();
 });
});
