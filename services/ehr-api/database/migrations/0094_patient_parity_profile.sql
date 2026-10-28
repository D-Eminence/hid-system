-- 0094 Patient parity with hid-1.0: the profile (owner decisions of
-- 2026-10-28: patients keep health fields on the profile; migrations
-- pre-approved for this batch, the declaration signed separately; and the
-- lead's decisions for this wave).
--
-- A patient sees and changes their email and phone, adds a photo, records
-- the hospital they use and their HMO, and enters their own health
-- information (blood group, genotype, allergies, current medications,
-- chronic conditions, medical notes for the care team), which clinicians
-- with access read as reported by the patient. Production sends no SMS: a
-- phone change is confirmed by the current password (Identity checks it)
-- and announced by email; an email change needs the current password and a
-- 6-digit code sent to the new address. Identity encrypts every contact and
-- the photo (AES-256-GCM, NIN_ENCRYPTION_KEY_B64); the database stores
-- ciphertext, key versions and keyed lookups, never a code.
--
-- 0. Preconditions (catalog reads only): every prerequisite exists; no
--    object of this migration exists (else 55000 "0094: already applied");
--    the body replaced in section 7 and the 12 bodies the new ones call or
--    rely on are byte for byte the ones measured on 0001-0093 (md5 of
--    pg_proc.prosrc); identity.patients' contact CHECKs, the unique
--    email and phone indexes and the staff email index are as 0002 made
--    them, and the recovery-code invalidation reasons and the external
--    identity statuses the email change writes are 0028's and 0002's; the
--    applying role, which will own every new table and function, holds (by
--    ownership, membership or grant, never a superuser's bypass) what the
--    new bodies read, write and call (among them UPDATE on auth.sessions,
--    auth.otp_challenges and auth.external_identities, and SELECT on the
--    workforce tables), owns identity.patients (so its RLS does not hide
--    migrated patients from them) and is itself the owner of the replaced
--    readiness function (whose new body reads a table with forced RLS
--    whose owner policy names the applying role). Every attribute of the
--    replaced function but the body is recorded and compared after the
--    replacement (section 8).
--    Then the two locks the new foreign keys need are taken (see Locks).
-- 1. identity.patient_profile_details: per patient, the hospital they use
--    now and their HMO's name (free text, as hid-1.0), each 1-120
--    characters without control characters and trimmed, or null; a
--    row_version for optimistic saves.
-- 2. identity.patient_profile_photos: per patient, the photo as Identity
--    encrypted it (JPEG or PNG, at most 300 KB decoded, 1-1024 pixels a
--    side), its media type, sha256, size and dimensions and the key version.
-- 3. identity.patient_contact_changes: every contact change. An email change
--    is pending (the new address encrypted, its contact lookup HMAC, an HMAC
--    of the code bound to the change, expiry, attempts, the delivery
--    outcome) until the code is verified, then completed; a phone change is
--    completed when it is made (the password is its proof). A refused start
--    (the contact is another account's) is kept, invalidated and without
--    ciphertext, so that it counts toward the patient's limit. One pending
--    change per patient and channel; rows are never deleted; a ciphertext is
--    erased once its change is superseded or invalidated.
-- 4. ehr.patient_reported_health_profiles: per patient, what the patient
--    entered: blood group (A+ A- B+ B- AB+ AB- O+ O-), genotype (AA AS AC SS
--    SC CC), allergies, current medications, chronic conditions and medical
--    notes (each 1-1000 characters, newlines the only control characters),
--    or null; who saved it, a row_version. Kept apart from clinician
--    records and from the immutable imported hid-1.0 profile (0062).
-- 5. Row-level security, forced on all four tables. The three Identity
--    tables have one policy, for their owner, and no grant: only the
--    SECURITY DEFINER commands below read or write them. The EHR table has
--    the owner's policy (its write command) and a read policy,
--    ehr.imported_record_read_context(patient_id) as 0062's imported
--    profile: the patient in a fresh patient-self transaction (0083) or a
--    clinician whose access to the patient at the current facility is
--    granted (ehr.context_allows ... 'read_records').
-- 6. Commands, each SECURITY DEFINER with search_path pg_catalog, pg_temp:
--    the Identity ones bound to identity.patient_self_session(subject,
--    session) and a correlation id (else nothing, or 42501 for a write):
--    a. identity.patient_self_contact: the account email and whether it is
--       verified, the patient's phone ciphertext and lookup HMAC, the
--       contact change that wrote that phone (id and key version, so Identity
--       knows how to decrypt it), whether a photo exists.
--    b. identity.my_contact_change_credentials: the account's password hash
--       and algorithm (Identity checks the current password), email and its
--       verification, the patient's first name and Health ID (the notices).
--    c. identity.start_my_email_change: refuses an account that is also
--       workforce (a platform role, a staff record or a facility membership,
--       0093's test: its email is the staff sign-in and identity.staff's
--       address too) ('workforce'), the account's own email ('unchanged'),
--       more than one start a resend window or five an hour
--       ('rate_limited'), an email another account, patient or staff record
--       holds ('unavailable', recorded and audited as denied); else
--       supersedes the open change and records the pending one ('started').
--    d. identity.read_my_pending_email_change: the pending change's
--       ciphertext (Identity decrypts the address to complete it).
--    e. identity.record_my_contact_change_delivery: the code's delivery
--       outcome; a definitive failure invalidates the change (audited).
--    f. identity.complete_my_email_change: a wrong code counts (the last
--       allowed one invalidates), an expired one invalidates; the right one,
--       under the advisory lock patient-contact:email:<HMAC> (sign-up
--       activation's), re-checks that the account is not workforce and that
--       no other account, patient or staff record holds the address, then
--       sets auth.accounts.email (and email_verified_at) and
--       identity.patients' email ciphertext and lookup HMAC to the new
--       address, so sign-in, recovery, Google's link and Novu use it from
--       then on; and, so that whoever holds the previous mailbox keeps
--       nothing it gave them: unlinks the Google accounts 0093 linked because
--       Google verified the previous address (source_system
--       hid-google-verified-email-link; a link the patient made or signed up
--       with stays), invalidates the account's open recovery codes
--       (PASSWORD_RESET, LEGACY_ACCOUNT_RECOVERY, LEGACY_SESSION_FALLBACK, as
--       0029's completion does) and revokes the account's sessions outside
--       the caller's session family ('contact_changed'; token_version is
--       unchanged, so this session goes on). It answers the previous
--       address once (its notice).
--    g. identity.change_my_phone: refuses the patient's current number
--       ('unchanged', either of a Nigerian number's two stored forms) unless
--       Identity says it cannot read the stored one (a number migrated from
--       hid-1.0 under the migration's key, which the profile shows as none):
--       the same number is then written again under Identity's key, as a
--       change, so the profile shows it from then on; more than five changes
--       an hour ('rate_limited'), a number another patient holds in any of
--       its forms ('unavailable', recorded); else, under the advisory lock
--       patient-contact:phone:<HMAC> (sign-up activation's), sets
--       identity.patients' phone ciphertext and lookup HMAC (phone sign-in
--       and reset use it from then on) and records the completed change;
--       answers the verified account email for the notice.
--    h. identity.read_my_profile_details / identity.save_my_profile_details
--       (409 on a stale version: 'conflict').
--    i. identity.set_my_profile_photo / identity.read_my_profile_photo /
--       identity.remove_my_profile_photo.
--    j. ehr.save_my_reported_health_profile: only in a fresh patient-self
--       EHR transaction (ehr.patient_self_context of app.patient_id); 409 on
--       a stale version ('conflict').
--    Every write records its audit.events row in the same transaction (no
--    contact, code, photo or health value in it).
-- 7. identity.patient_contact_lookup_ready (0057), replaced: 0057's body but
--    two of its checks also accept a contact that a completed contact change
--    of section 3 wrote (Identity computed its lookup HMAC with the current
--    key, as the rekey does): an active enrollment whose patient's contact
--    on that channel is now another one that a completed change wrote; and
--    a migrated patient's contact added (none before) by a change completed
--    after the rekey marker, which counts with the marker's contacts.
--    Without changes the answer is 0057's. Without this, the first email
--    change of a sign-up patient made every sign-up answer 503. The migrated
--    patients' contacts are counted once, before the marker is read, so that
--    the marker query stays cheap (with 20,000 active enrollments it runs in
--    160-200 ms against 0057's 210-280 ms).
-- 8. Post-checks: the replaced function keeps its owner, ACL, language,
--    volatility, SECURITY DEFINER and search_path, and its body is the one
--    this file gives it; every new table and function belongs to the
--    applying role; RLS is forced on the four tables.
-- 9. Grants, here and in runtime-grants.sql: the Identity commands to
--    hid_identity_runtime and hid_schema_test_runtime; the EHR command and
--    SELECT on ehr.patient_reported_health_profiles to hid_ehr_runtime and
--    hid_schema_test_runtime; no grant on the three Identity tables; every
--    new function revoked from PUBLIC. The replaced function keeps its ACL.
--
-- Locks: SHARE ROW EXCLUSIVE on auth.accounts and identity.patients (the new
-- foreign keys), taken up front in that order (registration writes accounts
-- and then patients), NOWAIT every 10 ms for at most 5 seconds (then 55P03,
-- nothing applied), held to commit: they block writes to those two tables,
-- never reads. No existing table is altered; replacing the readiness
-- function neither waits for nor blocks its calls. Measured with pg_locks
-- before commit (the file applied in an open transaction): SHARE ROW
-- EXCLUSIVE and ACCESS SHARE on auth.accounts and identity.patients, ACCESS
-- SHARE on their primary keys; ACCESS EXCLUSIVE (and the weaker locks
-- creating them takes) on the four new tables, their indexes and TOAST
-- tables; ACCESS SHARE on ehr.imported_record_read_context and
-- platform.reject_mutation (the read policy and the no-delete trigger);
-- SHARE UPDATE EXCLUSIVE on five new functions (their comments); ACCESS
-- EXCLUSIVE on section 0's own temporary table and helper and the session's
-- temporary schema; the catalogs' own locks; no lock on auth.sessions,
-- auth.otp_challenges, auth.external_identities or the workforce tables
-- (only the new bodies, when they run, write or read them). The apply took
-- 50-65 ms on a copy migrated through 0093; with a write held open on
-- identity.patients it stopped after 5.3 s with 55P03 and nothing applied.
--
-- Old services on this schema: every change is additive. The previous
-- Identity and EHR images call none of the new commands and read none of
-- the new tables; sign-up and the NIN route keep their readiness answer
-- (identical without contact changes). Applied migrations 0001 through 0093
-- are immutable.

-- 0. Preconditions. Whether holder holds a privilege on an object by
-- ownership, membership (direct or through other roles) or grant (also to
-- PUBLIC), ignoring a superuser's bypass (0090's, 0091's and 0093's helper).
create function pg_temp.parity_0094_holds(holder oid, object_owner oid, object_acl aclitem[],
  object_type "char", wanted text)
returns boolean
language sql stable
set search_path = pg_catalog, pg_temp
as $$
  with recursive held(role_id) as (
    select holder
    union
    select membership.roleid from pg_catalog.pg_auth_members membership join held on membership.member = held.role_id
  )
  select object_owner in (select held.role_id from held)
    or exists (select 1 from pg_catalog.aclexplode(coalesce(object_acl, pg_catalog.acldefault(object_type, object_owner))) acl
                where acl.privilege_type = wanted
                  and (acl.grantee = 0 or acl.grantee in (select held.role_id from held)))
$$;

create temporary table parity_0094_replaced as
  select proc.oid, proc.oid::regprocedure::text as what, proc.proowner, proc.proacl, proc.prolang,
         proc.provolatile, proc.prosecdef, proc.proconfig, proc.prorettype, proc.proretset,
         proc.proargnames, proc.proallargtypes
    from pg_proc proc
   where proc.oid = to_regprocedure('identity.patient_contact_lookup_ready()');

do $$
declare
  mismatch text;
  applier oid := (select oid from pg_roles where rolname = current_user);
begin
  -- a. Prerequisites.
  if to_regclass('identity.patients') is null
     or to_regclass('auth.accounts') is null
     or to_regclass('auth.sessions') is null
     or to_regclass('auth.otp_challenges') is null
     or to_regclass('auth.external_identities') is null
     or to_regclass('auth.account_roles') is null
     or to_regclass('identity.staff') is null
     or to_regclass('identity.staff_facility_memberships') is null
     or to_regclass('audit.events') is null
     or to_regclass('identity.public_patient_enrollments') is null
     or to_regclass('migration.patient_contact_lookup_rekeys') is null
     or to_regprocedure('identity.patient_self_session(text,uuid)') is null
     or to_regprocedure('identity.patient_contact_lookup_ready()') is null
     or to_regprocedure('ehr.patient_self_context(uuid)') is null
     or to_regprocedure('ehr.imported_record_read_context(uuid)') is null
     or to_regprocedure('auth.find_patient_account(text,text)') is null then
    raise exception using errcode = '55000', message = '0094: 0001-0093 must be applied first';
  end if;
  -- b. Not applied yet.
  if to_regclass('identity.patient_profile_details') is not null
     or to_regclass('identity.patient_profile_photos') is not null
     or to_regclass('identity.patient_contact_changes') is not null
     or to_regclass('ehr.patient_reported_health_profiles') is not null
     or exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
                 where (namespace.nspname, proc.proname) in (
                   ('identity', 'patient_self_contact'), ('identity', 'my_contact_change_credentials'),
                   ('identity', 'start_my_email_change'), ('identity', 'read_my_pending_email_change'),
                   ('identity', 'record_my_contact_change_delivery'), ('identity', 'complete_my_email_change'),
                   ('identity', 'change_my_phone'), ('identity', 'read_my_profile_details'),
                   ('identity', 'save_my_profile_details'), ('identity', 'set_my_profile_photo'),
                   ('identity', 'read_my_profile_photo'), ('identity', 'remove_my_profile_photo'),
                   ('ehr', 'save_my_reported_health_profile'))) then
    raise exception using errcode = '55000', message = '0094: already applied';
  end if;
  -- c. The body replaced (section 7), as 0057 left it.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('identity.patient_contact_lookup_ready()', 'd6838ccecab98c38059e66e04ad75cea'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0094: the function this migration replaces has another body than 0001-0093 gave it: %s', mismatch);
  end if;
  -- d. The bodies the new ones call or rely on, unchanged: the actor,
  -- correlation and facility readers, the patient session (Identity) and the
  -- patient-self and clinician read contexts (EHR, the read policy), the
  -- consent check behind it, the audit table's trigger, the no-delete
  -- trigger, the contact binding check sign-up uses (which the uniqueness
  -- checks below mirror), and the patient account lookup that phone sign-in
  -- and reset use (which reads identity.patients.phone_lookup_hmac).
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_correlation_id()', '48d3bf187101d33bfda51dac829aa223'),
      ('platform.current_facility_id()', 'c4a7c2989e83d9cedbf1f7b785a5aaed'),
      ('identity.patient_self_session(text,uuid)', 'd4c7aeaf25317d0fae794a2764d7d72b'),
      ('ehr.patient_self_context(uuid)', '9878cfbd3dec68263d2e4bffc7cd9975'),
      ('ehr.imported_record_read_context(uuid)', 'eabd4af535ecf91508eae6003836e427'),
      ('ehr.context_allows(uuid,uuid,text)', '75016690184a80bd246c365b4d108082'),
      ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)', '8b12ce866ee75cce411a2721795ffb92'),
      ('audit.authorize_platform_event()', '41e4102669ab23df53ac4d73badc8a8c'),
      ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def'),
      ('identity.public_patient_contact_already_bound(text,char)', '85a6bec81c3b4769b3a3ec5d60ffbc5e'),
      ('auth.find_patient_account(text,text)', '4dea10555ca51d6a240e3c5bbfeaf20c'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0094: a function this migration relies on has another body than 0001-0093 gave it: %s', mismatch);
  end if;
  -- e. identity.patients' contact pairs and the unique contact indexes the
  -- changes rely on (0002); the staff email index the uniqueness checks read
  -- (0002); the recovery-code invalidation reason and the external identity
  -- status a completed email change writes (0028, 0002).
  select string_agg(format('%s: %s', expected.what, coalesce(actual.definition, 'missing')), '; ')
    into mismatch
    from (values
      ('patients_check', 'CHECK (((phone_e164_ciphertext IS NULL) = (phone_lookup_hmac IS NULL)))'),
      ('patients_check1', 'CHECK (((email_ciphertext IS NULL) = (email_lookup_hmac IS NULL)))'),
      ('patients_check3',
       'CHECK (((contact_key_version IS NOT NULL) OR ((phone_e164_ciphertext IS NULL) AND (email_ciphertext IS NULL))))'),
      ('accounts_email_ci_uq',
       $c$CREATE UNIQUE INDEX accounts_email_ci_uq ON auth.accounts USING btree (lower(email)) WHERE ((email IS NOT NULL) AND (status <> 'deleted'::text))$c$),
      ('patients_email_hmac_uq',
       'CREATE UNIQUE INDEX patients_email_hmac_uq ON identity.patients USING btree (email_lookup_hmac) WHERE (email_lookup_hmac IS NOT NULL)'),
      ('patients_phone_hmac_uq',
       'CREATE UNIQUE INDEX patients_phone_hmac_uq ON identity.patients USING btree (phone_lookup_hmac) WHERE (phone_lookup_hmac IS NOT NULL)'),
      ('staff_email_ci_uq', 'CREATE UNIQUE INDEX staff_email_ci_uq ON identity.staff USING btree (lower(email))'),
      ('otp_challenges_invalidation_reason_check',
       $c$CHECK (((invalidation_reason IS NULL) OR (invalidation_reason = ANY (ARRAY['resend'::text, 'expired'::text, 'attempts_exhausted'::text, 'delivery_failed'::text, 'completed'::text, 'operator_revoked'::text]))))$c$),
      ('external_identities_status_check',
       $c$CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text, 'disabled'::text])))$c$))
         expected(what, definition)
    left join (
      select constraint_row.conname::text as what, pg_get_constraintdef(constraint_row.oid) as definition
        from pg_constraint constraint_row
       where constraint_row.conrelid in ('identity.patients'::regclass, 'auth.otp_challenges'::regclass,
                                         'auth.external_identities'::regclass)
         and constraint_row.contype = 'c'
      union all
      select index_class.relname::text, pg_get_indexdef(index_class.oid)
        from pg_class index_class
       where index_class.oid in (to_regclass('auth.accounts_email_ci_uq'),
                                 to_regclass('identity.patients_email_hmac_uq'),
                                 to_regclass('identity.patients_phone_hmac_uq'),
                                 to_regclass('identity.staff_email_ci_uq'))) actual
      on actual.what = expected.what
   where actual.definition is distinct from expected.definition;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0094: a CHECK or index this migration relies on differs from 0001-0093: %s', mismatch);
  end if;
  -- f. Privileges, never through a superuser's bypass (production's
  -- migrator has none). The applying role owns every new table and
  -- function: it must own identity.patients (through membership too) so that
  -- RLS does not hide migrated patients from the commands, reference and
  -- write what they reference and write, create in the two schemas, and run
  -- what they call; it must be the readiness function's owner itself.
  select string_agg(missing.what, '; ') into mismatch
    from (
      select format('%s lacks %s on %s', holder.rolname, wanted.privilege, relation.oid::regclass) as what
        from (values
          ('identity.patients', 'OWNER'), ('auth.accounts', 'SELECT'), ('auth.accounts', 'UPDATE'),
          ('auth.accounts', 'REFERENCES'), ('auth.sessions', 'SELECT'), ('auth.sessions', 'UPDATE'),
          ('auth.otp_challenges', 'SELECT'), ('auth.otp_challenges', 'UPDATE'),
          ('auth.external_identities', 'SELECT'), ('auth.external_identities', 'UPDATE'),
          ('auth.account_roles', 'SELECT'), ('identity.staff', 'SELECT'),
          ('identity.staff_facility_memberships', 'SELECT'), ('audit.events', 'INSERT'),
          ('migration.patient_contact_lookup_rekeys', 'SELECT')) wanted(relation_name, privilege)
        join pg_class relation on relation.oid = wanted.relation_name::regclass
        join pg_roles holder on holder.oid = applier
       where case when wanted.privilege = 'OWNER'
               then not pg_temp.parity_0094_holds(applier, relation.relowner, null::aclitem[], 'r', 'OWNER')
               else not pg_temp.parity_0094_holds(applier, relation.relowner, relation.relacl, 'r', wanted.privilege) end
      union all
      select format('%s lacks CREATE on schema %s', holder.rolname, namespace.nspname)
        from pg_namespace namespace
        join pg_roles holder on holder.oid = applier
       where namespace.nspname in ('identity', 'ehr')
         and not pg_temp.parity_0094_holds(applier, namespace.nspowner, namespace.nspacl, 'n', 'CREATE')
      union all
      select format('%s lacks EXECUTE on %s', holder.rolname, proc.oid::regprocedure)
        from (values
          ('identity.patient_self_session(text,uuid)'), ('platform.current_actor_subject()'),
          ('platform.current_correlation_id()'), ('ehr.patient_self_context(uuid)'),
          ('ehr.imported_record_read_context(uuid)'), ('platform.reject_mutation()')) wanted(proc_name)
        join pg_proc proc on proc.oid = wanted.proc_name::regprocedure
        join pg_roles holder on holder.oid = applier
       where not pg_temp.parity_0094_holds(applier, proc.proowner, proc.proacl, 'f', 'EXECUTE')
      union all
      select format('%s is not the owner of %s (owner %s)', current_user, replaced.what, pg_get_userbyid(replaced.proowner))
        from parity_0094_replaced replaced
       where replaced.proowner <> applier) missing;
  if mismatch is not null then
    raise exception using errcode = '42501', message = format('0094: missing privileges: %s', mismatch);
  end if;
  if (select count(*) from parity_0094_replaced) <> 1 then
    raise exception using errcode = '55000', message = '0094: the replaced function was not recorded';
  end if;
  raise notice '0094: owners checked: %', (
    select string_agg(format('%s=%s', owned.what, owned.owner), ', ' order by owned.what)
      from (select replaced.what, pg_get_userbyid(replaced.proowner) as owner from parity_0094_replaced replaced
            union all
            select 'identity.patients', pg_get_userbyid(relation.relowner) from pg_class relation
             where relation.oid = 'identity.patients'::regclass
            union all
            select 'new tables and functions', current_user::text) owned);
end
$$;

-- The locks the new foreign keys take, up front and bounded.
do $$
declare attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      lock table auth.accounts, identity.patients in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 500 then
        raise exception using errcode = '55P03',
          message = '0094: auth.accounts or identity.patients stayed busy for 5 seconds; run the release again later';
      end if;
      perform pg_sleep(0.01);
    end;
  end loop;
end
$$;

-- 1. The hospital the patient uses now and their HMO (free text, as hid-1.0).
create table identity.patient_profile_details (
  patient_id uuid primary key references identity.patients(id) on delete restrict,
  hospital_currently_using text check (hospital_currently_using is null
    or (hospital_currently_using ~ '^[^[:cntrl:]]{1,120}$' and hospital_currently_using = btrim(hospital_currently_using))),
  hmo_name text check (hmo_name is null
    or (hmo_name ~ '^[^[:cntrl:]]{1,120}$' and hmo_name = btrim(hmo_name))),
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

-- 2. The patient's photo, as Identity encrypted it.
create table identity.patient_profile_photos (
  patient_id uuid primary key references identity.patients(id) on delete restrict,
  ciphertext bytea not null check (octet_length(ciphertext) between 30 and 307229),
  media_type text not null check (media_type in ('image/jpeg', 'image/png')),
  sha256 char(64) not null check (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size integer not null check (byte_size between 1 and 307200),
  width integer not null check (width between 1 and 1024),
  height integer not null check (height between 1 and 1024),
  key_version text not null check (length(key_version) between 1 and 64),
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (octet_length(ciphertext) = byte_size + 29)
);

-- 3. Contact changes: pending email changes (a code to the new address) and
-- completed changes of either channel.
create table identity.patient_contact_changes (
  id uuid primary key,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  account_id uuid not null references auth.accounts(id) on delete restrict,
  channel text not null check (channel in ('email', 'phone')),
  state text not null check (state in ('pending', 'completed', 'invalidated')),
  new_lookup_hmac char(64) not null check (new_lookup_hmac ~ '^[0-9a-f]{64}$'),
  new_ciphertext bytea check (new_ciphertext is null or octet_length(new_ciphertext) between 30 and 2048),
  key_version text not null check (length(key_version) between 1 and 64),
  verifier_hmac char(64) check (verifier_hmac is null or verifier_hmac ~ '^[0-9a-f]{64}$'),
  verifier_key_version text check (verifier_key_version is null or length(verifier_key_version) between 1 and 64),
  expires_at timestamptz,
  max_attempts smallint check (max_attempts is null or max_attempts between 1 and 10),
  failed_attempts smallint not null default 0 check (failed_attempts >= 0),
  delivery_outcome text check (delivery_outcome is null
    or delivery_outcome in ('pending', 'accepted', 'definitive_failure', 'unknown')),
  delivery_provider text check (delivery_provider is null or delivery_provider ~ '^[a-z][a-z0-9_-]{1,63}$'),
  replaced_contact boolean,
  completed_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text check (invalidation_reason is null or invalidation_reason in (
    'superseded', 'expired', 'attempts_exhausted', 'delivery_failed', 'contact_unavailable', 'workforce_account')),
  created_at timestamptz not null default clock_timestamp(),
  row_version bigint not null default 1 check (row_version > 0),
  -- An email change carries its code's verifier, expiry and attempts; a
  -- phone change has none (the current password is its proof).
  check ((channel = 'email') = (verifier_hmac is not null and verifier_key_version is not null
    and expires_at is not null and max_attempts is not null and delivery_outcome is not null)),
  check (failed_attempts <= coalesce(max_attempts, 0)),
  check (channel = 'email' or state <> 'pending'),
  check ((state = 'completed') = (completed_at is not null)),
  check ((state = 'completed') = (replaced_contact is not null)),
  check ((state = 'invalidated') = (invalidated_at is not null)),
  check ((invalidated_at is null) = (invalidation_reason is null)),
  check (state <> 'pending' or new_ciphertext is not null),
  check (state <> 'invalidated' or new_ciphertext is null),
  check (expires_at is null or expires_at > created_at)
);
create unique index patient_contact_changes_pending_uq
  on identity.patient_contact_changes (patient_id, channel) where state = 'pending';
create index patient_contact_changes_patient_idx
  on identity.patient_contact_changes (patient_id, channel, created_at desc);
create index patient_contact_changes_completed_idx
  on identity.patient_contact_changes (patient_id, channel, new_lookup_hmac) where state = 'completed';
create trigger patient_contact_changes_no_delete
  before delete on identity.patient_contact_changes
  for each row execute function platform.reject_mutation();

-- 4. The health information the patient entered.
create table ehr.patient_reported_health_profiles (
  patient_id uuid primary key references identity.patients(id) on delete restrict,
  blood_group text check (blood_group is null or blood_group in ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
  genotype text check (genotype is null or genotype in ('AA', 'AS', 'AC', 'SS', 'SC', 'CC')),
  allergies text check (allergies is null
    or (length(allergies) between 1 and 1000 and allergies !~ '[\u0001-\u0009\u000b-\u001f\u007f-\u009f]')),
  current_medications text check (current_medications is null
    or (length(current_medications) between 1 and 1000
      and current_medications !~ '[\u0001-\u0009\u000b-\u001f\u007f-\u009f]')),
  chronic_conditions text check (chronic_conditions is null
    or (length(chronic_conditions) between 1 and 1000
      and chronic_conditions !~ '[\u0001-\u0009\u000b-\u001f\u007f-\u009f]')),
  medical_notes text check (medical_notes is null
    or (length(medical_notes) between 1 and 1000 and medical_notes !~ '[\u0001-\u0009\u000b-\u001f\u007f-\u009f]')),
  updated_by_account_id uuid not null,
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

comment on table identity.patient_profile_details is
  '0094: the hospital the patient uses now and their HMO, as the patient entered them (free text). Written only by identity.save_my_profile_details.';
comment on table identity.patient_profile_photos is
  '0094: the patient''s photo, encrypted by Identity (AES-256-GCM under identity:patient-photo:<patient>:<sha256>). Read and written only by the patient''s own commands.';
comment on table identity.patient_contact_changes is
  '0094: the patient''s contact changes; contacts encrypted by Identity under identity:patient-contact:<change>:<channel>; only an HMAC of a code. Never deleted.';
comment on table ehr.patient_reported_health_profiles is
  '0094: health information entered by the patient, not clinically verified; shown to clinicians as reported by the patient.';

-- 5. Row-level security.
alter table identity.patient_profile_details enable row level security;
alter table identity.patient_profile_details force row level security;
alter table identity.patient_profile_photos enable row level security;
alter table identity.patient_profile_photos force row level security;
alter table identity.patient_contact_changes enable row level security;
alter table identity.patient_contact_changes force row level security;
alter table ehr.patient_reported_health_profiles enable row level security;
alter table ehr.patient_reported_health_profiles force row level security;
do $$
begin
  execute format('create policy patient_profile_details_owner on identity.patient_profile_details for all '
    || 'using (current_user = %L) with check (current_user = %L)', current_user, current_user);
  execute format('create policy patient_profile_photos_owner on identity.patient_profile_photos for all '
    || 'using (current_user = %L) with check (current_user = %L)', current_user, current_user);
  execute format('create policy patient_contact_changes_owner on identity.patient_contact_changes for all '
    || 'using (current_user = %L) with check (current_user = %L)', current_user, current_user);
  execute format('create policy patient_reported_health_profiles_owner on ehr.patient_reported_health_profiles for all '
    || 'using (current_user = %L) with check (current_user = %L)', current_user, current_user);
end
$$;
create policy patient_reported_health_profiles_read on ehr.patient_reported_health_profiles
  for select using (ehr.imported_record_read_context(patient_id));
revoke all on identity.patient_profile_details, identity.patient_profile_photos, identity.patient_contact_changes,
  ehr.patient_reported_health_profiles from public;

-- 6a. The patient's contacts as their profile shows them.
create function identity.patient_self_contact(requested_subject text, requested_session uuid)
returns table (
  email text, email_verified boolean, phone_ciphertext bytea, phone_lookup_hmac text,
  phone_change_id uuid, phone_change_key_version text, has_photo boolean
)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
begin
  if patient_id_value is null then return; end if;
  return query
    select account.email, account.email_verified_at is not null,
           patient.phone_e164_ciphertext, patient.phone_lookup_hmac::text,
           written.id, written.key_version,
           exists (select 1 from identity.patient_profile_photos photo where photo.patient_id = patient.id)
      from identity.patients patient
      join auth.accounts account on account.id = patient.account_id
      left join lateral (
        select change_row.id, change_row.key_version
          from identity.patient_contact_changes change_row
         where change_row.patient_id = patient.id and change_row.channel = 'phone'
           and change_row.state = 'completed' and change_row.new_lookup_hmac = patient.phone_lookup_hmac
           and change_row.new_ciphertext = patient.phone_e164_ciphertext
         order by change_row.completed_at desc
         limit 1) written on true
     where patient.id = patient_id_value;
end
$$;

-- 6b. What a contact change needs to know about the account.
create function identity.my_contact_change_credentials(requested_subject text, requested_session uuid)
returns table (
  account_id uuid, email text, email_verified boolean, password_hash text, password_algorithm text,
  patient_first_name text, patient_hid_code text
)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
begin
  if patient_id_value is null then return; end if;
  return query
    select account.id, account.email, account.email_verified_at is not null, account.password_hash,
           account.password_algorithm, patient.first_name, patient.hid_code
      from identity.patients patient
      join auth.accounts account on account.id = patient.account_id
     where patient.id = patient_id_value;
end
$$;

-- 6c. Start an email change: a code goes to the new address.
create function identity.start_my_email_change(
  requested_subject text, requested_session uuid, requested_change_id uuid, requested_email text,
  requested_lookup_hmac char(64), requested_ciphertext bytea, requested_key_version text,
  requested_verifier_hmac char(64), requested_verifier_key_version text, requested_ttl_seconds integer,
  requested_max_attempts integer, requested_resend_seconds integer
) returns text
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
  normalized_email text := lower(btrim(requested_email));
  account_row auth.accounts%rowtype;
begin
  if patient_id_value is null or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  if requested_change_id is null
     or normalized_email is null or length(normalized_email) > 254
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or coalesce(requested_lookup_hmac, '') !~ '^[0-9a-f]{64}$'
     or coalesce(requested_verifier_hmac, '') !~ '^[0-9a-f]{64}$'
     or requested_ciphertext is null or octet_length(requested_ciphertext) not between 30 and 2048
     or coalesce(length(requested_key_version), 0) not between 1 and 64
     or coalesce(length(requested_verifier_key_version), 0) not between 1 and 64
     or coalesce(requested_ttl_seconds, 0) not between 60 and 1800
     or coalesce(requested_max_attempts, 0) not between 1 and 10
     or coalesce(requested_resend_seconds, 0) not between 10 and 600 then
    raise exception using errcode = '22023', message = 'PATIENT_CONTACT_CHANGE_INVALID';
  end if;
  -- One contact change of a patient at a time.
  perform pg_advisory_xact_lock(hashtextextended('patient-contact-change:' || patient_id_value::text, 0));
  select account.* into account_row
    from identity.patients patient
    join auth.accounts account on account.id = patient.account_id
   where patient.id = patient_id_value;
  -- An account that is also workforce (0093's test): its email is the staff
  -- sign-in and identity.staff's address too, which a patient's change must
  -- not move apart. Nothing is recorded.
  if exists (select 1 from auth.account_roles role_assignment where role_assignment.account_id = account_row.id)
     or exists (select 1 from identity.staff staff_record where staff_record.account_id = account_row.id)
     or exists (select 1 from identity.staff_facility_memberships membership
                 where membership.account_id = account_row.id) then
    return 'workforce';
  end if;
  if lower(account_row.email) = normalized_email then return 'unchanged'; end if;
  if exists (select 1 from identity.patient_contact_changes change_row
              where change_row.patient_id = patient_id_value and change_row.channel = 'email'
                and change_row.created_at > clock_timestamp() - make_interval(secs => requested_resend_seconds))
     or (select count(*) from identity.patient_contact_changes change_row
          where change_row.patient_id = patient_id_value and change_row.channel = 'email'
            and change_row.created_at > clock_timestamp() - interval '1 hour') >= 5 then
    return 'rate_limited';
  end if;
  update identity.patient_contact_changes
     set state = 'invalidated', invalidated_at = clock_timestamp(), invalidation_reason = 'superseded',
         new_ciphertext = null, row_version = row_version + 1
   where patient_id = patient_id_value and channel = 'email' and state = 'pending';
  -- Another account's email, another patient's contact email (as sign-up
  -- refuses it) or a staff record's email (staff_email_ci_uq; staff
  -- invitations read it): recorded without the address, so that it counts,
  -- and audited as denied (the superseded change with it).
  if exists (select 1 from auth.accounts other
              where lower(other.email) = normalized_email and other.status <> 'deleted'
                and other.id <> account_row.id)
     or exists (select 1 from identity.patients other
                 where other.email_lookup_hmac = requested_lookup_hmac and other.id <> patient_id_value)
     or exists (select 1 from identity.staff staff_record where lower(staff_record.email) = normalized_email) then
    insert into identity.patient_contact_changes (id, patient_id, account_id, channel, state, new_lookup_hmac,
      new_ciphertext, key_version, verifier_hmac, verifier_key_version, expires_at, max_attempts, delivery_outcome,
      invalidated_at, invalidation_reason)
    values (requested_change_id, patient_id_value, account_row.id, 'email', 'invalidated', requested_lookup_hmac,
      null, requested_key_version, requested_verifier_hmac, requested_verifier_key_version,
      clock_timestamp() + make_interval(secs => requested_ttl_seconds), requested_max_attempts, 'pending',
      clock_timestamp(), 'contact_unavailable');
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
      action, outcome, resource_type, resource_id, purpose_of_use, provenance, source_system, details)
    values (platform.current_correlation_id(), 'patient', requested_subject, account_row.id, patient_id_value,
      'identity.patient.contact-change.start', 'denied', 'patient-contact-change', requested_change_id::text,
      'patient-self', 'application', 'identity-api', jsonb_build_object('channel', 'email', 'result', 'unavailable'));
    return 'unavailable';
  end if;
  insert into identity.patient_contact_changes (id, patient_id, account_id, channel, state, new_lookup_hmac,
    new_ciphertext, key_version, verifier_hmac, verifier_key_version, expires_at, max_attempts, delivery_outcome)
  values (requested_change_id, patient_id_value, account_row.id, 'email', 'pending', requested_lookup_hmac,
    requested_ciphertext, requested_key_version, requested_verifier_hmac, requested_verifier_key_version,
    clock_timestamp() + make_interval(secs => requested_ttl_seconds), requested_max_attempts, 'pending');
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use, provenance, source_system, details)
  values (platform.current_correlation_id(), 'patient', requested_subject, account_row.id, patient_id_value,
    'identity.patient.contact-change.start', 'success', 'patient-contact-change', requested_change_id::text,
    'patient-self', 'application', 'identity-api', jsonb_build_object('channel', 'email'));
  return 'started';
end
$$;

-- 6d. The pending email change's address, encrypted (Identity decrypts it to
-- complete the change).
create function identity.read_my_pending_email_change(requested_subject text, requested_session uuid,
  requested_change_id uuid)
returns table (new_ciphertext bytea, key_version text)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
begin
  if patient_id_value is null then return; end if;
  return query
    select change_row.new_ciphertext, change_row.key_version
      from identity.patient_contact_changes change_row
     where change_row.id = requested_change_id and change_row.patient_id = patient_id_value
       and change_row.channel = 'email' and change_row.state = 'pending';
end
$$;

-- 6e. The code's delivery outcome.
create function identity.record_my_contact_change_delivery(requested_subject text, requested_session uuid,
  requested_change_id uuid, requested_outcome text, requested_provider text)
returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
  account_id_value uuid;
begin
  if patient_id_value is null or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  if requested_outcome is null or requested_outcome not in ('accepted', 'definitive_failure', 'unknown')
     or (requested_provider is not null and requested_provider !~ '^[a-z][a-z0-9_-]{1,63}$') then
    raise exception using errcode = '22023', message = 'Invalid delivery outcome';
  end if;
  update identity.patient_contact_changes
     set delivery_outcome = requested_outcome, delivery_provider = requested_provider,
         state = case when requested_outcome = 'definitive_failure' then 'invalidated' else state end,
         invalidated_at = case when requested_outcome = 'definitive_failure' then clock_timestamp() end,
         invalidation_reason = case when requested_outcome = 'definitive_failure' then 'delivery_failed' end,
         new_ciphertext = case when requested_outcome = 'definitive_failure' then null else new_ciphertext end,
         row_version = row_version + 1
   where id = requested_change_id and patient_id = patient_id_value and channel = 'email' and state = 'pending'
  returning account_id into account_id_value;
  -- The code could not be delivered, so the change ended: audited.
  if account_id_value is not null and requested_outcome = 'definitive_failure' then
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
      action, outcome, resource_type, resource_id, purpose_of_use, provenance, source_system, details)
    values (platform.current_correlation_id(), 'patient', requested_subject, account_id_value, patient_id_value,
      'identity.patient.contact-change.delivery', 'failure', 'patient-contact-change', requested_change_id::text,
      'patient-self', 'application', 'identity-api', jsonb_build_object('channel', 'email', 'result', 'delivery_failed'));
  end if;
end
$$;

-- 6f. Complete an email change with its code.
create function identity.complete_my_email_change(requested_subject text, requested_session uuid,
  requested_change_id uuid, requested_verifier_hmac char(64), requested_email text)
returns table (outcome text, email text, previous_email text, patient_first_name text, patient_hid_code text)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
  normalized_email text := lower(btrim(requested_email));
  change_row identity.patient_contact_changes%rowtype;
  account_row auth.accounts%rowtype;
  patient_row identity.patients%rowtype;
  result text;
  caller_family uuid;
  google_links_revoked integer := 0;
  recovery_codes_invalidated integer := 0;
  sessions_revoked integer := 0;
begin
  if patient_id_value is null or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('patient-contact-change:' || patient_id_value::text, 0));
  select change_found.* into change_row
    from identity.patient_contact_changes change_found
   where change_found.id = requested_change_id and change_found.patient_id = patient_id_value
     and change_found.channel = 'email'
   for update;
  if not found or change_row.state <> 'pending' then
    result := 'invalid';
  elsif change_row.expires_at <= clock_timestamp() then
    result := 'expired';
    update identity.patient_contact_changes
       set state = 'invalidated', invalidated_at = clock_timestamp(), invalidation_reason = 'expired',
           new_ciphertext = null, row_version = row_version + 1
     where id = change_row.id;
  elsif change_row.failed_attempts >= change_row.max_attempts then
    result := 'invalid';
    update identity.patient_contact_changes
       set state = 'invalidated', invalidated_at = clock_timestamp(), invalidation_reason = 'attempts_exhausted',
           new_ciphertext = null, row_version = row_version + 1
     where id = change_row.id;
  elsif requested_verifier_hmac is distinct from change_row.verifier_hmac then
    result := 'invalid';
    update identity.patient_contact_changes
       set failed_attempts = failed_attempts + 1,
           state = case when failed_attempts + 1 >= max_attempts then 'invalidated' else state end,
           invalidated_at = case when failed_attempts + 1 >= max_attempts then clock_timestamp() end,
           invalidation_reason = case when failed_attempts + 1 >= max_attempts then 'attempts_exhausted' end,
           new_ciphertext = case when failed_attempts + 1 >= max_attempts then null else new_ciphertext end,
           row_version = row_version + 1
     where id = change_row.id;
  elsif normalized_email is null or length(normalized_email) > 254
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception using errcode = '22023', message = 'PATIENT_CONTACT_CHANGE_INVALID';
  else
    -- Sign-up activation's lock for this address.
    perform pg_advisory_xact_lock(hashtextextended('patient-contact:email:' || change_row.new_lookup_hmac, 0));
    -- 0059's lock order: the account, then the patient.
    select account.* into account_row from auth.accounts account
     where account.id = change_row.account_id for update;
    select patient.* into patient_row from identity.patients patient
     where patient.id = patient_id_value for update;
    if patient_row.account_id is distinct from account_row.id
       or exists (select 1 from auth.accounts other
                   where lower(other.email) = normalized_email and other.status <> 'deleted'
                     and other.id <> account_row.id)
       or exists (select 1 from identity.patients other
                   where other.email_lookup_hmac = change_row.new_lookup_hmac and other.id <> patient_id_value)
       or exists (select 1 from identity.staff staff_record where lower(staff_record.email) = normalized_email) then
      result := 'unavailable';
    elsif exists (select 1 from auth.account_roles role_assignment where role_assignment.account_id = account_row.id)
       or exists (select 1 from identity.staff staff_record where staff_record.account_id = account_row.id)
       or exists (select 1 from identity.staff_facility_memberships membership
                   where membership.account_id = account_row.id) then
      -- The account became workforce after the start (0093's test).
      result := 'workforce';
    else
      begin
        update auth.accounts
           set email = normalized_email, email_verified_at = clock_timestamp(),
               updated_at = clock_timestamp(), row_version = row_version + 1
         where id = account_row.id;
        update identity.patients
           set email_ciphertext = change_row.new_ciphertext, email_lookup_hmac = change_row.new_lookup_hmac,
               contact_key_version = coalesce(contact_key_version, change_row.key_version),
               updated_at = clock_timestamp(), row_version = row_version + 1
         where id = patient_id_value;
        result := 'completed';
      exception when unique_violation then
        -- accounts_email_ci_uq or patients_email_hmac_uq: a concurrent claim.
        result := 'unavailable';
      end;
    end if;
    if result = 'completed' then
      update identity.patient_contact_changes
         set new_ciphertext = null, row_version = row_version + 1
       where patient_id = patient_id_value and channel = 'email' and state = 'completed'
         and new_ciphertext is not null;
      update identity.patient_contact_changes
         set state = 'completed', completed_at = clock_timestamp(),
             replaced_contact = patient_row.email_ciphertext is not null, row_version = row_version + 1
       where id = change_row.id;
      -- Whoever holds the previous mailbox keeps nothing it gave them. A
      -- Google account 0093 linked because Google verified the previous
      -- address no longer signs in (auth.resolve_google_identity reads active
      -- links only); a link the patient made, or signed up with, stays.
      with revoked as (
        update auth.external_identities identity_row
           set status = 'revoked', revoked_at = clock_timestamp()
         where identity_row.account_id = account_row.id
           and identity_row.issuer = 'https://accounts.google.com'
           and identity_row.status = 'active'
           and identity_row.source_system = 'hid-google-verified-email-link'
        returning 1)
      select count(*) into google_links_revoked from revoked;
      -- A recovery code sent to the previous address no longer completes (as
      -- 0029's completion invalidates the account's other recovery codes).
      with invalidated as (
        update auth.otp_challenges challenge
           set invalidated_at = clock_timestamp(), invalidation_reason = 'completed',
               row_version = challenge.row_version + 1
         where challenge.account_id = account_row.id
           and challenge.purpose in ('PASSWORD_RESET', 'LEGACY_ACCOUNT_RECOVERY', 'LEGACY_SESSION_FALLBACK')
           and challenge.consumed_at is null and challenge.invalidated_at is null
        returning 1)
      select count(*) into recovery_codes_invalidated from invalidated;
      -- Every other session of the account ends; the caller's session family
      -- goes on (token_version is unchanged, which would end it too).
      select session_row.family_id into caller_family from auth.sessions session_row
       where session_row.id = requested_session;
      with ended as (
        update auth.sessions session_row
           set revoked_at = clock_timestamp(), revocation_reason = 'contact_changed',
               row_version = session_row.row_version + 1
         where session_row.account_id = account_row.id and session_row.revoked_at is null
           and session_row.family_id is distinct from caller_family
        returning 1)
      select count(*) into sessions_revoked from ended;
      if google_links_revoked > 0 then
        insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
          action, outcome, resource_type, resource_id, purpose_of_use, provenance, source_system, details)
        values (platform.current_correlation_id(), 'patient', requested_subject, account_row.id, patient_id_value,
          'auth.google.auto-link.revoke', 'success', 'account', account_row.id::text, 'patient-self', 'application',
          'identity-api', jsonb_build_object('reason', 'email_changed', 'revoked', google_links_revoked));
      end if;
    else
      update identity.patient_contact_changes
         set state = 'invalidated', invalidated_at = clock_timestamp(),
             invalidation_reason = case when result = 'workforce' then 'workforce_account'
               else 'contact_unavailable' end,
             new_ciphertext = null, row_version = row_version + 1
       where id = change_row.id;
    end if;
  end if;
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use, provenance, source_system, details)
  select platform.current_correlation_id(), 'patient', requested_subject, patient.account_id, patient_id_value,
    case when result = 'completed' then 'identity.patient.contact-change.complete'
      else 'identity.patient.contact-change.verify' end,
    case when result = 'completed' then 'success' else 'denied' end,
    'patient-contact-change', requested_change_id::text, 'patient-self', 'application', 'identity-api',
    jsonb_build_object('channel', 'email', 'result', result)
      || case when result = 'completed' then jsonb_build_object('otherSessionsRevoked', sessions_revoked,
           'recoveryCodesInvalidated', recovery_codes_invalidated, 'googleLinksRevoked', google_links_revoked)
         else '{}'::jsonb end
    from identity.patients patient where patient.id = patient_id_value;
  return query select result,
    case when result = 'completed' then normalized_email end,
    case when result = 'completed' then account_row.email end,
    case when result = 'completed' then patient_row.first_name end,
    case when result = 'completed' then patient_row.hid_code end;
