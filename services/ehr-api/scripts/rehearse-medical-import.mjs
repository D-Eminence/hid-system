import assert from 'node:assert/strict';
import { createCipheriv,randomBytes,randomUUID } from 'node:crypto';
import { syntheticMedicalSource } from './medical-import-fixture.mjs';
import { canonicalJson,sha256 } from './staging-cutover-additions.mjs';
import { importMedicalRecords } from './import-staging-medical-records.mjs';
import { rehearseCustomerHistory } from './rehearse-customer-history.mjs';

export async function rehearseMedicalImport(client,securityAdmin) {
  const s=syntheticMedicalSource(),parentId=randomUUID(),fieldKey=randomBytes(32),keyReference='staging-migration-v1';
  const patient=s.collections.patients[0],provider=s.collections.user_profiles[1],staff=s.collections.staff[0];
  for(const account of s.collections.accounts) await client.query(`insert into auth.accounts(id,subject,legacy_identity_user_id,source_system)
    values($1,$2,$1,'legacy_identity')`,[account.id,`synthetic-medical-${account.id}`]);
  await client.query(`insert into identity.patients(id,account_id,hid_code,first_name,last_name,full_name,source_system,source_record_id)
    values($1::uuid,$2,'HID-MEDTESTABC','Synthetic','History','Synthetic History','legacy_identity',$1::text)`,[patient.id,patient.auth_user_id]);
  await client.query(`insert into migration.runs(id,source_system,source_snapshot,mode,status,started_by)
    values($1,'legacy_identity','synthetic-medical-import','stage','running','synthetic-test')`,[parentId]);
  for(const row of s.rows) await client.query(`insert into migration.source_rows(run_id,entity_type,source_pk,payload,payload_sha256)
    values($1,$2,$3,$4,$5)`,[parentId,row.entity_type,row.source_pk,JSON.stringify(row.payload),row.payload_sha256]);
  for(const type of Object.keys(s.counts)) await client.query(`insert into migration.entity_reconciliations
    (run_id,entity_type,source_count,target_count,source_checksum_sha256,target_checksum_sha256) values($1,$2,$3,$3,$4,$4)`,[parentId,type,s.counts[type],s.checksums[type]]);
  await client.query(`update migration.runs set status='staged',source_counts=$2,source_checksum_sha256=$3 where id=$1`,[parentId,JSON.stringify(s.counts),s.checksum]);
  await client.query(`update migration.runs set status='verified',mode='reconcile',completed_at=now(),target_counts=$2,target_checksum_sha256=$3 where id=$1`,[parentId,JSON.stringify(s.counts),s.checksum]);
  for(const row of s.rows.filter(r=>r.entity_type.startsWith('medical_'))) {
    const coordinate=`public.hid_${row.entity_type}:${row.source_pk}`;
    const plaintext=canonicalJson({source_table:`public.hid_${row.entity_type}`,payload:row.payload});
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',fieldKey,iv);
    cipher.setAAD(Buffer.from(`${parentId}:${patient.id}:${coordinate}`));
    const body=Buffer.concat([cipher.update(plaintext,'utf8'),cipher.final()]);
    await client.query(`insert into migration.legacy_clinical_quarantine(id,run_id,patient_id,source_record_id,encrypted_payload,payload_sha256,encryption_key_reference)
      values($1,$2,$3,$4,$5,$6,$7)`,[randomUUID(),parentId,patient.id,coordinate,Buffer.concat([Buffer.from([1]),iv,cipher.getAuthTag(),body]),sha256(plaintext),keyReference]);
  }
  const options={parentId,checksum:s.checksum,operator:'synthetic-test',fieldKey,keyReference};
  const count=async()=>Number((await client.query('select count(*)::int n from ehr.imported_medical_records where source_run_id=$1',[parentId])).rows[0].n);
  assert.equal((await importMedicalRecords(client,options)).mode,'dry-run');assert.equal(await count(),0);
  await assert.rejects(importMedicalRecords(client,{...options,apply:true,fieldKey:randomBytes(32)}),/preservation evidence/);
  assert.equal(await count(),0);
  const applied=await importMedicalRecords(client,{...options,apply:true});
  assert.deepEqual(applied.counts,{medical_records:17,medical_record_versions:17,medical_record_files:4});
  assert.equal(await count(),17);await importMedicalRecords(client,{...options,apply:true});assert.equal(await count(),17);
  assert.equal((await client.query("select count(*)::int n from migration.runs where source_system='staging_medical_history_import'")).rows[0].n,1);
  assert.equal((await client.query('select count(*)::int n from ehr.encounters where patient_id=$1',[patient.id])).rows[0].n,0);
  assert.equal((await client.query("select count(*)::int n from ehr.imported_medical_records where source_run_id=$1 and origin='patient-provided'",[parentId])).rows[0].n,16);
  await assert.rejects(client.query('update ehr.imported_medical_records set source_sha256=$2 where id=$1',[s.collections.medical_records[0].id,'a'.repeat(64)]),/Append-only|mutation|immutable/i);
  // Canonical drift must not create another receipt or replace any source history.
  await client.query('update identity.patients set account_id=null where id=$1',[patient.id]);
  await assert.rejects(importMedicalRecords(client,{...options,apply:true}),/patient association differs/);
  await client.query('update identity.patients set account_id=$2 where id=$1',[patient.id,patient.auth_user_id]);

  const org=randomUUID(),facility=randomUUID(),membership=randomUUID(),grant=randomUUID();
  await client.query("insert into identity.purpose_of_use_codes(code,display,source_system) values('direct-care','Synthetic direct care','synthetic-test') on conflict(code) do nothing");
  await client.query(`insert into identity.organizations(id,name,slug) values($1,'Synthetic import organization',$2)`,[org,`synthetic-medical-${org}`]);
  await client.query(`insert into identity.facilities(id,organization_id,name,code,timezone,active,lifecycle_status)
    values($1,$2,'Synthetic facility',$3,'Africa/Lagos',true,'verified')`,[facility,org,`SYN-${facility}`]);
  await client.query(`insert into identity.staff(id,account_id,full_name,email,verification_status,default_role)
    values($1,$2,'Synthetic provider',$3,'verified','clinician')`,[staff.id,provider.auth_user_id,`${staff.id}@example.invalid`]);
  await client.query(`insert into identity.staff_facility_memberships(id,staff_id,account_id,organization_id,facility_id,membership_role,app_role)
    values($1,$2,$3,$4,$5,'doctor','clinician')`,[membership,staff.id,provider.auth_user_id,org,facility]);
  await client.query(`insert into identity.consent_grants(id,patient_id,staff_id,account_id,membership_id,facility_id,scope,status,reason,starts_at,expires_at,purpose_of_use)
    values($1,$2,$3,$4,$5,$6,'read_records','active','Synthetic direct care',now()-interval '1 minute',now()+interval '1 hour','direct-care')`,[grant,patient.id,staff.id,provider.auth_user_id,membership,facility]);
  const quarantineOid=(await securityAdmin.query("select 'migration.legacy_clinical_quarantine'::regclass::oid as oid")).rows[0].oid;
  async function runtimeRead(settings) {
    await securityAdmin.query('begin');
    try {
      await securityAdmin.query('set local role hid_ehr_api_runtime');
      for(const [name,value] of Object.entries(settings)) await securityAdmin.query('select set_config($1,$2,true)',[name,value]);
      const results=[];
      for(const table of ['imported_medical_records','imported_medical_record_versions','imported_medical_record_files']) results.push((await securityAdmin.query(`select count(*)::int n from ehr.${table}`)).rows[0].n);
      assert.equal((await securityAdmin.query("select has_table_privilege(current_user,'ehr.imported_medical_records','INSERT') as allowed")).rows[0].allowed,false);
      assert.equal((await securityAdmin.query("select has_table_privilege(current_user,$1::oid,'SELECT') as allowed",[quarantineOid])).rows[0].allowed,false);
      return results;
    } finally { await securityAdmin.query('rollback'); }
  }
  const self={'app.patient_id':patient.id,'app.account_id':patient.auth_user_id,'app.session_id':randomUUID(),'app.actor_subject':`synthetic-medical-${patient.auth_user_id}`,
    'app.correlation_id':'synthetic-medical-self','app.purpose_of_use':'patient-self','app.self_authorized_until':new Date(Date.now()+30000).toISOString()};
  assert.deepEqual(await runtimeRead(self),[17,17,4]);
  assert.deepEqual(await runtimeRead({...self,'app.patient_id':randomUUID()}),[0,0,0]);
  assert.deepEqual(await runtimeRead({...self,'app.self_authorized_until':'2020-01-01T00:00:00Z'}),[0,0,0]);
  const workforce={'app.actor_subject':`synthetic-medical-${provider.auth_user_id}`,'app.facility_id':facility,'app.membership_id':membership,
    'app.correlation_id':'synthetic-medical-staff','app.purpose_of_use':'direct-care'};
  const decision=(await securityAdmin.query(`select identity.has_active_membership($2,$3,$4) as membership,
    identity.has_active_consent_grant($1,$2,$3,$4,'read_records','direct-care') as consent`,
    [patient.id,workforce['app.actor_subject'],membership,facility])).rows[0];
  assert.deepEqual(decision,{membership:true,consent:true},'Synthetic staff authorization setup');
  assert.deepEqual(await runtimeRead(workforce),[17,17,4]);
  assert.deepEqual(await runtimeRead({...workforce,'app.facility_id':randomUUID()}),[0,0,0]);
  await client.query('update identity.staff_facility_memberships set active=false where id=$1',[membership]);
  assert.deepEqual(await runtimeRead(workforce),[0,0,0]);
  await client.query('update identity.staff_facility_memberships set active=true where id=$1',[membership]);
  const customerHistory=await rehearseCustomerHistory(client,securityAdmin,{source:s,parentId,fieldKey,keyReference,self,workforce});
  await client.query("update identity.consent_grants set status='revoked',revoked_at=now(),revoked_reason='Synthetic revoke' where id=$1",[grant]);
  assert.deepEqual(await runtimeRead(workforce),[0,0,0]);
  return {records:17,versions:17,files:4,dryRunRollback:true,idempotent:true,encryptedEvidenceChecked:true,canonicalDriftRejected:true,
    immutable:true,rlsSelfOtherPatientExpiredAndStaffRevocation:'passed',fabricatedEncounters:0,customerHistory,liveAttachmentScan:'still required'};
}
