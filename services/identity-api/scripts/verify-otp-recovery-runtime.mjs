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
const notification = { deliver: async input => { delivered=input;return { outcome:'accepted',provider:'ses' }; } };
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
  process.stdout.write(JSON.stringify({status:'passed',scope:'local-synthetic-only',role:'hid_identity_api_runtime',otp_start_verify_complete:'passed',provider:'test-double-no-delivery',concurrent_completion_successes:1,concurrent_completion_denials:1,argon2_password_verified:true,semantic_audit_count:1,disabled_after_verification_denied:true,reenabled_old_challenge_denied:true,concurrent_rate_allowed:5,concurrent_rate_denied:3})+'\n');
} finally { await pool.end(); }