end
$$;

-- 6g. Change the phone, confirmed by the current password (Identity).
create function identity.change_my_phone(requested_subject text, requested_session uuid,
  requested_change_id uuid, requested_lookup_hmac char(64), requested_other_lookup_hmacs char(64)[],
  requested_ciphertext bytea, requested_key_version text, requested_current_unreadable boolean)
returns table (outcome text, notice_email text, patient_first_name text, patient_hid_code text)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
  every_form char(64)[];
  account_row auth.accounts%rowtype;
  patient_row identity.patients%rowtype;
  result text;
begin
  if patient_id_value is null or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  if requested_change_id is null
     or coalesce(requested_lookup_hmac, '') !~ '^[0-9a-f]{64}$'
     or coalesce(cardinality(requested_other_lookup_hmacs), 0) > 2
     or exists (select 1 from unnest(coalesce(requested_other_lookup_hmacs, '{}'::char(64)[])) other_form
                 where coalesce(other_form, '') !~ '^[0-9a-f]{64}$')
     or requested_ciphertext is null or octet_length(requested_ciphertext) not between 30 and 2048
     or coalesce(length(requested_key_version), 0) not between 1 and 64
     or requested_current_unreadable is null then
    raise exception using errcode = '22023', message = 'PATIENT_CONTACT_CHANGE_INVALID';
  end if;
  every_form := array[requested_lookup_hmac] || coalesce(requested_other_lookup_hmacs, '{}'::char(64)[]);
  perform pg_advisory_xact_lock(hashtextextended('patient-contact-change:' || patient_id_value::text, 0));
  -- Sign-up activation's lock for this number.
  perform pg_advisory_xact_lock(hashtextextended('patient-contact:phone:' || requested_lookup_hmac, 0));
  -- 0059's lock order: the account, then the patient.
  select account.* into account_row
    from auth.accounts account
    join identity.patients patient on patient.account_id = account.id
   where patient.id = patient_id_value
   for update of account;
  select patient.* into patient_row from identity.patients patient where patient.id = patient_id_value for update;
  -- The current number is unchanged, unless Identity cannot read the stored
  -- one (hid-1.0's, under the migration's key: the profile shows none): the
  -- same number is then written again, as a change, so that it shows.
  if patient_row.phone_lookup_hmac = any (every_form) and not requested_current_unreadable then
    result := 'unchanged';
  elsif (select count(*) from identity.patient_contact_changes change_row
          where change_row.patient_id = patient_id_value and change_row.channel = 'phone'
            and change_row.created_at > clock_timestamp() - interval '1 hour') >= 5 then
    result := 'rate_limited';
  elsif exists (select 1 from identity.patients other
                 where other.phone_lookup_hmac = any (every_form) and other.id <> patient_id_value) then
    result := 'unavailable';
  else
    begin
      update identity.patients
         set phone_e164_ciphertext = requested_ciphertext, phone_lookup_hmac = requested_lookup_hmac,
             contact_key_version = coalesce(contact_key_version, requested_key_version),
             updated_at = clock_timestamp(), row_version = row_version + 1
       where id = patient_id_value;
      result := 'changed';
    exception when unique_violation then
      -- patients_phone_hmac_uq: a concurrent claim.
      result := 'unavailable';
    end;
  end if;
  if result = 'changed' then
    update identity.patient_contact_changes
       set new_ciphertext = null, row_version = row_version + 1
     where patient_id = patient_id_value and channel = 'phone' and state = 'completed' and new_ciphertext is not null;
    insert into identity.patient_contact_changes (id, patient_id, account_id, channel, state, new_lookup_hmac,
      new_ciphertext, key_version, replaced_contact, completed_at)
    values (requested_change_id, patient_id_value, account_row.id, 'phone', 'completed', requested_lookup_hmac,
      requested_ciphertext, requested_key_version, patient_row.phone_e164_ciphertext is not null, clock_timestamp());
  elsif result = 'unavailable' then
    insert into identity.patient_contact_changes (id, patient_id, account_id, channel, state, new_lookup_hmac,
      new_ciphertext, key_version, invalidated_at, invalidation_reason)
    values (requested_change_id, patient_id_value, account_row.id, 'phone', 'invalidated', requested_lookup_hmac,
      null, requested_key_version, clock_timestamp(), 'contact_unavailable');
  end if;
  if result in ('changed', 'unavailable') then
    insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
      action, outcome, resource_type, resource_id, purpose_of_use, provenance, source_system, details)
    values (platform.current_correlation_id(), 'patient', requested_subject, account_row.id, patient_id_value,
      'identity.patient.contact-change.complete', case when result = 'changed' then 'success' else 'denied' end,
      'patient-contact-change', requested_change_id::text, 'patient-self', 'application', 'identity-api',
      jsonb_build_object('channel', 'phone', 'result', result));
  end if;
  return query select result,
    case when result = 'changed' and account_row.email_verified_at is not null then account_row.email end,
    case when result = 'changed' then patient_row.first_name end,
    case when result = 'changed' then patient_row.hid_code end;
