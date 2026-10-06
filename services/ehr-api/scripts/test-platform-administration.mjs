// Full migrated schema and real restricted login. Synthetic data only.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { canonicalJson, restoreLegacyPlatformAdmin } from './restore-legacy-platform-admin.mjs';
const scripts=path.dirname(fileURLToPath(import.meta.url));
const container=`hid-platform-admin-test-${randomUUID()}`,password=randomBytes(24).toString('hex');
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',timeout:180000,stdio:['ignore','pipe','pipe']});
const sha=value=>createHash('sha256').update(value).digest('hex');
let admin,runtime,started=false,checks=0;
try {
  docker('run','-d','--name',container,'--label','hid.purpose=disposable-platform-admin-test',
    '-e',`POSTGRES_PASSWORD=${password}`,'-p','127.0.0.1::5432','pgvector/pgvector:pg16');started=true;
  const port=Number(docker('port',container,'5432/tcp').trim().split(':').at(-1));
  const connect=async user=>{const c=new pg.Client({host:'127.0.0.1',port,user,password,database:'postgres'});
    c.on('error',()=>{});try{await c.connect();return c;}catch(e){await c.end();throw e;}};
  for(let i=0;i<60;i++){try{admin=await connect('postgres');break;}catch{await new Promise(r=>setTimeout(r,500));}}
  assert.ok(admin,'PostgreSQL startup');
  const url=new URL('postgresql://127.0.0.1/postgres');url.username='postgres';url.password=password;url.port=String(port);
  try {execFileSync(process.execPath,[path.join(scripts,'apply-migrations.mjs')],{env:{...process.env,NODE_ENV:'test',
    DATABASE_URL:url.href,DATABASE_SSL:'false',MIGRATION_TARGET:'rds'},stdio:['ignore','pipe','pipe'],timeout:180000});}
  catch(error){process.stderr.write(error.stderr?.toString()??'Migration setup failed');throw error;}
  await admin.query(await readFile(path.join(scripts,'../database/runtime-grants.sql'),'utf8'));
  const account=randomUUID(),profile=randomUUID(),run=randomUUID(),other=randomUUID();
  const payload={id:profile,auth_user_id:account,app_role:'platform_admin',active:true,deleted_at:null};
  await admin.query("insert into auth.accounts(id,subject,email) values($1::uuid,$1::uuid::text,'admin@example.test'),($2::uuid,$2::uuid::text,'ordinary@example.test')",[account,other]);
  await admin.query(`insert into migration.runs(id,source_system,source_snapshot,mode,status,started_by,source_checksum_sha256)
    values($1,'legacy_identity','synthetic-admin-snapshot','stage','running','synthetic-test',$2)`,[run,'a'.repeat(64)]);
  await admin.query(`insert into migration.source_rows(run_id,entity_type,source_pk,payload,payload_sha256)
    values($1,'user_profiles',$2,$3::jsonb,$4)`,[run,profile,JSON.stringify(payload),sha(canonicalJson(payload))]);
  await admin.query("update migration.runs set status='verified',completed_at=now() where id=$1",[run]);
  const options={runId:run,profileId:profile,sourceChecksum:'a'.repeat(64),profileChecksum:sha(canonicalJson(payload)),
    emailChecksum:sha('admin@example.test'),reason:'Owner approved restoration from verified legacy administrator profile'};
  const denied=async(optionsOverride,code)=>{await assert.rejects(restoreLegacyPlatformAdmin(admin,{...options,mode:'Apply',...optionsOverride}),{message:code});checks++;};
  await denied({sourceChecksum:'b'.repeat(64)},'VERIFIED_EXACT_SOURCE_REQUIRED');
  await denied({profileChecksum:'b'.repeat(64)},'ACTIVE_APPROVED_SOURCE_PROFILE_REQUIRED');
  await denied({emailChecksum:sha('different@example.test')},'EXACT_ACTIVE_DESIGNATED_ACCOUNT_REQUIRED');
  assert.equal((await restoreLegacyPlatformAdmin(admin,{...options,mode:'DryRun'})).changes_rolled_back,true);checks++;
  assert.equal((await admin.query('select count(*)::int count from auth.account_roles')).rows[0].count,0);checks++;
  assert.equal((await restoreLegacyPlatformAdmin(admin,{...options,mode:'Apply'})).role_created,true);checks++;
  assert.equal((await restoreLegacyPlatformAdmin(admin,{...options,mode:'Verify'})).idempotent_replay,true);checks++;
  await denied({reason:'Different restoration reason for existing administrator'},'EXISTING_RESTORATION_DIFFERS');
  assert.equal((await admin.query("select count(*)::int count from audit.events where action='admin.platform-role.legacy-restore'")).rows[0].count,1);checks++;
  await admin.query(`create role platform_admin_test_runtime login inherit nosuperuser nobypassrls password '${password}';
    grant hid_identity_api_runtime to platform_admin_test_runtime;`);
  runtime=await connect('platform_admin_test_runtime');
  assert.deepEqual((await runtime.query("select rolsuper,rolbypassrls from pg_roles where rolname=current_user")).rows[0],{rolsuper:false,rolbypassrls:false});checks++;
  const bind=async subject=>{await runtime.query('begin');await runtime.query(`select set_config('app.actor_subject',$1,true),
    set_config('app.facility_id','',true),set_config('app.membership_id','',true),
    set_config('app.correlation_id','platform-admin-test',true),set_config('app.purpose_of_use','healthcare-operations',true)`,[subject]);};
  const expectDeny=async(sql,parameters,code='42501')=>{await bind(account);
    await assert.rejects(runtime.query(sql,parameters),{code});await runtime.query('rollback');checks++;};
  await bind(account);
  assert.equal((await runtime.query('select platform.current_facility_id() facility,platform.current_membership_id() membership')).rows[0].facility,null);checks++;
  assert.ok((await runtime.query('select * from platform.admin_list_integration_providers()')).rowCount>0);checks++;
  const event=[account,account];
  const insert=`insert into audit.events(correlation_id,actor_type,actor_account_id,actor_subject,action,outcome,purpose_of_use,provenance)
    values('platform-admin-test','platform',$1,$2,'admin.integration.list','success','healthcare-operations','application')`;
  await runtime.query(insert,event);await runtime.query('commit');checks++;
  await bind(other);await assert.rejects(runtime.query('select * from platform.admin_list_integration_providers()'),{code:'42501'});
  await runtime.query('rollback');checks++;
  await expectDeny(insert,[other,other]);
  await expectDeny(insert.replace("'admin.integration.list'","'ehr.record.read'"),event,'23514');
  await expectDeny(insert.replace("'healthcare-operations'","null"),event,'23514');
  await expectDeny(insert.replace("'platform'","'staff'"),event,'23514');
  await expectDeny('update audit.events set reason=$1',['rewrite audit']);
  await expectDeny('delete from audit.events');
  await expectDeny('select * from ehr.encounters');
  await expectDeny('select * from auth.admin_transition_account($1,2,\'disabled\',\'Cannot remove the final administrator\',\'last-admin-disable\',$2)',[account,'a'.repeat(64)],'23514');
  await expectDeny('select * from auth.admin_change_platform_role($1,2,\'platform_super_admin\',\'revoke\',\'Cannot revoke the final administrator\',\'last-admin-revoke\',$2)',[account,'a'.repeat(64)],'23514');
  // A second real platform-only administrator is a reachable admin path.
  await admin.query(`insert into auth.account_roles(id,account_id,role_code,scope_type,grant_reason)
    values(gen_random_uuid(),$1,'platform_super_admin','platform','Synthetic second administrator')`,[other]);
  await bind(account);await runtime.query("select * from auth.admin_transition_account($1,2,'disabled','Second administrator remains active','second-admin-present',$2)",[account,'a'.repeat(64)]);
  await runtime.query('rollback');checks++;
  // Suspension and revocation immediately remove platform permission.
  await admin.query("update auth.accounts set status='disabled' where id=$1",[account]);
  await expectDeny(insert,event);
  await admin.query("update auth.accounts set status='active' where id=$1",[account]);
  await admin.query("update auth.account_roles set revoked_at=now(),revoked_by=$1,revocation_reason='Synthetic revocation check' where account_id=$1",[account]);
  await expectDeny(insert,event);
  console.log(JSON.stringify({passed:true,checks,restricted_login:true,customer_data:false,clinical_access_denied:true}));
} finally {
  for(const c of [runtime,admin])await c?.end().catch(()=>{});
  if(started)docker('rm','-f',container);
}
