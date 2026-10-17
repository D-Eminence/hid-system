\set ON_ERROR_STOP on
\o /dev/null
-- Staff record chat (ADR-069). Rollback-only.
--
-- A staff member's history of questions about one patient
-- (ehr.staff_record_chat_conversations and ehr.staff_record_chat_messages) is
-- read, written and deleted only by that staff account, at the selected
-- facility, in a direct-care transaction with a standard consent for the
-- patient and a membership that holds ehr.record-chat.use
-- (ehr.staff_record_chat_context). Another staff member, another facility, a
-- membership without the permission, a revoked consent, a break-glass grant
-- (purpose emergency), a patient-self context and the patient see and change
-- nothing. A stored exchange is never rewritten. A legal hold on the patient
-- or the staff account keeps the history. The abuse and cost limits are the
-- patient chat's commands with the audience 'staff': the caller is proved by
-- the same staff context, the lease and the counters belong to the staff
-- account, and the proposed defaults are 20 an hour and 100 a day. The
-- patient audience is covered by patient-record-chat.integration.sql.
--
-- Fixtures are synthetic (ids 5c4b...), inserted as the suite runner with
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
select set_config('hid.staff_chat_suite_hour', date_trunc('hour', clock_timestamp(), 'UTC')::text, false);
begin;
set constraints all deferred;

create temporary table staff_case_results(name text primary key, expected text not null, actual text not null)
  on commit drop;
create temporary table staff_deleted(n bigint) on commit drop;
create temporary table staff_leases(name text primary key, id uuid) on commit drop;
grant all on staff_case_results, staff_deleted, staff_leases to public;

