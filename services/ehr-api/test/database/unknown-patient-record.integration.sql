\set ON_ERROR_STOP on
-- ID-7 (0146): unknown patient records. Rollback-only. Every command runs as
-- the exact Identity (or EHR) API runtime role in the staff context their
-- services set.
--
--   1. create: the record and its patient row, the label per facility, the
--      estimated date of birth, the audit row (no Health ID or name), the
--      replay and a reused key, the request rules, the sealed demo refusal,
--      the sealed QA facility's record, a role without the permission;
--   2. no login and no NIN while unknown; 0138's pre-check answers
--      unknown_record here and not_permitted at another facility;
--   3. the basis (created_here at its facility only) and the own-facility
--      opening; search: a Health ID alone at its facility finds it, nothing
--      else does, and another facility's Health ID search does not;
--   4. list (open, all, paging, the audit rows) and read (the note; another
--      facility's record is not found, with the reason in the audit row);
--   5. identify: no candidate makes it standard; a candidate holds the
--      details and keeps it unknown; the phone rule for adults, the version,
--      the replay, a second identify;
--   6. confirm-separate: the second person, not in review, the held details
--      applied;
--   7. cancel: inactive, the basis gone; refused with a visit or only an
--      allergy attached (the allergy through the marker-gated policy, which
--      the tables' owner does not pass without the marker) or once
--      identified; the replay;
--   8. the waiting list's record kinds, and the grants;
--   9. Ola's review of #302: identify or confirm without a sex keeps it; the
--      approver's review (held details and candidate cards, its refusals and
--      audit rows); seals in both directions; ID-2's rule reads held phones
--      and records in review, refuses a stated Health ID of this facility's
--      unknown record and never links a case to one; replays audited; cancel
--      closes the waiting-list entry and nulls the held details; an erasure
--      erases the held contact. The record kind is derived (no column).
begin;

insert into identity.organizations (id, name, slug) values
  ('f1460000-0000-4000-8000-000000000001', 'Unknown Suite Hospital Group', 'unknown-suite-hospital-group'),
  ('f1460000-0000-4000-8000-000000000002', 'Unknown Suite Other Group', 'unknown-suite-other-group'),
  ('f1460000-0000-4000-8000-000000000003', 'Unknown Suite QA Group', 'unknown-suite-qa-group'),
  ('f1460000-0000-4000-8000-000000000004', 'Unknown Suite Demo Group', 'unknown-suite-demo-group');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('f1461000-0000-4000-8000-000000000001', 'f1460000-0000-4000-8000-000000000001', 'Unknown Suite Hospital', 'UNK-H',
   'Africa/Lagos', true, 'verified'),
  ('f1461000-0000-4000-8000-000000000002', 'f1460000-0000-4000-8000-000000000002', 'Unknown Suite Other', 'UNK-O',
   'Africa/Lagos', true, 'verified'),
  ('f1461000-0000-4000-8000-000000000003', 'f1460000-0000-4000-8000-000000000003', 'Unknown Suite QA', 'UNK-Q',
   'Africa/Lagos', true, 'verified'),
  ('f1461000-0000-4000-8000-000000000004', 'f1460000-0000-4000-8000-000000000004', 'Unknown Suite Demo', 'UNK-D',
   'Africa/Lagos', true, 'verified');
-- Members: 1 desk H, 2 nurse H, 3 admin H, 4 admin2 H, 5 desk O, 6 desk Q (QA), 7 desk D (demo), 8 lab H.
insert into auth.accounts (id, subject, email, display_name, status)
select ('f1462000-0000-4000-8000-00000000000' || n)::uuid, 'synthetic:unknown:member-' || n,
  'member' || n || '@unknown-suite.invalid', 'Unknown Suite Member ' || n, 'active'
  from generate_series(1, 8) n;
insert into identity.sealed_qa_members (member_kind, member_id) values
  ('organization', 'f1460000-0000-4000-8000-000000000003'), ('facility', 'f1461000-0000-4000-8000-000000000003'),
  ('account', 'f1462000-0000-4000-8000-000000000006');
insert into identity.sealed_demo_members (member_kind, member_id) values
  ('organization', 'f1460000-0000-4000-8000-000000000004'), ('facility', 'f1461000-0000-4000-8000-000000000004'),
  ('account', 'f1462000-0000-4000-8000-000000000007');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('f1463000-0000-4000-8000-00000000000' || member.n)::uuid, ('f1462000-0000-4000-8000-00000000000' || member.n)::uuid,
  'Unknown Suite Member ' || member.n, 'member' || member.n || '@unknown-suite.invalid', 'verified', member.role_code
  from (values (1, 'receptionist'), (2, 'nurse'), (3, 'admin'), (4, 'admin'), (5, 'receptionist'),
               (6, 'receptionist'), (7, 'receptionist'), (8, 'lab')) as member(n, role_code);
insert into identity.staff_facility_memberships
  (id, staff_id, account_id, organization_id, facility_id, membership_role, app_role, is_primary, active)
select ('f1464000-0000-4000-8000-00000000000' || member.n)::uuid, ('f1463000-0000-4000-8000-00000000000' || member.n)::uuid,
  ('f1462000-0000-4000-8000-00000000000' || member.n)::uuid,
  ('f1460000-0000-4000-8000-00000000000' || member.org)::uuid, ('f1461000-0000-4000-8000-00000000000' || member.org)::uuid,
  member.role_code, member.role_code, true, true
  from (values (1, 1, 'receptionist'), (2, 1, 'nurse'), (3, 1, 'admin'), (4, 1, 'admin'), (5, 2, 'receptionist'),
               (6, 3, 'receptionist'), (7, 4, 'receptionist'), (8, 1, 'lab')) as member(n, org, role_code);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('f1465000-0000-4000-8000-00000000000' || membership.n)::uuid, membership.account_id, membership.membership_role,
  'facility', membership.id, membership.facility_id, 'Unknown patient suite member'
  from (select substr(id::text, 36, 1)::integer as n, * from identity.staff_facility_memberships
         where id::text like 'f1464000-%') membership;
-- A standard patient: the possible duplicate.
insert into identity.patients (id, hid_code, first_name, last_name, full_name, dob, gender, status) values
  ('f1466000-0000-4000-8000-000000000001', 'HID-UNKSTD2', 'Ada', 'Obi', 'Ada Obi', date '1990-05-01', 'female', 'active');

create function pg_temp.as_member(n integer, correlation text, purpose text default 'healthcare-operations')
returns void language sql as $f$
  select set_config('app.actor_subject', 'synthetic:unknown:member-' || n, true),
    set_config('app.membership_id', 'f1464000-0000-4000-8000-00000000000' || n, true),
    set_config('app.facility_id', case n when 5 then 'f1461000-0000-4000-8000-000000000002'
      when 6 then 'f1461000-0000-4000-8000-000000000003' when 7 then 'f1461000-0000-4000-8000-000000000004'
      else 'f1461000-0000-4000-8000-000000000001' end, true),
    set_config('app.correlation_id', correlation, true), set_config('app.purpose_of_use', purpose, true);
$f$;
create function pg_temp.key(label text) returns text language sql as $f$ select 'unknown-suite-key-' || label; $f$;
create function pg_temp.sha(label text) returns text language sql as $f$
  select encode(sha256(('unknown-suite-' || label)::bytea), 'hex');
$f$;
create function pg_temp.note() returns bytea language sql as $f$ select decode(repeat('ab', 40), 'hex'); $f$;
create function pg_temp.patient(n integer) returns uuid language sql as $f$
  select ('f1467000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid;
$f$;
-- The record's version, read as the suite's owner (the runtime has no privilege on the table).
create function pg_temp.version(n integer) returns bigint language sql security definer as $f$
  select unknown_record.row_version from identity.unknown_patients unknown_record where unknown_record.patient_id = pg_temp.patient(n);
$f$;
create function pg_temp.refusal(command text) returns text language plpgsql as $f$
begin
  execute command;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
grant execute on function pg_temp.as_member(integer, text, text), pg_temp.key(text), pg_temp.sha(text), pg_temp.note(),
  pg_temp.patient(integer), pg_temp.version(integer), pg_temp.refusal(text)
  to hid_identity_api_runtime, hid_ehr_api_runtime;

-- 1. Create.
set local role hid_identity_api_runtime;
select pg_temp.as_member(1, 'unknown-create-0001');
do $$
declare made record; again record; outcome text;
  expected_dob date := least(make_date(extract(year from (clock_timestamp() at time zone 'Africa/Lagos'))::integer - 35, 7, 1),
                             (clock_timestamp() at time zone 'Africa/Lagos')::date);
begin
  select * into made from identity.create_unknown_patient(pg_temp.patient(1), 'HID-UNKAAA2', 'male', 35, 'unconscious',
    pg_temp.note(), 'v1', pg_temp.key('create-1'), pg_temp.sha('create-1'));
  if made.patient_id <> pg_temp.patient(1) or made.hid_code <> 'HID-UNKAAA2' or made.record_kind <> 'unknown'
     or made.label <> 'U-0001' or made.display_name <> 'Unknown patient U-0001' or made.sex <> 'male'
     or made.date_of_birth <> expected_dob or not made.dob_estimated or made.status <> 'open' or made.row_version <> 1
     or made.facility_daily_count <> 1 or made.replayed then
    raise exception '1a: create answered %', row_to_json(made);
  end if;
  select * into again from identity.create_unknown_patient(pg_temp.patient(1), 'HID-UNKAAA2', 'male', 35, 'unconscious',
    pg_temp.note(), 'v1', pg_temp.key('create-1'), pg_temp.sha('create-1'));
  if again.patient_id <> pg_temp.patient(1) or not again.replayed or again.label <> 'U-0001' then
    raise exception '1b: the replay answered %', row_to_json(again);
  end if;
  outcome := pg_temp.refusal(format('select identity.create_unknown_patient(%L, %L, %L, %s, %L, null, null, %L, %L)',
    pg_temp.patient(9), 'HID-UNKAAA9', 'male', 35, 'unconscious', pg_temp.key('create-1'), pg_temp.sha('create-other')));
  if outcome <> '22023 IDEMPOTENCY_KEY_REUSED' then raise exception '1c: a reused key answered %', outcome; end if;
  -- Without an age or a note: the next label, no date of birth.
  select * into made from identity.create_unknown_patient(pg_temp.patient(2), 'HID-UNKAAA3', 'female', null, 'confused',
    null, null, pg_temp.key('create-2'), pg_temp.sha('create-2'));
  if made.label <> 'U-0002' or made.date_of_birth is not null or made.dob_estimated or made.facility_daily_count <> 2 then
    raise exception '1d: the second create answered %', row_to_json(made);
  end if;
  -- More records for the steps below: 3, 4 and 5 (a child's age for 5).
  perform identity.create_unknown_patient(pg_temp.patient(3), 'HID-UNKAAA4', 'female', 40, 'cannot_communicate',
    null, null, pg_temp.key('create-3'), pg_temp.sha('create-3'));
  perform identity.create_unknown_patient(pg_temp.patient(4), 'HID-UNKAAA5', 'other', 50, 'other',
    null, null, pg_temp.key('create-4'), pg_temp.sha('create-4'));
  perform identity.create_unknown_patient(pg_temp.patient(5), 'HID-UNKAAA6', 'male', 8, 'unaccompanied_child',
    null, null, pg_temp.key('create-5'), pg_temp.sha('create-5'));
  for outcome in select pg_temp.refusal(command) from (values
      (format('select identity.create_unknown_patient(%L, %L, %L, %s, %L, null, null, %L, %L)', pg_temp.patient(9),
        'HID-UNKAAA9', 'male', 121, 'unconscious', pg_temp.key('bad-1'), pg_temp.sha('bad-1'))),
      (format('select identity.create_unknown_patient(%L, %L, null, %s, %L, null, null, %L, %L)', pg_temp.patient(9),
        'HID-UNKAAA9', 35, 'unconscious', pg_temp.key('bad-2'), pg_temp.sha('bad-2'))),
      (format('select identity.create_unknown_patient(%L, %L, %L, %s, %L, null, null, %L, %L)', pg_temp.patient(9),
        'HID-UNKAAA9', 'male', 35, 'asleep', pg_temp.key('bad-3'), pg_temp.sha('bad-3'))),
      (format('select identity.create_unknown_patient(%L, %L, %L, %s, %L, %L::bytea, null, %L, %L)', pg_temp.patient(9),
        'HID-UNKAAA9', 'male', 35, 'unconscious', pg_temp.note(), pg_temp.key('bad-4'), pg_temp.sha('bad-4'))),
      (format('select identity.create_unknown_patient(%L, %L, %L, %s, %L, null, null, %L, %L)', pg_temp.patient(9),
        'HID-BAD', 'male', 35, 'unconscious', pg_temp.key('bad-5'), pg_temp.sha('bad-5')))
    ) as cases(command) loop
    if outcome <> '22023 UNKNOWN_PATIENT_INVALID' then raise exception '1e: a bad request answered %', outcome; end if;
  end loop;
end $$;
-- Another facility numbers its own; a demo facility is refused; QA makes a QA patient; lab staff may not.
select pg_temp.as_member(5, 'unknown-create-other');
do $$
declare made record;
begin
  select * into made from identity.create_unknown_patient(pg_temp.patient(6), 'HID-UNKAAA7', 'male', 30, 'unconscious',
    null, null, pg_temp.key('create-6'), pg_temp.sha('create-6'));
  if made.label <> 'U-0001' then raise exception '1f: another facility''s first label is %', made.label; end if;
end $$;
select pg_temp.as_member(7, 'unknown-create-demo');
do $$
begin
  if pg_temp.refusal(format('select identity.create_unknown_patient(%L, %L, %L, %s, %L, null, null, %L, %L)',
       pg_temp.patient(9), 'HID-UNKAAA9', 'male', 30, 'unconscious', pg_temp.key('demo'), pg_temp.sha('demo')))
     <> '42501 UNKNOWN_PATIENT_SEALED_FACILITY' then
    raise exception '1g: a demo facility made an unknown record';
  end if;
end $$;
select pg_temp.as_member(6, 'unknown-create-qa');
select identity.create_unknown_patient(pg_temp.patient(7), 'HID-UNKAAA8', 'female', 30, 'confused', null, null,
  pg_temp.key('create-7'), pg_temp.sha('create-7'));
select pg_temp.as_member(8, 'unknown-create-lab');
do $$
begin
  if pg_temp.refusal(format('select identity.create_unknown_patient(%L, %L, %L, %s, %L, null, null, %L, %L)',
       pg_temp.patient(9), 'HID-UNKAAA9', 'male', 30, 'unconscious', pg_temp.key('lab'), pg_temp.sha('lab')))
     <> '42501 UNKNOWN_PATIENT_DENIED' then
    raise exception '1h: a lab member made an unknown record';
  end if;
end $$;
reset role;
do $$
declare patient_row identity.patients%rowtype;
begin
  select * into patient_row from identity.patients where id = pg_temp.patient(1);
  if patient_row.first_name <> 'Unknown' or patient_row.last_name <> 'U-0001'
     or patient_row.full_name <> 'Unknown patient U-0001' or patient_row.source_system <> 'hid-unknown-patient'
     or identity.patient_record_kind(patient_row.id) <> 'unknown' or patient_row.account_id is not null
     or patient_row.status <> 'active' then
    raise exception '1i: the patient row is %', row_to_json(patient_row);
  end if;
  -- D1: identity.patients gains no column; the kind is derived.
  if exists (select 1 from pg_attribute where attrelid = 'identity.patients'::regclass
              and attname in ('record_kind', 'dob_estimated'))
     or identity.patient_record_kind('f1466000-0000-4000-8000-000000000001') <> 'standard' then
    raise exception '1m: identity.patients has a kind column, or a standard patient is not standard';
  end if;
  if not identity.sealed_qa_patient(pg_temp.patient(7)) or identity.sealed_qa_patient(pg_temp.patient(1)) then
    raise exception '1j: the QA record is not a sealed QA patient';
  end if;
  -- Seven records made, and the one replay audited too (Ola's #302 item 8).
  if (select count(*) from audit.events where action = 'identity.unknown-patient.create'
       and not (details ? 'replayed')) <> 7
     or (select count(*) from audit.events where action = 'identity.unknown-patient.create'
          and details @> '{"replayed": true}' and patient_id = pg_temp.patient(1) and outcome = 'success') <> 1
     or exists (select 1 from audit.events where action like 'identity.unknown-patient%'
                 and (details::text like '%HID-%' or details::text like '%Unknown patient%'
                      or details::text like '%abab%')) then
    raise exception '1k: the create audit rows are wrong';
  end if;
  if (select arrival_note_ciphertext from identity.unknown_patients where patient_id = pg_temp.patient(1)) <> pg_temp.note() then
    raise exception '1l: the arrival note was not kept';
  end if;
end $$;

-- 2. No login and no NIN while unknown.
do $$
begin
  begin
    update identity.patients set account_id = 'f1462000-0000-4000-8000-000000000001' where id = pg_temp.patient(1);
    raise exception '2a: an unknown record got a login';
  exception when raise_exception then
    if sqlerrm <> 'PATIENT_RECORD_UNKNOWN' then raise; end if;
  end;
  begin
    insert into identity.patient_identifiers (id, patient_id, identifier_type, lookup_hmac, verified)
    values (gen_random_uuid(), pg_temp.patient(1), 'nin', repeat('c', 64), true);
    raise exception '2b: an unknown record got a NIN';
  exception when raise_exception then
    if sqlerrm <> 'PATIENT_RECORD_UNKNOWN' then raise; end if;
  end;
end $$;
set local role hid_identity_api_runtime;
select pg_temp.as_member(1, 'unknown-nin-precheck');
do $$
declare decision_value text;
begin
  select decision into decision_value from identity.patient_nin_link_precheck(pg_temp.patient(1), repeat('c', 64)::char(64),
    pg_temp.key('nin-1'), pg_temp.sha('nin-1')::char(64));
  if decision_value <> 'unknown_record' then raise exception '2c: the NIN pre-check answered %', decision_value; end if;
end $$;
-- Another facility's desk gets not_permitted, as for any patient not its own (Ola's #302 item 9).
select pg_temp.as_member(5, 'unknown-nin-precheck-other');
do $$
declare decision_value text;
begin
  select decision into decision_value from identity.patient_nin_link_precheck(pg_temp.patient(1), repeat('c', 64)::char(64),
    pg_temp.key('nin-o'), pg_temp.sha('nin-o')::char(64));
  if decision_value <> 'not_permitted' then raise exception '2d: another facility''s pre-check answered %', decision_value; end if;
end $$;
reset role;

-- 3. The basis, the opening and search.
do $$
begin
  if identity.own_facility_basis(pg_temp.patient(1), 'f1461000-0000-4000-8000-000000000001') <> 'created_here'
     or identity.own_facility_basis(pg_temp.patient(1), 'f1461000-0000-4000-8000-000000000002') is not null then
    raise exception '3a: the basis is wrong';
  end if;
end $$;
set local role hid_identity_api_runtime;
select pg_temp.as_member(2, 'unknown-open', 'direct-care');
do $$
declare opened record;
begin
  select * into opened from identity.open_own_facility_patient(null, pg_temp.patient(1));
  if opened.outcome <> 'opened' then raise exception '3b: the own-facility opening answered %', row_to_json(opened); end if;
end $$;
select pg_temp.as_member(1, 'unknown-search', 'direct-care');
do $$
declare found_row record; outcome_value text;
begin
  select * into found_row from identity.staff_patient_search('standard', null, null, null, 'HID-UNKAAA2', null, null, null);
  if found_row.outcome <> 'found' or found_row.record_kind <> 'unknown' or found_row.full_name <> 'Unknown patient U-0001' then
    raise exception '3c: a Health ID alone answered %', row_to_json(found_row);
  end if;
  select outcome into outcome_value from identity.staff_patient_search('standard', null, 'U-0001', null, 'HID-UNKAAA2',
    null, null, null);
  if outcome_value <> 'no_match' then raise exception '3d: Health ID and last name answered %', outcome_value; end if;
  select outcome into outcome_value from identity.staff_patient_search('standard', 'Unknown', 'U-0001',
    least(make_date(extract(year from (clock_timestamp() at time zone 'Africa/Lagos'))::integer - 35, 7, 1),
          (clock_timestamp() at time zone 'Africa/Lagos')::date),
    null, null, null, null);
  if outcome_value is distinct from 'no_match' then raise exception '3e: names and date of birth answered %', outcome_value; end if;
  select outcome into outcome_value from identity.staff_patient_search('standard', 'Ada', 'Obi', date '1990-05-01',
    null, null, null, null);
  if outcome_value <> 'found' then raise exception '3f: a standard patient was not found: %', outcome_value; end if;
end $$;
select pg_temp.as_member(5, 'unknown-search-other', 'direct-care');
do $$
declare outcome_value text;
begin
  select outcome into outcome_value from identity.staff_patient_search('standard', null, null, null, 'HID-UNKAAA2',
    null, null, null);
  if outcome_value <> 'no_match' then raise exception '3g: another facility''s Health ID search answered %', outcome_value; end if;
end $$;
reset role;

-- 4. List and read.
set local role hid_identity_api_runtime;
select pg_temp.as_member(1, 'unknown-list-0001');
do $$
declare listed jsonb; page record; outcome_row record;
begin
  select jsonb_agg(jsonb_build_object('label', card.label, 'more', card.has_more) order by card.created_at desc)
    into listed from identity.list_unknown_patients('open', 10, null, null) card;
  if listed <> '[{"label": "U-0005", "more": false}, {"label": "U-0004", "more": false},
                 {"label": "U-0003", "more": false}, {"label": "U-0002", "more": false},
                 {"label": "U-0001", "more": false}]'::jsonb then
    raise exception '4a: the list was %', listed;
  end if;
  select * into page from identity.list_unknown_patients('open', 2, null, null) card order by card.created_at desc limit 1 offset 1;
  if page.label <> 'U-0004' or not page.has_more then raise exception '4b: the first page ends with %', row_to_json(page); end if;
  select jsonb_agg(card.label order by card.created_at desc) into listed
    from identity.list_unknown_patients('open', 2, page.created_at, page.patient_id) card;
  if listed <> '["U-0003", "U-0002"]'::jsonb then raise exception '4c: the next page was %', listed; end if;
  select * into outcome_row from identity.read_unknown_patient(pg_temp.patient(1));
  if outcome_row.outcome <> 'found' or outcome_row.arrival_note_ciphertext <> pg_temp.note()
     or outcome_row.arrival_note_key_version <> 'v1' or outcome_row.health_id_last4 <> 'AAA2' then
    raise exception '4d: the read answered %', row_to_json(outcome_row);
  end if;
  if pg_temp.refusal('select identity.list_unknown_patients(''recent'', 10, null, null)') <> '22023 UNKNOWN_PATIENT_INVALID' then
    raise exception '4e: a bad status was accepted';
  end if;
end $$;
select pg_temp.as_member(5, 'unknown-read-other');
do $$
declare outcome_row record;
begin
  select * into outcome_row from identity.read_unknown_patient(pg_temp.patient(1));
  if outcome_row.outcome <> 'not_found' or outcome_row.patient_id is not null then
    raise exception '4f: another facility read %', row_to_json(outcome_row);
  end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from audit.events where action = 'identity.unknown-patient.list.shown'
       and correlation_id = 'unknown-list-0001') <> 9
     or not exists (select 1 from audit.events where action = 'identity.unknown-patient.read'
                     and correlation_id = 'unknown-read-other' and outcome = 'denied'
                     and details = '{"refusal": "not_found", "notFoundReason": "other_facility"}'::jsonb) then
    raise exception '4g: the list and read audit rows are wrong';
  end if;
end $$;

-- 5. Identify.
set local role hid_identity_api_runtime;
select pg_temp.as_member(1, 'unknown-identify-0001');
do $$
declare answer record; outcome text;
begin
  -- No candidate: record 2 becomes standard.
  select * into answer from identity.identify_unknown_patient(pg_temp.patient(2), pg_temp.version(2), ' Zara ', 'Bello',
    date '1985-01-01', 'female', repeat('d', 64), pg_temp.note(), pg_temp.note(), 'v1', pg_temp.key('identify-2'),
    pg_temp.sha('identify-2'));
  if answer.outcome <> 'identified' or answer.record_kind <> 'standard' or answer.display_name <> 'Zara Bello'
     or answer.status <> 'identified' or answer.dob_estimated or answer.candidate_count <> 0 or answer.replayed then
    raise exception '5a: identify answered %', row_to_json(answer);
  end if;
  select * into answer from identity.identify_unknown_patient(pg_temp.patient(2), 1, 'Zara', 'Bello',
    date '1985-01-01', 'female', repeat('d', 64), pg_temp.note(), pg_temp.note(), 'v1', pg_temp.key('identify-2'),
    pg_temp.sha('identify-2'));
  if answer.outcome <> 'identified' or not answer.replayed then raise exception '5b: the replay answered %', row_to_json(answer); end if;
  outcome := pg_temp.refusal(format('select identity.identify_unknown_patient(%L, %s, %L, %L, %L, %L, null, null, null, null, %L, %L)',
    pg_temp.patient(2), pg_temp.version(2), 'Zara', 'Bello', '2015-01-01', 'female', pg_temp.key('identify-2b'),
    pg_temp.sha('identify-2b')));
  if outcome <> 'P0001 UNKNOWN_PATIENT_ALREADY_IDENTIFIED' then raise exception '5c: a second identify answered %', outcome; end if;
  -- A candidate (the same name and date of birth as Ada Obi): held, still unknown.
  select * into answer from identity.identify_unknown_patient(pg_temp.patient(1), pg_temp.version(1), 'Ada', 'Obi',
    date '1990-05-01', 'female', repeat('e', 64), pg_temp.note(), pg_temp.note(), 'v1', pg_temp.key('identify-1'),
    pg_temp.sha('identify-1'));
  if answer.outcome <> 'sent_for_review' or answer.record_kind <> 'unknown' or answer.status <> 'sent_for_review'
     or answer.display_name <> 'Unknown patient U-0001' or answer.candidate_count <> 1 then
    raise exception '5d: identify with a candidate answered %', row_to_json(answer);
  end if;
  -- An adult without a phone; a stale version; a child without a phone is fine.
  outcome := pg_temp.refusal(format('select identity.identify_unknown_patient(%L, %s, %L, %L, %L, %L, null, null, null, null, %L, %L)',
    pg_temp.patient(3), pg_temp.version(3), 'Kemi', 'Ade', '1980-02-02', 'female', pg_temp.key('identify-3'),
    pg_temp.sha('identify-3')));
  if outcome <> '22023 UNKNOWN_PATIENT_PHONE_REQUIRED' then raise exception '5e: an adult without a phone answered %', outcome; end if;
  outcome := pg_temp.refusal(format('select identity.identify_unknown_patient(%L, %s, %L, %L, %L, %L, %L, %L::bytea, %L::bytea, %L, %L, %L)',
    pg_temp.patient(3), pg_temp.version(3) + 1, 'Kemi', 'Ade', '1980-02-02', 'female', repeat('f', 64), pg_temp.note(),
    pg_temp.note(), 'v1', pg_temp.key('identify-3'), pg_temp.sha('identify-3')));
  if outcome <> '40001 VERSION_CONFLICT' then raise exception '5f: a stale version answered %', outcome; end if;
  select * into answer from identity.identify_unknown_patient(pg_temp.patient(5), pg_temp.version(5), 'Tobi', 'Okafor',
    ((clock_timestamp() at time zone 'Africa/Lagos')::date - interval '8 years')::date, 'male', null, null, null, null,
    pg_temp.key('identify-5'), pg_temp.sha('identify-5'));
  if answer.outcome <> 'identified' then raise exception '5g: a child without a phone answered %', row_to_json(answer); end if;
end $$;
-- Record 3 is identified by an approver (admin 3) with Ada Obi's details too: in review.
select pg_temp.as_member(3, 'unknown-identify-0003');
select identity.identify_unknown_patient(pg_temp.patient(3), pg_temp.version(3), 'Ada', 'Obi', date '1990-05-01',
  'female', repeat('f', 64), pg_temp.note(), pg_temp.note(), 'v1', pg_temp.key('identify-3b'), pg_temp.sha('identify-3b'));
select pg_temp.as_member(1, 'unknown-search-after', 'direct-care');
do $$
declare found_row record;
begin
  select * into found_row from identity.staff_patient_search('standard', 'Zara', 'Bello', date '1985-01-01', null, null, null, null);
  if found_row.outcome <> 'found' or found_row.record_kind <> 'standard' then
    raise exception '5h: the identified record was not found: %', row_to_json(found_row);
  end if;
end $$;
reset role;
do $$
begin
  if (select array[first_name, last_name, identity.patient_record_kind(id)] from identity.patients where id = pg_temp.patient(1))
       <> array['Unknown', 'U-0001', 'unknown']
     or (select array[first_name, last_name, identity.patient_record_kind(id)] from identity.patients where id = pg_temp.patient(2))
       <> array['Zara', 'Bello', 'standard']
     or identity.own_facility_basis(pg_temp.patient(2), 'f1461000-0000-4000-8000-000000000001') <> 'created_here'
     or (select candidates from identity.unknown_patients where patient_id = pg_temp.patient(1))
       <> '[{"score": 90, "reasons": ["date_of_birth", "first_name", "last_name"],
             "patientId": "f1466000-0000-4000-8000-000000000001"}]'::jsonb
     or (select count(*) from audit.events where action = 'identity.unknown-patient.identify'
          and patient_id = pg_temp.patient(2) and details @> '{"replayed": true}') <> 1
     or exists (select 1 from audit.events where action = 'identity.unknown-patient.identify'
                 and (details::text like '%Ada%' or details::text like '%1990%' or details::text like '%Zara%')) then
    raise exception '5i: the identified and held records are wrong';
  end if;
