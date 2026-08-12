import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import type { DataAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import type { IdentityService } from '../identity/identity.service';
import { LabAccessionsService } from './lab-accessions.service';

const context={correlationId:'lab-accession-correlation',facilityId:'10000000-0000-4000-8000-000000000001',
  membershipId:'40000000-0000-4000-8000-000000000001',purposeOfUse:'direct-care',actor:{id:'actor',subject:'staff:lab',
    accountId:'20000000-0000-4000-8000-000000000001',roles:['lab'],permissions:['lab.accession.create','lab.accession.read',
      'lab.specimen.collect','lab.specimen.receive','lab.specimen.reject'],facilityIds:[],facilities:[],authenticationMethod:'local'}} satisfies DataAccessContext;
const patientId='50000000-0000-4000-8000-000000000001';
const workItemId='60000000-0000-4000-8000-000000000001';
const accessionId='70000000-0000-4000-8000-000000000001';
const specimenId='80000000-0000-4000-8000-000000000001';
const accession={id:accessionId,accession_number:'LAB-20260810-0000000001',work_item_id:workItemId,patient_id:patientId,
  facility_id:context.facilityId,status:'accessioned',priority:'routine',row_version:'1',created_at:new Date(),request_sha256:''};
const specimen={id:specimenId,specimen_identifier:'SPC-20260810-0000000001',requirement_id:'90000000-0000-4000-8000-000000000001',
  accession_id:accessionId,patient_id:patientId,facility_id:context.facilityId,specimen_type:'whole blood',container_type:'EDTA',
  status:'required',collected_at:null,received_at:null,rejected_at:null,rejection_reason:null,row_version:'1'};

const harness=(query:(sql:string,values?:unknown[])=>Promise<unknown>,decision={allowed:true,breakGlass:false})=>{
  const client={query:jest.fn(query)} as unknown as PoolClient;
  const database={withTransaction:async <T>(_context:DataAccessContext,fn:(c:PoolClient)=>Promise<T>)=>fn(client)} as unknown as DatabaseService;
  const identity={authorize:jest.fn().mockResolvedValue(decision)} as unknown as IdentityService;
  const audit={recordWithClient:jest.fn().mockResolvedValue(undefined)} as unknown as AuditService;
  return {service:new LabAccessionsService(database,identity,audit),client,identity,audit};
};

describe('LabAccessionsService',()=>{
  it('creates server-identified accession, requirement, required specimen, history, audit and outbox atomically',async()=>{
    const queries:string[]=[];
    const {service,audit}=harness(async(sql)=>{queries.push(sql);
      if(sql.includes('from lab.work_items')) return {rows:[{id:workItemId,patient_id:patientId,facility_id:context.facilityId,priority:'routine',status:'accepted'}]};
      if(sql.includes('from lab.accessions')&&sql.includes('for update')) return {rows:[]};
      if(sql.includes('insert into lab.accessions')) return {rows:[accession]};
      if(sql.includes('insert into lab.specimens')) return {rows:[specimen]};
      if(sql.includes('from lab.specimens')) return {rows:[specimen]};
      return {rows:[],rowCount:1};
    });
    const result=await service.create(context,workItemId,{requirements:[{specimenType:'whole blood',containerType:'EDTA'}],reason:'CBC collection'},'accession-test-key-0001');
    expect(result).toMatchObject({accessionNumber:'LAB-20260810-0000000001',patientId,specimens:[{status:'required'}]});
    expect(queries.some((q)=>q.includes('insert into lab.specimen_requirements'))).toBe(true);
    expect(queries.some((q)=>q.includes('insert into lab.specimen_events'))).toBe(true);
    expect(queries.some((q)=>q.includes('insert into lab.outbox_events'))).toBe(true);
    expect(queries.join('\n')).not.toMatch(/insert into (identity\.patients|ehr\.)|result|execution|instrument|qc/i);
    expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
  });

  it('replays an identical accession and rejects conflicting reuse',async()=>{
    const {requestDigest}=jest.requireActual('../common/idempotency') as typeof import('../common/idempotency');
    const normalized={requirements:[{specimenType:'whole blood',containerType:null,notes:null}],reason:'CBC collection'};
    const digest=requestDigest('lab.accession.create',{workItemId,...normalized});
    const run=async(hash:string)=>harness(async(sql)=>{
      if(sql.includes('from lab.work_items')) return {rows:[{id:workItemId,patient_id:patientId,facility_id:context.facilityId,priority:'routine',status:'accepted'}]};
      if(sql.includes('from lab.accessions')) return {rows:[{...accession,request_sha256:hash}]};
      if(sql.includes('from lab.specimens')) return {rows:[specimen]}; return {rows:[]};
    }).service.create(context,workItemId,{requirements:[{specimenType:'whole blood'}],reason:'CBC collection'},'accession-test-key-0001');
    await expect(run(digest)).resolves.toMatchObject({id:accessionId});
    await expect(run('f'.repeat(64))).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  });

  it('records collection with expected-version CAS, lifecycle evidence and minimum outbox',async()=>{
    const collected={...specimen,status:'collected',collected_at:new Date(),row_version:'2'};
    const queries:string[]=[]; const {service}=harness(async(sql)=>{queries.push(sql);
      if(sql.includes('select')&&sql.includes('from lab.specimens')) return {rows:[specimen]};
      if(sql.includes('specimen_command_idempotency')&&sql.includes('select')) return {rows:[]};
      if(sql.includes('update lab.specimens')) return {rows:[collected]}; return {rows:[],rowCount:1};
    });
    await expect(service.collect(context,accessionId,specimenId,{expectedVersion:1,collectedAt:'2026-08-10T10:00:00Z'},'specimen-command-key-0001'))
      .resolves.toMatchObject({status:'collected',version:2});
    expect(queries.some((q)=>q.includes("status='collected'"))).toBe(true);
    expect(queries.some((q)=>q.includes('insert into lab.specimen_events'))).toBe(true);
    expect(queries.some((q)=>q.includes('insert into lab.outbox_events'))).toBe(true);
  });

  it('denies absent permission and break-glass mutation before persistence',async()=>{
    const noPermission={...context,actor:{...context.actor,permissions:[]}};
    const first=harness(async()=>({rows:[]}));
    await expect(first.service.create(noPermission,workItemId,{requirements:[{specimenType:'blood'}],reason:'Required sample'},'accession-test-key-0001'))
      .rejects.toMatchObject({code:'LAB_OPERATION_ACCESS_DENIED'});
    const second=harness(async(sql)=>sql.includes('from lab.work_items')
      ? {rows:[{id:workItemId,patient_id:patientId,facility_id:context.facilityId,priority:'routine',status:'accepted'}]}:{rows:[]},
    {allowed:true,breakGlass:true});
    await expect(second.service.create(context,workItemId,{requirements:[{specimenType:'blood'}],reason:'Required sample'},'accession-test-key-0001'))
      .rejects.toMatchObject({code:'LAB_OPERATION_ACCESS_DENIED'});
  });
});
