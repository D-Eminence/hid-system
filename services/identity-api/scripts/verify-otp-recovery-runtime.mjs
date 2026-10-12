#!/usr/bin/env node
// Called by the private synthetic migration rehearsal, never an external DB.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
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
try {
  await pool.query("insert into auth.accounts(id,subject,email,status) values($1,$2,$3,'active')",[id,`synthetic:otp-runtime:${id}`,email]);
  const started=await otp.start({identifier:email,purpose:'PASSWORD_RESET',remoteIp:'192.0.2.219',correlationId:'otp-runtime-start-001'});
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
  const disabledId=randomUUID(), disabledEmail=`synthetic-${disabledId}@example.invalid`;
  await pool.query("insert into auth.accounts(id,subject,email,status) values($1,$2,$3,'active')",
    [disabledId,`synthetic:otp-disabled:${disabledId}`,disabledEmail]);
  const pending=await otp.start({identifier:disabledEmail,purpose:'PASSWORD_RESET',remoteIp:'192.0.2.221',correlationId:'otp-disable-start-001'});
  const proof=await otp.verify({challengeId:pending.challengeId,purpose:'PASSWORD_RESET',code:delivered.code,correlationId:'otp-disable-verify-001'});
  await pool.query("update auth.accounts set status='disabled',token_version=token_version+1,row_version=row_version+1 where id=$1",[disabledId]);
  const disabledCompletion={...completion,challengeId:pending.challengeId,verificationToken:proof.verificationToken,correlationId:'otp-disable-complete-001'};
  await assert.rejects(otp.complete(disabledCompletion),error=>error.code==='OTP_INVALID_OR_EXPIRED');
  assert.equal((await pool.query('select status from auth.accounts where id=$1',[disabledId])).rows[0].status,'disabled');
  await pool.query("update auth.accounts set status='active',token_version=token_version+1,row_version=row_version+1 where id=$1",[disabledId]);
  await assert.rejects(otp.complete(disabledCompletion),error=>error.code==='OTP_INVALID_OR_EXPIRED');
  const unknownIdentifier=`absent-${randomUUID()}@example.invalid`;
  const rate=await Promise.allSettled(Array.from({length:8},()=>otp.start({identifier:unknownIdentifier,purpose:'PASSWORD_RESET',remoteIp:'192.0.2.220',correlationId:'otp-runtime-rate-001'})));
  assert.equal(rate.filter(result=>result.status==='fulfilled').length,5,'Exactly five concurrent first-bucket requests may be accepted');
  assert.equal(rate.filter(result=>result.status==='rejected'&&result.reason.code==='OTP_RATE_LIMITED').length,3);
  // Uniform cooldown (0081): the accepted starts for one unknown identifier share one challengeId, as a known one's do.
  const rateIds=new Set(rate.filter(result=>result.status==='fulfilled').map(result=>result.value.challengeId));
  assert.equal(rateIds.size,1,'Concurrent recovery starts for one unknown identifier must answer one challengeId within the cooldown');
  // One failure budget per account across its challenges and purposes (five wrong codes in 15 minutes by default).
  const budgetId=randomUUID(), budgetEmail=`synthetic-${budgetId}@example.invalid`;
  await pool.query("insert into auth.accounts(id,subject,email,status) values($1,$2,$3,'active')",[budgetId,`synthetic:otp-budget:${budgetId}`,budgetEmail]);
  const startBudget=async(purpose,ip)=>{const sent=deliveries.length;
    const started=await otp.start({identifier:budgetEmail,purpose,remoteIp:ip,correlationId:`otp-budget-start-${ip.split('.').at(-1)}`});
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
  process.stdout.write(JSON.stringify({status:'passed',scope:'local-synthetic-only',role:'hid_identity_api_runtime',otp_start_verify_complete:'passed',provider:'test-double-no-delivery',concurrent_completion_successes:1,concurrent_completion_denials:1,argon2_password_verified:true,semantic_audit_count:1,disabled_after_verification_denied:true,reenabled_old_challenge_denied:true,concurrent_rate_allowed:5,concurrent_rate_denied:3,concurrent_unknown_start_challenge_ids:rateIds.size,failure_budget_correct_code_denied:true,failure_budget_two_purpose_denials:2,failure_budget_suspended_start_codes:0,failure_budget_recovered_after_block:true})+'\n');
} finally {
  // Deliveries and their bookkeeping run after start() answers; let them finish before the pool ends.
  await otp.settleDeliveries?.();
  await pool.end();
}
