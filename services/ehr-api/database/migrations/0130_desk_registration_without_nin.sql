-- 0130 Registration at the front desk without a NIN (ID-2, Release A of the
-- Akos EHR plan of 18 November 2026). Written on staging-novu-ci-20261005 at
-- afec3f75, where 0001-0127 are applied. 0128 (hid-system#264) and 0129
-- (hid-system#266) are booked before this number and touch nothing this file
-- reads or replaces. This file requires 0001-0127 applied. The declaration
-- is signed separately (the release integrator's).
--
-- Owner, 18 November 2026 (Q106, recommended answer accepted): the front
-- desk may register a patient without a NIN. "Phone required except for
-- children. The same desk person creates the record when there are no
-- possible duplicates. An approver decides when there are possible
-- duplicates, and always for link-existing." Screens say "NIN Verified" or
-- "NIN Not Verified"; nothing here returns the word the owner ruled out.
-- Outreach and self sign-up are unchanged; the NIN path is unchanged.
--
-- WHAT IT DOES
--   1. identity.registration_cases gains identity_evidence ('nin_verified',
--      the default and every existing row, or 'none') and no_nin_reason
--      (nin_service_unavailable, no_nin, not_carried, child,
--      foreign_national). The seven NIN and verification columns become
--      nullable, and registration_cases_evidence_shape_ck makes them null
--      exactly when the evidence is 'none' (and set, with no reason, when it
--      is 'nin_verified'). A case without a NIN is never
--      pending_new_identity_approval or resolved_existing_identity: it is
--      created at the desk (approved_new_identity) or sent for review
--      (review_required). A partial index serves the open-case duplicate check,
--      and a read policy lets the cases' owner (the functions below and 0131's)
--      read every case, as 0114 lets it read the contacts.
--   2. identity.no_nin_case_writes: a marker row each of this file's two
--      functions writes just before it writes a case without a NIN and
--      deletes just after (no runtime role has any privilege on it). The
--      case trigger refuses any write to a case without a NIN that has no
--      marker for that case from the same transaction, so a case without a
--      NIN can be created or decided only through those functions.
--   3. identity.desk_registration_phone_lookups: the keyed hash (the
--      Identity contact lookup HMAC, the key sign-in already uses) of the
--      phone the desk recorded for a case without a NIN, with the patient
--      once there is one. Only the functions read or write it. It is deleted
--      with the contact: an AFTER UPDATE OF erased_at trigger on
--      identity.registration_case_contacts and on
--      identity.patient_facility_contacts removes the case's row when either
--      is erased.
--   4. identity.validate_registration_case_write() (0011) is replaced. For a
--      NIN case every rule of 0011 is kept, and an INSERT may no longer
--      create a case that is already decided (approved_new_identity,
--      linked_existing, rejected or cancelled), and may create
--      resolved_existing_identity only for a patient who holds an active,
--      checked NIN with the case's lookup HMAC: the routes never did either,
--      and 0131 counts such cases as "registered here". For a case without a
--      NIN: identity_evidence, no_nin_reason and every column the 0011 rule
--      keeps fixed stay fixed; the write needs this transaction's
--      no_nin_case_writes row; an INSERT is review_required (no patient, not
--      reviewed) or approved_new_identity reviewed by its own creator with
--      this file's fixed reason; an UPDATE is review_required ->
--      approved_new_identity, linked_existing or rejected, by a member with
--      identity.registration.approve who did not create the case.
--   5. identity.register_patient_without_nin(...) (SECURITY DEFINER), for the
--      desk (identity.registration.write, purpose healthcare-operations):
--      checks the request (names, date of birth, reason; a phone and address
--      unless the reason is child, and child only under 18 on the Lagos
--      date; a stated Health ID's shape), replays an idempotent retry,
--      counts the facility's registrations without a NIN today (the Lagos
--      day) for an operations alert, with no daily limit (owner Q109: no
--      rate limit on a staff member or facility, so a busy day or a day
--      QoreID is down is never refused), refuses a sealed demo or QA
--      facility, serialises on
--      the date of birth, and looks for possible duplicates among active
--      patients the facility's seal allows: the same date of birth with the
--      same last name (or first and last swapped), the same phone (a
--      patient's sign-in phone or a phone a desk recorded for a registration
--      without a NIN), or the Health ID the patient stated; and open
--      registrations without a NIN (review_required) with the same date of
--      birth and last name or the same phone. With none, it creates the
--      patient at once (source_system 'hid-desk-registration', no NIN
--      identifier) and a case approved_new_identity reviewed by the same
--      desk person with the fixed reason. With any, it records the
--      candidates (the patient ids, scores and reason kinds) and a case
--      review_required. It writes the contact (phone and address ciphertext,
--      as 0114), the phone lookup, the case event, the outbox event for a
--      new patient and one audit row (criteria kinds only, never a name,
--      date of birth or phone). The desk is answered the outcome only.
--   6. identity.review_patient_without_nin(...) (SECURITY DEFINER), for an
--      approver (identity.registration.approve) who is not the case's
--      creator, at the case's facility: create_new (a new patient), or
--      link_existing (one of the case's candidates, active and allowed by
--      the seal), or reject; a written reason of 8-500 characters; the
--      case's version; an idempotent replay. Same records as 5.
--   7. EXECUTE on 5 and 6: revoked from PUBLIC, granted to
--      hid_identity_runtime (here when the role exists, and in
--      runtime-grants.sql).
--
-- No platform control is added (the owner's rule: no new settings unless
-- unavoidable); identity-api's registration-capabilities answers
-- withoutNin.enabled true with this file.
--
-- Locks, taken first (section 0b), NOWAIT: ACCESS EXCLUSIVE on
-- identity.registration_cases (ADD COLUMN with a constant default, DROP NOT
-- NULL, ADD CONSTRAINT with one validating scan of a small table, CREATE
-- INDEX and CREATE POLICY), SHARE ROW EXCLUSIVE on
-- identity.registration_case_contacts and identity.patient_facility_contacts
-- (CREATE TRIGGER) and on identity.patients and identity.facilities (the
-- foreign keys of a new, empty table), each held to commit. That is every
-- existing table this file locks (pg_locks before commit), at the strongest
-- mode it takes. New tables and functions take no lock on existing data.
-- A busy table fails the attempt at once, and its subtransaction releases
-- what it took. The attempt is made again every 100 ms for at most 5 seconds,
-- so the file never waits while holding a lock and no request queues behind
-- a waiting lock; then 55P03 (nothing applied; the release can run again).
-- When this transaction already holds an earlier migration's locks that stop
-- other sessions' reads or writes (the runner's dry run applies every pending
-- file in one transaction), one attempt and no sleep: 55P03 at once, nothing
-- applied, instead of keeping those locks while this file waits. Indexes are
-- locked only by planning (ACCESS SHARE), which only a REINDEX or DROP INDEX
-- could hold up.
--
-- Old services on this schema: today's identity-api never writes the new
-- columns (their defaults keep every NIN case as it was) and never calls the
-- new functions; its NIN routes are unchanged. The identity-api of this
-- branch needs this file before it serves POST
-- identity/registration-cases/without-nin.
--
-- 0. Preconditions (catalog reads only; 55000 and nothing applied).
-- 0b. Locks, NOWAIT (55P03 and nothing applied).
-- 1-7. As above.
-- 8. Post-checks.

-- 0. Preconditions.
do $$
declare
  mismatch text;
begin
  if to_regprocedure('identity.organization_staff_kinds(uuid)') is null
     or to_regclass('auth.session_single_sign_on') is null then
    raise exception using errcode = '55000', message = '0130: 0001-0127 must be applied first';
  end if;
  if exists (select 1 from pg_attribute attribute
              where attribute.attrelid = 'identity.registration_cases'::regclass
                and attribute.attname = 'identity_evidence' and not attribute.attisdropped)
     or to_regclass('identity.no_nin_case_writes') is not null then
    raise exception using errcode = '55000', message = '0130: already applied';
  end if;
  select string_agg(expected.column_name, ', ') into mismatch
    from (values
      ('nin_ciphertext', 'bytea'), ('nin_lookup_hmac', 'character(64)'), ('nin_last4', 'character(4)'),
      ('nin_key_version', 'text'), ('verification_provider', 'text'), ('verification_reference', 'text'),
      ('verified_at', 'timestamp with time zone'), ('status', 'text'), ('dob', 'date'),
      ('resolved_patient_id', 'uuid'), ('review_reason', 'text')) expected(column_name, type_name)
   where not exists (select 1 from pg_attribute attribute
                      where attribute.attrelid = 'identity.registration_cases'::regclass
                        and attribute.attname = expected.column_name and not attribute.attisdropped
                        and format_type(attribute.atttypid, attribute.atttypmod) = expected.type_name);
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0130: these registration case columns are not as 0011 made them: ' || mismatch;
  end if;
  if (select md5(pg_get_constraintdef(constraint_row.oid)) from pg_constraint constraint_row
       where constraint_row.conrelid = 'identity.registration_cases'::regclass
         and constraint_row.conname = 'registration_cases_status_check') is distinct from 'f7cca5aafe5876b9fd41610399a9baa7'
     and (select md5(pg_get_constraintdef(constraint_row.oid)) from pg_constraint constraint_row
       where constraint_row.conrelid = 'identity.registration_cases'::regclass
         and constraint_row.conname = 'registration_cases_status_check') is distinct from 'c025a641bc5415fa9c3643a08c172534' then
    raise exception using errcode = '55000', message = '0130: registration_cases_status_check is not as 0011 made it';
  end if;
  select string_agg(expected.signature, ', ') into mismatch
    from (values
      ('identity.validate_registration_case_write()', '5a7f6b2a0ba328acbdee00ef2a8f02cc'),
      ('identity.guard_facility_contact_erasure()', 'b8a5b6cb7ed29370d0d5de9b7db959a5'),
      ('identity.sealed_demo_facility(uuid)', 'd91d91c1d3e1a455e49c5960f313a6e7'),
      ('identity.sealed_qa_facility(uuid)', 'fe9846d94cd744bf37c3f72053d9931f'),
      ('identity.sealed_demo_patient(uuid)', '18fc6ced32fbc0803f56b4870b1de762'),
      ('identity.sealed_qa_patient(uuid)', '1728c2ed495d2255accfba6260571a97'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6')
    ) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0130: these bodies are not as 0011-0123 left them: ' || mismatch;
  end if;
  if not exists (select 1 from pg_trigger trigger_row
                  where trigger_row.tgrelid = 'identity.registration_cases'::regclass
                    and trigger_row.tgname = 'registration_cases_validate_write'
                    and trigger_row.tgfoid = 'identity.validate_registration_case_write()'::regprocedure) then
    raise exception using errcode = '55000', message = '0130: registration_cases_validate_write is not as 0011 made it';
  end if;
end
$$;

-- 0b. Locks (see Locks), NOWAIT, at most 5 s; one attempt when this
-- transaction already holds an earlier migration's locks.
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
      lock table identity.registration_cases
        in access exclusive mode nowait;
      lock table identity.registration_case_contacts, identity.patient_facility_contacts, identity.patients, identity.facilities
        in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if holding then
        raise exception using errcode = '55P03',
          message = '0130: identity.registration_cases, the registration or facility contacts, identity.patients or identity.facilities is busy, and this transaction already holds an earlier migration''s '
            || 'locks, so it does not wait; nothing applied; run the release again at a quieter time';
      end if;
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0130: identity.registration_cases, the registration or facility contacts, identity.patients or identity.facilities stayed busy for 5 seconds; nothing applied; run the release again at a '
            || 'quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
end
$locks$;

-- 1. The case's evidence.
alter table identity.registration_cases
  add column identity_evidence text not null default 'nin_verified',
  add column no_nin_reason text,
  alter column nin_ciphertext drop not null,
  alter column nin_lookup_hmac drop not null,
  alter column nin_last4 drop not null,
  alter column nin_key_version drop not null,
  alter column verification_provider drop not null,
  alter column verification_reference drop not null,
  alter column verified_at drop not null,
  add constraint registration_cases_identity_evidence_ck
    check (identity_evidence in ('nin_verified', 'none')),
  add constraint registration_cases_no_nin_reason_ck
    check (no_nin_reason is null or no_nin_reason in
      ('nin_service_unavailable', 'no_nin', 'not_carried', 'child', 'foreign_national')),
  add constraint registration_cases_evidence_shape_ck check (
    (identity_evidence = 'nin_verified' and no_nin_reason is null
      and nin_ciphertext is not null and nin_lookup_hmac is not null and nin_last4 is not null
      and nin_key_version is not null and verification_provider is not null
      and verification_reference is not null and verified_at is not null)
    or (identity_evidence = 'none' and no_nin_reason is not null
      and nin_ciphertext is null and nin_lookup_hmac is null and nin_last4 is null
      and nin_key_version is null and verification_provider is null
      and verification_reference is null and verified_at is null
      and status in ('review_required', 'approved_new_identity', 'linked_existing', 'rejected', 'cancelled')));

comment on column identity.registration_cases.identity_evidence is
  '0130: nin_verified (the NIN was checked, 0011) or none (registered at the desk without a NIN; shown as NIN Not Verified).';
comment on column identity.registration_cases.no_nin_reason is
  '0130: why the desk registered the patient without a NIN: nin_service_unavailable, no_nin, not_carried, child or foreign_national.';

-- Row-level security on the cases is forced, so a SECURITY DEFINER function
-- whose owner does not bypass it (production's owner) reads only what its
-- caller's policies admit. The duplicate check reads open registrations
-- without a NIN at every facility, and 0131 reads this facility's cases for
-- a doctor or nurse who holds no registration permission, so the cases' owner
-- may read them, as the contact tables' owners may (0114). No runtime role is
-- a member of the owner.
create policy registration_cases_owner_read on identity.registration_cases
  for select
  using (pg_has_role((select relation.relowner from pg_class relation
                       where relation.oid = 'identity.registration_cases'::regclass), 'USAGE'));

create index registration_cases_no_nin_open_dob_idx
  on identity.registration_cases (dob)
  where identity_evidence = 'none' and status = 'review_required';

-- 2. The functions' write marker.
create table identity.no_nin_case_writes (
  case_id uuid not null,
  transaction_id xid8 not null default pg_current_xact_id(),
  written_at timestamptz not null default clock_timestamp(),
  primary key (case_id, transaction_id)
);
alter table identity.no_nin_case_writes enable row level security;
comment on table identity.no_nin_case_writes is
  '0130: written only by identity.register_patient_without_nin and identity.review_patient_without_nin; identity.validate_registration_case_write refuses a write to a case without a NIN without a row from the same transaction. No runtime role has a privilege on it.';
revoke all on identity.no_nin_case_writes from public;

-- 3. The desk phone lookups.
create table identity.desk_registration_phone_lookups (
  registration_case_id uuid primary key
    references identity.registration_case_contacts (registration_case_id) on delete restrict,
  facility_id uuid not null references identity.facilities (id) on delete restrict,
  patient_id uuid references identity.patients (id) on delete restrict,
  phone_lookup_hmac character(64) not null check (phone_lookup_hmac ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp()
);
create index desk_registration_phone_lookups_hmac_idx
  on identity.desk_registration_phone_lookups (phone_lookup_hmac);
create index desk_registration_phone_lookups_patient_idx
  on identity.desk_registration_phone_lookups (patient_id) where patient_id is not null;
alter table identity.desk_registration_phone_lookups enable row level security;
comment on table identity.desk_registration_phone_lookups is
  '0130: the contact lookup HMAC of the phone a desk recorded for a registration without a NIN, for the duplicate check. Deleted when the case contact or the facility contact is erased. No runtime role has a privilege on it.';
revoke all on identity.desk_registration_phone_lookups from public;

create function identity.forget_desk_registration_phone_lookup()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.erased_at is not null and old.erased_at is null then
    delete from identity.desk_registration_phone_lookups lookup
     where lookup.registration_case_id = new.registration_case_id;
  end if;
  return null;
end
$$;
comment on function identity.forget_desk_registration_phone_lookup() is
  '0130: deletes the desk phone lookup of a registration case when its case contact or facility contact is erased.';
revoke all on function identity.forget_desk_registration_phone_lookup() from public;

create trigger registration_case_contacts_forget_phone_lookup
  after update of erased_at on identity.registration_case_contacts
  for each row execute function identity.forget_desk_registration_phone_lookup();
create trigger patient_facility_contacts_forget_phone_lookup
  after update of erased_at on identity.patient_facility_contacts
  for each row execute function identity.forget_desk_registration_phone_lookup();

-- 4. The case trigger.
create or replace function identity.validate_registration_case_write()
returns trigger
language plpgsql
security definer
set search_path = identity, auth, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  actor_membership uuid := platform.current_membership_id();
  actor_facility uuid := platform.current_facility_id();
  desk_reason constant text := 'No possible duplicates: created at the desk without a NIN';
begin
  if actor_account is null
     or actor_membership is null
     or actor_facility is null
     or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'Verified registration context is required';
  end if;

  -- 0130: a case without a NIN is written only by the two 0130 functions.
  if new.identity_evidence = 'none' or (tg_op = 'UPDATE' and old.identity_evidence = 'none') then
    if not exists (select 1 from identity.no_nin_case_writes marker
                    where marker.case_id = new.id and marker.transaction_id = pg_current_xact_id()) then
      raise exception using errcode = '42501', message = 'A registration without a NIN is written only by its commands';
    end if;
    if tg_op = 'INSERT' then
      if new.created_by_account_id <> actor_account
         or new.created_by_membership_id <> actor_membership
         or new.facility_id <> actor_facility
         or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'identity.registration.write')
         or not (
           (new.status = 'review_required' and new.resolved_patient_id is null and new.reviewed_by_account_id is null)
           or (new.status = 'approved_new_identity' and new.reviewed_by_account_id = actor_account
               and new.reviewed_by_membership_id = actor_membership and new.review_reason = desk_reason)
         ) then
        raise exception using errcode = '42501', message = 'Registration case attribution is invalid';
      end if;
      return new;
    end if;
    if new.identity_evidence is distinct from old.identity_evidence
       or new.no_nin_reason is distinct from old.no_nin_reason
       or new.facility_id is distinct from old.facility_id
       or new.created_by_account_id is distinct from old.created_by_account_id
       or new.created_by_membership_id is distinct from old.created_by_membership_id
       or new.first_name is distinct from old.first_name
       or new.last_name is distinct from old.last_name
       or new.full_name is distinct from old.full_name
       or new.dob is distinct from old.dob
       or new.gender is distinct from old.gender
       or new.idempotency_key is distinct from old.idempotency_key
       or new.request_sha256 is distinct from old.request_sha256
       or new.row_version <> old.row_version + 1
       or new.reviewed_by_account_id is distinct from actor_account
       or new.reviewed_by_membership_id is distinct from actor_membership
       or actor_account = old.created_by_account_id
       or old.status <> 'review_required'
       or new.status not in ('approved_new_identity', 'linked_existing', 'rejected')
       or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'identity.registration.approve') then
      raise exception using errcode = '42501', message = 'Registration review transition is invalid';
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.created_by_account_id <> actor_account
       or new.created_by_membership_id <> actor_membership
       or new.facility_id <> actor_facility
       or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'identity.registration.write') then
      raise exception using errcode = '42501', message = 'Registration case attribution is invalid';
    end if;
    -- 0130: a NIN case starts undecided; resolved_existing_identity only for
    -- the patient who already holds this checked NIN.
    if new.status not in ('pending_new_identity_approval', 'review_required', 'resolved_existing_identity')
       or (new.status = 'resolved_existing_identity' and not exists (
         select 1 from identity.patient_identifiers identifier
          where identifier.patient_id = new.resolved_patient_id
            and identifier.identifier_type = 'nin'
            and identifier.lookup_hmac = new.nin_lookup_hmac
            and identifier.verified and identifier.revoked_at is null)) then
      raise exception using errcode = '42501', message = 'Registration case attribution is invalid';
    end if;
    return new;
  end if;

  if new.identity_evidence is distinct from old.identity_evidence
     or new.no_nin_reason is distinct from old.no_nin_reason
     or new.facility_id is distinct from old.facility_id
     or new.created_by_account_id is distinct from old.created_by_account_id
     or new.created_by_membership_id is distinct from old.created_by_membership_id
     or new.first_name is distinct from old.first_name
     or new.last_name is distinct from old.last_name
     or new.full_name is distinct from old.full_name
     or new.dob is distinct from old.dob
     or new.gender is distinct from old.gender
     or new.nin_lookup_hmac is distinct from old.nin_lookup_hmac
     or new.nin_ciphertext is distinct from old.nin_ciphertext
     or new.nin_last4 is distinct from old.nin_last4
     or new.nin_key_version is distinct from old.nin_key_version
     or new.verification_provider is distinct from old.verification_provider
     or new.verification_reference is distinct from old.verification_reference
     or new.verified_at is distinct from old.verified_at
     or new.idempotency_key is distinct from old.idempotency_key
     or new.request_sha256 is distinct from old.request_sha256
     or (old.review_idempotency_key is not null and new.review_idempotency_key is distinct from old.review_idempotency_key)
     or (old.review_request_sha256 is not null and new.review_request_sha256 is distinct from old.review_request_sha256)
     or new.row_version <> old.row_version + 1
     or new.reviewed_by_account_id is distinct from actor_account
     or new.reviewed_by_membership_id is distinct from actor_membership
     or not (
       (old.status = 'pending_new_identity_approval' and new.status in ('approved_new_identity', 'rejected', 'cancelled'))
       or (old.status = 'review_required' and new.status in ('linked_existing', 'rejected', 'cancelled'))
     )
     or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'identity.registration.approve') then
    raise exception using errcode = '42501', message = 'Registration review transition is invalid';
  end if;
  return new;