end $$;

-- 6. Confirm separate.
set local role hid_identity_api_runtime;
select pg_temp.as_member(3, 'unknown-confirm-0001');
do $$
declare answer record; outcome text;
begin
  outcome := pg_temp.refusal(format('select identity.decide_unknown_patient(%L, %L, %s, %L, %L, %L)', pg_temp.patient(3),
    'confirm_separate', pg_temp.version(3), 'Checked with the family', pg_temp.key('confirm-3'), pg_temp.sha('confirm-3')));
  if outcome <> '42501 UNKNOWN_PATIENT_SECOND_PERSON_REQUIRED' then raise exception '6a: the identifier confirmed: %', outcome; end if;
  outcome := pg_temp.refusal(format('select identity.decide_unknown_patient(%L, %L, %s, %L, %L, %L)', pg_temp.patient(4),
    'confirm_separate', pg_temp.version(4), 'Checked with the family', pg_temp.key('confirm-4'), pg_temp.sha('confirm-4')));
  if outcome <> 'P0001 UNKNOWN_PATIENT_NOT_IN_REVIEW' then raise exception '6b: an open record answered %', outcome; end if;
  select * into answer from identity.decide_unknown_patient(pg_temp.patient(1), 'confirm_separate', pg_temp.version(1),
    'Different mother''s name; not Ada Obi', pg_temp.key('confirm-1'), pg_temp.sha('confirm-1'));
  if answer.outcome <> 'identified' or answer.record_kind <> 'standard' or answer.display_name <> 'Ada Obi'
     or answer.status <> 'identified' then
    raise exception '6c: confirm-separate answered %', row_to_json(answer);
  end if;
