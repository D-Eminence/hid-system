// Called by the disposable full-schema rehearsal. All accounts/records are synthetic.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {StaffChatHistoryService}=require('../dist/ehr/patient-records/staff-chat-history.service.js');
const {evidence:normalize,binding}=require('../dist/ehr/patient-records/patient-evidence.types.js');
const {STAFF_EVIDENCE_QUERY,StaffEvidenceService}=require('../dist/ehr/patient-records/staff-evidence.service.js');
export async function staffChatRuntimeChecks({admin,runtime,patientA,patientB,staffAccount}) {
  const facility='a4000000-0000-4000-8000-000000000002',membership='a6000000-0000-4000-8000-000000000001';
  const otherAccount=randomUUID(),otherStaff=randomUUID(),otherMember=randomUUID(),otherFacility=randomUUID();
  await admin.query("insert into auth.accounts(id,subject,email) values($1,'synthetic:staff-chat:b','staff-chat-b@example.invalid')",[otherAccount]);
  await admin.query(`insert into identity.staff(id,account_id,full_name,email,verification_status,default_role)
    values($1,$2,'Synthetic colleague','staff-chat-b@example.invalid','verified','doctor')`,[otherStaff,otherAccount]);
  await admin.query(`insert into identity.staff_facility_memberships(id,staff_id,account_id,organization_id,facility_id,membership_role,app_role,is_primary,active)
    select $1,$2,$3,organization_id,facility_id,'doctor','doctor',false,true from identity.staff_facility_memberships where id=$4`,[otherMember,otherStaff,otherAccount,membership]);
  await admin.query(`insert into auth.account_roles(id,account_id,role_code,scope_type,membership_id,facility_id,grant_reason)
    values($1,$2,'doctor','facility',$3,$4,'Synthetic staff chat test')`,[randomUUID(),otherAccount,otherMember,facility]);
  for(const patient of [patientA,patientB]) {
    const request=randomUUID();
    await admin.query(`insert into identity.access_requests(id,patient_id,staff_id,membership_id,facility_id,scope,purpose_of_use,reason,status,requested_duration_minutes,approved_by_patient_id,approved_at)
      values($1,$2,$3,$4,$5,'read_records','direct-care','Synthetic staff chat consent','approved',60,$2,clock_timestamp())`,[request,patient,otherStaff,otherMember,facility]);
    await admin.query(`insert into identity.consent_grants(id,request_id,patient_id,staff_id,account_id,membership_id,facility_id,scope,purpose_of_use,status,reason,starts_at,expires_at,break_glass)
      values($1,$2,$3,$4,$5,$6,$7,'read_records','direct-care','active','Synthetic staff chat consent',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour',false)`,
    [randomUUID(),request,patient,otherStaff,otherAccount,otherMember,facility]);
  }
  await admin.query(`insert into identity.facilities(id,organization_id,name,code,timezone,active,lifecycle_status)
    select $1,organization_id,'Synthetic other hospital','STAFFCHAT-B','Africa/Lagos',true,'verified' from identity.facilities where id=$2`,[otherFacility,facility]);
  const otherFacilityMember=randomUUID(),otherFacilityRequest=randomUUID();
  await admin.query(`insert into identity.staff_facility_memberships(id,staff_id,account_id,organization_id,facility_id,membership_role,app_role,is_primary,active)
    select $1,staff_id,account_id,organization_id,$2,'doctor','doctor',false,true from identity.staff_facility_memberships where id=$3`,[otherFacilityMember,otherFacility,membership]);
  await admin.query(`insert into auth.account_roles(id,account_id,role_code,scope_type,membership_id,facility_id,grant_reason)
    values($1,$2,'doctor','facility',$3,$4,'Synthetic second facility')`,[randomUUID(),staffAccount,otherFacilityMember,otherFacility]);
  await admin.query(`insert into identity.access_requests(id,patient_id,staff_id,membership_id,facility_id,scope,purpose_of_use,reason,status,requested_duration_minutes,approved_by_patient_id,approved_at)
    select $1,$2,staff_id,$3,$4,'read_records','direct-care','Synthetic second facility consent','approved',60,$2,clock_timestamp()
    from identity.staff_facility_memberships where id=$5`,[otherFacilityRequest,patientA,otherFacilityMember,otherFacility,membership]);
  await admin.query(`insert into identity.consent_grants(id,request_id,patient_id,staff_id,account_id,membership_id,facility_id,scope,purpose_of_use,status,reason,starts_at,expires_at,break_glass)
    select $1,$2,$3,staff_id,account_id,$4,$5,'read_records','direct-care','active','Synthetic second facility consent',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour',false
    from identity.staff_facility_memberships where id=$6`,[randomUUID(),otherFacilityRequest,patientA,otherFacilityMember,otherFacility,membership]);
  async function tx(patient,work,patch={}) {
    const ctx={subject:'synthetic:self:3',account:staffAccount,facility,membership,purpose:'direct-care',expiry:new Date(Date.now()+30000).toISOString(),correlation:'synthetic-staff-chat',permissionHash:'a'.repeat(64),...patch};
    await runtime.query('begin');
    try {
      await runtime.query(`select set_config('app.actor_subject',$1,true),set_config('app.facility_id',$2,true),
        set_config('app.membership_id',$3,true),set_config('app.purpose_of_use',$4,true),set_config('app.chat_account_id',$5,true),
        set_config('app.chat_patient_id',$6,true),set_config('app.chat_authorized_until',$7,true),
        set_config('app.correlation_id',$9,true),set_config('app.chat_permission_hash',$8,true)`,
      [ctx.subject,ctx.facility,ctx.membership,ctx.purpose,ctx.account,patient,ctx.expiry,ctx.permissionHash,ctx.correlation]);
      const value=await work(runtime);await runtime.query('commit');return value;
    }catch(error){await runtime.query('rollback');throw error;}
  }
  const evidence={bind:scope=>({snapshot:async()=>{
    const rows=await scope.transaction({},'synthetic-current',client=>client.query(STAFF_EVIDENCE_QUERY,[scope.patientId,'','',['note','prescription']]));
    return {records:rows.rows.map(r=>normalize({kind:r.kind,id:r.id,version:r.version,title:r.title,
      recordedAt:r.recorded_at?new Date(r.recorded_at).toISOString():null,effectiveAt:r.effective_at?new Date(r.effective_at).toISOString():null,
      provenance:r.provenance,quality:r.quality,fields:r.fields})),coverage:{unavailable:[]}};
  }}),auditScope:()=>({})};
  const history=new StaffChatHistoryService(evidence,{recordWithClient:async()=>{}});
  const request={correlationId:'synthetic-staff-chat'};
  const scope=(patient,patch={})=>({patientId:patient,authorize:async()=>({patientId:patient}),
    transaction:(_a,_c,work)=>tx(patient,work,patch)});
  const a=scope(patientA),b=scope(patientB),other=scope(patientA,{subject:'synthetic:staff-chat:b',account:otherAccount,membership:otherMember});
  const reply={status:'ready',answer:'Synthetic staff-only answer.',sources:[]};
  const generation=await history.bind(a).start(request);
  await history.bind(a).save(request,generation,'Patient A question',reply);
  assert.equal((await history.read(a,request)).exchanges.length,1);
  assert.equal((await history.read(b,request)).exchanges.length,0,'Patient B does not inherit A history');
  assert.equal((await history.read(other,request)).exchanges.length,0,'An independently authorized colleague does not inherit A history');
  const secondFacility=scope(patientA,{facility:otherFacility,membership:otherFacilityMember});
  assert.equal((await history.read(secondFacility,request)).exchanges.length,0,'The same clinician at another consent-authorized facility has a separate conversation');
  const secondGeneration=await history.bind(secondFacility).start(request);
  await history.bind(secondFacility).save(request,secondGeneration,'Other facility conversation',reply);
  assert.equal((await history.read(a,request)).exchanges[0].question,'Patient A question');
  assert.equal((await history.read(scope(patientA,{permissionHash:'b'.repeat(64)}),request)).exchanges.length,0,'Changed read permissions hide prior conversation context');
  const otherGeneration=await history.bind(other).start(request);
  await history.bind(other).save(request,otherGeneration,'Colleague question',reply);
  assert.equal((await history.read(a,request)).exchanges[0].question,'Patient A question');
  assert.equal((await history.read(other,request)).exchanges[0].question,'Colleague question');
  const read=client=>client.query('select question from ehr.staff_chat_messages where patient_id=$1',[patientA]);
  assert.equal((await runtime.query('select * from ehr.staff_chat_messages')).rows.length,0,'Missing transaction context denies staff history');
  for(const patch of [{facility:otherFacility},{membership:otherMember},{account:otherAccount},{purpose:'emergency'},{correlation:''},
    {expiry:new Date(Date.now()-1000).toISOString()},{expiry:new Date(Date.now()+120000).toISOString()}]) {
    assert.equal((await tx(patientA,read,patch)).rows.length,0,'Wrong or expired scope denied');
  }
  assert.equal((await tx(patientB,read)).rows.length,0,'Forged patient predicate cannot cross the selected scope');
  await assert.rejects(tx(patientB,client=>client.query(`insert into ehr.staff_chat_state(patient_id) values($1)`,[patientA])),{code:'42501'});
  assert.equal((await tx(patientA,client=>client.query('select * from ehr.patient_chat_messages'))).rows.length,0,'Staff cannot read patient private chat');
  const rows=await tx(patientA,client=>client.query(STAFF_EVIDENCE_QUERY,[patientA,'','',['note','prescription']]));
  assert.ok(rows.rows.length>0,'Staff query reads current authorized evidence');
  // Run the production staff extraction query as the actual restricted role:
  // validates view columns, joins, grants and RLS even when no clean file exists.
  const textAccess=new StaffEvidenceService(null,null,null,null).documents(a);
  const fileRows=await tx(patientA,client=>client.query(textAccess.query,[patientA,null]));
  assert.ok(fileRows.rows.every(row=>row.patient_id===patientA),'Staff file evidence query remains patient-bound');
  assert.ok(rows.rows.every(row=>['note','prescription'].includes(row.kind)),'Source-kind filtering occurs in SQL');
  assert.ok(!rows.rows.some(row=>row.id==='a8000000-0000-4000-8000-000000000003'),'Foreign patient clinical note excluded');
  await tx(patientA,client=>client.query(`insert into ehr.staff_evidence_chunks(patient_id,source_kind,source_id,source_version,source_hash,chunk_no,model_id,embedding)
    values($1,'note',$2,'1',$3,0,'synthetic-staff-test',$4::vector)`,[patientA,randomUUID(),'b'.repeat(64),JSON.stringify(Array(1024).fill(0))]));
  assert.equal((await tx(patientB,client=>client.query('select * from ehr.staff_evidence_chunks'))).rows.length,0,'Vectors isolated by patient');
  assert.equal((await tx(patientA,client=>client.query('select * from ehr.staff_evidence_chunks'),{subject:'synthetic:staff-chat:b',account:otherAccount,membership:otherMember})).rows.length,0,'Vectors isolated by clinician');
  const currentEvidence=await evidence.bind(a).snapshot();
  const note=currentEvidence.records.find(r=>r.kind==='note');assert.ok(note);
  const recordReply={status:'ready',answer:'Synthetic current note [1].',sources:[{...binding(note),number:1,title:note.title,recordedAt:note.recordedAt,effectiveAt:note.effectiveAt,provenance:note.provenance,quality:note.quality}]};
  await history.bind(a).save(request,generation,'Bound note question',recordReply);
  const context=await history.bind(a).context(request,generation);assert.ok(context.bindings.some(b=>b.id===note.id));
  await history.bind(a).save(request,generation,'Inherited note follow-up',reply,context.bindings);
  await admin.query('begin');
  await admin.query(`select set_config('app.actor_subject','synthetic:self:3',true),set_config('app.membership_id',$1,true),
    set_config('app.facility_id',$2,true),set_config('app.purpose_of_use','direct-care',true),
    set_config('app.correlation_id','synthetic-staff-source-change',true),set_config('app.change_reason','Synthetic staff source invalidation check',true)`,[membership,facility]);
  await admin.query(`insert into ehr.clinical_note_revisions(clinical_note_id,patient_id,facility_id,revision_no,content,change_reason,created_by,created_by_membership_id)
    select id,patient_id,facility_id,current_revision_no+1,'Synthetic changed clinical note','Synthetic source correction',$2,$3 from ehr.clinical_notes where id=$1`,[note.id,staffAccount,membership]);
  await admin.query("update ehr.clinical_notes set current_revision_no=current_revision_no+1,status='amended' where id=$1",[note.id]);
  await admin.query('commit');
  const refreshed=await history.read(a,request);
  assert.ok(!refreshed.exchanges.some(e=>['Bound note question','Inherited note follow-up'].includes(e.question)),'Changed evidence removes the answer and its dependent follow-up');
  await history.clear(a,request);
  await assert.rejects(history.bind(a).save(request,generation,'Late answer',reply),/conversation was cleared/);
  assert.equal((await history.read(other,request)).exchanges.length,1,'Clear preserves colleague history');
  const freshGeneration=await history.bind(a).start(request);
  for(let n=0;n<12;n++)await history.bind(a).save(request,freshGeneration,'Retention check '+n,reply);
  assert.equal((await history.read(a,request)).exchanges.length,10,'Staff history retains at most ten exchanges');
  await admin.query("update ehr.staff_chat_messages set created_at=clock_timestamp()-interval '31 days' where patient_id=$1 and account_id=$2",[patientA,staffAccount]);
  assert.equal((await history.read(a,request)).exchanges.length,0,'Expired staff messages are pruned');
  await admin.query("update identity.staff_facility_memberships set active=false where id=$1",[membership]);
  assert.equal((await tx(patientA,read)).rows.length,0,'Revoked membership denies direct SQL history reads');
  await admin.query("update identity.staff_facility_memberships set active=true where id=$1",[membership]);
  await admin.query("update identity.consent_grants set status='revoked',revoked_at=clock_timestamp() where patient_id=$1 and membership_id=$2",[patientA,otherMember]);
  assert.equal((await tx(patientA,read,{subject:'synthetic:staff-chat:b',account:otherAccount,membership:otherMember})).rows.length,0,'Revoked consent hides saved chat');
  console.log(JSON.stringify({staff_chat_runtime:true,checks:['patient isolation','colleague isolation','wrong facility/membership/account','expired context','wrong purpose','cross-patient insert denied','patient private history denied','kind-filtered clinical evidence','scoped vectors','clear generation race','exact source and inherited invalidation','permission-change history invalidation','valid second facility isolation','10 exchanges / 30 days','revoked membership','revoked consent'],customer_data:false}));
}