end
$$;

-- 6h. The hospital and the HMO.
create function identity.read_my_profile_details(requested_subject text, requested_session uuid)
returns table (hospital_currently_using text, hmo_name text, row_version bigint, saved boolean)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
begin
  if patient_id_value is null then return; end if;
  return query
    select details.hospital_currently_using, details.hmo_name, details.row_version, true
      from identity.patient_profile_details details
     where details.patient_id = patient_id_value
    union all
    select null::text, null::text, 0::bigint, false
     where not exists (select 1 from identity.patient_profile_details details
                        where details.patient_id = patient_id_value);
end
$$;

create function identity.save_my_profile_details(requested_subject text, requested_session uuid,
  requested_expected_version bigint, requested_hospital text, requested_hmo text)
returns table (outcome text, hospital_currently_using text, hmo_name text, row_version bigint)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
  account_id_value uuid;
  existing identity.patient_profile_details%rowtype;
begin
  if patient_id_value is null or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  if requested_expected_version is null or requested_expected_version < 0
     or (requested_hospital is not null and (requested_hospital !~ '^[^[:cntrl:]]{1,120}$'
       or requested_hospital <> btrim(requested_hospital)))
     or (requested_hmo is not null and (requested_hmo !~ '^[^[:cntrl:]]{1,120}$'
       or requested_hmo <> btrim(requested_hmo))) then
    raise exception using errcode = '22023', message = 'PATIENT_PROFILE_DETAILS_INVALID';
  end if;
  select patient.account_id into account_id_value from identity.patients patient where patient.id = patient_id_value;
  perform pg_advisory_xact_lock(hashtextextended('patient-profile-details:' || patient_id_value::text, 0));
  select details.* into existing from identity.patient_profile_details details
   where details.patient_id = patient_id_value for update;
  if not found then
    if requested_expected_version <> 0 then
      return query select 'conflict'::text, null::text, null::text, 0::bigint;
      return;
    end if;
    insert into identity.patient_profile_details (patient_id, hospital_currently_using, hmo_name)
      values (patient_id_value, requested_hospital, requested_hmo);
  elsif existing.row_version <> requested_expected_version then
    return query select 'conflict'::text, existing.hospital_currently_using, existing.hmo_name, existing.row_version;
    return;
  else
    update identity.patient_profile_details
       set hospital_currently_using = requested_hospital, hmo_name = requested_hmo,
           updated_at = clock_timestamp(), row_version = existing.row_version + 1
     where patient_id = patient_id_value;
  end if;
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use, provenance, source_system, details)
  values (platform.current_correlation_id(), 'patient', requested_subject, account_id_value, patient_id_value,
    'identity.patient.profile-details.update', 'success', 'patient-profile-details', patient_id_value::text,
    'patient-self', 'application', 'identity-api',
    jsonb_build_object('hospitalSet', requested_hospital is not null, 'hmoSet', requested_hmo is not null));
  return query select 'saved'::text, details.hospital_currently_using, details.hmo_name, details.row_version
    from identity.patient_profile_details details where details.patient_id = patient_id_value;