end $$;
select pg_temp.as_member(4, 'unknown-confirm-0003');
select identity.decide_unknown_patient(pg_temp.patient(3), 'confirm_separate', pg_temp.version(3),
  'Checked with the family', pg_temp.key('confirm-3b'), pg_temp.sha('confirm-3b'));
select pg_temp.as_member(1, 'unknown-confirm-desk');
do $$
begin
  if pg_temp.refusal(format('select identity.decide_unknown_patient(%L, %L, %s, %L, %L, %L)', pg_temp.patient(4), 'cancel',
       pg_temp.version(4), 'Made in error today', pg_temp.key('cancel-desk'), pg_temp.sha('cancel-desk')))
     <> '42501 UNKNOWN_PATIENT_DENIED' then
    raise exception '6d: the desk decided a record';
  end if;
end $$;
reset role;
do $$
begin
  if (select array[first_name, last_name, identity.patient_record_kind(id)] from identity.patients where id = pg_temp.patient(3))
       <> array['Ada', 'Obi', 'standard']
     or (select decision from identity.unknown_patients where patient_id = pg_temp.patient(3)) <> 'confirmed_separate' then
    raise exception '6e: the second approver''s decision was not applied';
  end if;
end $$;

-- 7. Cancel: record 4 has nothing attached; record 6 (facility O) gets a visit
-- (owner SQL as facility O's member under a direct-care grant, so its
-- record version has an actor and the records-processing guard does not apply).
select pg_temp.as_member(5, 'unknown-visit-fixture', '');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass, correlation_id) values
  ('f146a000-0000-4000-8000-000000000006', pg_temp.patient(6), 'f1463000-0000-4000-8000-000000000005',
   'f1462000-0000-4000-8000-000000000005', 'f1464000-0000-4000-8000-000000000005',
   'f1461000-0000-4000-8000-000000000002', 'write_records', 'direct-care', 'active', 'Unknown suite visit grant',
   now() - interval '1 minute', now() + interval '1 hour', false, 'unknown-visit-grant');