-- Accounts 1 and 2 are patients A and B; 3 is doctor 1 (facilities A and B),
-- 4 doctor 2 (facility A), 5 a receptionist (facility A), 6 a nurse (facility A).
insert into auth.accounts(id,subject,email,display_name,status)
select ('5c4b0100-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  'synthetic:staff-chat:'||n,'staff-chat-'||n||'@example.invalid','Synthetic staff chat '||n,'active'
from generate_series(1,6) n;
insert into identity.patients(id,account_id,hid_code,first_name,last_name,full_name,status)
select ('5c4b0200-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('5c4b0100-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  'HID-STAFQ'||chr(64+n),'Staff','Patient '||n,'Staff Patient '||n,'active'
from generate_series(1,2) n;
insert into auth.sessions(id,account_id,family_id,refresh_token_sha256,access_jti,account_token_version,
  authentication_method,issued_at,expires_at,absolute_expires_at,session_kind,patient_id)
select ('5c4b0300-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('5c4b0100-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('5c4b0300-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  md5('staff-chat'||n)||md5('staff-chat'||n),gen_random_uuid(),1,'password',clock_timestamp(),
  clock_timestamp()+interval '1 hour',clock_timestamp()+interval '2 hours','patient',
  ('5c4b0200-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
from generate_series(1,2) n;
insert into identity.organizations(id,name,slug)
values('5c4b0400-0000-4000-8000-000000000001','Staff chat test organization','staff-chat-test-organization');
insert into identity.facilities(id,organization_id,name,code,timezone,active,lifecycle_status)
values('5c4b0400-0000-4000-8000-000000000002','5c4b0400-0000-4000-8000-000000000001','Staff chat facility A',
  'SCH-A','Africa/Lagos',true,'verified'),
  ('5c4b0400-0000-4000-8000-000000000003','5c4b0400-0000-4000-8000-000000000001','Staff chat facility B',
  'SCH-B','Africa/Lagos',true,'verified');
insert into identity.staff(id,account_id,full_name,email,verification_status,default_role)
select ('5c4b0500-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('5c4b0100-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Synthetic staff chat member '||n,
  'member-staff-chat-'||n||'@example.invalid','verified',
  case n when 5 then 'receptionist' when 6 then 'nurse' else 'doctor' end
from generate_series(3,6) n;
-- Memberships: 1 doctor 1 at A, 2 doctor 1 at B, 3 doctor 2 at A, 4 the
-- receptionist at A, 5 the nurse at A.
insert into identity.staff_facility_memberships(id,staff_id,account_id,organization_id,facility_id,membership_role,
  app_role,is_primary,active)
values
  ('5c4b0600-0000-4000-8000-000000000001','5c4b0500-0000-4000-8000-000000000003','5c4b0100-0000-4000-8000-000000000003',
   '5c4b0400-0000-4000-8000-000000000001','5c4b0400-0000-4000-8000-000000000002','doctor','doctor',true,true),
  ('5c4b0600-0000-4000-8000-000000000002','5c4b0500-0000-4000-8000-000000000003','5c4b0100-0000-4000-8000-000000000003',
   '5c4b0400-0000-4000-8000-000000000001','5c4b0400-0000-4000-8000-000000000003','doctor','doctor',false,true),
  ('5c4b0600-0000-4000-8000-000000000003','5c4b0500-0000-4000-8000-000000000004','5c4b0100-0000-4000-8000-000000000004',
   '5c4b0400-0000-4000-8000-000000000001','5c4b0400-0000-4000-8000-000000000002','doctor','doctor',true,true),
  ('5c4b0600-0000-4000-8000-000000000004','5c4b0500-0000-4000-8000-000000000005','5c4b0100-0000-4000-8000-000000000005',
   '5c4b0400-0000-4000-8000-000000000001','5c4b0400-0000-4000-8000-000000000002','receptionist','receptionist',true,true),
  ('5c4b0600-0000-4000-8000-000000000005','5c4b0500-0000-4000-8000-000000000006','5c4b0100-0000-4000-8000-000000000006',
   '5c4b0400-0000-4000-8000-000000000001','5c4b0400-0000-4000-8000-000000000002','nurse','nurse',true,true);
insert into auth.account_roles(id,account_id,role_code,scope_type,membership_id,facility_id,grant_reason)
values
  ('5c4b0610-0000-4000-8000-000000000001','5c4b0100-0000-4000-8000-000000000003','doctor','facility',
   '5c4b0600-0000-4000-8000-000000000001','5c4b0400-0000-4000-8000-000000000002','Synthetic staff chat role'),
  ('5c4b0610-0000-4000-8000-000000000002','5c4b0100-0000-4000-8000-000000000003','doctor','facility',
   '5c4b0600-0000-4000-8000-000000000002','5c4b0400-0000-4000-8000-000000000003','Synthetic staff chat role'),
  ('5c4b0610-0000-4000-8000-000000000003','5c4b0100-0000-4000-8000-000000000004','doctor','facility',
   '5c4b0600-0000-4000-8000-000000000003','5c4b0400-0000-4000-8000-000000000002','Synthetic staff chat role'),
  ('5c4b0610-0000-4000-8000-000000000004','5c4b0100-0000-4000-8000-000000000005','receptionist','facility',
   '5c4b0600-0000-4000-8000-000000000004','5c4b0400-0000-4000-8000-000000000002','Synthetic staff chat role'),
  ('5c4b0610-0000-4000-8000-000000000005','5c4b0100-0000-4000-8000-000000000006','nurse','facility',
   '5c4b0600-0000-4000-8000-000000000005','5c4b0400-0000-4000-8000-000000000002','Synthetic staff chat role');

set local session_replication_role = replica;
-- Standard direct-care read consents at facility A: doctor 1 (membership 1)
-- for patients A and B, doctor 2 (membership 3) for patient A, the
-- receptionist (4) and the nurse (5) for patient A. None at facility B.
-- Doctor 2 also has a break-glass grant for patient B (purpose emergency).
insert into identity.consent_grants(id,patient_id,staff_id,account_id,membership_id,facility_id,scope,purpose_of_use,
  status,reason,starts_at,expires_at)
values
  ('5c4b0700-0000-4000-8000-000000000001','5c4b0200-0000-4000-8000-000000000001','5c4b0500-0000-4000-8000-000000000003',
   '5c4b0100-0000-4000-8000-000000000003','5c4b0600-0000-4000-8000-000000000001','5c4b0400-0000-4000-8000-000000000002',
   'read_records','direct-care','active','Synthetic staff chat consent 1',clock_timestamp()-interval '1 hour',
   clock_timestamp()+interval '30 days'),
  ('5c4b0700-0000-4000-8000-000000000002','5c4b0200-0000-4000-8000-000000000002','5c4b0500-0000-4000-8000-000000000003',
   '5c4b0100-0000-4000-8000-000000000003','5c4b0600-0000-4000-8000-000000000001','5c4b0400-0000-4000-8000-000000000002',
   'read_records','direct-care','active','Synthetic staff chat consent 2',clock_timestamp()-interval '1 hour',
   clock_timestamp()+interval '30 days'),
  ('5c4b0700-0000-4000-8000-000000000003','5c4b0200-0000-4000-8000-000000000001','5c4b0500-0000-4000-8000-000000000004',
   '5c4b0100-0000-4000-8000-000000000004','5c4b0600-0000-4000-8000-000000000003','5c4b0400-0000-4000-8000-000000000002',
   'read_records','direct-care','active','Synthetic staff chat consent 3',clock_timestamp()-interval '1 hour',
   clock_timestamp()+interval '30 days'),
  ('5c4b0700-0000-4000-8000-000000000004','5c4b0200-0000-4000-8000-000000000001','5c4b0500-0000-4000-8000-000000000005',
   '5c4b0100-0000-4000-8000-000000000005','5c4b0600-0000-4000-8000-000000000004','5c4b0400-0000-4000-8000-000000000002',
   'read_records','direct-care','active','Synthetic staff chat consent 4',clock_timestamp()-interval '1 hour',
   clock_timestamp()+interval '30 days'),
  ('5c4b0700-0000-4000-8000-000000000005','5c4b0200-0000-4000-8000-000000000001','5c4b0500-0000-4000-8000-000000000006',
   '5c4b0100-0000-4000-8000-000000000006','5c4b0600-0000-4000-8000-000000000005','5c4b0400-0000-4000-8000-000000000002',
   'read_records','direct-care','active','Synthetic staff chat consent 5',clock_timestamp()-interval '1 hour',
   clock_timestamp()+interval '30 days');
insert into identity.consent_grants(id,patient_id,staff_id,account_id,membership_id,facility_id,scope,purpose_of_use,
  status,reason,starts_at,expires_at,break_glass)
values('5c4b0700-0000-4000-8000-000000000009','5c4b0200-0000-4000-8000-000000000002',
  '5c4b0500-0000-4000-8000-000000000004','5c4b0100-0000-4000-8000-000000000004','5c4b0600-0000-4000-8000-000000000003',
  '5c4b0400-0000-4000-8000-000000000002','break_glass','emergency','active','Synthetic emergency access reason',
  clock_timestamp()-interval '5 minutes',clock_timestamp()+interval '55 minutes',true);
set local session_replication_role = origin;

-- A staff member's direct-care context, as DatabaseService.withTransaction sets it.
create function pg_temp.bind_staff(account_no integer, membership_no integer, facility_no integer default 2,
  purpose text default 'direct-care') returns void
language sql as $$
  select set_config('app.actor_subject','synthetic:staff-chat:'||account_no,true),
    set_config('app.facility_id','5c4b0400-0000-4000-8000-'||lpad(facility_no::text,12,'0'),true),
    set_config('app.membership_id','5c4b0600-0000-4000-8000-'||lpad(membership_no::text,12,'0'),true),
    set_config('app.correlation_id','staff-record-chat-integration-0001',true),
    set_config('app.purpose_of_use',purpose,true),
    set_config('app.account_id','',true), set_config('app.session_id','',true), set_config('app.patient_id','',true),
    set_config('app.self_authorized_until','',true), set_config('app.patient_release','',true);
$$;
-- The patient-self binding, as DatabaseService.withPatientTransaction sets it.
create function pg_temp.bind_self(patient_no integer) returns void
language sql as $$
  select set_config('app.actor_subject','synthetic:staff-chat:'||patient_no,true),
    set_config('app.account_id','5c4b0100-0000-4000-8000-'||lpad(patient_no::text,12,'0'),true),
    set_config('app.session_id','5c4b0300-0000-4000-8000-'||lpad(patient_no::text,12,'0'),true),
    set_config('app.patient_id','5c4b0200-0000-4000-8000-'||lpad(patient_no::text,12,'0'),true),
    set_config('app.correlation_id','staff-record-chat-integration-self',true),
    set_config('app.self_authorized_until',(clock_timestamp()+interval '30 seconds')::text,true),
    set_config('app.purpose_of_use','patient-self',true), set_config('app.facility_id','',true),
    set_config('app.membership_id','',true), set_config('app.patient_release','',true);
$$;
create function pg_temp.patient(n integer) returns uuid
language sql immutable as $$ select ('5c4b0200-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
create function pg_temp.conversation(n integer) returns uuid
language sql immutable as $$ select ('5c4b0800-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
create function pg_temp.message(n integer) returns uuid
language sql immutable as $$ select ('5c4b0900-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
create function pg_temp.reply(answer text default 'The last recorded blood pressure was normal.') returns jsonb
language sql immutable as $$
  select jsonb_build_object('status','answered','answer',answer,
    'blocks',jsonb_build_array(jsonb_build_object('kind','record','text',answer,'references',jsonb_build_array(1))),
    'sources',jsonb_build_array(jsonb_build_object('number',1,'kind','vital','id','5c4b0a00-0000-4000-8000-000000000001',
      'recordedOn','2026-10-01','effectiveOn',null,'title','Vital signs')))
$$;
-- A conversation of the staff member (account, membership, facility) about the patient.
create function pg_temp.insert_conversation(conversation_no integer, patient_no integer, account_no integer,
  membership_no integer, facility_no integer default 2) returns void
language sql as $$
  insert into ehr.staff_record_chat_conversations(id,patient_id,facility_id,account_id,membership_id)
  values (pg_temp.conversation(conversation_no), pg_temp.patient(patient_no),
    ('5c4b0400-0000-4000-8000-'||lpad(facility_no::text,12,'0'))::uuid,
    ('5c4b0100-0000-4000-8000-'||lpad(account_no::text,12,'0'))::uuid,
    ('5c4b0600-0000-4000-8000-'||lpad(membership_no::text,12,'0'))::uuid)
$$;
create function pg_temp.insert_message(message_no integer, conversation_no integer, patient_no integer,
  account_no integer, membership_no integer, key text, facility_no integer default 2,
  question text default 'What was the last blood pressure?', reply jsonb default pg_temp.reply(),
  bindings jsonb default '[{"kind":"vital","id":"5c4b0a00-0000-4000-8000-000000000001","hash":"0"}]') returns void
language sql as $$
  insert into ehr.staff_record_chat_messages(id,conversation_id,patient_id,facility_id,account_id,membership_id,
    idempotency_key,request_sha256,question,reply,source_bindings)
  values (pg_temp.message(message_no), pg_temp.conversation(conversation_no), pg_temp.patient(patient_no),
    ('5c4b0400-0000-4000-8000-'||lpad(facility_no::text,12,'0'))::uuid,
    ('5c4b0100-0000-4000-8000-'||lpad(account_no::text,12,'0'))::uuid,
    ('5c4b0600-0000-4000-8000-'||lpad(membership_no::text,12,'0'))::uuid,
    key, repeat('a',64), question, reply, bindings)
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
    raise exception using errcode = 'P0001', message = 'staff record chat attempt succeeded';
  exception when others then
    if sqlerrm = 'staff record chat attempt succeeded' then return 'ok'; end if;
    return sqlstate || ':' || sqlerrm;
  end;
end
$$;
create function pg_temp.context(patient_no integer) returns text
language sql as $$ select ehr.staff_record_chat_context(pg_temp.patient(patient_no))::text $$;
create function pg_temp.held(patient_no integer) returns text
language plpgsql as $$
declare
  answer boolean;
begin
  execute 'select ehr.staff_record_chat_history_on_hold($1)' into answer using pg_temp.patient(patient_no);
  return answer::text;
exception when others then
  return sqlstate;
end
$$;
create function pg_temp.visible() returns text
language sql as $$
  select (select count(*) from ehr.staff_record_chat_conversations)::text || ','
    || (select count(*) from ehr.staff_record_chat_messages)::text
$$;
create function pg_temp.record(name text, expected text, actual text) returns void
language sql as $$
  insert into staff_case_results values (name, expected, coalesce(actual, '<none>'));
$$;

-- 0. The permission: held by doctor, clinician and nurse, not by the
--    receptionist; the staff audience is one permission and no more.
select pg_temp.record('the permission exists and is active', 'true',
  (select active::text from auth.permissions where code = 'ehr.record-chat.use'));
select pg_temp.record('the roles that hold the permission', 'clinician,doctor,nurse',
  (select string_agg(role_code, ',' order by role_code) from auth.role_permissions
    where permission_code = 'ehr.record-chat.use'));

-- 1. The staff proof.
set local role hid_ehr_api_runtime;
select pg_temp.bind_staff(3, 1);
select pg_temp.record('doctor 1 for patient A at facility A', 'true', pg_temp.context(1));
select pg_temp.record('doctor 1 for patient B at facility A', 'true', pg_temp.context(2));
select pg_temp.bind_staff(3, 2, 3);
select pg_temp.record('doctor 1 at facility B, which holds no consent', 'false', pg_temp.context(1));
select pg_temp.bind_staff(4, 3);
select pg_temp.record('doctor 2 for patient A', 'true', pg_temp.context(1));
select pg_temp.record('doctor 2 for patient B, which holds no standard consent', 'false', pg_temp.context(2));
select pg_temp.bind_staff(4, 3, 2, 'emergency');
select pg_temp.record('doctor 2 for patient B under a break-glass grant', 'false', pg_temp.context(2));
select pg_temp.record('break-glass passes the consent check itself', 'true',
  ehr.context_allows(pg_temp.patient(2), '5c4b0400-0000-4000-8000-000000000002', 'read_records')::text);
select pg_temp.bind_staff(4, 3, 2, 'treatment');
select pg_temp.record('another purpose', 'false', pg_temp.context(1));
select pg_temp.bind_staff(5, 4);
select pg_temp.record('the receptionist, with consent and no permission', 'false', pg_temp.context(1));
select pg_temp.bind_staff(6, 5);
select pg_temp.record('the nurse, who holds the permission', 'true', pg_temp.context(1));
select pg_temp.bind_staff(3, 1);
select pg_temp.record('no patient', 'false', ehr.staff_record_chat_context(null)::text);
select pg_temp.bind_self(1);
select pg_temp.record('a patient-self context', 'false', pg_temp.context(1));
select set_config('app.actor_subject','',true);
select pg_temp.record('no actor', 'false', pg_temp.context(1));
reset role;

-- 2. Doctor 1 writes and reads their own history of patient A.
set local role hid_ehr_api_runtime;
select pg_temp.bind_staff(3, 1);
select pg_temp.record('doctor 1 starts a conversation', 'ok', pg_temp.outcome(
  $sql$select pg_temp.insert_conversation(1, 1, 3, 1)$sql$));
select pg_temp.record('doctor 1 stores an exchange', 'ok', pg_temp.outcome(
  $sql$select pg_temp.insert_message(1, 1, 1, 3, 1, 'staff-chat-key-0000001')$sql$));
select pg_temp.record('doctor 1 reads their history', '1,1', pg_temp.visible());
select pg_temp.record('the same idempotency key in the conversation', '23505', pg_temp.outcome(
  $sql$select pg_temp.insert_message(2, 1, 1, 3, 1, 'staff-chat-key-0000001')$sql$));
select pg_temp.record('a second conversation of the same scope', '23505', pg_temp.outcome(
  $sql$select pg_temp.insert_conversation(2, 1, 3, 1)$sql$));
select pg_temp.record('a reply with an unknown status', '23514', pg_temp.outcome(
  $sql$select pg_temp.insert_message(3, 1, 1, 3, 1, 'staff-chat-key-0000003',
       reply => pg_temp.reply() || '{"status":"free_text"}')$sql$));
select pg_temp.record('a reply answer over 4000 characters', '23514', pg_temp.outcome(
  $sql$select pg_temp.insert_message(3, 1, 1, 3, 1, 'staff-chat-key-0000003', reply => pg_temp.reply(repeat('x',4001)))$sql$));
select pg_temp.record('a question over 1000 characters', '23514', pg_temp.outcome(
  $sql$select pg_temp.insert_message(3, 1, 1, 3, 1, 'staff-chat-key-0000003', question => repeat('q',1001))$sql$));
select pg_temp.record('a short idempotency key', '23514', pg_temp.outcome(
  $sql$select pg_temp.insert_message(3, 1, 1, 3, 1, 'short-key')$sql$));
select pg_temp.record('more than 40 source bindings', '23514', pg_temp.outcome(
  $sql$select pg_temp.insert_message(3, 1, 1, 3, 1, 'staff-chat-key-0000003',
       bindings => (select jsonb_agg(jsonb_build_object('kind','vital','id',n)) from generate_series(1,41) n))$sql$));
select pg_temp.record('an exchange naming doctor 2 as its author', '42501', pg_temp.outcome(
  $sql$select pg_temp.insert_message(3, 1, 1, 4, 3, 'staff-chat-key-0000004')$sql$));
select pg_temp.record('an exchange for a patient doctor 1 has no consent for here', '23503', pg_temp.outcome(
  $sql$select pg_temp.insert_message(3, 1, 2, 3, 1, 'staff-chat-key-0000005')$sql$));
select pg_temp.record('a conversation naming another account', '42501', pg_temp.outcome(
  $sql$select pg_temp.insert_conversation(9, 1, 4, 3)$sql$));
select pg_temp.record('a conversation naming the membership of another facility', '42501', pg_temp.outcome(
  $sql$select pg_temp.insert_conversation(9, 1, 3, 2)$sql$));
select pg_temp.record('the runtime updates an exchange', '42501', pg_temp.outcome(
  $sql$update ehr.staff_record_chat_messages set question = 'changed'$sql$));
select pg_temp.record('the runtime updates a conversation', '42501', pg_temp.outcome(
  $sql$update ehr.staff_record_chat_conversations set created_at = created_at$sql$));
select pg_temp.record('the runtime truncates the history', '42501', pg_temp.outcome(
  $sql$truncate ehr.staff_record_chat_messages$sql$));
reset role;

-- 3. Nobody else sees or changes it.
set local role hid_ehr_api_runtime;
select pg_temp.bind_staff(4, 3);
select pg_temp.record('doctor 2, with consent for the same patient', '0,0', pg_temp.visible());
with deleted as (delete from ehr.staff_record_chat_messages returning 1) insert into staff_deleted select count(*) from deleted;
with deleted as (delete from ehr.staff_record_chat_conversations returning 1) insert into staff_deleted select count(*) from deleted;
select pg_temp.record('doctor 2 deletes doctor 1''s history', '0,0', (select string_agg(n::text, ',') from staff_deleted));
-- Doctor 2's own scope passes the policy; the conversation's key names doctor 1.
select pg_temp.record('doctor 2 stores an exchange in doctor 1''s conversation', '23503', pg_temp.outcome(
  $sql$select pg_temp.insert_message(4, 1, 1, 4, 3, 'staff-chat-key-0000006')$sql$));
select pg_temp.bind_staff(3, 2, 3);
select pg_temp.record('doctor 1 at facility B', '0,0', pg_temp.visible());
select pg_temp.bind_staff(5, 4);
select pg_temp.record('the receptionist', '0,0', pg_temp.visible());
select pg_temp.bind_staff(6, 5);
select pg_temp.record('the nurse', '0,0', pg_temp.visible());
select pg_temp.bind_staff(3, 1, 2, 'emergency');
select pg_temp.record('doctor 1 under another purpose', '0,0', pg_temp.visible());
select pg_temp.bind_self(1);
select pg_temp.record('patient A, whose record it is about', '0,0', pg_temp.visible());
reset role;
select pg_temp.record('the history exists', '1,1', (select count(*)::text from ehr.staff_record_chat_conversations)
  || ',' || (select count(*)::text from ehr.staff_record_chat_messages));

-- 3a. Consent is checked each time: a revoked grant hides the history, and
--     it returns with a new one.
update identity.consent_grants set status = 'revoked', revoked_at = clock_timestamp()
 where id = '5c4b0700-0000-4000-8000-000000000001';
set local role hid_ehr_api_runtime;
select pg_temp.bind_staff(3, 1);
select pg_temp.record('doctor 1 after the consent is revoked', '0,0', pg_temp.visible());
select pg_temp.record('the proof after the consent is revoked', 'false', pg_temp.context(1));
reset role;
update identity.consent_grants set status = 'active', revoked_at = null
 where id = '5c4b0700-0000-4000-8000-000000000001';
set local role hid_ehr_api_runtime;
select pg_temp.bind_staff(3, 1);
select pg_temp.record('doctor 1 after the consent is active again', '1,1', pg_temp.visible());
reset role;

-- 3b. A legal hold keeps the history: while an active hold names the patient
--     or the staff account, the delete policies keep every row, and
--     ehr.staff_record_chat_history_on_hold says so to a staff direct-care
--     transaction only (true, fail closed, for any other caller).
insert into platform.legal_holds(id,subject_type,subject_id,reason)
values ('5c4b0b10-0000-4000-8000-000000000001','patient','5c4b0200-0000-4000-8000-000000000001',
  'Synthetic staff chat hold on the patient');
insert into platform.legal_holds(id,subject_type,subject_id,reason,released_at,release_reason)
values ('5c4b0b10-0000-4000-8000-000000000003','patient','5c4b0200-0000-4000-8000-000000000002',
  'Synthetic released staff chat hold',clock_timestamp(),'Synthetic hold released');
set local role hid_ehr_api_runtime;
select pg_temp.bind_staff(3, 1);
select pg_temp.record('a hold on patient A', 'true', pg_temp.held(1));
select pg_temp.record('a released hold on patient B does not hold', 'false', pg_temp.held(2));
delete from staff_deleted;
with deleted as (delete from ehr.staff_record_chat_messages returning 1) insert into staff_deleted select count(*) from deleted;
with deleted as (delete from ehr.staff_record_chat_conversations returning 1) insert into staff_deleted select count(*) from deleted;
select pg_temp.record('doctor 1 deletes their history under a patient hold', '0,0',
  (select string_agg(n::text, ',') from staff_deleted));
select pg_temp.record('the held history remains', '1,1', pg_temp.visible());
select pg_temp.bind_self(1);
select pg_temp.record('the patient asks about a hold', 'true', pg_temp.held(1));
select pg_temp.bind_staff(3, 1, 2, 'emergency');
select pg_temp.record('another purpose asks about a hold', 'true', pg_temp.held(2));
reset role;
set local session_replication_role = replica;
delete from platform.legal_holds where id = '5c4b0b10-0000-4000-8000-000000000001';
set local session_replication_role = origin;
insert into platform.legal_holds(id,subject_type,subject_id,reason)
values ('5c4b0b10-0000-4000-8000-000000000002','account','5c4b0100-0000-4000-8000-000000000003',
  'Synthetic staff chat hold on the staff account');
set local role hid_ehr_api_runtime;
select pg_temp.bind_staff(3, 1);
select pg_temp.record('a hold on doctor 1''s account', 'true', pg_temp.held(1));
delete from staff_deleted;
with deleted as (delete from ehr.staff_record_chat_conversations returning 1) insert into staff_deleted select count(*) from deleted;
select pg_temp.record('doctor 1 deletes their history under an account hold', '0|1,1',
  (select string_agg(n::text, ',') from staff_deleted) || '|' || pg_temp.visible());
reset role;
set local session_replication_role = replica;
delete from platform.legal_holds where id = '5c4b0b10-0000-4000-8000-000000000002';
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.bind_staff(3, 1);
select pg_temp.record('the hold released, doctor 1 deletes their history', 'ok|0,0', pg_temp.outcome(
  $sql$delete from ehr.staff_record_chat_conversations where patient_id = '5c4b0200-0000-4000-8000-000000000001'$sql$)
  || '|' || pg_temp.visible());
select pg_temp.record('an exchange for a deleted conversation', '23503', pg_temp.outcome(
  $sql$select pg_temp.insert_message(5, 1, 1, 3, 1, 'staff-chat-key-0000007')$sql$));
reset role;
select pg_temp.record('nothing of doctor 1''s history remains', '0', (select count(*)::text
  from ehr.staff_record_chat_messages where patient_id = pg_temp.patient(1)));

-- 4. The limits. A reservation reads the kill switch again (55000
--    RECORD_CHAT_PAUSED while it is off, which it is until turned on here).
set local role hid_ehr_api_runtime;
select pg_temp.bind_staff(3, 1);
select pg_temp.record('a staff reservation while record chat is paused', '55000:RECORD_CHAT_PAUSED', pg_temp.attempt(
  $sql$select ehr.reserve_record_chat('staff', '5c4b0200-0000-4000-8000-000000000001', 1000, 1000000)$sql$));
reset role;
update platform.control_settings set enabled = true where control_key = 'record_chat_enabled';
set local role hid_ehr_api_runtime;
select pg_temp.bind_staff(3, 1);
select pg_temp.record('the staff audience reads no limit table', '42501', pg_temp.outcome(
  $sql$select count(*) from ehr.record_chat_reservations$sql$));
select pg_temp.record('an unknown audience', '22023:RECORD_CHAT_AUDIENCE_INVALID', pg_temp.refusal(
  $sql$select ehr.reserve_record_chat('admin', '5c4b0200-0000-4000-8000-000000000001', 1000, 1000000)$sql$));
select pg_temp.record('a reservation of no tokens', '22023:RECORD_CHAT_RESERVATION_INVALID', pg_temp.refusal(
  $sql$select ehr.reserve_record_chat('staff', '5c4b0200-0000-4000-8000-000000000001', 0, 1000000)$sql$));
select pg_temp.record('the patient audience from a staff context', '42501:RECORD_CHAT_PERMISSION_DENIED', pg_temp.refusal(
  $sql$select ehr.reserve_record_chat('patient', '5c4b0200-0000-4000-8000-000000000001', 1000, 1000000)$sql$));
select pg_temp.bind_staff(4, 3);
select pg_temp.record('a reservation for a patient without consent', '42501:RECORD_CHAT_PERMISSION_DENIED', pg_temp.refusal(
  $sql$select ehr.reserve_record_chat('staff', '5c4b0200-0000-4000-8000-000000000002', 1000, 1000000)$sql$));
select pg_temp.bind_staff(4, 3, 2, 'emergency');
select pg_temp.record('a reservation under break-glass', '42501:RECORD_CHAT_PERMISSION_DENIED', pg_temp.refusal(
  $sql$select ehr.reserve_record_chat('staff', '5c4b0200-0000-4000-8000-000000000002', 1000, 1000000)$sql$));
select pg_temp.bind_staff(5, 4);
select pg_temp.record('a reservation by the receptionist', '42501:RECORD_CHAT_PERMISSION_DENIED', pg_temp.refusal(
  $sql$select ehr.reserve_record_chat('staff', '5c4b0200-0000-4000-8000-000000000001', 1000, 1000000)$sql$));
select pg_temp.bind_self(1);
select pg_temp.record('a reservation from the patient''s own session as staff', '42501:RECORD_CHAT_PERMISSION_DENIED',
  pg_temp.refusal($sql$select ehr.reserve_record_chat('staff', '5c4b0200-0000-4000-8000-000000000001', 1000, 1000000)$sql$));

-- One in flight per staff account; settlement is idempotent and its owner's only.
select pg_temp.bind_staff(3, 1);
insert into staff_leases select 'doctor 1', ehr.reserve_record_chat('staff', pg_temp.patient(1), 5000, 1000000);
select pg_temp.record('a second request in flight', 'P4091:RECORD_CHAT_BUSY', pg_temp.refusal(
  $sql$select ehr.reserve_record_chat('staff', '5c4b0200-0000-4000-8000-000000000002', 5000, 1000000)$sql$));
select pg_temp.bind_staff(4, 3);
select pg_temp.record('another staff account is not busy', 'ok', pg_temp.outcome(
  $sql$insert into staff_leases select 'doctor 2', ehr.reserve_record_chat('staff',
       '5c4b0200-0000-4000-8000-000000000001', 5000, 1000000)$sql$));
select pg_temp.record('doctor 2 settles doctor 1''s lease', '42501:RECORD_CHAT_PERMISSION_DENIED', pg_temp.refusal(
  $sql$select ehr.settle_record_chat((select id from staff_leases where name = 'doctor 1'), 10, 10, 0, 0, 'answered')$sql$));
select pg_temp.bind_self(1);
select pg_temp.record('the patient settles a staff lease', '42501:RECORD_CHAT_PERMISSION_DENIED', pg_temp.refusal(
  $sql$select ehr.settle_record_chat((select id from staff_leases where name = 'doctor 1'), 10, 10, 0, 0, 'answered')$sql$));
select pg_temp.bind_staff(3, 1);
select pg_temp.record('an unknown outcome', '22023:RECORD_CHAT_SETTLEMENT_INVALID', pg_temp.refusal(
  $sql$select ehr.settle_record_chat((select id from staff_leases where name = 'doctor 1'), 10, 10, 0, 0, 'expired')$sql$));
select pg_temp.record('doctor 1 settles their lease', 'true',
  (select ehr.settle_record_chat(id, 1200, 300, 0, 0, 'answered')::text from staff_leases where name = 'doctor 1'));
select pg_temp.record('settling again changes nothing', 'false',
  (select ehr.settle_record_chat(id, 1200, 300, 0, 0, 'answered')::text from staff_leases where name = 'doctor 1'));
-- A lease whose staff context changed (here: its consent is revoked) can no
-- longer be settled by its owner; it expires and is charged its estimate.
reset role;
update identity.consent_grants set status = 'revoked', revoked_at = clock_timestamp()
 where id = '5c4b0700-0000-4000-8000-000000000003';
set local role hid_ehr_api_runtime;
select pg_temp.bind_staff(4, 3);
select pg_temp.record('doctor 2 settles after the consent is revoked', '42501:RECORD_CHAT_PERMISSION_DENIED', pg_temp.refusal(
  $sql$select ehr.settle_record_chat((select id from staff_leases where name = 'doctor 2'), 10, 10, 0, 0, 'answered')$sql$));
reset role;
update identity.consent_grants set status = 'active', revoked_at = null
 where id = '5c4b0700-0000-4000-8000-000000000003';
select pg_temp.record('the settled lease and its audience', 'staff,answered,1200,300',
  (select audience || ',' || outcome || ',' || input_tokens || ',' || output_tokens from ehr.record_chat_reservations
    where id = (select id from staff_leases where name = 'doctor 1')));
select pg_temp.record('the lease belongs to the staff account', '5c4b0100-0000-4000-8000-000000000003',
  (select account_id::text from ehr.record_chat_reservations where id = (select id from staff_leases where name = 'doctor 1')));

-- 20 an hour per staff account: the 21st is refused with the seconds until
-- the hour's bucket resets; every refusal rolls back its own increments.
set local role hid_ehr_api_runtime;
select pg_temp.bind_staff(3, 1);
do $$
declare
  lease uuid;
begin
  for attempt in 2..20 loop
    lease := ehr.reserve_record_chat('staff', '5c4b0200-0000-4000-8000-000000000001', 1000, 1000000);
    perform ehr.settle_record_chat(lease, 0, 0, 0, 0, 'failed');
  end loop;
end
$$;
select pg_temp.record('the 21st request in the hour', 'P4290:RECORD_CHAT_RATE_LIMITED', pg_temp.refusal(
  $sql$select ehr.reserve_record_chat('staff', '5c4b0200-0000-4000-8000-000000000001', 1000, 1000000)$sql$));
reset role;
select pg_temp.record('the refusals counted nothing', '20,20',
  (select string_agg(request_count::text, ',' order by bucket_period) from ehr.record_chat_usage_counters
    where audience = 'staff' and account_id = '5c4b0100-0000-4000-8000-000000000003'));
select pg_temp.record('the patient audience counters are not touched', '0',
  (select count(*)::text from ehr.record_chat_usage_counters where audience = 'patient'
    and account_id = '5c4b0100-0000-4000-8000-000000000003'));

-- 100 a day per staff account: a day bucket at the limit refuses.
set local session_replication_role = replica;
update ehr.record_chat_usage_counters set request_count = 100
 where audience = 'staff' and account_id = '5c4b0100-0000-4000-8000-000000000004' and bucket_period = 'day';
insert into ehr.record_chat_usage_counters(audience,account_id,bucket_period,bucket_start,request_count)
values ('staff','5c4b0100-0000-4000-8000-000000000004','day',date_trunc('day', statement_timestamp(), 'UTC'),100)
on conflict (audience, account_id, bucket_period, bucket_start) do nothing;
set local session_replication_role = origin;
update ehr.record_chat_reservations set settled_at = clock_timestamp(), outcome = 'failed', input_tokens = 0, output_tokens = 0,
  cache_read_tokens = 0, cache_write_tokens = 0
 where id = (select id from staff_leases where name = 'doctor 2');
set local role hid_ehr_api_runtime;
select pg_temp.bind_staff(4, 3);
select pg_temp.record('the 101st request in the day', 'P4290:RECORD_CHAT_RATE_LIMITED', pg_temp.refusal(
  $sql$select ehr.reserve_record_chat('staff', '5c4b0200-0000-4000-8000-000000000001', 1000, 1000000)$sql$));
reset role;

-- The daily budget is shared with the patient audience: reserved plus used
-- plus requested may not pass the configured budget or the hard ceiling.
set local session_replication_role = replica;
delete from ehr.record_chat_usage_counters where account_id = '5c4b0100-0000-4000-8000-000000000004';
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.bind_staff(4, 3);
select pg_temp.record('a staff request over the configured budget', 'P5030:RECORD_CHAT_BUDGET_EXHAUSTED', pg_temp.refusal(
  $sql$select ehr.reserve_record_chat('staff', '5c4b0200-0000-4000-8000-000000000001', 5000, 1000)$sql$));
reset role;

-- The kill switch is read again at every reservation.
update platform.control_settings set enabled = false where control_key = 'record_chat_enabled';
set local role hid_ehr_api_runtime;
select pg_temp.bind_staff(4, 3);
select pg_temp.record('a reservation after the control is turned off', '55000:RECORD_CHAT_PAUSED', pg_temp.attempt(
  $sql$select ehr.reserve_record_chat('staff', '5c4b0200-0000-4000-8000-000000000001', 1000, 1000000)$sql$));
reset role;

-- 5. Nothing else is added.
select pg_temp.record('no staff chat embedding, chunk or extraction table', '0',
  (select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'ehr' and c.relkind = 'r' and (c.relname like 'staff\_chat%' or c.relname like '%evidence_chunks'
      or c.relname like '%attachment_extractions' or c.relname like '%document_extractions')));
select pg_temp.record('no staff record chat retention class or purge command', '0,0,0',
  (select count(*)::text from platform.record_class_retention_policies where record_class like '%chat%')
  || ',' || (select count(*)::text from pg_proc where proname like '%prune_record_chat%')
  || ',' || (select count(*)::text from pg_attribute where attrelid = 'ehr.staff_record_chat_messages'::regclass
    and attname = 'expires_at'));
select pg_temp.record('the control keys are unchanged', 'break_glass_enabled,clinician_signup_enabled,maintenance_mode,'
  || 'outreach_portal_enabled,patient_portal_enabled,provider_portal_enabled,record_chat_enabled,uploads_enabled',
  (select string_agg(control_key, ',' order by control_key) from platform.control_settings));
select pg_temp.record('the runtime has no UPDATE privilege on the staff history', 'false,false',
  has_table_privilege('hid_ehr_runtime', 'ehr.staff_record_chat_messages', 'UPDATE')::text || ','
  || has_table_privilege('hid_ehr_runtime', 'ehr.staff_record_chat_conversations', 'UPDATE')::text);
select pg_temp.record('public has nothing on the staff history', 'false,false',
  has_table_privilege('public', 'ehr.staff_record_chat_messages', 'SELECT')::text || ','
  || has_table_privilege('public', 'ehr.staff_record_chat_conversations', 'SELECT')::text);

do $$
declare
  failures text;
begin
  select string_agg(format('%s: expected %s, got %s', name, expected, actual), E'\n' order by name)
    into failures from staff_case_results where expected is distinct from actual;
  if failures is not null then
    raise exception E'staff record chat cases differ from the staff record chat rules:\n%', failures;
  end if;
  if date_trunc('hour', clock_timestamp(), 'UTC')::text <> current_setting('hid.staff_chat_suite_hour') then
    raise exception 'the staff record chat suite crossed a UTC hour boundary (its hourly and daily cases bucket by '
      'the hour); run it again';
  end if;
  if (select count(*) from staff_case_results) < 70 then
    raise exception 'staff record chat suite recorded only % cases', (select count(*) from staff_case_results);
  end if;
end $$;
rollback;