end
$$;

-- 6i. The photo.
create function identity.set_my_profile_photo(requested_subject text, requested_session uuid,
  requested_ciphertext bytea, requested_media_type text, requested_sha256 char(64), requested_byte_size integer,
  requested_width integer, requested_height integer, requested_key_version text)
returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
  account_id_value uuid;
begin
  if patient_id_value is null or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  if requested_ciphertext is null or requested_media_type is null or requested_sha256 is null
     or requested_byte_size is null or requested_width is null or requested_height is null
     or requested_key_version is null then
    raise exception using errcode = '22023', message = 'PATIENT_PHOTO_INVALID';
  end if;
  select patient.account_id into account_id_value from identity.patients patient where patient.id = patient_id_value;
  insert into identity.patient_profile_photos (patient_id, ciphertext, media_type, sha256, byte_size, width, height,
    key_version)
  values (patient_id_value, requested_ciphertext, requested_media_type, requested_sha256, requested_byte_size,
    requested_width, requested_height, requested_key_version)
  on conflict (patient_id) do update
    set ciphertext = excluded.ciphertext, media_type = excluded.media_type, sha256 = excluded.sha256,
        byte_size = excluded.byte_size, width = excluded.width, height = excluded.height,
        key_version = excluded.key_version, updated_at = clock_timestamp(),
        row_version = identity.patient_profile_photos.row_version + 1;
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use, provenance, source_system, details)
  values (platform.current_correlation_id(), 'patient', requested_subject, account_id_value, patient_id_value,
    'identity.patient.photo.set', 'success', 'patient-photo', patient_id_value::text,
    'patient-self', 'application', 'identity-api',
    jsonb_build_object('mediaType', requested_media_type, 'byteSize', requested_byte_size,
      'width', requested_width, 'height', requested_height));
  return true;
