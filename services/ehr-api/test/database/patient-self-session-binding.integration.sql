\set ON_ERROR_STOP on
-- The patient-self context is bound to the patient's own live session
-- (PSELF-RLS, 0083, main D-Eminence/hid-system#75): the database checks the
-- named patient, account, subject and session against
-- identity.patient_self_session and never trusts the transaction settings
-- alone. Cases follow main's (patient-self.integration.sql in #75), through
-- the EHR runtime for clinical records, the derived index and chat history,
-- and through the Lab runtime's wrapper. Rollback-only.
begin;
set constraints all deferred;

-- The binding's security properties (0083): SECURITY DEFINER with the pinned
-- search_path, and EXECUTE only for the EHR, Lab and schema-test runtimes.
do $$
declare
  extra text;
begin
  if not exists (select 1 from pg_proc where oid = 'ehr.patient_self_context(uuid)'::regprocedure
                  and prosecdef and proconfig = '{"search_path=pg_catalog, pg_temp"}'::text[] and provolatile = 's') then
    raise exception 'ehr.patient_self_context lost SECURITY DEFINER, its search_path or STABLE';
  end if;
  select string_agg(coalesce(nullif(privilege.grantee::regrole::text, '-'), 'public'), ', ')
    into extra
    from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
   where p.oid = 'ehr.patient_self_context(uuid)'::regprocedure
     and privilege.privilege_type = 'EXECUTE' and privilege.grantee <> p.proowner
     and (privilege.grantee = 0 or privilege.grantee::regrole::text
          not in ('hid_ehr_runtime', 'hid_lab_runtime', 'hid_schema_test_runtime'));
  if extra is not null then
    raise exception 'ehr.patient_self_context is executable by more than the EHR, Lab and test runtimes: %', extra;
  end if;
end $$;

-- Two patients with one live patient session each, and a workforce author.
insert into auth.accounts(id,subject,email,display_name,status)
select ('c1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  'synthetic:bind:'||n,'bind-'||n||'@example.invalid','Synthetic bind '||n,'active'
from generate_series(1,3) n;
insert into identity.patients(id,account_id,hid_code,first_name,last_name,full_name,status) values
 ('c2000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','HID-BNDAAA','Bind','One','Bind One','active'),
 ('c2000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000002','HID-BNDBBB','Bind','Two','Bind Two','active');
insert into auth.sessions(id,account_id,family_id,refresh_token_sha256,access_jti,account_token_version,
  authentication_method,issued_at,expires_at,absolute_expires_at,session_kind,patient_id)
select ('c3000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('c1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('c3000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  md5('bind'||n)||md5('bind'||n),gen_random_uuid(),1,'password',clock_timestamp(),
  clock_timestamp()+interval '1 hour',clock_timestamp()+interval '2 hours','patient',
  ('c2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
from generate_series(1,2) n;

insert into identity.organizations(id,name,slug)
values('c4000000-0000-4000-8000-000000000001','Bind test organization','bind-test-organization');
insert into identity.facilities(id,organization_id,name,code,timezone,active,lifecycle_status)
values('c4000000-0000-4000-8000-000000000002','c4000000-0000-4000-8000-000000000001','Bind test facility','BIND-A','Africa/Lagos',true,'verified');
insert into identity.staff(id,account_id,full_name,email,verification_status,default_role)
values('c5000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000003','Synthetic doctor','doctor-bind@example.invalid','verified','doctor');
insert into identity.staff_facility_memberships(id,staff_id,account_id,organization_id,facility_id,membership_role,app_role,is_primary,active)
values('c6000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000003',
  'c4000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000002','doctor','doctor',true,true);

-- One completed encounter with a signed note per patient. The fixtures skip
-- the clinical write triggers (schema.integration.sql covers them).
set local session_replication_role = replica;
insert into ehr.encounters(id,patient_id,facility_id,created_by,created_by_membership_id,encounter_type,status,started_at,ended_at)
select ('c7000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('c2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  'c4000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000003','c6000000-0000-4000-8000-000000000001',
  'ambulatory','completed',clock_timestamp()-interval '1 hour',clock_timestamp()
from generate_series(1,2) n;
insert into ehr.clinical_notes(id,encounter_id,patient_id,facility_id,created_by,created_by_membership_id,
  note_type,title,status,current_revision_no,signed_at,signed_by)
select ('c8000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('c7000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  ('c2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'c4000000-0000-4000-8000-000000000002',
  'c1000000-0000-4000-8000-000000000003','c6000000-0000-4000-8000-000000000001',
  'progress','Synthetic note','signed',1,clock_timestamp(),'c1000000-0000-4000-8000-000000000003'
from generate_series(1,2) n;
insert into ehr.clinical_note_revisions(clinical_note_id,patient_id,facility_id,revision_no,content,change_reason,created_by,created_by_membership_id)
select id,patient_id,facility_id,1,'Synthetic clinical content','Synthetic fixture create',created_by,created_by_membership_id
from ehr.clinical_notes where id::text like 'c8000000-%';
insert into ehr.patient_chat_state(patient_id) values
  ('c2000000-0000-4000-8000-000000000001'),('c2000000-0000-4000-8000-000000000002');
set local session_replication_role = origin;

-- Patient 2's session is revoked for its own case; patient 1's stays live.
update auth.sessions set revoked_at=clock_timestamp(),revocation_reason='synthetic-test'
  where id='c3000000-0000-4000-8000-000000000002';

create temporary table bind_cases(label text primary key, patient text, subject text, account text, session text)
  on commit drop;
grant select on bind_cases to public;
insert into bind_cases values
  ('another patient with the caller''s own live session',
   'c2000000-0000-4000-8000-000000000002','synthetic:bind:1','c1000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001'),
  ('another patient with a session that does not exist',
   'c2000000-0000-4000-8000-000000000002','synthetic:bind:2','c1000000-0000-4000-8000-000000000002','c3000000-0000-4000-8000-000000000099'),
  ('a patient whose own session is revoked',
   'c2000000-0000-4000-8000-000000000002','synthetic:bind:2','c1000000-0000-4000-8000-000000000002','c3000000-0000-4000-8000-000000000002'),
  ('a patient session of another account',
   'c2000000-0000-4000-8000-000000000002','synthetic:bind:2','c1000000-0000-4000-8000-000000000002','c3000000-0000-4000-8000-000000000001'),
  ('the patient''s own session under another account id',
   'c2000000-0000-4000-8000-000000000001','synthetic:bind:1','c1000000-0000-4000-8000-000000000002','c3000000-0000-4000-8000-000000000001'),
  ('the patient''s own session under another subject',
   'c2000000-0000-4000-8000-000000000001','synthetic:bind:2','c1000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001'),
  ('a session id that is not a UUID',
   'c2000000-0000-4000-8000-000000000001','synthetic:bind:1','c1000000-0000-4000-8000-000000000001','not-a-session-id'),
  ('an account id that is not a UUID',
   'c2000000-0000-4000-8000-000000000001','synthetic:bind:1','not-an-account-id','c3000000-0000-4000-8000-000000000001');

create function pg_temp.bind(patient text, subject text, account text, session text) returns void
language sql as $$
  select set_config('app.patient_id', patient, true), set_config('app.actor_subject', subject, true),
    set_config('app.account_id', account, true), set_config('app.session_id', session, true),
    set_config('app.purpose_of_use', 'patient-self', true), set_config('app.facility_id', '', true),
    set_config('app.membership_id', '', true), set_config('app.correlation_id', 'patient-self-binding-0001', true),
    set_config('app.self_authorized_until', (clock_timestamp() + interval '30 seconds')::text, true);
$$;

-- Unbound contexts read nothing and write nothing through the EHR runtime.
set local role hid_ehr_api_runtime;
do $$
declare
  probe record;
  leaked text := '';
begin
  for probe in select * from bind_cases order by label loop
    perform pg_temp.bind(probe.patient, probe.subject, probe.account, probe.session);
    if ehr.patient_self_context(probe.patient::uuid) is distinct from false
       or exists(select 1 from ehr.encounters) or exists(select 1 from ehr.clinical_notes)
       or exists(select 1 from ehr.clinical_note_revisions) or exists(select 1 from ehr.patient_chat_state) then
      leaked := leaked || probe.label || ' (read); ';
    end if;
    begin
      insert into ehr.patient_record_embeddings
        (note_id,revision_no,patient_id,facility_id,content_sha256,model_id,embedding)
      values (('c8000000-0000-4000-8000-00000000000' || right(probe.patient, 1))::uuid, 1, probe.patient::uuid,
        'c4000000-0000-4000-8000-000000000002', repeat('b',64), 'synthetic-bind-model',
        (array_fill(0::real,array[1024]))::public.vector);
      leaked := leaked || probe.label || ' (index write); ';
    exception when insufficient_privilege then null;
    end;
  end loop;
  if leaked <> '' then
    raise exception 'an unbound patient-self context reached patient records: %', leaked;
  end if;
end $$;
reset role;

-- The same contexts through the Lab runtime's wrapper.
set local role hid_lab_api_runtime;
do $$
declare
  probe record;
  leaked text := '';
begin
  for probe in select * from bind_cases order by label loop
    perform pg_temp.bind(probe.patient, probe.subject, probe.account, probe.session);
    if lab.patient_self_context(probe.patient::uuid) is distinct from false then
      leaked := leaked || probe.label || '; ';
    end if;
  end loop;
  if leaked <> '' then
    raise exception 'an unbound patient-self context passed the Lab wrapper: %', leaked;
  end if;
end $$;
reset role;

-- A stale account token version unbinds the session too.
update auth.accounts set token_version=2 where id='c1000000-0000-4000-8000-000000000001';
set local role hid_ehr_api_runtime;
select pg_temp.bind('c2000000-0000-4000-8000-000000000001','synthetic:bind:1',
  'c1000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001');
do $$ begin
  if ehr.patient_self_context('c2000000-0000-4000-8000-000000000001') or exists(select 1 from ehr.encounters) then
    raise exception 'a session of a stale account token version read patient records';
  end if;
end $$;
reset role;
update auth.accounts set token_version=1 where id='c1000000-0000-4000-8000-000000000001';

-- Each state that identity.patient_self_session refuses unbinds the
-- patient's own session too; every change is undone before the next.
create temporary table bind_states(label text primary key, apply text, undo text) on commit drop;
grant select on bind_states to public;
insert into bind_states values
  -- auth.sessions requires absolute_expires_at >= expires_at > issued_at, so
  -- an absolute expiry always comes with this one.
  ('an expired session',
   $s$update auth.sessions set issued_at=clock_timestamp()-interval '2 hours',
      expires_at=clock_timestamp()-interval '1 second' where id='c3000000-0000-4000-8000-000000000001'$s$,
   $s$update auth.sessions set expires_at=clock_timestamp()+interval '1 hour' where id='c3000000-0000-4000-8000-000000000001'$s$),
  ('a revoked session',
   $s$update auth.sessions set revoked_at=clock_timestamp(),revocation_reason='synthetic-test' where id='c3000000-0000-4000-8000-000000000001'$s$,
   $s$update auth.sessions set revoked_at=null,revocation_reason=null where id='c3000000-0000-4000-8000-000000000001'$s$),
  ('an inactive account',
   $s$update auth.accounts set status='pending_reset' where id='c1000000-0000-4000-8000-000000000001'$s$,
   $s$update auth.accounts set status='active' where id='c1000000-0000-4000-8000-000000000001'$s$),
  ('a temporarily disabled account',
   $s$update auth.accounts set disabled_until=clock_timestamp()+interval '1 hour' where id='c1000000-0000-4000-8000-000000000001'$s$,
   $s$update auth.accounts set disabled_until=null where id='c1000000-0000-4000-8000-000000000001'$s$),
  ('an inactive patient',
   $s$update identity.patients set status='deceased' where id='c2000000-0000-4000-8000-000000000001'$s$,
   $s$update identity.patients set status='active' where id='c2000000-0000-4000-8000-000000000001'$s$);
do $$
declare
  state record;
  leaked text := '';
begin
  for state in select * from bind_states order by label loop
    execute state.apply;
    set local role hid_ehr_api_runtime;
    perform pg_temp.bind('c2000000-0000-4000-8000-000000000001','synthetic:bind:1',
      'c1000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001');
    if ehr.patient_self_context('c2000000-0000-4000-8000-000000000001') or exists(select 1 from ehr.encounters) then
      leaked := leaked || state.label || '; ';
    end if;
    reset role;
    execute state.undo;
  end loop;
  if leaked <> '' then
    raise exception 'an unbindable session state still read patient records: %', leaked;
  end if;
end $$;

-- Without a correlation id the binding refuses as well.
set local role hid_ehr_api_runtime;
select pg_temp.bind('c2000000-0000-4000-8000-000000000001','synthetic:bind:1',
  'c1000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001');
select set_config('app.correlation_id', '', true);
do $$ begin
  if ehr.patient_self_context('c2000000-0000-4000-8000-000000000001') or exists(select 1 from ehr.encounters) then
    raise exception 'a patient-self context without a correlation id read patient records';
  end if;
end $$;
reset role;

-- Patient 1 bound to its own live session reads, indexes and keeps chat
-- history for its own released records only.
set local role hid_ehr_api_runtime;
select pg_temp.bind('c2000000-0000-4000-8000-000000000001','synthetic:bind:1',
  'c1000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001');
do $$ begin
  if not ehr.patient_self_context('c2000000-0000-4000-8000-000000000001')
     or ehr.patient_self_context('c2000000-0000-4000-8000-000000000002')
     or ehr.patient_self_context(null) then
    raise exception 'the bound context did not name exactly its own patient';
  end if;
  if (select array_agg(id::text) from ehr.encounters) is distinct from array['c7000000-0000-4000-8000-000000000001']
     or (select count(*) from ehr.clinical_notes) <> 1 or (select count(*) from ehr.clinical_note_revisions) <> 1
     or (select count(*) from ehr.patient_chat_state) <> 1 then
    raise exception 'a patient bound to its own session did not see exactly its released records';
  end if;
  insert into ehr.patient_record_embeddings
    (note_id,revision_no,patient_id,facility_id,content_sha256,model_id,embedding)
  select clinical_note_id,revision_no,patient_id,facility_id,content_sha256,
    'synthetic-bind-model',(array_fill(0::real,array[1024]))::public.vector
  from ehr.clinical_note_revisions;
  if (select count(*) from ehr.patient_record_embeddings) <> 1 then
    raise exception 'a bound patient cannot index its own released note';
  end if;
end $$;
-- An expired self authorization still ends the binding.
select set_config('app.self_authorized_until',(clock_timestamp()-interval '1 second')::text,true);
do $$ begin
  if ehr.patient_self_context('c2000000-0000-4000-8000-000000000001') or exists(select 1 from ehr.encounters) then
    raise exception 'an expired self authorization read patient records';
  end if;
end $$;
reset role;

set local role hid_lab_api_runtime;
select pg_temp.bind('c2000000-0000-4000-8000-000000000001','synthetic:bind:1',
  'c1000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001');
do $$ begin
  if not lab.patient_self_context('c2000000-0000-4000-8000-000000000001') then
    raise exception 'the Lab wrapper refused a patient bound to its own session';
  end if;
end $$;
reset role;

rollback;
