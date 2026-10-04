import type { PoolClient } from 'pg';
import type { AuditService } from '../audit/audit.service';
import type { DataAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import type { IdentityService } from '../identity/identity.service';
import { LabWorkItemsService } from './lab-work-items.service';

const facilityId='10000000-0000-4000-8000-000000000001';
const patientA='20000000-0000-4000-8000-000000000001';
const patientB='20000000-0000-4000-8000-000000000002';
const context={correlationId:'lab-work-list-test',facilityId,
 membershipId:'30000000-0000-4000-8000-000000000001',purposeOfUse:'direct-care',
 actor:{id:'actor',subject:'staff:lab',accountId:'40000000-0000-4000-8000-000000000001',
  roles:['lab'],permissions:['lab.work-item.read','lab.work-item.accept'],facilityIds:[facilityId],facilities:[],
  authenticationMethod:'local'}} satisfies DataAccessContext;
const workItem=(id:string,patientId:string)=>({id,patient_id:patientId,facility_id:facilityId,
 ordering_facility_id:facilityId,source_ehr_order_id:'50000000-0000-4000-8000-000000000001',
 source_ehr_order_version:'1',source_encounter_id:'60000000-0000-4000-8000-000000000001',
 status:'accepted',priority:'routine',accepted_by:context.actor.accountId,accepted_at:new Date(),
 row_version:'1',created_at:new Date(),test_name:'Blood test',accession_id:null,accession_number:null,specimen_statuses:[]});

function harness(rows:ReturnType<typeof workItem>[]) {
 const client={query:jest.fn(async()=>({rows}))} as unknown as PoolClient;
 const database={withTransaction:async<T>(_context:DataAccessContext,operation:(client:PoolClient)=>Promise<T>)=>operation(client)} as unknown as DatabaseService;
 const identity={authorize:jest.fn(async(patientId:string)=>({allowed:patientId===patientA,breakGlass:false}))} as unknown as IdentityService;
 const audit={recordWithClient:jest.fn(async()=>undefined)} as unknown as AuditService;
 return {service:new LabWorkItemsService(database,identity,audit),client,identity,audit};
}

describe('LabWorkItemsService authorization',()=>{
 it('filters the queue by exact patient authorization and audits the visible count',async()=>{
  const a=workItem('70000000-0000-4000-8000-000000000001',patientA);
  const b=workItem('70000000-0000-4000-8000-000000000002',patientB);
  const {service,identity,audit}=harness([a,b]);
  const result=await service.list(context);
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({id:a.id,patientId:patientA});
  expect(identity.authorize).toHaveBeenCalledWith(patientA,'read_records','direct-care',context);
  expect(identity.authorize).toHaveBeenCalledWith(patientB,'read_records','direct-care',context);
  expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({
   action:'lab.work-item.list',details:{resultCount:1},outcome:'success',
  }));
 });

 it('does not accept a Lab handoff without permission or from another facility',async()=>{
  const {service,client}=harness([]);
  const command={sourceEhrOrderId:'50000000-0000-4000-8000-000000000001',sourceEhrOrderVersion:1,
   sourceEncounterId:'60000000-0000-4000-8000-000000000001',patientId:patientA,
   orderingFacilityId:facilityId,testCodeSystem:'LOINC',testCode:'718-7',testName:'Haemoglobin',
   priority:'routine' as const,requestedBy:context.actor.accountId,requestedAt:new Date().toISOString()};
  await expect(service.acceptEhrOrder({...context,actor:{...context.actor,permissions:[]}},command))
   .rejects.toMatchObject({status:403,code:'LAB_WORK_ITEM_ACCESS_DENIED'});
  await expect(service.acceptEhrOrder(context,{...command,orderingFacilityId:'10000000-0000-4000-8000-000000000002'}))
   .rejects.toMatchObject({status:403,code:'LAB_CROSS_FACILITY_ACCEPTANCE_DENIED'});
  expect(client.query).not.toHaveBeenCalled();
 });

 it('omits work items visible through an emergency break-glass grant',async()=>{
  const row=workItem('70000000-0000-4000-8000-000000000001',patientA);
  const {service,identity}=harness([row]);
  jest.spyOn(identity,'authorize').mockResolvedValue({allowed:true,breakGlass:true,patientId:patientA,
   facilityId,membershipId:context.membershipId,scope:'read_records',purpose:'emergency'});
  await expect(service.list({...context,purposeOfUse:'emergency'})).resolves.toEqual({items:[]});
 });
});
