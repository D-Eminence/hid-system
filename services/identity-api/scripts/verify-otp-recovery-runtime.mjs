#!/usr/bin/env node
// Called by the private synthetic migration rehearsal, never an external DB.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
const service = resolve(import.meta.dirname, '..');
const require = createRequire(join(service, 'package.json'));
const socket = process.env.PGHOST;
assert(process.env.NODE_ENV === 'test' && socket?.startsWith('/tmp/hid-tuf-migration.')
  && process.env.PGDATABASE === 'hid_rehearsal', 'Only the owned synthetic rehearsal is supported');
require('ts-node').register({ project: join(service, 'tsconfig.json'), transpileOnly: true });
require('reflect-metadata');
const { Pool } = require('pg');
const { OtpService } = require(join(service, 'src/auth/otp.service.ts'));
const pool = new Pool({ host: socket, user: process.env.PGUSER, database: process.env.PGDATABASE, max: 20 });
let delivered;
const deliveries=[];
// Captures the code as notification-api would receive it, synchronously inside start().
const notification = { deliver: async input => { delivered=input;deliveries.push(input);return { outcome:'accepted',provider:'ses' }; } };
const database = {
  query: async (sql, values) => {
    const client=await pool.connect();
    try { await client.query('begin');await client.query('set local role hid_identity_api_runtime');
      const result=await client.query(sql,values);await client.query('commit');return result;
    } catch(error){await client.query('rollback');throw error;}finally{client.release();}
  },
  withSystemTransaction: async (correlation, operation) => {
    const client=await pool.connect();
    try {await client.query('begin');await client.query('set local role hid_identity_api_runtime');
      await client.query("select set_config('app.actor_subject','system:auth',true),set_config('app.correlation_id',$1,true)",[correlation]);
      const result=await operation(client);await client.query('commit');return result;
    } catch(error){await client.query('rollback');throw error;}finally{client.release();}
  },
};
const otp=new OtpService(database,notification);
const id=randomUUID();
const email=`synthetic-${id}@example.invalid`;
// Recovery reaches only the account kind of its page (0086); these accounts
// are patients, whose code goes only to a verified contact.
const HID_ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const syntheticHid=()=>`HID-${Array.from(randomBytes(12),byte=>HID_ALPHABET[byte%32]).join('')}`;
const patientAccount=async(accountId,accountEmail,label,{verified=true}={})=>{
  await pool.query(`insert into auth.accounts(id,subject,email,status,email_verified_at)
    values($1,$2,$3,'active',case when $4 then clock_timestamp() end)`,[accountId,`synthetic:${label}:${accountId}`,accountEmail,verified]);
  await pool.query(`insert into identity.patients(id,account_id,hid_code,first_name,last_name,full_name)
    values($1,$2,$3,'Synthetic','Recovery','Synthetic Recovery')`,[randomUUID(),accountId,syntheticHid()]);
};
try {
  await patientAccount(id,email,'otp-runtime');
  // A Google link of the account: a completed recovery must revoke it (0086).
  await pool.query(`insert into auth.external_identities(id,account_id,issuer,subject,status,source_system)
    values($1,$2,'https://accounts.google.com',$3,'active','synthetic')`,[randomUUID(),id,`synthetic-google-${id}`]);
  // The legacy importer's provenance record (issuer 'legacy-identity') is not a
  // sign-in: a recovery keeps it and does not count it. 0086 tells it apart by
  // issuer. The synthetic row is marked source_system 'synthetic', not
  // 'legacy_identity': the rehearsal later promotes and reconciles a synthetic
  // legacy source in the same database, and reconciliation counts every
  // 'legacy_identity' row as one the importer must account for.
  await pool.query(`insert into auth.external_identities(id,account_id,issuer,subject,status,source_system)
    values($1,$2,'legacy-identity',$3,'active','synthetic')`,[randomUUID(),id,id]);
  const started=await otp.start({audience:'patient',identifier:email,purpose:'PASSWORD_RESET',remoteIp:'192.0.2.219',correlationId:'otp-runtime-start-001'});
  assert.equal(delivered.challengeId,started.challengeId);
  assert.match(delivered.code,/^\d{6}$/);
  const verified=await otp.verify({challengeId:started.challengeId,purpose:'PASSWORD_RESET',code:delivered.code,correlationId:'otp-runtime-verify-001'});
  const completion={challengeId:started.challengeId,purpose:'PASSWORD_RESET',verificationToken:verified.verificationToken,newPassword:'Synthetic-Recovery-Password-2026',correlationId:'otp-runtime-complete-001'};
  const concurrent=await Promise.allSettled([otp.complete(completion),otp.complete(completion)]);
  assert.equal(concurrent.filter(result=>result.status==='fulfilled').length,1,'Only one concurrent completion may succeed');
  const denial=concurrent.find(result=>result.status==='rejected');
  assert.equal(denial.reason.code,'OTP_INVALID_OR_EXPIRED');
  const current=(await pool.query('select password_hash,password_algorithm,token_version::integer from auth.accounts where id=$1',[id])).rows[0];
  assert.equal(current.token_version,2);assert.equal(current.password_algorithm,'argon2id');
  assert(await require('argon2').verify(current.password_hash,completion.newPassword));
  assert.equal((await pool.query("select count(*)::integer as n from audit.events where actor_account_id=$1 and action='auth.otp.recovery.completed'",[id])).rows[0].n,1);
  assert.deepEqual((await pool.query(`select issuer,status,revoked_at is not null as revoked from auth.external_identities
    where account_id=$1 order by issuer`,[id])).rows,
    [{issuer:'https://accounts.google.com',status:'revoked',revoked:true},{issuer:'legacy-identity',status:'active',revoked:false}],
    'A completed recovery must revoke the account\'s Google link and keep its legacy provenance record');
  assert.equal((await pool.query(`select details->>'external_identities_revoked' as n from audit.events
    where actor_account_id=$1 and action='auth.otp.recovery.completed'`,[id])).rows[0].n,'1');
  const disabledId=randomUUID(), disabledEmail=`synthetic-${disabledId}@example.invalid`;
  await patientAccount(disabledId,disabledEmail,'otp-disabled');
  const pending=await otp.start({audience:'patient',identifier:disabledEmail,purpose:'PASSWORD_RESET',remoteIp:'192.0.2.221',correlationId:'otp-disable-start-001'});
  const proof=await otp.verify({challengeId:pending.challengeId,purpose:'PASSWORD_RESET',code:delivered.code,correlationId:'otp-disable-verify-001'});
  await pool.query("update auth.accounts set status='disabled',token_version=token_version+1,row_version=row_version+1 where id=$1",[disabledId]);
  const disabledCompletion={...completion,challengeId:pending.challengeId,verificationToken:proof.verificationToken,correlationId:'otp-disable-complete-001'};
  await assert.rejects(otp.complete(disabledCompletion),error=>error.code==='OTP_INVALID_OR_EXPIRED');
  assert.equal((await pool.query('select status from auth.accounts where id=$1',[disabledId])).rows[0].status,'disabled');
  await pool.query("update auth.accounts set status='active',token_version=token_version+1,row_version=row_version+1 where id=$1",[disabledId]);
  await assert.rejects(otp.complete(disabledCompletion),error=>error.code==='OTP_INVALID_OR_EXPIRED');
  const unknownIdentifier=`absent-${randomUUID()}@example.invalid`;
  const rate=await Promise.allSettled(Array.from({length:8},()=>otp.start({audience:'patient',identifier:unknownIdentifier,purpose:'PASSWORD_RESET',remoteIp:'192.0.2.220',correlationId:'otp-runtime-rate-001'})));
  assert.equal(rate.filter(result=>result.status==='fulfilled').length,5,'Exactly five concurrent first-bucket requests may be accepted');
  assert.equal(rate.filter(result=>result.status==='rejected'&&result.reason.code==='OTP_RATE_LIMITED').length,3);
  // Uniform cooldown (0081): the accepted starts for one unknown identifier share one challengeId, as a known one's do.
  const rateIds=new Set(rate.filter(result=>result.status==='fulfilled').map(result=>result.value.challengeId));
  assert.equal(rateIds.size,1,'Concurrent recovery starts for one unknown identifier must answer one challengeId within the cooldown');
  // IP-1: the start limit is per client network against the real table. Six
  // clients each get their own bucket; every address of one IPv6 /64 shares
  // one, so rotating addresses inside an allocation does not reset it; and a
  // start with no client address is refused rather than charged to a bucket
  // every such request would share.
  const networkStarts=addresses=>Promise.allSettled(addresses.map((remoteIp,index)=>otp.start({identifier:`absent-${randomUUID()}@example.invalid`,purpose:'PASSWORD_RESET',remoteIp,correlationId:`otp-network-${index}`})));
  const ipv4Clients=await networkStarts(Array.from({length:6},(_,index)=>`198.51.100.${150+index}`));
  assert.equal(ipv4Clients.filter(result=>result.status==='fulfilled').length,6,'Six clients with their own addresses must each be accepted');
  const oneAllocation=await networkStarts(Array.from({length:7},(_,index)=>`2001:db8:4:5:${index+1}::${index+9}`));
  assert.equal(oneAllocation.filter(result=>result.status==='fulfilled').length,5,'Every address of one IPv6 /64 must share one start bucket');
  assert.equal(oneAllocation.filter(result=>result.status==='rejected'&&result.reason.code==='OTP_RATE_LIMITED').length,2);
  assert.equal((await otp.start({identifier:`absent-${randomUUID()}@example.invalid`,purpose:'PASSWORD_RESET',remoteIp:'2001:db8:4:6::1',correlationId:'otp-network-other'})).accepted,true,'Another /64 must have its own bucket');
  for (const remoteIp of [undefined,'not-an-address']) await assert.rejects(otp.start({identifier:`absent-${randomUUID()}@example.invalid`,purpose:'PASSWORD_RESET',remoteIp,correlationId:'otp-network-none'}),
    error=>error.code==='OTP_RATE_LIMIT_UNAVAILABLE'&&error.getStatus()===503,'A start without a client address must answer 503, never share a bucket');
  // One failure budget per account across its challenges and purposes (five wrong codes in 15 minutes by default).
  const budgetId=randomUUID(), budgetEmail=`synthetic-${budgetId}@example.invalid`;
  await patientAccount(budgetId,budgetEmail,'otp-budget');
  const startBudget=async(purpose,ip)=>{const sent=deliveries.length;
    const started=await otp.start({audience:'patient',identifier:budgetEmail,purpose,remoteIp:ip,correlationId:`otp-budget-start-${ip.split('.').at(-1)}`});
    return {started,delivery:deliveries.length>sent?deliveries.at(-1):null};};
  const wrong=code=>code==='000000'?'000001':'000000';
  const probe=await startBudget('LEGACY_SESSION_FALLBACK','192.0.2.230');
  const reset=await startBudget('PASSWORD_RESET','192.0.2.231');
  const legacy=await startBudget('LEGACY_ACCOUNT_RECOVERY','192.0.2.232');
  for (const value of [probe,reset,legacy]) assert.equal(value.delivery?.challengeId,value.started.challengeId,'Each failure-budget challenge must be delivered');
  for (let attempt=1;attempt<=4;attempt++) await assert.rejects(otp.verify({challengeId:reset.started.challengeId,purpose:'PASSWORD_RESET',code:wrong(reset.delivery.code),correlationId:`otp-budget-wrong-${attempt}`}),error=>error.code==='OTP_INVALID_OR_EXPIRED');
  const exhaustion=await Promise.allSettled([
    otp.verify({challengeId:reset.started.challengeId,purpose:'PASSWORD_RESET',code:wrong(reset.delivery.code),correlationId:'otp-budget-race-reset'}),
    otp.verify({challengeId:legacy.started.challengeId,purpose:'LEGACY_ACCOUNT_RECOVERY',code:wrong(legacy.delivery.code),correlationId:'otp-budget-race-legacy'})]);
  assert.deepEqual(exhaustion.map(result=>result.status==='rejected'?String(result.reason.code):'verified'),['OTP_INVALID_OR_EXPIRED','OTP_INVALID_OR_EXPIRED'],
    'Concurrent wrong codes for two purposes of one account at its failure budget must both be refused with OTP_INVALID_OR_EXPIRED, never a database error');
  await assert.rejects(otp.verify({challengeId:probe.started.challengeId,purpose:'LEGACY_SESSION_FALLBACK',code:probe.delivery.code,correlationId:'otp-budget-correct'}),
    error=>error.code==='OTP_INVALID_OR_EXPIRED','A correct recovery code was accepted after its account spent the failure budget');
  // As the owner, end the three starts' cooldowns (not the budget): a new start must still send nothing.
  await pool.query("update auth.otp_start_cooldowns set started_at=started_at-interval '2 minutes' where challenge_id=any($1::uuid[])",[[probe,reset,legacy].map(value=>value.started.challengeId)]);
  await pool.query("update auth.otp_challenges set created_at=created_at-interval '2 minutes' where account_id=$1",[budgetId]);
  const suspended=await startBudget('PASSWORD_RESET','192.0.2.233');
  assert.equal(suspended.delivery,null,'A recovery start for an account whose failure budget is spent must send no code');
  assert.notEqual(suspended.started.challengeId,reset.started.challengeId);
  // As the owner, end the block early: the account recovers with a new code.
  const lifted=await pool.query("update auth.otp_rate_limits set blocked_until=null where scope='account' and blocked_until>clock_timestamp()");
  assert.equal(lifted.rowCount,1,'Exactly one account failure budget must be blocked after the budget check');
  await pool.query("update auth.otp_start_cooldowns set started_at=started_at-interval '2 minutes' where challenge_id=$1",[suspended.started.challengeId]);
  const recovered=await startBudget('PASSWORD_RESET','192.0.2.234');
  assert.equal(recovered.delivery?.challengeId,recovered.started.challengeId,'A recovery start after the failure block ends must deliver a code');
  assert.equal((await otp.verify({challengeId:recovered.started.challengeId,purpose:'PASSWORD_RESET',code:recovered.delivery.code,correlationId:'otp-budget-recovered'})).verified,true);
  assert.equal(typeof otp.settleDeliveries,'function','OtpService must let its owner wait for deliveries that run after the response');

  // REC-AUDIENCE (0086): each recovery page reaches only its own kind of
  // account. A start on another page is answered like an unknown identifier,
  // counts nothing for the account and sends nothing.
  const staffId=randomUUID(), staffEmail=`synthetic-staff-${staffId}@example.invalid`;
  await pool.query("insert into auth.accounts(id,subject,email,status) values($1,$2,$3,'active')",[staffId,`synthetic:otp-staff:${staffId}`,staffEmail]);
  await pool.query(`insert into identity.staff(id,account_id,full_name,email,verification_status,default_role)
    values($1,$2,'Synthetic Staff',$3,'verified','nurse')`,[randomUUID(),staffId,staffEmail]);
  // A live staff session and a live platform session that the staff reset must end.
  for (const [kind,minutes] of [['staff',60],['platform',10]]) {
    const sessionId=randomUUID();
    await pool.query(`insert into auth.sessions(id,account_id,family_id,refresh_token_sha256,access_jti,account_token_version,
        authentication_method,issued_at,expires_at,absolute_expires_at,session_kind)
      values($1,$2,$1,$3,$4,1,'password',clock_timestamp(),clock_timestamp()+make_interval(mins=>$5),clock_timestamp()+interval '1 hour',$6)`,
    [sessionId,staffId,randomBytes(32).toString('hex'),randomUUID(),minutes,kind]);
  }
  const sentBeforeAudience=deliveries.length;
  const answerShape=answer=>({...answer,challengeId:typeof answer.challengeId});
  const unknownStaff=await otp.start({audience:'staff',identifier:`absent-staff-${randomUUID()}@example.invalid`,purpose:'PASSWORD_RESET',remoteIp:'192.0.2.240',correlationId:'otp-audience-unknown'});
  const mismatched=[
    await otp.start({audience:'patient',identifier:staffEmail,purpose:'PASSWORD_RESET',remoteIp:'192.0.2.241',correlationId:'otp-audience-patient-page'}),
    await otp.start({audience:'platform',identifier:staffEmail,purpose:'PASSWORD_RESET',remoteIp:'192.0.2.242',correlationId:'otp-audience-admin-page'}),
    await otp.start({audience:'staff',identifier:email,purpose:'PASSWORD_RESET',remoteIp:'192.0.2.243',correlationId:'otp-audience-staff-page'}),
  ];
  await otp.settleDeliveries();
  assert.equal(deliveries.length,sentBeforeAudience,'A recovery start on another page must send no code');
  for (const answer of mismatched) assert.deepEqual(answerShape(answer),answerShape(unknownStaff),'A start on another page must be answered like an unknown identifier');
  assert.equal((await pool.query('select count(*)::integer as n from auth.otp_challenges where account_id=$1',[staffId])).rows[0].n,0);
  const staffStart=await otp.start({audience:'staff',identifier:staffEmail,purpose:'PASSWORD_RESET',remoteIp:'192.0.2.244',correlationId:'otp-audience-staff'});
  await otp.settleDeliveries();
  assert.equal(deliveries.length,sentBeforeAudience+1,'The staff page must reach a staff account at its provisioned email');
  assert.deepEqual([delivered.challengeId,delivered.recipient],[staffStart.challengeId,staffEmail]);
  const staffProof=await otp.verify({challengeId:staffStart.challengeId,purpose:'PASSWORD_RESET',code:delivered.code,correlationId:'otp-audience-staff-verify'});
  await otp.complete({challengeId:staffStart.challengeId,purpose:'PASSWORD_RESET',verificationToken:staffProof.verificationToken,
    newPassword:'Synthetic-Staff-Recovery-2026',correlationId:'otp-audience-staff-complete'});
  assert.deepEqual((await pool.query(`select session_kind,revocation_reason from auth.sessions where account_id=$1 order by session_kind`,[staffId])).rows,
    [{session_kind:'platform',revocation_reason:'password_recovered_with_otp'},{session_kind:'staff',revocation_reason:'password_recovered_with_otp'}],
    'A completed staff reset must end every staff and platform session of the account');

  // REC-UNVERIFIED-CONTACT (0086): a patient's code goes only to a verified contact.
  const unverifiedId=randomUUID(), unverifiedEmail=`synthetic-unverified-${unverifiedId}@example.invalid`;
  await patientAccount(unverifiedId,unverifiedEmail,'otp-unverified',{verified:false});
  const sentBeforeUnverified=deliveries.length;
  const unverified=await otp.start({audience:'patient',identifier:unverifiedEmail,purpose:'PASSWORD_RESET',remoteIp:'192.0.2.245',correlationId:'otp-unverified-start'});
  await otp.settleDeliveries();
  assert.equal(deliveries.length,sentBeforeUnverified,'A patient with an unverified email and no verified phone must be sent no code');
  assert.deepEqual(answerShape(unverified),answerShape(unknownStaff));
  assert.equal((await pool.query('select count(*)::integer as n from auth.otp_challenges where account_id=$1',[unverifiedId])).rows[0].n,0);
  // As the owner, verify the email and end the cooldown: the same start now delivers.
  await pool.query('update auth.accounts set email_verified_at=clock_timestamp() where id=$1',[unverifiedId]);
  await pool.query("update auth.otp_start_cooldowns set started_at=started_at-interval '2 minutes' where challenge_id=$1",[unverified.challengeId]);
  const verifiedStart=await otp.start({audience:'patient',identifier:unverifiedEmail,purpose:'PASSWORD_RESET',remoteIp:'192.0.2.246',correlationId:'otp-verified-start'});
  await otp.settleDeliveries();
  assert.deepEqual([delivered.challengeId,delivered.recipient],[verifiedStart.challengeId,unverifiedEmail]);
  process.stdout.write(JSON.stringify({status:'passed',scope:'local-synthetic-only',role:'hid_identity_api_runtime',otp_start_verify_complete:'passed',provider:'test-double-no-delivery',concurrent_completion_successes:1,concurrent_completion_denials:1,argon2_password_verified:true,semantic_audit_count:1,disabled_after_verification_denied:true,reenabled_old_challenge_denied:true,concurrent_rate_allowed:5,concurrent_rate_denied:3,concurrent_unknown_start_challenge_ids:rateIds.size,failure_budget_correct_code_denied:true,failure_budget_two_purpose_denials:2,failure_budget_suspended_start_codes:0,failure_budget_recovered_after_block:true,network_clients_accepted:6,ipv6_allocation_accepted:5,ipv6_allocation_denied:2,missing_client_address:'503 OTP_RATE_LIMIT_UNAVAILABLE',
    recovery_revoked_google_link:true,recovery_kept_legacy_provenance:true,audience_mismatch_codes:0,audience_mismatch_uniform:true,staff_reset_ended_staff_and_platform_sessions:true,
    unverified_patient_email_codes:0,verified_patient_email_delivered:true})+'\n');
} finally {
  // Deliveries and their bookkeeping run after start() answers; let them finish before the pool ends.
  await otp.settleDeliveries?.();
  await pool.end();
}
