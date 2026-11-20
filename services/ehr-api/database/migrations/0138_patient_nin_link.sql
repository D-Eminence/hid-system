-- 0138: verify a NIN later and link it (ID-6, Akos P0-1, Release B; the
-- planned contract's "ID-6: Verify a NIN later and link it"). Owner
-- decisions applied: Q109 (no limit per staff member or facility), Q115 (the
-- keep rule, applied by 0137 to the NIN check this route makes), Q117 (the
-- words when a NIN cannot be verified) and Q100 B (404 PATIENT_NOT_FOUND).
-- Booked as 0138 on hid-system#258; numbers are given in merge order at the
-- Release B cut-off. This file requires 0001-0137 applied.
--
-- A patient registered without a NIN (ID-2, 0130) gets a NIN checked with
-- QoreID at this facility's desk and attached to their record. On success
-- ID-0's rule reads "NIN Verified": a verified, unrevoked `nin` row in
-- identity.patient_identifiers. Nothing else about the patient changes:
-- names, date of birth, Health ID, the assurance state and who has access
-- stay as they are. Only this facility's own patients (0131's
-- identity.own_facility_basis), never through a consent grant; linking a NIN
-- never creates or extends an own-facility basis (it writes no registration
-- case, the rows 0131's "registered here" reads).
--
-- QoreID is asked by identity-api, through 0137's once-per-NIN guard as the
-- desk's check (path 'desk'), before 2. The NIN record's names (either
-- order) and date of birth are compared there; this file never sees them.
--
-- 1. identity.patient_nin_links: the evidence of each link (who, where, when,
--    QoreID's reference, the NIN's lookup HMAC and key version, never the NIN)
--    and the request's Idempotency-Key and digest, unique per account. It
--    cannot be changed or deleted (platform.reject_mutation, as
--    identity.verification_evidence), has row-level security on with no
--    policy and no grant: only the functions below, as its owner, write or
--    read it. identity.verification_evidence is not used: its patient rows
--    are the patient's own check (no staff membership or facility, its CHECK).
-- 2. identity.patient_identifiers.nin_link_id: the link a NIN row came from.
--    A NIN row names exactly one source: its registration case, its public
--    enrollment, the patient's own evidence, or (new) its link. The two
--    CHECKs that count them are replaced with the same rule over four.
-- 3. identity.patient_nin_link_precheck(patient, lookup HMAC, key, digest):
--    what the route may do before QoreID is asked (so nothing is charged for
--    a refusal): 'not_found' (no active patient of that id on this facility's
--    side of the seals: Q100 B, the same answer whatever the reason),
--    'not_permitted' (not this facility's own patient), 'already_linked' (the
--    same NIN, by lookup HMAC), 'has_nin' (another verified NIN), 'replay'
--    or 'key_reused' (the account's Idempotency-Key, with the same or
--    another digest), or 'eligible' with the record's first and last name
--    and date of birth, which identity-api compares with the NIN record.
-- 4. identity.link_patient_nin(...): the link, in one transaction. 0058's
--    advisory lock on the NIN (so a desk link and the patient's own binding
--    of the same NIN wait for each other), then the patient row FOR UPDATE;
--    3's checks again; a NIN already on another record answers
--    'on_another_record' and the other record's id (for the audit row only:
--    the route never names it); else the evidence row, the verified `nin`
--    identifier (source 'hid-desk-nin-link') and the patient's row_version
--    + 1, and the audit row identity.patient.nin-link (outcome nin_linked,
--    the patient, never the NIN or its HMAC).
-- 5. identity.patient_self_access_log: 0132's text plus one kind, nin_added
--    ("NIN added at <facility>"), for a staff identity.patient.nin-link row
--    whose outcome is nin_linked.
--
-- Both functions are SECURITY DEFINER, for hid_identity_runtime (and the
-- schema test runtime, as 0137's). Each
-- needs a staff session: an account, an active membership at the session's
-- facility with identity.registration.write, and purpose
-- healthcare-operations, as ID-2 (0130).
--
-- Locks: ACCESS EXCLUSIVE on identity.patient_identifiers (ADD COLUMN, the
-- CHECKs replaced and validated against its rows, a UNIQUE and a foreign
-- key), held to commit, and SHARE ROW EXCLUSIVE on identity.patients,
-- identity.facilities, identity.staff_facility_memberships and auth.accounts
-- (the foreign keys of the new, empty table). That is every existing table
-- this file locks (pg_locks before commit), at the strongest mode it takes.
-- Taken first, NOWAIT: a busy table fails the attempt at once and its
-- subtransaction releases what it took; the attempt is made again every
-- 100 ms for at most 5 seconds, then 55P03 (nothing applied). When this
-- transaction already holds an earlier migration's locks that stop other
-- sessions' reads or writes (the runner's dry run), one attempt and no
-- sleep: 55P03 at once, nothing applied. Indexes are locked only by planning,
-- which only a REINDEX or DROP INDEX could hold up.
--
-- Old services on this schema: today's identity-api never writes the new
-- column (null on every row it inserts, which the new CHECKs allow exactly
-- as the old ones did) and never calls the new functions; the access log
-- answers as before for every row it already shows. The identity-api of this
-- branch needs this file before it serves POST identity/patients/:id/nin.
--
-- 0. Preconditions (catalog reads only; 55000 and nothing applied).
-- 0b. Locks, NOWAIT (55P03 and nothing applied).
-- 1-5. As above.
-- 6. Post-checks.