select set_config('app.purpose_of_use', 'direct-care', true);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
values ('f1468000-0000-4000-8000-000000000006', pg_temp.patient(6), 'f1461000-0000-4000-8000-000000000002',
  'f1462000-0000-4000-8000-000000000005', 'f1464000-0000-4000-8000-000000000005', 'ambulatory', 'in_progress', clock_timestamp());
set local role hid_identity_api_runtime;
select pg_temp.as_member(3, 'unknown-cancel-0001');
do $$
declare answer record; outcome text;
begin
  select * into answer from identity.decide_unknown_patient(pg_temp.patient(4), 'cancel', pg_temp.version(4),
    'Made in error today', pg_temp.key('cancel-4'), pg_temp.sha('cancel-4'));
  if answer.outcome <> 'cancelled' or answer.status <> 'cancelled' then raise exception '7a: cancel answered %', row_to_json(answer); end if;
  select * into answer from identity.decide_unknown_patient(pg_temp.patient(4), 'cancel', 1,
    'Made in error today', pg_temp.key('cancel-4'), pg_temp.sha('cancel-4'));
  if not answer.replayed then raise exception '7b: the cancel replay answered %', row_to_json(answer); end if;
  outcome := pg_temp.refusal(format('select identity.decide_unknown_patient(%L, %L, %s, %L, %L, %L)', pg_temp.patient(4),
    'cancel', pg_temp.version(4), 'Made in error today', pg_temp.key('cancel-4b'), pg_temp.sha('cancel-4b')));
  if outcome <> 'P0001 UNKNOWN_PATIENT_CANCELLED' then raise exception '7c: a second cancel answered %', outcome; end if;
  outcome := pg_temp.refusal(format('select identity.decide_unknown_patient(%L, %L, %s, %L, %L, %L)', pg_temp.patient(2),
    'cancel', pg_temp.version(2), 'Made in error today', pg_temp.key('cancel-2'), pg_temp.sha('cancel-2')));
  if outcome <> 'P0001 UNKNOWN_PATIENT_ALREADY_IDENTIFIED' then raise exception '7d: cancelling an identified record answered %', outcome; end if;
  if (select count(*) from identity.list_unknown_patients('open', 10, null, null)) <> 0
     or (select count(*) from identity.list_unknown_patients('all', 10, null, null)) <> 5 then
    raise exception '7e: the lists after cancel are wrong';
  end if;
