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
  await admin.query(`begin;
    select set_config('app.change_reason','Synthetic context amendment',true),set_config('app.correlation_id','synthetic-context-amendment',true),set_config('app.actor_subject','synthetic:self:3',true),set_config('app.membership_id','a6000000-0000-4000-8000-000000000001',true),
      set_config('app.facility_id','a4000000-0000-4000-8000-000000000002',true),set_config('app.purpose_of_use','direct-care',true);
    insert into ehr.clinical_note_revisions(clinical_note_id,patient_id,facility_id,revision_no,content,change_reason,created_by,created_by_membership_id)
      select id,patient_id,facility_id,2,'Updated synthetic clinical content','Synthetic amendment',created_by,created_by_membership_id
      from ehr.clinical_notes where id='${noteId}';
    update ehr.clinical_notes set current_revision_no=2,status='amended' where id='${noteId}';
    commit;`);
  assert.equal((await history.read(request)).exchanges.length,0);
  assert.equal((await history.context(request,noteGeneration)).exchanges.length,0);
  console.log(JSON.stringify({passed:true,restricted_login:true,legacy_checks:15,
    conversation_checks:['bounded context','patient isolation','clear generation','current source bindings','stale inherited reply withheld'],customer_data:false}));
} finally {
  await runtime?.end().catch(()=>{}); await admin?.end().catch(()=>{});
  if(started) docker('rm','-f',container);
}