end
$$;

create function identity.read_my_profile_photo(requested_subject text, requested_session uuid)
returns table (ciphertext bytea, media_type text, sha256 text, byte_size integer, key_version text,
  updated_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
begin
  if patient_id_value is null then return; end if;
  return query
    select photo.ciphertext, photo.media_type, photo.sha256::text, photo.byte_size, photo.key_version,
           photo.updated_at
      from identity.patient_profile_photos photo
     where photo.patient_id = patient_id_value;
end
$$;

create function identity.remove_my_profile_photo(requested_subject text, requested_session uuid)
returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
  account_id_value uuid;
begin
  if patient_id_value is null or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  delete from identity.patient_profile_photos photo where photo.patient_id = patient_id_value;
  if not found then return false; end if;
  select patient.account_id into account_id_value from identity.patients patient where patient.id = patient_id_value;
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use, provenance, source_system, details)
  values (platform.current_correlation_id(), 'patient', requested_subject, account_id_value, patient_id_value,
    'identity.patient.photo.remove', 'success', 'patient-photo', patient_id_value::text,
    'patient-self', 'application', 'identity-api', '{}'::jsonb);
  return true;
end
$$;

-- 6j. The patient's own health information (EHR, fresh patient-self context).
create function ehr.save_my_reported_health_profile(requested_expected_version bigint, requested_blood_group text,
  requested_genotype text, requested_allergies text, requested_current_medications text,
  requested_chronic_conditions text, requested_medical_notes text)
