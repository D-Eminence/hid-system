// Disposable database, synthetic contacts, real restricted login and full grants.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
const scripts = path.dirname(fileURLToPath(import.meta.url));
const container = `hid-novu-test-${randomUUID()}`;
const password = randomBytes(24).toString('hex');
const docker = (...args) => execFileSync('docker', args, {encoding:'utf8',timeout:180000,stdio:['ignore','pipe','pipe']});
let admin, worker, unauthorized, started = false;
try {
  docker('run','-d','--name',container,'--label','hid.purpose=disposable-novu-test',
    '-e',`POSTGRES_PASSWORD=${password}`,'-p','127.0.0.1::5432','pgvector/pgvector:pg16'); started=true;
  const port = Number(docker('port',container,'5432/tcp').trim().split(':').at(-1));
  const connect = async user => { const c=new pg.Client({host:'127.0.0.1',port,user,password,database:'postgres'});
    c.on('error',()=>{});try {await c.connect();return c;}catch(e){await c.end();throw e;} };
  for(let i=0;i<60;i++){try{admin=await connect('postgres');break;}catch{await new Promise(r=>setTimeout(r,500));}}
  assert.ok(admin,'PostgreSQL startup');
  const url=new URL('postgresql://127.0.0.1/postgres');url.username='postgres';url.password=password;url.port=String(port);
  execFileSync(process.execPath,[path.join(scripts,'apply-migrations.mjs')],{env:{...process.env,NODE_ENV:'test',
    DATABASE_URL:url.href,DATABASE_SSL:'false',MIGRATION_TARGET:'rds'},stdio:['ignore','pipe','pipe'],timeout:180000});
  await admin.query(await readFile(path.join(scripts,'../database/runtime-grants.sql'),'utf8'));
  await admin.query('begin');
  await admin.query('set local role hid_event_delivery_commands');
  await admin.query('select patient_id from integration.outbox_envelopes where false');
  await admin.query('rollback');
  await admin.query(`create role novu_test_worker login inherit nosuperuser nobypassrls password '${password}';
    grant hid_notification_worker to novu_test_worker;
    create role novu_test_other login inherit nosuperuser nobypassrls password '${password}';
    grant usage on schema integration to novu_test_other;
    grant execute on function integration.notification_recipient_for_claim(uuid,uuid,uuid) to novu_test_other;
    insert into integration.inbox_consumers(consumer_name,database_role) values ('notification-worker-v1','hid_notification_worker')
      on conflict (consumer_name) do nothing;`);
  // Replace only transport input in this disposable DB. All auth/identity tables,
  // RLS policies, commands and runtime grants are the real migrations.
  await admin.query(`create table integration.novu_fixture_events (like integration.outbox_envelopes);
    create or replace view integration.outbox_envelopes with (security_invoker=true) as select * from integration.novu_fixture_events;
    grant select on integration.novu_fixture_events to hid_event_delivery_commands;`);
  const account=randomUUID(), patient=randomUUID(), event=randomUUID();
  await admin.query(`insert into auth.accounts(id,subject,email,email_verified_at) values ($1,'synthetic-novu','controlled@example.test',now());
  `,[account]);
  await admin.query(`insert into identity.patients(id,account_id,hid_code,first_name,last_name,full_name)
    values ($1,$2,'HID-ABCDEFGH','Test','Patient','Test Patient')`,[patient,account]);
  await admin.query(`insert into integration.novu_fixture_events(producer,event_id,event_type,event_version,correlation_id,patient_id)
    values ('lab',$1,'LabResultReleased',1,'synthetic-novu-event',$2)`,[event,patient]);
  worker=await connect('novu_test_worker');unauthorized=await connect('novu_test_other');
  const claim=(await worker.query(`select * from integration.claim_inbox_message('notification-worker-v1',$1,'lab',
    'LabResultReleased',1,'synthetic-novu-event',$2,'novu-test-worker',900)`,[event,'a'.repeat(64)])).rows[0].claim_token;
  const resolve=async(p=patient,t=claim,c=worker)=>(await c.query(
    'select * from integration.notification_recipient_for_claim($1,$2,$3)',[event,t,p])).rows;
  assert.equal((await resolve())[0].email,'controlled@example.test');
  assert.deepEqual(await resolve(randomUUID()),[]);
  await assert.rejects(resolve(patient,randomUUID()),{code:'55000'});
  await assert.rejects(resolve(patient,claim,unauthorized),{code:'42501'});
  await assert.rejects(worker.query('select email from auth.accounts'),{code:'42501'});
  await assert.rejects(worker.query('select id from identity.patients'),{code:'42501'});
  await assert.rejects(worker.query('select * from integration.verified_notification_recipient($1)',[patient]),{code:'42501'});
  for(const [table,column,value,id] of [
    ['auth.accounts','email_verified_at',null,account],['auth.accounts','status','disabled',account],
    ['identity.patients','status','inactive',patient],['identity.patients','notifications_enabled',false,patient]]){
    await admin.query(`update ${table} set ${column}=$1 where id=$2`,[value,id]);assert.deepEqual(await resolve(),[]);
    await admin.query(`update ${table} set ${column}=$1 where id=$2`,[column==='email_verified_at'?new Date():column==='notifications_enabled'?true:'active',id]);
  }
  await admin.query("update auth.accounts set email='changed@example.test' where id=$1",[account]);
  assert.equal((await resolve())[0].email,'changed@example.test');
  await admin.query("update integration.novu_fixture_events set producer='pharmacy'");assert.deepEqual(await resolve(),[]);
  await admin.query("update integration.novu_fixture_events set producer='lab'");
  await admin.query("update integration.inbox_messages set claim_expires_at=now()-interval '1 second'");
  await assert.rejects(resolve(),{code:'55000'});
  console.log(JSON.stringify({status:'passed',checks:14,restricted_login:true,customer_data:false}));
} finally {
  for(const c of [worker,unauthorized,admin]) await c?.end().catch(()=>{});
  if(started) docker('rm','-f',container);
}
