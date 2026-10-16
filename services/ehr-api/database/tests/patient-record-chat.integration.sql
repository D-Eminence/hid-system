\set ON_ERROR_STOP on
\o /dev/null
-- Patient record chat (owner decision 1 of 2026-10-16). Rollback-only.
--
-- The patient's own history (ehr.patient_chat_conversations and
-- ehr.patient_chat_messages) is read, written and deleted only in a fresh
-- patient-self transaction bound to that patient (ehr.patient_self_context,
-- 0091), never updated, and checked in shape. Another patient, an expired
-- authorization, a revoked session, a mismatched account and a staff context
-- see and change nothing. The abuse and cost limits are reached only through
-- ehr.reserve_record_chat and ehr.settle_record_chat: one request in flight
-- per account, 10 an hour and 30 a day, a daily token budget with a hard
-- ceiling, an expired lease freed and its tokens counted as used, settlement
-- by the lease's own patient only. The runtime reads none of the limit
-- tables. The kill switch record_chat_enabled exists and is off. No retention
-- class, purge command or permission is added (retention is an open owner
-- decision).
--
-- Fixtures are synthetic (ids 5c4a7...), inserted as the suite runner with
-- session_replication_role = replica where a row needs a state the commands
-- would not create; CHECK constraints still apply. Every case is recorded and
-- the suite fails at the end listing every case whose outcome differs. The
-- rehearsal also runs this suite with a schema owner that is neither a
-- superuser nor BYPASSRLS (release checklist P8).
--
-- The hourly and daily cases need one UTC hour (ehr.reserve_record_chat
-- buckets by statement_timestamp()): within a minute of the next hour the
-- suite first waits for it, and at the end it fails, asking for a rerun, if
-- the run still crossed an hour boundary.
select pg_sleep(extract(epoch from date_trunc('hour', clock_timestamp(), 'UTC') + interval '1 hour' - clock_timestamp()) + 1)
 where date_trunc('hour', clock_timestamp(), 'UTC') + interval '1 hour' - clock_timestamp() < interval '60 seconds';
select set_config('hid.record_chat_suite_hour', date_trunc('hour', clock_timestamp(), 'UTC')::text, false);
begin;
set constraints all deferred;

create temporary table chat_case_results(name text primary key, expected text not null, actual text not null)
  on commit drop;
create temporary table chat_deleted(n bigint) on commit drop;
create temporary table chat_leases(name text primary key, id uuid) on commit drop;
create temporary table chat_budget_before(reserved bigint, used bigint) on commit drop;
grant all on chat_case_results, chat_deleted, chat_leases, chat_budget_before to public;

