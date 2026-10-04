import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import type { DataAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import type { IdentityService } from '../identity/identity.service';
import { LabExecutionsService } from './lab-executions.service';

const context={correlationId:'execution-correlation',facilityId:'10000000-0000-4000-8000-000000000001',membershipId:'40000000-0000-4000-8000-000000000001',purposeOfUse:'direct-care',actor:{id:'actor',subject:'staff:lab',accountId:'20000000-0000-4000-8000-000000000001',roles:['lab'],permissions:['lab.execution.start','lab.execution.complete','lab.execution.read','lab.result.enter','lab.result.correct'],facilityIds:[],facilities:[],authenticationMethod:'local'}} satisfies DataAccessContext;
const specimenId='50000000-0000-4000-8000-000000000001',patientId='60000000-0000-4000-8000-000000000001',executionId='70000000-0000-4000-8000-000000000001';
const harness=(query:(sql:string)=>Promise<unknown>,decision={allowed:true,breakGlass:false})=>{const client={query:jest.fn(query)} as unknown as PoolClient;const database={withTransaction:async<T>(_c:DataAccessContext,fn:(c:PoolClient)=>Promise<T>)=>fn(client)} as unknown as DatabaseService;const identity={authorize:jest.fn().mockResolvedValue(decision)} as unknown as IdentityService;const audit={recordWithClient:jest.fn().mockResolvedValue(undefined)} as unknown as AuditService;return {service:new LabExecutionsService(database,identity,audit),client,audit,identity};};

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

 it('returns only released versions to a clinician after a new unreleased correction',async()=>{
  const reader={...context,actor:{...context.actor,permissions:['lab.result.released.read']}};
  const resultId='a0000000-0000-4000-8000-000000000001';
  const revision=(version:string,released:boolean)=>({result_id:resultId,execution_id:executionId,patient_id:patientId,
   facility_id:context.facilityId,version,result_type:'numeric',numeric_value:version==='1'?'12.5':'99',text_value:null,
   unit:'g/dL',reference_range:null,abnormal_flag:'unknown',entered_at:new Date(),correction_reason:version==='1'?null:'Private correction',
   request_sha256:'a'.repeat(64),verified_at:released?new Date():null,released_at:released?new Date():null,invalidated_at:null});
  const {service,audit}=harness(async sql=>{
   if(sql.includes('select patient_id::text from lab.results'))return {rows:[{patient_id:patientId}]};
   if(sql.includes('select id::text,execution_id::text,status,current_version::text'))return {rows:[{id:resultId,execution_id:executionId,status:'entered_unverified',current_version:'2'}]};
   if(sql.includes('from lab.result_revisions rr'))return {rows:[revision('1',true),revision('2',false)]};
   return {rows:[]};
  });
  const result=await service.getResultHistory(reader,resultId);
  expect(result).toMatchObject({status:'released',currentVersion:1,currentReleasedVersion:1});
  expect(result.revisions).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain('Private correction');
  expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({
   action:'lab.result.history.read',patientId,resourceId:resultId,outcome:'success',
  }));
 });

 it('requires patient authorization before aggregating specimen execution values',async()=>{
  const queried:string[]=[];
  const {service,identity}=harness(async sql=>{queried.push(sql);
   if(sql.includes('from lab.specimens where'))return {rows:[{patient_id:patientId}]};
   return {rows:[]};
  },{allowed:false,breakGlass:false});
  await expect(service.listForSpecimen(context,specimenId)).rejects.toMatchObject({status:403,code:'LAB_EXECUTION_ACCESS_DENIED'});
  expect(identity.authorize).toHaveBeenCalledWith(patientId,'read_records','direct-care',context);
  expect(queried.some(sql=>sql.includes('from lab.test_executions'))).toBe(false);
 });

 it('denies emergency break-glass access to detailed Lab results',async()=>{
  const emergency={...context,purposeOfUse:'emergency' as const};
  const {service}=harness(async sql=>sql.includes('from lab.specimens where')?{rows:[{patient_id:patientId}]}:{rows:[]},
   {allowed:true,breakGlass:true});
  await expect(service.listForSpecimen(emergency,specimenId)).rejects.toMatchObject({status:403,code:'LAB_EXECUTION_ACCESS_DENIED'});
 });

 it('lists only released result projections for the authorized patient and audits the read',async()=>{
  const clinician={...context,actor:{...context.actor,permissions:['lab.result.released.read']}};
  const resultId='a0000000-0000-4000-8000-000000000001';
  const {service,client,audit}=harness(async sql=>sql.includes('select distinct on (r.id)')?{rows:[{
   result_id:resultId,execution_id:executionId,patient_id:patientId,facility_id:context.facilityId,
   result_version:'1',result_type:'numeric',numeric_value:'12.5',text_value:null,unit:'g/dL',reference_range:null,
   abnormal_flag:'normal',released_at:new Date('2026-08-10T10:00:00Z'),test_code_system:'LOINC',
   test_code:'718-7',test_name:'Haemoglobin',
  }]}:{rows:[]});
  await expect(service.listReleasedForPatient(clinician,patientId,{limit:50,offset:0})).resolves.toMatchObject({items:[{
   resultId,patientId,resultVersion:1,numericValue:12.5,test:{code:'718-7'},
  }]});
  expect(client.query).toHaveBeenCalledWith(expect.stringContaining('not exists(select 1 from lab.result_invalidations'),
   [patientId,context.facilityId,50,0]);
  expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({
   action:'lab.result.released.list',patientId,outcome:'success',
  }));
 });

 it('does not query released values when patient authorization is denied',async()=>{
  const queries:string[]=[];
  const clinician={...context,actor:{...context.actor,permissions:['lab.result.released.read']}};
  const {service,audit}=harness(async sql=>{queries.push(sql);return {rows:[]};},{allowed:false,breakGlass:false});
  await expect(service.listReleasedForPatient(clinician,patientId,{limit:50,offset:0}))
   .rejects.toMatchObject({status:403,code:'LAB_EXECUTION_ACCESS_DENIED'});
  expect(queries).toHaveLength(0);
  expect(audit.recordWithClient).not.toHaveBeenCalled();
 });
});
