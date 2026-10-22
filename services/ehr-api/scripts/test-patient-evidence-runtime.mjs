// Real restricted login, synthetic accounts, disposable full migrated schema.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import pg from 'pg';
const require = createRequire(import.meta.url);
const { PatientChatHistoryService } = require('../dist/ehr/patient-records/patient-chat-history.service.js');
const { PatientEvidenceService } = require('../dist/ehr/patient-records/patient-evidence.service.js');
const { AuditService } = require('../dist/audit/audit.service.js');
const container = `hid-chat-history-test-${randomUUID()}`;
const password = randomBytes(24).toString('hex');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 180000, stdio: ['ignore','pipe','pipe'] });
let admin, runtime, started = false;
// Test-only simple DML batches. Each statement binds only its own placeholders.
async function preparedBatch(client,sql,values=[]) {
 for(const part of sql.split(';').filter(p=>p.trim())) {
  const ids=[...new Set([...part.matchAll(/\$(\d+)/g)].map(m=>Number(m[1])))].sort((a,b)=>a-b);
  const mapped=part.replace(/\$(\d+)/g,(_m,n)=>'$'+(ids.indexOf(Number(n))+1));
  await client.query(mapped,ids.map(i=>values[i-1]));
 }
}
try {
  docker('run','-d','--name',container,'--label','hid.purpose=disposable-chat-history-test',
    '-e',`POSTGRES_PASSWORD=${password}`,'-p','127.0.0.1::5432','pgvector/pgvector:pg16'); started=true;
  const port = Number(docker('port',container,'5432/tcp').trim().split(':').at(-1));
  const connect = async user => { const client = new pg.Client({host:'127.0.0.1',port,user,password,database:'postgres'});
    client.on('error',()=>{}); try { await client.connect(); return client; } catch(error) { await client.end(); throw error; } };
  for(let i=0;i<60;i++) { try {admin=await connect('postgres');break;} catch {await new Promise(r=>setTimeout(r,500));} }
  assert.ok(admin,'Disposable PostgreSQL startup');
  const url=new URL('postgresql://127.0.0.1/postgres');url.username='postgres';url.password=password;url.port=String(port);
  execFileSync(process.execPath,[path.join(import.meta.dirname,'apply-migrations.mjs')],{env:{...process.env,NODE_ENV:'test',
    DATABASE_URL:url.href,DATABASE_SSL:'false',MIGRATION_TARGET:'rds'},stdio:['ignore','pipe','pipe'],timeout:180000});
  await admin.query(await readFile(path.join(import.meta.dirname,'../database/runtime-grants.sql'),'utf8'));
  await admin.query(`create role chat_test_runtime login inherit nosuperuser nobypassrls password '${password}'; grant hid_ehr_api_runtime to chat_test_runtime;`);
  runtime=await connect('chat_test_runtime');
  const a=randomUUID(),b=randomUUID(),accountA=randomUUID(),accountB=randomUUID();
  await admin.query(`insert into auth.accounts(id,subject,email) values ($1,'chat-synthetic-a','a@example.test'),($2,'chat-synthetic-b','b@example.test')`,[accountA,accountB]);
  await admin.query(`insert into identity.patients(id,account_id,hid_code,first_name,last_name,full_name) values
    ($1,$2,'HID-CHATA2','Synthetic','A','Synthetic A'),($3,$4,'HID-CHATB2','Synthetic','B','Synthetic B')`,[a,accountA,b,accountB]);
  // The patient-self context is bound to a live patient session (0083), as
  // Identity's self authorization returns one.
  const liveSession=async(account,patient)=>{const id=randomUUID();
    await admin.query(`insert into auth.sessions(id,account_id,family_id,refresh_token_sha256,access_jti,account_token_version,
      authentication_method,issued_at,expires_at,absolute_expires_at,session_kind,patient_id)
      select $1::uuid,a.id,$1::uuid,md5($1::uuid::text)||md5($1::uuid::text),gen_random_uuid(),a.token_version,'password',
      clock_timestamp(),clock_timestamp()+interval '1 hour',clock_timestamp()+interval '2 hours','patient',$2::uuid
      from auth.accounts a where a.id=$3::uuid`,[id,patient,account]);
    return id;};
  const sessionA=await liveSession(accountA,a),sessionB=await liveSession(accountB,b);
  let authorization={patientId:a,accountId:accountA,subject:'chat-synthetic-a',sessionId:sessionA,expiresAt:new Date(Date.now()+30000).toISOString()};
  const database={withPatientTransaction:async(auth,correlation,operation)=>{
    await runtime.query('begin');
    try {await runtime.query(`select set_config('app.patient_id',$1,true),set_config('app.account_id',$2,true),
      set_config('app.actor_subject',$3,true),set_config('app.session_id',$4,true),set_config('app.self_authorized_until',$5,true),
      set_config('app.correlation_id',$6,true),set_config('app.purpose_of_use','patient-self',true)`,
    [auth.patientId,auth.accountId,auth.subject,auth.sessionId,auth.expiresAt,correlation]);
      const value=await operation(runtime);await runtime.query('commit');return value;
    } catch(error) {await runtime.query('rollback');throw error;}
  }};
  const records={authorizeSelf:async()=>({...authorization,expiresAt:new Date(Date.now()+30000).toISOString()})};
  const evidence=new PatientEvidenceService(database,records,{patientReleasedResults:async()=>({records:[],nextCursor:null})},new AuditService(database),{read:async()=>({records:[],pending:0,complete:true})},{patientProfile:async()=>({patientId:authorization.patientId,version:1})});
  const history=new PatientChatHistoryService(database,records,new AuditService(database),evidence);
  const request={correlationId:'synthetic-history-test'};
  const reply={status:'ready',answer:'Synthetic capability answer.',sources:[]};
  assert.equal((await history.read(request)).exchanges.length,0);
  const generation=await history.start(request,authorization);
  assert.equal((await history.context(request,generation)).exchanges.length,0);
  await history.save(request,generation,'Synthetic private question',reply);
  assert.equal((await history.read(request)).exchanges[0].question,'Synthetic private question');
  assert.equal((await history.context(request,generation)).exchanges[0].question,'Synthetic private question');
  for(let i=0;i<11;i++) await history.save(request,generation,'Question '+i,reply);
  assert.equal((await history.read(request)).exchanges.length,10);
  assert.equal((await admin.query('select count(*)::int as count from ehr.patient_chat_messages where patient_id=$1',[a])).rows[0].count,10);
  assert.equal((await history.context(request,generation)).exchanges.length,4);
  authorization={...authorization,patientId:b,accountId:accountB,subject:'chat-synthetic-b',sessionId:sessionB};
  assert.equal((await history.read(request)).exchanges.length,0);
  const bGeneration=await history.start(request,authorization);
  assert.equal((await history.context(request,bGeneration)).exchanges.length,0);
  await database.withPatientTransaction(authorization,'cross-patient',async client=>{
    assert.equal((await client.query('select * from ehr.patient_chat_messages where patient_id=$1',[a])).rows.length,0);
    assert.equal((await client.query('delete from ehr.patient_chat_messages where patient_id=$1',[a])).rowCount,0);
  });
  await assert.rejects(database.withPatientTransaction(authorization,'cross-insert',client=>client.query(
    'insert into ehr.patient_chat_messages(patient_id,generation,question,reply,source_bindings) values ($1,$2,$3,$4,$5)',
    [a,generation,'Forbidden question',JSON.stringify(reply),'[]'])),{code:'42501'});
  authorization={...authorization,patientId:a,accountId:accountA,subject:'chat-synthetic-a',sessionId:sessionA};
  await history.clear(request);
  assert.equal((await history.read(request)).exchanges.length,0);
  await assert.rejects(history.save(request,generation,'Late result',reply),/conversation was cleared/);
  await assert.rejects(history.context(request,generation),/conversation was cleared/);
  const fresh=await history.start(request,authorization);
  await history.save(request,fresh,'Expired synthetic message',reply);
  await admin.query("update ehr.patient_chat_messages set created_at=now()-interval '31 days' where patient_id=$1",[a]);
  assert.equal((await history.read(request)).exchanges.length,0);
  assert.equal((await admin.query('select count(*)::int as count from ehr.patient_chat_messages')).rows[0].count,0);
  await history.save(request,fresh,'Invisible stale citation',reply);
  await admin.query(`update ehr.patient_chat_messages set source_bindings=$1 where patient_id=$2`,
    [JSON.stringify([{noteId:randomUUID(),revisionNo:1,hash:'a'.repeat(64)}]),a]);
  assert.equal((await history.read(request)).exchanges.length,0);
  assert.equal((await runtime.query('select count(*)::int as count from ehr.patient_chat_messages')).rows[0].count,0);
  assert.equal((await runtime.query('select rolsuper,rolbypassrls from pg_roles where rolname=current_user')).rows[0].rolbypassrls,false);
  assert.equal((await history.context(request,fresh)).exchanges.length,0);
  // Actual current clinical sources in a disposable synthetic database only.
  const staffAccount=randomUUID();
  await admin.query("insert into auth.accounts(id,subject,email) values ($1,'synthetic:self:3','doctor@example.test')",[staffAccount]);
  const fixture=await readFile(path.join(import.meta.dirname,'../database/tests/patient-self.integration.sql'),'utf8');
  let seed=fixture.split('-- Clinical fixture attribution uses a separate real workforce principal.')[1].split('-- Seed a different patient')[0];
  for(const [from,to] of [['a1000000-0000-4000-8000-000000000001',accountA],['a1000000-0000-4000-8000-000000000002',accountB],
    ['a1000000-0000-4000-8000-000000000003',staffAccount],['a2000000-0000-4000-8000-000000000001',a],['a2000000-0000-4000-8000-000000000002',b]]) {
    seed=seed.replaceAll(from,to);
  }
  // The fixture constructs patient UUIDs in SELECTs, so substitute those expressions too.
  seed=seed.replaceAll("('a2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid",`(case when n=1 then '${a}' else '${b}' end)::uuid`);
  seed=seed.replaceAll("('a2000000-0000-4000-8000-'||lpad((case when n=3 then 2 else 1 end)::text,12,'0'))::uuid",`(case when n=3 then '${b}' else '${a}' end)::uuid`);
  await admin.query("select set_config('app.correlation_id','synthetic-clinical-context',true);\n"+seed);
  await history.clear(request);
  const noteGeneration=await history.start(request,authorization);
  const noteId='a8000000-0000-4000-8000-000000000001';
  const evidenceReply={status:'ready',answer:'Synthetic clinical content [1].',sources:[{number:1,noteId,revisionNo:1,title:'Synthetic note',signedAt:new Date().toISOString()}]};
  await history.save(request,noteGeneration,'Explain the synthetic note',evidenceReply);
  const context=await history.context(request,noteGeneration);
  assert.equal(context.bindings[0].id,noteId);
  await history.save(request,noteGeneration,'A follow-up',reply,context.bindings);
  assert.equal((await history.read(request)).exchanges.length,2);
  await assert.rejects(history.save(request,noteGeneration,'Stale follow-up',reply,[{...context.bindings[0],hash:'f'.repeat(64)}]),/source records changed/);
  const inherited=(await admin.query('select source_bindings from ehr.patient_chat_messages where question=$1',['A follow-up'])).rows[0].source_bindings;
  assert.deepEqual(inherited,context.bindings);
  // Old evidence is no longer current: both the original and inherited reply must disappear.
  await preparedBatch(admin,`begin;
    select set_config('app.change_reason','Synthetic context amendment',true),set_config('app.correlation_id','synthetic-context-amendment',true),set_config('app.actor_subject','synthetic:self:3',true),set_config('app.membership_id','a6000000-0000-4000-8000-000000000001',true),
      set_config('app.facility_id','a4000000-0000-4000-8000-000000000002',true),set_config('app.purpose_of_use','direct-care',true);
    insert into ehr.clinical_note_revisions(clinical_note_id,patient_id,facility_id,revision_no,content,change_reason,created_by,created_by_membership_id)
      select id,patient_id,facility_id,2,'Updated synthetic clinical content','Synthetic amendment',created_by,created_by_membership_id
      from ehr.clinical_notes where id='${noteId}';
    update ehr.clinical_notes set current_revision_no=2,status='amended' where id='${noteId}';
    commit;`);
  assert.equal((await history.read(request)).exchanges.length,0);
  assert.equal((await history.context(request,noteGeneration)).exchanges.length,0);

  // Add an imported patient report with exact immutable provenance.
  const migrationRun=randomUUID(),importId=randomUUID(),versionId=randomUUID();
  await preparedBatch(admin,`begin;set constraints all deferred;
    insert into migration.runs(id,source_system,source_snapshot,mode,status,started_by)
    values($1,'synthetic-evidence','synthetic-records','stage','running','synthetic-test');`,[migrationRun]);
  await admin.query(`insert into ehr.imported_medical_records(id,patient_id,author_account_id,origin,current_version_id,source_run_id,
    source_payload,source_sha256,source_created_at,source_updated_at) values($1,$2,$3,'patient-provided',$4,$5,
    '{"title":"Synthetic reported medication","info_type":"medication"}',repeat('a',64),'2020-01-01','2020-01-01')`,[importId,a,accountA,versionId,migrationRun]);
  await preparedBatch(admin,`insert into ehr.imported_medical_record_versions(id,record_id,patient_id,version_no,author_account_id,origin,
    source_payload,source_sha256,source_created_at) values($1,$2,$3,2,$4,'patient-provided',
    '{"record":"Patient reports synthetic medicine","structured_data":{"medication_name":"Synthetic medicine"}}',repeat('b',64),'2020-01-01');commit;`,[versionId,importId,a,accountA]);
  const priorVersion=randomUUID();
  await admin.query(`insert into ehr.imported_medical_record_versions(id,record_id,patient_id,version_no,author_account_id,origin,
    source_payload,source_sha256,source_created_at) values($1,$2,$3,1,$4,'patient-provided',
    '{"record":"Historical diabetes mention"}',repeat('f',64),'2019-01-01')`,[priorVersion,importId,a,accountA]);
  let snapshot=await evidence.snapshot(request);
  const imported=snapshot.records.find(r=>r.kind==='import'&&r.id===importId);
  assert.ok(imported);assert.match(imported.provenance,/Patient reported/);
  assert.equal(snapshot.records.find(r=>r.kind==='import_version'&&r.id===priorVersion)?.quality,'superseded imported version; historical evidence, not current clinical truth');
  assert.equal(snapshot.records.some(r=>r.id==='a8000000-0000-4000-8000-000000000002'),false,'Draft note withheld');
  assert.equal(snapshot.records.some(r=>r.id==='a8000000-0000-4000-8000-000000000003'),false,'Other patient withheld');
  const typedReply={status:'ready',answer:'The patient reports a medicine [1].',sources:[{...imported,number:1}]};
  await history.save(request,noteGeneration,'Imported medicine',typedReply);
  assert.equal((await history.read(request)).exchanges.length,1);
  // Derived-vector isolation and lack of patient clinical-write authority.
  await database.withPatientTransaction(authorization,'synthetic-evidence-vector',async client=>{
    await client.query(`insert into ehr.patient_evidence_chunks(patient_id,source_kind,source_id,source_version,source_hash,chunk_no,model_id,embedding)
    values($1,'import',$2,$3,$4,0,'synthetic-model',(array_fill(0::real,array[1024]))::public.vector)`,[a,imported.id,imported.version,imported.hash]);
    assert.equal((await client.query('select count(*)::int count from ehr.patient_evidence_chunks')).rows[0].count,1);
  });
  authorization={...authorization,patientId:b,accountId:accountB,subject:'chat-synthetic-b',sessionId:sessionB};
  assert.equal((await evidence.snapshot(request)).records.some(r=>r.id===importId),false);
  await database.withPatientTransaction(authorization,'synthetic-other-vector',async client=>{
    assert.equal((await client.query('select count(*)::int count from ehr.patient_evidence_chunks')).rows[0].count,0);
  });
  authorization={...authorization,patientId:a,accountId:accountA,subject:'chat-synthetic-a',sessionId:sessionA};

  // Existing full native-schema fixture exercises real clinical/Lab triggers.
  const schemaFixture=(await readFile(path.join(import.meta.dirname,'../database/tests/schema.integration.sql'),'utf8'))
    .split('-- Pharmacy foundation:')[0].split('\n').filter(line=>line.charCodeAt(0)!==92).join('\n')
    .replace("('healthcare-operations', 'Healthcare operations', 'schema-test');","('healthcare-operations', 'Healthcare operations', 'schema-test') on conflict(code) do nothing;")
    +'\nreset role;commit;';
  await admin.query(schemaFixture);
  const verifier=randomUUID(),verifierStaff=randomUUID(),verifierMembership=randomUUID(),verification=randomUUID();
  await preparedBatch(admin,`begin;
    insert into auth.accounts(id,subject,email,status) values($1,'staff:synthetic-evidence-verifier','verifier@example.test','active');
    insert into identity.staff(id,account_id,full_name,email,verification_status,default_role)
    values($2,$1,'Synthetic verifier','verifier@example.test','verified','lab');
    insert into identity.staff_facility_memberships(id,staff_id,account_id,organization_id,facility_id,membership_role,app_role,is_primary,active)
    values($3,$2,$1,'10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','lab','lab',true,true);`,[verifier,verifierStaff,verifierMembership]);
  await preparedBatch(admin,`insert into auth.account_roles(id,account_id,role_code,scope_type,membership_id,facility_id,grant_reason)
    values($1,$2,'lab','facility',$3,'10000000-0000-4000-8000-000000000002','Synthetic independent verifier');
    select set_config('app.actor_subject','staff:synthetic-evidence-verifier',true),
    set_config('app.membership_id',$3::text,true),set_config('app.facility_id','10000000-0000-4000-8000-000000000002',true),
    set_config('app.correlation_id','synthetic-lab-release-evidence',true),set_config('app.purpose_of_use','direct-care',true);`,[randomUUID(),verifier,verifierMembership]);
  await admin.query(`insert into lab.result_verifications(id,result_id,execution_id,patient_id,facility_id,result_version,
    verified_by,verified_by_membership_id,verified_at,reason,idempotency_key,request_sha256,correlation_id)
    select $1,id,execution_id,patient_id,facility_id,current_version,$2,$3,clock_timestamp(),'Synthetic exact-version verification',
    'synthetic-evidence-verification-01',repeat('c',64),'synthetic-lab-release-evidence' from lab.results where id='f2000000-0000-4000-8000-000000000002'`,[verification,verifier,verifierMembership]);
  await preparedBatch(admin,`insert into lab.result_releases(verification_id,result_id,execution_id,patient_id,facility_id,result_version,
    released_by,released_by_membership_id,released_at,reason,idempotency_key,request_sha256,correlation_id)
    select $1,id,execution_id,patient_id,facility_id,current_version,$2,$3,clock_timestamp(),'Synthetic exact-version release',
    'synthetic-evidence-release-01',repeat('d',64),'synthetic-lab-release-evidence' from lab.results where id='f2000000-0000-4000-8000-000000000002';commit;`,[verification,verifier,verifierMembership]);
  await admin.query(`create role lab_evidence_test login inherit nosuperuser nobypassrls password '${password}';grant hid_lab_api_runtime to lab_evidence_test;`);
  const labRuntime=await connect('lab_evidence_test');
  const labPatientSession=await liveSession('20000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000001');
  try {
    const {PATIENT_LAB_QUERY}=require('../../lab-api/dist/lab/patient-results.service.js');
    const staffLabRead=async(patient,facility='10000000-0000-4000-8000-000000000002')=>{
      await labRuntime.query('begin');
      try {
        await labRuntime.query(`select set_config('app.actor_subject','staff:test-clinician',true),
          set_config('app.facility_id',$1,true),set_config('app.membership_id','40000000-0000-4000-8000-000000000001',true),
          set_config('app.purpose_of_use','direct-care',true),set_config('app.correlation_id','synthetic-staff-lab-evidence',true),
          set_config('app.patient_id','',true),set_config('app.self_authorized_until','',true)`,[facility]);
        return (await labRuntime.query(PATIENT_LAB_QUERY,[patient,''])).rows;
      } finally {await labRuntime.query('rollback');}
    };
    assert.equal((await staffLabRead('50000000-0000-4000-8000-000000000001')).length,1,'Restricted Lab role reads authorized staff released results');
    assert.equal((await staffLabRead(a)).length,0,'Staff Lab collection excludes another patient without consent');
    assert.equal((await staffLabRead('50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003')).length,0,'Staff Lab collection retains facility isolation');
    await labRuntime.query('begin');
    await labRuntime.query(`select set_config('app.actor_subject','patient:test-person',true),set_config('app.account_id','20000000-0000-4000-8000-000000000002',true),
      set_config('app.patient_id','50000000-0000-4000-8000-000000000001',true),set_config('app.session_id',$1,true),
      set_config('app.self_authorized_until',$2,true),set_config('app.correlation_id','synthetic-lab-evidence-read',true),
      set_config('app.purpose_of_use','patient-self',true),set_config('app.facility_id','',true),set_config('app.membership_id','',true)`,[labPatientSession,new Date(Date.now()+30000).toISOString()]);
    const result=(await labRuntime.query(PATIENT_LAB_QUERY,['50000000-0000-4000-8000-000000000001',''])).rows;
    assert.equal(result.length,1);assert.equal(result[0].fields.numericValue,'12.7');assert.equal(result[0].fields.unit,'g/dL');
    assert.equal((await labRuntime.query(PATIENT_LAB_QUERY,[a,''])).rows.length,0,'Other patient cannot be selected by changing SQL parameter');
    assert.equal((await labRuntime.query("select has_table_privilege(current_user,'ehr.clinical_notes','SELECT') allowed")).rows[0].allowed,false);
    await labRuntime.query('rollback');
    await preparedBatch(admin,`begin;select set_config('app.actor_subject','staff:synthetic-evidence-verifier',true),
      set_config('app.membership_id',$1::text,true),set_config('app.facility_id','10000000-0000-4000-8000-000000000002',true),
      set_config('app.correlation_id','synthetic-result-invalidation',true),set_config('app.purpose_of_use','direct-care',true);`,[verifierMembership]);
    await preparedBatch(admin,`insert into lab.result_invalidations(result_id,execution_id,patient_id,facility_id,result_version,actor_id,actor_membership_id,disposition,
      reason,idempotency_key,request_sha256,correlation_id)
      select id,execution_id,patient_id,facility_id,current_version,$1,$2,'entered_in_error','Synthetic invalidation test','synthetic-invalidation-evidence-01',repeat('e',64),
      'synthetic-result-invalidation' from lab.results where id='f2000000-0000-4000-8000-000000000002';commit;`,[verifier,verifierMembership]);
    await labRuntime.query('begin');
    await labRuntime.query(`select set_config('app.actor_subject','patient:test-person',true),set_config('app.account_id','20000000-0000-4000-8000-000000000002',true),
      set_config('app.patient_id','50000000-0000-4000-8000-000000000001',true),set_config('app.session_id',$1,true),
      set_config('app.self_authorized_until',$2,true),set_config('app.correlation_id','synthetic-lab-invalidation-read',true),
      set_config('app.purpose_of_use','patient-self',true)`,[labPatientSession,new Date(Date.now()+30000).toISOString()]);
    assert.equal((await labRuntime.query(PATIENT_LAB_QUERY,['50000000-0000-4000-8000-000000000001',''])).rows.length,0,'Invalidated current version withheld');
    await labRuntime.query('rollback');
    assert.equal((await staffLabRead('50000000-0000-4000-8000-000000000001')).length,0,'Invalidated current version withheld from staff');
  } finally {await labRuntime.end();}
  // Positive native clinical adapters use an attributed synthetic clinician,
  // then complete the encounter before exposing observations to patient self.
  await preparedBatch(admin,`begin;select set_config('app.actor_subject','synthetic:self:3',true),
    set_config('app.membership_id','a6000000-0000-4000-8000-000000000001',true),
    set_config('app.facility_id','a4000000-0000-4000-8000-000000000002',true),
    set_config('app.correlation_id','synthetic-native-evidence',true),set_config('app.purpose_of_use','direct-care',true),
    set_config('app.change_reason','Synthetic encounter completion',true);
    insert into ehr.prescriptions(encounter_id,patient_id,facility_id,created_by,created_by_membership_id,medication_display,frequency,instructions,status)
    select id,patient_id,facility_id,created_by,created_by_membership_id,'Synthetic prescribed medicine','daily','Synthetic instructions','active'
    from ehr.encounters where id='a7000000-0000-4000-8000-000000000002';
    insert into ehr.diagnoses(encounter_id,patient_id,facility_id,created_by,created_by_membership_id,code_system,code,display,clinical_status,verification_status)
    select id,patient_id,facility_id,created_by,created_by_membership_id,'synthetic','synthetic-condition','Synthetic condition','active','confirmed'
    from ehr.encounters where id='a7000000-0000-4000-8000-000000000002';
    insert into ehr.vitals(encounter_id,patient_id,facility_id,created_by,created_by_membership_id,recorded_at,pulse_bpm)
    select id,patient_id,facility_id,created_by,created_by_membership_id,clock_timestamp(),80
    from ehr.encounters where id='a7000000-0000-4000-8000-000000000002';
    insert into ehr.lab_requests(encounter_id,patient_id,facility_id,created_by,created_by_membership_id,test_code_system,test_code,test_display,status)
    select id,patient_id,facility_id,created_by,created_by_membership_id,'synthetic','synthetic-test','Synthetic investigation','active'
    from ehr.encounters where id='a7000000-0000-4000-8000-000000000002';
    update ehr.encounters set status='completed',ended_at=clock_timestamp() where id='a7000000-0000-4000-8000-000000000002';commit;`);
  snapshot=await evidence.snapshot(request);
  for(const kind of ['prescription','diagnosis','vital','investigation'])assert.ok(snapshot.records.some(r=>r.kind===kind),kind+' adapter available to restricted patient context');
  const denied=await database.withPatientTransaction(await records.authorizeSelf(request),'synthetic-forbidden-clinical-write',client=>
    client.query("update ehr.prescriptions set status='cancelled' where patient_id=$1",[a]));
  assert.equal(denied.rowCount,0,'Patient self cannot mutate clinician prescriptions');
  const {staffChatRuntimeChecks}=await import('./staff-chat-runtime-checks.mjs');
  await staffChatRuntimeChecks({admin,runtime,patientA:a,patientB:b,staffAccount});
  console.log(JSON.stringify({passed:true,restricted_login:true,legacy_checks:15,
    evidence_checks:['typed imports','patient-reported provenance','draft exclusion','cross-patient vectors','restricted Lab released results','staff Lab patient and facility isolation','exact result invalidation'],
    conversation_checks:['bounded context','patient isolation','clear generation','current source bindings','stale inherited reply withheld'],customer_data:false}));
} finally {
  await runtime?.end().catch(()=>{}); await admin?.end().catch(()=>{});
  if(started) docker('rm','-f',container);
}