-- Accounts 1-3 are patients 1-3, account 4 a doctor. Sessions: 1 and 2 live
-- for patients 1 and 2, 3 revoked (patient 3).
insert into auth.accounts(id,subject,email,display_name,status)
select ('5c4a7100-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  'synthetic:record-chat:'||n,'record-chat-'||n||'@example.invalid','Synthetic record chat '||n,'active'
from generate_series(1,4) n;
insert into identity.patients(id,account_id,hid_code,first_name,last_name,full_name,status)
select ('5c4a7200-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('5c4a7100-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  'HID-CHATQ'||chr(64+n),'Chat','Patient '||n,'Chat Patient '||n,'active'
from generate_series(1,3) n;
insert into auth.sessions(id,account_id,family_id,refresh_token_sha256,access_jti,account_token_version,
  authentication_method,issued_at,expires_at,absolute_expires_at,session_kind,patient_id,revoked_at,revocation_reason)
select ('5c4a7300-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('5c4a7100-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('5c4a7300-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  md5('record-chat'||n)||md5('record-chat'||n),gen_random_uuid(),1,'password',clock_timestamp(),
  clock_timestamp()+interval '1 hour',clock_timestamp()+interval '2 hours','patient',
  ('5c4a7200-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  case when n=3 then clock_timestamp() end, case when n=3 then 'logout' end
from generate_series(1,3) n;
insert into identity.organizations(id,name,slug)
values('5c4a7400-0000-4000-8000-000000000001','Record chat test organization','record-chat-test-organization');
insert into identity.facilities(id,organization_id,name,code,timezone,active,lifecycle_status)
values('5c4a7400-0000-4000-8000-000000000002','5c4a7400-0000-4000-8000-000000000001','Record chat test facility',
  'CHAT-A','Africa/Lagos',true,'verified');
insert into identity.staff(id,account_id,full_name,email,verification_status,default_role)
values('5c4a7500-0000-4000-8000-000000000001','5c4a7100-0000-4000-8000-000000000004','Synthetic record chat doctor',
  'doctor-record-chat@example.invalid','verified','doctor');
insert into identity.staff_facility_memberships(id,staff_id,account_id,organization_id,facility_id,membership_role,
  app_role,is_primary,active)
values('5c4a7600-0000-4000-8000-000000000001','5c4a7500-0000-4000-8000-000000000001',
  '5c4a7100-0000-4000-8000-000000000004','5c4a7400-0000-4000-8000-000000000001',
  '5c4a7400-0000-4000-8000-000000000002','doctor','doctor',true,true);

-- The patient-self binding, as DatabaseService.withPatientTransaction sets it.
create function pg_temp.bind_self(patient_no integer, account_no integer default null,
  session_no integer default null, authorized_for interval default interval '30 seconds') returns void
language sql as $$
  select set_config('app.actor_subject','synthetic:record-chat:'||coalesce(account_no, patient_no),true),
    set_config('app.account_id','5c4a7100-0000-4000-8000-'||lpad(coalesce(account_no, patient_no)::text,12,'0'),true),
    set_config('app.session_id','5c4a7300-0000-4000-8000-'||lpad(coalesce(session_no, patient_no)::text,12,'0'),true),
    set_config('app.patient_id','5c4a7200-0000-4000-8000-'||lpad(patient_no::text,12,'0'),true),
    set_config('app.correlation_id','patient-record-chat-integration-0001',true),
    set_config('app.self_authorized_until',(clock_timestamp()+authorized_for)::text,true),
    set_config('app.purpose_of_use','patient-self',true), set_config('app.facility_id','',true),
    set_config('app.membership_id','',true), set_config('app.patient_release','',true);
$$;
-- The doctor's direct-care staff context, as DatabaseService.withTransaction sets it.
create function pg_temp.bind_staff() returns void
language sql as $$
  select set_config('app.actor_subject','synthetic:record-chat:4',true),
    set_config('app.account_id','',true), set_config('app.session_id','',true), set_config('app.patient_id','',true),
    set_config('app.self_authorized_until','',true),
    set_config('app.facility_id','5c4a7400-0000-4000-8000-000000000002',true),
    set_config('app.membership_id','5c4a7600-0000-4000-8000-000000000001',true),
    set_config('app.correlation_id','patient-record-chat-integration-staff',true),
    set_config('app.purpose_of_use','direct-care',true);
$$;
create function pg_temp.patient(n integer) returns uuid
language sql immutable as $$ select ('5c4a7200-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
create function pg_temp.conversation(n integer) returns uuid
language sql immutable as $$ select ('5c4a7700-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
create function pg_temp.message(n integer) returns uuid
language sql immutable as $$ select ('5c4a7800-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
-- A reply the service stores: answered, one record block citing source 1.
create function pg_temp.reply(answer text default 'Your blood pressure was recorded as normal.') returns jsonb
language sql immutable as $$
  select jsonb_build_object('status','answered','answer',answer,
    'blocks',jsonb_build_array(jsonb_build_object('kind','record','text',answer,'references',jsonb_build_array(1))),
    'sources',jsonb_build_array(jsonb_build_object('number',1,'kind','vital','id','5c4a7900-0000-4000-8000-000000000001',
      'recordedOn','2026-10-01','effectiveOn',null,'title','Vital signs')))
$$;
create function pg_temp.insert_message(message_no integer, patient_no integer, conversation_no integer,
  key text, question text default 'What was my last blood pressure?', reply jsonb default pg_temp.reply(),
  bindings jsonb default '[{"kind":"vital","id":"5c4a7900-0000-4000-8000-000000000001","hash":"0"}]') returns void
language sql as $$
  insert into ehr.patient_chat_messages(id,conversation_id,patient_id,idempotency_key,request_sha256,question,reply,
    source_bindings)
  values (pg_temp.message(message_no), pg_temp.conversation(conversation_no), pg_temp.patient(patient_no), key,
    repeat('a',64), question, reply, bindings)
$$;
-- The SQLSTATE a statement raises, or 'ok'.
create function pg_temp.outcome(statement text) returns text
language plpgsql as $$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate;
end
$$;
-- The SQLSTATE and message a statement raises, or 'ok'.
create function pg_temp.refusal(statement text) returns text
language plpgsql as $$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ':' || sqlerrm;
end
$$;
-- A statement's SQLSTATE and message, or 'ok'; its effects are always rolled back.
create function pg_temp.attempt(statement text) returns text
language plpgsql as $$
begin
  begin
    execute statement;
    raise exception using errcode = 'P0001', message = 'record chat attempt succeeded';
  exception when others then
    if sqlerrm = 'record chat attempt succeeded' then return 'ok'; end if;
    return sqlstate || ':' || sqlerrm;
  end;
end
$$;
-- What ehr.record_chat_history_on_hold answers for patient n, or the SQLSTATE it raises.
create function pg_temp.held(patient_no integer) returns text
language plpgsql as $$
declare
  answer boolean;
begin
  execute 'select ehr.record_chat_history_on_hold($1)' into answer using pg_temp.patient(patient_no);
  return answer::text;
exception when others then
  return sqlstate;
end
$$;
create function pg_temp.visible() returns text
language sql as $$
  select (select count(*) from ehr.patient_chat_conversations)::text || ','
    || (select count(*) from ehr.patient_chat_messages)::text
$$;
create function pg_temp.record(name text, expected text, actual text) returns void
language sql as $$
  insert into chat_case_results values (name, expected, coalesce(actual, '<none>'));
$$;
create function pg_temp.retry_after() returns text
language plpgsql as $$
declare
  seconds text;
begin
  perform ehr.reserve_record_chat('patient', '5c4a7200-0000-4000-8000-000000000001', 1000, 1000000);
  return 'not refused';
exception when sqlstate 'P4290' then
  get stacked diagnostics seconds = pg_exception_detail;
  return case when seconds ~ '^\d+$' and seconds::integer between 1 and 3600 then 'seconds' else seconds end;
end
$$;

-- 1. Patient 1, bound to their own live session, writes and reads their history.
set local role hid_ehr_api_runtime;
select pg_temp.bind_self(1);
select pg_temp.record('patient 1 starts a conversation', 'ok', pg_temp.outcome(
  $sql$insert into ehr.patient_chat_conversations(id,patient_id)
       values ('5c4a7700-0000-4000-8000-000000000001','5c4a7200-0000-4000-8000-000000000001')$sql$));
select pg_temp.record('patient 1 stores an exchange', 'ok', pg_temp.outcome(
  $sql$select pg_temp.insert_message(1, 1, 1, 'record-chat-key-000001')$sql$));
select pg_temp.record('patient 1 reads their history', '1,1', pg_temp.visible());
select pg_temp.record('the same idempotency key in the conversation', '23505', pg_temp.outcome(
  $sql$select pg_temp.insert_message(2, 1, 1, 'record-chat-key-000001')$sql$));
select pg_temp.record('a reply with an unknown status', '23514', pg_temp.outcome(
  $sql$select pg_temp.insert_message(3, 1, 1, 'record-chat-key-000003',
       reply => pg_temp.reply() || '{"status":"free_text"}')$sql$));
select pg_temp.record('a reply answer over 4000 characters', '23514', pg_temp.outcome(
  $sql$select pg_temp.insert_message(3, 1, 1, 'record-chat-key-000003', reply => pg_temp.reply(repeat('x',4001)))$sql$));
select pg_temp.record('a reply with nine blocks', '23514', pg_temp.outcome(
  $sql$select pg_temp.insert_message(3, 1, 1, 'record-chat-key-000003', reply => pg_temp.reply()
       || jsonb_build_object('blocks', (select jsonb_agg(jsonb_build_object('kind','explanation','text','x',
            'references','[]'::jsonb)) from generate_series(1,9))))$sql$));
select pg_temp.record('a reply that is not an object', '23514', pg_temp.outcome(
  $sql$select pg_temp.insert_message(3, 1, 1, 'record-chat-key-000003', reply => '["answered"]'::jsonb)$sql$));
select pg_temp.record('a question over 1000 characters', '23514', pg_temp.outcome(
  $sql$select pg_temp.insert_message(3, 1, 1, 'record-chat-key-000003', question => repeat('q',1001))$sql$));
select pg_temp.record('an empty question', '23514', pg_temp.outcome(
  $sql$select pg_temp.insert_message(3, 1, 1, 'record-chat-key-000003', question => '')$sql$));
select pg_temp.record('a short idempotency key', '23514', pg_temp.outcome(
  $sql$select pg_temp.insert_message(3, 1, 1, 'short-key')$sql$));
select pg_temp.record('more than 40 source bindings', '23514', pg_temp.outcome(
  $sql$select pg_temp.insert_message(3, 1, 1, 'record-chat-key-000003',
       bindings => (select jsonb_agg(jsonb_build_object('kind','vital','id',n)) from generate_series(1,41) n))$sql$));
select pg_temp.record('an exchange for another patient''s conversation', '42501', pg_temp.outcome(
  $sql$select pg_temp.insert_message(3, 2, 1, 'record-chat-key-000004')$sql$));
select pg_temp.record('a conversation for another patient', '42501', pg_temp.outcome(
  $sql$insert into ehr.patient_chat_conversations(id,patient_id)
       values ('5c4a7700-0000-4000-8000-000000000009','5c4a7200-0000-4000-8000-000000000002')$sql$));
-- A stored exchange is never rewritten: there is no UPDATE privilege or policy.
select pg_temp.record('the runtime updates an exchange', '42501', pg_temp.outcome(
  $sql$update ehr.patient_chat_messages set question = 'changed'$sql$));
select pg_temp.record('the runtime updates a conversation', '42501', pg_temp.outcome(
  $sql$update ehr.patient_chat_conversations set created_at = created_at$sql$));
select pg_temp.record('the runtime truncates the history', '42501', pg_temp.outcome(
  $sql$truncate ehr.patient_chat_messages$sql$));

-- 2. Every other context sees and changes nothing of patient 1's history.
select pg_temp.bind_self(2);
select pg_temp.record('patient 2 sees patient 1''s history', '0,0', pg_temp.visible());
with deleted as (delete from ehr.patient_chat_messages returning 1) insert into chat_deleted select count(*) from deleted;
with deleted as (delete from ehr.patient_chat_conversations returning 1) insert into chat_deleted select count(*) from deleted;
select pg_temp.record('patient 2 deletes patient 1''s history', '0,0',
  (select string_agg(n::text, ',') from chat_deleted));
select pg_temp.bind_self(1, authorized_for => interval '-1 second');
select pg_temp.record('an expired self authorization', '0,0', pg_temp.visible());
select pg_temp.bind_self(1, authorized_for => interval '5 minutes');
select pg_temp.record('patient 1 bound again reads their history', '1,1', pg_temp.visible());
select pg_temp.bind_self(3);
select pg_temp.record('a revoked session', '0,0', pg_temp.visible());
select pg_temp.bind_self(1, account_no => 2);
select pg_temp.record('a mismatched account', '0,0', pg_temp.visible());
select pg_temp.bind_self(1, session_no => 2);
select pg_temp.record('another patient''s session', '0,0', pg_temp.visible());
select pg_temp.bind_staff();
select pg_temp.record('a staff direct-care context', '0,0', pg_temp.visible());
select pg_temp.record('a staff context stores an exchange', '42501', pg_temp.outcome(
  $sql$select pg_temp.insert_message(4, 1, 1, 'record-chat-key-000005')$sql$));
select set_config('app.patient_release','vitals,diagnoses,prescriptions,labResults,documents',true);
select set_config('app.purpose_of_use','patient-self',true);
select pg_temp.record('a staff context naming patient-self', '0,0', pg_temp.visible());

-- 3. Deleting the conversation deletes its exchanges; an exchange for a
--    deleted conversation is refused by the foreign key (the service answers
--    409 CHAT_CONVERSATION_CHANGED).
select pg_temp.bind_self(1);
select pg_temp.record('patient 1 deletes their history', 'ok', pg_temp.outcome(
  $sql$delete from ehr.patient_chat_conversations where patient_id = '5c4a7200-0000-4000-8000-000000000001'$sql$));
select pg_temp.record('the exchanges went with the conversation', '0,0', pg_temp.visible());
select pg_temp.record('an exchange for a deleted conversation', '23503', pg_temp.outcome(
  $sql$select pg_temp.insert_message(5, 1, 1, 'record-chat-key-000006')$sql$));
reset role;
select pg_temp.record('nothing of patient 1''s history remains', '0', (select count(*)::text
  from ehr.patient_chat_messages where patient_id = pg_temp.patient(1)));

-- 3a. A legal hold keeps the history: while an active hold names the patient
--     or the patient's account, the delete policies keep every row, and
--     ehr.record_chat_history_on_hold says so to the patient's own
--     transaction only (true, fail closed, for any other caller).
set local role hid_ehr_api_runtime;
select pg_temp.bind_self(2);
insert into ehr.patient_chat_conversations(id,patient_id) values (pg_temp.conversation(2), pg_temp.patient(2));
select pg_temp.insert_message(10, 2, 2, 'record-chat-key-000010');
select pg_temp.record('no hold on patient 2', 'false',
  pg_temp.held(2));
reset role;
insert into platform.legal_holds(id,subject_type,subject_id,reason)
values ('5c4a7b10-0000-4000-8000-000000000001','patient','5c4a7200-0000-4000-8000-000000000002',
  'Synthetic record chat hold on the patient');
insert into platform.legal_holds(id,subject_type,subject_id,reason,released_at,release_reason)
values ('5c4a7b10-0000-4000-8000-000000000003','patient','5c4a7200-0000-4000-8000-000000000001',
  'Synthetic released record chat hold',clock_timestamp(),'Synthetic hold released');
set local role hid_ehr_api_runtime;
select pg_temp.bind_self(2);
select pg_temp.record('a hold on patient 2', 'true',
  pg_temp.held(2));
delete from chat_deleted;
with deleted as (delete from ehr.patient_chat_messages returning 1) insert into chat_deleted select count(*) from deleted;
with deleted as (delete from ehr.patient_chat_conversations returning 1) insert into chat_deleted select count(*) from deleted;
select pg_temp.record('patient 2 deletes their history under a patient hold', '0,0',
  (select string_agg(n::text, ',') from chat_deleted));
select pg_temp.record('the held history remains', '1,1', pg_temp.visible());
select pg_temp.bind_self(1);
select pg_temp.record('a released hold does not hold', 'false',
  pg_temp.held(1));
select pg_temp.record('patient 1 asks about patient 2''s hold', 'true',
  pg_temp.held(2));
select pg_temp.bind_staff();
select pg_temp.record('a staff context asks about a hold', 'true',
  pg_temp.held(1));
reset role;
set local session_replication_role = replica;
delete from platform.legal_holds where id = '5c4a7b10-0000-4000-8000-000000000001';
set local session_replication_role = origin;
insert into platform.legal_holds(id,subject_type,subject_id,reason)
values ('5c4a7b10-0000-4000-8000-000000000002','account','5c4a7100-0000-4000-8000-000000000002',
  'Synthetic record chat hold on the account');
set local role hid_ehr_api_runtime;
select pg_temp.bind_self(2);
select pg_temp.record('a hold on patient 2''s account', 'true',
  pg_temp.held(2));
delete from chat_deleted;
with deleted as (delete from ehr.patient_chat_conversations returning 1) insert into chat_deleted select count(*) from deleted;
select pg_temp.record('patient 2 deletes their history under an account hold', '0|1,1',
  (select string_agg(n::text, ',') from chat_deleted) || '|' || pg_temp.visible());
reset role;
set local session_replication_role = replica;
delete from platform.legal_holds where id = '5c4a7b10-0000-4000-8000-000000000002';
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.bind_self(2);
select pg_temp.record('the hold released, patient 2 deletes their history', 'ok|0,0', pg_temp.outcome(
  $sql$delete from ehr.patient_chat_conversations where patient_id = '5c4a7200-0000-4000-8000-000000000002'$sql$)
  || '|' || pg_temp.visible());
reset role;

-- 4. The limits are reached through the commands only. A reservation reads
--    the kill switch again, in the transaction that commits the disclosure
--    audit row (55000 RECORD_CHAT_PAUSED while it is off); it is turned on
--    for this section and off again after it.
set local role hid_ehr_api_runtime;
select pg_temp.bind_self(1);
select pg_temp.record('a reservation while record chat is paused', '55000:RECORD_CHAT_PAUSED', pg_temp.attempt(
  $sql$select ehr.reserve_record_chat('patient', '5c4a7200-0000-4000-8000-000000000001', 1000, 1000000)$sql$));
reset role;
update platform.control_settings set enabled = true where control_key = 'record_chat_enabled';
set local role hid_ehr_api_runtime;
select pg_temp.bind_self(1);
select pg_temp.record('the runtime reads the usage counters', '42501', pg_temp.outcome(
  $sql$select count(*) from ehr.record_chat_usage_counters$sql$));
select pg_temp.record('the runtime reads the reservations', '42501', pg_temp.outcome(
  $sql$select count(*) from ehr.record_chat_reservations$sql$));
select pg_temp.record('the runtime reads the daily budget', '42501', pg_temp.outcome(
  $sql$select count(*) from ehr.record_chat_daily_budget$sql$));
select pg_temp.record('the runtime resets its counters', '42501', pg_temp.outcome(
  $sql$delete from ehr.record_chat_usage_counters$sql$));
select pg_temp.record('the staff audience is not built', '22023:RECORD_CHAT_AUDIENCE_INVALID', pg_temp.refusal(
  $sql$select ehr.reserve_record_chat('staff', '5c4a7200-0000-4000-8000-000000000001', 1000, 1000000)$sql$));
select pg_temp.record('a reservation for another patient', '42501:RECORD_CHAT_PERMISSION_DENIED', pg_temp.refusal(
  $sql$select ehr.reserve_record_chat('patient', '5c4a7200-0000-4000-8000-000000000002', 1000, 1000000)$sql$));
select pg_temp.record('a reservation of no tokens', '22023:RECORD_CHAT_RESERVATION_INVALID', pg_temp.refusal(
  $sql$select ehr.reserve_record_chat('patient', '5c4a7200-0000-4000-8000-000000000001', 0, 1000000)$sql$));
select pg_temp.bind_staff();
select pg_temp.record('a reservation from a staff context', '42501:RECORD_CHAT_PERMISSION_DENIED', pg_temp.refusal(
  $sql$select ehr.reserve_record_chat('patient', '5c4a7200-0000-4000-8000-000000000001', 1000, 1000000)$sql$));
select pg_temp.bind_self(3);
select pg_temp.record('a reservation on a revoked session', '42501:RECORD_CHAT_PERMISSION_DENIED', pg_temp.refusal(
  $sql$select ehr.reserve_record_chat('patient', '5c4a7200-0000-4000-8000-000000000003', 1000, 1000000)$sql$));

-- One in flight per account; settlement is idempotent and its owner's only.
select pg_temp.bind_self(1);
insert into chat_leases select 'first', ehr.reserve_record_chat('patient', pg_temp.patient(1), 5000, 1000000);
select pg_temp.record('a second request in flight', 'P4091:RECORD_CHAT_BUSY', pg_temp.refusal(
  $sql$select ehr.reserve_record_chat('patient', '5c4a7200-0000-4000-8000-000000000001', 5000, 1000000)$sql$));
select pg_temp.bind_self(2);
select pg_temp.record('another account is not busy', 'ok', pg_temp.outcome(
  $sql$insert into chat_leases select 'patient 2', ehr.reserve_record_chat('patient',
       '5c4a7200-0000-4000-8000-000000000002', 5000, 1000000)$sql$));
select pg_temp.record('patient 2 settles patient 1''s lease', '42501:RECORD_CHAT_PERMISSION_DENIED', pg_temp.refusal(
  $sql$select ehr.settle_record_chat((select id from chat_leases where name = 'first'), 10, 10, 0, 0, 'answered')$sql$));
select pg_temp.bind_self(1);
select pg_temp.record('an unknown outcome', '22023:RECORD_CHAT_SETTLEMENT_INVALID', pg_temp.refusal(
  $sql$select ehr.settle_record_chat((select id from chat_leases where name = 'first'), 10, 10, 0, 0, 'expired')$sql$));
-- No path settles a lease as authorization_changed: a lease whose
-- authorization ended during the call expires and is charged its estimate.
select pg_temp.record('the outcome no path writes', '22023:RECORD_CHAT_SETTLEMENT_INVALID', pg_temp.attempt(
  $sql$select ehr.settle_record_chat((select id from chat_leases where name = 'first'), 10, 10, 0, 0,
       'authorization_changed')$sql$));
select pg_temp.record('patient 1 settles their lease', 'true',
  (select ehr.settle_record_chat(id, 1200, 300, 0, 0, 'answered')::text from chat_leases where name = 'first'));
select pg_temp.record('settling again changes nothing', 'false',
  (select ehr.settle_record_chat(id, 1200, 300, 0, 0, 'answered')::text from chat_leases where name = 'first'));
reset role;
select pg_temp.record('the settled lease and the budget', 'answered,1200,300|5000,1500',
  (select outcome || ',' || input_tokens || ',' || output_tokens from ehr.record_chat_reservations
    where id = (select id from chat_leases where name = 'first'))
  || '|' || (select reserved_tokens || ',' || used_tokens from ehr.record_chat_daily_budget
    where day = (statement_timestamp() at time zone 'UTC')::date));

-- 10 an hour per account: the 11th is refused with the seconds until the
-- hour's bucket resets; every refusal rolls back its own increments.
set local role hid_ehr_api_runtime;
select pg_temp.bind_self(1);
do $$
declare
  lease uuid;
begin
  for attempt in 2..10 loop
    lease := ehr.reserve_record_chat('patient', '5c4a7200-0000-4000-8000-000000000001', 1000, 1000000);
    perform ehr.settle_record_chat(lease, 0, 0, 0, 0, 'failed');
  end loop;
end
$$;
select pg_temp.record('the 11th request in the hour', 'P4290:RECORD_CHAT_RATE_LIMITED', pg_temp.refusal(
  $sql$select ehr.reserve_record_chat('patient', '5c4a7200-0000-4000-8000-000000000001', 1000, 1000000)$sql$));
select pg_temp.record('the refusal names the seconds until the hour resets', 'seconds', pg_temp.retry_after());
reset role;
select pg_temp.record('the refusals counted nothing', '10,10',
  (select string_agg(request_count::text, ',' order by bucket_period) from ehr.record_chat_usage_counters
    where account_id = '5c4a7100-0000-4000-8000-000000000001'));

-- 30 a day per account: a day bucket at the limit refuses before the hour's.
set local session_replication_role = replica;
update ehr.record_chat_usage_counters set request_count = 30
 where account_id = '5c4a7100-0000-4000-8000-000000000002' and bucket_period = 'day';
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.bind_self(2);
select ehr.settle_record_chat(id, 0, 0, 0, 0, 'failed') from chat_leases where name = 'patient 2';
select pg_temp.record('the 31st request in the day', 'P4290:RECORD_CHAT_RATE_LIMITED', pg_temp.refusal(
  $sql$select ehr.reserve_record_chat('patient', '5c4a7200-0000-4000-8000-000000000002', 1000, 1000000)$sql$));
reset role;

-- The daily budget: reserved plus used plus requested may not pass the
-- configured budget or the hard ceiling of 20,000,000.
set local session_replication_role = replica;
delete from ehr.record_chat_usage_counters where account_id = '5c4a7100-0000-4000-8000-000000000002';
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.bind_self(2);
select pg_temp.record('a request over the configured budget', 'P5030:RECORD_CHAT_BUDGET_EXHAUSTED', pg_temp.refusal(
  $sql$select ehr.reserve_record_chat('patient', '5c4a7200-0000-4000-8000-000000000002', 5000, 6000)$sql$));
reset role;
set local session_replication_role = replica;
update ehr.record_chat_daily_budget set used_tokens = 19999000
 where day = (statement_timestamp() at time zone 'UTC')::date;
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.bind_self(2);
select pg_temp.record('the hard ceiling', 'P5030:RECORD_CHAT_BUDGET_EXHAUSTED', pg_temp.refusal(
  $sql$select ehr.reserve_record_chat('patient', '5c4a7200-0000-4000-8000-000000000002', 5000, 100000000)$sql$));
reset role;
set local session_replication_role = replica;
update ehr.record_chat_daily_budget set used_tokens = 0
 where day = (statement_timestamp() at time zone 'UTC')::date;
set local session_replication_role = origin;

-- An expired lease is free: the next reservation settles it as expired and
-- counts its reserved tokens as used.
set local session_replication_role = replica;
insert into ehr.record_chat_reservations(id,audience,account_id,patient_id,reserved_tokens,created_at,expires_at)
values ('5c4a7a00-0000-4000-8000-000000000001','patient','5c4a7100-0000-4000-8000-000000000002',
  '5c4a7200-0000-4000-8000-000000000002',7000,statement_timestamp()-interval '61 seconds',
  statement_timestamp()-interval '1 second');
update ehr.record_chat_daily_budget set reserved_tokens = reserved_tokens + 7000
 where day = (statement_timestamp() at time zone 'UTC')::date;
set local session_replication_role = origin;
insert into chat_budget_before select reserved_tokens, used_tokens from ehr.record_chat_daily_budget
 where day = (statement_timestamp() at time zone 'UTC')::date;
set local role hid_ehr_api_runtime;
select pg_temp.bind_self(2);
select pg_temp.record('a request after a stale lease', 'ok', pg_temp.outcome(
  $sql$insert into chat_leases select 'after stale', ehr.reserve_record_chat('patient',
       '5c4a7200-0000-4000-8000-000000000002', 1000, 1000000)$sql$));
reset role;
select pg_temp.record('the stale lease is settled as expired and its tokens used', 'expired|-6000,7000',
  (select outcome from ehr.record_chat_reservations where id = '5c4a7a00-0000-4000-8000-000000000001')
  || '|' || (select (budget.reserved_tokens - before.reserved) || ',' || (budget.used_tokens - before.used)
    from ehr.record_chat_daily_budget budget, chat_budget_before before
    where budget.day = (statement_timestamp() at time zone 'UTC')::date));
-- Settling the lease again, as a late settlement for it would, changes nothing.
delete from chat_budget_before;
insert into chat_budget_before select reserved_tokens, used_tokens from ehr.record_chat_daily_budget
 where day = (statement_timestamp() at time zone 'UTC')::date;
set local role hid_ehr_api_runtime;
select pg_temp.bind_self(2);
select pg_temp.record('a late settlement of the expired lease', 'false',
  ehr.settle_record_chat('5c4a7a00-0000-4000-8000-000000000001', 100, 0, 0, 0, 'failed')::text);
reset role;
select pg_temp.record('the late settlement left the budget alone', '0,0',
  (select (budget.reserved_tokens - before.reserved) || ',' || (budget.used_tokens - before.used)
     from ehr.record_chat_daily_budget budget,
          chat_budget_before before
    where budget.day = (statement_timestamp() at time zone 'UTC')::date));
-- An unsettled lease of an account that never came back is pruned after two
-- days with the settled ones (its day's budget is long past).
set local session_replication_role = replica;
insert into ehr.record_chat_reservations(id,audience,account_id,patient_id,reserved_tokens,created_at,expires_at)
values ('5c4a7a00-0000-4000-8000-000000000003','patient','5c4a7100-0000-4000-8000-000000000003',
  '5c4a7200-0000-4000-8000-000000000003',500,statement_timestamp()-interval '3 days',
  statement_timestamp()-interval '3 days'+interval '60 seconds');
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.bind_self(2);
select ehr.settle_record_chat(id, 0, 0, 0, 0, 'failed') from chat_leases where name = 'after stale';
select pg_temp.record('another reservation prunes the abandoned lease', 'ok', pg_temp.outcome(
  $sql$insert into chat_leases select 'prune', ehr.reserve_record_chat('patient',
       '5c4a7200-0000-4000-8000-000000000002', 1000, 1000000)$sql$));
reset role;
select pg_temp.record('the abandoned lease is gone', '0', (select count(*)::text from ehr.record_chat_reservations
  where id = '5c4a7a00-0000-4000-8000-000000000003'));
select pg_temp.record('the reservations admit no authorization_changed outcome', '23514', pg_temp.outcome(
  $sql$insert into ehr.record_chat_reservations(audience,account_id,patient_id,reserved_tokens,created_at,expires_at,
         settled_at,outcome)
       values ('patient','5c4a7100-0000-4000-8000-000000000003','5c4a7200-0000-4000-8000-000000000003',1,
         statement_timestamp(),statement_timestamp()+interval '60 seconds',statement_timestamp(),
         'authorization_changed')$sql$));
update platform.control_settings set enabled = false where control_key = 'record_chat_enabled';
select pg_temp.record('a lease lasts at most 60 seconds', '23514', pg_temp.outcome(
  $sql$insert into ehr.record_chat_reservations(audience,account_id,patient_id,reserved_tokens,created_at,expires_at)
       values ('patient','5c4a7100-0000-4000-8000-000000000003','5c4a7200-0000-4000-8000-000000000003',1,
         statement_timestamp(),statement_timestamp()+interval '61 seconds')$sql$));
select pg_temp.record('the reservations hold ids, counts and token numbers only',
  'account_id,audience,cache_read_tokens,cache_write_tokens,created_at,expires_at,id,input_tokens,outcome,'
  || 'output_tokens,patient_id,reserved_tokens,settled_at',
  (select string_agg(attname, ',' order by attname) from pg_attribute
    where attrelid = 'ehr.record_chat_reservations'::regclass and attnum > 0 and not attisdropped));

-- 5. The catalogue: the commands, the policies, forced row-level security.
select pg_temp.record('the commands are owned by the schema owner, security definer, with a pinned search path',
  'ehr.record_chat_history_on_hold(uuid):true:{"search_path=pg_catalog, pg_temp"}:true;'
  || 'ehr.reserve_record_chat(text,uuid,integer,bigint):true:{"search_path=pg_catalog, pg_temp"}:true;'
  || 'ehr.settle_record_chat(uuid,integer,integer,integer,integer,text):true:{"search_path=pg_catalog, pg_temp"}:true',
  (select string_agg(proc.oid::regprocedure::text || ':' || proc.prosecdef || ':' || proc.proconfig::text || ':'
      || (proc.proowner = (select relowner from pg_class where oid = 'ehr.patient_chat_messages'::regclass)),
      ';' order by proc.oid::regprocedure::text)
     from pg_proc proc where proc.oid in ('ehr.reserve_record_chat(text,uuid,integer,bigint)'::regprocedure,
       'ehr.settle_record_chat(uuid,integer,integer,integer,integer,text)'::regprocedure,
       to_regprocedure('ehr.record_chat_history_on_hold(uuid)'))));
select pg_temp.record('PUBLIC executes no command', 'false,false,false',
  has_function_privilege('public', 'ehr.reserve_record_chat(text,uuid,integer,bigint)', 'EXECUTE') || ','
  || has_function_privilege('public', 'ehr.settle_record_chat(uuid,integer,integer,integer,integer,text)', 'EXECUTE')
  || ',' || coalesce(has_function_privilege('public', to_regprocedure('ehr.record_chat_history_on_hold(uuid)'),
    'EXECUTE')::text, 'missing'));
select pg_temp.record('the hold check is stable', 's', (select provolatile::text from pg_proc
  where oid = to_regprocedure('ehr.record_chat_history_on_hold(uuid)')));
select pg_temp.record('the chat tables force row-level security',
  'patient_chat_conversations,patient_chat_messages,record_chat_daily_budget,record_chat_reservations,'
  || 'record_chat_usage_counters',
  (select string_agg(relname, ',' order by relname) from pg_class
    where relnamespace = 'ehr'::regnamespace and relrowsecurity and relforcerowsecurity
      and relname in ('patient_chat_conversations','patient_chat_messages','record_chat_usage_counters',
        'record_chat_reservations','record_chat_daily_budget')));
select pg_temp.record('the history policies: patient-self select, insert and delete without a hold, no update',
  'patient_chat_conversations_self_delete:d:(ehr.patient_self_context(patient_id) AND (NOT '
  || 'ehr.record_chat_history_on_hold(patient_id))):;'
  || 'patient_chat_conversations_self_insert:a::ehr.patient_self_context(patient_id);'
  || 'patient_chat_conversations_self_read:r:ehr.patient_self_context(patient_id):;'
  || 'patient_chat_messages_self_delete:d:(ehr.patient_self_context(patient_id) AND (NOT '
  || 'ehr.record_chat_history_on_hold(patient_id))):;'
  || 'patient_chat_messages_self_insert:a::ehr.patient_self_context(patient_id);'
  || 'patient_chat_messages_self_read:r:ehr.patient_self_context(patient_id):',
  (select string_agg(policy.polname || ':' || policy.polcmd::text || ':'
      || coalesce(pg_get_expr(policy.polqual, policy.polrelid), '') || ':'
      || coalesce(pg_get_expr(policy.polwithcheck, policy.polrelid), ''), ';' order by policy.polname)
     from pg_policy policy
    where policy.polrelid in ('ehr.patient_chat_conversations'::regclass, 'ehr.patient_chat_messages'::regclass)
      and policy.polpermissive));
select pg_temp.record('no other policy on the history', '6',
  (select count(*)::text from pg_policy
    where polrelid in ('ehr.patient_chat_conversations'::regclass, 'ehr.patient_chat_messages'::regclass)));

-- 6. The kill switch, and nothing beyond this migration's scope.
set local role hid_ehr_api_runtime;
select pg_temp.record('record_chat_enabled exists and is off', 'false',
  platform.control_enabled('record_chat_enabled')::text);
select pg_temp.record('an unknown control is still invalid', '22023', pg_temp.outcome(
  $sql$select platform.control_enabled('not_a_control')$sql$));
reset role;
select pg_temp.record('the control row', 'false|1|true',
  (select enabled || '|' || row_version || '|' || (updated_by is null) from platform.control_settings
    where control_key = 'record_chat_enabled'));
select pg_temp.record('the control keys', 'break_glass_enabled,maintenance_mode,outreach_portal_enabled,'
  || 'patient_portal_enabled,provider_portal_enabled,record_chat_enabled,uploads_enabled',
  (select string_agg(key_match[1], ',' order by key_match[1])
     from pg_constraint constraint_row,
          regexp_matches(pg_get_constraintdef(constraint_row.oid), '''([a-z_]+)''', 'g') key_match
    where constraint_row.conrelid = 'platform.control_settings'::regclass
      and constraint_row.conname = 'control_settings_control_key_check'));
select pg_temp.record('the control command admits the new key', 'record_chat_enabled', (select substring(prosrc
  from 'record_chat_enabled') from pg_proc where oid = 'platform.admin_set_control(text,boolean,bigint,text)'::regprocedure));
select pg_temp.record('no record chat retention class or purge command', '0,0,0',
  (select count(*)::text from platform.record_class_retention_policies where record_class like '%chat%')
  || ',' || (select count(*)::text from pg_proc where proname like '%prune_record_chat%')
  || ',' || (select count(*)::text from pg_attribute where attrelid = 'ehr.patient_chat_messages'::regclass
    and attname = 'expires_at'));
select pg_temp.record('no record chat permission is seeded', '0',
  (select count(*)::text from auth.permissions where code like 'ehr.record-chat%'));
reset role;

do $$
declare
  failures text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by name)
    into failures from chat_case_results where expected is distinct from actual;
  if failures is not null then
    raise exception E'patient record chat cases differ from the record chat rules:\n%', failures;
  end if;
  if date_trunc('hour', clock_timestamp(), 'UTC')::text <> current_setting('hid.record_chat_suite_hour') then
    raise exception 'the patient record chat suite crossed a UTC hour boundary (its hourly and daily cases bucket by '
      'the hour); run it again';
  end if;
  if (select count(*) from chat_case_results) < 55 then
    raise exception 'patient record chat suite recorded only % cases', (select count(*) from chat_case_results);
  end if;
end $$;
rollback;