end $$;
reset role;
-- Facility O's administrator is the desk member's colleague: give member 5 the approve role for this case.
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('f1465000-0000-4000-8000-000000000099', 'f1462000-0000-4000-8000-000000000005', 'admin', 'facility',
   'f1464000-0000-4000-8000-000000000005', 'f1461000-0000-4000-8000-000000000002', 'Unknown patient suite approver');
set local role hid_identity_api_runtime;
select pg_temp.as_member(5, 'unknown-cancel-0006');
do $$
begin
  if pg_temp.refusal(format('select identity.decide_unknown_patient(%L, %L, %s, %L, %L, %L)', pg_temp.patient(6), 'cancel',
       pg_temp.version(6), 'Made in error today', pg_temp.key('cancel-6'), pg_temp.sha('cancel-6')))
     <> 'P0001 UNKNOWN_PATIENT_HAS_RECORDS' then
    raise exception '7f: a record with a visit was cancelled';
  end if;
end $$;
reset role;
do $$
begin
  if (select status from identity.patients where id = pg_temp.patient(4)) <> 'inactive'
     or identity.own_facility_basis(pg_temp.patient(4), 'f1461000-0000-4000-8000-000000000001') is not null
     or (select status from identity.patients where id = pg_temp.patient(6)) <> 'active' then
    raise exception '7g: the cancelled record is wrong';
  end if;
  if exists (select 1 from audit.events where action like 'identity.unknown-patient.%'
              and (details::text like '%HID-%' or details::text like '%Ada%')) then
    raise exception '7h: an audit row holds a name or Health ID';
  end if;
end $$;

-- 7b. Record 8 at facility H has only an allergy (no visit): the cancel check
-- sees it through the marker-gated policy, and the tables' owner without the
-- marker still sees nothing.
set local role hid_identity_api_runtime;
select pg_temp.as_member(1, 'unknown-create-8');
select identity.create_unknown_patient(pg_temp.patient(8), 'HID-UNKAAB2', 'female', 25, 'confused', null, null,
  pg_temp.key('create-8'), pg_temp.sha('create-8'));
reset role;
select pg_temp.as_member(2, 'unknown-allergy-fixture', '');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id,
  scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass, correlation_id) values
  ('f146a000-0000-4000-8000-000000000008', pg_temp.patient(8), 'f1463000-0000-4000-8000-000000000002',
   'f1462000-0000-4000-8000-000000000002', 'f1464000-0000-4000-8000-000000000002',
   'f1461000-0000-4000-8000-000000000001', 'write_records', 'direct-care', 'active', 'Unknown suite allergy grant',
   now() - interval '1 minute', now() + interval '1 hour', false, 'unknown-allergy-grant');
select set_config('app.purpose_of_use', 'direct-care', true);
insert into ehr.recorded_allergies (id, patient_id, facility_id, created_by, created_by_membership_id, substance, severity,
  status)
values ('f146b000-0000-4000-8000-000000000008', pg_temp.patient(8), 'f1461000-0000-4000-8000-000000000001',
  'f1462000-0000-4000-8000-000000000002', 'f1464000-0000-4000-8000-000000000002', 'Penicillin', 'severe', 'active');
do $$
declare seen bigint;
begin
  perform set_config('app.actor_subject', '', true), set_config('app.membership_id', '', true),
    set_config('app.facility_id', '', true), set_config('app.purpose_of_use', '', true);
  execute format('set local role %I', (select pg_get_userbyid(relation.relowner) from pg_class relation
                                        where relation.oid = 'ehr.recorded_allergies'::regclass));
  select count(*) into seen from ehr.recorded_allergies where patient_id = pg_temp.patient(8);
  reset role;
  if seen <> 0 then raise exception '7i: the tables'' owner sees % allergies without the marker', seen; end if;
end $$;
set local role hid_identity_api_runtime;
select pg_temp.as_member(3, 'unknown-cancel-0008');
do $$
begin
  if pg_temp.refusal(format('select identity.decide_unknown_patient(%L, %L, %s, %L, %L, %L)', pg_temp.patient(8), 'cancel',
       pg_temp.version(8), 'Made in error today', pg_temp.key('cancel-8'), pg_temp.sha('cancel-8')))
     <> 'P0001 UNKNOWN_PATIENT_HAS_RECORDS' then
    raise exception '7j: a record with an allergy was cancelled';
  end if;
end $$;
reset role;
do $$
begin
  if exists (select 1 from ehr.unknown_patient_cancel_scans) then
    raise exception '7k: a cancel-check marker was left behind';
  end if;
end $$;

-- 8. The waiting list's record kinds, and the grants.
select set_config('app.purpose_of_use', '', true), set_config('app.actor_subject', '', true),
  set_config('app.membership_id', '', true), set_config('app.facility_id', '', true);
insert into ehr.visit_queue (id, facility_id, patient_id, queue_day, check_in_basis, checked_in_by_account_id,
  checked_in_by_membership_id, updated_by_membership_id, checked_in_at)
values ('f1469000-0000-4000-8000-000000000001', 'f1461000-0000-4000-8000-000000000001', pg_temp.patient(5),
  (clock_timestamp() at time zone 'Africa/Lagos')::date, 'own_facility', 'f1462000-0000-4000-8000-000000000002',
  'f1464000-0000-4000-8000-000000000002', 'f1464000-0000-4000-8000-000000000002', clock_timestamp()),
  ('f1469000-0000-4000-8000-000000000002', 'f1461000-0000-4000-8000-000000000002', pg_temp.patient(6),
  (clock_timestamp() at time zone 'Africa/Lagos')::date, 'own_facility', 'f1462000-0000-4000-8000-000000000005',
  'f1464000-0000-4000-8000-000000000005', 'f1464000-0000-4000-8000-000000000005', clock_timestamp());
set local role hid_ehr_api_runtime;
select pg_temp.as_member(2, 'unknown-queue-kinds', 'direct-care');
do $$
declare listed jsonb;
begin
  select jsonb_agg(jsonb_build_object('entry', kinds.entry_id, 'kind', kinds.record_kind, 'estimated', kinds.dob_estimated))
    into listed
    from ehr.visit_queue_record_kinds(array['f1469000-0000-4000-8000-000000000001',
                                            'f1469000-0000-4000-8000-000000000002']::uuid[]) kinds;
  if listed <> '[{"entry": "f1469000-0000-4000-8000-000000000001", "kind": "standard", "estimated": false}]'::jsonb then
    raise exception '8a: the record kinds were %', listed;
  end if;