-- 0. Preconditions.
do $$
declare
  mismatch text;
begin
  if to_regprocedure('identity.qoreid_nin_record_used(character,text)') is null
     or to_regprocedure('identity.own_facility_basis(uuid,uuid)') is null
     or to_regclass('identity.patient_search_refs') is null then
    raise exception using errcode = '55000', message = '0138: 0001-0137 must be applied first';
  end if;
  if to_regclass('identity.patient_nin_links') is not null
     or exists (select 1 from pg_attribute attribute
                 where attribute.attrelid = 'identity.patient_identifiers'::regclass
                   and attribute.attname = 'nin_link_id' and not attribute.attisdropped) then
    raise exception using errcode = '55000', message = '0138: already applied';
  end if;
  select string_agg(expected.column_name, ', ') into mismatch
    from (values
      ('patient_id', 'uuid'), ('identifier_type', 'text'), ('value_ciphertext', 'bytea'),
      ('lookup_hmac', 'character(64)'), ('encryption_key_version', 'text'), ('display_hint', 'text'),
      ('verified', 'boolean'), ('source_system', 'text'), ('registration_case_id', 'uuid'),
      ('verified_at', 'timestamp with time zone'), ('verification_provider', 'text'),
      ('verification_reference', 'text'), ('revoked_at', 'timestamp with time zone'),
      ('public_enrollment_id', 'uuid'), ('patient_self_evidence_id', 'uuid')) expected(column_name, type_name)
   where not exists (select 1 from pg_attribute attribute
                      where attribute.attrelid = 'identity.patient_identifiers'::regclass
                        and attribute.attname = expected.column_name and not attribute.attisdropped
                        and format_type(attribute.atttypid, attribute.atttypmod) = expected.type_name);
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0138: these patient identifier columns are not as 0002-0058 made them: ' || mismatch;
  end if;
  select string_agg(expected.column_name, ', ') into mismatch
    from (values ('status', 'text'), ('row_version', 'bigint'), ('updated_at', 'timestamp with time zone'))
         expected(column_name, type_name)
   where not exists (select 1 from pg_attribute attribute
                      where attribute.attrelid = 'identity.patients'::regclass
                        and attribute.attname = expected.column_name and not attribute.attisdropped
                        and format_type(attribute.atttypid, attribute.atttypmod) = expected.type_name);
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0138: these patient columns are not as 0002 made them: ' || mismatch;
  end if;
  select string_agg(expected.constraint_name, ', ') into mismatch
    from (values
      ('patient_identifiers_nin_verification_ck', '3a4392f3be07f0d61e2a024988d4c467'),
      ('patient_identifiers_registration_case_ck', '195dd02ea31014fcc8e88e90754ba20a')
    ) expected(constraint_name, definition_md5)
   where (select md5(pg_get_constraintdef(constraint_row.oid)) from pg_constraint constraint_row
           where constraint_row.conrelid = 'identity.patient_identifiers'::regclass
             and constraint_row.conname = expected.constraint_name)
         is distinct from expected.definition_md5;
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0138: these patient identifier CHECKs are not as 0058 left them: ' || mismatch;
  end if;
  select string_agg(expected.signature, ', ') into mismatch
    from (values
      ('identity.own_facility_basis(uuid,uuid)', '629709624cc0eaafb96a47b685f6a4f9'),
      ('identity.sealed_demo_facility(uuid)', 'd91d91c1d3e1a455e49c5960f313a6e7'),
      ('identity.sealed_qa_facility(uuid)', 'fe9846d94cd744bf37c3f72053d9931f'),
      ('identity.sealed_demo_patient(uuid)', '18fc6ced32fbc0803f56b4870b1de762'),
      ('identity.sealed_qa_patient(uuid)', '1728c2ed495d2255accfba6260571a97'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('auth.account_id_for_subject(text)', '4678770cf6a210034740f09422fdfbaa'),
      ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def'),
      ('identity.patient_self_access_log(text,uuid,integer,timestamptz,bigint)', '40a2511cee0c86f1d68be83e047e1ab9')
    ) expected(signature, body_md5)
   where (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0138: these bodies are not as 0001-0137 left them: ' || mismatch;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'hid_identity_runtime')
     or not exists (select 1 from pg_roles where rolname = 'hid_schema_test_runtime') then
    raise exception using errcode = '55000', message = '0138: hid_identity_runtime or hid_schema_test_runtime is missing';
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
      lock table identity.patient_identifiers
        in access exclusive mode nowait;
      lock table identity.patients, identity.facilities, identity.staff_facility_memberships, auth.accounts
        in share row exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if holding then
        raise exception using errcode = '55P03',
          message = '0138: identity.patient_identifiers, identity.patients, identity.facilities, the staff memberships or auth.accounts is busy, and this transaction already holds an earlier migration''s '
            || 'locks, so it does not wait; nothing applied; run the release again at a quieter time';
      end if;
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0138: identity.patient_identifiers, identity.patients, identity.facilities, the staff memberships or auth.accounts stayed busy for 5 seconds; nothing applied; run the release again at a '
            || 'quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
end
$locks$;

-- 1. The evidence of each link.
create table identity.patient_nin_links (
  id uuid primary key,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  membership_id uuid not null references identity.staff_facility_memberships(id) on delete restrict,
  actor_account_id uuid not null references auth.accounts(id) on delete restrict,
  nin_lookup_hmac char(64) not null check (nin_lookup_hmac ~ '^[0-9a-f]{64}$'),
  encryption_key_version text not null check (length(encryption_key_version) between 1 and 64),
  provider text not null check (provider = 'qoreid'),
  provider_reference text not null check (
    length(provider_reference) between 1 and 255
    and provider_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'),
  qoreid_called boolean not null,
  idempotency_key text not null check (length(idempotency_key) between 8 and 128
    and idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  correlation_id text not null check (
    length(correlation_id) between 8 and 128
    and correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  created_at timestamptz not null default clock_timestamp(),
  constraint patient_nin_links_idempotency_uq unique (actor_account_id, idempotency_key)
);
create index patient_nin_links_patient_idx on identity.patient_nin_links (patient_id, created_at desc);
create trigger patient_nin_links_no_mutation
  before update or delete on identity.patient_nin_links
  for each row execute function platform.reject_mutation();
alter table identity.patient_nin_links enable row level security;
revoke all on table identity.patient_nin_links from public;
comment on table identity.patient_nin_links is
  '0138 (ID-6): the evidence of a NIN linked at a facility''s desk (who, where, when, QoreID''s reference, the NIN''s lookup HMAC), and the request''s Idempotency-Key. Never the NIN. Written and read only by identity.link_patient_nin and identity.patient_nin_link_precheck.';

-- 2. A NIN row names its link.
alter table identity.patient_identifiers
  add column nin_link_id uuid,
  add constraint patient_identifiers_nin_link_id_key unique (nin_link_id),
  add constraint patient_identifiers_nin_link_fk foreign key (nin_link_id)
    references identity.patient_nin_links(id) on delete restrict,
  drop constraint patient_identifiers_nin_verification_ck,
  drop constraint patient_identifiers_registration_case_ck,
  add constraint patient_identifiers_nin_verification_ck check (
    identifier_type <> 'nin'
    or (verified and verified_at is not null
        and verification_provider is not null and length(verification_provider) between 1 and 100
        and verification_reference is not null and length(verification_reference) between 1 and 255
        and num_nonnulls(registration_case_id, public_enrollment_id, patient_self_evidence_id, nin_link_id) = 1)),
  add constraint patient_identifiers_registration_case_ck check (
    (identifier_type = 'nin'
     and num_nonnulls(registration_case_id, public_enrollment_id, patient_self_evidence_id, nin_link_id) = 1)
    or (identifier_type <> 'nin' and registration_case_id is null and public_enrollment_id is null
        and patient_self_evidence_id is null and nin_link_id is null));
comment on column identity.patient_identifiers.nin_link_id is
  '0138 (ID-6): the desk link (identity.patient_nin_links) this verified NIN came from.';

-- 3. Before QoreID is asked.
create function identity.patient_nin_link_precheck(
  requested_patient_id uuid, requested_lookup_hmac char(64),
  requested_idempotency_key text, requested_request_sha256 char(64)
) returns table (decision text, first_name text, last_name text, date_of_birth date)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  actor_subject text := platform.current_actor_subject();
  actor_account uuid := auth.account_id_for_subject(actor_subject);
  actor_membership uuid := platform.current_membership_id();
  actor_facility uuid := platform.current_facility_id();
  patient_value uuid;
  stored_sha256 char(64);
  stored_patient uuid;
  existing_hmac char(64);
begin
  if actor_account is null or actor_membership is null or actor_facility is null
     or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not exists (select 1 from identity.staff_facility_memberships membership
                     where membership.id = actor_membership and membership.account_id = actor_account
                       and membership.facility_id = actor_facility and membership.active
                       and membership.migration_hold_reason is null)
     or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility,
                                           'identity.registration.write') then
    raise exception using errcode = '42501', message = 'NIN_LINK_DENIED';
  end if;
  if requested_patient_id is null or requested_lookup_hmac is null or requested_lookup_hmac !~ '^[0-9a-f]{64}$'
     or requested_idempotency_key is null
     or requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
     or requested_request_sha256 is null or requested_request_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'NIN_LINK_INVALID';
  end if;
  select link.request_sha256, link.patient_id into stored_sha256, stored_patient
    from identity.patient_nin_links link
   where link.actor_account_id = actor_account and link.idempotency_key = requested_idempotency_key;
  if found then
    return query select case when stored_sha256 = requested_request_sha256 and stored_patient = requested_patient_id
                             then 'replay' else 'key_reused' end, null::text, null::text, null::date;
    return;
  end if;
  select patient.id into patient_value
    from identity.patients patient
   where patient.id = requested_patient_id and patient.status = 'active'
     and identity.sealed_demo_facility(actor_facility) = identity.sealed_demo_patient(patient.id)
     and identity.sealed_qa_facility(actor_facility) = identity.sealed_qa_patient(patient.id);
  if patient_value is null then
    return query select 'not_found'::text, null::text, null::text, null::date;
    return;
  end if;
  if identity.own_facility_basis(patient_value, actor_facility) is null then
    return query select 'not_permitted'::text, null::text, null::text, null::date;
    return;
  end if;
  select identifier.lookup_hmac into existing_hmac
    from identity.patient_identifiers identifier
   where identifier.patient_id = patient_value and identifier.identifier_type = 'nin'
     and identifier.verified and identifier.revoked_at is null
   order by identifier.lookup_hmac = requested_lookup_hmac desc
   limit 1;
  if existing_hmac is not null then
    return query select case when existing_hmac = requested_lookup_hmac then 'already_linked' else 'has_nin' end,
                        null::text, null::text, null::date;
    return;
  end if;
  -- Eligible: the record's name and date of birth, which identity-api
  -- compares with the NIN record (either order, as the patient's own check).
  return query select 'eligible'::text, patient.first_name, patient.last_name, patient.dob
    from identity.patients patient where patient.id = patient_value;
end;
$$;
revoke all on function identity.patient_nin_link_precheck(uuid, char, text, char) from public;
grant execute on function identity.patient_nin_link_precheck(uuid, char, text, char)
  to hid_identity_runtime, hid_schema_test_runtime;
comment on function identity.patient_nin_link_precheck(uuid, char, text, char) is
  '0138 (ID-6): what POST identity/patients/:id/nin may do before QoreID is asked: not_found, not_permitted, already_linked, has_nin, replay, key_reused, or eligible with the record''s name and date of birth (compared with the NIN record by identity-api).';

-- 4. The link.
create function identity.link_patient_nin(
  requested_patient_id uuid, requested_link_id uuid, requested_lookup_hmac char(64),
  requested_nin_ciphertext bytea, requested_key_version text, requested_last4 char(4),
  requested_provider_reference text, requested_qoreid_called boolean,
  requested_idempotency_key text, requested_request_sha256 char(64)
) returns table (outcome text, other_patient_id uuid)
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
  patient_value uuid;
  existing_hmac char(64);
  other_value uuid;
  stored_sha256 char(64);
  stored_patient uuid;
  verified_at_value timestamptz;
begin
  select membership.organization_id into actor_organization
    from identity.staff_facility_memberships membership
   where membership.id = actor_membership and membership.account_id = actor_account
     and membership.facility_id = actor_facility and membership.active
     and membership.migration_hold_reason is null;
  if actor_account is null or actor_membership is null or actor_facility is null or actor_correlation is null
     or actor_organization is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not auth.membership_has_permission(actor_subject, actor_membership, actor_facility,
                                           'identity.registration.write') then
    raise exception using errcode = '42501', message = 'NIN_LINK_DENIED';
  end if;
  if requested_patient_id is null or requested_link_id is null
     or requested_lookup_hmac is null or requested_lookup_hmac !~ '^[0-9a-f]{64}$'
     or requested_nin_ciphertext is null or octet_length(requested_nin_ciphertext) < 30
     or requested_key_version is null or length(requested_key_version) not between 1 and 64
     or requested_last4 is null or requested_last4 !~ '^[0-9]{4}$'
     or requested_provider_reference is null
     or requested_provider_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
     or requested_qoreid_called is null
     or requested_idempotency_key is null
     or requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
     or requested_request_sha256 is null or requested_request_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'NIN_LINK_INVALID';
  end if;
  -- 0058's lock on the NIN: a desk link and the patient's own binding of the
  -- same NIN, and two desks linking it, wait for each other.
  perform pg_advisory_xact_lock(hashtextextended('patient-nin:' || requested_lookup_hmac, 0));
  select link.request_sha256, link.patient_id into stored_sha256, stored_patient
    from identity.patient_nin_links link
   where link.actor_account_id = actor_account and link.idempotency_key = requested_idempotency_key;
  if found then
    return query select case when stored_sha256 = requested_request_sha256 and stored_patient = requested_patient_id
                             then 'replay' else 'key_reused' end, null::uuid;
    return;
  end if;
  select patient.id into patient_value
    from identity.patients patient
   where patient.id = requested_patient_id and patient.status = 'active'
     and identity.sealed_demo_facility(actor_facility) = identity.sealed_demo_patient(patient.id)
     and identity.sealed_qa_facility(actor_facility) = identity.sealed_qa_patient(patient.id)
     for update;
  if patient_value is null then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;
  if identity.own_facility_basis(patient_value, actor_facility) is null then
    return query select 'not_permitted'::text, null::uuid;
    return;
  end if;
  select identifier.lookup_hmac into existing_hmac
    from identity.patient_identifiers identifier
   where identifier.patient_id = patient_value and identifier.identifier_type = 'nin'
     and identifier.verified and identifier.revoked_at is null
   order by identifier.lookup_hmac = requested_lookup_hmac desc
   limit 1;
  if existing_hmac is not null then
    return query select case when existing_hmac = requested_lookup_hmac then 'already_linked' else 'has_nin' end,
                        null::uuid;
    return;
  end if;
  -- Any NIN row of this HMAC, revoked or not, holds the NIN (the unique index
  -- patient_identifiers_lookup_uq covers them all).
  select identifier.patient_id into other_value
    from identity.patient_identifiers identifier
   where identifier.identifier_type = 'nin' and identifier.lookup_hmac = requested_lookup_hmac
   limit 1;
  if other_value is not null then
    return query select 'on_another_record'::text, other_value;
    return;
  end if;
  verified_at_value := clock_timestamp();
  insert into identity.patient_nin_links (
    id, patient_id, facility_id, membership_id, actor_account_id, nin_lookup_hmac, encryption_key_version,
    provider, provider_reference, qoreid_called, idempotency_key, request_sha256, correlation_id, created_at
  ) values (
    requested_link_id, patient_value, actor_facility, actor_membership, actor_account, requested_lookup_hmac,
    requested_key_version, 'qoreid', requested_provider_reference, requested_qoreid_called,
    requested_idempotency_key, requested_request_sha256, actor_correlation, verified_at_value
  );
  insert into identity.patient_identifiers (
    id, patient_id, identifier_type, value_ciphertext, lookup_hmac, encryption_key_version, display_hint,
    verified, source_system, verified_at, verification_provider, verification_reference, nin_link_id
  ) values (
    gen_random_uuid(), patient_value, 'nin', requested_nin_ciphertext, requested_lookup_hmac,
    requested_key_version, requested_last4, true, 'hid-desk-nin-link', verified_at_value, 'qoreid',
    requested_provider_reference, requested_link_id
  );
  update identity.patients patient
     set row_version = patient.row_version + 1, updated_at = verified_at_value
   where patient.id = patient_value;
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id, organization_id,
    facility_id, patient_id, action, resource_type, resource_id, outcome, purpose_of_use, provenance,
    source_system, details
  ) values (
    actor_correlation, 'staff', actor_subject, actor_account, actor_membership, actor_organization,
    actor_facility, patient_value, 'identity.patient.nin-link', 'patient', patient_value::text, 'success',
    'healthcare-operations', 'application', 'identity-api',
    jsonb_build_object('outcome', 'nin_linked', 'qoreidCalled', requested_qoreid_called,
                       'linkId', requested_link_id)
  );
  return query select 'nin_linked'::text, null::uuid;
end;
$$;
revoke all on function identity.link_patient_nin(uuid, uuid, char, bytea, text, char, text, boolean, text, char)
  from public;
grant execute on function identity.link_patient_nin(uuid, uuid, char, bytea, text, char, text, boolean, text, char)
  to hid_identity_runtime, hid_schema_test_runtime;
comment on function identity.link_patient_nin(uuid, uuid, char, bytea, text, char, text, boolean, text, char) is
  '0138 (ID-6): link a QoreID-checked NIN to this facility''s own patient: nin_linked, or not_found, not_permitted, already_linked, has_nin, on_another_record (with the other record, for the audit row only), replay or key_reused.';

-- 5. The patient's access log: 0132's text plus nin_added.
create or replace function identity.patient_self_access_log(
  requested_subject text, requested_session uuid, requested_limit integer,
  before_occurred_at timestamptz, before_sequence_id bigint
) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
  bounded_limit integer := least(greatest(coalesce(requested_limit, 50), 1), 100);
  scan_cap constant integer := 2000;
  scanned integer;
  oldest_cursor text;
  all_islands jsonb;
  island_count integer;
  take_count integer;
  next_cursor jsonb;
  entries jsonb;
begin
  if patient_id_value is null then return null; end if;
  if (before_occurred_at is null) <> (before_sequence_id is null) then
    raise exception using errcode = '22023', message = 'ACCESS_LOG_CURSOR_INVALID';
  end if;
  with raw as materialized (
    select event.sequence_id, event.event_id, event.occurred_at, event.action, event.outcome,
           event.provenance, event.actor_type, event.actor_account_id, event.actor_membership_id,
           event.facility_id,
           -- 0138: a desk link's outcome (nin_linked, or already_linked).
           case when event.action = 'identity.patient.nin-link' then event.details ->> 'outcome' end as link_outcome
      from audit.events event
     where event.patient_id = patient_id_value
       and (before_occurred_at is null
         or (event.occurred_at, event.sequence_id) < (before_occurred_at, before_sequence_id))
     order by event.occurred_at desc, event.sequence_id desc
     limit scan_cap
  ), classified as materialized (
    -- Materialized, so that each row's kind is computed once.
    select raw.*, kinds.kind
      from raw
      cross join lateral (select case
        when raw.outcome <> 'success' or raw.provenance <> 'application' then null
        -- The interceptor's rows and the authorization checks, most of a
        -- chart's rows, without a regular expression.
        when raw.action like 'api.%' or raw.action like '%.request'
          or raw.action = 'identity.authorization.check' then null
        when raw.actor_type = 'staff' and raw.action = 'identity.break-glass.activate' then 'emergency_access'
        -- 0132 (owner Q104 of 18 November 2026): "Found in an emergency search at <facility>".
        when raw.actor_type = 'staff' and raw.action = 'identity.patient.emergency-search.shown'
          then 'found_in_emergency_search'
        -- 0138 (ID-6): "NIN added at <facility>", when a desk linked the NIN.
        when raw.actor_type = 'staff' and raw.action = 'identity.patient.nin-link'
          and raw.link_outcome = 'nin_linked' then 'nin_added'
        when raw.actor_type = 'patient' and raw.action = 'identity.access-request.approve' then 'access_granted'
        when raw.actor_type = 'staff' and raw.action = 'identity.patient-access-pin.verify' then 'access_granted'
        when raw.actor_type = 'staff' and raw.action = 'identity.consent-grant.close' then 'access_ended'
        when raw.actor_type = 'patient' and raw.action = 'identity.consent-grant.patient-revoke' then 'access_ended'
        when raw.actor_type not in ('staff', 'system', 'workload') then null
        when raw.action ~ ('^(ehr\.((encounter|note|note-revision|vital|vital-correction|diagnosis|prescription'
            || '|lab-request)\.(create|update)|note\.import-ocr|document\.upload\.complete'
            || '|order-route\.(send|withdraw))'
            || '|lab\.(result\.(enter|correct|verify|release|revise-released|entered-in-error)'
            || '|specimen\.(collect|receive|reject)|accession\.create|execution\.(start|complete)'
            || '|import\.create|imported-evidence\.create|work-item\.accept'
            || '|order-route\.(cannot-complete|wrong-patient|wrong-patient-correction))'
            || '|pharmacy\.(dispensing\.(create|reverse)|import\.create|imported-medication-evidence\.create'
            || '|work-item\.accept|order-route\.(cannot-complete|wrong-patient|wrong-patient-correction)))$')
          then 'changed'
        when raw.action ~ ('^(ehr\.((encounter|note|note-revision|vital|vital-correction|diagnosis|prescription'
            || '|lab-request|document|order-route)\.(read|list)|document\.(download|ocr-source\.read)'
            || '|imported\.records\.read|emergency\.records\.read'
            || '|imported\.attachment\.download|staff\.chat\.evidence\.read|record\.read)'
            || '|identity\.(patient\.lookup|staff\.chat\.profile\.read)'
            || '|lab\.((work-item|accession|execution|import)\.(read|list)|result\.(history|released)\.read'
            || '|staff\.chat\.released-results\.read|order-route\.(read|accept))'
            || '|pharmacy\.((work-item|dispensing|import)\.(read|list)|order-route\.(read|accept))'
            || '|ocr\.(job\.read|(extraction|validation|publication)\.list))$')
          then 'viewed'
      end as kind) kinds
     where kinds.kind is not null
  ), flagged as (
    select classified.*,
      case when classified.kind in ('viewed', 'changed')
            and lag(classified.kind) over ordered = classified.kind
            and lag(classified.actor_type) over ordered = classified.actor_type
            and lag(classified.actor_account_id) over ordered is not distinct from classified.actor_account_id
            and lag(classified.facility_id) over ordered is not distinct from classified.facility_id
            and lag(classified.occurred_at) over ordered - classified.occurred_at < interval '10 minutes'
           then 0 else 1 end as starts_island
      from classified
    window ordered as (order by classified.occurred_at desc, classified.sequence_id desc)
  ), numbered as (
    select flagged.*,
      sum(flagged.starts_island) over (order by flagged.occurred_at desc, flagged.sequence_id desc
        rows unbounded preceding) as island
      from flagged
  ), islands as (
    select numbered.island,
      (array_agg(numbered.event_id order by numbered.occurred_at desc, numbered.sequence_id desc))[1] as event_id,
      max(numbered.occurred_at) as newest_at,
      (array_agg(numbered.occurred_at order by numbered.occurred_at, numbered.sequence_id))[1] as oldest_at,
      (array_agg(numbered.sequence_id order by numbered.occurred_at, numbered.sequence_id))[1] as oldest_sequence,
      (array_agg(numbered.kind order by numbered.occurred_at desc, numbered.sequence_id desc))[1] as kind,
      (array_agg(numbered.actor_type order by numbered.occurred_at desc, numbered.sequence_id desc))[1] as actor_type,
      (array_agg(numbered.actor_membership_id order by numbered.occurred_at desc, numbered.sequence_id desc))[1]
        as actor_membership_id,
      (array_agg(numbered.facility_id order by numbered.occurred_at desc, numbered.sequence_id desc))[1] as facility_id
      from numbered
     group by numbered.island
  )
  select (select count(*) from raw),
         (select to_char(raw.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || raw.sequence_id
            from raw order by raw.occurred_at, raw.sequence_id limit 1),
         coalesce((select jsonb_agg(jsonb_build_object(
              'id', islands.event_id::text,
              'at', to_char(islands.newest_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'action', islands.kind,
              'actorKind', case
                when islands.actor_type = 'patient' then 'patient'
                when islands.actor_type = 'staff' and islands.actor_membership_id is not null then 'clinician'
                when islands.actor_type = 'staff' then 'support'
                when islands.facility_id is not null then 'facility'
                else 'system' end,
              'membership', case when islands.actor_type = 'staff' then islands.actor_membership_id end,
              'facility', islands.facility_id,
              'cursor', to_char(islands.oldest_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                || '|' || islands.oldest_sequence)
            order by islands.island) from islands), '[]'::jsonb)
    into scanned, oldest_cursor, all_islands;
  island_count := jsonb_array_length(all_islands);
  -- An entry is complete once an older entry follows it in the rows read,
  -- or once every row was read.
  if island_count > bounded_limit then
    take_count := bounded_limit;
    next_cursor := to_jsonb(all_islands -> (take_count - 1) ->> 'cursor');
  elsif scanned >= scan_cap then
    take_count := case when island_count > 1 then island_count - 1 else island_count end;
    next_cursor := case when take_count >= 1 and take_count < island_count
      then to_jsonb(all_islands -> (take_count - 1) ->> 'cursor') else to_jsonb(oldest_cursor) end;
  else
    take_count := island_count;
    next_cursor := null;
  end if;
  -- Names only for the entries returned: the clinician's (staff record of
  -- the membership the row names) and the facility's.
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', element.value->>'id', 'at', element.value->>'at', 'action', element.value->>'action',
      'actorKind', element.value->>'actorKind',
      'actorName', case when element.value->>'actorKind' = 'clinician' then (
        select staff_record.full_name
          from identity.staff_facility_memberships membership
          join identity.staff staff_record on staff_record.id = membership.staff_id
         where membership.id = (element.value->>'membership')::uuid) end,
      'facilityName', (select facility.name from identity.facilities facility
                        where facility.id = (element.value->>'facility')::uuid))
      order by element.ordinality), '[]'::jsonb) into entries
    from jsonb_array_elements(all_islands) with ordinality element(value, ordinality)
   where element.ordinality <= take_count;
  return jsonb_build_object('events', entries, 'next', case when next_cursor is null then null else
    jsonb_build_object('occurredAt', split_part(next_cursor #>> '{}', '|', 1),
                       'sequenceId', split_part(next_cursor #>> '{}', '|', 2)::bigint) end);
end
$$;

comment on function identity.patient_self_access_log(text,uuid,integer,timestamptz,bigint) is
  '0093, 0132, 0138: who viewed or changed the live patient session''s record, newest first, from its successful audit events; since 0132 also each emergency search that found the patient (found_in_emergency_search, owner Q104), and since 0138 each NIN a facility''s desk linked (nin_added, ID-6); no record contents.';

-- 6. Post-checks.
do $$
declare
  offender text;
begin
  if (select relrowsecurity from pg_class where oid = 'identity.patient_nin_links'::regclass) is not true
     or exists (select 1 from pg_policy where polrelid = 'identity.patient_nin_links'::regclass)
     or (select relowner from pg_class where oid = 'identity.patient_nin_links'::regclass)
        <> (select oid from pg_roles where rolname = current_user) then
    raise exception using errcode = '55000', message = '0138: identity.patient_nin_links is not as created';
  end if;
  select string_agg(grantee.rolname || ' ' || privilege.privilege_type, ', ') into offender
    from pg_class relation
    cross join lateral aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) privilege
    join pg_roles grantee on grantee.oid = privilege.grantee
   where relation.oid = 'identity.patient_nin_links'::regclass and privilege.grantee <> relation.relowner;
  if offender is not null then
    raise exception using errcode = '55000', message = format('0138: a role holds a privilege on the table: %s', offender);
  end if;
  select string_agg(signature, ', ') into offender
    from (values ('identity.patient_nin_link_precheck(uuid,character,text,character)'),
                 ('identity.link_patient_nin(uuid,uuid,character,bytea,text,character,text,boolean,text,character)'),
                 ('identity.patient_self_access_log(text,uuid,integer,timestamp with time zone,bigint)')) expected(signature)
    join pg_proc proc on proc.oid = to_regprocedure(expected.signature)
   where not proc.prosecdef or proc.proowner <> (select oid from pg_roles where rolname = current_user)
      or proc.proconfig is distinct from array['search_path=pg_catalog, pg_temp'];
  if offender is not null
     or to_regprocedure('identity.patient_nin_link_precheck(uuid,character,text,character)') is null
     or to_regprocedure('identity.link_patient_nin(uuid,uuid,character,bytea,text,character,text,boolean,text,character)') is null then
    raise exception using errcode = '55000', message = format('0138: a function is not as created: %s', offender);
  end if;
  select string_agg(grantee.rolname || ' ' || proc.proname, ', ') into offender
    from pg_proc proc
    cross join lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) privilege
    join pg_roles grantee on grantee.oid = privilege.grantee
   where proc.oid in (to_regprocedure('identity.patient_nin_link_precheck(uuid,character,text,character)'),
                      to_regprocedure('identity.link_patient_nin(uuid,uuid,character,bytea,text,character,text,boolean,text,character)'))
     and privilege.privilege_type = 'EXECUTE' and privilege.grantee <> proc.proowner
     and grantee.rolname not in ('hid_identity_runtime', 'hid_schema_test_runtime');
  if offender is not null then
    raise exception using errcode = '55000', message = format('0138: a role may execute a function it must not: %s', offender);
  end if;
end
$$;
