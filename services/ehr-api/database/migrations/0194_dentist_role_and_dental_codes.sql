-- 0194 DEN-1 (Release D): the dentist role and the dental codes. Written on
-- claude/sprint-dental-backend at a8126e33 (staging-novu-ci-20261005 at
-- 0cfddcc9, that is 0001-0153 applied: Releases A to C, 0150-0151 and Release
-- E). The number is provisional (given at merge, after the files booked
-- before it; 0195 and 0196 follow it). No migration number appears inside a
-- function body this file makes or changes, so renumbering keeps every md5.
-- The declaration in config/production-schema-compatibility.json stays an
-- unsigned draft until the owner signs this file.
--
-- Owner decisions (25 November 2026, "I approve Q147-Q290 at the recommended
-- options"; docs/EHR_PLANNED_CONTRACT.md, DEN-1): Q155 A (D1 A, a new dentist
-- role in its own migration, with a role-table update, a sealed QA login and a
-- department switch), Q149 A (the switch: DENTAL_ENABLED, off by default, in
-- ehr-api and identity-api). Built at the recommended option, not yet answered
-- by the owner: Q-DEN-1 A (only dentists hold the dental codes; no doctor,
-- clinician or nurse) and Q-DEN-2 A (no emergency access for dentists). The
-- owner confirms that dentist@healthidentitydirectory.com receives mail before
-- signing (BILL-17's rule); otherwise G5 is left out of the signed file.
--
-- WHAT IT DOES (nothing else)
-- G1 auth.permissions: ehr.dental.read, ehr.dental.write.
-- G2 auth.roles: dentist, active.
-- G3 auth.role_permissions: the dentist's 25 rows (the two dental codes; the
--    doctor's codes for the visit, prescribing and lab ordering; nothing for
--    registration, Migrate, imports, outreach or emergency access):
--      ehr.dental.read, ehr.dental.write, ehr.encounter.read,
--      ehr.encounter.write, ehr.note.read, ehr.note.write,
--      ehr.diagnosis.read, ehr.diagnosis.write, ehr.prescription.read,
--      ehr.prescription.write, ehr.lab-request.read, ehr.lab-request.write,
--      ehr.vital.read, ehr.vital.write, ehr.document.read,
--      ehr.document.write, ehr.order-route.send,
--      identity.authorization.check, identity.consent.read,
--      identity.consent.write, identity.patient-access-pin.verify,
--      identity.patient.read, lab.result.released.read,
--      lab.work-item.accept, pharmacy.dispensing.read.
--    No row for any other role; no code is taken from any role. 0136's count
--    is not needed: no member holds the new role when the file applies.
--    identity.patient.open-own-facility comes only with 0196 (Q156 A, held).
-- G4 The staff vocabulary, the 0136/0139/0150 way (CREATE OR REPLACE from
--    each function's current definition, so owner, ACL, SECURITY DEFINER and
--    search_path stay as they are):
--    identity.staff_role_licence_body(text) gains "when 'dentist' then
--      'MDCN'" after the doctor's line (the MDCN keeps the dental register);
--    identity.staff_invitable_roles(text, text) gains 'dentist' after
--      'doctor' in the hospital and clinic list (and 'other' with ehr or
--      migrate); laboratories and pharmacies cannot invite a dentist;
--    the six functions whose bodies hold the five-role list ('doctor',
--      'nurse', 'lab', 'pharmacist', 'receptionist' (each exactly once):
--      identity.staff_invitation_fields_valid,
--      identity.change_facility_staff_role, identity.add_facility_staff_role,
--      identity.remove_facility_staff_role,
--      identity.admin_add_facility_staff_role and
--      identity.admin_remove_facility_staff_role gain 'dentist' after 'doctor'
--      in that list, and nothing else;
--    identity.staff_invitations' staff_invitations_role_code_check and
--      identity.staff_licence_attestations'
--      staff_licence_attestations_role_code_check gain 'dentist' after
--      'doctor' (every value found is kept), added NOT VALID and validated
--      under the lock. The licence checks are unchanged: a dentist takes
--      their licensed branch, so a dentist needs an MDCN licence. (The
--      attestations' role check is not named in the contract's G4; without
--      it no dentist could be invited or added with a licence, because every
--      licensed role's grant writes an attestation row.)
--    Tolerant of the other Release D lanes (BILL-1's 0162 adds cashier and
--    billing_officer to the same lists and replaces "= 'receptionist'" and
--    "<> 'receptionist'" with "in (...)" and "not in (...)"; radiology may add
--    its roles): the precondition takes each function's current body, removes
--    every role appended after 'receptionist' and turns 0162's "in
--    ('receptionist')" and "not in ('receptionist')" back, and requires the
--    md5 that 0001-0153 leave. The licence body function is taken the same
--    way with any other lane's "when ... then ..." line removed. The
--    replacement inserts 'dentist' after 'doctor' and keeps whatever another
--    lane appended; the post-check proves each new body is the old body with
--    exactly that one insertion. So 0194 applies before or after 0162.
--    (0162 as cut on claude/sprint-billing-backend pins these bodies exactly,
--    so 0162 refuses after 0194 until it takes the same tolerance; reported.)
-- G5 Sealed QA step (Q155 A), only where 0123 installed the sealed QA tenant
--    (QA Hospital is a QA facility), exactly as 0151 and 0162 seed theirs: one
--    fictional login at QA Hospital, pending_reset, no password, email
--    verified: dentist@healthidentitydirectory.com "QA Dentist" (dentist),
--    account c0a00003-0000-4000-8000-0000000000de, staff
--    c0a00004-0000-4000-8000-0000000000de, membership
--    c0a00005-0000-4000-8000-000000000de1; a sealed QA member first (so 0123's
--    seal sees it), one staff record, one membership, one facility role with
--    the membership's id, and one identity.sealed-qa.staff-login-add audit
--    row. Refused 55000 "0194: SEALED_QA_ADDRESS_TAKEN" when the address is
--    held elsewhere (0123's rule), "0194: SEALED_QA_ID_TAKEN" when a fixed id
--    is (so a clash with another lane's ids stops the file and never merges).
--    On every other database (CI, throwaway clusters, the rehearsal) nothing
--    is written for this step, not even an audit row, and a NOTICE says so.
--    No licence attestation is written for the QA dentist (0151's QA logins
--    carry none either).
-- G6 audit.events, as the system actor (no account, membership, facility or
--    patient), correlation 0194-dentist-role-and-dental-codes, source
--    hid-0194: one auth.permission.add per code (2), one auth.role.add (1)
--    and one auth.role-permission.add per row (25): 28 rows, plus G5's one
--    where the QA tenant is installed. Details hold codes, the migration and
--    the decision; never a name or address.
--
-- Locks, taken first, NOWAIT, in one attempt made up to 50 times 100 ms apart
-- (about 5 seconds), so the file never waits for one of its locks while
-- holding the others; then 55P03 "0194: ... stayed busy for 5 seconds; nothing
-- applied; run the release again at a quieter time". When this transaction
-- already holds an earlier migration's locks that stop other sessions (the
-- runner's dry run applies every pending file in one transaction), one
-- attempt, no sleep ("... so it does not wait; nothing applied; run the
-- release again at a quieter time"). Measured with pg_locks before commit
-- (dental-migrations.integration.sql compares them):
--   SHARE ROW EXCLUSIVE: auth.roles, auth.permissions, auth.role_permissions
--     (other writers wait; every reader, each request's permission check
--     included, goes on);
--   ACCESS EXCLUSIVE: identity.staff_invitations and
--     identity.staff_licence_attestations (their role checks are replaced;
--     small tables, held for milliseconds);
--   ROW EXCLUSIVE: audit.events, identity.sealed_qa_members, auth.accounts,
--     identity.staff, identity.staff_facility_memberships, auth.account_roles
--     (the QA step's rows; taken on every database, as 0151 does);
--   SHARE: identity.organization_applications (no application can name the
--     QA address between the check and commit);
--   ROW SHARE: identity.organizations, identity.facilities, identity.patients,
--     identity.outreach_organisations (the new rows' and the audit rows'
--     foreign keys and 0123's triggers);
--   ACCESS SHARE: identity.sealed_demo_members (0123's demo-overlap trigger
--     and the seal checks) and identity.staff_attestation_texts (the body
--     check of identity.staff_invitation_fields_valid, a SQL function);
--   and 0123's sealed QA install lock (tried, not waited for).
-- The replaced functions are replaced in place; the runner's lock_timeout
-- (5 s) ends any wait on them.
--
-- Old services on this schema: the old roles answer exactly as before (only
-- dentist is added to the lists). Old identity-api images do not know dentist
-- and refuse it early (400), which is harmless; this branch's identity-api
-- refuses it with 409 STAFF_ROLE_NOT_AVAILABLE while DENTAL_ENABLED is off.
-- No old service checks the new codes. New services on a schema without this
-- file: no role holds a dental code, so 0195's functions refuse everything.
--
-- Undo (not in the ledger; by hand, only if the owner signs it): end the
-- dentist assignments, delete the 25 role rows (and 0196's row if applied),
-- the role and the two codes, restore the eight functions and the two checks
-- from their definitions without 'dentist' (the post-check's reverse
-- replacement), and remove the QA login rows.
--
-- The whole file is one statement (do $den0194$), so whatever raises in it,
-- however the file is run, applies nothing:
-- 0. The locks (above).
-- 1. Preconditions (55000, or 42501 for ownership; nothing applied):
--    a. markers of the earlier files whose objects it uses only: 0123 (the
--       sealed QA tenant) and 0139 (the SX-4 add and remove functions);
--    b. not applied yet ("0194: already applied" when every object is exactly
--       as this file leaves it; "0194: the schema is not in the reviewed
--       state" when any of its objects exists otherwise);
--    c. the eight functions, taken as above, as 0001-0153 leave them (md5);
--       the two role checks name the five (four) roles of 0001-0153 and
--       perhaps other lanes' roles after them, and not dentist;
--    d. the 23 existing codes the dentist's rows name exist and are active
--       (codes and roles other lanes add are accepted);
--    e. the QA step's helpers and seal triggers as 0151 checks them, and one
--       owner for what it writes (0151's step f).
-- 2. G1-G6.
-- 3. Post-checks: the 25 rows (md5 pinned) and that no other role row
--    changed (row by row), the eight functions (each exactly the old body
--    with the one insertion, and owner, ACL, SECURITY DEFINER and search_path
--    unchanged), the two checks (validated, the values found plus dentist),
--    the 28 audit rows, the QA step's rows.

do $den0194$
declare
  attempt integer := 0;
  holding boolean := exists (
    select 1 from pg_locks held
      join pg_class relation on relation.oid = held.relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where held.pid = pg_backend_pid() and held.locktype = 'relation' and held.granted
       and held.database = (select database_row.oid from pg_database database_row
                             where database_row.datname = current_database())
       and held.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
       and namespace.nspname <> 'migration');
  correlation constant text := '0194-dentist-role-and-dental-codes';
  decision constant text := 'Q155 A (owner, 25 November 2026), DEN-1';
  reason_text constant text := 'Owner decision Q155 A (25 November 2026), DEN-1: the dentist role and the dental codes';
  new_codes constant jsonb := '[
    ["ehr.dental.read", "Open the dental chart, the dental procedures and the dental visit summary"],
    ["ehr.dental.write", "Record the dental chart; plan, record, sign, cancel and correct dental procedures; set the dental follow-up"]]';
  -- The dentist's 25 codes (G3). The first two are G1's; the other 23 must exist and be active.
  dentist_codes constant text[] := array[
    'ehr.dental.read', 'ehr.dental.write', 'ehr.encounter.read', 'ehr.encounter.write', 'ehr.note.read',
    'ehr.note.write', 'ehr.diagnosis.read', 'ehr.diagnosis.write', 'ehr.prescription.read', 'ehr.prescription.write',
    'ehr.lab-request.read', 'ehr.lab-request.write', 'ehr.vital.read', 'ehr.vital.write', 'ehr.document.read',
    'ehr.document.write', 'ehr.order-route.send', 'identity.authorization.check', 'identity.consent.read',
    'identity.consent.write', 'identity.patient-access-pin.verify', 'identity.patient.read',
    'lab.result.released.read', 'lab.work-item.accept', 'pharmacy.dispensing.read'];
  -- The 25 rows: md5 of "role code" pairs in byte order (collate "C"), joined by ','.
  rows_md5 constant text := 'c4b6cff4a76147523d27a1d35bc33ca5';
  -- The functions this file replaces: md5 of pg_proc.prosrc as 0001-0153 leave it (after the other lanes' roles are
  -- taken out, see normalized below), and what to insert where (exactly once in each).
  role_functions constant jsonb := '[
    {"f": "identity.staff_role_licence_body(text)", "base": "1d6531b60beaf640a46342be8380eac3",
     "find": "    when ''doctor'' then ''MDCN''\n", "with": "    when ''doctor'' then ''MDCN''\n    when ''dentist'' then ''MDCN''\n"},
    {"f": "identity.staff_invitable_roles(text,text)", "base": "b6f4068712d97284fd95d169e3bde0cf",
     "find": "array[''doctor'', ''nurse'', ", "with": "array[''doctor'', ''dentist'', ''nurse'', "},
    {"f": "identity.staff_invitation_fields_valid(text,text,text,text,text,text)",
     "base": "a19f57eb883418bc352d7a5b0fdab991",
     "find": "(''doctor'', ''nurse'', ''lab'', ''pharmacist'', ''receptionist''",
     "with": "(''doctor'', ''dentist'', ''nurse'', ''lab'', ''pharmacist'', ''receptionist''"},
    {"f": "identity.change_facility_staff_role(uuid,bigint,text,text,text,text,text)",
     "base": "478b9dc8c9e4996b86b1e06fb81c3116",
     "find": "(''doctor'', ''nurse'', ''lab'', ''pharmacist'', ''receptionist''",
     "with": "(''doctor'', ''dentist'', ''nurse'', ''lab'', ''pharmacist'', ''receptionist''"},
    {"f": "identity.add_facility_staff_role(uuid,bigint,text,text,text,text,text,text,character)",
     "base": "1ca56a2cdd0231341d9f3b48441b2074",
     "find": "(''doctor'', ''nurse'', ''lab'', ''pharmacist'', ''receptionist''",
     "with": "(''doctor'', ''dentist'', ''nurse'', ''lab'', ''pharmacist'', ''receptionist''"},
    {"f": "identity.remove_facility_staff_role(uuid,bigint,text,text)",
     "base": "8da5860b2edbd3ee7205e4473b30fbc7",
     "find": "(''doctor'', ''nurse'', ''lab'', ''pharmacist'', ''receptionist''",
     "with": "(''doctor'', ''dentist'', ''nurse'', ''lab'', ''pharmacist'', ''receptionist''"},
    {"f": "identity.admin_add_facility_staff_role(uuid,uuid,bigint,text,text,text,text,text,text,character)",
     "base": "e12a01443fad2b903f22533153810b0f",
     "find": "(''doctor'', ''nurse'', ''lab'', ''pharmacist'', ''receptionist''",
     "with": "(''doctor'', ''dentist'', ''nurse'', ''lab'', ''pharmacist'', ''receptionist''"},
    {"f": "identity.admin_remove_facility_staff_role(uuid,uuid,bigint,text,text,text,character)",
     "base": "9d326012bf28739a62cef768b613f181",
     "find": "(''doctor'', ''nurse'', ''lab'', ''pharmacist'', ''receptionist''",
     "with": "(''doctor'', ''dentist'', ''nurse'', ''lab'', ''pharmacist'', ''receptionist''"}]';
  -- The two role checks: (table, constraint, the roles 0001-0153 leave in order).
  role_checks constant jsonb := '[
    {"t": "identity.staff_invitations", "c": "staff_invitations_role_code_check",
     "base": ["doctor", "nurse", "lab", "pharmacist", "receptionist"]},
    {"t": "identity.staff_licence_attestations", "c": "staff_licence_attestations_role_code_check",
     "base": ["doctor", "nurse", "lab", "pharmacist"]}]';
  -- Sealed QA step (G5).
  qa_hospital_organization constant uuid := 'c0a00001-0000-4000-8000-000000000001';
  qa_hospital constant uuid := 'c0a00002-0000-4000-8000-000000000001';
  qa_role_reason constant text := 'Sealed QA tenant: QA Hospital dentist (0194, Q155 A)';
  qa_audit_reason constant text := 'Q155 A: a dentist login at QA Hospital, sealed QA only';
  qa_correlation constant text := '0194-sealed-qa-dentist';
  qa_account constant uuid := 'c0a00003-0000-4000-8000-0000000000de';
  qa_staff constant uuid := 'c0a00004-0000-4000-8000-0000000000de';
  qa_membership constant uuid := 'c0a00005-0000-4000-8000-000000000de1';
  qa_subject constant text := 'sealed-qa:c0a00003-0000-4000-8000-0000000000de';
  qa_email constant text := 'dentist@healthidentitydirectory.com';
  qa_name constant text := 'QA Dentist';
  found_absent boolean;
  missing text;
  applier oid := (select role_row.oid from pg_roles role_row where role_row.rolname = current_user);
  owner_oid oid;
  saved_role text;
  installed boolean;
  rows_before text;
  entry jsonb;
  source text;
  replaced text;
  normalized text;
  found_count integer;
  found_values text[];
  wanted_values text[];
  before_state jsonb := '{}';
  check_state jsonb := '{}';
  step bigint;
  written integer := 0;
  applied_functions integer := 0;
begin
  loop
  attempt := attempt + 1;
  begin
  -- 0. The locks, NOWAIT.
  lock table auth.roles, auth.permissions, auth.role_permissions
    in share row exclusive mode nowait;
  lock table identity.staff_invitations, identity.staff_licence_attestations
    in access exclusive mode nowait;
  lock table audit.events, identity.sealed_qa_members, auth.accounts, identity.staff,
             identity.staff_facility_memberships, auth.account_roles
    in row exclusive mode nowait;
  lock table identity.organization_applications
    in share mode nowait;
  lock table identity.organizations, identity.facilities, identity.patients, identity.outreach_organisations
    in row share mode nowait;
  lock table identity.sealed_demo_members, identity.staff_attestation_texts
    in access share mode nowait;
  if not pg_try_advisory_xact_lock(hashtextextended('hid-sealed-qa-install', 0)) then
    raise exception using errcode = '55P03', message = '0194: the sealed QA install lock is held';
  end if;
  exit;

  exception when lock_not_available then
    if holding then
      raise exception using errcode = '55P03',
        message = '0194: a table 0194 writes or checks (the role table, staff invitations, staff licence '
          || 'attestations, audit events, the sealed QA members, accounts, staff records, staff memberships, account '
          || 'roles, organization applications and the tables their keys reference) or the sealed QA install lock is '
          || 'busy, and this transaction already holds an earlier migration''s locks, so it does not wait; nothing '
          || 'applied; run the release again at a quieter time';
    end if;
    if attempt >= 50 then
      raise exception using errcode = '55P03',
        message = '0194: a table 0194 writes or checks (the role table, staff invitations, staff licence '
          || 'attestations, audit events, the sealed QA members, accounts, staff records, staff memberships, account '
          || 'roles, organization applications and the tables their keys reference) or the sealed QA install lock '
          || 'stayed busy for 5 seconds; nothing applied; run the release again at a quieter time';
    end if;
    perform pg_sleep(0.1);
  end;
  end loop;

  -- 1. Preconditions.
  -- a. Markers of the earlier files whose objects this file uses only: 0123's sealed QA tenant (G5) and 0139's SX-4
  -- functions (G4; c pins their bodies).
  if to_regprocedure('identity.sealed_qa_install()') is null
     or to_regprocedure('identity.add_facility_staff_role(uuid,bigint,text,text,text,text,text,text,character)') is null
     or to_regprocedure('identity.admin_remove_facility_staff_role(uuid,uuid,bigint,text,text,text,character)') is null then
    raise exception using errcode = '55000', message = '0194: 0123 and 0139 must be applied first';
  end if;

  -- b. Not applied yet. Applied exactly: the role, the two codes and the 25 rows as this file leaves them, every
  -- function holding dentist exactly once where this file puts it, both checks naming dentist, and the 28 audit rows.
  if exists (select 1 from auth.roles where code = 'dentist')
     or exists (select 1 from auth.permissions where code in ('ehr.dental.read', 'ehr.dental.write'))
     or exists (select 1 from auth.role_permissions where role_code = 'dentist')
     or exists (select 1 from jsonb_array_elements(role_functions) fn
                 where (select proc.prosrc from pg_proc proc where proc.oid = to_regprocedure(fn.value->>'f'))
                       like '%''dentist''%')
     or exists (select 1 from jsonb_array_elements(role_checks) chk
                 join pg_constraint constraint_row on constraint_row.conrelid = (chk.value->>'t')::regclass
                  and constraint_row.conname = chk.value->>'c'
                 where pg_get_constraintdef(constraint_row.oid) like '%''dentist''%')
     or exists (select 1 from audit.events event_row where event_row.correlation_id = correlation) then
    if (select count(*) from auth.roles where code = 'dentist' and active) = 1
       and (select count(*) from auth.permissions where code in ('ehr.dental.read', 'ehr.dental.write') and active) = 2
       and (select md5(string_agg(grant_row.role_code || ' ' || grant_row.permission_code, ','
                                  order by grant_row.role_code collate "C", grant_row.permission_code collate "C"))
              from auth.role_permissions grant_row
             where grant_row.role_code = 'dentist'
               and grant_row.permission_code <> 'identity.patient.open-own-facility') = rows_md5
       and (select count(*) from auth.role_permissions grant_row
             where grant_row.permission_code in ('ehr.dental.read', 'ehr.dental.write')
               and grant_row.role_code <> 'dentist') = 0
       and not exists (
             select 1 from jsonb_array_elements(role_functions) fn
              left join lateral (select proc.prosrc from pg_proc proc
                                  where proc.oid = to_regprocedure(fn.value->>'f')) current_body on true
              where current_body.prosrc is null
                 or (length(current_body.prosrc) - length(replace(current_body.prosrc, fn.value->>'with', '')))
                    / length(fn.value->>'with') <> 1
                 or (length(current_body.prosrc) - length(replace(current_body.prosrc, '''dentist''', '')))
                    / length('''dentist''') <> 1)
       and (select count(*) from jsonb_array_elements(role_checks) chk
              join pg_constraint constraint_row on constraint_row.conrelid = (chk.value->>'t')::regclass
               and constraint_row.conname = chk.value->>'c' and constraint_row.convalidated
             where pg_get_constraintdef(constraint_row.oid) like '%''doctor''::text, ''dentist''::text%') = 2
       and (select count(*) from audit.events event_row where event_row.correlation_id = correlation) = 28 then
      raise exception using errcode = '55000', message = '0194: already applied';
    end if;
    raise exception using errcode = '55000',
      message = '0194: the schema is not in the reviewed state (the dentist role, a dental code, a role row, a role '
        || 'list naming dentist or 0194''s audit rows exist, with other content than 0194 leaves); nothing applied';
  end if;

  -- c. The eight functions as 0001-0153 leave them, once another lane's roles are taken out (see the header): every
  -- role appended after 'receptionist' removed, 0162's in ('receptionist') and not in ('receptionist') turned back,
  -- and in the licence body function every line of a role other than the four removed. Each holds its insertion
  -- point exactly once.
  select string_agg(fn.value->>'f', ', ') into missing
    from jsonb_array_elements(role_functions) fn
    left join lateral (select proc.prosrc from pg_proc proc where proc.oid = to_regprocedure(fn.value->>'f')) current_body
      on true
   where current_body.prosrc is null
      or md5(regexp_replace(regexp_replace(regexp_replace(regexp_replace(current_body.prosrc,
           $re$'receptionist'(, '[a-z_]+')+$re$, $re$'receptionist'$re$, 'g'),
           $re$not in \('receptionist'\)$re$, $re$<> 'receptionist'$re$, 'g'),
           $re$ in \('receptionist'\)$re$, $re$ = 'receptionist'$re$, 'g'),
           $re$    when '(?!doctor'|nurse'|lab'|pharmacist')[a-z_]+' then '[A-Z]+'\n$re$, '', 'g'))
         is distinct from fn.value->>'base'
      or (length(current_body.prosrc) - length(replace(current_body.prosrc, fn.value->>'find', '')))
         / length(fn.value->>'find') <> 1;
  if missing is not null then
    raise exception using errcode = '55000',
      message = '0194: these functions differ from 0001-0153 (other lanes'' roles aside) or are missing: ' || missing;
  end if;
  -- The two role checks: the roles 0001-0153 leave, in order, then perhaps other lanes' roles; never dentist.
  for entry in select value from jsonb_array_elements(role_checks) loop
    select array_agg(found.value[1] order by found.ord) into found_values
      from pg_constraint constraint_row,
           regexp_matches(pg_get_constraintdef(constraint_row.oid), $re$'([a-z_]+)'::text$re$, 'g')
             with ordinality found(value, ord)
     where constraint_row.conrelid = (entry->>'t')::regclass and constraint_row.conname = entry->>'c';
    select array_agg(value order by ord) into wanted_values
      from jsonb_array_elements_text(entry->'base') with ordinality base(value, ord);
    if found_values is null
       or found_values[1:cardinality(wanted_values)] is distinct from wanted_values
       or 'dentist' = any (found_values)
       or (select pg_get_constraintdef(constraint_row.oid) from pg_constraint constraint_row
            where constraint_row.conrelid = (entry->>'t')::regclass and constraint_row.conname = entry->>'c')
          is distinct from 'CHECK ((role_code = ANY (ARRAY[' || (select string_agg(quote_literal(value) || '::text', ', '
                                                                   order by ord)
                                                                   from unnest(found_values) with ordinality v(value, ord))
                           || '])))' then
      raise exception using errcode = '55000',
        message = format('0194: %s.%s is not a role list of 0001-0153 (other lanes'' roles after it aside)',
          entry->>'t', entry->>'c');
    end if;
    check_state := check_state || jsonb_build_object(entry->>'c', to_jsonb(found_values));
  end loop;

  -- d. The 23 existing codes the dentist's rows name (others' additions are accepted; no role's list is pinned).
  select string_agg(wanted.code, ', ' order by wanted.code) into missing
    from unnest(dentist_codes[3:]) wanted(code)
   where not exists (select 1 from auth.permissions permission_row
                      where permission_row.code = wanted.code and permission_row.active);
  if missing is not null then
    raise exception using errcode = '55000', message = '0194: these codes are missing or inactive: ' || missing;
  end if;

  -- e. The QA step's helpers and seal triggers as 0151 checks them.
  with expected(signature, digest) as (values
         ('identity.sealed_qa_facility(uuid)', 'fe9846d94cd744bf37c3f72053d9931f'),
         ('identity.sealed_qa_account(uuid)', '2c19c76bff02b394097724f99e09fc9d'),
         ('identity.sealed_qa_recipient(text)', '7bb9434e607271d72c1e02f0961bce13'),
         ('identity.sealed_qa_members_not_demo()', 'b306df4f70f9d207467cedbf75a5c7aa'),
         ('identity.staff_memberships_sealed_qa()', '4c00d810e3be5d047b55c6d90573527f'),
         ('identity.account_roles_sealed_qa()', '6a95d1dd699daca074d901decd68d138'),
         ('identity.staff_memberships_sealed_demo()', 'cf5745fe353d90ce79b095983085266c'),
         ('identity.account_roles_sealed_demo()', 'f852b9f89d084a99f7489d9427a779fc')),
       differing as (
         select expected.signature from expected
          where to_regprocedure(expected.signature) is null
             or not exists (select 1 from pg_proc proc
                             where proc.oid = to_regprocedure(expected.signature)
                               and md5(proc.prosrc) = expected.digest))
  select exists (select 1 from differing), (select string_agg(differing.signature, ', ') from differing)
    into found_absent, missing;
  if found_absent then
    raise exception using errcode = '55000',
      message = format('0194: these functions differ from 0123''s (and 0098''s) or are missing: %s', missing);
  end if;
  if not identity.sealed_qa_recipient(qa_email) then
    raise exception using errcode = '55000', message = '0194: the QA address is not of the owner''s domain';
  end if;
  owner_oid := (select relation.relowner from pg_class relation
                 where relation.oid = 'identity.sealed_qa_members'::regclass);
  with foreign_owned as (
         select expected.table_name as what
           from (values ('auth.accounts'), ('identity.staff'), ('identity.staff_facility_memberships'),
                        ('auth.account_roles'), ('audit.events'), ('auth.roles'), ('auth.permissions'),
                        ('auth.role_permissions'), ('identity.staff_invitations'),
                        ('identity.staff_licence_attestations')) expected(table_name)
          where not exists (select 1 from pg_class relation
                             where relation.oid = to_regclass(expected.table_name) and relation.relowner = owner_oid)
         union all
         select fn.value->>'f'
           from jsonb_array_elements(role_functions) fn
          where not exists (select 1 from pg_proc proc
                             where proc.oid = to_regprocedure(fn.value->>'f') and proc.proowner = owner_oid))
  select exists (select 1 from foreign_owned), (select string_agg(foreign_owned.what, ', ') from foreign_owned)
    into found_absent, missing;
  if found_absent then
    raise exception using errcode = '42501',
      message = format('0194: these are not owned by %s, the owner of identity.sealed_qa_members: %s',
        coalesce(pg_get_userbyid(owner_oid), 'nobody'), missing);
  end if;
  if not (applier = owner_oid
          or (pg_has_role(applier, owner_oid, 'USAGE') and pg_has_role(applier, owner_oid, 'SET'))) then
    raise exception using errcode = '42501',
      message = format('0194: %s must own, or inherit from and be able to SET ROLE to, %s', current_user,
        pg_get_userbyid(owner_oid));
  end if;
  if exists (select 1 from auth.accounts account where account.id = qa_account)
     or identity.sealed_qa_account(qa_account)
     or exists (select 1 from identity.staff staff_row where staff_row.id = qa_staff)
     or exists (select 1 from identity.staff_facility_memberships membership where membership.id = qa_membership)
     or exists (select 1 from auth.account_roles assignment where assignment.id = qa_membership) then
    raise exception using errcode = '55000', message = '0194: SEALED_QA_ID_TAKEN';
  end if;

  select string_agg(grant_row.role_code || ' ' || grant_row.permission_code || ' ' || grant_row.granted_at::text, ','
                    order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
    into rows_before from auth.role_permissions grant_row;
  -- Each function's body, owner, ACL, SECURITY DEFINER, volatility and settings before (the post-check compares).
  select jsonb_object_agg(fn.value->>'f', jsonb_build_object('src', proc.prosrc, 'owner', proc.proowner::text,
           'acl', coalesce(proc.proacl::text, ''), 'definer', proc.prosecdef, 'volatile', proc.provolatile,
           'config', coalesce(proc.proconfig::text, '')))
    into before_state
    from jsonb_array_elements(role_functions) fn
    join pg_proc proc on proc.oid = to_regprocedure(fn.value->>'f');

  -- 2. G1 the codes, G2 the role, G3 the rows.
  insert into auth.permissions (code, description)
  select value->>0, value->>1 from jsonb_array_elements(new_codes);
  insert into auth.roles (code, description) values
    ('dentist', 'Dentist: dental clinic visits, the FDI tooth chart and signed dental procedures, with the doctor''s '
      || 'codes for the visit, prescribing and lab ordering');
  insert into auth.role_permissions (role_code, permission_code) values
    ('dentist', 'ehr.dental.read'), ('dentist', 'ehr.dental.write'), ('dentist', 'ehr.encounter.read'),
    ('dentist', 'ehr.encounter.write'), ('dentist', 'ehr.note.read'), ('dentist', 'ehr.note.write'),
    ('dentist', 'ehr.diagnosis.read'), ('dentist', 'ehr.diagnosis.write'), ('dentist', 'ehr.prescription.read'),
    ('dentist', 'ehr.prescription.write'), ('dentist', 'ehr.lab-request.read'), ('dentist', 'ehr.lab-request.write'),
    ('dentist', 'ehr.vital.read'), ('dentist', 'ehr.vital.write'), ('dentist', 'ehr.document.read'),
    ('dentist', 'ehr.document.write'), ('dentist', 'ehr.order-route.send'),
    ('dentist', 'identity.authorization.check'), ('dentist', 'identity.consent.read'),
    ('dentist', 'identity.consent.write'), ('dentist', 'identity.patient-access-pin.verify'),
    ('dentist', 'identity.patient.read'), ('dentist', 'lab.result.released.read'),
    ('dentist', 'lab.work-item.accept'), ('dentist', 'pharmacy.dispensing.read');

  -- G4 the staff vocabulary: each function from its current definition with its one insertion.
  for entry in select value from jsonb_array_elements(role_functions) loop
    source := pg_get_functiondef(to_regprocedure(entry->>'f'));
    if (length(source) - length(replace(source, entry->>'find', ''))) / length(entry->>'find') <> 1 then
      raise exception using errcode = '55000',
        message = '0194: ' || (entry->>'f') || ' does not name the roles as 0001-0153 do; nothing applied';
    end if;
    replaced := replace(source, entry->>'find', entry->>'with');
    execute replaced;
    applied_functions := applied_functions + 1;
  end loop;
  for entry in select value from jsonb_array_elements(role_checks) loop
    select array_agg(value order by ord) into found_values
      from jsonb_array_elements_text(check_state->(entry->>'c')) with ordinality found(value, ord);
    -- dentist after doctor; every value found kept, in its order.
    wanted_values := array['doctor', 'dentist'] || found_values[2:];
    execute format('alter table %s drop constraint %I', entry->>'t', entry->>'c');
    execute format('alter table %s add constraint %I check (role_code in (%s)) not valid', entry->>'t', entry->>'c',
      (select string_agg(quote_literal(value), ', ' order by ord)
         from unnest(wanted_values) with ordinality v(value, ord)));
    execute format('alter table %s validate constraint %I', entry->>'t', entry->>'c');
    check_state := check_state || jsonb_build_object(entry->>'c', to_jsonb(wanted_values));
  end loop;

  -- G6 the audit rows.
  insert into audit.events (correlation_id, actor_type, action, outcome, resource_type, resource_id, purpose_of_use,
    reason, provenance, source_system, details)
  select correlation, 'system', 'auth.permission.add', 'success', 'permission', value->>0, 'healthcare-operations',
         reason_text, 'migration', 'hid-0194',
         jsonb_build_object('permissionCode', value->>0, 'migration', '0194', 'decision', decision)
    from jsonb_array_elements(new_codes);
  insert into audit.events (correlation_id, actor_type, action, outcome, resource_type, resource_id, purpose_of_use,
    reason, provenance, source_system, details)
  values (correlation, 'system', 'auth.role.add', 'success', 'role', 'dentist', 'healthcare-operations', reason_text,
          'migration', 'hid-0194', jsonb_build_object('roleCode', 'dentist', 'migration', '0194', 'decision', decision));
  insert into audit.events (correlation_id, actor_type, action, outcome, resource_type, resource_id, purpose_of_use,
    reason, provenance, source_system, details)
  select correlation, 'system', 'auth.role-permission.add', 'success', 'role-permission',
         grant_row.role_code || '/' || grant_row.permission_code, 'healthcare-operations', reason_text, 'migration',
         'hid-0194', jsonb_build_object('roleCode', grant_row.role_code, 'permissionCode', grant_row.permission_code,
           'migration', '0194', 'decision', decision)
    from auth.role_permissions grant_row
   where grant_row.role_code = 'dentist'
   order by grant_row.permission_code collate "C";

  -- G5 the sealed QA step.
  installed := exists (select 1 from identity.facilities facility
                        where facility.id = qa_hospital and facility.organization_id = qa_hospital_organization)
               and identity.sealed_qa_facility(qa_hospital);
  if not installed then
    raise notice '0194: the sealed QA tenant is not installed here (QA Hospital is not a QA facility): no QA login written';
  else
    if exists (select 1 from auth.accounts account
                where lower(account.email) = qa_email and account.status <> 'deleted' and account.id <> qa_account)
       or exists (select 1 from identity.staff staff_row
                   where lower(staff_row.email) = qa_email and staff_row.id is distinct from qa_staff)
       or exists (select 1 from identity.organization_applications application
                   where lower(application.administrator_email) = qa_email
                     and application.status in ('pending_verification', 'ready_for_review'))
       or exists (select 1 from identity.staff_invitations invitation
                   where lower(invitation.invitee_email) = qa_email
                     and invitation.status = 'pending' and invitation.expires_at > clock_timestamp()) then
      raise exception using errcode = '55000', message = '0194: SEALED_QA_ADDRESS_TAKEN';
    end if;
    saved_role := current_setting('role');
    if applier <> owner_oid then
      execute format('set local role %I', pg_get_userbyid(owner_oid));
    end if;
    insert into identity.sealed_qa_members (member_kind, member_id) values ('account', qa_account);
    get diagnostics step = row_count; written := written + step;
    insert into auth.accounts (id, subject, email, display_name, status, email_verified_at, source_system)
    values (qa_account, qa_subject, qa_email, qa_name, 'pending_reset', clock_timestamp(), 'hid-sealed-qa');
    get diagnostics step = row_count; written := written + step;
    insert into identity.staff (id, account_id, full_name, email, verification_status, default_role, active,
      source_system)
    values (qa_staff, qa_account, qa_name, qa_email, 'verified', 'dentist', true, 'hid-sealed-qa');
    get diagnostics step = row_count; written := written + step;
    insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
      membership_role, app_role, is_primary, active, source_system)
    values (qa_membership, qa_staff, qa_account, qa_hospital_organization, qa_hospital, 'dentist', 'dentist', true,
            true, 'hid-sealed-qa');
    get diagnostics step = row_count; written := written + step;
    insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
    values (qa_membership, qa_account, 'dentist', 'facility', qa_membership, qa_hospital, qa_role_reason);
    get diagnostics step = row_count; written := written + step;
    insert into audit.events (correlation_id, actor_type, facility_id, action, outcome, resource_type, resource_id,
      purpose_of_use, reason, provenance, source_system, details)
    values (qa_correlation, 'system', qa_hospital, 'identity.sealed-qa.staff-login-add', 'success', 'staff-membership',
            qa_membership::text, 'healthcare-operations', qa_audit_reason, 'migration', 'hid-sealed-qa',
            jsonb_build_object('membershipId', qa_membership, 'roleCode', 'dentist', 'migration', '0194',
              'decision', 'Q155 A'));
    get diagnostics step = row_count; written := written + step;
    perform set_config('role', saved_role, true);
  end if;

  -- 3. Post-checks.
  if (select md5(string_agg(grant_row.role_code || ' ' || grant_row.permission_code, ','
                            order by grant_row.role_code collate "C", grant_row.permission_code collate "C"))
        from auth.role_permissions grant_row where grant_row.role_code = 'dentist') is distinct from rows_md5
     or (select count(*) from auth.role_permissions grant_row where grant_row.role_code = 'dentist') <> 25
     or (select count(*) from auth.role_permissions grant_row
          where grant_row.permission_code in ('ehr.dental.read', 'ehr.dental.write')) <> 2 then
    raise exception using errcode = '55000', message = '0194: post-check failed: the 25 rows of the dentist';
  end if;
  if (select string_agg(grant_row.role_code || ' ' || grant_row.permission_code || ' ' || grant_row.granted_at::text,
                        ',' order by grant_row.role_code collate "C", grant_row.permission_code collate "C")
        from auth.role_permissions grant_row where grant_row.role_code <> 'dentist')
     is distinct from rows_before then
    raise exception using errcode = '55000', message = '0194: post-check failed: another role''s row changed';
  end if;
  -- Each function is its old body with exactly the one insertion (taking the insertion out gives the old body back,
  -- and dentist appears once), and its owner, ACL, SECURITY DEFINER, volatility and settings are unchanged.
  select string_agg(fn.value->>'f', ', ') into missing
    from jsonb_array_elements(role_functions) fn
    left join pg_proc proc on proc.oid = to_regprocedure(fn.value->>'f')
   where proc.oid is null
      or replace(proc.prosrc, fn.value->>'with', fn.value->>'find') is distinct from before_state->(fn.value->>'f')->>'src'
      or (length(proc.prosrc) - length(replace(proc.prosrc, '''dentist''', ''))) / length('''dentist''') <> 1
      or (length(proc.prosrc) - length(replace(proc.prosrc, fn.value->>'with', ''))) / length(fn.value->>'with') <> 1
      or proc.proowner::text is distinct from before_state->(fn.value->>'f')->>'owner'
      or coalesce(proc.proacl::text, '') is distinct from before_state->(fn.value->>'f')->>'acl'
      or proc.prosecdef is distinct from (before_state->(fn.value->>'f')->>'definer')::boolean
      or proc.provolatile::text is distinct from before_state->(fn.value->>'f')->>'volatile'
      or coalesce(proc.proconfig::text, '') is distinct from before_state->(fn.value->>'f')->>'config';
  if missing is not null or applied_functions <> 8 then
    raise exception using errcode = '55000', message = '0194: post-check failed: ' || coalesce(missing, 'the functions');
  end if;
  for entry in select value from jsonb_array_elements(role_checks) loop
    if (select pg_get_constraintdef(constraint_row.oid) from pg_constraint constraint_row
         where constraint_row.conrelid = (entry->>'t')::regclass and constraint_row.conname = entry->>'c'
           and constraint_row.convalidated)
       is distinct from 'CHECK ((role_code = ANY (ARRAY['
         || (select string_agg(quote_literal(value) || '::text', ', ' order by ord)
               from jsonb_array_elements_text(check_state->(entry->>'c')) with ordinality v(value, ord)) || '])))'
       or (check_state->(entry->>'c')->>1) is distinct from 'dentist' then
      raise exception using errcode = '55000', message = '0194: post-check failed: ' || (entry->>'c');
    end if;
  end loop;
  if (select count(*) from audit.events event_row
       where event_row.correlation_id = correlation and event_row.actor_type = 'system'
         and event_row.actor_account_id is null and event_row.actor_membership_id is null
         and event_row.facility_id is null and event_row.patient_id is null) <> 28 then
    raise exception using errcode = '55000', message = '0194: post-check failed: the audit rows';
  end if;
  if installed then
    if written <> 6
       or not exists (select 1 from auth.accounts account
                       where account.id = qa_account and account.status = 'pending_reset'
                         and account.password_hash is null and identity.sealed_qa_account(qa_account))
       or (select count(*) from identity.staff_facility_memberships membership where membership.account_id = qa_account) <> 1
       or (select count(*) from auth.account_roles assignment where assignment.account_id = qa_account) <> 1
       or not exists (select 1 from auth.account_roles assignment
                       where assignment.id = qa_membership and assignment.role_code = 'dentist'
                         and assignment.facility_id = qa_hospital and assignment.revoked_at is null)
       or (select count(*) from audit.events event_row where event_row.correlation_id = qa_correlation) <> 1 then
      raise exception using errcode = '55000', message = '0194: post-check failed: the QA login is not as written';
    end if;
  elsif exists (select 1 from auth.accounts account where account.id = qa_account)
        or exists (select 1 from audit.events event_row where event_row.correlation_id = qa_correlation) then
    raise exception using errcode = '55000', message = '0194: post-check failed: QA rows written without the QA tenant';
  end if;

  raise notice '0194: codes ehr.dental.read and ehr.dental.write, role dentist (licence body MDCN, invitable at hospitals and clinics) with 25 role rows, 28 audit rows%.',
    case when installed then '; QA Dentist at QA Hospital (pending_reset)' else '' end;
end
$den0194$;