end $$;
reset role;
do $$
begin
  if not has_function_privilege('hid_identity_api_runtime',
       'identity.create_unknown_patient(uuid,text,text,integer,text,bytea,text,text,text)', 'EXECUTE')
     or has_function_privilege('hid_ehr_api_runtime',
       'identity.create_unknown_patient(uuid,text,text,integer,text,bytea,text,text,text)', 'EXECUTE')
     or not has_function_privilege('hid_ehr_api_runtime', 'ehr.visit_queue_record_kinds(uuid[])', 'EXECUTE')
     or has_function_privilege('hid_identity_api_runtime', 'identity.unknown_patient_cards(uuid[])', 'EXECUTE')
     or has_table_privilege('hid_identity_api_runtime', 'identity.unknown_patients', 'SELECT') then
    raise exception '8b: the grants are wrong';
  end if;
end $$;

-- 9. Ola's review of #302 (each case names its item).
-- Fixtures: a second real standard patient, and a sealed QA patient.
select set_config('app.purpose_of_use', '', true), set_config('app.actor_subject', '', true),
  set_config('app.membership_id', '', true), set_config('app.facility_id', '', true);
insert into identity.patients (id, hid_code, first_name, last_name, full_name, dob, gender, status) values
  ('f1466000-0000-4000-8000-000000000002', 'HID-UNKSTD3', 'Bayo', 'Ade', 'Bayo Ade', date '1970-03-03', 'male', 'active'),
  ('f1466000-0000-4000-8000-000000000003', 'HID-UNKSTD4', 'Chidi', 'Eze', 'Chidi Eze', date '1975-04-04', 'male', 'active');
insert into identity.sealed_qa_members (member_kind, member_id) values ('patient', 'f1466000-0000-4000-8000-000000000003');
create function pg_temp.hmac(label text) returns text language sql as $f$ select repeat(label, 32); $f$;
grant execute on function pg_temp.hmac(text) to hid_identity_api_runtime;

-- 9a (items 5 and 8). Records 10 (male) and 11 (female) at H; identify
-- without a sex keeps the one recorded at creation; an identify replay is
-- audited.
set local role hid_identity_api_runtime;
select pg_temp.as_member(1, 'unknown-ola-9a');
do $$
declare answer record;
begin
  perform identity.create_unknown_patient(pg_temp.patient(10), 'HID-UNKACA', 'male', 60, 'unconscious', null, null,
    pg_temp.key('create-10'), pg_temp.sha('create-10'));
  perform identity.create_unknown_patient(pg_temp.patient(11), 'HID-UNKACB', 'female', 30, 'confused', null, null,
    pg_temp.key('create-11'), pg_temp.sha('create-11'));
  perform identity.create_unknown_patient(pg_temp.patient(12), 'HID-UNKACC', 'female', 30, 'confused', null, null,
    pg_temp.key('create-12'), pg_temp.sha('create-12'));
  select * into answer from identity.identify_unknown_patient(pg_temp.patient(10), pg_temp.version(10), 'Musa', 'Bala',
    date '1960-06-06', null, pg_temp.hmac('a2'), pg_temp.note(), pg_temp.note(), 'v1', pg_temp.key('identify-10'),
    pg_temp.sha('identify-10'));
  if answer.outcome <> 'identified' or answer.sex is distinct from 'male' then raise exception '9a: identify without a sex answered %', row_to_json(answer); end if;
  -- Ada Obi's details (the standard patient and records 1 and 3 now hold them): in review.
  select * into answer from identity.identify_unknown_patient(pg_temp.patient(11), pg_temp.version(11), 'Ada', 'Obi',
    date '1990-05-01', null, pg_temp.hmac('a3'), pg_temp.note(), pg_temp.note(), 'v1', pg_temp.key('identify-11'),
    pg_temp.sha('identify-11'));
  if answer.outcome <> 'sent_for_review' or answer.candidate_count <> 3 then
    raise exception '9a: identify of record 11 answered %', row_to_json(answer);
  end if;
end $$;
-- Record 12 is identified by approver 3, who then may not review it.
select pg_temp.as_member(3, 'unknown-ola-9a-3');
select identity.identify_unknown_patient(pg_temp.patient(12), pg_temp.version(12), 'Ada', 'Obi', date '1990-05-01',
  'female', pg_temp.hmac('b1'), pg_temp.note(), pg_temp.note(), 'v1', pg_temp.key('identify-12'), pg_temp.sha('identify-12'));

-- 9b (item 1). The approver's review: the held details and each candidate's
-- card, one audit row per candidate; refused to the desk, to the member who
-- identified, and for a record not in review.
select pg_temp.as_member(1, 'unknown-ola-9b-desk');
do $$
begin
  if pg_temp.refusal(format('select identity.review_unknown_patient(%L)', pg_temp.patient(11)))
     <> '42501 UNKNOWN_PATIENT_DENIED' then
    raise exception '9b: the desk read a review';
  end if;
end $$;
select pg_temp.as_member(3, 'unknown-ola-9b');
do $$
declare answer record;
begin
  select * into answer from identity.review_unknown_patient(pg_temp.patient(11));
  if answer.outcome <> 'found' or answer.proposed_first_name <> 'Ada' or answer.proposed_last_name <> 'Obi'
     or answer.proposed_date_of_birth <> date '1990-05-01' or answer.proposed_sex is not null
     or answer.status <> 'sent_for_review' or answer.label <> 'U-0008' or jsonb_array_length(answer.candidates) <> 3
     or answer.candidates -> 0 <> '{"position": 1, "fullName": "Ada Obi", "dateOfBirth": "1990-05-01", "sex": "female",
          "healthIdLast4": "STD2", "matchReasons": ["date_of_birth", "first_name", "last_name"], "active": true}'::jsonb
     or answer.candidates::text like '%f146%' or answer.candidates::text like '%HID-%' then
    raise exception '9b: the review answered %', row_to_json(answer);
  end if;
  select * into answer from identity.review_unknown_patient(pg_temp.patient(12));
  if answer.outcome <> 'second_person_required' or answer.candidates is not null then
    raise exception '9b: the identifier''s review answered %', row_to_json(answer);
  end if;
  select * into answer from identity.review_unknown_patient(pg_temp.patient(10));
  if answer.outcome <> 'not_in_review' then raise exception '9b: an identified record''s review answered %', row_to_json(answer); end if;
  select * into answer from identity.review_unknown_patient(pg_temp.patient(6));
  if answer.outcome <> 'not_found' then raise exception '9b: another facility''s review answered %', row_to_json(answer); end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from audit.events where action = 'identity.unknown-patient.review' and outcome = 'success'
       and patient_id = pg_temp.patient(11) and details ->> 'candidateCount' = '3') <> 1
     or (select array_agg(patient_id order by patient_id) from audit.events
          where action = 'identity.unknown-patient.review.shown' and details ->> 'unknownPatientId' = pg_temp.patient(11)::text)
        <> array['f1466000-0000-4000-8000-000000000001', pg_temp.patient(1), pg_temp.patient(3)]::uuid[]
     or (select count(*) from audit.events where action = 'identity.unknown-patient.review' and outcome = 'denied') <> 3
     or exists (select 1 from audit.events where action like 'identity.unknown-patient.review%'
                 and (details::text like '%Ada%' or details::text like '%1990%')) then
    raise exception '9b: the review audit rows are wrong';
  end if;
end $$;

-- 9c (item 5). Confirm-separate with no held sex keeps the recorded one.
set local role hid_identity_api_runtime;
select pg_temp.as_member(4, 'unknown-ola-9c');
select identity.decide_unknown_patient(pg_temp.patient(11), 'confirm_separate', pg_temp.version(11),
  'A different person: checked with the family', pg_temp.key('confirm-11'), pg_temp.sha('confirm-11'));
reset role;
do $$
begin
  if (select array[gender, full_name] from identity.patients where id = pg_temp.patient(11)) is distinct from array['female', 'Ada Obi']
     or (select gender from identity.patients where id = pg_temp.patient(10)) is distinct from 'male' then
    raise exception '9c: a sex not given erased the recorded one';
  end if;
end $$;

-- 9d (item 3). Seals: a QA identify never counts a real review queue, and a
-- real identify never counts a QA record in review. Record 12 (real, held as
-- Ada Obi) is in review; a real desk registration of Bayo Ade waits for review.
set local role hid_identity_api_runtime;
select pg_temp.as_member(1, 'unknown-ola-9d-desk');
do $$
declare answer record;
begin
  select * into answer from identity.register_patient_without_nin('f146c000-0000-4000-8000-000000000001', 'Bayo', 'Ade',
    date '1970-03-03', 'male', 'not_carried', pg_temp.hmac('a5'), pg_temp.note(), pg_temp.note(), 'v1', null,
    pg_temp.key('register-bayo'), pg_temp.sha('register-bayo'), 'HID-UNKACD');
  if answer.case_status <> 'review_required' then raise exception '9d: the real registration answered %', row_to_json(answer); end if;
