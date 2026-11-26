-- 0173 ADT-1 Inpatient admission: who uses the wards, ward-team access
-- (switched off) and sealed test wards (Release D, the department sprint the
-- owner approved on 25 November 2026, verbatim: "I approve Q147–Q290 at the
-- recommended options"). Written on claude/sprint-inpatient-backend at
-- 64b22777 (staging at 95fa1e52) after 0170 and 0171 in the same pull request.
-- The number is provisional (given at merge). It needs 0170 and 0171, not
-- 0172. It pins no role's whole code list: only that no inpatient code exists
-- yet and that every other row of the role table is the same after it as
-- before, so it applies whatever 0152-0169 add to the role table. The
-- declaration in config/production-schema-compatibility.json stays unsigned
-- until the owner signs this file. It is its own file so Rahman can review who
-- gets the wards apart from the tables, and the ward-team part as an identity
-- and consent change.
--
-- Owner decisions (25 November 2026, each at its recommended option): Q185 A
-- (doctors and clinicians request, decide and discharge; nurses, clinicians and
-- doctors give and move beds), Q191 A (facility admins set up wards), Q156 A
-- (ward-team access for the stay, built and off until Rahman and the DPO
-- agree), Q163 A (sealed QA records can be admitted in tests), Q-ADT-15 A (a
-- ward-team grant lasts until discharge, or 2 hours after the patient leaves
-- the member's ward; the patient can end it).
--
-- What it changes (nothing else):
-- C1 auth.permissions          seven codes: ehr.ward.read (the bed board,
--                              census and admissions list), ehr.admission.read
--                              (the admission reason on ward lists, Q-ADT-10,
--                              and the summary print), ehr.bed.allocate (give
--                              and move beds, bed status), ehr.wristband.print
--                              (bands), ehr.admission.decide (request,
--                              prepare, discharge, cancel, change),
--                              ehr.ward.manage (ward setup), and
--                              ehr.death-record.write (the death record; no
--                              role holds it: a later signed file gives it to
--                              doctors once the clinical lead and legal sign).
-- C2 auth.role_permissions     sixteen rows:
--                                nurse      ward.read, admission.read,
--                                           bed.allocate, wristband.print
--                                clinician  the nurse's four and
--                                           admission.decide
--                                doctor     the nurse's four and
--                                           admission.decide
--                                admin      ward.manage
--                                org_admin  ward.manage
-- C3 audit.events              one row per role row added, as the system
--                              actor (no account, membership, facility or
--                              patient): auth.role-permission.add, resource
--                              role-permission "<role>/<code>", reason "ADT-1
--                              Inpatient (Release D, owner decisions Q185 A
--                              and Q191 A)".
-- C4 Ward-team access (Q156 A), built and off:
--    - identity.consent_grants: the authorization_method CHECK gains
--      'ward_stay'; a new nullable column admission_id (references
--      ehr.admissions) set exactly for ward_stay; consent_grants_ward_stay_shape_ck
--      holds such a grant to direct care, write records, not break-glass, no
--      access request, no patient as grantor;
--    - identity.record_access_notices: the access_kind CHECK gains 'ward_stay';
--    - identity.open_ward_stay(admission uuid) (SECURITY DEFINER, EXECUTE for
--      hid_identity_runtime only): refuses while ehr.inpatient_switches'
--      ward_stay_access is false (WARD_STAY_ACCESS_NOT_AVAILABLE); then the
--      caller must be an active nurse, clinician or doctor membership here on
--      the ward team (the staff list of the ward the patient is in, or the
--      responsible doctor), the admission admitted or discharge_ready, no
--      active deny directive; it gives a write grant for direct care
--      (authorization_method ward_stay, the admission's id, reason "Opened by
--      the ward team during your stay"), reusing the member's active one; one
--      audit row per call (identity.ward-stay.open, success or the refusal);
--    - identity.end_ward_stay_grants(admission uuid, reason text) (no runtime
--      role may execute it; 0171's ehr.admission_discharge and
--      ehr.admission_transfer call it through ehr.admission_stay_ended): at
--      discharge every active ward-stay grant of the admission ends at once;
--      at a transfer those of members not on the new ward's staff list (and
--      not the responsible doctor) end 2 hours later; one
--      identity.ward-stay.end audit row per grant ended, as the system actor;
--    - replaced, md5-pinned before (0131's) and after, as 0131 did:
--      identity.patient_self_access_history (basis 'ward-stay', revocable by
--      the patient), identity.revoke_my_consent_grant (accepts it) and
--      identity.note_record_access (access kind 'ward_stay': "Your records
--      were opened");
--    - 0104's records-processing cover never counts a ward-stay grant (it has
--      no access request), as for own-facility grants. Nothing changes there.
-- C5 Sealed test wards (Q163 A): only where 0123 installed QA Hospital, and at
--    the sealed demo facilities (0098) with a nurse, clinician or doctor: one
--    general ward "QA Ward A" (Bed 1-8 and two overflow spaces, "Extra
--    mattress 1" and "Extra mattress 2") and one ICU ward "QA ICU" (ICU Bed
--    1-4), all fictional, with the facility's active nurse, clinician and
--    doctor memberships (the sealed QA nurse and doctor logins at QA Hospital)
--    on their staff lists; one audit row per ward (ehr.ward.sealed-seed, as the
--    system actor). No patient is admitted by the file. On every other
--    database (CI, acceptance, rehearsals, throwaway clusters, production
--    without the QA tenant) nothing is written there and a NOTICE says so.
-- Permissions are read from the role table on every request, so the change
-- applies from each signed-in member's next request; nobody is signed out.
-- ehr-api's INPATIENT_ENABLED still keeps every route closed in production
-- until the owner's go-live. The closing NOTICE prints how many active
-- memberships at real (not sealed) facilities gain each code.
--
-- Locks, taken first, NOWAIT: SHARE ROW EXCLUSIVE on auth.role_permissions
-- (other writers wait; every reader goes on) and on ehr.admissions (the new
-- column's foreign key); ROW EXCLUSIVE on auth.permissions, audit.events,
-- ehr.wards, ehr.beds and ehr.ward_staff; ACCESS EXCLUSIVE on
-- identity.consent_grants and identity.record_access_notices (the CHECK swaps
-- and the column add, one validating scan each); ROW SHARE on auth.roles,
-- auth.accounts, identity.staff_facility_memberships, identity.organizations,
-- identity.facilities and identity.patients (the foreign key checks of the new
-- rows); ACCESS SHARE on auth.account_roles, identity.sealed_demo_members,
-- identity.sealed_qa_members and ehr.inpatient_switches (read). A busy table
-- fails the attempt at once, and its subtransaction releases what it took. The
-- attempt is made 50 times, 100 ms apart (about 5 seconds); then 55P03
-- (nothing applied). When this transaction already holds an earlier
-- migration's locks that stop other sessions' reads or writes, one attempt and
-- no sleep: 55P03 at once, nothing applied. Both refusals begin "0173: " and end
-- "run the release again at a quieter time" (#306).
--
-- Old images on this schema: today's identity image never writes ward_stay
-- grants and reads them as "other" in the access history until the new image
-- ships; harmless, because the switch is off and no such grant exists.
--
-- Undo (not in the ledger; a migration only if the owner signs it): take the
-- sixteen rows out of auth.role_permissions (or mark the seven codes
-- inactive); every member is back where 0171 left them (no wards) from the
-- next request. The ward-team part stays harmless while its switch is off.
--
-- The whole file is one statement (do $adt0173$), so whatever raises in it,
-- however the file is run, applies nothing:
-- 0. The locks (one attempt, made up to 50 times while a table is busy).
-- 1. Preconditions (55000, nothing applied): 0170 and 0171 applied; "0173:
--    already applied" when the seven codes, exactly the sixteen rows, the
--    column, the CHECKs and the new functions are there; "0173: the schema is
--    not in the reviewed state" for any half state; the five roles active;
--    auth.membership_has_permission and the three replaced identity bodies as
--    0001-0151 leave them (md5); the two CHECKs 0131's (with any value another
--    lane added, which is kept).
-- 2. C1-C5.
-- 3. Post-checks: the inpatient rows are exactly the sixteen; every other row
--    of the role table is unchanged; exactly sixteen role audit rows; the
--    CHECKs (the values found plus ward_stay), the column and the three
--    replaced bodies (md5) as written; the five functions in 0168's form (body
--    md5, SECURITY DEFINER setting, volatility, search_path; owner and EXECUTE
--    for the two it makes); no grant or notice row written (this
--    transaction's own row counters; no scan of identity.consent_grants); the
--    switch still off.

do $adt0173$
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
  v_missing text;
  v_reason constant text := 'ADT-1 Inpatient (Release D, owner decisions Q185 A and Q191 A)';
  v_correlation constant text := '0173-inpatient-adt1';
  -- The sixteen rows, in byte order (role, then code), joined by ','.
  v_rows_expected constant text := 'admin ehr.ward.manage,clinician ehr.admission.decide,clinician ehr.admission.read,'
    || 'clinician ehr.bed.allocate,clinician ehr.ward.read,clinician ehr.wristband.print,doctor ehr.admission.decide,'
    || 'doctor ehr.admission.read,doctor ehr.bed.allocate,doctor ehr.ward.read,doctor ehr.wristband.print,'
    || 'nurse ehr.admission.read,nurse ehr.bed.allocate,nurse ehr.ward.read,nurse ehr.wristband.print,'
    || 'org_admin ehr.ward.manage';
  v_codes constant text[] := array['ehr.ward.read', 'ehr.admission.read', 'ehr.bed.allocate', 'ehr.wristband.print',
    'ehr.admission.decide', 'ehr.ward.manage', 'ehr.death-record.write'];
  v_permission_check_md5 constant text := '65e3eaff93fe729fd5c5b986b80c9dd6';
  -- 0131's two value-list CHECKs: 0131's values (all must be there; another lane's extra values are kept), and this
  -- file adds 'ward_stay' to each.
  v_method_0131 constant text[] := array['patient_access_pin', 'own_facility'];
  v_kind_0131 constant text[] := array['standard', 'share', 'pin', 'own_facility'];
  v_method_values text[];
  v_kind_values text[];
  v_rows_before text;
  v_audited integer;
  v_owner name;
  v_present integer;
  v_sealed record;
  v_creator uuid;
  v_ward uuid;
  v_seeded integer := 0;
  v_gain record;
begin
  -- Before the locks (catalog reads only): the files whose tables step 0 locks.
  if to_regclass('ehr.wards') is null or to_regclass('ehr.beds') is null or to_regclass('ehr.ward_staff') is null
     or to_regclass('ehr.inpatient_switches') is null or to_regclass('ehr.admissions') is null then
    raise exception using errcode = '55000', message = '0173: 0170 and 0171 must be applied first';
  end if;

  -- 0. The locks, NOWAIT. (The attempt's block is not indented, so step 0
  -- reads as its own step.)
  loop
  v_attempt := v_attempt + 1;
  begin
  lock table auth.role_permissions, ehr.admissions in share row exclusive mode nowait;
  lock table auth.permissions, audit.events, ehr.wards, ehr.beds, ehr.ward_staff in row exclusive mode nowait;
  lock table identity.consent_grants, identity.record_access_notices in access exclusive mode nowait;
  lock table auth.roles, auth.accounts, identity.staff_facility_memberships, identity.organizations,
             identity.facilities, identity.patients
    in row share mode nowait;
  lock table auth.account_roles, identity.sealed_demo_members, identity.sealed_qa_members, ehr.inpatient_switches
    in access share mode nowait;
  exit;
  exception when lock_not_available then
    if v_holding then
      raise exception using errcode = '55P03',
        message = '0173: the role table, the consent grants, the record access notices, the wards and beds, '
          || 'audit.events or a table 0173''s rows check or read is busy, and this transaction already holds an '
          || 'earlier migration''s locks, so it does not wait; nothing applied; run the release again at a quieter time';
    end if;
    if v_attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0173: the role table, the consent grants, the record access notices, the wards and beds, '
          || 'audit.events or a table 0173''s rows check or read stayed busy for 5 seconds; nothing applied; run the '
          || 'release again at a quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  if to_regclass('ehr.wards') is null or to_regclass('ehr.inpatient_switches') is null
     or to_regclass('ehr.admissions') is null
     or to_regprocedure('ehr.admission_stay_ended(uuid, text)') is null then
    raise exception using errcode = '55000', message = '0173: 0170 and 0171 must be applied first';
  end if;
  select count(*) into v_present
    from (values (to_regprocedure('identity.open_ward_stay(uuid)')::oid),
                 (to_regprocedure('identity.end_ward_stay_grants(uuid, text)')::oid),
                 ((select attribute_row.attrelid::oid from pg_attribute attribute_row
                    where attribute_row.attrelid = 'identity.consent_grants'::regclass
                      and attribute_row.attname = 'admission_id' and not attribute_row.attisdropped)),
                 ((select constraint_row.oid from pg_constraint constraint_row
                    where constraint_row.conrelid = 'identity.consent_grants'::regclass
                      and constraint_row.conname = 'consent_grants_ward_stay_shape_ck')))
         present(object_id)
   where present.object_id is not null;
  if v_present = 4
     and (select count(*) from auth.permissions where code = any (v_codes) and active) = 7
     and (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code, ','
                            order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
            from auth.role_permissions grant_row where grant_row.permission_code = any (v_codes))
         is not distinct from v_rows_expected then
    raise exception using errcode = '55000', message = '0173: already applied';
  end if;
  if v_present <> 0
     or exists (select 1 from auth.permissions where code = any (v_codes))
     or exists (select 1 from auth.role_permissions where permission_code = any (v_codes)) then
    raise exception using errcode = '55000',
      message = '0173: the schema is not in the reviewed state (an inpatient code, row or ward-team object is there, '
        || 'but not exactly what 0173 leaves); nothing applied';
  end if;
  select string_agg(code, ', ' order by code) into v_missing
    from (values ('nurse'), ('clinician'), ('doctor'), ('admin'), ('org_admin')) wanted(code)
   where not exists (select 1 from auth.roles role_row where role_row.code = wanted.code and role_row.active);
  if v_missing is not null then
    raise exception using errcode = '55000', message = '0173: role missing or inactive: ' || v_missing;
  end if;
  select string_agg(expected.signature, ', ') into v_missing
    from (values
      ('auth.membership_has_permission(text,uuid,uuid,text)', v_permission_check_md5),
      ('identity.patient_self_access_history(text,uuid)', '3bbb6a4050e5d41e45ea2d583f9996b6'),
      ('identity.revoke_my_consent_grant(text,uuid,uuid,text)', 'b8564b0e919fe5ddfd6deddd5dbc9f4f'),
      ('identity.note_record_access(uuid)', '9045ca676f7cc57d7870027cf6e25f8f'),
      ('identity.sealed_demo_facility(uuid)', 'd91d91c1d3e1a455e49c5960f313a6e7'),
      ('identity.sealed_qa_facility(uuid)', 'fe9846d94cd744bf37c3f72053d9931f')
    ) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if v_missing is not null then
    raise exception using errcode = '55000', message = '0173: these bodies are not as 0001-0151 left them: ' || v_missing;
  end if;
  -- Each a plain list of text values written as 0131 writes it, holding 0131's values and not 'ward_stay' (a value
  -- another lane added is kept).
  select coalesce(array_agg(found.value[1] order by found.ord), array[]::text[]) into v_method_values
    from pg_constraint constraint_row,
         regexp_matches(pg_get_constraintdef(constraint_row.oid), '''([a-z_]+)''::text', 'g') with ordinality found(value, ord)
   where constraint_row.conrelid = 'identity.consent_grants'::regclass
     and constraint_row.conname = 'consent_grants_authorization_method_ck';
  select coalesce(array_agg(found.value[1] order by found.ord), array[]::text[]) into v_kind_values
    from pg_constraint constraint_row,
         regexp_matches(pg_get_constraintdef(constraint_row.oid), '''([a-z_]+)''::text', 'g') with ordinality found(value, ord)
   where constraint_row.conrelid = 'identity.record_access_notices'::regclass
     and constraint_row.conname = 'record_access_notices_access_kind_check';
  if (select pg_get_constraintdef(constraint_row.oid) from pg_constraint constraint_row
       where constraint_row.conrelid = 'identity.consent_grants'::regclass and constraint_row.contype = 'c'
         and constraint_row.conname = 'consent_grants_authorization_method_ck' and constraint_row.convalidated)
       is distinct from format('CHECK (((authorization_method IS NULL) OR (authorization_method = ANY (ARRAY[%s]))))',
         (select string_agg(quote_literal(value) || '::text', ', ' order by ord)
            from unnest(v_method_values) with ordinality listed(value, ord)))
     or (select pg_get_constraintdef(constraint_row.oid) from pg_constraint constraint_row
          where constraint_row.conrelid = 'identity.record_access_notices'::regclass and constraint_row.contype = 'c'
            and constraint_row.conname = 'record_access_notices_access_kind_check' and constraint_row.convalidated)
       is distinct from format('CHECK ((access_kind = ANY (ARRAY[%s])))',
         (select string_agg(quote_literal(value) || '::text', ', ' order by ord)
            from unnest(v_kind_values) with ordinality listed(value, ord)))
     or not (v_method_values @> v_method_0131) or not (v_kind_values @> v_kind_0131)
     or 'ward_stay' = any (v_method_values) or 'ward_stay' = any (v_kind_values)
     or cardinality(v_method_values) <> (select count(distinct value) from unnest(v_method_values) value)
     or cardinality(v_kind_values) <> (select count(distinct value) from unnest(v_kind_values) value) then
    raise exception using errcode = '55000',
      message = '0173: the grant method or notice kind CHECK is not as 0131 left it (with any value another lane '
        || 'added); nothing applied';
  end if;
  v_owner := (select pg_get_userbyid(proowner) from pg_proc
               where oid = 'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)'::regprocedure);

  select string_agg(grant_row.role_code || ' ' || grant_row.permission_code || ' ' || grant_row.granted_at::text, ','
                    order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
    into v_rows_before from auth.role_permissions grant_row;
  -- The rows of identity.consent_grants, identity.record_access_notices this file must not write: this transaction's
  -- own row counters for each (inserted/updated/deleted), taken here and compared in the post-checks. They cost
  -- nothing; a count or a snapshot of the rows would read whole tables under this file's locks.
  select string_agg(format('%s %s/%s/%s', watched.relation, pg_stat_get_xact_tuples_inserted(watched.relation),
           pg_stat_get_xact_tuples_updated(watched.relation), pg_stat_get_xact_tuples_deleted(watched.relation)),
           ', ' order by watched.ord)
    into v_writes_before
    from unnest(array['identity.consent_grants', 'identity.record_access_notices']::regclass[])
         with ordinality watched(relation, ord);

  -- 2. C1. The seven codes.
  insert into auth.permissions (code, description) values
    ('ehr.ward.read', 'See this facility''s bed board, census and admissions list (ADT-1, 0173)'),
    ('ehr.admission.read', 'See the admission reason on ward lists and print a discharge summary (ADT-1, 0173)'),
    ('ehr.bed.allocate', 'Give a requested admission a bed, move a patient to another bed, and set a bed''s status (ADT-1, 0173)'),
    ('ehr.wristband.print', 'Print inpatient and newborn bands (ADT-1, 0173)'),
    ('ehr.admission.decide', 'Request an admission, prepare and record a discharge, cancel or change an admission (ADT-1, 0173)'),
    ('ehr.ward.manage', 'Set up this facility''s wards, beds and ward staff lists (ADT-1, 0173)'),
    ('ehr.death-record.write', 'Write and amend the medical certificate of cause of death (ADT-1, 0173; held by no role until a later signed file)');

  -- C2. The sixteen rows (Q185 A, Q191 A).
  insert into auth.role_permissions (role_code, permission_code) values
    ('nurse', 'ehr.ward.read'), ('nurse', 'ehr.admission.read'), ('nurse', 'ehr.bed.allocate'),
    ('nurse', 'ehr.wristband.print'),
    ('clinician', 'ehr.ward.read'), ('clinician', 'ehr.admission.read'), ('clinician', 'ehr.bed.allocate'),
    ('clinician', 'ehr.wristband.print'), ('clinician', 'ehr.admission.decide'),
    ('doctor', 'ehr.ward.read'), ('doctor', 'ehr.admission.read'), ('doctor', 'ehr.bed.allocate'),
    ('doctor', 'ehr.wristband.print'), ('doctor', 'ehr.admission.decide'),
    ('admin', 'ehr.ward.manage'), ('org_admin', 'ehr.ward.manage');

  -- C3. One audit row per role row, as the system actor.
  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id, purpose_of_use, reason,
    provenance, source_system, details
  )
  select v_correlation, 'system', 'auth.role-permission.add', 'success', 'role-permission',
         grant_row.role_code || '/' || grant_row.permission_code, 'healthcare-operations', v_reason, 'migration',
         'hid-0173',
         jsonb_build_object('roleCode', grant_row.role_code, 'permissionCode', grant_row.permission_code,
           'migration', '0173', 'decision', case when grant_row.permission_code = 'ehr.ward.manage' then 'Q191 A'
                                                 else 'Q185 A' end)
    from auth.role_permissions grant_row
   where grant_row.permission_code = any (v_codes)
   order by grant_row.role_code collate "C", grant_row.permission_code collate "C";

  -- C4. Ward-team access (Q156 A), built and off.
  alter table identity.consent_grants add column admission_id uuid references ehr.admissions(id) on delete restrict;
  -- The two value lists: the values found (0131's, and any another lane added) plus 'ward_stay'.
  alter table identity.consent_grants drop constraint consent_grants_authorization_method_ck;
  execute format('alter table identity.consent_grants add constraint consent_grants_authorization_method_ck '
    || 'check (authorization_method is null or authorization_method in (%s))',
    (select string_agg(quote_literal(value), ', ' order by ord)
       from unnest(v_method_values || array['ward_stay']) with ordinality listed(value, ord)));
  alter table identity.consent_grants
    add constraint consent_grants_ward_stay_shape_ck
      check ((authorization_method is not distinct from 'ward_stay') = (admission_id is not null)
        and (authorization_method is distinct from 'ward_stay'
             or (scope = 'write_records' and purpose_of_use = 'direct-care' and break_glass = false
                 and request_id is null and granted_by_patient_id is null)));
  create index consent_grants_ward_stay_idx on identity.consent_grants (admission_id, status, expires_at desc)
    where authorization_method = 'ward_stay';
  alter table identity.record_access_notices drop constraint record_access_notices_access_kind_check;
  execute format('alter table identity.record_access_notices add constraint record_access_notices_access_kind_check '
    || 'check (access_kind in (%s))',
    (select string_agg(quote_literal(value), ', ' order by ord)
       from unnest(v_kind_values || array['ward_stay']) with ordinality listed(value, ord)));

  create function identity.open_ward_stay(requested_admission uuid)
  returns table (outcome text, consent_grant_id uuid, subject_patient_id uuid, grant_status text,
    expires_at timestamptz, existing_grant boolean)
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $fn$
  #variable_conflict use_column
  declare
    actor_subject text := platform.current_actor_subject();
    actor_account uuid := auth.account_id_for_subject(platform.current_actor_subject());
    actor_membership uuid := platform.current_membership_id();
    actor_facility uuid := platform.current_facility_id();
    actor_correlation text := platform.current_correlation_id();
    actor_staff uuid;
    actor_organization uuid;
    admission_row ehr.admissions%rowtype;
    refusal text;
    grant_value uuid;
    grant_expires timestamptz;
    reused boolean := false;
    grant_reason constant text := 'Opened by the ward team during your stay';
  begin
    if not coalesce((select switch_row.enabled from ehr.inpatient_switches switch_row
                      where switch_row.key = 'ward_stay_access'), false) then
      raise exception using errcode = '55000', message = 'WARD_STAY_ACCESS_NOT_AVAILABLE';
    end if;
    if actor_account is null or actor_membership is null or actor_facility is null or actor_correlation is null then
      raise exception using errcode = '42501', message = 'WARD_STAY_ACCESS_REFUSED';
    end if;
    if platform.current_purpose_of_use() is distinct from 'direct-care' then
      raise exception using errcode = '22023', message = 'WARD_STAY_DIRECT_CARE_ONLY';
    end if;
    select membership.staff_id, membership.organization_id into actor_staff, actor_organization
      from identity.staff_facility_memberships membership
     where membership.id = actor_membership and membership.account_id = actor_account
       and membership.facility_id = actor_facility and membership.active
       and membership.migration_hold_reason is null
       and exists (select 1 from auth.account_roles assignment
                    where assignment.membership_id = membership.id and assignment.revoked_at is null
                      and assignment.scope_type = 'facility'
                      and assignment.role_code in ('nurse', 'clinician', 'doctor'));
    if actor_staff is null then
      raise exception using errcode = '42501', message = 'WARD_STAY_ACCESS_REFUSED';
    end if;
    select admission.* into admission_row from ehr.admissions admission
     where admission.id = requested_admission and admission.facility_id = actor_facility;
    if not found then
      refusal := 'not_found';
    elsif admission_row.status not in ('admitted', 'discharge_ready') then
      refusal := 'state_invalid';
    elsif not (admission_row.responsible_membership_id = actor_membership
               or exists (select 1 from ehr.ward_staff staff where staff.ward_id = admission_row.ward_id
                           and staff.membership_id = actor_membership)) then
      refusal := 'not_on_ward_team';
    elsif ehr.inpatient_chart_blocked(admission_row.patient_id, actor_facility, actor_organization, actor_staff) then
      refusal := 'deny_directive';
    end if;
    if refusal is not null then
      insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
        organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id, purpose_of_use,
        provenance, source_system, details)
      values (actor_correlation, 'staff', actor_subject, actor_account, actor_membership, actor_organization,
        actor_facility, admission_row.patient_id, 'identity.ward-stay.open',
        case when refusal = 'not_found' then 'failure' else 'denied' end, 'admission', requested_admission::text,
        'direct-care', 'application', 'identity-api', jsonb_build_object('refusal', refusal));
      return query select case when refusal = 'not_found' then 'not_found' else 'refused' end,
        null::uuid, null::uuid, null::text, null::timestamptz, false;
      return;
    end if;
    perform pg_advisory_xact_lock(hashtextextended(
      'ward-stay-open:' || actor_membership::text || ':' || admission_row.id::text, 0));
    select grant_row.id, grant_row.expires_at into grant_value, grant_expires
      from identity.consent_grants grant_row
     where grant_row.admission_id = admission_row.id and grant_row.membership_id = actor_membership
       and grant_row.account_id = actor_account and grant_row.authorization_method = 'ward_stay'
       and grant_row.status = 'active' and grant_row.expires_at > clock_timestamp()
       and grant_row.migration_hold_reason is null
     order by grant_row.expires_at desc limit 1;
    if grant_value is null then
      grant_value := gen_random_uuid();
      grant_expires := current_timestamp + interval '30 days';
      insert into identity.consent_grants (id, request_id, patient_id, staff_id, account_id, membership_id, facility_id,
        scope, purpose_of_use, status, reason, starts_at, expires_at, break_glass, correlation_id,
        authorization_method, admission_id)
      values (grant_value, null, admission_row.patient_id, actor_staff, actor_account, actor_membership, actor_facility,
        'write_records', 'direct-care', 'active', grant_reason, current_timestamp, grant_expires, false,
        actor_correlation, 'ward_stay', admission_row.id);
    else
      reused := true;
    end if;
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
      organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id, purpose_of_use,
      provenance, source_system, details)
    values (actor_correlation, 'staff', actor_subject, actor_account, actor_membership, actor_organization,
      actor_facility, admission_row.patient_id, 'identity.ward-stay.open', 'success', 'consent-grant',
      grant_value::text, 'direct-care', 'application', 'identity-api',
      jsonb_build_object('admissionId', admission_row.id, 'existingGrant', reused, 'expiresAt', grant_expires,
        'scope', 'write_records'));
    return query select 'opened'::text, grant_value, admission_row.patient_id, 'active'::text, grant_expires, reused;
  end
  $fn$;
  comment on function identity.open_ward_stay(uuid) is
    '0173 (ADT-1, Q156 A, Q-ADT-15 A): "Open chart for this stay". Switched off: refuses with WARD_STAY_ACCESS_NOT_AVAILABLE while ehr.inpatient_switches.ward_stay_access is false. A nurse, clinician or doctor of this facility on the ward team (the staff list of the ward the patient is in, or the responsible doctor) gets a write grant for direct care tied to the admitted or discharge-ready admission (authorization_method ward_stay), reused while active; it ends at discharge, or 2 hours after the patient leaves the member''s ward, and the patient can end it. refused for not on the ward team, the state, or a deny directive. Every call is audited (identity.ward-stay.open).';
  revoke all on function identity.open_ward_stay(uuid) from public;

  create function identity.end_ward_stay_grants(requested_admission uuid, requested_reason text)
  returns integer
  language plpgsql
  volatile
  set search_path = pg_catalog, pg_temp
  as $fn$
  declare
    admission_row ehr.admissions%rowtype;
    ended integer := 0;
    grant_row identity.consent_grants%rowtype;
    now_value timestamptz := clock_timestamp();
  begin
    select admission.* into admission_row from ehr.admissions admission where admission.id = requested_admission;
    for grant_row in
      select candidate.* from identity.consent_grants candidate
       where candidate.admission_id = requested_admission and candidate.authorization_method = 'ward_stay'
         and candidate.status = 'active' and candidate.expires_at > now_value
       order by candidate.id
       for update
    loop
      if requested_reason = 'discharge' or admission_row.status in ('discharged', 'cancelled') then
        update identity.consent_grants grant_update
           set status = 'expired', expires_at = greatest(grant_update.starts_at + interval '1 millisecond', now_value),
               updated_at = now_value, row_version = grant_update.row_version + 1
         where grant_update.id = grant_row.id;
      elsif grant_row.membership_id <> admission_row.responsible_membership_id
            and not exists (select 1 from ehr.ward_staff staff where staff.ward_id = admission_row.ward_id
                             and staff.membership_id = grant_row.membership_id)
            and grant_row.expires_at > now_value + interval '2 hours' then
        update identity.consent_grants grant_update
           set expires_at = now_value + interval '2 hours', updated_at = now_value,
               row_version = grant_update.row_version + 1
         where grant_update.id = grant_row.id;
      else
        continue;
      end if;
      ended := ended + 1;
      insert into audit.events (correlation_id, actor_type, facility_id, patient_id, action, outcome, resource_type,
        resource_id, purpose_of_use, provenance, source_system, details)
      values (coalesce(platform.current_correlation_id(), 'ward-stay-end-' || grant_row.id::text), 'system',
        grant_row.facility_id, grant_row.patient_id, 'identity.ward-stay.end', 'success', 'consent-grant',
        grant_row.id::text, 'direct-care', 'system', 'ehr-api',
        jsonb_build_object('admissionId', requested_admission, 'reason', requested_reason,
          'endsIn', case when requested_reason = 'discharge' then 'now' else '2 hours' end));
    end loop;
    return ended;
  end
  $fn$;
  comment on function identity.end_ward_stay_grants(uuid, text) is
    '0173 (ADT-1, Q-ADT-15 A): ends an admission''s ward-stay grants: all at once at discharge; at a transfer, 2 hours later for members not on the new ward''s staff list and not the responsible doctor. One identity.ward-stay.end audit row per grant, as the system actor. No role may execute it; 0171''s ehr.admission_stay_ended calls it.';
  revoke all on function identity.end_ward_stay_grants(uuid, text) from public;

  -- The patient's side (0131's three bodies, each with ward_stay beside own_facility).
  create or replace function identity.patient_self_access_history(requested_subject text, requested_session uuid)
  returns jsonb
  language plpgsql
  stable security definer
  set search_path = pg_catalog, pg_temp
  as $function$
  declare patient uuid; result jsonb;
  begin
    patient := identity.patient_self_session(requested_subject,requested_session);
    if patient is null then return null; end if;
    select jsonb_build_object('items',coalesce(jsonb_agg(entries.item order by entries.created_at desc,entries.id desc),
        '[]'::jsonb)) into result from (
      select jsonb_build_object('consentGrantId',g.id,'scope',g.scope,'purpose',g.purpose_of_use,
        'status',case when g.status='active' and g.expires_at<=statement_timestamp() then 'expired' else g.status end,
        'startsAt',g.starts_at,'expiresAt',g.expires_at,'reason',g.reason,'facilityName',f.name,
        'breakGlass',g.break_glass or g.scope='break_glass',
        'revocableByPatient',labelled.revocable,
        -- 0131: how the access was given ("Opened as this facility's patient" for own-facility).
        'basis',case when g.break_glass or g.scope='break_glass' then 'emergency'
          when g.authorization_method='own_facility' then 'own-facility'
          -- 0173 (ADT-1, Q156 A): opened by the ward team during the stay.
          when g.authorization_method='ward_stay' then 'ward-stay'
          when g.authorization_method='patient_access_pin' then 'pin'
          when s.consent_grant_id is not null then 'share'
          when g.granted_by_patient_id is not distinct from patient then 'approval'
          else 'other' end,
        'shareLevel',s.level,'shareDuration',s.duration_preset,
        'clinicianName',case when s.consent_grant_id is not null then st.full_name end) as item, g.created_at, g.id
      from identity.consent_grants g join identity.facilities f on f.id=g.facility_id
      left join identity.patient_consent_shares s on s.consent_grant_id=g.id
      left join identity.staff st on st.id=g.staff_id and s.consent_grant_id is not null
      cross join lateral (select g.status='active' and g.expires_at>statement_timestamp()
          and not g.break_glass and g.scope<>'break_glass'
          and (g.granted_by_patient_id is not distinct from patient
            or g.authorization_method is not distinct from 'patient_access_pin'
            or g.authorization_method is not distinct from 'own_facility'
            or g.authorization_method is not distinct from 'ward_stay') as revocable) labelled
      where g.patient_id=patient order by labelled.revocable desc,g.created_at desc,g.id desc limit 50
    ) entries;
    return result;
  end;
  $function$;

  create or replace function identity.revoke_my_consent_grant(requested_subject text, requested_session uuid,
    requested_grant_id uuid, requested_reason text)
  returns table(consent_grant_id uuid, grant_status text, revoked_at timestamp with time zone, replayed boolean)
  language plpgsql
  security definer
  set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
  as $function$
  #variable_conflict use_column
  declare
    patient_id_value uuid;
    account_id_value uuid;
    grant_row identity.consent_grants%rowtype;
    revoked_at_value timestamptz;
  begin
    patient_id_value := identity.patient_self_session(requested_subject, requested_session);
    if patient_id_value is null then
      raise exception using errcode = '42501', message = 'Patient self session is required';
    end if;
    if length(btrim(coalesce(requested_reason, ''))) not between 3 and 500 then
      raise exception using errcode = '22023', message = 'A revocation reason is required';
    end if;
    select account_id into account_id_value from identity.patients where id = patient_id_value;
    -- Serialize with PIN verification, replacement and removal for this patient.
    perform pg_advisory_xact_lock(hashtextextended('patient-access-pin:' || patient_id_value::text, 0));
    select * into grant_row from identity.consent_grants grant_candidate
     where grant_candidate.id = requested_grant_id and grant_candidate.patient_id = patient_id_value
     for update;
    if not found then
      raise exception using errcode = 'P0002', message = 'The access grant is unavailable';
    end if;
    -- 0131: an own-facility opening is the patient's to revoke too; 0173: and a ward-team opening (Q156 A).
    if grant_row.break_glass or grant_row.scope = 'break_glass'
       or not (grant_row.granted_by_patient_id is not distinct from patient_id_value
         or grant_row.authorization_method is not distinct from 'patient_access_pin'
         or grant_row.authorization_method is not distinct from 'own_facility'
         or grant_row.authorization_method is not distinct from 'ward_stay') then
      raise exception using errcode = '55000', message = 'CONSENT_GRANT_NOT_PATIENT_REVOCABLE';
    end if;
    if grant_row.status = 'revoked' then
      return query select grant_row.id, 'revoked'::text, grant_row.revoked_at, true;
      return;
    end if;
    if grant_row.status <> 'active' or grant_row.expires_at <= clock_timestamp() then
      raise exception using errcode = '55000', message = 'The access grant is no longer active';
    end if;
    revoked_at_value := clock_timestamp();
    update identity.consent_grants
       set status = 'revoked', revoked_at = revoked_at_value, revoked_by = account_id_value,
           revoked_reason = btrim(requested_reason), updated_at = revoked_at_value,
           row_version = row_version + 1
     where id = grant_row.id;
    insert into audit.events (
      correlation_id, actor_type, actor_subject, actor_account_id, patient_id, facility_id,
      action, outcome, resource_type, resource_id, purpose_of_use, reason,
      provenance, source_system, details
    ) values (
      platform.current_correlation_id(), 'patient', requested_subject, account_id_value, patient_id_value,
      grant_row.facility_id, 'identity.consent-grant.patient-revoke', 'success', 'consent-grant',
      grant_row.id::text, 'patient-self', 'Revoked by the patient', 'application', 'identity-api',
      jsonb_build_object('scope', grant_row.scope,
        'authorizationMethod', coalesce(grant_row.authorization_method, 'patient_approval'))
    );
    return query select grant_row.id, 'revoked'::text, revoked_at_value, false;
  end
  $function$;

  create or replace function identity.note_record_access(requested_consent_grant_id uuid)
  returns text
  language plpgsql
  security definer
  set search_path = pg_catalog, pg_temp
  as $function$
  declare
    subject_value text := platform.current_actor_subject();
    membership_value uuid := platform.current_membership_id();
    facility_value uuid := platform.current_facility_id();
    account_id_value uuid;
    grant_row identity.consent_grants%rowtype;
    day_value date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
    kind_value text;
    notice_id_value uuid := gen_random_uuid();
    inbox_id_value uuid;
    facility_name_value text;
    recipient_exists boolean;
  begin
    select account.id into account_id_value from auth.accounts account where account.subject = subject_value;
    if account_id_value is null or membership_value is null or facility_value is null
       or platform.current_correlation_id() is null then
      return 'not_applicable';
    end if;
    select * into grant_row from identity.consent_grants candidate
     where candidate.id = requested_consent_grant_id and candidate.membership_id = membership_value
       and candidate.facility_id = facility_value and candidate.account_id = account_id_value
       and candidate.status = 'active' and candidate.starts_at <= clock_timestamp()
       and candidate.expires_at > clock_timestamp() and not candidate.break_glass and candidate.scope <> 'break_glass'
       and candidate.migration_hold_reason is null;
    if not found then
      perform identity.share_audit('staff', subject_value, account_id_value, membership_value, facility_value, null,
        'identity.record-access-notice.note', 'denied', 'consent-grant', null, platform.current_purpose_of_use(),
        jsonb_build_object('reason', 'not_applicable'));
      return 'not_applicable';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('record-access-notice:' || grant_row.patient_id::text, 0));
    if exists (select 1 from identity.record_access_notices notice
                where notice.patient_id = grant_row.patient_id and notice.facility_id = facility_value
                  and notice.notice_day = day_value) then
      return 'already_noted';
    end if;
    if (select count(*) from identity.record_access_notices notice
         where notice.patient_id = grant_row.patient_id and notice.notice_day = day_value) >= 10 then
      return 'capped';
    end if;
    kind_value := case
      when grant_row.authorization_method = 'patient_access_pin' then 'pin'
      -- 0131: opened as this facility's own patient.
      when grant_row.authorization_method = 'own_facility' then 'own_facility'
      -- 0173 (ADT-1, Q156 A): opened by the ward team during the stay.
      when grant_row.authorization_method = 'ward_stay' then 'ward_stay'
      when exists (select 1 from identity.patient_consent_shares share where share.consent_grant_id = grant_row.id)
        then 'share'
      else 'standard' end;
    select facility.name into facility_name_value from identity.facilities facility where facility.id = facility_value;
    inbox_id_value := notification.enqueue_patient_inbox_item(grant_row.patient_id, 'RECORDS_OPENED', 'record-access',
      notice_id_value, jsonb_strip_nulls(jsonb_build_object('facilityName', facility_name_value, 'accessKind', kind_value)));
    recipient_exists := exists (select 1 from integration.verified_notification_recipient(grant_row.patient_id));
    insert into identity.record_access_notices (
      id, patient_id, facility_id, membership_id, consent_grant_id, notice_day, access_kind, first_access_at,
      inbox_item_id, email_status, next_attempt_at
    ) values (
      notice_id_value, grant_row.patient_id, facility_value, membership_value, grant_row.id, day_value, kind_value,
      clock_timestamp(), inbox_id_value, case when recipient_exists then 'pending' else 'not_sent' end,
      case when recipient_exists then clock_timestamp() end
    );
    perform identity.share_audit('staff', subject_value, account_id_value, membership_value, facility_value,
      grant_row.patient_id, 'identity.record-access-notice.note', 'success', 'record-access', notice_id_value,
      platform.current_purpose_of_use(), jsonb_build_object('accessKind', kind_value));
    return 'noted';
  end
  $function$;

  -- Owners and EXECUTE (as 0131).
  if v_owner <> current_user then
    execute format('alter function identity.open_ward_stay(uuid) owner to %I', v_owner);
    execute format('alter function identity.end_ward_stay_grants(uuid, text) owner to %I', v_owner);
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant execute on function identity.open_ward_stay(uuid) to hid_identity_runtime;
  end if;

  -- C5. Sealed test wards (Q163 A): QA Hospital where 0123 installed it, and the sealed demo facilities.
  for v_sealed in
    select facility.id as facility_id, facility.organization_id
      from identity.facilities facility
     where facility.active
       and ((facility.id = 'c0a00002-0000-4000-8000-000000000001' and identity.sealed_qa_facility(facility.id))
            or (identity.sealed_demo_facility(facility.id)
                and exists (select 1 from identity.sealed_demo_members member
                             where member.member_kind = 'facility' and member.member_id = facility.id)))
       and exists (select 1 from identity.staff_facility_memberships membership
                     join auth.account_roles assignment on assignment.membership_id = membership.id
                      and assignment.revoked_at is null and assignment.scope_type = 'facility'
                    where membership.facility_id = facility.id and membership.active
                      and assignment.role_code in ('nurse', 'clinician', 'doctor'))
     order by facility.id
  loop
    select membership.id into v_creator
      from identity.staff_facility_memberships membership
      join auth.account_roles assignment on assignment.membership_id = membership.id
       and assignment.revoked_at is null and assignment.scope_type = 'facility'
     where membership.facility_id = v_sealed.facility_id and membership.active
     order by (assignment.role_code in ('admin', 'org_admin')) desc, membership.id
     limit 1;
    insert into ehr.wards (facility_id, organization_id, name, ward_type, takes, created_by_membership_id,
      updated_by_membership_id)
    values (v_sealed.facility_id, v_sealed.organization_id, 'QA Ward A', 'general', 'any', v_creator, v_creator)
    returning id into v_ward;
    insert into ehr.beds (ward_id, facility_id, name, kind, created_by_membership_id, updated_by_membership_id)
    select v_ward, v_sealed.facility_id, bed_name, bed_kind, v_creator, v_creator
      from (select 'Bed ' || ordinal::text, 'bed' from generate_series(1, 8) ordinal
            union all select 'Extra mattress ' || ordinal::text, 'overflow' from generate_series(1, 2) ordinal)
           seeded(bed_name, bed_kind);
    insert into ehr.ward_staff (ward_id, membership_id, facility_id, added_by_membership_id)
    select distinct v_ward, membership.id, v_sealed.facility_id, v_creator
      from identity.staff_facility_memberships membership
      join auth.account_roles assignment on assignment.membership_id = membership.id
       and assignment.revoked_at is null and assignment.scope_type = 'facility'
     where membership.facility_id = v_sealed.facility_id and membership.active
       and assignment.role_code in ('nurse', 'clinician', 'doctor');
    insert into audit.events (correlation_id, actor_type, facility_id, action, outcome, resource_type, resource_id,
      purpose_of_use, reason, provenance, source_system, details)
    values (v_correlation, 'system', v_sealed.facility_id, 'ehr.ward.sealed-seed', 'success', 'ward', v_ward::text,
      'healthcare-operations', 'Sealed test ward (0173, owner decision Q163 A)', 'migration', 'hid-0173',
      jsonb_build_object('wardType', 'general', 'beds', 8, 'overflow', 2, 'migration', '0173'));
    insert into ehr.wards (facility_id, organization_id, name, ward_type, takes, created_by_membership_id,
      updated_by_membership_id)
    values (v_sealed.facility_id, v_sealed.organization_id, 'QA ICU', 'icu', 'any', v_creator, v_creator)
    returning id into v_ward;
    insert into ehr.beds (ward_id, facility_id, name, kind, created_by_membership_id, updated_by_membership_id)
    select v_ward, v_sealed.facility_id, 'ICU Bed ' || ordinal::text, 'bed', v_creator, v_creator
      from generate_series(1, 4) ordinal;
    insert into ehr.ward_staff (ward_id, membership_id, facility_id, added_by_membership_id)
    select distinct v_ward, membership.id, v_sealed.facility_id, v_creator
      from identity.staff_facility_memberships membership
      join auth.account_roles assignment on assignment.membership_id = membership.id
       and assignment.revoked_at is null and assignment.scope_type = 'facility'
     where membership.facility_id = v_sealed.facility_id and membership.active
       and assignment.role_code in ('nurse', 'clinician', 'doctor');
    insert into audit.events (correlation_id, actor_type, facility_id, action, outcome, resource_type, resource_id,
      purpose_of_use, reason, provenance, source_system, details)
    values (v_correlation, 'system', v_sealed.facility_id, 'ehr.ward.sealed-seed', 'success', 'ward', v_ward::text,
      'healthcare-operations', 'Sealed test ward (0173, owner decision Q163 A)', 'migration', 'hid-0173',
      jsonb_build_object('wardType', 'icu', 'beds', 4, 'overflow', 0, 'migration', '0173'));
    v_seeded := v_seeded + 1;
  end loop;
  if v_seeded = 0 then
    raise notice '0173: no sealed QA or demo facility with nurses, clinicians or doctors is installed here: no test ward written';
  end if;

  -- 3. Post-checks.
  select count(*) into v_audited from audit.events event_row
   where event_row.correlation_id = v_correlation and event_row.action = 'auth.role-permission.add';
  if (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code, ','
                        order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
        from auth.role_permissions grant_row where grant_row.permission_code = any (v_codes))
     is distinct from v_rows_expected
     or (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code || ' ' || grant_row.granted_at::text,
                           ',' order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
           from auth.role_permissions grant_row where not grant_row.permission_code = any (v_codes))
        is distinct from v_rows_before
     or (select count(*) from auth.permissions where code = any (v_codes) and active) <> 7
     or exists (select 1 from auth.role_permissions where permission_code = 'ehr.death-record.write')
     or v_audited <> 16
     or (select count(*) from audit.events event_row
          where event_row.correlation_id = v_correlation and event_row.action = 'ehr.ward.sealed-seed') <> 2 * v_seeded then
    raise exception using errcode = '55000', message = '0173: post-check failed (the role table or its audit rows)';
  end if;
  if (select pg_get_constraintdef(constraint_row.oid) from pg_constraint constraint_row
       where constraint_row.conrelid = 'identity.consent_grants'::regclass and constraint_row.contype = 'c'
         and constraint_row.conname = 'consent_grants_authorization_method_ck' and constraint_row.convalidated)
       is distinct from format('CHECK (((authorization_method IS NULL) OR (authorization_method = ANY (ARRAY[%s]))))',
         (select string_agg(quote_literal(value) || '::text', ', ' order by ord)
            from unnest(v_method_values || array['ward_stay']) with ordinality listed(value, ord)))
     or (select pg_get_constraintdef(constraint_row.oid) from pg_constraint constraint_row
          where constraint_row.conrelid = 'identity.record_access_notices'::regclass and constraint_row.contype = 'c'
            and constraint_row.conname = 'record_access_notices_access_kind_check' and constraint_row.convalidated)
       is distinct from format('CHECK ((access_kind = ANY (ARRAY[%s])))',
         (select string_agg(quote_literal(value) || '::text', ', ' order by ord)
            from unnest(v_kind_values || array['ward_stay']) with ordinality listed(value, ord)))
     or not exists (select 1 from pg_constraint where conrelid = 'identity.consent_grants'::regclass
                     and conname = 'consent_grants_ward_stay_shape_ck' and convalidated) then
    raise exception using errcode = '55000', message = '0173: post-check failed (the grant CHECKs)';
  end if;
  select string_agg(expected.signature, ', ') into v_missing
    from (values
      ('identity.patient_self_access_history(text,uuid)', 'b86778d5f12e4a8ca605cd870df1ccb9'),
      ('identity.revoke_my_consent_grant(text,uuid,uuid,text)', '0d9ec8a681b67d8ca3574f25a97f0e18'),
      ('identity.note_record_access(uuid)', '6c44604b17709e6aa29e1d8d496329c5')
    ) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if v_missing is not null then
    raise exception using errcode = '55000', message = '0173: post-check failed (a replaced body): ' || v_missing;
  end if;
  if exists (select 1 from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where proc.oid = 'identity.open_ward_stay(uuid)'::regprocedure and acl.grantee <> proc.proowner
                and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_identity_runtime'))
     or exists (select 1 from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                 where proc.oid = 'identity.end_ward_stay_grants(uuid, text)'::regprocedure
                   and acl.grantee <> proc.proowner)
     or not (select prosecdef from pg_proc where oid = 'identity.open_ward_stay(uuid)'::regprocedure)
     or coalesce((select switch_row.enabled from ehr.inpatient_switches switch_row
                   where switch_row.key = 'ward_stay_access'), true) then
    raise exception using errcode = '55000', message = '0173: post-check failed (the ward-team functions or switch)';
  end if;

  -- Post-check, rows: no row of identity.consent_grants, identity.record_access_notices written.
  if (select string_agg(format('%s %s/%s/%s', watched.relation, pg_stat_get_xact_tuples_inserted(watched.relation),
               pg_stat_get_xact_tuples_updated(watched.relation), pg_stat_get_xact_tuples_deleted(watched.relation)),
               ', ' order by watched.ord)
        from unnest(array['identity.consent_grants', 'identity.record_access_notices']::regclass[])
             with ordinality watched(relation, ord))
     is distinct from v_writes_before then
    raise exception using errcode = '55000', message = '0173: post-check failed (it wrote a row of a table '
      || 'it must not write; counters before: ' || v_writes_before || ')';
  end if;
  -- Post-check, functions (0168's form). The 5 functions this file makes (2) or replaces (3):
  -- each a plain function with its SECURITY DEFINER setting, volatility, body (the md5 of prosrc) and fixed
  -- search_path as written here. Those it makes are the owner's (v_owner), with EXECUTE for exactly the runtimes
  -- listed (the entry points, when the role exists) and for no other role (none on the helpers); CREATE OR REPLACE
  -- keeps a replaced function's owner and grants.
  select string_agg(expected.signature, ', ' order by expected.signature) into v_post_mismatch
    from (values
      ('identity.open_ward_stay(uuid)', false, true, 'v', '8c5a8d1c2440c505753f07f42bc5a81a',
       'search_path=pg_catalog, pg_temp', array['hid_identity_runtime']),
      ('identity.end_ward_stay_grants(uuid,text)', false, false, 'v', 'be121b8907ab9aa92c60da77ccc87a39',
       'search_path=pg_catalog, pg_temp', array[]::text[]),
      ('identity.patient_self_access_history(text,uuid)', true, true, 's', 'b86778d5f12e4a8ca605cd870df1ccb9',
       'search_path=pg_catalog, pg_temp', null),
      ('identity.revoke_my_consent_grant(text,uuid,uuid,text)', true, true, 'v', '0d9ec8a681b67d8ca3574f25a97f0e18',
       'search_path=pg_catalog, identity, auth, audit, platform, pg_temp', null),
      ('identity.note_record_access(uuid)', true, true, 'v', '6c44604b17709e6aa29e1d8d496329c5',
       'search_path=pg_catalog, pg_temp', null)
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
      message = '0173: post-check failed (these functions are not as made: ' || v_post_mismatch || ')';
  end if;
  -- End of the functions' post-check.
  -- What the rows give, at real (not sealed) facilities: the active memberships that gain each code.
  select count(distinct membership.id) filter (where grant_row.permission_code = 'ehr.ward.read') as ward_read,
         count(distinct membership.id) filter (where grant_row.permission_code = 'ehr.admission.read') as admission_read,
         count(distinct membership.id) filter (where grant_row.permission_code = 'ehr.bed.allocate') as bed_allocate,
         count(distinct membership.id) filter (where grant_row.permission_code = 'ehr.wristband.print') as wristband,
         count(distinct membership.id) filter (where grant_row.permission_code = 'ehr.admission.decide') as decide,
         count(distinct membership.id) filter (where grant_row.permission_code = 'ehr.ward.manage') as manage
    into v_gain
    from identity.staff_facility_memberships membership
    join auth.account_roles assignment on assignment.membership_id = membership.id and assignment.revoked_at is null
    join auth.role_permissions grant_row on grant_row.role_code = assignment.role_code
   where membership.active and membership.facility_id is not null
     and grant_row.permission_code = any (v_codes)
     and not identity.sealed_demo_facility(membership.facility_id)
     and not identity.sealed_qa_facility(membership.facility_id);
  raise notice '0173: the inpatient codes are given (Q185 A, Q191 A): at real facilities ehr.ward.read is now held by % active staff memberships, ehr.admission.read by %, ehr.bed.allocate by %, ehr.wristband.print by %, ehr.admission.decide by %, ehr.ward.manage by %; ehr.death-record.write by none; sixteen role rows, sixteen audit rows; ward-team access built and off; sealed test wards at % facilities.',
    v_gain.ward_read, v_gain.admission_read, v_gain.bed_allocate, v_gain.wristband, v_gain.decide, v_gain.manage,
    v_seeded;
end
$adt0173$;
