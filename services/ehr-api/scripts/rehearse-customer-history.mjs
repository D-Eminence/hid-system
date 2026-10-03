import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createCipheriv} from 'node:crypto';
import {Readable} from 'node:stream';
import {clinicalPayload} from './customer-data-validation.mjs';
import {syntheticCustomerSource} from './customer-history-fixture.mjs';
import {syntheticAttachmentEvidence} from './attachment-evidence-fixture.mjs';
import {importHealthProfiles} from './import-staging-health-profiles.mjs';
import {importAttachmentEvidence} from './import-staging-attachment-evidence.mjs';
import {importCustomerHistory} from './import-staging-customer-history.mjs';
import {applyNativeConfiguration} from './customer-configuration-mapping.mjs';
import {collectConfigurationBaseline} from './configuration-baseline.mjs';
import {prepareConfigurationMap} from './prepare-customer-configuration-map.mjs';
import {dispatchCustomerImport} from './run-staging-customer-import.mjs';
import {encodedInput,buildCustomerImportInput} from './customer-import-input.mjs';
import {canonicalJson,sha256} from './staging-cutover-additions.mjs';

export async function rehearseCustomerHistory(client,securityAdmin,{source,parentId,fieldKey,keyReference,self,workforce}){
  const patient=source.collections.patients[0],clinical=clinicalPayload(patient),plaintext=canonicalJson(clinical);
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',fieldKey,iv);cipher.setAAD(Buffer.from(`${parentId}:${patient.id}:legacy-clinical`));
  const encrypted=Buffer.concat([cipher.update(plaintext),cipher.final()]);
  await client.query(`insert into migration.legacy_clinical_quarantine(id,run_id,patient_id,source_record_id,encrypted_payload,payload_sha256,encryption_key_reference)
    values($1,$2,$3::uuid,$3::uuid::text,$4,$5,$6)`,[randomUUID(),parentId,patient.id,Buffer.concat([Buffer.from([1]),iv,cipher.getAuthTag(),encrypted]),sha256(plaintext),keyReference]);
  const options={parentId,checksum:source.checksum,operator:'synthetic-test',fieldKey,keyReference};
  const runnerEnv={HID_DEPLOYMENT_ENV:'staging',MIGRATION_PARENT_RUN_ID:parentId,MIGRATION_PARENT_SOURCE_CHECKSUM:source.checksum,
    MIGRATION_FIXTURE_SHA256:'a'.repeat(64),MIGRATION_OPERATOR:'synthetic-test',MIGRATION_FIELD_KEY_REFERENCE:keyReference,
    MIGRATION_FIELD_ENCRYPTION_KEY_B64:fieldKey.toString('base64')};
  assert.equal((await dispatchCustomerImport(client,{operation:'HealthProfiles',e:runnerEnv})).mode,'dry-run');
  assert.equal((await client.query('select count(*)::int n from ehr.imported_patient_health_profiles')).rows[0].n,0);
  await assert.rejects(importHealthProfiles(client,{...options,fieldKey:randomBytes(32)}),/preservation evidence/);
  await dispatchCustomerImport(client,{operation:'HealthProfiles',e:runnerEnv,apply:true});await importHealthProfiles(client,{...options,apply:true});
  const evidence=syntheticAttachmentEvidence(source,'synthetic-medical-import');
  // Exercise the ECS attachment dispatcher with independently verified bytes,
  // then roll back before the existing import/repeat/malware assertions.
  const transport=structuredClone(evidence),objectBytes=Buffer.alloc(19,7);
  for(const file of transport.manifest.files) file.sha256=sha256(objectBytes);
  const manifestBytes=Buffer.from(JSON.stringify(transport.manifest));
  transport.report.manifest_sha256=sha256(manifestBytes);
  for(const scan of transport.report.files){scan.sha256=sha256(objectBytes);scan.report_sha256=sha256(canonicalJson(Object.fromEntries(Object.entries(scan).filter(([k])=>k!=='report_sha256'))));}
  const attachmentInput=buildCustomerImportInput('AttachmentEvidence',{manifest:encodedInput(manifestBytes),manifest_version_id:transport.manifestVersionId,
    report:encodedInput(Buffer.from(JSON.stringify(transport.report))),bucket:transport.bucket},
    {parentId,checksum:source.checksum,fixtureSha256:runnerEnv.MIGRATION_FIXTURE_SHA256});
  const documentKey='arn:aws:kms:eu-west-1:659225405023:key/11111111-1111-4111-8111-111111111111';
  const verifiedS3={async send(command){return {Body:Readable.from([objectBytes]),VersionId:command.input.VersionId,ContentLength:objectBytes.length,
    ServerSideEncryption:'aws:kms',SSEKMSKeyId:documentKey};}};
  const dispatched=await dispatchCustomerImport(client,{operation:'AttachmentEvidence',inputBytes:attachmentInput,s3:verifiedS3,
    e:{...runnerEnv,MIGRATION_DOCUMENT_BUCKET:transport.bucket,MIGRATION_DOCUMENT_KMS_KEY_ARN:documentKey}});
  assert.equal(dispatched.bindings,4);assert.equal(dispatched.mode,'dry-run');
  assert.equal((await client.query('select count(*)::int n from ehr.imported_attachment_bindings')).rows[0].n,0);
  const fileOptions={...options,...evidence,verifyObject:async()=>({versionId:'wrong',sha256:'b'.repeat(64),sizeBytes:19,encrypted:true})};
  await assert.rejects(importAttachmentEvidence(client,fileOptions),/integrity differs/);
  fileOptions.verifyObject=async(_key,version)=>({versionId:version,sha256:'b'.repeat(64),sizeBytes:19,encrypted:true});
  assert.equal((await importAttachmentEvidence(client,fileOptions)).bindings,4);
  assert.equal((await client.query('select count(*)::int n from ehr.imported_attachment_bindings')).rows[0].n,0);
  await importAttachmentEvidence(client,{...fileOptions,apply:true});await importAttachmentEvidence(client,{...fileOptions,apply:true});
  assert.equal((await client.query('select count(*)::int n from ehr.imported_attachment_scan_events')).rows[0].n,4);
  const newer=structuredClone(evidence.report);const scan=newer.files[0];scan.result='infected';scan.scanned_at=new Date(Date.now()+1).toISOString();
  await new Promise(resolve=>setTimeout(resolve,5));
  scan.report_sha256=sha256(canonicalJson(Object.fromEntries(Object.entries(scan).filter(([k])=>k!=='report_sha256'))));
  await importAttachmentEvidence(client,{...fileOptions,report:newer,apply:true});
  await assert.rejects(importAttachmentEvidence(client,{...fileOptions,apply:true}),/Older or simultaneous/);

  const bundle=syntheticCustomerSource(source),historyOptions={...options,bundle,sourceChecksum:bundle.checksum};
  const authCount=Number((await client.query('select count(*) n from auth.otp_challenges')).rows[0].n);
  const deliveryCount=Number((await client.query('select count(*) n from notification.delivery_attempts')).rows[0].n);
  const inputBytes=buildCustomerImportInput('CustomerHistory',{source:encodedInput(Buffer.from(JSON.stringify(bundle))),source_checksum:bundle.checksum},
    {parentId,checksum:source.checksum,fixtureSha256:runnerEnv.MIGRATION_FIXTURE_SHA256});
  const dry=await dispatchCustomerImport(client,{operation:'CustomerHistory',e:runnerEnv,inputBytes});assert.equal(dry.notifications,193);
  assert.equal((await client.query('select count(*)::int n from notification.imported_inbox_items')).rows[0].n,0);
  const applied=await dispatchCustomerImport(client,{operation:'CustomerHistory',e:runnerEnv,inputBytes,apply:true});await importCustomerHistory(client,{...historyOptions,apply:true});
  assert.equal(applied.table_dispositions,29);assert.equal(applied.configuration_retained_pending_activation,31);
  assert.equal(Number((await client.query('select count(*) n from auth.otp_challenges')).rows[0].n),authCount);
  assert.equal(Number((await client.query('select count(*) n from notification.delivery_attempts')).rows[0].n),deliveryCount);
  assert.equal((await client.query("select count(*)::int n from migration.customer_table_dispositions where run_id=$1 and disposition='excluded-invalid-outreach'",[applied.receipt_id])).rows[0].n,7);

  async function runtime(role,settings,fn){
    await securityAdmin.query('begin');
    try{await securityAdmin.query(`set local role ${role}`);for(const [k,v] of Object.entries(settings)) await securityAdmin.query('select set_config($1,$2,true)',[k,v]);return await fn(securityAdmin);}
    finally{await securityAdmin.query('rollback');}
  }
  async function clinicalRead(settings){return runtime('hid_ehr_api_runtime',settings,async c=>{
    const values=[];for(const t of ['imported_patient_health_profiles','imported_attachment_bindings','imported_attachment_scan_events']) values.push((await c.query(`select count(*)::int n from ehr.${t}`)).rows[0].n);
    return values;
  });}
  assert.deepEqual(await clinicalRead(self),[1,4,5]);assert.deepEqual(await clinicalRead({...self,'app.patient_id':randomUUID()}),[0,0,0]);
  assert.deepEqual(await clinicalRead(workforce),[1,4,5]);assert.deepEqual(await clinicalRead({...workforce,'app.facility_id':randomUUID()}),[0,0,0]);
  const subject={'app.actor_subject':self['app.actor_subject']};
  const all=[];for(const offset of [0,100,200]) all.push(...await runtime('hid_identity_api_runtime',subject,async c=>(await c.query('select * from identity.list_my_imported_notifications(100,$1)',[offset])).rows));
  assert.equal(all.length,193);assert.equal(new Set(all.map(x=>x.id)).size,193);
  const readItem=bundle.rows.find(r=>r.entity_type==='notifications'&&r.payload.read_at);
  assert.equal(new Date(all.find(r=>r.id===readItem.source_pk).read_at).toISOString(),readItem.payload.read_at);
  assert.equal((await runtime('hid_identity_api_runtime',{'app.actor_subject':workforce['app.actor_subject']},async c=>(await c.query('select * from identity.list_my_imported_notifications()')).rows)).length,0);
  await assert.rejects(runtime('hid_identity_api_runtime',{'app.actor_subject':workforce['app.actor_subject']},c=>c.query('select * from identity.mark_my_imported_notification_read($1)',[all[0].id])),/NOTIFICATION_NOT_FOUND/);
  await runtime('hid_identity_api_runtime',subject,async c=>{const read=(await c.query('select * from identity.mark_my_imported_notification_read($1)',[all[0].id])).rows[0];assert.ok(read.read_at);});
  await runtime('hid_identity_api_runtime',subject,async c=>{
    assert.equal((await c.query('select * from platform.admin_imported_customer_configuration()')).rows.length,0);
    const oid=(await securityAdmin.query("select 'platform.imported_customer_configuration'::regclass::oid oid")).rows[0].oid;
    assert.equal((await c.query('select has_table_privilege(current_user,$1::oid,\'SELECT\') allowed',[oid])).rows[0].allowed,false);
  });
  await assert.rejects(client.query('update platform.imported_customer_configuration set disposition=\'mapped\''),/Append-only|mutation|immutable/i);
  // A reviewed mapping can follow preservation, without changing the archive.
  const account=source.collections.user_profiles[1].auth_user_id;
  await client.query(`insert into auth.account_roles(id,account_id,role_code,scope_type,grant_reason)
    values($1,$2,'platform_super_admin','platform','Synthetic configuration review')`,[randomUUID(),account]);
    const actorSubject=workforce['app.actor_subject'];await client.query("select set_config('app.actor_subject',$1,false)",[actorSubject]);
    const baseline=await collectConfigurationBaseline(client,{parentId,parentChecksum:historyOptions.checksum});
    const draft=prepareConfigurationMap(bundle,baseline);
    assert.ok(draft.summary.mapped>=2);
    const generated={...draft,schema:'hid.customer-configuration-map/v1',approved_by:'Synthetic reviewer',actor_subject:actorSubject};
    const generatedDry=await importCustomerHistory(client,{...historyOptions,mapping:generated,apply:false});
    assert.equal(generatedDry.configuration_mapped,draft.summary.mapped);
    assert.equal((await client.query('select count(*)::int n from platform.imported_configuration_mappings')).rows[0].n,0);
  const originalProduct=(await client.query("select to_jsonb(p) value from platform.commercial_products p where slug='ehr'")).rows[0].value;
  const product=bundle.rows.find(r=>r.entity_type==='commercial_products'&&r.payload.slug==='ehr');
  const mapping={schema:'hid.customer-configuration-map/v1',source_checksum:bundle.checksum,approved_by:'synthetic-reviewer',actor_subject:actorSubject,
    entries:bundle.rows.filter(r=>['commercial_products','commercial_prices','platform_billing_settings','platform_controls','staff_role_policies','ai_workload_routes'].includes(r.entity_type))
      .map(r=>({category:r.entity_type,source_pk:r.source_pk,source_sha256:r.payload_sha256,action:r===product?'product':'retain',
        ...(r===product?{target:'ehr',expected_target_sha256:sha256(canonicalJson(originalProduct))}:{}),reason:'Synthetic preservation decision'}))};
  const activation=await importCustomerHistory(client,{...historyOptions,mapping,apply:true});assert.equal(activation.configuration_mapped,1);
  await importCustomerHistory(client,{...historyOptions,mapping,apply:true});
  assert.equal((await securityAdmin.query("select count(*)::int n from platform.commercial_catalog_events where correlation_id=$1",[applied.receipt_id])).rows[0].n,1);
  const display=await runtime('hid_identity_api_runtime',{'app.actor_subject':actorSubject},async c=>(await c.query('select * from platform.admin_imported_customer_configuration()')).rows);
  assert.equal(display.length,31);assert.equal(display.find(r=>r.category==='commercial_products'&&r.source_pk===product.source_pk).disposition,'mapped-target-fields');
  // Native controls are baseline checked and audited; unsupported signup flags
  // remain private source settings rather than silently becoming defaults.
  const control=bundle.rows.find(r=>r.entity_type==='platform_controls');
  const controlBaseline=(await client.query("select to_jsonb(c) value from platform.control_settings c where control_key='uploads_enabled'")).rows[0].value;
  const decision={action:'control',controls:['uploads_enabled'],expected_targets:{uploads_enabled:sha256(canonicalJson(controlBaseline))},reason:'Synthetic control preservation'};
  await client.query('begin');
  await applyNativeConfiguration(client,control,decision,{actorSubject,repeated:false,correlationId:applied.receipt_id});
  await client.query('commit');
  assert.equal((await securityAdmin.query("select count(*)::int n from platform.control_events where correlation_id=$1",[applied.receipt_id])).rows[0].n,1);
  await client.query('begin');await applyNativeConfiguration(client,control,decision,{actorSubject,repeated:true,correlationId:applied.receipt_id});await client.query('rollback');
  await client.query("update platform.commercial_products set name='Synthetic changed after mapping' where slug='ehr'");
  await assert.rejects(importCustomerHistory(client,{...historyOptions,mapping,apply:true}),/mapped configuration changed/);
  return {healthProfiles:1,attachmentBindings:4,newInfectedScanBlocksPriorClean:true,notifications:193,recipientIsolation:true,allPagesAccessible:true,
    configurationPreserved:31,mappingAfterPreservationAndNoOverwrite:true,tableDispositions:29,challengeReplay:0,outreachOperationalImport:0,syntheticEvidenceOnly:true,
      stagedInputDispatcherHealthAndHistory:true,stagedInputDispatcherAttachmentRollback:true,
      readOnlyConfigurationBaseline:true,generatedConfigurationMappingDryRun:true};
}