end;
$$;

-- 5. The desk command.
create function identity.register_patient_without_nin(
  requested_case_id uuid,
  requested_first_name text,
  requested_last_name text,
  requested_dob date,
  requested_gender text,
  requested_no_nin_reason text,
  requested_phone_lookup_hmacs text,
  requested_phone_ciphertext bytea,
  requested_address_ciphertext bytea,
  requested_contact_key_version text,
  requested_stated_hid text,
  requested_idempotency_key text,
  requested_request_sha256 text,
  requested_hid_code text)
returns table (case_id uuid, case_status text, case_version bigint, subject_patient_id uuid,
  subject_hid_code text, candidate_count integer, facility_daily_count integer, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  actor_membership uuid := platform.current_membership_id();
  actor_facility uuid := platform.current_facility_id();
  actor_correlation text := platform.current_correlation_id();
  actor_organization uuid;
  lagos_today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
  first_value text := btrim(coalesce(requested_first_name, ''));
  last_value text := btrim(coalesce(requested_last_name, ''));
  stated_value text := upper(btrim(requested_stated_hid));
  phone_hmacs character(64)[];
  has_contact boolean := requested_phone_ciphertext is not null;
  existing identity.registration_cases%rowtype;
  facility_count integer;
  open_cases integer;
  candidates_found integer;
  candidate_json jsonb;
  new_patient uuid;
  desk_reason constant text := 'No possible duplicates: created at the desk without a NIN';
  kinds text[];
begin
  if actor_account is null or actor_membership is null or actor_facility is null or actor_correlation is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not exists (select 1 from identity.staff_facility_memberships membership
                     where membership.id = actor_membership and membership.account_id = actor_account
                       and membership.facility_id = actor_facility and membership.active
                       and membership.migration_hold_reason is null)
     or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'identity.registration.write') then
    raise exception using errcode = '42501', message = 'NO_NIN_REGISTRATION_DENIED';
  end if;
  select membership.organization_id into actor_organization
    from identity.staff_facility_memberships membership where membership.id = actor_membership;
  if identity.sealed_demo_facility(actor_facility) or identity.sealed_qa_facility(actor_facility) then
    raise exception using errcode = '42501', message = 'NO_NIN_REGISTRATION_SEALED_FACILITY';
  end if;

  -- The request.
  if requested_case_id is null
     or length(first_value) not between 1 and 100 or length(last_value) not between 1 and 100
     or requested_dob is null or requested_dob < date '1900-01-01' or requested_dob > lagos_today
     or (requested_gender is not null and requested_gender not in ('female', 'male', 'intersex', 'other', 'unknown'))
     or requested_no_nin_reason is null
     or requested_no_nin_reason not in ('nin_service_unavailable', 'no_nin', 'not_carried', 'child', 'foreign_national')
     or coalesce(requested_idempotency_key, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
     or coalesce(requested_request_sha256, '') !~ '^[0-9a-f]{64}$'
     or coalesce(requested_hid_code, '') !~ '^HID-[A-HJ-NP-Z2-9]{6,32}$'
     or (stated_value is not null and stated_value !~ '^HID-[A-HJ-NP-Z2-9]{6,32}$')
     -- The phone and the address come together (0114's contact row), with their lookup.
     or (requested_phone_ciphertext is null) <> (requested_address_ciphertext is null)
     or (requested_phone_ciphertext is null) <> (requested_contact_key_version is null)
     or (requested_phone_ciphertext is null) <> (requested_phone_lookup_hmacs is null)
     or (requested_phone_lookup_hmacs is not null
         and requested_phone_lookup_hmacs !~ '^[0-9a-f]{64}(,[0-9a-f]{64})?$') then
    raise exception using errcode = '22023', message = 'NO_NIN_REGISTRATION_INVALID';
  end if;
  -- Owner Q106: a phone is required, except for a child (under 18 on today's Lagos date).
  if requested_no_nin_reason = 'child'
     and requested_dob <= (lagos_today - interval '18 years')::date then
    raise exception using errcode = '22023', message = 'NO_NIN_REGISTRATION_NOT_A_CHILD';
  end if;
  if requested_no_nin_reason <> 'child' and not has_contact then
    raise exception using errcode = '22023', message = 'NO_NIN_REGISTRATION_PHONE_REQUIRED';
  end if;
  if requested_phone_lookup_hmacs is not null then
    phone_hmacs := string_to_array(requested_phone_lookup_hmacs, ',')::character(64)[];
  end if;

  -- An idempotent retry.
  select * into existing from identity.registration_cases registration
   where registration.facility_id = actor_facility and registration.created_by_account_id = actor_account
     and registration.idempotency_key = requested_idempotency_key;
  if found then
    if existing.request_sha256 is distinct from requested_request_sha256 or existing.identity_evidence <> 'none' then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return query select existing.id, existing.status, existing.row_version, existing.resolved_patient_id,
      (select patient.hid_code from identity.patients patient where patient.id = existing.resolved_patient_id),
      (select count(*)::integer from identity.registration_case_candidates candidate where candidate.case_id = existing.id),
      null::integer, true;
    return;
  end if;

  -- No daily limit (owner Q109): the facility's count today is only for the
  -- operations alert, so it is read without a lock.
  select count(*) into facility_count
    from identity.registration_cases registration
   where registration.facility_id = actor_facility
     and registration.identity_evidence = 'none'
     and registration.created_at >= (lagos_today::timestamp at time zone 'Africa/Lagos');

  -- One registration without a NIN for a date of birth at a time, so two
  -- desks registering the same person see each other.
  perform pg_advisory_xact_lock(hashtextextended('no-nin-registration-dob:' || requested_dob::text, 0));

  select coalesce(jsonb_agg(jsonb_build_object('patientId', ranked.patient_id, 'score', ranked.score,
           'reasons', to_jsonb(ranked.reasons)) order by ranked.score desc, ranked.patient_id), '[]'::jsonb)
    into candidate_json
    from (
      select hits.patient_id, max(hits.score) as score,
             array_agg(distinct hits.reason order by hits.reason) as reasons
        from (
          -- The same date of birth with the same last name, or the names swapped.
          select patient.id as patient_id, 90 as score, unnest(case
                   when lower(patient.first_name) = lower(first_value)
                     then array['date_of_birth', 'first_name', 'last_name']
                   else array['date_of_birth', 'last_name'] end) as reason
            from identity.patients patient
           where patient.status = 'active' and patient.dob = requested_dob
             and lower(patient.last_name) = lower(last_value)
          union all
          select patient.id, 85, unnest(array['date_of_birth', 'first_name', 'last_name'])
            from identity.patients patient
           where patient.status = 'active' and patient.dob = requested_dob
             and lower(patient.last_name) = lower(first_value) and lower(patient.first_name) = lower(last_value)
          -- The same phone: a sign-in phone, or one a desk recorded.
          union all
          select patient.id, 80, 'phone'
            from identity.patients patient
           where phone_hmacs is not null and patient.status = 'active'
             and patient.phone_lookup_hmac = any (phone_hmacs)
          union all
          select lookup.patient_id, 80, 'phone'
            from identity.desk_registration_phone_lookups lookup
            join identity.patients patient on patient.id = lookup.patient_id and patient.status = 'active'
           where phone_hmacs is not null and lookup.phone_lookup_hmac = any (phone_hmacs)
          -- The Health ID the patient stated.
          union all
          select patient.id, 65, 'stated_hid'
            from identity.patients patient
           where stated_value is not null and patient.status = 'active'
             and upper(patient.hid_code) = stated_value
        ) hits
       -- This facility is not sealed (refused above), so a sealed demo or QA
       -- patient is never a candidate here.
       where not identity.sealed_demo_patient(hits.patient_id)
         and not identity.sealed_qa_patient(hits.patient_id)
       group by hits.patient_id
       order by max(hits.score) desc, hits.patient_id
       limit 20
    ) ranked;
  candidates_found := jsonb_array_length(candidate_json);

  -- Open registrations without a NIN that look like the same person.
  select count(*)::integer into open_cases
    from identity.registration_cases registration
   where registration.identity_evidence = 'none' and registration.status = 'review_required'
     and ((registration.dob = requested_dob and lower(registration.last_name) = lower(last_value))
          or (phone_hmacs is not null and exists (
            select 1 from identity.desk_registration_phone_lookups lookup
             where lookup.registration_case_id = registration.id
               and lookup.phone_lookup_hmac = any (phone_hmacs))));

  kinds := array_remove(array[
    case when exists (select 1 from jsonb_array_elements(candidate_json) item where item -> 'reasons' ? 'date_of_birth')
      then 'name_and_date_of_birth' end,
    case when exists (select 1 from jsonb_array_elements(candidate_json) item where item -> 'reasons' ? 'phone')
      then 'phone' end,
    case when exists (select 1 from jsonb_array_elements(candidate_json) item where item -> 'reasons' ? 'stated_hid')
      then 'stated_health_id' end,
    case when open_cases > 0 then 'open_registration' end], null);

  insert into identity.no_nin_case_writes (case_id) values (requested_case_id);

  if candidates_found = 0 and open_cases = 0 then
    -- Owner Q106: no possible duplicates, so the same desk person creates the record.
    new_patient := pg_catalog.gen_random_uuid();
    insert into identity.patients (id, hid_code, first_name, last_name, full_name, dob, gender, status, source_system)
    values (new_patient, requested_hid_code, first_value, last_value, first_value || ' ' || last_value,
            requested_dob, requested_gender, 'active', 'hid-desk-registration');
    insert into identity.registration_cases (
      id, facility_id, created_by_account_id, created_by_membership_id, status,
      first_name, last_name, full_name, dob, gender, identity_evidence, no_nin_reason,
      idempotency_key, request_sha256, resolved_patient_id,
      review_idempotency_key, review_request_sha256, reviewed_by_account_id, reviewed_by_membership_id, review_reason
    ) values (
      requested_case_id, actor_facility, actor_account, actor_membership, 'approved_new_identity',
      first_value, last_value, first_value || ' ' || last_value, requested_dob, requested_gender, 'none',
      requested_no_nin_reason, requested_idempotency_key, requested_request_sha256, new_patient,
      requested_idempotency_key, requested_request_sha256, actor_account, actor_membership, desk_reason
    );
  else
    insert into identity.registration_cases (
      id, facility_id, created_by_account_id, created_by_membership_id, status,
      first_name, last_name, full_name, dob, gender, identity_evidence, no_nin_reason,
      idempotency_key, request_sha256
    ) values (
      requested_case_id, actor_facility, actor_account, actor_membership, 'review_required',
      first_value, last_value, first_value || ' ' || last_value, requested_dob, requested_gender, 'none',
      requested_no_nin_reason, requested_idempotency_key, requested_request_sha256
    );
    insert into identity.registration_case_candidates (case_id, patient_id, match_score, match_reasons)
    select requested_case_id, (item ->> 'patientId')::uuid, (item ->> 'score')::smallint, item -> 'reasons'
      from jsonb_array_elements(candidate_json) item;
  end if;

  -- The marker lives only for the write it allows.
  delete from identity.no_nin_case_writes marker
   where marker.case_id = requested_case_id and marker.transaction_id = pg_current_xact_id();

  if has_contact then
    insert into identity.registration_case_contacts (
      registration_case_id, facility_id, phone_ciphertext, address_ciphertext, key_version,
      stated_hid_code, created_by_account_id, created_by_membership_id
    ) values (requested_case_id, actor_facility, requested_phone_ciphertext, requested_address_ciphertext,
      requested_contact_key_version, stated_value, actor_account, actor_membership);
    insert into identity.desk_registration_phone_lookups (registration_case_id, facility_id, patient_id, phone_lookup_hmac)
    values (requested_case_id, actor_facility, new_patient, phone_hmacs[1]);
    if new_patient is not null then
      insert into identity.patient_facility_contacts (
        patient_id, facility_id, registration_case_id, phone_ciphertext, address_ciphertext, key_version,
        created_by_account_id, created_by_membership_id)
      values (new_patient, actor_facility, requested_case_id, requested_phone_ciphertext,
        requested_address_ciphertext, requested_contact_key_version, actor_account, actor_membership);
    end if;
  end if;

  insert into identity.registration_case_events (
    case_id, event_type, actor_account_id, actor_membership_id, facility_id, patient_id, reason, details
  ) values (
    requested_case_id, case when new_patient is null then 'review_required' else 'approved_new_identity' end,
    actor_account, actor_membership, actor_facility, new_patient,
    case when new_patient is null then null else desk_reason end,
    jsonb_build_object('withoutNin', true, 'noNinReason', requested_no_nin_reason,
      'candidateCount', candidates_found, 'openRegistrationCount', open_cases,
      'duplicateKinds', to_jsonb(kinds), 'contactRecorded', has_contact,
      'statedHealthId', stated_value is not null)
  );
  if new_patient is not null then
    insert into identity.outbox_events (
      event_type, aggregate_id, aggregate_version, facility_id, patient_id, correlation_id, payload
    ) values ('PatientRegistered', requested_case_id, 2, actor_facility, new_patient, actor_correlation,
      jsonb_build_object('source', 'desk-registration-without-nin'));
  end if;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    actor_correlation, 'staff', actor_subject, actor_account, actor_membership,
    actor_organization, actor_facility, new_patient, 'identity.registration.without-nin', 'success',
    'registration-case', requested_case_id::text, 'healthcare-operations', 'application', 'identity-api',
    jsonb_build_object('status', case when new_patient is null then 'review_required' else 'approved_new_identity' end,
      'noNinReason', requested_no_nin_reason, 'candidateCount', candidates_found,
      'candidatePatientIds', (select coalesce(jsonb_agg(item -> 'patientId'), '[]'::jsonb)
                                from jsonb_array_elements(candidate_json) item),
      'openRegistrationCount', open_cases, 'duplicateKinds', to_jsonb(kinds),
      'contactRecorded', has_contact, 'facilityDailyCount', facility_count + 1)
  );
  return query select requested_case_id,
    case when new_patient is null then 'review_required' else 'approved_new_identity' end,
    1::bigint, new_patient, case when new_patient is null then null else requested_hid_code end,
    candidates_found, facility_count + 1, false;
end
$$;

comment on function identity.register_patient_without_nin(uuid, text, text, date, text, text, text, bytea, bytea, text, text, text, text, text) is
  '0130 (ID-2, owner Q106 of 18 November 2026): the desk registers a patient without a NIN. No possible duplicate: the same desk person creates the patient at once (approved_new_identity, source hid-desk-registration). Any possible duplicate (same date of birth and last name, same phone, the stated Health ID, or an open registration without a NIN): review_required, for an approver. Phone and address required unless the reason is child (under 18). No daily limit (owner Q109); the count at the facility today is returned for an operations alert. Refused at sealed demo and QA facilities. Audited with criteria kinds only.';

-- 6. The approver command.
create function identity.review_patient_without_nin(
  requested_case_id uuid,
  requested_expected_version bigint,
  requested_decision text,
  requested_patient_id uuid,
  requested_reason text,
  requested_idempotency_key text,
  requested_request_sha256 text,
  requested_hid_code text)
returns table (case_id uuid, case_status text, case_version bigint, subject_patient_id uuid,
  subject_hid_code text, candidate_count integer, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  actor_membership uuid := platform.current_membership_id();
  actor_facility uuid := platform.current_facility_id();
  actor_correlation text := platform.current_correlation_id();
  actor_organization uuid;
  reason_value text := btrim(coalesce(requested_reason, ''));
  case_row identity.registration_cases%rowtype;
  target_status text;
  target_patient uuid;
  candidates integer;
begin
  if actor_account is null or actor_membership is null or actor_facility is null or actor_correlation is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not exists (select 1 from identity.staff_facility_memberships membership
                     where membership.id = actor_membership and membership.account_id = actor_account
                       and membership.facility_id = actor_facility and membership.active
                       and membership.migration_hold_reason is null)
     or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'identity.registration.approve') then
    raise exception using errcode = '42501', message = 'NO_NIN_REVIEW_DENIED';
  end if;
  select membership.organization_id into actor_organization
    from identity.staff_facility_memberships membership where membership.id = actor_membership;
  if requested_decision is null or requested_decision not in ('create_new', 'link_existing', 'reject')
     or length(reason_value) not between 8 and 500
     or requested_expected_version is null or requested_expected_version < 1
     or coalesce(requested_idempotency_key, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
     or coalesce(requested_request_sha256, '') !~ '^[0-9a-f]{64}$'
     or (requested_decision = 'create_new' and coalesce(requested_hid_code, '') !~ '^HID-[A-HJ-NP-Z2-9]{6,32}$')
     or ((requested_decision = 'link_existing') <> (requested_patient_id is not null)) then
    raise exception using errcode = '22023', message = 'NO_NIN_REVIEW_INVALID';
  end if;

  select * into case_row from identity.registration_cases registration
   where registration.id = requested_case_id and registration.facility_id = actor_facility
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'REGISTRATION_CASE_NOT_FOUND';
  end if;
  if case_row.identity_evidence <> 'none' then
    raise exception using errcode = '55000', message = 'NO_NIN_REVIEW_NOT_WITHOUT_NIN';
  end if;
  target_status := case requested_decision when 'create_new' then 'approved_new_identity'
    when 'link_existing' then 'linked_existing' else 'rejected' end;
  -- An idempotent retry of the decision already made.
  if case_row.status <> 'review_required' then
    if case_row.review_idempotency_key = requested_idempotency_key
       and case_row.review_request_sha256 = requested_request_sha256
       and case_row.status = target_status
       and case_row.reviewed_by_account_id = actor_account then
      return query select case_row.id, case_row.status, case_row.row_version, case_row.resolved_patient_id,
        (select patient.hid_code from identity.patients patient where patient.id = case_row.resolved_patient_id),
        (select count(*)::integer from identity.registration_case_candidates candidate where candidate.case_id = case_row.id),
        true;
      return;
    end if;
    if case_row.review_idempotency_key = requested_idempotency_key then
      raise exception using errcode = '22023', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    raise exception using errcode = '55000', message = 'NO_NIN_REVIEW_NOT_AWAITING';
  end if;
  -- Owner Q106: a second person decides.
  if case_row.created_by_account_id = actor_account then
    raise exception using errcode = '42501', message = 'NO_NIN_REVIEW_SECOND_PERSON';
  end if;
  if case_row.row_version <> requested_expected_version then
    raise exception using errcode = '55000', message = 'VERSION_CONFLICT';
  end if;

  if requested_decision = 'link_existing' then
    select candidate.patient_id into target_patient
      from identity.registration_case_candidates candidate
      join identity.patients patient on patient.id = candidate.patient_id and patient.status = 'active'
     where candidate.case_id = case_row.id and candidate.patient_id = requested_patient_id
       and identity.sealed_demo_patient(patient.id) = identity.sealed_demo_facility(actor_facility)
       and identity.sealed_qa_patient(patient.id) = identity.sealed_qa_facility(actor_facility);
    if target_patient is null then
      raise exception using errcode = '55000', message = 'PATIENT_NOT_A_REVIEW_CANDIDATE';
    end if;
  elsif requested_decision = 'create_new' then
    target_patient := pg_catalog.gen_random_uuid();
    insert into identity.patients (id, hid_code, first_name, last_name, full_name, dob, gender, status, source_system)
    values (target_patient, requested_hid_code, case_row.first_name, case_row.last_name, case_row.full_name,
            case_row.dob, case_row.gender, 'active', 'hid-desk-registration');
  end if;

  insert into identity.no_nin_case_writes (case_id) values (case_row.id);
  update identity.registration_cases registration
     set status = target_status, resolved_patient_id = target_patient,
         reviewed_by_account_id = actor_account, reviewed_by_membership_id = actor_membership,
         review_reason = reason_value, review_idempotency_key = requested_idempotency_key,
         review_request_sha256 = requested_request_sha256,
         row_version = registration.row_version + 1, updated_at = clock_timestamp()
   where registration.id = case_row.id;
  delete from identity.no_nin_case_writes marker
   where marker.case_id = case_row.id and marker.transaction_id = pg_current_xact_id();

  if target_patient is not null then
    insert into identity.patient_facility_contacts (
      patient_id, facility_id, registration_case_id, phone_ciphertext, address_ciphertext, key_version,
      created_by_account_id, created_by_membership_id)
    select target_patient, contact.facility_id, contact.registration_case_id, contact.phone_ciphertext,
           contact.address_ciphertext, contact.key_version, actor_account, actor_membership
      from identity.registration_case_contacts contact
     where contact.registration_case_id = case_row.id and contact.erased_at is null;
    update identity.desk_registration_phone_lookups lookup
       set patient_id = target_patient
     where lookup.registration_case_id = case_row.id;
  end if;

  insert into identity.registration_case_events (
    case_id, event_type, actor_account_id, actor_membership_id, facility_id, patient_id, reason, details
  ) values (case_row.id, target_status, actor_account, actor_membership, actor_facility, target_patient,
    reason_value, jsonb_build_object('withoutNin', true, 'decision', requested_decision));
  if requested_decision = 'create_new' then
    insert into identity.outbox_events (
      event_type, aggregate_id, aggregate_version, facility_id, patient_id, correlation_id, payload
    ) values ('PatientRegistered', case_row.id, 2, actor_facility, target_patient, actor_correlation,
      jsonb_build_object('source', 'desk-registration-without-nin'));
  elsif requested_decision = 'link_existing' then
    insert into identity.outbox_events (
      event_type, aggregate_id, aggregate_version, facility_id, patient_id, correlation_id, payload
    ) values ('PatientIdentityResolved', case_row.id, 2, actor_facility, target_patient, actor_correlation,
      jsonb_build_object('resolution', 'reviewed-existing-without-nin'));
  end if;
  select count(*)::integer into candidates from identity.registration_case_candidates candidate
   where candidate.case_id = case_row.id;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, reason, provenance, source_system, details
  ) values (
    actor_correlation, 'staff', actor_subject, actor_account, actor_membership,
    actor_organization, actor_facility, target_patient, 'identity.registration.without-nin.review', 'success',
    'registration-case', case_row.id::text, 'healthcare-operations', reason_value, 'application', 'identity-api',
    jsonb_build_object('decision', requested_decision, 'status', target_status, 'candidateCount', candidates)
  );
  return query select case_row.id, target_status, case_row.row_version + 1, target_patient,
    case when target_patient is null then null
         else (select patient.hid_code from identity.patients patient where patient.id = target_patient) end,
    candidates, false;
end
$$;

comment on function identity.review_patient_without_nin(uuid, bigint, text, uuid, text, text, text, text) is
  '0130 (ID-2, owner Q106 of 18 November 2026): an approver who did not create the case decides a registration without a NIN that has possible duplicates: create_new, link_existing (one of its candidates) or reject, with a written reason. Link-existing is always an approver''s decision.';

-- 7. Owners and EXECUTE.
revoke all on function identity.register_patient_without_nin(uuid, text, text, date, text, text, text, bytea, bytea, text, text, text, text, text) from public;
revoke all on function identity.review_patient_without_nin(uuid, bigint, text, uuid, text, text, text, text) from public;
do $$
declare
  case_owner name := (select pg_get_userbyid(proowner) from pg_proc
                       where oid = 'identity.validate_registration_case_write()'::regprocedure);
begin
  if case_owner <> current_user then
    execute format('alter function identity.register_patient_without_nin(uuid, text, text, date, text, text, text, bytea, bytea, text, text, text, text, text) owner to %I', case_owner);
    execute format('alter function identity.review_patient_without_nin(uuid, bigint, text, uuid, text, text, text, text) owner to %I', case_owner);
    execute format('alter function identity.forget_desk_registration_phone_lookup() owner to %I', case_owner);
    execute format('alter table identity.no_nin_case_writes owner to %I', case_owner);
    execute format('alter table identity.desk_registration_phone_lookups owner to %I', case_owner);
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant execute on function identity.register_patient_without_nin(uuid, text, text, date, text, text, text, bytea, bytea, text, text, text, text, text) to hid_identity_runtime;
    grant execute on function identity.review_patient_without_nin(uuid, bigint, text, uuid, text, text, text, text) to hid_identity_runtime;
  end if;
end
$$;

-- 8. Post-checks.
do $$
begin
  if exists (select 1 from identity.registration_cases where identity_evidence <> 'nin_verified') then
    raise exception using errcode = '55000', message = '0130: an existing case is not nin_verified';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'identity.registration_cases'::regclass
                  and conname = 'registration_cases_evidence_shape_ck' and convalidated) then
    raise exception using errcode = '55000', message = '0130: registration_cases_evidence_shape_ck is not valid';
  end if;
  if exists (select 1 from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
              where proc.oid in ('identity.register_patient_without_nin(uuid, text, text, date, text, text, text, bytea, bytea, text, text, text, text, text)'::regprocedure,
                                 'identity.review_patient_without_nin(uuid, bigint, text, uuid, text, text, text, text)'::regprocedure)
                and acl.grantee <> proc.proowner
                and (acl.grantee = 0 or pg_get_userbyid(acl.grantee) <> 'hid_identity_runtime')) then
    raise exception using errcode = '55000', message = '0130: a command is granted to a role other than hid_identity_runtime';
  end if;
  if exists (select 1 from pg_class relation, lateral aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
              where relation.oid in ('identity.no_nin_case_writes'::regclass, 'identity.desk_registration_phone_lookups'::regclass)
                and acl.grantee <> relation.relowner) then
    raise exception using errcode = '55000', message = '0130: a new table is granted to a role other than its owner';
  end if;
end
$$;
