-- 0155 A facility's own medicines and lab tests (ORD-7 of the Akos EHR plan,
-- lane D, third slice: facility items). The planned contract's section
-- "ORD-7: Medicine and lab-test lists, and lab tests by name only", part
-- "Facility items", is what this builds the database part of. The plan is
-- the clinical owner's design note on hid-system#258 (Ola, 26 November 2026,
-- 12:34 UTC, comment 7192389223), which takes Rahman's reviews 7167521757 and
-- 7167526411 and the coordinator's Billing decision 7177222281 (option 2).
-- Written on staging-novu-ci-20261005 at 0cfddcc9 (Release E: 0001-0153,
-- live). The number is a booking, given in release order at integration; no
-- migration number appears inside a function body, so renumbering leaves
-- every md5. Of the files since 0149 it uses only 0149's and 0152's objects:
-- 0153 and 0154 are not required. The declaration is signed separately.
--
-- THE GAP. 0149's national lists hold only what the clinical lead signed. A
-- facility that stocks a medicine or runs a test that is not on them has no
-- code to order it by, and no list to pick it from.
--
-- WHAT IT DOES
-- F1 ehr.catalog_facility_items: one row per item a facility adds. The id
--    (a uuid) is the item's code under the code system HID-FACILITY. The
--    facility; the kind (medicine or lab_test); display (1-500); the
--    contract's fields (EHR_PLANNED_CONTRACT.md, "Facility items"): for a
--    medicine the generic name (1-200, required), strength (up to 80), dose
--    form (section 46's values) and routes (at most 5, each 1-100); for a
--    test the specimen (up to 100) and category (0149's twelve), both
--    optional; a CHECK keeps each kind to its own fields. Active,
--    row_version, the Idempotency-Key and the request's sha256, who added
--    it (account, membership, time) and who last changed it (account,
--    membership, time: all three null or all three set, a CHECK). A
--    generated tsvector over the display and the generic name, split into
--    words exactly as 0149's lists and a search split them, with a GIN index.
--    Foreign keys (Rahman's answer 3): the facility to identity.facilities,
--    and (created_by_membership_id, facility_id, created_by) and
--    (changed_by_membership_id, facility_id, changed_by) to
--    identity.staff_facility_memberships(id, facility_id, account_id), as
--    0004 does for ehr.diagnoses; no separate key to auth.accounts.
--    Limits: one active name per kind at a facility, a unique index on
--    (facility_id, kind, lower(display)) where active (the service answers
--    FACILITY_ITEM_EXISTS); the Idempotency-Key unique on (facility_id,
--    created_by, idempotency_key), kept on the row with the request's
--    sha256 (there is no facility-level keys table, Rahman's answer 10 on
--    0180).
-- F2 ehr.catalog_facility_item_guard(), BEFORE INSERT OR UPDATE for each
--    row (runs as the writing role):
--    a. an INSERT starts at row_version 1, created now, with no change
--       recorded (55000 otherwise), and each route 1-100 characters
--       (23514 FACILITY_ITEM_ROUTES_INVALID);
--    b. an UPDATE may change only active, row_version (to the old value
--       + 1) and the three "changed" columns; anything else is 55000
--       FACILITY_ITEM_IMMUTABLE, so the id, facility, kind, names, creator,
--       key and digest never change;
--    c. an item that becomes active (an INSERT, or an UPDATE from inactive
--       to active, a re-activation) is held to at most 500 active items of
--       its kind at its facility: it takes
--       pg_advisory_xact_lock(7410, hashtext(facility_id::text)), then
--       counts, and refuses the 501st (P0001 FACILITY_ITEM_LIMIT). The name
--       index is checked on re-activation too, as on any insert of an index
--       entry. The count is read after the lock in its own statement, so
--       under READ COMMITTED (ehr-api's default) it sees every item another
--       transaction committed before letting the lock go. An add whose
--       creator's Idempotency-Key is already on a row (the same request
--       again, which waited for the first) is not counted: the key index
--       refuses it (23505), or the service's ON CONFLICT inserts nothing, so
--       a replay at the cap answers as a replay, not FACILITY_ITEM_LIMIT.
--    Class key 7410 is new. At 0cfddcc9, #331 9d41866c, #335 d50825fa, #336
--    f804c9e8, #337 6038c85e and #343 ad5080bc the only two-key advisory
--    lock is 0153's 7409. PostgreSQL keeps the one-key and two-key spaces
--    apart, so 7410 meets no other lock; nothing else may use it.
-- F3 DELETE and TRUNCATE refused by platform.reject_mutation() triggers, as
--    0152 does: an item is never deleted, so its code is never reused.
-- F4 Row security, enabled and forced (Rahman's point 1). Four permissive
--    policies, for every role (privileges say who may use them: only the
--    EHR runtime has any on the table, F9). Every session reader and the
--    write check are called as (select ...), so each runs once per
--    statement, not once per row (Rahman's 0180 review, item 3):
--    - read: facility_id = the session's facility;
--    - insert: facility_id, created_by and created_by_membership_id equal
--      the session's facility, account and membership, and the write check
--      (F5) is true. That is 0141's author check in policy form:
--      platform.current_account_id() is
--      auth.account_id_for_subject(platform.current_actor_subject());
--    - update: USING the session's facility and the write check; WITH
--      CHECK the same facility, changed_by and changed_by_membership_id the
--      session's account and membership, and the write check;
--    - owner read, as 0141's: the table's owner reads every row. Without it
--      the definer search and status (F6, F7) would find nothing under
--      production's NOSUPERUSER NOBYPASSRLS owner. Because the owner sees
--      every facility, F6 and F7 filter on platform.current_facility_id()
--      inside their bodies, never on an argument, and with no session
--      facility they return no facility rows.
--    So a session at facility A never sees B's items, cannot insert a B row
--    and cannot change B's rows.
-- F5 ehr.facility_item_write_allowed() (Rahman's answer 7): whether the
--    session may write items: auth.membership_has_permission(the session's
--    subject, membership and facility, 'ehr.catalog.facility-item.write').
--    Like 0141's ehr.is_consultation_draft_author it answers only for the
--    session; unlike it, it takes no argument, so it cannot be asked about
--    another member or facility. A helper, because runtime-grants.sql grants
--    auth.membership_has_permission only to the identity, outreach and
--    schema test runtimes, not to the EHR runtime. SECURITY DEFINER, STABLE,
--    plpgsql, search_path pg_catalog, pg_temp; EXECUTE to hid_ehr_runtime
--    alone (a policy wrapper; Rahman's 0180 answer 9).
-- F6 ehr.search_catalog_facility_items(kind, q, limit) (new; Rahman's answer
--    2: separate from 0149's searches, which are not changed). SECURITY
--    DEFINER, STABLE, plpgsql. The session facility's active items of the
--    kind where every word of q starts a word of the display or the generic
--    name, with 0149's query helper (the first 6 words of q, each cut to 40
--    characters; q never reaches to_tsquery as typed). Each with its own
--    display, which 0149's medicine search cannot return. Names that start
--    with q first, then the display in the "C" collation, then the id; at
--    most limit (1-25) and whether more matched. It answers when no national
--    version is active. 22023 CATALOG_SEARCH_INVALID for a kind other than
--    medicine or lab_test, q outside 2-100 characters after trimming or a
--    limit outside 1-25.
-- F7 ehr.catalog_status() (0152's) is replaced by a plpgsql body with the
--    same columns. offered adds the session facility's active items of the
--    kind; available is "a national version is active, or the facility
--    offers an item". Versions, approval dates, notices and sha256 stay the
--    national list's. With no facility items, or no session facility, it
--    answers exactly as 0152's: Release E's ehr-api calls it on the pool
--    (no session facility) and needs offered > 0, so its answer does not
--    change. STABLE, SECURITY DEFINER and search_path are restated
--    (CREATE OR REPLACE keeps the owner and 0149's grants).
-- F8 auth.permissions gains ehr.catalog.facility-item.write, and
--    auth.role_permissions one row, admin (owner question 5: admin only; a
--    later role is one more row), in 0150's form; audit.events two rows as
--    the system actor, auth.permission.add for the new code and
--    auth.role-permission.add for admin's row, as Billing's 0162 does, so
--    release declarations count codes and role rows the same way (Rahman,
--    7175579690). Permissions are read on every request, so admins hold it
--    from their next request; nobody is signed out.
-- F9 Grants (here and in runtime-grants.sql): SELECT, INSERT and UPDATE on
--    the table to hid_ehr_runtime (no DELETE); EXECUTE on F5 to
--    hid_ehr_runtime alone; EXECUTE on F6 to hid_ehr_runtime and
--    hid_schema_test_runtime, as 0149 and 0153 grant theirs; F2 to no role
--    (its trigger runs it); F7 keeps 0149's grants. Each where the role
--    exists; revoked from PUBLIC.
--
-- What Billing relies on (coordinator, option 2, 7177222281). An order of a
-- facility item carries the code system HID-FACILITY and the item's id as
-- PostgreSQL writes it (36 characters, lower case). The id is the primary
-- key; F2 refuses any change to it and F3 any delete, so it is unique and
-- never reused. Withdrawing (active false) keeps the row and its id, and
-- re-activation brings back the same id. Kept stable for a later read by
-- Billing: the name ehr.catalog_facility_items; the columns id, facility_id,
-- kind (medicine, lab_test) and active; and the owner read policy (the
-- owner reads only through it under FORCE). That policy shows every
-- facility, so such a read must match facility_id as well as id.
--
-- Locks, taken first (step 0), NOWAIT, in one attempt, as 0150 does: SHARE
-- ROW EXCLUSIVE on auth.role_permissions (other writers wait; every reader,
-- each request's permission check included, goes on), and on
-- identity.facilities and identity.staff_facility_memberships, which the new
-- table's foreign keys reference (Rahman's answer 3); ROW EXCLUSIVE on
-- auth.permissions and audit.events (the new rows); ROW SHARE on auth.roles
-- (the role row's key) and on auth.accounts, identity.organizations and
-- identity.patients (the audit rows' keys open every table they reference,
-- even for a null key, as 0150 says). A busy table fails the attempt at
-- once and its subtransaction gives back what it took. The attempt is made
-- 50 times, 100 ms apart (about 5 seconds), then 55P03 "0155: ... stayed
-- busy for 5 seconds; nothing applied; run the release again at a quieter
-- time". When this transaction already holds an earlier migration's locks
-- that stop other sessions (the runner's dry run of every pending file), one
-- attempt and no sleep: 55P03 "0155: ... so it does not wait; nothing
-- applied; ...". Both are the runner's busy refusal, so a dry run rolls back
-- and tries again (dry-run-attempts.mjs). No catalogue list is locked: F2,
-- F5, F6 and F7 are plpgsql with no %ROWTYPE or %TYPE, so creating them
-- opens no table. (With either, the body would open its table when it is
-- made; behind another lock that fails at the runner's 5 s lock_timeout with
-- a compile error the dry run does not retry.) Other waits are not NOWAIT,
-- and the runner's lock_timeout ends each after 5 seconds (not a busy
-- refusal; nothing applied): a row of auth.roles another session holds FOR
-- UPDATE, or DDL in flight on audit.events' identity sequence.
-- What waits while 0155 holds its locks: writes to facilities, to staff
-- memberships (sign-ups, desk enrolment, invitations) and to role rows.
-- Reads do not wait, and neither do audit writes or permission checks.
-- Measured on throwaway PostgreSQL 16 with 0001-0153 applied (fictional
-- data; the new table is empty, so no foreign key reads a row), ten runs
-- with a superuser applier and ten with a NOSUPERUSER NOBYPASSRLS applier:
-- the hold, from the lock attempt to commit, was 21.8-26.6 ms and 21.3-34.8
-- ms. Behind an open write of identity.facilities the file stopped with the
-- 5-second refusal after 4.98 s, and with an earlier lock held in its own
-- transaction at once (11 ms), nothing applied. With 0155's transaction
-- open, reads of facilities, memberships and role rows, a permission check
-- and an audit insert ran at once; writes of facilities, memberships and
-- role rows waited (55P03 under a 200 ms lock_timeout). pg_locks before
-- commit, on existing tables: SHARE ROW EXCLUSIVE on auth.role_permissions,
-- identity.facilities and identity.staff_facility_memberships; ROW EXCLUSIVE
-- on auth.permissions and audit.events; ROW SHARE on auth.roles,
-- auth.accounts, identity.organizations and identity.patients; ACCESS SHARE
-- on some of these where the file only reads them; none on 0149's or 0152's
-- lists or versions.
--
-- Old services on this schema: nothing calls F5 or F6 or reads the table;
-- F7 answers as 0152's while no facility item exists or no session facility
-- is set (Release E's ehr-api calls it on the pool). The new code is held by
-- admin only, which no old service checks. New services on a schema without
-- this file: the facility-item routes and search answer 503
-- CATALOG_UNAVAILABLE (42P01 or 42883), and the status answers as 0152's.
--
-- Undo (owner-signed, one transaction; Rahman's point 5). Every lock below
-- is taken first, NOWAIT, in one attempt, as 0152 takes its two:
-- 1. Remove admin's row, under 0150's locks, with an audit row.
-- 2. Put back 0152's status. It is language sql, so first lock what it reads
--    ACCESS SHARE NOWAIT: ehr.catalog_versions, ehr.catalog_medicines,
--    ehr.catalog_lab_tests and ehr.catalog_diagnoses. Post-check md5
--    af2b63e1d10f9922a69ab9ed216c5e09 and STABLE.
-- 3. Only to withdraw items as well: lock the table ACCESS EXCLUSIVE NOWAIT;
--    lift FORCE for this transaction, as 0154's undo does; set active =
--    false and row_version = row_version + 1 (only those two columns change,
--    so the guard lets it through, and the "changed" columns keep their
--    all-or-none CHECK); restore FORCE. Under FORCE, the owner's UPDATE
--    changes 0 rows (Rahman's test).
-- The table, F5, F6 and the code stay; the ledger row stays.
-- Images: ehr-api, lab-api and identity-api can roll back to Release E's,
-- which never read the table. Rollback floor: once a facility lab test has
-- been ordered, ehr-api and lab-api stay at or above 0155's images, because
-- Release E's sensitive-test lists do not hide a dotted or kit name.
-- Withdrawing items (step 3) stops new orders only; recorded requests and
-- results keep their names.
--
-- Release: 0155, then ehr-api, lab-api (the sensitive-test list, in the same
-- PR) and identity-api, then the website. No sprint file rides with it.
--
-- 0. The locks (above).
-- 1. Preconditions (55000, or 42501 for the applier; nothing applied):
--    a. 0149's and 0152's objects; b. not applied yet ("0155: already
--    applied" when every object of this file is as it leaves it, comparing
--    only 0155's own role row: admin's, so a role given the code later does
--    not change the answer; any other state with one of them: "not in the
--    reviewed state"); c. by md5: 0152's
--    status (af2b63e1...), 0149's query helper (with its owner and
--    search_path), auth.membership_has_permission,
--    auth.account_id_for_subject, the four platform.current_* readers that
--    F4 and F5 call, and platform.reject_mutation(); d. the membership key
--    the foreign keys reference; e. admin active, still holding the 16 codes
--    0001-0153 gave it (a subset: codes other lanes add pass; Billing's 0162
--    adds ten), and the new code on no role; f. the applier owns
--    ehr.catalog_versions (as 0153 requires). 0149's searches are neither
--    called nor changed, so they are not pinned.
-- 2. F1-F3. 3. F5 and F4. 4. F6 and F7. 5. F9. 6. F8. 7. Comments.
-- 8. Post-checks (55000): the owners; the grants; relrowsecurity and
--    relforcerowsecurity; each policy in full (name, command, roles,
--    permissive, expressions); the guard trigger (tgtype 23, its function,
--    no WHEN, no column list, no arguments, enabled 'O') and the guard's
--    md5, owner and search_path; the DELETE and TRUNCATE refusals pinned the
--    same way (tgtype 11 and 34); F5, F6 and F7's md5, owner, SECURITY
--    DEFINER, STABLE and search_path; the three foreign keys and the name
--    index by definition; admin's new row and the two audit rows; an empty
--    table.

-- 0. The locks, NOWAIT, at most 5 s; one attempt when this transaction
-- already holds an earlier migration's locks.
do $locks$
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
begin
  loop
    attempt := attempt + 1;
    begin
      lock table auth.role_permissions, identity.facilities, identity.staff_facility_memberships
        in share row exclusive mode nowait;
      lock table auth.permissions, audit.events
        in row exclusive mode nowait;
      lock table auth.roles, auth.accounts, identity.organizations, identity.patients
        in row share mode nowait;
      exit;
    exception when lock_not_available then
      -- Both endings are the runner's busy refusal (dry-run-attempts.mjs), so a dry run tries again.
      if holding then
        raise exception using errcode = '55P03',
          message = '0155: auth.role_permissions, identity.facilities, identity.staff_facility_memberships, '
            || 'auth.permissions, audit.events or a table 0155''s rows check (the roles, accounts, organizations and '
            || 'patients) is busy, and this transaction already holds an earlier migration''s locks, so it does not '
            || 'wait; nothing applied; run the release again at a quieter time';
      end if;
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0155: auth.role_permissions, identity.facilities, identity.staff_facility_memberships, '
            || 'auth.permissions, audit.events or a table 0155''s rows check (the roles, accounts, organizations and '
            || 'patients) stayed busy for 5 seconds; nothing applied; run the release again at a quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
end
$locks$;

-- 1. Preconditions (under the locks).
do $$
declare
  new_code constant text := 'ehr.catalog.facility-item.write';
  -- admin's codes as 0001-0153 leave them (Release C, 0150 and Release E add none). Every one must still be held;
  -- codes other lanes add to admin are accepted.
  admin_codes constant text[] := array['audit.read', 'identity.registration.approve', 'identity.registration.write',
    'lab.accession.read', 'lab.execution.read', 'lab.import.read', 'lab.result.released.read', 'ocr.job.read',
    'organization.manage', 'outreach.campaign.read', 'outreach.campaign.write', 'outreach.registration.read',
    'outreach.registration.write', 'pharmacy.dispensing.read', 'pharmacy.import.read', 'workforce.manage'];
  owner_oid oid;
  mismatch text;
begin
  -- a. 0149's and 0152's objects.
  if to_regclass('ehr.catalog_versions') is null or to_regclass('ehr.catalog_medicines') is null
     or to_regclass('ehr.catalog_lab_tests') is null or to_regclass('ehr.catalog_diagnoses') is null
     or to_regprocedure('ehr.search_catalog_diagnoses(text,integer)') is null then
    raise exception using errcode = '55000', message = '0155: 0149 and 0152 must be applied first';
  end if;
  -- b. Not applied yet.
  if to_regclass('ehr.catalog_facility_items') is not null
     or to_regprocedure('ehr.catalog_facility_item_guard()') is not null
     or to_regprocedure('ehr.facility_item_write_allowed()') is not null
     or to_regprocedure('ehr.search_catalog_facility_items(text,text,integer)') is not null
     or exists (select 1 from auth.permissions permission_row where permission_row.code = new_code)
     or exists (select 1 from auth.role_permissions grant_row where grant_row.permission_code = new_code) then
    if to_regclass('ehr.catalog_facility_items') is not null
       and (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure('ehr.catalog_status()'))
           = '99e0abe265d0006f77ff6f279986dea2'
       and (select md5(proc.prosrc) from pg_proc proc
             where proc.oid = to_regprocedure('ehr.catalog_facility_item_guard()')) = '7c542dcf3cc6586d88c3d384cf9f245f'
       and (select md5(proc.prosrc) from pg_proc proc
             where proc.oid = to_regprocedure('ehr.facility_item_write_allowed()')) = 'b6ed2869600110b6399835bd4c4f6d7e'
       and (select md5(proc.prosrc) from pg_proc proc
             where proc.oid = to_regprocedure('ehr.search_catalog_facility_items(text,text,integer)'))
           = '56d5b39e176c83b02a12df1c8a3e3e77'
       and exists (select 1 from auth.permissions permission_row
                    where permission_row.code = new_code and permission_row.active)
       and exists (select 1 from auth.role_permissions grant_row
                    where grant_row.role_code = 'admin' and grant_row.permission_code = new_code)
       and (select count(*) from audit.events event_row
             where event_row.correlation_id = '0155-catalog-facility-items') = 2 then
      raise exception using errcode = '55000', message = '0155: already applied';
    end if;
    raise exception using errcode = '55000',
      message = '0155: the facility items, their functions or the code ehr.catalog.facility-item.write exist, with '
        || 'other content than 0155 leaves; not in the reviewed state; nothing applied';
  end if;
  -- c. What the new bodies and policies call, and what they replace, by md5.
  select string_agg(expected.signature, ', ' order by expected.signature) into mismatch
    from (values
      ('ehr.catalog_status()', 'af2b63e1d10f9922a69ab9ed216c5e09'),
      ('ehr.catalog_search_query(text)', '8b3c964d6b9f34c557210acfe1f986ff'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('auth.account_id_for_subject(text)', '4678770cf6a210034740f09422fdfbaa'),
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_account_id()', 'b715ffe72856836d13ab16656fa6e94a'),
      ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
      ('platform.current_membership_id()', '641989704fea95f885fbc38c6feb5aa5'),
      ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def')
    ) expected(signature, body_md5)
   where to_regprocedure(expected.signature) is null
      or (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = '0155: these functions are not the ones this file relies on: ' || mismatch;
  end if;
  owner_oid := (select relation.relowner from pg_class relation where relation.oid = 'ehr.catalog_versions'::regclass);
  -- The search calls 0149's query helper as its owner (the helper is the owner's only), as 0152 pins it.
  if not exists (select 1 from pg_proc proc
                  where proc.oid = 'ehr.catalog_search_query(text)'::regprocedure and proc.proowner = owner_oid
                    and proc.proconfig = array['search_path=pg_catalog, pg_temp'])
     or not exists (select 1 from pg_proc proc
                     where proc.oid = 'ehr.catalog_status()'::regprocedure and proc.proowner = owner_oid
                       and proc.prosecdef and proc.provolatile = 's'
                       and proc.proconfig = array['search_path=pg_catalog, pg_temp']) then
    raise exception using errcode = '55000',
      message = '0155: 0149''s query helper or 0152''s status is not owned or set as made';
  end if;
  -- d. The membership key the foreign keys reference (id, facility_id, account_id).
  if not exists (select 1 from pg_constraint constraint_row
                  where constraint_row.conrelid = 'identity.staff_facility_memberships'::regclass
                    and constraint_row.contype in ('u', 'p')
                    and (select array_agg(attribute.attname::text order by key_column.position)
                           from unnest(constraint_row.conkey) with ordinality as key_column(attnum, position)
                           join pg_attribute attribute on attribute.attrelid = constraint_row.conrelid
                            and attribute.attnum = key_column.attnum)
                        = array['id', 'facility_id', 'account_id']) then
    raise exception using errcode = '55000',
      message = '0155: identity.staff_facility_memberships has no key on (id, facility_id, account_id)';
  end if;
  -- e. admin active, holding every code 0001-0153 gave it; the new code on no role (b).
  if not exists (select 1 from auth.roles role_row where role_row.code = 'admin' and role_row.active)
     or exists (select 1 from unnest(admin_codes) wanted(code)
                 where not exists (select 1 from auth.role_permissions grant_row
                                    where grant_row.role_code = 'admin' and grant_row.permission_code = wanted.code)) then
    raise exception using errcode = '55000',
      message = '0155: the role admin is inactive or lacks a code 0001-0153 gave it; nothing applied';
  end if;
  -- f. The applier owns 0149's tables, so the new objects have the same owner and the status can be replaced.
  if owner_oid is distinct from (select role_row.oid from pg_roles role_row where role_row.rolname = current_user) then
    raise exception using errcode = '42501',
      message = format('0155: apply 0155 as %s, the owner of ehr.catalog_versions (the role that applied 0149 and '
        || '0152), not %s', pg_get_userbyid(owner_oid), current_user);
  end if;
end
$$;

-- 2. The table (F1), its guard (F2) and the refusals (F3).
create table ehr.catalog_facility_items (
  id uuid not null default gen_random_uuid(),
  facility_id uuid not null,
  kind text not null check (kind in ('medicine', 'lab_test')),
  display text not null check (length(btrim(display)) between 1 and 500 and length(display) <= 500),
  generic_name text check (generic_name is null
    or (length(btrim(generic_name)) between 1 and 200 and length(generic_name) <= 200)),
  strength text check (strength is null or length(strength) between 1 and 80),
  dose_form text check (dose_form is null or dose_form in ('tablet', 'capsule', 'liquid', 'injection', 'cream',
    'inhaler', 'drops', 'other')),
  routes text[] not null default '{}' check (cardinality(routes) <= 5 and array_position(routes, null) is null),
  specimen text check (specimen is null or length(specimen) between 1 and 100),
  category text check (category is null or category in ('haematology', 'chemistry', 'microbiology', 'serology',
    'parasitology', 'urine-and-stool', 'hormones', 'molecular', 'blood-bank', 'immunology', 'histopathology',
    'other')),
  active boolean not null default true,
  row_version bigint not null default 1 check (row_version > 0),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid not null,
  created_by_membership_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  changed_by uuid,
  changed_by_membership_id uuid,
  changed_at timestamptz,
  -- Split as a search splits q (ehr.catalog_search_query): lower case, at anything not a letter or a digit.
  search_terms tsvector generated always as (to_tsvector('simple'::regconfig,
    regexp_replace(lower(display || ' ' || coalesce(generic_name, '')), '[^[:alnum:]]+', ' ', 'g'))) stored,
  constraint catalog_facility_items_pkey primary key (id),
  constraint catalog_facility_items_facility_fk foreign key (facility_id)
    references identity.facilities(id) on delete restrict,
  constraint catalog_facility_items_created_by_fk foreign key (created_by_membership_id, facility_id, created_by)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  constraint catalog_facility_items_changed_by_fk foreign key (changed_by_membership_id, facility_id, changed_by)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  constraint catalog_facility_items_kind_fields_ck check (
    (kind = 'medicine' and generic_name is not null and specimen is null and category is null)
    or (kind = 'lab_test' and generic_name is null and strength is null and dose_form is null
        and cardinality(routes) = 0)),
  constraint catalog_facility_items_changed_ck check (
    (changed_by is null and changed_by_membership_id is null and changed_at is null)
    or (changed_by is not null and changed_by_membership_id is not null and changed_at is not null)),
  constraint catalog_facility_items_key_uq unique (facility_id, created_by, idempotency_key)
);
-- One active name per kind at a facility (FACILITY_ITEM_EXISTS); a re-activation adds its entry again.
create unique index catalog_facility_items_active_name_uq
  on ehr.catalog_facility_items (facility_id, kind, lower(display)) where active;
create index catalog_facility_items_search_idx on ehr.catalog_facility_items using gin (search_terms);
revoke all on ehr.catalog_facility_items from public;

-- F2. It runs as the writing role, so its count reads what that role may read: the EHR runtime sees its session
-- facility's rows (F4), and an item of another facility is refused by the insert or update policy anyway.
create function ehr.catalog_facility_item_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  active_items bigint;
begin
  if tg_op = 'INSERT' then
    if new.changed_by is not null or new.changed_by_membership_id is not null or new.changed_at is not null then
      raise exception using errcode = '55000', message = 'FACILITY_ITEM_IMMUTABLE';
    end if;
    if exists (select 1 from unnest(new.routes) as route(word)
                where length(btrim(route.word)) < 1 or length(route.word) > 100) then
      raise exception using errcode = '23514', message = 'FACILITY_ITEM_ROUTES_INVALID';
    end if;
    new.row_version := 1;
    new.created_at := clock_timestamp();
  else
    -- Only active, row_version and the three "changed" columns may change (search_terms follows display).
    if (to_jsonb(new) - array['active', 'row_version', 'changed_by', 'changed_by_membership_id', 'changed_at',
                              'search_terms'])
       is distinct from
       (to_jsonb(old) - array['active', 'row_version', 'changed_by', 'changed_by_membership_id', 'changed_at',
                              'search_terms'])
       or new.row_version is distinct from old.row_version + 1 then
      raise exception using errcode = '55000', message = 'FACILITY_ITEM_IMMUTABLE';
    end if;
  end if;
  -- At most 500 active items of a kind at a facility, counted after the facility's lock.
  if new.active and (tg_op = 'INSERT' or not old.active) then
    perform pg_advisory_xact_lock(7410, hashtext(new.facility_id::text));
    -- The same add again (its creator's Idempotency-Key is on a row, perhaps one that committed while this waited):
    -- the key index refuses it, or ON CONFLICT inserts nothing, so it is not counted.
    if tg_op = 'INSERT' and exists (select 1 from ehr.catalog_facility_items item
                                     where item.facility_id = new.facility_id and item.created_by = new.created_by
                                       and item.idempotency_key = new.idempotency_key) then
      return new;
    end if;
    select count(*) into active_items
      from ehr.catalog_facility_items item
     where item.facility_id = new.facility_id and item.kind = new.kind and item.active and item.id <> new.id;
    if active_items >= 500 then
      raise exception using errcode = 'P0001', message = 'FACILITY_ITEM_LIMIT';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function ehr.catalog_facility_item_guard() from public;
create trigger catalog_facility_items_guard
  before insert or update on ehr.catalog_facility_items
  for each row execute function ehr.catalog_facility_item_guard();
-- F3. Never deleted, so a code is never reused.
create trigger catalog_facility_items_no_delete
  before delete on ehr.catalog_facility_items
  for each row execute function platform.reject_mutation();
create trigger catalog_facility_items_no_truncate
  before truncate on ehr.catalog_facility_items
  for each statement execute function platform.reject_mutation();

-- 3. The write check (F5), then row security (F4).
create function ehr.facility_item_write_allowed()
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  subject_value text := platform.current_actor_subject();
  membership_value uuid := platform.current_membership_id();
  facility_value uuid := platform.current_facility_id();
begin
  if subject_value is null or membership_value is null or facility_value is null then
    return false;
  end if;
  return coalesce(auth.membership_has_permission(subject_value, membership_value, facility_value,
                                                 'ehr.catalog.facility-item.write'), false);
end;
$$;
revoke all on function ehr.facility_item_write_allowed() from public;

alter table ehr.catalog_facility_items enable row level security;
alter table ehr.catalog_facility_items force row level security;
create policy catalog_facility_items_owner_read on ehr.catalog_facility_items for select
  using (pg_has_role((select relation.relowner from pg_class relation
                       where relation.oid = 'ehr.catalog_facility_items'::regclass), 'USAGE'));
create policy catalog_facility_items_facility_read on ehr.catalog_facility_items for select
  using (facility_id = (select platform.current_facility_id()));
create policy catalog_facility_items_insert on ehr.catalog_facility_items for insert
  with check (facility_id = (select platform.current_facility_id())
              and created_by = (select platform.current_account_id())
              and created_by_membership_id = (select platform.current_membership_id())
              and (select ehr.facility_item_write_allowed()));
create policy catalog_facility_items_update on ehr.catalog_facility_items for update
  using (facility_id = (select platform.current_facility_id())
         and (select ehr.facility_item_write_allowed()))
  with check (facility_id = (select platform.current_facility_id())
              and changed_by = (select platform.current_account_id())
              and changed_by_membership_id = (select platform.current_membership_id())
              and (select ehr.facility_item_write_allowed()));

-- 4. The facility search (F6) and the status (F7).
create function ehr.search_catalog_facility_items(requested_kind text, requested_q text, requested_limit integer)
returns table (item_id uuid, display text, generic_name text, strength text, dose_form text, routes text[],
  specimen text, category text, more boolean)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  trimmed text := btrim(requested_q);
  facility_value uuid := platform.current_facility_id();
  query tsquery;
  starts text;
begin
  if requested_kind is null or requested_kind not in ('medicine', 'lab_test')
     or trimmed is null or length(trimmed) < 2 or length(trimmed) > 100
     or requested_limit is null or requested_limit < 1 or requested_limit > 25 then
    raise exception using errcode = '22023', message = 'CATALOG_SEARCH_INVALID';
  end if;
  -- The owner reads every facility's items (the owner read policy), so only the session's facility is asked for.
  if facility_value is null then
    return;
  end if;
  query := ehr.catalog_search_query(trimmed);
  if query is null then
    return;
  end if;
  -- "Starts with q" for the order: q with LIKE's %, _ and \ escaped.
  starts := replace(replace(replace(lower(trimmed), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return query
    with matched as (
      select item.id, item.display, item.generic_name, item.strength, item.dose_form, item.routes, item.specimen,
             item.category
        from ehr.catalog_facility_items item
       where item.facility_id = facility_value and item.kind = requested_kind and item.active
         and item.search_terms @@ query),
    ranked as (
      select matched.*, count(*) over () as total,
             row_number() over (order by (lower(matched.display) like starts escape '\'
                                          or coalesce(lower(matched.generic_name) like starts escape '\', false)) desc,
               lower(matched.display) collate "C", matched.id) as position
        from matched)
    select ranked.id, ranked.display, ranked.generic_name, ranked.strength, ranked.dose_form, ranked.routes,
           ranked.specimen, ranked.category, ranked.total > requested_limit
      from ranked
     where ranked.position <= requested_limit
     order by ranked.position;
end;
$$;
revoke all on function ehr.search_catalog_facility_items(text, text, integer) from public;

-- F7: the same columns as 0152's; the session facility's active items are added to its lists' counts.
create or replace function ehr.catalog_status()
returns table (kind text, available boolean, list_version text, approved_at timestamptz, offered integer,
  attribution text[], file_sha256 text)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  facility_value uuid := platform.current_facility_id();
begin
  return query
    select kinds.kind, version_row.id is not null or own.items > 0, version_row.version, version_row.approved_at,
           case kinds.kind
             when 'medicine' then (select count(*)::integer from ehr.catalog_medicines medicine
                                    where medicine.version_id = version_row.id and not medicine.withdrawn)
             when 'lab_test' then (select count(*)::integer from ehr.catalog_lab_tests test
                                    where test.version_id = version_row.id and not test.withdrawn)
             else (select count(*)::integer from ehr.catalog_diagnoses diagnosis
                    where diagnosis.version_id = version_row.id) end + own.items,
           coalesce(version_row.attribution, '{}'), version_row.file_sha256::text
      from (values ('diagnosis'), ('lab_test'), ('medicine')) as kinds(kind)
      left join ehr.catalog_versions version_row on version_row.kind = kinds.kind and version_row.active
      -- The owner reads every facility's items (the owner read policy), so only the session's facility is counted;
      -- with none, no item is.
      cross join lateral (select count(*)::integer as items from ehr.catalog_facility_items item
                           where item.facility_id = facility_value and item.kind = kinds.kind and item.active) own
     order by kinds.kind;
end;
$$;

-- 5. Grants (here and in runtime-grants.sql), where the roles exist.
do $$
declare runtime_role text;
begin
  if exists (select 1 from pg_roles where rolname = 'hid_ehr_runtime') then
    grant select, insert, update on ehr.catalog_facility_items to hid_ehr_runtime;
    grant execute on function ehr.facility_item_write_allowed() to hid_ehr_runtime;
  end if;
  foreach runtime_role in array array['hid_ehr_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = runtime_role) then
      execute format('grant execute on function ehr.search_catalog_facility_items(text, text, integer) to %I',
        runtime_role);
    end if;
  end loop;
end
$$;

-- 6. The code, admin's row and their two audit rows (F8).
do $$
declare
  new_code constant text := 'ehr.catalog.facility-item.write';
  correlation constant text := '0155-catalog-facility-items';
  decision constant text := 'ORD-7 facility items, admin only (design note on hid-system#258, 26 November 2026)';
  reason_text constant text := 'ORD-7: hospital administrators add and withdraw their facility''s own medicines and '
    || 'lab tests';
begin
  insert into auth.permissions (code, description)
  values (new_code, 'Add and withdraw this facility''s own medicines and lab tests');
  insert into auth.role_permissions (role_code, permission_code) values ('admin', new_code);
  insert into audit.events (correlation_id, actor_type, action, outcome, resource_type, resource_id, purpose_of_use,
    reason, provenance, source_system, details)
  values (correlation, 'system', 'auth.permission.add', 'success', 'permission', new_code, 'healthcare-operations',
          reason_text, 'migration', 'hid-0155',
          jsonb_build_object('permissionCode', new_code, 'migration', '0155', 'decision', decision));
  insert into audit.events (correlation_id, actor_type, action, outcome, resource_type, resource_id, purpose_of_use,
    reason, provenance, source_system, details)
  values (correlation, 'system', 'auth.role-permission.add', 'success', 'role-permission', 'admin/' || new_code,
          'healthcare-operations', reason_text, 'migration', 'hid-0155',
          jsonb_build_object('roleCode', 'admin', 'permissionCode', new_code, 'migration', '0155', 'decision', decision));
end
$$;

-- 7. Comments.
comment on table ehr.catalog_facility_items is
  '0155 (ORD-7): a facility''s own medicines and lab tests, ordered under the code system HID-FACILITY with the item''s id as the code. Never deleted; a withdrawn item keeps its id. At most 500 active items of each kind per facility, one active name per kind. Row-level security, forced: a session reads its own facility''s items and writes them with ehr.catalog.facility-item.write. No patient data.';
comment on function ehr.catalog_facility_item_guard() is
  '0155 (ORD-7): guard of ehr.catalog_facility_items. An update may change only active, row_version (old + 1) and the changed columns (55000 FACILITY_ITEM_IMMUTABLE); an item that becomes active takes the facility''s lock (pg_advisory_xact_lock, class key 7410) and is refused past 500 active items of its kind (P0001 FACILITY_ITEM_LIMIT).';
comment on function ehr.facility_item_write_allowed() is
  '0155 (ORD-7): whether the session''s membership holds ehr.catalog.facility-item.write at the session''s facility. Takes no argument; the facility items'' insert and update policies call it.';
comment on function ehr.search_catalog_facility_items(text, text, integer) is
  '0155 (ORD-7): the session facility''s active items of a kind (medicine or lab_test) whose display or generic name has a word starting with each word of q; names starting with q first, then A to Z; at most limit (1-25) and whether more matched. None without a session facility. 22023 CATALOG_SEARCH_INVALID for another kind, q outside 2-100 characters or a limit outside 1-25.';
comment on function ehr.catalog_status() is
  '0149 (ORD-7), 0152 (ORD-9), 0155 (ORD-7): per kind (diagnosis, lab_test, medicine): whether an active version exists or the session''s facility offers an item, the version''s label, when it was approved, how many rows it and the facility offer, the notices its sources require and the sha256 of its seed file.';

-- 8. Post-checks.
do $$
declare
  new_code constant text := 'ehr.catalog.facility-item.write';
  owner_oid oid := (select relation.relowner from pg_class relation where relation.oid = 'ehr.catalog_versions'::regclass);
  mismatch text;
begin
  -- The owners: the table and the four functions are the catalogue's owner's.
  if (select relation.relowner from pg_class relation where relation.oid = 'ehr.catalog_facility_items'::regclass)
       is distinct from owner_oid
     or exists (select 1 from pg_proc proc
                 where proc.oid in ('ehr.catalog_facility_item_guard()'::regprocedure,
                                    'ehr.facility_item_write_allowed()'::regprocedure,
                                    'ehr.search_catalog_facility_items(text,text,integer)'::regprocedure,
                                    'ehr.catalog_status()'::regprocedure)
                   and proc.proowner is distinct from owner_oid) then
    raise exception using errcode = '55000',
      message = '0155: the facility items and their functions are not owned by the owner of ehr.catalog_versions';
  end if;
  -- The table's grants: SELECT, INSERT and UPDATE to the EHR runtime (where it exists) and nothing else; no column
  -- grant.
  if exists (select 1 from pg_class relation, lateral aclexplode(coalesce(relation.relacl,
               acldefault('r', relation.relowner))) acl
              where relation.oid = 'ehr.catalog_facility_items'::regclass and acl.grantee <> relation.relowner
                and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_ehr_runtime'
                     or acl.privilege_type not in ('SELECT', 'INSERT', 'UPDATE')))
     or (exists (select 1 from pg_roles where rolname = 'hid_ehr_runtime')
         and (select count(*) from pg_class relation, lateral aclexplode(relation.relacl) acl
               where relation.oid = 'ehr.catalog_facility_items'::regclass
                 and acl.grantee = (select oid from pg_roles where rolname = 'hid_ehr_runtime')) <> 3)
     or exists (select 1 from pg_attribute attribute
                 where attribute.attrelid = 'ehr.catalog_facility_items'::regclass and attribute.attacl is not null) then
    raise exception using errcode = '55000',
      message = '0155: the facility items are granted otherwise than SELECT, INSERT and UPDATE to the EHR runtime';
  end if;
  -- The functions' grants: the write check to the EHR runtime alone; the search and the status to the EHR and
  -- schema test runtimes; the guard to no role.
  if exists (select 1 from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where proc.oid in ('ehr.catalog_facility_item_guard()'::regprocedure,
                                 'ehr.facility_item_write_allowed()'::regprocedure,
                                 'ehr.search_catalog_facility_items(text,text,integer)'::regprocedure,
                                 'ehr.catalog_status()'::regprocedure)
                and acl.grantee <> proc.proowner
                and (acl.grantee = 0
                     or proc.oid = 'ehr.catalog_facility_item_guard()'::regprocedure
                     or (proc.oid = 'ehr.facility_item_write_allowed()'::regprocedure
                         and pg_get_userbyid(acl.grantee) <> 'hid_ehr_runtime')
                     or pg_get_userbyid(acl.grantee) not in ('hid_ehr_runtime', 'hid_schema_test_runtime'))) then
    raise exception using errcode = '55000',
      message = '0155: a facility item function is granted to a role it is not for';
  end if;
  -- Row security, enabled and forced, and each policy in full: command, permissive, roles and both expressions (by
  -- md5 of the printed text); no other policy.
  if not exists (select 1 from pg_class relation
                  where relation.oid = 'ehr.catalog_facility_items'::regclass
                    and relation.relrowsecurity and relation.relforcerowsecurity) then
    raise exception using errcode = '55000', message = '0155: row-level security is not enabled and forced';
  end if;
  with expected(policy_name, digest) as (values
         ('catalog_facility_items_facility_read', 'c6f3661b0f67247fb9239bb5085b55a0'),
         ('catalog_facility_items_insert', 'a5ef21ce5532fb4542aba9bbbb707d19'),
         ('catalog_facility_items_owner_read', 'bc461a1eebf81c48cb33edf5d41dd93c'),
         ('catalog_facility_items_update', 'a7e263b0472c644928e733a36a5f4bf5')),
       present as (
         select policy_row.polname::text as policy_name,
                md5(policy_row.polcmd::text || ':' || policy_row.polpermissive::text || ':'
                    || case when policy_row.polroles = array[0::oid] then 'public' else policy_row.polroles::text end
                    || ':' || coalesce(pg_get_expr(policy_row.polqual, policy_row.polrelid), '-') || ':'
                    || coalesce(pg_get_expr(policy_row.polwithcheck, policy_row.polrelid), '-')) as digest
           from pg_policy policy_row
          where policy_row.polrelid = 'ehr.catalog_facility_items'::regclass),
       differing as (
         select coalesce(expected.policy_name, present.policy_name) as what
           from expected full join present on present.policy_name = expected.policy_name
          where expected.digest is distinct from present.digest)
  select string_agg(differing.what, ', ' order by differing.what) into mismatch from differing;
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0155: these policies are not as made: ' || mismatch;
  end if;
  -- Each trigger's events as made (pg_trigger.tgtype: 1 for each row, 2 before, 4 insert, 8 delete, 16 update,
  -- 32 truncate): 23 before insert or update for each row, 11 before delete for each row, 34 before truncate. With
  -- no WHEN condition (tgqual), no column list (UPDATE OF: tgattr) and no arguments, enabled 'O'.
  if (select count(*) from pg_trigger trigger_row
       where not trigger_row.tgisinternal and trigger_row.tgenabled = 'O'
         and trigger_row.tgrelid = 'ehr.catalog_facility_items'::regclass
         and trigger_row.tgqual is null and trigger_row.tgattr = ''::int2vector and trigger_row.tgnargs = 0
         and ((trigger_row.tgname = 'catalog_facility_items_guard' and trigger_row.tgtype = 23
               and trigger_row.tgfoid = 'ehr.catalog_facility_item_guard()'::regprocedure)
              or (trigger_row.tgname = 'catalog_facility_items_no_delete' and trigger_row.tgtype = 11
                  and trigger_row.tgfoid = 'platform.reject_mutation()'::regprocedure)
              or (trigger_row.tgname = 'catalog_facility_items_no_truncate' and trigger_row.tgtype = 34
                  and trigger_row.tgfoid = 'platform.reject_mutation()'::regprocedure))) <> 3
     or (select count(*) from pg_trigger trigger_row
          where not trigger_row.tgisinternal and trigger_row.tgrelid = 'ehr.catalog_facility_items'::regclass) <> 3 then
    raise exception using errcode = '55000', message = '0155: the facility items'' triggers are not as made';
  end if;
  -- The four bodies exactly, with their owner, SECURITY DEFINER, volatility and search_path.
  select string_agg(expected.signature, ', ' order by expected.signature) into mismatch
    from (values
      ('ehr.catalog_facility_item_guard()', '7c542dcf3cc6586d88c3d384cf9f245f', false, 'v'),
      ('ehr.facility_item_write_allowed()', 'b6ed2869600110b6399835bd4c4f6d7e', true, 's'),
      ('ehr.search_catalog_facility_items(text,text,integer)', '56d5b39e176c83b02a12df1c8a3e3e77', true, 's'),
      ('ehr.catalog_status()', '99e0abe265d0006f77ff6f279986dea2', true, 's')
    ) expected(signature, body_md5, definer, volatility)
   where not exists (select 1 from pg_proc proc
                      where proc.oid = to_regprocedure(expected.signature)
                        and md5(proc.prosrc) = expected.body_md5 and proc.proowner = owner_oid
                        and proc.prosecdef = expected.definer and proc.provolatile = expected.volatility
                        and proc.prolang = (select language_row.oid from pg_language language_row
                                             where language_row.lanname = 'plpgsql')
                        and proc.proconfig = array['search_path=pg_catalog, pg_temp']);
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0155: these functions are not as made: ' || mismatch;
  end if;
  -- The foreign keys and the name index by definition.
  if (select string_agg(pg_get_constraintdef(constraint_row.oid), ' | ' order by constraint_row.conname)
        from pg_constraint constraint_row
       where constraint_row.conrelid = 'ehr.catalog_facility_items'::regclass and constraint_row.contype = 'f')
     is distinct from 'FOREIGN KEY (changed_by_membership_id, facility_id, changed_by) REFERENCES '
       || 'identity.staff_facility_memberships(id, facility_id, account_id) ON DELETE RESTRICT | FOREIGN KEY '
       || '(created_by_membership_id, facility_id, created_by) REFERENCES identity.staff_facility_memberships(id, '
       || 'facility_id, account_id) ON DELETE RESTRICT | FOREIGN KEY (facility_id) REFERENCES identity.facilities(id) '
       || 'ON DELETE RESTRICT'
     or (select pg_get_indexdef(index_row.indexrelid) from pg_index index_row
          where index_row.indexrelid = to_regclass('ehr.catalog_facility_items_active_name_uq'))
        is distinct from 'CREATE UNIQUE INDEX catalog_facility_items_active_name_uq ON ehr.catalog_facility_items '
          || 'USING btree (facility_id, kind, lower(display)) WHERE active' then
    raise exception using errcode = '55000', message = '0155: the facility items'' keys or name index are not as made';
  end if;
  -- admin's new row (the code active, held by admin alone) and the two audit rows; an empty table.
  if not exists (select 1 from auth.permissions permission_row where permission_row.code = new_code and permission_row.active)
     or (select string_agg(grant_row.role_code, ',') from auth.role_permissions grant_row
          where grant_row.permission_code = new_code) is distinct from 'admin'
     or (select string_agg(event_row.action || ' ' || event_row.resource_id, ',' order by event_row.sequence_id)
           from audit.events event_row where event_row.correlation_id = '0155-catalog-facility-items')
        is distinct from 'auth.permission.add ' || new_code || ',auth.role-permission.add admin/' || new_code then
    raise exception using errcode = '55000', message = '0155: the code, admin''s row or their audit rows are not as made';
  end if;
  if exists (select 1 from ehr.catalog_facility_items) then
    raise exception using errcode = '55000', message = '0155: the facility items must be empty after this file';
  end if;
  raise notice '0155: facility items ready; admins hold ehr.catalog.facility-item.write from their next request; two audit rows.';
end
$$;
