-- 0151 Recent diagnoses (ORD-9 of the Akos EHR plan, lane D, second
-- slice, first part). The planned contract's section "ORD-9: Diagnosis
-- search on ICD-11, recent diagnoses, and diagnoses by name only",
-- "Recent diagnoses"; the sizing note on hid-system#258 (Ola, 23 November
-- 2026, 14:18 UTC) splits it from the name-only part. Written on 0150
-- (#320). The number is provisional, given in merge order; no migration
-- number appears inside a function body. This file requires 0001-0137,
-- 0149 and 0150 applied. The declaration is signed separately.
--
-- THE GAP. A clinician who records the same few diagnoses all day has to
-- search for each one again.
--
-- WHAT IT DOES
-- 1. ehr.clinician_recent_diagnoses: a member's own last picks at the
--    facility of their membership: the code system, code and display as
--    they saved them, when last used and how often. It holds no patient
--    id, so it stays usable after a grant ends and shows no patient. At
--    most 200 per membership; the oldest drop off. Row-level security is
--    on with no policy and no grant: only the two functions below, as
--    the table's owner, read or write it.
-- 2. ehr.record_recent_diagnosis(code system, code, display) (SECURITY
--    DEFINER): called by ehr-api in the same transaction as each diagnosis
--    the member saves (DiagnosesService.createInTransaction, the route's
--    and EHR-C5's consultation's), inside a savepoint, so it never fails
--    the save. It reads the session's actor, membership and facility
--    (app.actor_subject, app.membership_id, app.facility_id, as ehr-api
--    sets them) and records only for a membership holding
--    ehr.diagnosis.write at that facility (auth.membership_has_permission);
--    otherwise, or with no code, it records nothing. A pick already listed
--    has its display, time and count updated.
-- 3. ehr.recent_diagnoses(limit) (SECURITY DEFINER, STABLE): the session's
--    membership's picks at its facility, newest first, at most limit
--    (1-50); none for a membership without ehr.diagnosis.write. 22023
--    RECENT_DIAGNOSES_INVALID for a limit outside 1-50.
-- 4. Grants: EXECUTE on 2 and 3 to hid_ehr_runtime and
--    hid_schema_test_runtime only (and in runtime-grants.sql).
--
-- Locks: the new table and functions only; no foreign key, so no existing
-- relation is locked. Busy refusals: none; the preconditions' refusals
-- start with "0151: ".
--
-- Old services on this schema: nothing calls the functions. New services
-- on a schema without this file: the record call fails inside its
-- savepoint (42883) and the diagnosis saves as before; the recent route
-- answers 503 CATALOG_UNAVAILABLE.
--
-- Undo (by hand only): drop the two functions, then the table.
--
-- 0. Preconditions. 1-4. As above. 5. Post-checks.

-- 0. Preconditions (catalog reads only; 55000 and nothing applied).
do $$
begin
  if to_regclass('ehr.catalog_diagnoses') is null or to_regclass('ehr.diagnoses') is null then
    raise exception using errcode = '55000', message = '0151: 0001-0137, 0149 and 0150 must be applied first';
  end if;
  if to_regclass('ehr.clinician_recent_diagnoses') is not null
     or to_regprocedure('ehr.record_recent_diagnosis(text,text,text)') is not null
     or to_regprocedure('ehr.recent_diagnoses(integer)') is not null then
    raise exception using errcode = '55000', message = '0151: already applied';
  end if;
  if (select md5(proc.prosrc) from pg_proc proc
       where proc.oid = to_regprocedure('auth.membership_has_permission(text,uuid,uuid,text)'))
     is distinct from '65e3eaff93fe729fd5c5b986b80c9dd6' then
    raise exception using errcode = '55000', message = '0151: auth.membership_has_permission is not as 0001-0137 left it';
  end if;
end
$$;

-- 1. The table.
create table ehr.clinician_recent_diagnoses (
  membership_id uuid not null,
  facility_id uuid not null,
  code_system text not null check (length(btrim(code_system)) between 1 and 255),
  code text not null check (length(btrim(code)) between 1 and 100),
  display text not null check (length(btrim(display)) between 1 and 500),
  last_used_at timestamptz not null default clock_timestamp(),
  use_count integer not null default 1 check (use_count >= 1),
  constraint clinician_recent_diagnoses_pkey primary key (membership_id, code_system, code)
);
create index clinician_recent_diagnoses_newest_idx
  on ehr.clinician_recent_diagnoses (membership_id, last_used_at desc);
alter table ehr.clinician_recent_diagnoses enable row level security;
revoke all on ehr.clinician_recent_diagnoses from public;

-- 2. The record (in the diagnosis save's transaction).
create function ehr.record_recent_diagnosis(requested_code_system text, requested_code text, requested_display text)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  membership_value uuid;
  facility_value uuid;
begin
  begin
    membership_value := nullif(current_setting('app.membership_id', true), '')::uuid;
    facility_value := nullif(current_setting('app.facility_id', true), '')::uuid;
  exception when invalid_text_representation then
    return;
  end;
  if membership_value is null or facility_value is null
     or nullif(btrim(requested_code_system), '') is null or nullif(btrim(requested_code), '') is null
     or nullif(btrim(requested_display), '') is null
     or length(requested_code_system) > 255 or length(requested_code) > 100 or length(requested_display) > 500
     or not auth.membership_has_permission(current_setting('app.actor_subject', true), membership_value,
                                           facility_value, 'ehr.diagnosis.write') then
    return;
  end if;
  insert into ehr.clinician_recent_diagnoses as recent
         (membership_id, facility_id, code_system, code, display)
  values (membership_value, facility_value, requested_code_system, requested_code, requested_display)
  on conflict (membership_id, code_system, code) do update
     set display = excluded.display, facility_id = excluded.facility_id,
         last_used_at = clock_timestamp(), use_count = recent.use_count + 1;
  delete from ehr.clinician_recent_diagnoses recent
   where recent.membership_id = membership_value
     and (recent.code_system, recent.code) in (
       select older.code_system, older.code from ehr.clinician_recent_diagnoses older
        where older.membership_id = membership_value
        order by older.last_used_at desc, older.code_system, older.code
        offset 200);
end;
$$;

-- 3. The read.
create function ehr.recent_diagnoses(requested_limit integer)
returns table (code_system text, code text, display text, last_used_at timestamptz, use_count integer)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  membership_value uuid;
  facility_value uuid;
begin
  if requested_limit is null or requested_limit < 1 or requested_limit > 50 then
    raise exception using errcode = '22023', message = 'RECENT_DIAGNOSES_INVALID';
  end if;
  begin
    membership_value := nullif(current_setting('app.membership_id', true), '')::uuid;
    facility_value := nullif(current_setting('app.facility_id', true), '')::uuid;
  exception when invalid_text_representation then
    return;
  end;
  if membership_value is null or facility_value is null
     or not auth.membership_has_permission(current_setting('app.actor_subject', true), membership_value,
                                           facility_value, 'ehr.diagnosis.write') then
    return;
  end if;
  return query
    select recent.code_system, recent.code, recent.display, recent.last_used_at, recent.use_count
      from ehr.clinician_recent_diagnoses recent
     where recent.membership_id = membership_value and recent.facility_id = facility_value
     order by recent.last_used_at desc, recent.code_system, recent.code
     limit requested_limit;
end;
$$;

-- 4. Grants (here and in runtime-grants.sql).
revoke all on function ehr.record_recent_diagnosis(text, text, text), ehr.recent_diagnoses(integer) from public;
do $$
declare runtime_role text;
begin
  foreach runtime_role in array array['hid_ehr_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = runtime_role) then
      execute format('grant execute on function ehr.record_recent_diagnosis(text, text, text), '
        || 'ehr.recent_diagnoses(integer) to %I', runtime_role);
    end if;
  end loop;
end
$$;

comment on table ehr.clinician_recent_diagnoses is
  '0151 (ORD-9): each member''s own last diagnosis picks at their facility (code system, code, display, last used, count), at most 200 per membership; no patient id. Row-level security on, no policy, no grant: read and written only by ehr.recent_diagnoses and ehr.record_recent_diagnosis.';
comment on function ehr.record_recent_diagnosis(text, text, text) is
  '0151 (ORD-9): records a diagnosis pick for the session''s membership (ehr.diagnosis.write at the session''s facility), in the save''s transaction; records nothing otherwise or with no code. At most 200 per membership.';
comment on function ehr.recent_diagnoses(integer) is
  '0151 (ORD-9): the session''s membership''s diagnosis picks at its facility, newest first, at most limit (1-50); none without ehr.diagnosis.write. 22023 RECENT_DIAGNOSES_INVALID for a limit outside 1-50.';

-- 5. Post-checks.
do $$
declare
  owner_oid oid := (select relation.relowner from pg_class relation
                     where relation.oid = 'ehr.clinician_recent_diagnoses'::regclass);
begin
  if not (select relation.relrowsecurity from pg_class relation
           where relation.oid = 'ehr.clinician_recent_diagnoses'::regclass)
     or exists (select 1 from pg_policy policy where policy.polrelid = 'ehr.clinician_recent_diagnoses'::regclass)
     or exists (select 1 from pg_class relation, lateral aclexplode(coalesce(relation.relacl,
                  acldefault('r', relation.relowner))) acl
                 where relation.oid = 'ehr.clinician_recent_diagnoses'::regclass
                   and acl.grantee <> relation.relowner) then
    raise exception using errcode = '55000', message = '0151: the recent diagnoses table is not the owner''s only';
  end if;
  if exists (select 1 from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where proc.oid in ('ehr.record_recent_diagnosis(text,text,text)'::regprocedure,
                                 'ehr.recent_diagnoses(integer)'::regprocedure)
                and acl.grantee <> proc.proowner
                and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) not in ('hid_ehr_runtime', 'hid_schema_test_runtime'))) then
    raise exception using errcode = '55000', message = '0151: a recent diagnoses function is granted to a role other than the EHR and schema test runtimes';
  end if;
  if (select count(*) from pg_proc proc
       where proc.oid in ('ehr.record_recent_diagnosis(text,text,text)'::regprocedure,
                          'ehr.recent_diagnoses(integer)'::regprocedure)
         and proc.prosecdef and proc.proowner = owner_oid
         and proc.proconfig = array['search_path=pg_catalog, pg_temp']) <> 2 then
    raise exception using errcode = '55000', message = '0151: a recent diagnoses function is not as made';
  end if;
end
$$;