end $$;
select pg_temp.as_member(6, 'unknown-ola-9d-qa');
do $$
declare answer record;
begin
  perform identity.create_unknown_patient(pg_temp.patient(13), 'HID-UNKACE', 'female', 30, 'confused', null, null,
    pg_temp.key('create-13'), pg_temp.sha('create-13'));
  perform identity.create_unknown_patient(pg_temp.patient(14), 'HID-UNKACF', 'male', 50, 'confused', null, null,
    pg_temp.key('create-14'), pg_temp.sha('create-14'));
  perform identity.create_unknown_patient(pg_temp.patient(15), 'HID-UNKACG', 'male', 50, 'confused', null, null,
    pg_temp.key('create-15'), pg_temp.sha('create-15'));
  select * into answer from identity.identify_unknown_patient(pg_temp.patient(13), pg_temp.version(13), 'Ada', 'Obi',
    date '1990-05-01', 'female', pg_temp.hmac('a4'), pg_temp.note(), pg_temp.note(), 'v1', pg_temp.key('identify-13'),
    pg_temp.sha('identify-13'));
  if answer.outcome <> 'identified' then raise exception '9d: a QA identify counted a real record in review: %', row_to_json(answer); end if;
  select * into answer from identity.identify_unknown_patient(pg_temp.patient(14), pg_temp.version(14), 'Bayo', 'Ade',
    date '1970-03-03', 'male', pg_temp.hmac('a8'), pg_temp.note(), pg_temp.note(), 'v1', pg_temp.key('identify-14'),
    pg_temp.sha('identify-14'));
  if answer.outcome <> 'identified' then raise exception '9d: a QA identify counted a real registration: %', row_to_json(answer); end if;
  -- A QA record in review (the QA patient Chidi Eze is its candidate).
  select * into answer from identity.identify_unknown_patient(pg_temp.patient(15), pg_temp.version(15), 'Chidi', 'Eze',
    date '1975-04-04', 'male', pg_temp.hmac('a6'), pg_temp.note(), pg_temp.note(), 'v1', pg_temp.key('identify-15'),
    pg_temp.sha('identify-15'));
  if answer.outcome <> 'sent_for_review' then raise exception '9d: the QA record in review answered %', row_to_json(answer); end if;
end $$;
select pg_temp.as_member(1, 'unknown-ola-9d-real');
do $$
declare answer record;
begin
  perform identity.create_unknown_patient(pg_temp.patient(16), 'HID-UNKACH', 'male', 50, 'confused', null, null,
    pg_temp.key('create-16'), pg_temp.sha('create-16'));
  select * into answer from identity.identify_unknown_patient(pg_temp.patient(16), pg_temp.version(16), 'Chidi', 'Eze',
    date '1975-04-04', 'male', pg_temp.hmac('a7'), pg_temp.note(), pg_temp.note(), 'v1', pg_temp.key('identify-16'),
    pg_temp.sha('identify-16'));
  if answer.outcome <> 'identified' then raise exception '9d: a real identify counted a QA record: %', row_to_json(answer); end if;
end $$;