returns table (outcome text, blood_group text, genotype text, allergies text, current_medications text,
  chronic_conditions text, medical_notes text, row_version bigint, updated_at timestamptz)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  uuid_shape constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  claimed_patient text := nullif(current_setting('app.patient_id', true), '');
  claimed_account text := nullif(current_setting('app.account_id', true), '');
  claimed_subject text := nullif(current_setting('app.actor_subject', true), '');
  patient_id_value uuid;
  existing ehr.patient_reported_health_profiles%rowtype;
  invalid_text constant text := '[\u0001-\u0009\u000b-\u001f\u007f-\u009f]';
begin
  if claimed_patient is null or claimed_patient !~ uuid_shape or claimed_account is null
     or claimed_account !~ uuid_shape or platform.current_correlation_id() is null
     or not ehr.patient_self_context(claimed_patient::uuid) then
    raise exception using errcode = '42501', message = 'Patient self context is required';
  end if;
  patient_id_value := claimed_patient::uuid;
  if requested_expected_version is null or requested_expected_version < 0
     or (requested_blood_group is not null
       and requested_blood_group not in ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'))
     or (requested_genotype is not null and requested_genotype not in ('AA', 'AS', 'AC', 'SS', 'SC', 'CC'))
     or exists (select 1 from unnest(array[requested_allergies, requested_current_medications,
                  requested_chronic_conditions, requested_medical_notes]) field(value)
                 where field.value is not null
                   and (length(field.value) not between 1 and 1000 or field.value ~ invalid_text)) then
    raise exception using errcode = '22023', message = 'PATIENT_HEALTH_PROFILE_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('patient-reported-health-profile:' || patient_id_value::text, 0));
  select profile.* into existing from ehr.patient_reported_health_profiles profile
   where profile.patient_id = patient_id_value for update;
  if not found then
    if requested_expected_version <> 0 then
      return query select 'conflict'::text, null::text, null::text, null::text, null::text, null::text, null::text,
        0::bigint, null::timestamptz;
      return;
    end if;
    insert into ehr.patient_reported_health_profiles (patient_id, blood_group, genotype, allergies,
      current_medications, chronic_conditions, medical_notes, updated_by_account_id)
    values (patient_id_value, requested_blood_group, requested_genotype, requested_allergies,
      requested_current_medications, requested_chronic_conditions, requested_medical_notes, claimed_account::uuid);
  elsif existing.row_version <> requested_expected_version then
    return query select 'conflict'::text, existing.blood_group, existing.genotype, existing.allergies,
      existing.current_medications, existing.chronic_conditions, existing.medical_notes, existing.row_version,
      existing.updated_at;
    return;
  else
    update ehr.patient_reported_health_profiles
       set blood_group = requested_blood_group, genotype = requested_genotype, allergies = requested_allergies,
           current_medications = requested_current_medications, chronic_conditions = requested_chronic_conditions,
           medical_notes = requested_medical_notes, updated_by_account_id = claimed_account::uuid,
           updated_at = clock_timestamp(), row_version = existing.row_version + 1
     where patient_id = patient_id_value;
  end if;
  insert into audit.events (correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use, provenance, source_system, details)
  values (platform.current_correlation_id(), 'patient', claimed_subject, claimed_account::uuid, patient_id_value,
    'ehr.patient.self.health-profile.update', 'success', 'patient-reported-health-profile', patient_id_value::text,
    'patient-self', 'application', 'ehr-api',
    jsonb_build_object('fields', to_jsonb(array_remove(array[
      case when requested_blood_group is not null then 'bloodGroup' end,
      case when requested_genotype is not null then 'genotype' end,
      case when requested_allergies is not null then 'allergies' end,
      case when requested_current_medications is not null then 'currentMedications' end,
      case when requested_chronic_conditions is not null then 'chronicConditions' end,
      case when requested_medical_notes is not null then 'medicalNotes' end], null))));
  return query select 'saved'::text, profile.blood_group, profile.genotype, profile.allergies,
    profile.current_medications, profile.chronic_conditions, profile.medical_notes, profile.row_version,
    profile.updated_at
    from ehr.patient_reported_health_profiles profile where profile.patient_id = patient_id_value;
end
$$;

-- 7. Contact lookup readiness (0057), replaced: 0057's body plus the
-- contacts completed contact changes wrote. CREATE OR REPLACE keeps its
-- owner and ACL.
create or replace function identity.patient_contact_lookup_ready()
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, identity, migration, platform, pg_temp as $$
declare
  legacy_count bigint;
  legacy_contacts bigint;
  added_at timestamptz[];
begin
  if nullif(platform.current_actor_subject(), '') is null then
    raise exception using errcode = '42501', message = 'PATIENT_CONTACT_LOOKUP_DENIED';
  end if;
  select count(*) into legacy_count from identity.patients
    where source_system = 'legacy_identity';
  if legacy_count = 0
    and not exists (select 1 from identity.public_patient_enrollments
      where contact_hmac is not null and contact_lookup_hmac is null) then
    return true;
  end if;
  select count(*) into legacy_contacts from identity.patients patient
    cross join lateral (values (patient.phone_e164_ciphertext),
      (patient.email_ciphertext)) as contact(ciphertext)
    where patient.source_system = 'legacy_identity'
      and contact.ciphertext is not null;
  -- 0094: a contact a migrated patient added through a completed contact
  -- change after the marker (none before it on that channel; nothing removes
  -- one) counts with the marker's contacts.
  select coalesce(array_agg(change_row.completed_at), '{}') into added_at
    from identity.patient_contact_changes change_row
    join identity.patients changed on changed.id = change_row.patient_id
   where changed.source_system = 'legacy_identity'
     and change_row.state = 'completed' and not change_row.replaced_contact;
  if not exists (select 1 from migration.patient_contact_lookup_rekeys marker
    where marker.legacy_patient_count = legacy_count
      and marker.legacy_contact_count + (select count(*) from unnest(added_at) added(completed_at)
        where added.completed_at > marker.created_at) = legacy_contacts
      and marker.enrollment_count >= (
        select count(*) from identity.public_patient_enrollments enrollment
        where enrollment.contact_hmac is not null
          and enrollment.created_at <= marker.created_at)) then
    return false;
  end if;
  if exists (select 1 from identity.patients patient
    where patient.source_system = 'legacy_identity'
      and ((patient.phone_e164_ciphertext is not null and patient.phone_lookup_hmac is null)
        or (patient.email_ciphertext is not null and patient.email_lookup_hmac is null))) then
    return false;
  end if;
  -- 0094: an active enrollment's patient whose contact on that channel is
  -- no longer the enrollment's is ready when a completed contact change
  -- wrote it (a second anti-join, read only for those enrollments).
  if exists (select 1 from identity.public_patient_enrollments enrollment
    where enrollment.contact_hmac is not null
      and (enrollment.contact_lookup_hmac is null
        or (enrollment.state = 'active' and not exists (
          select 1 from identity.patients patient
          where patient.id = enrollment.patient_id
            and ((enrollment.contact_channel = 'phone'
              and patient.phone_lookup_hmac = enrollment.contact_lookup_hmac)
              or (enrollment.contact_channel = 'email'
                and patient.email_lookup_hmac = enrollment.contact_lookup_hmac)))
          and not exists (
            select 1 from identity.patients patient
            join identity.patient_contact_changes change_row
              on change_row.patient_id = patient.id and change_row.channel = enrollment.contact_channel
             and change_row.state = 'completed'
             and change_row.new_lookup_hmac = case enrollment.contact_channel
               when 'phone' then patient.phone_lookup_hmac else patient.email_lookup_hmac end
            where patient.id = enrollment.patient_id)))) then
    return false;
  end if;
  return true;
end;
$$;

-- 8. Post-checks.
do $$
declare mismatch text;
begin
  select string_agg(replaced.what, ', ') into mismatch
    from parity_0094_replaced replaced
    join pg_proc proc on proc.oid = replaced.oid
   where (proc.proowner, proc.proacl, proc.prolang, proc.provolatile, proc.prosecdef, proc.proconfig,
          proc.prorettype, proc.proretset, proc.proargnames, proc.proallargtypes)
     is distinct from (replaced.proowner, replaced.proacl, replaced.prolang, replaced.provolatile,
          replaced.prosecdef, replaced.proconfig, replaced.prorettype, replaced.proretset,
          replaced.proargnames, replaced.proallargtypes);
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0094: the replaced function changed more than its body: %s', mismatch);
  end if;
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none')), '; ') into mismatch
    from (values
      ('identity.patient_contact_lookup_ready()', 'e0370d523deb8fcfa40a33a41dfa9227'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0094: the replaced body is not the one this file gives: %s', mismatch);
  end if;
  if exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
              where (namespace.nspname, proc.proname) in (
                ('identity', 'patient_self_contact'), ('identity', 'my_contact_change_credentials'),
                ('identity', 'start_my_email_change'), ('identity', 'read_my_pending_email_change'),
                ('identity', 'record_my_contact_change_delivery'), ('identity', 'complete_my_email_change'),
                ('identity', 'change_my_phone'), ('identity', 'read_my_profile_details'),
                ('identity', 'save_my_profile_details'), ('identity', 'set_my_profile_photo'),
                ('identity', 'read_my_profile_photo'), ('identity', 'remove_my_profile_photo'),
                ('ehr', 'save_my_reported_health_profile'))
                and (proc.proowner <> (select oid from pg_roles where rolname = current_user)
                  or not proc.prosecdef or proc.proconfig is distinct from '{"search_path=pg_catalog, pg_temp"}'::text[]))
     or exists (select 1 from pg_class relation
                 where relation.oid in ('identity.patient_profile_details'::regclass,
                   'identity.patient_profile_photos'::regclass, 'identity.patient_contact_changes'::regclass,
                   'ehr.patient_reported_health_profiles'::regclass)
                   and (relation.relowner <> (select oid from pg_roles where rolname = current_user)
                     or not relation.relrowsecurity or not relation.relforcerowsecurity)) then
    raise exception using errcode = '55000', message = '0094: a new table or function is not as this file makes it';
  end if;
end
$$;
drop function pg_temp.parity_0094_holds(oid, oid, aclitem[], "char", text);
drop table pg_temp.parity_0094_replaced;

-- 9. Grants (here and in runtime-grants.sql).
revoke all on function identity.patient_self_contact(text,uuid),
  identity.my_contact_change_credentials(text,uuid),
  identity.start_my_email_change(text,uuid,uuid,text,char,bytea,text,char,text,integer,integer,integer),
  identity.read_my_pending_email_change(text,uuid,uuid),
  identity.record_my_contact_change_delivery(text,uuid,uuid,text,text),
  identity.complete_my_email_change(text,uuid,uuid,char,text),
  identity.change_my_phone(text,uuid,uuid,char,char[],bytea,text,boolean),
  identity.read_my_profile_details(text,uuid),
  identity.save_my_profile_details(text,uuid,bigint,text,text),
  identity.set_my_profile_photo(text,uuid,bytea,text,char,integer,integer,integer,text),
  identity.read_my_profile_photo(text,uuid),
  identity.remove_my_profile_photo(text,uuid),
  ehr.save_my_reported_health_profile(bigint,text,text,text,text,text,text) from public;

do $$
declare grantee text;
begin
  foreach grantee in array array['hid_identity_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = grantee) then
      execute format('grant execute on function identity.patient_self_contact(text,uuid), '
        || 'identity.my_contact_change_credentials(text,uuid), '
        || 'identity.start_my_email_change(text,uuid,uuid,text,char,bytea,text,char,text,integer,integer,integer), '
        || 'identity.read_my_pending_email_change(text,uuid,uuid), '
        || 'identity.record_my_contact_change_delivery(text,uuid,uuid,text,text), '
        || 'identity.complete_my_email_change(text,uuid,uuid,char,text), '
        || 'identity.change_my_phone(text,uuid,uuid,char,char[],bytea,text,boolean), '
        || 'identity.read_my_profile_details(text,uuid), '
        || 'identity.save_my_profile_details(text,uuid,bigint,text,text), '
        || 'identity.set_my_profile_photo(text,uuid,bytea,text,char,integer,integer,integer,text), '
        || 'identity.read_my_profile_photo(text,uuid), '
        || 'identity.remove_my_profile_photo(text,uuid) to %I', grantee);
    end if;
  end loop;
  foreach grantee in array array['hid_ehr_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = grantee) then
      execute format('grant select on ehr.patient_reported_health_profiles to %I', grantee);
      execute format('grant execute on function '
        || 'ehr.save_my_reported_health_profile(bigint,text,text,text,text,text,text) to %I', grantee);
    end if;
  end loop;
end
$$;

comment on function identity.patient_self_contact(text,uuid) is
  '0094: the live patient session''s account email (and whether it is verified), phone ciphertext and lookup, the contact change that wrote that phone, and whether a photo exists.';
comment on function identity.start_my_email_change(text,uuid,uuid,text,char,bytea,text,char,text,integer,integer,integer) is
  '0094: starts the live patient session''s email change (a code to the new address): started, workforce, unchanged, rate_limited or unavailable.';
comment on function identity.complete_my_email_change(text,uuid,uuid,char,text) is
  '0094: completes the live patient session''s email change with its code; sets the account email and the patient''s contact email, unlinks the Google accounts linked by the previous address, invalidates open recovery codes and ends the account''s other sessions.';
comment on function identity.change_my_phone(text,uuid,uuid,char,char[],bytea,text,boolean) is
  '0094: changes the live patient session''s phone (Identity checked the current password): changed, unchanged, rate_limited or unavailable; the same number is written again when Identity cannot read the stored one.';
comment on function ehr.save_my_reported_health_profile(bigint,text,text,text,text,text,text) is
  '0094: saves the health information the patient of a fresh patient-self transaction entered; conflict on a stale version.';
