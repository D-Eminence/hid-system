-- Outreach screening (owner, 2026-11-13: "i need the outreach to be able to
-- take more information ... whatever it takes to make this thing ready"),
-- for the AccessCare Medical Outreach of 14 November 2026: consultation, free
-- tests (blood pressure, blood sugar, malaria), medicines given, hearing
-- checks and health education. The number 0118 is a placeholder: it releases
-- right after 0117, ahead of the other queued migrations, which are renumbered
-- after it.
--
-- WHAT IT DOES
--   1. outreach.registration_screenings: one screening per registration case,
--      every field optional, replaced as a whole on each save (version + 1):
--      blood pressure, pulse, temperature, weight, height, blood glucose (value,
--      unit, fasting or random), malaria rapid test, hearing (each ear), main
--      complaint, seen by a clinician (and their name or role), outcome or
--      advice, medicines given (up to 10: name and dose), referral (and to
--      where), who recorded it and when. Plausible-range checks refuse typos.
--      - Row-level security as the registration's: forced; a staff session
--        with outreach.registration.read / .write at the case's facility, and
--        only for a case that session can see (so a campaign's members only,
--        0045). No delete except by a retention or support redaction.
--      - outreach.validate_registration_screening (trigger): the case exists
--        at the same facility and is not redacted (55000
--        OUTREACH_REGISTRATION_REDACTED); the session's own account and
--        membership record it; an insert is version 1, an update the next
--        version, and the case, facility and first recording never change;
--        medicines are a list of up to 10 {name 1-100, dose up to 200}.
--      - The idempotency of a save is kept on the row itself (the last
--        Idempotency-Key and request digest), so outreach.command_idempotency
--        is not changed.
--      - Redaction: when a registration is redacted (0116: the retention
--        sweep, or support), its screening row is deleted in the same
--        transaction (trigger on the case's redaction update).
--   2. outreach.registration_cases.area: optional area, town or LGA (1-100
--      characters), set at registration, never changed, cleared when the
--      registration is redacted.
--   3. The outreach-group tenant rule capping a registration's notes at 280
--      characters now caps them at 1000 (0115's
--      outreach.enforce_organiser_tenant_rules, one line).
--   4. The organiser terms: 2026-11-14 is accepted beside 2026-11-01 (the live
--      website sends 2026-11-01 until the new one ships), in 0115's two
--      activation commands (one line each). The registration notice version is
--      not pinned in the database (0115 checks its form only), so
--      outreach-notice-2026-11-14 needs no change here.
--   Lines 3 and 4 are replaced inside the live bodies, md5-pinned before
--   and after.
--
-- Audit: outreach-api writes one audit row per screening read and save (ids
-- only; no values). Locks: ACCESS EXCLUSIVE (NOWAIT, bounded at 5 seconds,
-- else 55P03) on outreach.registration_cases for the new column and triggers.

-- 0. Preconditions.
do $$
declare
  mismatch text;
begin
  if to_regclass('outreach.registration_cases') is null or to_regclass('outreach.registration_redactions') is null
     or to_regprocedure('outreach.context_allows(uuid,text)') is null
     or to_regprocedure('outreach.privileged_run_active(text)') is null then
    raise exception using errcode = '55000', message = '0118: a prerequisite object is missing (0024, 0115, 0116)';
  end if;
  if to_regclass('outreach.registration_screenings') is not null
     or exists (select 1 from pg_attribute where attrelid = 'outreach.registration_cases'::regclass
                 and attname = 'area' and not attisdropped) then
    raise exception using errcode = '55000', message = '0118: already applied';
  end if;
  select string_agg(expected.signature, ', ') into mismatch
    from (values
      ('outreach.enforce_organiser_tenant_rules()', 'dd9592a1c4d59be2a472dddff0cb8e65'),
      ('identity.activate_outreach_organiser(uuid,character,text,text)', '1dcc38c73d81f08f0bbeecc30831f987'),
      ('identity.activate_outreach_organiser_for_account(text,text,text,text,character,bytea,text)',
       '65c91c427cc775e1b0ef89a7baf40dab')) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0118: these bodies are not 0115''s: ' || mismatch;
  end if;
end
$$;

-- 1. The screening.
create table outreach.registration_screenings (
  registration_case_id uuid primary key,
  facility_id uuid not null,
  bp_systolic smallint check (bp_systolic between 50 and 300),
  bp_diastolic smallint check (bp_diastolic between 20 and 200),
  pulse_bpm smallint check (pulse_bpm between 20 and 250),
  temperature_c numeric(3,1) check (temperature_c between 30.0 and 45.0),
  weight_kg numeric(4,1) check (weight_kg between 0.5 and 400.0),
  height_cm smallint check (height_cm between 30 and 250),
  glucose_value numeric(4,1),
  glucose_unit text check (glucose_unit in ('mmol/L', 'mg/dL')),
  glucose_timing text check (glucose_timing in ('fasting', 'random')),
  malaria_rdt text check (malaria_rdt in ('positive', 'negative', 'not_done')),
  hearing_left text check (hearing_left in ('pass', 'refer', 'not_done')),
  hearing_right text check (hearing_right in ('pass', 'refer', 'not_done')),
  main_complaint text check (length(btrim(main_complaint)) between 1 and 200),
  seen_by_clinician boolean,
  clinician_name text check (length(btrim(clinician_name)) between 1 and 100),
  outcome text check (length(btrim(outcome)) between 1 and 500),
  medicines_given jsonb not null default '[]'::jsonb
    check (jsonb_typeof(medicines_given) = 'array' and jsonb_array_length(medicines_given) <= 10),
  referred boolean,
  referred_to text check (length(btrim(referred_to)) between 1 and 200),
  version integer not null check (version > 0),
  recorded_at timestamptz not null default clock_timestamp(),
  recorded_by_account_id uuid not null,
  recorded_by_membership_id uuid not null,
  updated_at timestamptz not null default clock_timestamp(),
  updated_by_account_id uuid not null,
  updated_by_membership_id uuid not null,
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  constraint registration_screenings_case_fk foreign key (registration_case_id)
    references outreach.registration_cases(id) on delete restrict,
  constraint registration_screenings_bp_ck check ((bp_systolic is null) = (bp_diastolic is null)
    and (bp_systolic is null or bp_diastolic < bp_systolic)),
  constraint registration_screenings_glucose_ck check (
    (glucose_value is null) = (glucose_unit is null) and (glucose_value is null) = (glucose_timing is null)
    and (glucose_value is null
         or (glucose_unit = 'mmol/L' and glucose_value between 1.0 and 40.0)
         or (glucose_unit = 'mg/dL' and glucose_value between 18.0 and 720.0))),
  constraint registration_screenings_referral_ck check (referred_to is null or referred is true)
);

comment on table outreach.registration_screenings is
  '0118: the screening of an outreach registration (vital signs, blood glucose, malaria rapid test, hearing, complaint, clinician, outcome, medicines given, referral), all optional, replaced as a whole on each save (version). Row-level security as the registration''s; deleted when the registration is redacted.';

create function outreach.validate_registration_screening()
returns trigger language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
  actor_membership uuid := platform.current_membership_id();
  case_facility uuid;
  item jsonb;
begin
  if tg_op = 'DELETE' then
    if not outreach.privileged_run_active('retention') then
      raise exception using errcode = '55000', message = 'OUTREACH_SCREENING_IMMUTABLE';
    end if;
    return old;
  end if;
  select case_row.facility_id into case_facility
    from outreach.registration_cases case_row where case_row.id = new.registration_case_id;
  if case_facility is null or case_facility is distinct from new.facility_id
     or new.facility_id is distinct from platform.current_facility_id() then
    raise exception using errcode = '23514', message = 'OUTREACH_REGISTRATION_NOT_FOUND';
  end if;
  if exists (select 1 from outreach.registration_redactions redaction
              where redaction.registration_case_id = new.registration_case_id) then
    raise exception using errcode = '55000', message = 'OUTREACH_REGISTRATION_REDACTED';
  end if;
  if actor_account is null or actor_membership is null
     or new.updated_by_account_id is distinct from actor_account
     or new.updated_by_membership_id is distinct from actor_membership then
    raise exception using errcode = '42501', message = 'OUTREACH_SCREENING_ACTOR_MISMATCH';
  end if;
  for item in select value from jsonb_array_elements(new.medicines_given) loop
    if jsonb_typeof(item) is distinct from 'object'
       or exists (select 1 from jsonb_object_keys(item) item_key where item_key not in ('name', 'dose'))
       or jsonb_typeof(item -> 'name') is distinct from 'string'
       or length(btrim(item ->> 'name')) not between 1 and 100
       or (item ? 'dose' and jsonb_typeof(item -> 'dose') not in ('string', 'null'))
       or length(coalesce(item ->> 'dose', '')) > 200 then
      raise exception using errcode = '23514', message = 'OUTREACH_SCREENING_MEDICINES_INVALID';
    end if;
  end loop;
  if tg_op = 'INSERT' then
    if new.version is distinct from 1
       or new.recorded_by_account_id is distinct from actor_account
       or new.recorded_by_membership_id is distinct from actor_membership then
      raise exception using errcode = '23514', message = 'OUTREACH_SCREENING_VERSION_INVALID';
    end if;
    new.recorded_at := clock_timestamp();
    new.updated_at := new.recorded_at;
    return new;
  end if;
  if new.version is distinct from old.version + 1
     or new.registration_case_id is distinct from old.registration_case_id
     or new.facility_id is distinct from old.facility_id
     or new.recorded_at is distinct from old.recorded_at
     or new.recorded_by_account_id is distinct from old.recorded_by_account_id
     or new.recorded_by_membership_id is distinct from old.recorded_by_membership_id then
    raise exception using errcode = '23514', message = 'OUTREACH_SCREENING_VERSION_INVALID';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end
$$;

create trigger registration_screenings_validate
  before insert or update or delete on outreach.registration_screenings
  for each row execute function outreach.validate_registration_screening();

alter table outreach.registration_screenings enable row level security;
alter table outreach.registration_screenings force row level security;

-- 2. The registration's area, and the screening's redaction.
do $$
declare
  attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      lock table outreach.registration_cases in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 500 then
        raise exception using errcode = '55P03',
          message = '0118: outreach.registration_cases stayed busy for 5 seconds; run the release again later';
      end if;
      perform pg_sleep(0.01);
    end;
  end loop;
end
$$;

alter table outreach.registration_cases add column area text
  constraint registration_cases_area_ck check (length(btrim(area)) between 1 and 100);

comment on column outreach.registration_cases.area is
  '0118: the person''s area, town or LGA as given at registration (optional); never changed; cleared when the registration is redacted.';

-- The area never changes, except that a redaction (full name set to
-- '[redacted]') clears it.
create function outreach.registration_case_area_guard()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.full_name = '[redacted]' and old.full_name is distinct from '[redacted]' then
    new.area := null;
  elsif new.area is distinct from old.area then
    raise exception using errcode = '23514', message = 'OUTREACH_REGISTRATION_AREA_IMMUTABLE';
  end if;
  return new;
end
$$;

create trigger outreach_registration_area_guard
  before update on outreach.registration_cases
  for each row execute function outreach.registration_case_area_guard();

-- A redacted registration's screening is deleted in the same transaction.
create function outreach.registration_case_screening_redact()
returns trigger language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.full_name = '[redacted]' and old.full_name is distinct from '[redacted]' then
    delete from outreach.registration_screenings screening where screening.registration_case_id = new.id;
  end if;
  return null;
end
$$;

create trigger outreach_registration_screening_redact
  after update of full_name on outreach.registration_cases
  for each row execute function outreach.registration_case_screening_redact();

-- 3. The notes cap at an outreach group: 280 to 1000 characters.
-- 4. The organiser terms: 2026-11-14 beside 2026-11-01.
do $$
declare
  item record;
  definition text;
begin
  for item in select * from (values
      ('outreach.enforce_organiser_tenant_rules()',
       'length(new.operational_notes) > 280', 'length(new.operational_notes) > 1000'),
      ('identity.activate_outreach_organiser(uuid,character,text,text)',
       'requested_terms_version is distinct from identity.outreach_organiser_terms_version()',
       'requested_terms_version is null or requested_terms_version not in (''2026-11-01'', ''2026-11-14'')'),
      ('identity.activate_outreach_organiser_for_account(text,text,text,text,character,bytea,text)',
       'requested_terms_version is distinct from identity.outreach_organiser_terms_version()',
       'requested_terms_version is null or requested_terms_version not in (''2026-11-01'', ''2026-11-14'')'))
      changes(signature, old_text, new_text) loop
    definition := pg_get_functiondef(to_regprocedure(item.signature));
    if (length(definition) - length(replace(definition, item.old_text, ''))) / length(item.old_text) <> 1 then
      raise exception using errcode = '55000', message = '0118: the text to replace is not in ' || item.signature;
    end if;
    execute replace(definition, item.old_text, item.new_text);
  end loop;
end
$$;

comment on function identity.outreach_organiser_terms_version() is
  '0115: the organiser terms version of 2026-11-01. Since 0118 the activation commands accept 2026-11-01 and 2026-11-14.';

-- 5. Owners, policies, ACLs.
do $$
declare
  outreach_owner name := (select pg_get_userbyid(relowner) from pg_class where oid = 'outreach.campaigns'::regclass);
begin
  if outreach_owner <> current_user then
    execute format('alter table outreach.registration_screenings owner to %I', outreach_owner);
    execute format('alter function outreach.validate_registration_screening() owner to %I', outreach_owner);
    execute format('alter function outreach.registration_case_area_guard() owner to %I', outreach_owner);
    execute format('alter function outreach.registration_case_screening_redact() owner to %I', outreach_owner);
  end if;
  -- A redaction (a retention run: the sweep or support) deletes as the owner.
  execute format('create policy registration_screenings_redact on outreach.registration_screenings for delete to %I '
    || 'using (outreach.privileged_run_active(''retention''))', outreach_owner);
  -- A delete reads the rows it deletes, so the redaction also reads them (in a
  -- retention run only).
  execute format('create policy registration_screenings_redact_read on outreach.registration_screenings for select '
    || 'to %I using (outreach.privileged_run_active(''retention''))', outreach_owner);
end
$$;

create policy registration_screenings_read on outreach.registration_screenings for select
  using (outreach.context_allows(facility_id, 'outreach.registration.read'));
create policy registration_screenings_insert on outreach.registration_screenings for insert
  with check (outreach.context_allows(facility_id, 'outreach.registration.write'));
create policy registration_screenings_update on outreach.registration_screenings for update
  using (outreach.context_allows(facility_id, 'outreach.registration.write'))
  with check (outreach.context_allows(facility_id, 'outreach.registration.write'));
-- Only for a case the session can see (the case's own policies: its facility,
-- and a campaign's members only).
create policy registration_screenings_case_visible on outreach.registration_screenings as restrictive for all
  using (outreach.privileged_run_active('retention')
         or exists (select 1 from outreach.registration_cases case_row
                     where case_row.id = registration_screenings.registration_case_id))
  with check (exists (select 1 from outreach.registration_cases case_row
                       where case_row.id = registration_screenings.registration_case_id));

revoke all on outreach.registration_screenings from public;
revoke all on function outreach.validate_registration_screening(), outreach.registration_case_area_guard(),
  outreach.registration_case_screening_redact() from public;

-- Grants (here and in runtime-grants.sql).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_outreach_runtime') then
    grant select, insert, update on outreach.registration_screenings to hid_outreach_runtime;
  end if;
end
$$;

-- 6. Post-checks.
do $$
begin
  if (select md5(prosrc) from pg_proc where oid = 'outreach.enforce_organiser_tenant_rules()'::regprocedure)
       is not distinct from 'dd9592a1c4d59be2a472dddff0cb8e65'
     or (select prosrc from pg_proc where oid = 'outreach.enforce_organiser_tenant_rules()'::regprocedure)
          not like '%length(new.operational_notes) > 1000%'
     or (select count(*) from pg_proc
          where oid in ('identity.activate_outreach_organiser(uuid,character,text,text)'::regprocedure,
                        'identity.activate_outreach_organiser_for_account(text,text,text,text,character,bytea,text)'::regprocedure)
            and prosrc like '%not in (''2026-11-01'', ''2026-11-14'')%'
            and prosrc not like '%is distinct from identity.outreach_organiser_terms_version()%') <> 2 then
    raise exception using errcode = '55000', message = '0118: a replaced body is not as written';
  end if;
  if exists (select 1 from pg_roles role_row
              where role_row.rolname like 'hid\_%'
                and role_row.oid <> (select relowner from pg_class where oid = 'outreach.registration_screenings'::regclass)
                and has_table_privilege(role_row.oid, 'outreach.registration_screenings', 'DELETE')) then
    raise exception using errcode = '55000', message = '0118: a runtime role may delete a screening';
  end if;
end
$$;