-- 9e (items 2 and 7, and 8 for 0130). ID-2's rule reads an identified
-- record's held phone and a record in review's held details, never a QA
-- record's; a stated Health ID of this facility's unknown record is refused,
-- and at another facility it is not a candidate but sends the case to an
-- approver (a QA facility's record never counts); a replay is audited.
do $$
declare answer record;
begin
  -- Record 10's held phone, with another name and date of birth.
  select * into answer from identity.register_patient_without_nin('f146c000-0000-4000-8000-000000000002', 'Musa', 'Belo',
    date '1961-01-01', 'male', 'not_carried', pg_temp.hmac('a2'), pg_temp.note(), pg_temp.note(), 'v1', null,
    pg_temp.key('register-musa'), pg_temp.sha('register-musa'), 'HID-UNKADA');
  if answer.case_status <> 'review_required' or answer.candidate_count <> 1 then
    raise exception '9e: the held phone was not a candidate: %', row_to_json(answer);
  end if;
  select * into answer from identity.register_patient_without_nin('f146c000-0000-4000-8000-000000000002', 'Musa', 'Belo',
    date '1961-01-01', 'male', 'not_carried', pg_temp.hmac('a2'), pg_temp.note(), pg_temp.note(), 'v1', null,
    pg_temp.key('register-musa'), pg_temp.sha('register-musa'), 'HID-UNKADA');
  if not answer.replayed then raise exception '9e: the replay answered %', row_to_json(answer); end if;
  -- Record 12's held phone (in review): an open registration, no candidate.
  select * into answer from identity.register_patient_without_nin('f146c000-0000-4000-8000-000000000003', 'Ngozi', 'Uche',
    date '1955-05-05', 'female', 'not_carried', pg_temp.hmac('b1'), pg_temp.note(), pg_temp.note(), 'v1', null,
    pg_temp.key('register-ngozi'), pg_temp.sha('register-ngozi'), 'HID-UNKADB');
  if answer.case_status <> 'review_required' or answer.candidate_count <> 0 then
    raise exception '9e: the record in review was not counted: %', row_to_json(answer);
  end if;
  -- The QA record in review's held phone: not counted here.
  select * into answer from identity.register_patient_without_nin('f146c000-0000-4000-8000-000000000004', 'Femi', 'Ola',
    date '1966-06-06', 'male', 'not_carried', pg_temp.hmac('a6'), pg_temp.note(), pg_temp.note(), 'v1', null,
    pg_temp.key('register-femi'), pg_temp.sha('register-femi'), 'HID-UNKADC');
  if answer.case_status <> 'approved_new_identity' then
    raise exception '9e: a QA record in review was counted: %', row_to_json(answer);
  end if;
  -- Record 8 is still unknown, at H.
  if pg_temp.refusal(format('select identity.register_patient_without_nin(%L, %L, %L, %L, %L, %L, %L, %L::bytea, %L::bytea, %L, %L, %L, %L, %L)',
       'f146c000-0000-4000-8000-000000000005', 'Joy', 'Eke', '1999-09-09', 'female', 'not_carried', pg_temp.hmac('b2'),
       pg_temp.note(), pg_temp.note(), 'v1', 'HID-UNKAAB2', pg_temp.key('register-joy'), pg_temp.sha('register-joy'),
       'HID-UNKADD')) <> 'P0001 PATIENT_RECORD_UNKNOWN' then
    raise exception '9e: a stated Health ID of this facility''s unknown record was registered';
  end if;
end $$;
select pg_temp.as_member(5, 'unknown-ola-9e-other');
do $$
declare answer record;
begin
  -- Record 8 is still unknown at H: here at O it is no candidate (O can
  -- neither identify nor link it), but the case goes to an approver (Ola's
  -- round 3, item 3).
  select * into answer from identity.register_patient_without_nin('f146c000-0000-4000-8000-000000000006', 'Sade', 'Lawal',
    date '1977-07-07', 'female', 'not_carried', pg_temp.hmac('b4'), pg_temp.note(), pg_temp.note(), 'v1', 'HID-UNKAAB2',
    pg_temp.key('register-sade'), pg_temp.sha('register-sade'), 'HID-UNKADE');
  if answer.case_status <> 'review_required' or answer.candidate_count <> 0 or answer.subject_patient_id is not null then
    raise exception '9e: another facility''s stated Health ID of an unknown record answered %', row_to_json(answer);
  end if;
  -- The QA facility's unknown record (record 7) never counts at a real facility.
  select * into answer from identity.register_patient_without_nin('f146c000-0000-4000-8000-000000000017', 'Tobi', 'Ade',
    date '1978-08-08', 'male', 'not_carried', pg_temp.hmac('b5'), pg_temp.note(), pg_temp.note(), 'v1', 'HID-UNKAAA8',
    pg_temp.key('register-tobi'), pg_temp.sha('register-tobi'), 'HID-UNKAEZ');
  if answer.case_status <> 'approved_new_identity' or answer.candidate_count <> 0 then
    raise exception '9e: the QA facility''s unknown record counted at a real facility: %', row_to_json(answer);
  end if;
end $$;
reset role;
do $$
begin
  if exists (select 1 from identity.registration_case_candidates where case_id = 'f146c000-0000-4000-8000-000000000006')
     or not exists (select 1 from audit.events where action = 'identity.registration.without-nin'
                     and resource_id = 'f146c000-0000-4000-8000-000000000006' and patient_id is null
                     and details -> 'duplicateKinds' = '["stated_health_id"]'::jsonb
                     and details ->> 'statedUnknownRecordPatientId' = pg_temp.patient(8)::text
                     and (details -> 'candidatePatientIds') = '[]'::jsonb)
     or not exists (select 1 from identity.registration_case_events
                     where case_id = 'f146c000-0000-4000-8000-000000000006' and event_type = 'review_required'
                       and details @> '{"statedUnknownRecord": true, "duplicateKinds": ["stated_health_id"]}')
     or exists (select 1 from audit.events where action = 'identity.registration.without-nin'
                 and resource_id = 'f146c000-0000-4000-8000-000000000017' and details ? 'statedUnknownRecordPatientId') then
    raise exception '9e: the review of another facility''s stated unknown record is not recorded as intended';
  end if;
end $$;
do $$
begin
  if not exists (select 1 from identity.registration_case_candidates
                  where case_id = 'f146c000-0000-4000-8000-000000000002' and patient_id = pg_temp.patient(10)
                    and match_reasons = '["phone"]'::jsonb)
     or (select count(*) from audit.events where action = 'identity.registration.without-nin'
          and resource_id = 'f146c000-0000-4000-8000-000000000002' and details @> '{"replayed": true}') <> 1
     or not exists (select 1 from audit.events where action = 'identity.registration.without-nin'
                     and resource_id = 'f146c000-0000-4000-8000-000000000003'
                     and details -> 'duplicateKinds' = '["open_registration"]'::jsonb) then
    raise exception '9e: the registrations are wrong';
  end if;
end $$;

-- 9f (item 7). A registration case never resolves to a record that is still
-- unknown, whichever path writes it: here an approver's link to record 8,
-- made a candidate by hand.
insert into identity.registration_case_candidates (case_id, patient_id, match_score, match_reasons)
values ('f146c000-0000-4000-8000-000000000002', pg_temp.patient(8), 80, '["phone"]');
set local role hid_identity_api_runtime;
select pg_temp.as_member(3, 'unknown-ola-9f');
do $$
begin
  if pg_temp.refusal(format('select identity.review_patient_without_nin(%L, 1, %L, %L, %L, %L, %L, null)',
       'f146c000-0000-4000-8000-000000000002', 'link_existing', pg_temp.patient(8), 'The same person, by phone',
       pg_temp.key('link-8'), pg_temp.sha('link-8'))) <> 'P0001 PATIENT_RECORD_UNKNOWN' then
    raise exception '9f: a registration was linked to an unknown record';
  end if;
end $$;
reset role;
do $$
begin
  begin
    update identity.patients set account_id = 'f1462000-0000-4000-8000-000000000008' where id = pg_temp.patient(10);
  exception when others then
    raise exception '9f: an identified record could not get a login: %', sqlerrm;
  end;
end $$;

-- 9g (items 2 and 6). Cancel closes the waiting-list entry and nulls the
-- held details and contact; an erasure erases an identified record's held
-- contact.
set local role hid_identity_api_runtime;
select pg_temp.as_member(1, 'unknown-ola-9g');
select identity.create_unknown_patient(pg_temp.patient(17), 'HID-UNKAEA', 'female', 30, 'confused', null, null,
  pg_temp.key('create-17'), pg_temp.sha('create-17'));
select identity.identify_unknown_patient(pg_temp.patient(17), pg_temp.version(17), 'Ada', 'Obi', date '1990-05-01',
  'female', pg_temp.hmac('b3'), pg_temp.note(), pg_temp.note(), 'v1', pg_temp.key('identify-17'), pg_temp.sha('identify-17'));
reset role;
select set_config('app.purpose_of_use', '', true), set_config('app.actor_subject', '', true),
  set_config('app.membership_id', '', true), set_config('app.facility_id', '', true);
insert into ehr.visit_queue (id, facility_id, patient_id, queue_day, check_in_basis, checked_in_by_account_id,
  checked_in_by_membership_id, updated_by_membership_id, checked_in_at)
values ('f1469000-0000-4000-8000-000000000017', 'f1461000-0000-4000-8000-000000000001', pg_temp.patient(17),
  (clock_timestamp() at time zone 'Africa/Lagos')::date, 'own_facility', 'f1462000-0000-4000-8000-000000000002',
  'f1464000-0000-4000-8000-000000000002', 'f1464000-0000-4000-8000-000000000002', clock_timestamp());
set local role hid_identity_api_runtime;
select pg_temp.as_member(3, 'unknown-ola-9g-cancel');
select identity.decide_unknown_patient(pg_temp.patient(17), 'cancel', pg_temp.version(17), 'Made in error today',
  pg_temp.key('cancel-17'), pg_temp.sha('cancel-17'));
reset role;
do $$
declare erased record;
begin
  if (select array[stage, (closed_at is not null)::text] from ehr.visit_queue
       where id = 'f1469000-0000-4000-8000-000000000017') <> array['cancelled', 'true']
     or not exists (select 1 from audit.events where action = 'ehr.visit-queue.update'
                     and resource_id = 'f1469000-0000-4000-8000-000000000017'
                     and details @> '{"stage": "cancelled", "closedBy": "identity.unknown-patient.cancel"}')
     or not exists (select 1 from audit.events where action = 'identity.unknown-patient.cancel'
                     and patient_id = pg_temp.patient(17) and details @> '{"waitingListEntriesClosed": 1}')
     or exists (select 1 from identity.unknown_patients where patient_id = pg_temp.patient(17)
                 and (proposed_first_name is not null or proposed_last_name is not null or proposed_dob is not null
                      or proposed_gender is not null or contact_phone_ciphertext is not null
                      or contact_phone_lookup_hmac is not null))
     or (select count(*) from audit.events where action = 'identity.unknown-patient.cancel'
          and patient_id = pg_temp.patient(4) and details @> '{"replayed": true}') <> 1 then
    raise exception '9g: the cancel did not close the entry or null the held details';
  end if;
  select * into erased from identity.erase_patient_facility_contacts(pg_temp.patient(10), 'erasure_request');
  if exists (select 1 from identity.unknown_patients where patient_id = pg_temp.patient(10)
              and (contact_phone_ciphertext is not null or contact_address_ciphertext is not null
                   or contact_key_version is not null or contact_phone_lookup_hmac is not null))
     or not exists (select 1 from audit.events where action = 'identity.patient-facility-contact.erase'
                     and patient_id = pg_temp.patient(10) and details @> '{"unknownRecordContacts": 1}') then
    raise exception '9g: the erasure left the held contact';
  end if;
end $$;
-- The desk's identify of record 17, retried with its key and body after
-- the cancel, is refused as a fresh identify is (Ola's round 3, item 4).
set local role hid_identity_api_runtime;
select pg_temp.as_member(1, 'unknown-ola-9g-replay');
do $$
begin
  if pg_temp.refusal(format('select identity.identify_unknown_patient(%L, %s, %L, %L, %L, %L, %L, %L::bytea, %L::bytea, %L, %L, %L)',
       pg_temp.patient(17), pg_temp.version(17), 'Ada', 'Obi', '1990-05-01', 'female', pg_temp.hmac('b3'),
       pg_temp.note(), pg_temp.note(), 'v1', pg_temp.key('identify-17'), pg_temp.sha('identify-17')))
     <> 'P0001 UNKNOWN_PATIENT_CANCELLED' then
    raise exception '9g: an identify replayed after the cancel was answered';
  end if;
end $$;
reset role;
-- After the erasure, the same phone is no longer a candidate.
set local role hid_identity_api_runtime;
select pg_temp.as_member(1, 'unknown-ola-9g-after');
do $$
declare answer record;
begin
  select * into answer from identity.register_patient_without_nin('f146c000-0000-4000-8000-000000000007', 'Musa', 'Belo',
    date '1961-01-01', 'male', 'not_carried', pg_temp.hmac('a2'), pg_temp.note(), pg_temp.note(), 'v1', null,
    pg_temp.key('register-musa-2'), pg_temp.sha('register-musa-2'), 'HID-UNKADF');
  -- The first Musa Belo registration, still in review, is an open registration; record 10 is no candidate.
  if answer.case_status <> 'review_required' or answer.candidate_count <> 0 then
    raise exception '9g: after the erasure the registration answered %', row_to_json(answer);
  end if;
end $$;
reset role;
do $$
begin
  if exists (select 1 from identity.registration_case_candidates
              where case_id = 'f146c000-0000-4000-8000-000000000007' and patient_id = pg_temp.patient(10)) then
    raise exception '9g: an erased held phone was still a candidate';
  end if;
end $$;

rollback;
