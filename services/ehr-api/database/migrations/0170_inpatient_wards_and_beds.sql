-- 0170 ADT-1 Inpatient admission: wards and beds (Release D, the department
-- sprint the owner approved on 25 November 2026, verbatim: "I approve
-- Q147–Q290 at the recommended options"). Written on
-- claude/sprint-inpatient-backend at 64b22777 (staging-novu-ci-20261005 at
-- 95fa1e52: 0001-0151 applied). The number is provisional: numbers are given
-- at merge, after the files booked before it (0152-0153 ORD-9, 0154 ORD-12,
-- APPT-1's 0160-0161, BILL-1's 0162-0167, ED-1's 0168-0169). This file reads
-- nothing 0152-0169 create or change, so it applies on 0001-0151 and on
-- 0001-0169 alike. The declaration in config/production-schema-compatibility.json
-- stays unsigned until the owner signs this file. 0171 (admissions), 0172
-- (charges) and 0173 (who uses the wards) are their own files.
--
-- Owner decisions (25 November 2026, each at its recommended option; the
-- contract is docs/EHR_PLANNED_CONTRACT.md, ADT-1): Q186 A (one patient per bed
-- or named overflow space; a bed is available, occupied, cleaning or under
-- maintenance), Q191 A (facility admins set up wards), Q190 A (every ward
-- staff member sees names on the board after the DPO check: a switch, off
-- here), Q201 A (ICU is a ward type), Q156 A (ward-team access: a switch, off
-- here), Q188 A (the death record: a switch, off here).
--
-- What it changes (nothing else):
-- W1 ehr.wards              facility, organisation, name (2-80, unique among
--                           the facility's active wards in any case),
--                           ward_type (general, paediatric, maternity, icu,
--                           private, other), takes (any, male, female),
--                           active, who created and changed it, row version.
-- W2 ehr.beds               ward, facility, name (1-40, unique among the
--                           ward's active beds in any case), kind (bed,
--                           overflow), status (available, occupied, cleaning,
--                           maintenance) and since when, active, row version.
--                           An inactive bed is never occupied (CHECK). A bed
--                           is never deleted.
-- W3 ehr.bed_status_events  every status change, with the note (a cleaning
--                           record, a maintenance reason or a release note;
--                           never patient content), the actor and the time.
--                           A trigger refuses any update or delete.
-- W4 ehr.ward_staff         ward, membership, who added it and when; unique
--                           (ward, membership). The list says who works on
--                           the ward; it never opens a chart by itself.
-- W5 ehr.ward_events        every ward and bed setup change and bed status
--                           change, with the Idempotency-Key and the
--                           request's SHA-256 (unique per membership and
--                           key). Append only.
-- W6 ehr.inpatient_switches three rows, board_names_for_ward_staff (Q190),
--                           ward_stay_access (Q156) and death_record (Q188),
--                           all false. No runtime role may read or write it;
--                           only the functions read it. A later signed
--                           migration turns a switch on after its review.
--    Every table has row-level security enabled and no policy or privilege
--    for any runtime role: only the functions below read or write them, as
--    their owner (0135's rule).
-- W7 SECURITY DEFINER functions (search_path pg_catalog, pg_temp), owned like
--    0135's (the owner of identity.has_active_consent_grant), EXECUTE for
--    hid_ehr_runtime only: ehr.ward_list, ehr.ward_create, ehr.ward_update,
--    ehr.bed_create, ehr.bed_update, ehr.ward_staff_set, ehr.bed_set_status,
--    ehr.bed_board, ehr.inpatient_census. Helpers no role may execute:
--    ehr.inpatient_caller, ehr.inpatient_audit, ehr.ward_key,
--    ehr.ward_json, ehr.inpatient_member_has_role,
--    ehr.inpatient_chart_blocked, ehr.ward_patient_name_visible (Q190: the
--    switch, the deny directives and ehr.context_allows), the history's
--    immutability trigger, and three parts 0171 replaces once admissions
--    exist: ehr.inpatient_bed_occupants (no rows here), ehr.inpatient_waiting
--    (an empty list here) and ehr.inpatient_day_counts (no rows here).
--    Each function checks the caller: an active membership not held by the
--    cutover at the session facility, the access code (ehr.ward.read for the
--    board and census; ehr.ward.manage for setup; ehr.bed.allocate or
--    ehr.ward.manage for a bed's status; the list with either), and the
--    purpose (direct care, and healthcare operations for setup). Without 0173
--    no role holds an inpatient code, so every function refuses: the
--    database half of "built but switched off".
-- W8 Audit, in the request's transaction (as 0135: a refusal the function
--    raises is recorded by ehr-api's request audit; an answer that refuses is
--    recorded here): ehr.ward.create, ehr.ward.update, ehr.bed.create,
--    ehr.bed.update, ehr.bed.status, ehr.ward.staff-set, ehr.bed-board (one
--    collection row with the count and the patient ids shown, and one
--    ehr.bed-board.shown row per patient with whether the name was shown),
--    ehr.census (no patient). Rows hold ids, outcomes and refusal kinds;
--    never a name, date of birth, Health ID, admission reason or note text.
--    This file itself writes no audit row: it changes no existing row.
--
-- Locks (measured with pg_locks before commit and compared by the migrations
-- suite), taken first, NOWAIT: SHARE ROW EXCLUSIVE on identity.facilities and
-- identity.staff_facility_memberships (the foreign keys of the new, empty
-- tables); ROW EXCLUSIVE on audit.events (the audit helper's body names it);
-- ACCESS SHARE on identity.patients, identity.consent_directives, identity.consent_directive_versions,
-- auth.permissions, auth.role_permissions and auth.account_roles (read by the
-- preconditions or named by the bodies). A busy table fails the attempt at
-- once, and its subtransaction releases what it took. The attempt is made 50
-- times, 100 ms apart (about 5 seconds), so the file never waits for one of
-- its locks while holding the others; then 55P03 (nothing applied). When this
-- transaction already holds an earlier migration's locks that stop other
-- sessions' reads or writes (the runner's dry run applies every pending file
-- in one transaction), one attempt and no sleep: 55P03 at once, nothing
-- applied. Both refusals begin "0170: " and end "run the release again at a
-- quieter time", so the runner's dry run rolls back and tries again (#306).
-- Other waits are not NOWAIT, and the runner's lock_timeout ends each after 5
-- seconds (nothing applied): an index or catalog that maintenance holds.
--
-- Old images on this schema: nothing calls the new functions.
--
-- Undo (not in the ledger; a migration only if the owner signs it): drop the
-- functions and the six tables (once 0171 is undone).
--
-- The whole file is one statement (do $adt0170$), so whatever raises in it,
-- however the file is run, applies nothing:
-- 0. The locks (one attempt, made up to 50 times while a table is busy).
-- 1. Preconditions (55000, nothing applied): the earlier functions this file
--    calls (it uses no object of 0114, 0135 or 0145, so it needs no marker of
--    them; the bodies it calls are md5-pinned below);
--    "0170: already applied" when every object of this file is there,
--    "0170: the schema is not in the reviewed state" for any half state; the
--    bodies this file calls md5-pinned; the columns it reads by name and
--    type; the functions' owner is the owner of the tables it reads.
-- 2. W1-W7.
-- 3. Post-checks (0148's, 0152's and 0168's form): the tables have row-level
--    security and no privilege for any role but their owner; the two
--    histories' identity sequences (sequence_no) are the owner's and granted
--    to no other role (runtime-grants.sql takes back what its schema-wide
--    sequence grants would give); the switches are the three rows, all false;
--    the two triggers by events, columns and function, with no WHEN condition
--    or arguments, and no other trigger on the new tables; the 20 functions
--    by body (md5), SECURITY DEFINER setting, volatility, search_path, owner
--    and EXECUTE (hid_ehr_runtime on the nine entry points, no role on the
--    helpers); no audit row written (this transaction's own row counters for
--    audit.events, which cost nothing; no count of the table).

do $adt0170$
declare
  v_writes_before text;
  v_post_mismatch text;
  v_attempt integer := 0;
  v_holding boolean := exists (
    select 1 from pg_locks held
      join pg_class relation on relation.oid = held.relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
       and held.database = (select database_row.oid from pg_database database_row
                             where database_row.datname = current_database())
       and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
       and namespace.nspname <> 'migration');
  v_mismatch text;
  v_present integer;
  v_owner name;
begin
  -- 0. The locks, NOWAIT. (The attempt's block is not indented, so step 0
  -- reads as its own step.)
  loop
  v_attempt := v_attempt + 1;
  begin
  lock table identity.facilities, identity.staff_facility_memberships in share row exclusive mode nowait;
  lock table audit.events in row exclusive mode nowait;
  lock table identity.patients, identity.consent_directives, identity.consent_directive_versions, auth.permissions,
    auth.role_permissions, auth.account_roles
    in access share mode nowait;
  exit;
  exception when lock_not_available then
    if v_holding then
      raise exception using errcode = '55P03',
        message = '0170: identity.facilities, identity.staff_facility_memberships, audit.events or a table 0170 '
          || 'reads (patients, consent directives, permissions, role permissions and role '
          || 'assignments) is busy, and this transaction already holds an earlier migration''s locks, so it does not '
          || 'wait; nothing applied; run the release again at a quieter time';
    end if;
    if v_attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0170: identity.facilities, identity.staff_facility_memberships, audit.events or a table 0170 '
          || 'reads (patients, consent directives, permissions, role permissions and role '
          || 'assignments) stayed busy for 5 seconds; nothing applied; run the release again at a quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  -- No earlier file's marker: this file uses no object of 0114 (department codes), 0135 (the waiting list) or 0145
  -- (unknown records). The functions it calls must be there (their bodies are md5-pinned below).
  if to_regprocedure('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)') is null
     or to_regprocedure('ehr.context_allows(uuid,uuid,text)') is null
     or to_regprocedure('auth.membership_has_permission(text,uuid,uuid,text)') is null
     or to_regclass('migration.schema_migrations') is null then
    raise exception using errcode = '55000', message = '0170: 0001-0151 must be applied first';
  end if;

  select count(*) into v_present
    from (values (to_regclass('ehr.wards')::oid), (to_regclass('ehr.beds')::oid),
                 (to_regclass('ehr.bed_status_events')::oid), (to_regclass('ehr.ward_staff')::oid),
                 (to_regclass('ehr.ward_events')::oid), (to_regclass('ehr.inpatient_switches')::oid),
                 (to_regprocedure('ehr.bed_board(uuid, text)')::oid),
                 (to_regprocedure('ehr.inpatient_census(date)')::oid),
                 (to_regprocedure('ehr.ward_patient_name_visible(uuid, uuid)')::oid))
         present(object_id)
   where present.object_id is not null;
  if v_present = 9 then
    raise exception using errcode = '55000', message = '0170: already applied';
  end if;
  if v_present <> 0
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'ehr'
                   and (proc.proname like 'ward\_%' or proc.proname like 'bed\_%'
                        or proc.proname like 'inpatient\_%' or proc.proname like 'beds\_%'
                        or proc.proname like 'wards\_%')) then
    raise exception using errcode = '55000',
      message = '0170: the schema is not in the reviewed state (part of 0170 is there); nothing applied';
  end if;

  select string_agg(expected.signature, ', ') into v_mismatch
    from (values
      ('identity.sealed_demo_facility(uuid)', 'd91d91c1d3e1a455e49c5960f313a6e7'),
      ('identity.sealed_qa_facility(uuid)', 'fe9846d94cd744bf37c3f72053d9931f'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('ehr.context_allows(uuid,uuid,text)', '75016690184a80bd246c365b4d108082'),
      ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)',
       '732d11892dd4e27e1ff9093ae3b7de5a')
    ) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0170: these bodies are not as 0001-0151 left them: ' || v_mismatch;
  end if;
  if to_regprocedure('platform.current_actor_subject()') is null
     or to_regprocedure('platform.current_membership_id()') is null
     or to_regprocedure('platform.current_facility_id()') is null
     or to_regprocedure('platform.current_correlation_id()') is null
     or to_regprocedure('platform.current_purpose_of_use()') is null
     or to_regprocedure('auth.account_id_for_subject(text)') is null then
    raise exception using errcode = '55000', message = '0170: a function this file calls is missing';
  end if;
  -- The columns this file reads, by name and type.
  select string_agg(wanted.relation || '.' || wanted.column_name, ', ' order by wanted.relation, wanted.column_name)
    into v_mismatch
    from (values
      ('identity.facilities', 'id', 'uuid'), ('identity.facilities', 'organization_id', 'uuid'),
      ('identity.staff_facility_memberships', 'id', 'uuid'),
      ('identity.staff_facility_memberships', 'account_id', 'uuid'),
      ('identity.staff_facility_memberships', 'staff_id', 'uuid'),
      ('identity.staff_facility_memberships', 'organization_id', 'uuid'),
      ('identity.staff_facility_memberships', 'facility_id', 'uuid'),
      ('identity.staff_facility_memberships', 'active', 'boolean'),
      ('identity.staff_facility_memberships', 'migration_hold_reason', 'text'),
      ('auth.account_roles', 'membership_id', 'uuid'), ('auth.account_roles', 'role_code', 'text'),
      ('auth.account_roles', 'scope_type', 'text'),
      ('auth.account_roles', 'revoked_at', 'timestamp with time zone'),
      ('identity.consent_directives', 'patient_id', 'uuid'),
      ('identity.consent_directives', 'current_version', 'integer'),
      ('identity.consent_directive_versions', 'status', 'text'),
      ('identity.consent_directive_versions', 'provision_type', 'text'),
      ('identity.consent_directive_versions', 'facility_id', 'uuid'),
      ('identity.consent_directive_versions', 'actions', 'text[]'),
      ('identity.consent_directive_versions', 'purposes', 'text[]'),
      ('identity.consent_directive_versions', 'grantee_type', 'text'),
      ('identity.consent_directive_versions', 'grantee_id', 'uuid')
    ) wanted(relation, column_name, type_name)
   where not exists (select 1 from pg_attribute attribute_row
                      where attribute_row.attrelid = wanted.relation::regclass
                        and attribute_row.attname = wanted.column_name and attribute_row.attnum > 0
                        and not attribute_row.attisdropped
                        and format_type(attribute_row.atttypid, attribute_row.atttypmod) = wanted.type_name);
  if v_mismatch is not null then
    raise exception using errcode = '55000', message = '0170: these columns are not as 0001-0151 left them: ' || v_mismatch;
  end if;
  v_owner := (select pg_get_userbyid(proowner) from pg_proc
               where oid = 'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)'::regprocedure);
  -- The rows of audit.events this file must not write: this transaction's own row counters for each
  -- (inserted/updated/deleted), taken here and compared in the post-checks. They cost nothing; a count or a snapshot
  -- of the rows would read whole tables under this file's locks.
  select string_agg(format('%s %s/%s/%s', watched.relation, pg_stat_get_xact_tuples_inserted(watched.relation),
           pg_stat_get_xact_tuples_updated(watched.relation), pg_stat_get_xact_tuples_deleted(watched.relation)),
           ', ' order by watched.ord)
    into v_writes_before
    from unnest(array['audit.events']::regclass[]) with ordinality watched(relation, ord);

  -- W1. Wards.
  create table ehr.wards (
    id uuid primary key default gen_random_uuid(),
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    organization_id uuid not null,
    name text not null check (name = btrim(name) and length(name) between 2 and 80 and name !~ '[[:cntrl:]]'),
    ward_type text not null check (ward_type in ('general', 'paediatric', 'maternity', 'icu', 'private', 'other')),
    takes text not null default 'any' check (takes in ('any', 'male', 'female')),
    active boolean not null default true,
    created_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    created_at timestamptz not null default clock_timestamp(),
    updated_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    updated_at timestamptz not null default clock_timestamp(),
    row_version bigint not null default 1 check (row_version > 0),
    unique (id, facility_id),
    constraint wards_facility_organization_fk foreign key (facility_id, organization_id)
      references identity.facilities(id, organization_id) on delete restrict
  );
  create unique index wards_active_name_ux on ehr.wards (facility_id, lower(name)) where active;
  create index wards_facility_idx on ehr.wards (facility_id, ward_type) where active;
  alter table ehr.wards enable row level security;
  revoke all on ehr.wards from public;
  comment on table ehr.wards is
    '0170 (ADT-1, Q191 A, Q201 A): a ward of a facility, with its type (ICU is a ward type) and who it takes. Set up by facility admins. Only the inpatient functions read and write it, as its owner.';

  -- W2. Beds and overflow spaces.
  create table ehr.beds (
    id uuid primary key default gen_random_uuid(),
    ward_id uuid not null,
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    name text not null check (name = btrim(name) and length(name) between 1 and 40 and name !~ '[[:cntrl:]]'),
    kind text not null default 'bed' check (kind in ('bed', 'overflow')),
    status text not null default 'available' check (status in ('available', 'occupied', 'cleaning', 'maintenance')),
    status_since timestamptz not null default clock_timestamp(),
    active boolean not null default true,
    created_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    created_at timestamptz not null default clock_timestamp(),
    updated_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    updated_at timestamptz not null default clock_timestamp(),
    row_version bigint not null default 1 check (row_version > 0),
    unique (id, facility_id),
    constraint beds_ward_fk foreign key (ward_id, facility_id) references ehr.wards(id, facility_id) on delete restrict,
    -- An inactive bed is never occupied.
    constraint beds_inactive_not_occupied_ck check (active or status <> 'occupied')
  );
  create unique index beds_active_name_ux on ehr.beds (ward_id, lower(name)) where active;
  create index beds_ward_idx on ehr.beds (ward_id, kind, name);
  create index beds_facility_status_idx on ehr.beds (facility_id, status) where active;
  alter table ehr.beds enable row level security;
  revoke all on ehr.beds from public;
  comment on table ehr.beds is
    '0170 (ADT-1, Q186 A): a bed or a named overflow space of a ward; one patient at a time (0171''s unique index). Never deleted. Only the inpatient functions read and write it, as its owner.';

  -- W3. Bed status history.
  create table ehr.bed_status_events (
    id uuid primary key default gen_random_uuid(),
    sequence_no bigint generated always as identity,
    bed_id uuid not null references ehr.beds(id) on delete restrict,
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    from_status text check (from_status is null or from_status in ('available', 'occupied', 'cleaning', 'maintenance')),
    to_status text not null check (to_status in ('available', 'occupied', 'cleaning', 'maintenance')),
    cause text not null check (cause in ('created', 'turnover', 'maintenance', 'release', 'cleaning', 'admission',
      'transfer', 'discharge')),
    note text check (note is null or (note = btrim(note) and length(note) between 1 and 300)),
    by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    at timestamptz not null default clock_timestamp()
  );
  create index bed_status_events_bed_idx on ehr.bed_status_events (bed_id, sequence_no);
  create index bed_status_events_facility_idx on ehr.bed_status_events (facility_id, at);
  alter table ehr.bed_status_events enable row level security;
  revoke all on ehr.bed_status_events from public;
  comment on table ehr.bed_status_events is
    '0170 (ADT-1): every bed status change with its cause, the note (a cleaning record, a maintenance reason or a release note, never patient content), the actor and the time. Append only.';

  create function ehr.bed_status_events_immutable()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, pg_temp
  as $fn$
  begin
    raise exception using errcode = '55000', message = 'INPATIENT_HISTORY_IMMUTABLE';
  end
  $fn$;
  revoke all on function ehr.bed_status_events_immutable() from public;
  create trigger bed_status_events_immutable
    before update or delete on ehr.bed_status_events
    for each row execute function ehr.bed_status_events_immutable();

  -- W4. Ward staff.
  create table ehr.ward_staff (
    ward_id uuid not null references ehr.wards(id) on delete restrict,
    membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    added_by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    added_at timestamptz not null default clock_timestamp(),
    primary key (ward_id, membership_id)
  );
  create index ward_staff_membership_idx on ehr.ward_staff (membership_id);
  alter table ehr.ward_staff enable row level security;
  revoke all on ehr.ward_staff from public;
  comment on table ehr.ward_staff is
    '0170 (ADT-1): who works on a ward (nurses, clinicians and doctors of the facility). Used for "my wards" and, once switched on, for ward-team access (Q156, 0173). A place on the list never opens a chart by itself.';

  -- W5. Setup history.
  create table ehr.ward_events (
    id uuid primary key default gen_random_uuid(),
    sequence_no bigint generated always as identity,
    facility_id uuid not null references identity.facilities(id) on delete restrict,
    ward_id uuid not null references ehr.wards(id) on delete restrict,
    bed_id uuid references ehr.beds(id) on delete restrict,
    kind text not null check (kind in ('ward_created', 'ward_updated', 'bed_created', 'bed_updated', 'bed_status',
      'staff_set')),
    details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
    by_account_id uuid not null,
    by_membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
    at timestamptz not null default clock_timestamp(),
    idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
    request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$')
  );
  create unique index ward_events_key_ux on ehr.ward_events (by_membership_id, idempotency_key);
  create index ward_events_ward_idx on ehr.ward_events (ward_id, sequence_no);
  alter table ehr.ward_events enable row level security;
  revoke all on ehr.ward_events from public;
  comment on table ehr.ward_events is
    '0170 (ADT-1): every ward and bed setup change and bed status change, with the Idempotency-Key and the request''s SHA-256. Append only.';
  create trigger ward_events_immutable
    before update or delete on ehr.ward_events
    for each row execute function ehr.bed_status_events_immutable();

  -- W6. The switches (all off).
  create table ehr.inpatient_switches (
    key text primary key check (key in ('board_names_for_ward_staff', 'ward_stay_access', 'death_record')),
    enabled boolean not null default false,
    changed_by_migration text not null check (changed_by_migration ~ '^[0-9]{4}$'),
    changed_at timestamptz not null default clock_timestamp()
  );
  insert into ehr.inpatient_switches (key, enabled, changed_by_migration) values
    ('board_names_for_ward_staff', false, '0170'), ('ward_stay_access', false, '0170'), ('death_record', false, '0170');
  alter table ehr.inpatient_switches enable row level security;
  revoke all on ehr.inpatient_switches from public;
  comment on table ehr.inpatient_switches is
    '0170 (ADT-1): board_names_for_ward_staff (Q190 A, after the DPO check), ward_stay_access (Q156 A, after Rahman and the DPO agree) and death_record (Q188 A, after the clinical lead and legal sign). All off. Only a later signed migration turns one on. No runtime role may read or write it.';

  -- W7. Helpers (no role may execute them; the functions below run them as their owner).

  -- Whether a membership is active here and holds one of the given roles at this facility.
  create function ehr.inpatient_member_has_role(requested_membership uuid, requested_facility uuid, roles text[])
  returns boolean
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select exists (
      select 1
        from identity.staff_facility_memberships membership
        join auth.account_roles assignment
          on assignment.membership_id = membership.id and assignment.revoked_at is null
         and assignment.scope_type = 'facility'
       where membership.id = requested_membership and membership.facility_id = requested_facility
         and membership.active and membership.migration_hold_reason is null
         and assignment.role_code = any (roles))
  $fn$;
  revoke all on function ehr.inpatient_member_has_role(uuid, uuid, text[]) from public;

  -- The caller: an active membership here not held by the cutover, the access the function needs, and an allowed
  -- purpose. The answer says which inpatient codes the member holds.
  create function ehr.inpatient_caller(required_access text, allowed_purposes text[])
  returns table (actor_subject text, actor_account uuid, actor_membership uuid, actor_facility uuid,
    actor_organization uuid, actor_staff uuid, actor_correlation text, actor_purpose text, can_read_ward boolean,
    can_read_admission boolean, can_allocate boolean, can_print_band boolean, can_decide boolean, can_manage boolean,
    can_write_death_record boolean)
  language plpgsql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    refusal text;
  begin
    actor_subject := platform.current_actor_subject();
    actor_account := auth.account_id_for_subject(actor_subject);
    actor_membership := platform.current_membership_id();
    actor_facility := platform.current_facility_id();
    actor_correlation := platform.current_correlation_id();
    actor_purpose := platform.current_purpose_of_use();
    refusal := case when required_access = 'ward_manage' then 'WARD_SETUP_NOT_ALLOWED'
                    when required_access in ('bed_allocate', 'bed_status') then 'BED_ALLOCATE_NOT_ALLOWED'
                    when required_access = 'admission_decide' then 'ADMISSION_DECIDE_NOT_ALLOWED'
                    else 'INPATIENT_NOT_ALLOWED' end;
    if actor_account is null or actor_membership is null or actor_facility is null or actor_correlation is null then
      raise exception using errcode = '42501', message = refusal;
    end if;
    select membership.organization_id, membership.staff_id into actor_organization, actor_staff
      from identity.staff_facility_memberships membership
     where membership.id = actor_membership and membership.account_id = actor_account
       and membership.facility_id = actor_facility and membership.active
       and membership.migration_hold_reason is null;
    if not found then
      raise exception using errcode = '42501', message = refusal;
    end if;
    can_read_ward := auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.ward.read');
    can_read_admission := can_read_ward
      and auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.admission.read');
    can_allocate := can_read_ward
      and auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.bed.allocate');
    can_print_band := can_read_ward
      and auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.wristband.print');
    can_decide := can_read_admission
      and auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.admission.decide');
    can_manage := auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.ward.manage');
    can_write_death_record := can_read_admission
      and auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.death-record.write');
    if (required_access = 'ward_read' and not can_read_ward)
       or (required_access = 'ward_list' and not (can_read_ward or can_manage))
       or (required_access = 'ward_manage' and not can_manage)
       or (required_access = 'bed_status' and not (can_allocate or can_manage))
       or (required_access = 'bed_allocate' and not can_allocate)
       or (required_access = 'admission_read' and not can_read_admission)
       or (required_access = 'wristband' and not can_print_band)
       or (required_access = 'admission_decide' and not can_decide)
       or (required_access = 'death_record' and not can_write_death_record)
       or required_access not in ('ward_read', 'ward_list', 'ward_manage', 'bed_status', 'bed_allocate',
                                  'admission_read', 'wristband', 'admission_decide', 'death_record') then
      raise exception using errcode = '42501', message = refusal;
    end if;
    if actor_purpose is null or not actor_purpose = any (allowed_purposes) then
      raise exception using errcode = '22023', message = 'INPATIENT_PURPOSE_REQUIRED';
    end if;
    return next;
  end
  $fn$;
  revoke all on function ehr.inpatient_caller(text, text[]) from public;

  -- One audit row as the session's member. Callers pass ids, outcomes, refusal kinds and flags only.
  create function ehr.inpatient_audit(a_patient uuid, a_action text, a_outcome text, a_resource_type text,
    a_resource_id text, a_details jsonb)
  returns void
  language sql
  volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, provenance, source_system, details
    )
    select platform.current_correlation_id(), 'staff', platform.current_actor_subject(),
           auth.account_id_for_subject(platform.current_actor_subject()), platform.current_membership_id(),
           membership.organization_id, platform.current_facility_id(), a_patient, a_action, a_outcome,
           a_resource_type, a_resource_id, platform.current_purpose_of_use(), 'application', 'ehr-api',
           coalesce(a_details, '{}'::jsonb)
      from identity.staff_facility_memberships membership
     where membership.id = platform.current_membership_id()
  $fn$;
  revoke all on function ehr.inpatient_audit(uuid, text, text, text, text, jsonb) from public;

  -- The Idempotency-Key of a setup or bed status write: 'new', 'replay' (the same key and body: the ward or bed
  -- and the first answer's kind) or 'reused' (the same key, another body). Under an advisory lock per membership
  -- and key, so two requests with one key never both act.
  create function ehr.ward_key(a_membership uuid, a_key text, a_sha text)
  returns table (state text, ward_id uuid, bed_id uuid, kind text)
  language plpgsql
  volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    found_event ehr.ward_events%rowtype;
  begin
    if a_key is null or a_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
       or a_sha is null or a_sha !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'INPATIENT_IDEMPOTENCY_KEY_INVALID';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('inpatient-key:' || a_membership::text || ':' || a_key, 0));
    select event.* into found_event from ehr.ward_events event
     where event.by_membership_id = a_membership and event.idempotency_key = a_key;
    if not found then
      state := 'new';
    elsif found_event.request_sha256 = a_sha then
      state := 'replay';
      ward_id := found_event.ward_id;
      bed_id := found_event.bed_id;
      kind := found_event.kind;
    else
      state := 'reused';
    end if;
    return next;
  end
  $fn$;
  revoke all on function ehr.ward_key(uuid, text, text) from public;

  -- A ward as route 1 answers it: counts only, never a patient; the beds and staff list when asked.
  create function ehr.ward_json(requested_ward uuid, with_details boolean)
  returns jsonb
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select jsonb_build_object(
      'wardId', ward.id, 'name', ward.name, 'wardType', ward.ward_type, 'takes', ward.takes, 'active', ward.active,
      'bedCount', count(bed.id) filter (where bed.kind = 'bed'),
      'overflowCount', count(bed.id) filter (where bed.kind = 'overflow'),
      'occupied', count(bed.id) filter (where bed.status = 'occupied'),
      'available', count(bed.id) filter (where bed.status = 'available'),
      'cleaning', count(bed.id) filter (where bed.status = 'cleaning'),
      'maintenance', count(bed.id) filter (where bed.status = 'maintenance'),
      'overflowInUse', count(bed.id) filter (where bed.kind = 'overflow' and bed.status = 'occupied'),
      'staffCount', (select count(*) from ehr.ward_staff staff where staff.ward_id = ward.id),
      'rowVersion', ward.row_version)
      || case when coalesce(with_details, false) then jsonb_build_object(
           'beds', coalesce((select jsonb_agg(jsonb_build_object('bedId', all_bed.id, 'name', all_bed.name,
               'kind', all_bed.kind, 'status', all_bed.status, 'active', all_bed.active,
               'rowVersion', all_bed.row_version) order by all_bed.kind, lower(all_bed.name), all_bed.id)
             from ehr.beds all_bed where all_bed.ward_id = ward.id), '[]'::jsonb),
           'staffMembershipIds', coalesce((select jsonb_agg(staff.membership_id order by staff.membership_id)
             from ehr.ward_staff staff where staff.ward_id = ward.id), '[]'::jsonb))
         else '{}'::jsonb end
      from ehr.wards ward
      left join ehr.beds bed on bed.ward_id = ward.id and bed.active
     where ward.id = requested_ward
     group by ward.id
  $fn$;
  revoke all on function ehr.ward_json(uuid, boolean) from public;

  -- Whether an active deny directive keeps this patient's chart from the viewer here (EHR-C7's chartBlocked).
  create function ehr.inpatient_chart_blocked(requested_patient uuid, viewer_facility uuid, viewer_organization uuid,
    viewer_staff uuid)
  returns boolean
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select exists (
      select 1
        from identity.consent_directives directive
        join identity.consent_directive_versions directive_version
          on directive_version.directive_id = directive.id
         and directive_version.version_no = directive.current_version
       where directive.patient_id = requested_patient
         and directive_version.status = 'active'
         and directive_version.provision_type = 'deny'
         and directive_version.starts_at <= clock_timestamp()
         and (directive_version.expires_at is null or directive_version.expires_at > clock_timestamp())
         and (directive_version.facility_id is null or directive_version.facility_id = viewer_facility)
         and (cardinality(directive_version.actions) = 0
              or directive_version.actions && array['read_records', 'write_records']::text[])
         and (cardinality(directive_version.purposes) = 0 or 'direct-care' = any (directive_version.purposes))
         and (directive_version.grantee_type = 'all'
              or (directive_version.grantee_type = 'facility' and directive_version.grantee_id = viewer_facility)
              or (directive_version.grantee_type = 'organization' and directive_version.grantee_id = viewer_organization)
              or (directive_version.grantee_type = 'staff' and directive_version.grantee_id = viewer_staff)))
  $fn$;
  revoke all on function ehr.inpatient_chart_blocked(uuid, uuid, uuid, uuid) from public;

  -- Q190: whether the session's member sees this patient's name on a ward list. Never with an active deny
  -- directive; with the switch on (after the DPO check), always; until then only while the member can read the
  -- chart now (ehr.context_allows, as the member).
  create function ehr.ward_patient_name_visible(requested_member uuid, requested_patient uuid)
  returns boolean
  language plpgsql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    member_row identity.staff_facility_memberships%rowtype;
  begin
    if requested_member is null or requested_patient is null
       or requested_member is distinct from platform.current_membership_id() then
      return false;
    end if;
    select membership.* into member_row from identity.staff_facility_memberships membership
     where membership.id = requested_member and membership.facility_id = platform.current_facility_id();
    if not found
       or ehr.inpatient_chart_blocked(requested_patient, member_row.facility_id, member_row.organization_id,
                                      member_row.staff_id) then
      return false;
    end if;
    if coalesce((select switch_row.enabled from ehr.inpatient_switches switch_row
                  where switch_row.key = 'board_names_for_ward_staff'), false) then
      return true;
    end if;
    return coalesce(ehr.context_allows(requested_patient, member_row.facility_id, 'read_records'), false);
  end
  $fn$;
  revoke all on function ehr.ward_patient_name_visible(uuid, uuid) from public;

  -- The patients in the given wards' beds (0171 replaces this; before 0171 no bed can be occupied).
  create function ehr.inpatient_bed_occupants(requested_facility uuid, requested_wards uuid[])
  returns table (bed_id uuid, patient_id uuid, admission_id uuid, name_shown boolean, card jsonb)
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select null::uuid, null::uuid, null::uuid, null::boolean, null::jsonb where false
  $fn$;
  revoke all on function ehr.inpatient_bed_occupants(uuid, uuid[]) from public;

  -- The requested admissions waiting for a bed in the given wards or in no ward (0171 replaces this).
  create function ehr.inpatient_waiting(requested_facility uuid, requested_wards uuid[])
  returns table (patient_id uuid, admission_id uuid, name_shown boolean, card jsonb)
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select null::uuid, null::uuid, null::boolean, null::jsonb where false
  $fn$;
  revoke all on function ehr.inpatient_waiting(uuid, uuid[]) from public;

  -- A Lagos day's admissions, transfers, discharges, deaths and the midnight count per ward, and the number
  -- waiting for a bed (0171 replaces this).
  create function ehr.inpatient_day_counts(requested_facility uuid, requested_day date)
  returns table (ward_id uuid, admitted integer, transfers_in integer, transfers_out integer, discharged integer,
    died integer, waiting_for_bed integer, midnight_count integer)
  language sql
  stable
  set search_path = pg_catalog, pg_temp
  as $fn$
    select null::uuid, 0, 0, 0, 0, 0, 0, 0 where false
  $fn$;
  revoke all on function ehr.inpatient_day_counts(uuid, date) from public;

  -- Route 1: the facility's wards (counts only), with the beds and staff list when asked.
  create function ehr.ward_list(requested_include_inactive boolean, requested_details boolean)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
  begin
    select * into caller from ehr.inpatient_caller('ward_list', array['direct-care', 'healthcare-operations']);
    return jsonb_build_object('items', coalesce((
      select jsonb_agg(ehr.ward_json(ward.id, coalesce(requested_details, false))
                       order by ward.active desc, lower(ward.name), ward.id)
        from ehr.wards ward
       where ward.facility_id = caller.actor_facility
         and (ward.active or coalesce(requested_include_inactive, false))), '[]'::jsonb));
  end
  $fn$;
  comment on function ehr.ward_list(boolean, boolean) is
    '0170 (ADT-1): this facility''s wards, active first, with counts only (never a patient); inactive ones when asked; each ward''s beds and staff list when asked. Needs ehr.ward.read or ehr.ward.manage.';
  revoke all on function ehr.ward_list(boolean, boolean) from public;

  -- Route 2: a new ward (Q191 A: facility admins).
  create function ehr.ward_create(requested_name text, requested_ward_type text, requested_takes text,
    requested_idempotency_key text, requested_request_sha256 text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    key_state record;
    name_value text := btrim(coalesce(requested_name, ''));
    new_id uuid;
  begin
    select * into caller from ehr.inpatient_caller('ward_manage', array['healthcare-operations']);
    if length(name_value) not between 2 and 80 or name_value ~ '[[:cntrl:]]'
       or requested_ward_type is null
       or requested_ward_type not in ('general', 'paediatric', 'maternity', 'icu', 'private', 'other')
       or coalesce(requested_takes, 'any') not in ('any', 'male', 'female') then
      raise exception using errcode = '22023', message = 'INPATIENT_INVALID';
    end if;
    select * into key_state from ehr.ward_key(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = 'ward_created' then
      return jsonb_build_object('outcome', 'created', 'replayed', true, 'ward', ehr.ward_json(key_state.ward_id, true));
    elsif key_state.state <> 'new' then
      perform ehr.inpatient_audit(null, 'ehr.ward.create', 'denied', 'ward', null,
        jsonb_build_object('refusal', 'key_reused'));
      return jsonb_build_object('outcome', 'key_reused');
    end if;
    perform pg_advisory_xact_lock(hashtextextended('inpatient-ward-name:' || caller.actor_facility::text, 0));
    if exists (select 1 from ehr.wards ward where ward.facility_id = caller.actor_facility and ward.active
                and lower(ward.name) = lower(name_value)) then
      perform ehr.inpatient_audit(null, 'ehr.ward.create', 'denied', 'ward', null,
        jsonb_build_object('refusal', 'name_taken'));
      return jsonb_build_object('outcome', 'name_taken');
    end if;
    insert into ehr.wards (facility_id, organization_id, name, ward_type, takes, created_by_membership_id,
      updated_by_membership_id)
    values (caller.actor_facility, caller.actor_organization, name_value, requested_ward_type,
      coalesce(requested_takes, 'any'), caller.actor_membership, caller.actor_membership)
    returning id into new_id;
    insert into ehr.ward_events (facility_id, ward_id, kind, details, by_account_id, by_membership_id,
      idempotency_key, request_sha256)
    values (caller.actor_facility, new_id, 'ward_created',
      jsonb_build_object('wardType', requested_ward_type, 'takes', coalesce(requested_takes, 'any')),
      caller.actor_account, caller.actor_membership, requested_idempotency_key, requested_request_sha256);
    perform ehr.inpatient_audit(null, 'ehr.ward.create', 'success', 'ward', new_id::text,
      jsonb_build_object('wardType', requested_ward_type, 'takes', coalesce(requested_takes, 'any')));
    return jsonb_build_object('outcome', 'created', 'replayed', false, 'ward', ehr.ward_json(new_id, true));
  end
  $fn$;
  comment on function ehr.ward_create(text, text, text, text, text) is
    '0170 (ADT-1, Q191 A): a new ward of this facility (name 2-80, unique among the active wards in any case; type general, paediatric, maternity, icu, private or other; takes any, male or female). Needs ehr.ward.manage, for healthcare operations. Outcomes created (replayed), name_taken, key_reused. Audited (ehr.ward.create).';
  revoke all on function ehr.ward_create(text, text, text, text, text) from public;

  -- Route 3: change a ward. The type and closing only while no bed of the ward is occupied.
  create function ehr.ward_update(requested_ward uuid, requested_row_version bigint, requested_name text,
    requested_ward_type text, requested_takes text, requested_active boolean, requested_idempotency_key text,
    requested_request_sha256 text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    key_state record;
    ward_row ehr.wards%rowtype;
    name_value text := nullif(btrim(coalesce(requested_name, '')), '');
    refusal text;
  begin
    select * into caller from ehr.inpatient_caller('ward_manage', array['healthcare-operations']);
    if requested_ward is null or requested_row_version is null
       or (requested_name is not null and (name_value is null or length(name_value) not between 2 and 80
                                           or name_value ~ '[[:cntrl:]]'))
       or (requested_ward_type is not null
           and requested_ward_type not in ('general', 'paediatric', 'maternity', 'icu', 'private', 'other'))
       or (requested_takes is not null and requested_takes not in ('any', 'male', 'female'))
       or (requested_name is null and requested_ward_type is null and requested_takes is null
           and requested_active is null) then
      raise exception using errcode = '22023', message = 'INPATIENT_INVALID';
    end if;
    select * into key_state from ehr.ward_key(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = 'ward_updated' and key_state.ward_id = requested_ward then
      return jsonb_build_object('outcome', 'updated', 'replayed', true, 'ward', ehr.ward_json(requested_ward, true));
    end if;
    perform pg_advisory_xact_lock(hashtextextended('inpatient-ward-name:' || caller.actor_facility::text, 0));
    select ward.* into ward_row from ehr.wards ward
     where ward.id = requested_ward and ward.facility_id = caller.actor_facility for update;
    if not found then
      refusal := 'not_found';
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif ward_row.row_version <> requested_row_version then
      refusal := 'changed';
    elsif ((requested_ward_type is not null and requested_ward_type <> ward_row.ward_type)
           or (requested_active is false and ward_row.active))
          and exists (select 1 from ehr.beds bed where bed.ward_id = ward_row.id and bed.status = 'occupied') then
      refusal := 'not_empty';
    elsif (name_value is not null or requested_active is true)
          and coalesce(requested_active, ward_row.active)
          and exists (select 1 from ehr.wards other where other.facility_id = caller.actor_facility and other.active
                       and other.id <> ward_row.id and lower(other.name) = lower(coalesce(name_value, ward_row.name))) then
      refusal := 'name_taken';
    end if;
    if refusal is not null then
      perform ehr.inpatient_audit(null, 'ehr.ward.update', case when refusal = 'not_found' then 'failure' else 'denied' end,
        'ward', requested_ward::text, jsonb_build_object('refusal', refusal));
      return jsonb_build_object('outcome', refusal);
    end if;
    update ehr.wards ward
       set name = coalesce(name_value, ward.name), ward_type = coalesce(requested_ward_type, ward.ward_type),
           takes = coalesce(requested_takes, ward.takes), active = coalesce(requested_active, ward.active),
           updated_by_membership_id = caller.actor_membership, updated_at = clock_timestamp(),
           row_version = ward.row_version + 1
     where ward.id = ward_row.id;
    insert into ehr.ward_events (facility_id, ward_id, kind, details, by_account_id, by_membership_id,
      idempotency_key, request_sha256)
    values (caller.actor_facility, ward_row.id, 'ward_updated',
      jsonb_strip_nulls(jsonb_build_object('nameChanged', name_value is not null and name_value <> ward_row.name,
        'wardType', requested_ward_type, 'takes', requested_takes, 'active', requested_active)),
      caller.actor_account, caller.actor_membership, requested_idempotency_key, requested_request_sha256);
    perform ehr.inpatient_audit(null, 'ehr.ward.update', 'success', 'ward', ward_row.id::text,
      jsonb_strip_nulls(jsonb_build_object('nameChanged', name_value is not null and name_value <> ward_row.name,
        'wardType', requested_ward_type, 'takes', requested_takes, 'active', requested_active)));
    return jsonb_build_object('outcome', 'updated', 'replayed', false, 'ward', ehr.ward_json(ward_row.id, true));
  end
  $fn$;
  comment on function ehr.ward_update(uuid, bigint, text, text, text, boolean, text, text) is
    '0170 (ADT-1): change a ward''s name, type, who it takes, or close or reopen it. The type and closing only while no bed of the ward is occupied (not_empty). Outcomes updated (replayed), not_found, changed, name_taken, not_empty, key_reused. Needs ehr.ward.manage. Audited (ehr.ward.update).';
  revoke all on function ehr.ward_update(uuid, bigint, text, text, text, boolean, text, text) from public;

  -- Route 4: a new bed or overflow space. Up to 200 beds and 50 overflow spaces per ward.
  create function ehr.bed_create(requested_ward uuid, requested_name text, requested_kind text,
    requested_idempotency_key text, requested_request_sha256 text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    key_state record;
    ward_row ehr.wards%rowtype;
    name_value text := btrim(coalesce(requested_name, ''));
    kind_value text := coalesce(requested_kind, 'bed');
    refusal text;
    new_id uuid;
  begin
    select * into caller from ehr.inpatient_caller('ward_manage', array['healthcare-operations']);
    if requested_ward is null or length(name_value) not between 1 and 40 or name_value ~ '[[:cntrl:]]'
       or kind_value not in ('bed', 'overflow') then
      raise exception using errcode = '22023', message = 'INPATIENT_INVALID';
    end if;
    select * into key_state from ehr.ward_key(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = 'bed_created' and key_state.ward_id = requested_ward then
      return jsonb_build_object('outcome', 'created', 'replayed', true, 'bedId', key_state.bed_id,
        'ward', ehr.ward_json(requested_ward, true));
    end if;
    select ward.* into ward_row from ehr.wards ward
     where ward.id = requested_ward and ward.facility_id = caller.actor_facility for update;
    if not found then
      refusal := 'not_found';
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif exists (select 1 from ehr.beds bed where bed.ward_id = ward_row.id and bed.active
                   and lower(bed.name) = lower(name_value)) then
      refusal := 'name_taken';
    elsif (select count(*) from ehr.beds bed where bed.ward_id = ward_row.id and bed.active and bed.kind = kind_value)
          >= (case when kind_value = 'bed' then 200 else 50 end) then
      refusal := 'limit_reached';
    end if;
    if refusal is not null then
      perform ehr.inpatient_audit(null, 'ehr.bed.create', case when refusal = 'not_found' then 'failure' else 'denied' end,
        'ward', requested_ward::text, jsonb_build_object('refusal', refusal));
      return jsonb_build_object('outcome', refusal);
    end if;
    insert into ehr.beds (ward_id, facility_id, name, kind, created_by_membership_id, updated_by_membership_id)
    values (ward_row.id, caller.actor_facility, name_value, kind_value, caller.actor_membership, caller.actor_membership)
    returning id into new_id;
    insert into ehr.bed_status_events (bed_id, facility_id, from_status, to_status, cause, by_membership_id)
    values (new_id, caller.actor_facility, null, 'available', 'created', caller.actor_membership);
    update ehr.wards ward set row_version = ward.row_version + 1, updated_at = clock_timestamp(),
           updated_by_membership_id = caller.actor_membership
     where ward.id = ward_row.id;
    insert into ehr.ward_events (facility_id, ward_id, bed_id, kind, details, by_account_id, by_membership_id,
      idempotency_key, request_sha256)
    values (caller.actor_facility, ward_row.id, new_id, 'bed_created', jsonb_build_object('kind', kind_value),
      caller.actor_account, caller.actor_membership, requested_idempotency_key, requested_request_sha256);
    perform ehr.inpatient_audit(null, 'ehr.bed.create', 'success', 'bed', new_id::text,
      jsonb_build_object('wardId', ward_row.id, 'kind', kind_value));
    return jsonb_build_object('outcome', 'created', 'replayed', false, 'bedId', new_id,
      'ward', ehr.ward_json(ward_row.id, true));
  end
  $fn$;
  comment on function ehr.bed_create(uuid, text, text, text, text) is
    '0170 (ADT-1, Q186 A): a new bed or named overflow space of a ward of this facility (name 1-40, unique among the ward''s active beds in any case; at most 200 beds and 50 overflow spaces). Outcomes created (replayed), not_found, name_taken, limit_reached, key_reused. Needs ehr.ward.manage. Audited (ehr.bed.create).';
  revoke all on function ehr.bed_create(uuid, text, text, text, text) from public;

  -- Route 5: rename a bed, or take it out of use (never while occupied) or back.
  create function ehr.bed_update(requested_bed uuid, requested_row_version bigint, requested_name text,
    requested_active boolean, requested_idempotency_key text, requested_request_sha256 text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    key_state record;
    bed_row ehr.beds%rowtype;
    name_value text := nullif(btrim(coalesce(requested_name, '')), '');
    refusal text;
  begin
    select * into caller from ehr.inpatient_caller('ward_manage', array['healthcare-operations']);
    if requested_bed is null or requested_row_version is null
       or (requested_name is not null and (name_value is null or length(name_value) not between 1 and 40
                                           or name_value ~ '[[:cntrl:]]'))
       or (requested_name is null and requested_active is null) then
      raise exception using errcode = '22023', message = 'INPATIENT_INVALID';
    end if;
    select * into key_state from ehr.ward_key(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = 'bed_updated' and key_state.bed_id = requested_bed then
      return jsonb_build_object('outcome', 'updated', 'replayed', true, 'bedId', requested_bed,
        'ward', ehr.ward_json(key_state.ward_id, true));
    end if;
    select bed.* into bed_row from ehr.beds bed
     where bed.id = requested_bed and bed.facility_id = caller.actor_facility for update;
    if not found then
      refusal := 'not_found';
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif bed_row.row_version <> requested_row_version then
      refusal := 'changed';
    elsif requested_active is false and bed_row.status = 'occupied' then
      refusal := 'occupied';
    elsif coalesce(requested_active, bed_row.active)
          and exists (select 1 from ehr.beds other where other.ward_id = bed_row.ward_id and other.active
                       and other.id <> bed_row.id and lower(other.name) = lower(coalesce(name_value, bed_row.name))) then
      refusal := 'name_taken';
    elsif requested_active is true and not bed_row.active
          and (select count(*) from ehr.beds bed where bed.ward_id = bed_row.ward_id and bed.active
                and bed.kind = bed_row.kind) >= (case when bed_row.kind = 'bed' then 200 else 50 end) then
      refusal := 'limit_reached';
    end if;
    if refusal is not null then
      perform ehr.inpatient_audit(null, 'ehr.bed.update', case when refusal = 'not_found' then 'failure' else 'denied' end,
        'bed', requested_bed::text, jsonb_build_object('refusal', refusal));
      return jsonb_build_object('outcome', refusal);
    end if;
    update ehr.beds bed
       set name = coalesce(name_value, bed.name), active = coalesce(requested_active, bed.active),
           updated_by_membership_id = caller.actor_membership, updated_at = clock_timestamp(),
           row_version = bed.row_version + 1
     where bed.id = bed_row.id;
    insert into ehr.ward_events (facility_id, ward_id, bed_id, kind, details, by_account_id, by_membership_id,
      idempotency_key, request_sha256)
    values (caller.actor_facility, bed_row.ward_id, bed_row.id, 'bed_updated',
      jsonb_strip_nulls(jsonb_build_object('nameChanged', name_value is not null and name_value <> bed_row.name,
        'active', requested_active)),
      caller.actor_account, caller.actor_membership, requested_idempotency_key, requested_request_sha256);
    perform ehr.inpatient_audit(null, 'ehr.bed.update', 'success', 'bed', bed_row.id::text,
      jsonb_strip_nulls(jsonb_build_object('nameChanged', name_value is not null and name_value <> bed_row.name,
        'active', requested_active)));
    return jsonb_build_object('outcome', 'updated', 'replayed', false, 'bedId', bed_row.id,
      'ward', ehr.ward_json(bed_row.ward_id, true));
  end
  $fn$;
  comment on function ehr.bed_update(uuid, bigint, text, boolean, text, text) is
    '0170 (ADT-1): rename a bed, or take it out of use (never while occupied) or back. A bed is never deleted. Outcomes updated (replayed), not_found, changed, occupied, name_taken, limit_reached, key_reused. Needs ehr.ward.manage. Audited (ehr.bed.update).';
  revoke all on function ehr.bed_update(uuid, bigint, text, boolean, text, text) from public;

  -- Route 6: the ward's staff list (0-200 active nurse, clinician or doctor memberships here).
  create function ehr.ward_staff_set(requested_ward uuid, requested_row_version bigint, requested_members uuid[],
    requested_idempotency_key text, requested_request_sha256 text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    key_state record;
    ward_row ehr.wards%rowtype;
    members uuid[] := coalesce((select array_agg(distinct member) from unnest(requested_members) member
                                 where member is not null), array[]::uuid[]);
    refusal text;
  begin
    select * into caller from ehr.inpatient_caller('ward_manage', array['healthcare-operations']);
    if requested_ward is null or requested_row_version is null or requested_members is null
       or cardinality(members) > 200 or exists (select 1 from unnest(requested_members) member where member is null) then
      raise exception using errcode = '22023', message = 'INPATIENT_INVALID';
    end if;
    select * into key_state from ehr.ward_key(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = 'staff_set' and key_state.ward_id = requested_ward then
      return jsonb_build_object('outcome', 'updated', 'replayed', true, 'ward', ehr.ward_json(requested_ward, true));
    end if;
    select ward.* into ward_row from ehr.wards ward
     where ward.id = requested_ward and ward.facility_id = caller.actor_facility for update;
    if not found then
      refusal := 'not_found';
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif ward_row.row_version <> requested_row_version then
      refusal := 'changed';
    elsif exists (select 1 from unnest(members) member
                   where not ehr.inpatient_member_has_role(member, caller.actor_facility,
                                                           array['nurse', 'clinician', 'doctor'])) then
      refusal := 'staff_invalid';
    end if;
    if refusal is not null then
      perform ehr.inpatient_audit(null, 'ehr.ward.staff-set', case when refusal = 'not_found' then 'failure' else 'denied' end,
        'ward', requested_ward::text, jsonb_build_object('refusal', refusal));
      return jsonb_build_object('outcome', refusal);
    end if;
    delete from ehr.ward_staff staff where staff.ward_id = ward_row.id and not staff.membership_id = any (members);
    insert into ehr.ward_staff (ward_id, membership_id, facility_id, added_by_membership_id)
    select ward_row.id, member, caller.actor_facility, caller.actor_membership from unnest(members) member
    on conflict (ward_id, membership_id) do nothing;
    update ehr.wards ward set row_version = ward.row_version + 1, updated_at = clock_timestamp(),
           updated_by_membership_id = caller.actor_membership
     where ward.id = ward_row.id;
    insert into ehr.ward_events (facility_id, ward_id, kind, details, by_account_id, by_membership_id,
      idempotency_key, request_sha256)
    values (caller.actor_facility, ward_row.id, 'staff_set',
      jsonb_build_object('membershipIds', to_jsonb(members), 'count', cardinality(members)),
      caller.actor_account, caller.actor_membership, requested_idempotency_key, requested_request_sha256);
    perform ehr.inpatient_audit(null, 'ehr.ward.staff-set', 'success', 'ward', ward_row.id::text,
      jsonb_build_object('count', cardinality(members), 'membershipIds', to_jsonb(members)));
    return jsonb_build_object('outcome', 'updated', 'replayed', false, 'ward', ehr.ward_json(ward_row.id, true));
  end
  $fn$;
  comment on function ehr.ward_staff_set(uuid, bigint, uuid[], text, text) is
    '0170 (ADT-1): replace a ward''s staff list (0-200 active nurse, clinician or doctor memberships of this facility; staff_invalid otherwise). The list never opens a chart by itself. Outcomes updated (replayed), not_found, changed, staff_invalid, key_reused. Needs ehr.ward.manage. Audited (ehr.ward.staff-set).';
  revoke all on function ehr.ward_staff_set(uuid, bigint, uuid[], text, text) from public;

  -- Route 7: the bed board of one ward, or of every active ward of a type.
  create function ehr.bed_board(requested_ward uuid, requested_ward_type text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    ward_ids uuid[];
    occupants jsonb;
    waiting jsonb;
    shown jsonb;
    shown_patients uuid[];
    result jsonb;
  begin
    select * into caller from ehr.inpatient_caller('ward_read', array['direct-care']);
    if (requested_ward is null) = (requested_ward_type is null)
       or (requested_ward_type is not null
           and requested_ward_type not in ('general', 'paediatric', 'maternity', 'icu', 'private', 'other')) then
      raise exception using errcode = '22023', message = 'INPATIENT_INVALID';
    end if;
    select coalesce(array_agg(ward.id order by lower(ward.name), ward.id), array[]::uuid[]) into ward_ids
      from ehr.wards ward
     where ward.facility_id = caller.actor_facility
       and ((requested_ward is not null and ward.id = requested_ward)
            or (requested_ward is null and ward.active and ward.ward_type = requested_ward_type));
    if requested_ward is not null and cardinality(ward_ids) = 0 then
      perform ehr.inpatient_audit(null, 'ehr.bed-board', 'failure', 'ward', requested_ward::text,
        jsonb_build_object('refusal', 'not_found'));
      return jsonb_build_object('outcome', 'not_found');
    end if;

    select coalesce(jsonb_agg(jsonb_build_object('bedId', occupant.bed_id, 'patientId', occupant.patient_id,
             'admissionId', occupant.admission_id, 'nameShown', occupant.name_shown, 'card', occupant.card)),
             '[]'::jsonb)
      into occupants from ehr.inpatient_bed_occupants(caller.actor_facility, ward_ids) occupant;
    select coalesce(jsonb_agg(jsonb_build_object('patientId', waiting_row.patient_id,
             'admissionId', waiting_row.admission_id, 'nameShown', waiting_row.name_shown, 'card', waiting_row.card)
             order by waiting_row.card->>'requestedAt', waiting_row.admission_id), '[]'::jsonb)
      into waiting from ehr.inpatient_waiting(caller.actor_facility, ward_ids) waiting_row;

    select jsonb_build_object('outcome', 'found', 'wards', coalesce(jsonb_agg(jsonb_build_object(
        'wardId', ward.id, 'name', ward.name, 'wardType', ward.ward_type, 'takes', ward.takes, 'active', ward.active,
        'beds', coalesce((select jsonb_agg(jsonb_build_object(
            'bedId', bed.id, 'name', bed.name, 'kind', bed.kind, 'status', bed.status, 'statusSince', bed.status_since,
            'rowVersion', bed.row_version,
            'patient', (select occupant->'card' from jsonb_array_elements(occupants) occupant
                         where (occupant->>'bedId')::uuid = bed.id limit 1))
            order by bed.kind, lower(bed.name), bed.id)
          from ehr.beds bed where bed.ward_id = ward.id and bed.active), '[]'::jsonb))
        order by ordering.ord), '[]'::jsonb),
      'waitingForBed', coalesce((select jsonb_agg(waiting_row.value->'card' order by waiting_row.ord)
          from jsonb_array_elements(waiting) with ordinality waiting_row(value, ord)), '[]'::jsonb))
      into result
      from unnest(ward_ids) with ordinality ordering(id, ord)
      join ehr.wards ward on ward.id = ordering.id;

    shown := (select coalesce(jsonb_agg(listed.value), '[]'::jsonb)
                from (select occupant.value || jsonb_build_object('waitingForBed', false) as value
                        from jsonb_array_elements(occupants) occupant
                      union all
                      select waiting_row.value || jsonb_build_object('waitingForBed', true)
                        from jsonb_array_elements(waiting) waiting_row) listed);
    select coalesce(array_agg(distinct (listed->>'patientId')::uuid), array[]::uuid[]) into shown_patients
      from jsonb_array_elements(shown) listed;
    perform ehr.inpatient_audit(null, 'ehr.bed-board', 'success', 'bed-board', null,
      jsonb_build_object('wardIds', to_jsonb(ward_ids), 'wardType', requested_ward_type,
        'resultCount', cardinality(shown_patients), 'hasMore', false, 'patientIds', to_jsonb(shown_patients)));
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
      purpose_of_use, provenance, source_system, details
    )
    select caller.actor_correlation, 'staff', caller.actor_subject, caller.actor_account, caller.actor_membership,
           caller.actor_organization, caller.actor_facility, (listed->>'patientId')::uuid, 'ehr.bed-board.shown',
           'success', 'admission', listed->>'admissionId', caller.actor_purpose, 'application', 'ehr-api',
           jsonb_build_object('nameShown', (listed->>'nameShown')::boolean,
             'waitingForBed', (listed->>'waitingForBed')::boolean)
      from jsonb_array_elements(shown) listed
     order by listed->>'admissionId';
    return result;
  end
  $fn$;
  comment on function ehr.bed_board(uuid, text) is
    '0170 (ADT-1): the bed board of one ward of this facility (closed ones too), or of every active ward of a type (wardType icu is the ICU page): each active bed with its status and, when occupied, the patient''s card (0171), and the admissions waiting for a bed in those wards or in no ward. Names follow Q190 (ehr.ward_patient_name_visible). Needs ehr.ward.read, for direct care. Audited: one ehr.bed-board row with the patient ids shown, and one ehr.bed-board.shown row per patient with whether the name was shown.';
  revoke all on function ehr.bed_board(uuid, text) from public;

  -- Route 8: the census (counts only), today or a past Lagos day up to 90 days back.
  create function ehr.inpatient_census(requested_day date)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
    day_value date := coalesce(requested_day, (clock_timestamp() at time zone 'Africa/Lagos')::date);
    day_end timestamptz;
    wards jsonb;
    facility_counts jsonb;
  begin
    select * into caller from ehr.inpatient_caller('ward_read', array['direct-care']);
    if day_value > today or day_value < today - 90 then
      raise exception using errcode = '22023', message = 'INPATIENT_INVALID';
    end if;
    day_end := least(((day_value + 1)::timestamp at time zone 'Africa/Lagos'), clock_timestamp());
    -- Each bed's status at the end of the day (now for today): its last status change before then.
    with bed_counts as (
      select ward.id as ward_id, ward.name, ward.ward_type,
             count(bed_state.bed_id)::integer as beds,
             count(bed_state.bed_id) filter (where bed_state.status = 'occupied')::integer as occupied,
             count(bed_state.bed_id) filter (where bed_state.status = 'available')::integer as available,
             count(bed_state.bed_id) filter (where bed_state.status = 'cleaning')::integer as cleaning,
             count(bed_state.bed_id) filter (where bed_state.status = 'maintenance')::integer as maintenance,
             count(bed_state.bed_id) filter (where bed_state.status = 'occupied'
                                              and bed_state.kind = 'overflow')::integer as overflow_in_use
        from ehr.wards ward
        left join lateral (
          select bed.id as bed_id, bed.kind,
                 coalesce((select event.to_status from ehr.bed_status_events event
                            where event.bed_id = bed.id and event.at < day_end
                            order by event.sequence_no desc limit 1), 'available') as status
            from ehr.beds bed
           where bed.ward_id = ward.id and bed.active and bed.created_at < day_end) bed_state on true
       where ward.facility_id = caller.actor_facility and ward.active
       group by ward.id, ward.name, ward.ward_type),
    day_counts as (
      select counted.* from ehr.inpatient_day_counts(caller.actor_facility, day_value) counted),
    census_rows as (
      select bed_counts.*, coalesce(day_counts.admitted, 0) as admitted,
             coalesce(day_counts.transfers_in, 0) as transfers_in,
             coalesce(day_counts.transfers_out, 0) as transfers_out,
             coalesce(day_counts.discharged, 0) as discharged, coalesce(day_counts.died, 0) as died,
             coalesce(day_counts.waiting_for_bed, 0) as waiting_for_bed,
             coalesce(day_counts.midnight_count, 0) as midnight_count
        from bed_counts left join day_counts on day_counts.ward_id = bed_counts.ward_id)
    select coalesce(jsonb_agg(jsonb_build_object('wardId', census_row.ward_id, 'name', census_row.name,
             'wardType', census_row.ward_type, 'beds', census_row.beds, 'occupied', census_row.occupied,
             'available', census_row.available, 'cleaning', census_row.cleaning,
             'maintenance', census_row.maintenance, 'overflowInUse', census_row.overflow_in_use,
             'admitted', census_row.admitted, 'transfersIn', census_row.transfers_in,
             'transfersOut', census_row.transfers_out, 'discharged', census_row.discharged, 'died', census_row.died,
             'waitingForBed', census_row.waiting_for_bed, 'midnightCount', census_row.midnight_count)
             order by lower(census_row.name), census_row.ward_id), '[]'::jsonb),
           jsonb_build_object('beds', coalesce(sum(census_row.beds), 0), 'occupied', coalesce(sum(census_row.occupied), 0),
             'available', coalesce(sum(census_row.available), 0), 'cleaning', coalesce(sum(census_row.cleaning), 0),
             'maintenance', coalesce(sum(census_row.maintenance), 0),
             'overflowInUse', coalesce(sum(census_row.overflow_in_use), 0),
             'admitted', coalesce(sum(census_row.admitted), 0), 'transfersIn', coalesce(sum(census_row.transfers_in), 0),
             'transfersOut', coalesce(sum(census_row.transfers_out), 0),
             'discharged', coalesce(sum(census_row.discharged), 0), 'died', coalesce(sum(census_row.died), 0),
             'waitingForBed', coalesce(sum(census_row.waiting_for_bed), 0)
               + coalesce((select sum(day_counts.waiting_for_bed) from day_counts where day_counts.ward_id is null), 0),
             'midnightCount', coalesce(sum(census_row.midnight_count), 0))
      into wards, facility_counts
      from census_rows census_row;
    perform ehr.inpatient_audit(null, 'ehr.census', 'success', 'census', null,
      jsonb_build_object('date', day_value));
    return jsonb_build_object('date', day_value, 'facility', facility_counts, 'wards', wards);
  end
  $fn$;
  comment on function ehr.inpatient_census(date) is
    '0170 (ADT-1): the facility''s census for today or a past Lagos day (up to 90 days back): per active ward and for the facility, the beds and their statuses at the end of the day (now for today), overflow in use, and the day''s admissions, transfers, discharges, deaths, waiting for a bed and the midnight count (0171). Counts only, never a patient. Needs ehr.ward.read, for direct care. Audited (ehr.census, no patient).';
  revoke all on function ehr.inpatient_census(date) from public;

  -- Route 9: a bed's status by hand (the design's three actions, and available -> cleaning). Occupied is set by an
  -- admission, never by hand.
  create function ehr.bed_set_status(requested_bed uuid, requested_row_version bigint, requested_status text,
    requested_note text, requested_idempotency_key text, requested_request_sha256 text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    caller record;
    key_state record;
    bed_row ehr.beds%rowtype;
    note_value text := nullif(btrim(coalesce(requested_note, '')), '');
    cause_value text;
    refusal text;
  begin
    select * into caller from ehr.inpatient_caller('bed_status', array['direct-care', 'healthcare-operations']);
    if requested_bed is null or requested_row_version is null
       or requested_status is null or requested_status not in ('available', 'cleaning', 'maintenance')
       or (note_value is not null and (length(note_value) > 300 or note_value ~ '[[:cntrl:]]')) then
      raise exception using errcode = '22023', message = 'INPATIENT_INVALID';
    end if;
    select * into key_state from ehr.ward_key(caller.actor_membership, requested_idempotency_key,
      requested_request_sha256);
    if key_state.state = 'replay' and key_state.kind = 'bed_status' and key_state.bed_id = requested_bed then
      return jsonb_build_object('outcome', 'updated', 'replayed', true,
        'bed', (select jsonb_build_object('bedId', bed.id, 'name', bed.name, 'kind', bed.kind, 'status', bed.status,
                  'statusSince', bed.status_since, 'rowVersion', bed.row_version) from ehr.beds bed
                 where bed.id = requested_bed));
    end if;
    select bed.* into bed_row from ehr.beds bed
     where bed.id = requested_bed and bed.facility_id = caller.actor_facility for update;
    if not found then
      refusal := 'not_found';
    elsif key_state.state <> 'new' then
      refusal := 'key_reused';
    elsif bed_row.row_version <> requested_row_version then
      refusal := 'changed';
    elsif bed_row.status = 'occupied' then
      refusal := 'occupied';
    elsif not bed_row.active then
      refusal := 'status_invalid';
    else
      cause_value := case
        when bed_row.status = 'cleaning' and requested_status = 'available' then 'turnover'
        when bed_row.status = 'available' and requested_status = 'maintenance' then 'maintenance'
        when bed_row.status = 'maintenance' and requested_status = 'available' then 'release'
        when bed_row.status = 'available' and requested_status = 'cleaning' then 'cleaning' end;
      if cause_value is null then
        refusal := 'status_invalid';
      elsif cause_value = 'maintenance' and (note_value is null or length(note_value) < 8) then
        refusal := 'note_required';
      end if;
    end if;
    if refusal is not null then
      perform ehr.inpatient_audit(null, 'ehr.bed.status', case when refusal = 'not_found' then 'failure' else 'denied' end,
        'bed', requested_bed::text, jsonb_build_object('refusal', refusal, 'toStatus', requested_status));
      return jsonb_build_object('outcome', refusal);
    end if;
    update ehr.beds bed
       set status = requested_status, status_since = clock_timestamp(),
           updated_by_membership_id = caller.actor_membership, updated_at = clock_timestamp(),
           row_version = bed.row_version + 1
     where bed.id = bed_row.id;
    insert into ehr.bed_status_events (bed_id, facility_id, from_status, to_status, cause, note, by_membership_id)
    values (bed_row.id, caller.actor_facility, bed_row.status, requested_status, cause_value, note_value,
      caller.actor_membership);
    insert into ehr.ward_events (facility_id, ward_id, bed_id, kind, details, by_account_id, by_membership_id,
      idempotency_key, request_sha256)
    values (caller.actor_facility, bed_row.ward_id, bed_row.id, 'bed_status',
      jsonb_build_object('fromStatus', bed_row.status, 'toStatus', requested_status, 'cause', cause_value),
      caller.actor_account, caller.actor_membership, requested_idempotency_key, requested_request_sha256);
    perform ehr.inpatient_audit(null, 'ehr.bed.status', 'success', 'bed', bed_row.id::text,
      jsonb_build_object('fromStatus', bed_row.status, 'toStatus', requested_status, 'cause', cause_value,
        'noteGiven', note_value is not null));
    return jsonb_build_object('outcome', 'updated', 'replayed', false,
      'bed', (select jsonb_build_object('bedId', bed.id, 'name', bed.name, 'kind', bed.kind, 'status', bed.status,
                'statusSince', bed.status_since, 'rowVersion', bed.row_version) from ehr.beds bed
               where bed.id = bed_row.id));
  end
  $fn$;
  comment on function ehr.bed_set_status(uuid, bigint, text, text, text, text) is
    '0170 (ADT-1): a bed''s status by hand: cleaning -> available ("Complete bed turnover", note optional), available -> maintenance ("Place in maintenance", a reason of 8-300 characters), maintenance -> available ("Release from maintenance"), available -> cleaning. Never from or to occupied. Outcomes updated (replayed), not_found, changed, occupied, status_invalid, note_required, key_reused. Needs ehr.bed.allocate or ehr.ward.manage. Audited (ehr.bed.status; never the note).';
  revoke all on function ehr.bed_set_status(uuid, bigint, text, text, text, text) from public;

  -- Owners and EXECUTE (as 0135: the owner of identity.has_active_consent_grant).
  if v_owner <> current_user then
    execute format('alter table ehr.wards owner to %I', v_owner);
    execute format('alter table ehr.beds owner to %I', v_owner);
    execute format('alter table ehr.bed_status_events owner to %I', v_owner);
    execute format('alter table ehr.ward_staff owner to %I', v_owner);
    execute format('alter table ehr.ward_events owner to %I', v_owner);
    execute format('alter table ehr.inpatient_switches owner to %I', v_owner);
    execute (select string_agg(format('alter function %s owner to %I', proc.oid::regprocedure, v_owner), '; ')
               from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
              where namespace.nspname = 'ehr'
                and (proc.proname like 'ward\_%' or proc.proname like 'bed\_%' or proc.proname like 'inpatient\_%'));
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_ehr_runtime') then
    grant execute on function
      ehr.ward_list(boolean, boolean),
      ehr.ward_create(text, text, text, text, text),
      ehr.ward_update(uuid, bigint, text, text, text, boolean, text, text),
      ehr.bed_create(uuid, text, text, text, text),
      ehr.bed_update(uuid, bigint, text, boolean, text, text),
      ehr.ward_staff_set(uuid, bigint, uuid[], text, text),
      ehr.bed_board(uuid, text),
      ehr.inpatient_census(date),
      ehr.bed_set_status(uuid, bigint, text, text, text, text)
      to hid_ehr_runtime;
  end if;

  -- 3. Post-checks.
  if exists (select 1 from pg_class class_row,
                    lateral aclexplode(coalesce(class_row.relacl, acldefault('r', class_row.relowner))) acl
              where class_row.oid in ('ehr.wards'::regclass, 'ehr.beds'::regclass, 'ehr.bed_status_events'::regclass,
                                      'ehr.ward_staff'::regclass, 'ehr.ward_events'::regclass,
                                      'ehr.inpatient_switches'::regclass)
                and acl.grantee <> class_row.relowner)
     or (select count(*) from pg_class
          where oid in ('ehr.wards'::regclass, 'ehr.beds'::regclass, 'ehr.bed_status_events'::regclass,
                        'ehr.ward_staff'::regclass, 'ehr.ward_events'::regclass, 'ehr.inpatient_switches'::regclass)
            and relrowsecurity) <> 6
     or exists (select 1 from pg_policy where polrelid in ('ehr.wards'::regclass, 'ehr.beds'::regclass,
                  'ehr.bed_status_events'::regclass, 'ehr.ward_staff'::regclass, 'ehr.ward_events'::regclass,
                  'ehr.inpatient_switches'::regclass)) then
    raise exception using errcode = '55000',
      message = '0170: post-check failed (a table is granted to a role, has a policy or lacks row-level security)';
  end if;
  if (select string_agg(switch_row.key || '=' || switch_row.enabled::text, ',' order by switch_row.key)
        from ehr.inpatient_switches switch_row)
     is distinct from 'board_names_for_ward_staff=false,death_record=false,ward_stay_access=false' then
    raise exception using errcode = '55000', message = '0170: post-check failed (the switches)';
  end if;
  if exists (select 1 from pg_proc proc
               join pg_namespace namespace on namespace.oid = proc.pronamespace,
               lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where namespace.nspname = 'ehr'
                and (proc.proname like 'ward\_%' or proc.proname like 'bed\_%' or proc.proname like 'inpatient\_%')
                and acl.grantee <> proc.proowner
                and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_ehr_runtime'
                     or proc.proname not in ('ward_list', 'ward_create', 'ward_update', 'bed_create', 'bed_update',
                                             'ward_staff_set', 'bed_board', 'inpatient_census', 'bed_set_status')))
     or (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where namespace.nspname = 'ehr'
            and (proc.proname like 'ward\_%' or proc.proname like 'bed\_%' or proc.proname like 'inpatient\_%')
            and proc.prosecdef) <> 9
     or (select count(*) from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
          where namespace.nspname = 'ehr'
            and (proc.proname like 'ward\_%' or proc.proname like 'bed\_%' or proc.proname like 'inpatient\_%')) <> 20
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where namespace.nspname = 'ehr'
                   and (proc.proname like 'ward\_%' or proc.proname like 'bed\_%' or proc.proname like 'inpatient\_%')
                   and proc.proconfig is distinct from array['search_path=pg_catalog, pg_temp']) then
    raise exception using errcode = '55000', message = '0170: post-check failed (the functions'' security or grants)';
  end if;
  if (select count(*) from pg_trigger trigger_row
       where (trigger_row.tgrelid, trigger_row.tgname) in (('ehr.bed_status_events'::regclass, 'bed_status_events_immutable'),
               ('ehr.ward_events'::regclass, 'ward_events_immutable'))
         and trigger_row.tgenabled = 'O') <> 2 then
    raise exception using errcode = '55000', message = '0170: post-check failed (the triggers)';
  end if;

  -- Post-check, sequences (0168's form). The sequences the 6 new tables own: exactly the identity
  -- sequences of ehr.bed_status_events.sequence_no, ehr.ward_events.sequence_no, each the owner's (v_owner, as its table) and
  -- granted to no other role. (runtime-grants.sql takes them back from hid_ehr_runtime and hid_schema_test_runtime
  -- after its schema-wide sequence grants; a file never grants a runtime a new identity sequence.)
  if (select count(*) from pg_depend dependency join pg_class sequence_row on sequence_row.oid = dependency.objid
       where dependency.classid = 'pg_class'::regclass and dependency.refclassid = 'pg_class'::regclass
         and dependency.deptype in ('a', 'i') and sequence_row.relkind = 'S'
         and dependency.refobjid in ('ehr.wards'::regclass, 'ehr.beds'::regclass, 'ehr.bed_status_events'::regclass,
           'ehr.ward_staff'::regclass, 'ehr.ward_events'::regclass, 'ehr.inpatient_switches'::regclass)) <> 2
     or exists (select 1
                  from (values ('ehr.bed_status_events', 'ehr.bed_status_events_sequence_no_seq'),
                          ('ehr.ward_events', 'ehr.ward_events_sequence_no_seq')) expected(relation, sequence_name)
                 where to_regclass(expected.sequence_name)
                       is distinct from to_regclass(pg_get_serial_sequence(expected.relation, 'sequence_no'))
                    or (select sequence_row.relowner from pg_class sequence_row
                         where sequence_row.oid = to_regclass(expected.sequence_name))
                       is distinct from (select role_row.oid from pg_roles role_row where role_row.rolname = v_owner)
                    or exists (select 1 from pg_class sequence_row,
                                      lateral aclexplode(coalesce(sequence_row.relacl, acldefault('s', sequence_row.relowner))) acl
                                where sequence_row.oid = to_regclass(expected.sequence_name)
                                  and acl.grantee <> sequence_row.relowner)) then
    raise exception using errcode = '55000',
      message = '0170: post-check failed (a sequence of the new tables is granted to a role or is not the owner''s)';
  end if;
  -- End of the sequences' post-check.
  -- Post-check, rows: no row of audit.events written.
  if (select string_agg(format('%s %s/%s/%s', watched.relation, pg_stat_get_xact_tuples_inserted(watched.relation),
               pg_stat_get_xact_tuples_updated(watched.relation), pg_stat_get_xact_tuples_deleted(watched.relation)),
               ', ' order by watched.ord)
        from unnest(array['audit.events']::regclass[]) with ordinality watched(relation, ord))
     is distinct from v_writes_before then
    raise exception using errcode = '55000', message = '0170: post-check failed (it wrote a row of a table '
      || 'it must not write; counters before: ' || v_writes_before || ')';
  end if;
  -- Post-check, triggers (0152's form). The 2 triggers this file makes, each by its table, name, events
  -- (pg_trigger.tgtype: 1 for each row, 2 before, 4 insert, 8 delete, 16 update, 32 truncate), UPDATE OF columns
  -- (tgattr, '' for none) and function; with no WHEN condition, no arguments, enabled in origin mode, not internal,
  -- not a constraint trigger and with no transition table (a WHEN condition or an UPDATE OF list leaves tgtype as it
  -- is, so each is held apart).
  -- No other trigger on the 6 tables this file makes (they hold 2).
  if (select count(*)
        from (values
      ('ehr.bed_status_events', 'bed_status_events_immutable', 27, 'ehr.bed_status_events_immutable()', ''),
      ('ehr.ward_events', 'ward_events_immutable', 27, 'ehr.bed_status_events_immutable()', '')
        ) expected(relation, name, events, function_signature, columns)
        join pg_trigger trigger_row on trigger_row.tgrelid = expected.relation::regclass
         and trigger_row.tgname = expected.name and trigger_row.tgtype = expected.events
         and trigger_row.tgfoid = to_regprocedure(expected.function_signature)
       where not trigger_row.tgisinternal and trigger_row.tgenabled = 'O' and trigger_row.tgnargs = 0
         and trigger_row.tgqual is null and trigger_row.tgconstraint = 0 and trigger_row.tgoldtable is null
         and trigger_row.tgnewtable is null
         and coalesce((select string_agg(attribute_row.attname, ',' order by attribute_row.attnum)
                         from pg_attribute attribute_row
                        where attribute_row.attrelid = trigger_row.tgrelid
                          and attribute_row.attnum = any (trigger_row.tgattr::int2[])), '') = expected.columns
         and cardinality(trigger_row.tgattr::int2[]) = coalesce(cardinality(string_to_array(nullif(expected.columns, ''), ',')), 0)
     ) <> 2
     or (select count(*) from pg_trigger trigger_row where not trigger_row.tgisinternal
          and trigger_row.tgrelid in ('ehr.wards'::regclass, 'ehr.beds'::regclass, 'ehr.bed_status_events'::regclass,
            'ehr.ward_staff'::regclass, 'ehr.ward_events'::regclass, 'ehr.inpatient_switches'::regclass)) <> 2 then
    raise exception using errcode = '55000', message = '0170: post-check failed (the triggers, in 0152''s form)';
  end if;
  -- End of the triggers' post-check.
  -- Post-check, functions (0168's form). The 20 functions this file makes (20) or replaces (0):
  -- each a plain function with its SECURITY DEFINER setting, volatility, body (the md5 of prosrc) and fixed
  -- search_path as written here. Those it makes are the owner's (v_owner), with EXECUTE for exactly the runtimes
  -- listed (the entry points, when the role exists) and for no other role (none on the helpers); CREATE OR REPLACE
  -- keeps a replaced function's owner and grants.
  select string_agg(expected.signature, ', ' order by expected.signature) into v_post_mismatch
    from (values
      ('ehr.bed_status_events_immutable()', false, false, 'v', '1c388f655b535bf07b736a995ca8a588',
       'search_path=pg_catalog, pg_temp', array[]::text[]),
      ('ehr.inpatient_member_has_role(uuid,uuid,text[])', false, false, 's', '6fe87cf420a6ee48fa20f397191aa866',
       'search_path=pg_catalog, pg_temp', array[]::text[]),
      ('ehr.inpatient_caller(text,text[])', false, false, 's', '605009e6aa061d48680c7a01463095f8',
       'search_path=pg_catalog, pg_temp', array[]::text[]),
      ('ehr.inpatient_audit(uuid,text,text,text,text,jsonb)', false, false, 'v', '81c360af02e3cd2ddb8f3a4fb3041dd2',
       'search_path=pg_catalog, pg_temp', array[]::text[]),
      ('ehr.ward_key(uuid,text,text)', false, false, 'v', '18d86f876044fec21ac0467a58bde55b',
       'search_path=pg_catalog, pg_temp', array[]::text[]),
      ('ehr.ward_json(uuid,boolean)', false, false, 's', 'd8ec8be15d8d52d32d1c1f40c37b4ce9',
       'search_path=pg_catalog, pg_temp', array[]::text[]),
      ('ehr.inpatient_chart_blocked(uuid,uuid,uuid,uuid)', false, false, 's', '77c70b509fd1914d601dd9391cc921bc',
       'search_path=pg_catalog, pg_temp', array[]::text[]),
      ('ehr.ward_patient_name_visible(uuid,uuid)', false, false, 's', '32db17d5e8974a112c2cdf1f21d7bcec',
       'search_path=pg_catalog, pg_temp', array[]::text[]),
      ('ehr.inpatient_bed_occupants(uuid,uuid[])', false, false, 's', 'ef7fdc71d0e22a5f7ea179a432da1125',
       'search_path=pg_catalog, pg_temp', array[]::text[]),
      ('ehr.inpatient_waiting(uuid,uuid[])', false, false, 's', '4fe910433909cce113d9bbdeff3902d9',
       'search_path=pg_catalog, pg_temp', array[]::text[]),
      ('ehr.inpatient_day_counts(uuid,date)', false, false, 's', '6664ebd5a34ce8e017aa8ab9f05507eb',
       'search_path=pg_catalog, pg_temp', array[]::text[]),
      ('ehr.ward_list(boolean,boolean)', false, true, 'v', 'a803e00dd05077235fb60de35dbc30ab',
       'search_path=pg_catalog, pg_temp', array['hid_ehr_runtime']),
      ('ehr.ward_create(text,text,text,text,text)', false, true, 'v', '10313e45398457d77e2416c53db9ab7c',
       'search_path=pg_catalog, pg_temp', array['hid_ehr_runtime']),
      ('ehr.ward_update(uuid,bigint,text,text,text,boolean,text,text)', false, true, 'v', 'c0cf4e711058ae6701390530ef8b90c8',
       'search_path=pg_catalog, pg_temp', array['hid_ehr_runtime']),
      ('ehr.bed_create(uuid,text,text,text,text)', false, true, 'v', '30817a545ba77fed50d3b89046c2cf2d',
       'search_path=pg_catalog, pg_temp', array['hid_ehr_runtime']),
      ('ehr.bed_update(uuid,bigint,text,boolean,text,text)', false, true, 'v', '4a54101acc4f75bb59bdc992b1f1744b',
       'search_path=pg_catalog, pg_temp', array['hid_ehr_runtime']),
      ('ehr.ward_staff_set(uuid,bigint,uuid[],text,text)', false, true, 'v', 'f6205e9a66c21ee84212c50c4960c686',
       'search_path=pg_catalog, pg_temp', array['hid_ehr_runtime']),
      ('ehr.bed_board(uuid,text)', false, true, 'v', '51856be695d7940f83bedb2e5964f547',
       'search_path=pg_catalog, pg_temp', array['hid_ehr_runtime']),
      ('ehr.inpatient_census(date)', false, true, 'v', '6dc6b7ea183c0479dc89018d2178712b',
       'search_path=pg_catalog, pg_temp', array['hid_ehr_runtime']),
      ('ehr.bed_set_status(uuid,bigint,text,text,text,text)', false, true, 'v', '74b1db50a7c43998ee72a24a093ecf6e',
       'search_path=pg_catalog, pg_temp', array['hid_ehr_runtime'])
    ) expected(signature, replaced, security_definer, volatility, body_md5, config, runtimes)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.signature)
   where proc.oid is null or proc.prokind <> 'f' or proc.prosecdef <> expected.security_definer
      or proc.provolatile::text <> expected.volatility or md5(proc.prosrc) <> expected.body_md5
      or proc.proconfig is distinct from array[expected.config]
      or (not expected.replaced
          and (proc.proowner <> (select role_row.oid from pg_roles role_row where role_row.rolname = v_owner)
               or exists (select 1 from aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                           where acl.grantee <> proc.proowner
                             and (acl.grantee = 0 or acl.privilege_type <> 'EXECUTE'
                                  or not pg_get_userbyid(acl.grantee) = any (expected.runtimes)))
               or exists (select 1 from unnest(expected.runtimes) runtime_name
                            join pg_roles role_row on role_row.rolname = runtime_name
                           where not exists (select 1 from aclexplode(proc.proacl) acl
                                              where acl.grantee = role_row.oid and acl.privilege_type = 'EXECUTE'))));
  if v_post_mismatch is not null then
    raise exception using errcode = '55000',
      message = '0170: post-check failed (these functions are not as made: ' || v_post_mismatch || ')';
  end if;
  -- End of the functions' post-check.
  raise notice '0170: wards and beds are installed (6 tables, 20 functions; the three switches off). Nobody can use them until 0173 gives the codes.';
end
$adt0170$;
