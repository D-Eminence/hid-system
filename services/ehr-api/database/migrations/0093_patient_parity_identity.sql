-- 0093 Patient parity with hid-1.0: identity (owner decisions of 2026-10-28;
-- migrations pre-approved for this batch, the declaration signed separately).
--
-- A patient signs in and resets the password with an email, a Health ID or a
-- phone number; a migrated hid-1.0 patient is found by Health ID and phone
-- too; Google signs in a registered patient whose verified Google email is
-- exactly one patient's verified email; the patient sees security notices,
-- an unread count and who viewed or changed the record. Identity's runtime
-- reads identity.patients only through RLS, which lets system:auth see
-- patients from public enrollment alone (0051), so every lookup that must
-- also find a migrated patient (source_system legacy_identity) is a SECURITY
-- DEFINER function here.
--
-- 0. Preconditions (catalog reads only): every prerequisite exists; no
--    object of this migration exists under any signature (else 55000
--    "0093: already applied"); the two bodies replaced below and the 17
--    bodies the new ones call or rely on are byte for byte the ones measured
--    on 0001-0092 (md5 of pg_proc.prosrc); the inbox's code, resource type
--    and metadata CHECKs, the audit index the access log reads and the
--    patients' unique Health ID and phone indexes are as 0002, 0003 and 0037
--    made them; the applying role, which will own every new function, holds
--    (by ownership, membership or grant, never a superuser's bypass) what
--    the new bodies read, write and call, including ownership of
--    identity.patients (so its RLS does not hide migrated patients from
--    them), and the owner of each replaced function may run what its new
--    body calls. Every attribute of the two replaced functions but the body
--    is recorded and compared after the replacement (section 9).
-- 1. auth.find_patient_account(kind, value): system:auth only. 'hid' (a
--    Health ID, any case), 'phone' (the phone's contact lookup HMAC, as
--    identity.patients.phone_lookup_hmac holds it for sign-up, NIN-route and
--    migrated patients alike; or two HMACs, comma separated: a Nigerian
--    number's +234... and +2340... forms, because hid-1.0 kept a trunk 0
--    typed after +234 and the importer kept it too) or 'account' (an account
--    id). The phone is compared as char(64), the column's type, so that
--    patients_phone_hmac_uq answers it. The account of the one active
--    patient found, any account status but deleted, with what
--    patient sign-in needs (the password hash for 'hid' and 'phone' only),
--    whether the account is a workforce account (any role, staff record or
--    facility membership), whether its email is verified, and the patient's
--    first name and Health ID for the reset emails. Nothing when no patient
--    or more than one account matches (across both forms of a phone too).
--    Replaces Identity's direct HID query, which RLS limited to
--    public-enrollment patients.
-- 2. auth.patient_email_registered(email, email HMAC): system:auth only;
--    whether a non-deleted patient account uses the email (account email or
--    patient contact email). Google sign-up answers GOOGLE_ACCOUNT_EXISTS.
-- 3. auth.link_google_identity_by_verified_email(subject, email, email
--    HMAC): system:auth only. A Google subject already linked answers
--    'suspended' when its account is a suspended patient account, else
--    'already_linked'. Otherwise, under an advisory lock on the email: the
--    active patients whose account (not deleted) has that email or whose
--    contact email HMAC is that one, as two index lookups (accounts_email_ci_uq,
--    patients_email_hmac_uq) unioned; none 'none', two or more 'ambiguous';
--    for the one: a workforce account 'workforce' (never linked), an email
--    that is not the account's verified email 'not_verified', a suspended
--    account 'suspended', any other inactive account 'not_verified', another
--    active Google subject on the account 'linked_elsewhere'; else the link
--    (auth.external_identities, source_system
--    'hid-google-verified-email-link'), an audit row 'auth.google.auto-link'
--    and the inbox notice SECURITY_GOOGLE_LINKED, all in the caller's
--    transaction, answering 'linked' with the account. The account and the
--    patient are locked FOR UPDATE, in 0059's order, as the explicit link
--    does; unique (issuer, subject) settles a concurrent link
--    ('already_linked').
-- 4. auth.record_account_security_notice(account, code): system:auth only.
--    SECURITY_PASSWORD_RESET_REQUESTED, SECURITY_PASSWORD_CHANGED or
--    SECURITY_GOOGLE_LINKED (resource type 'account', no resource id, empty
--    metadata: no PHI, no secret) for the account's active patient, only
--    with the evidence written in the last 10 minutes (an open recovery
--    challenge; password_changed_at; an active Google link), once per
--    evidence, and a reset request at most once an hour. Anything else
--    (unknown code, no patient, a deleted account, no evidence) answers
--    null and never raises, so a sign-in or a reset never fails for a notice.
-- 5. identity.count_my_unread_notifications(subject, session): the patient
--    session's unread inbox items plus unread imported hid-1.0
--    notifications, each counted up to 1000, at most 1000 in all; null
--    without a live patient session.
-- 6. identity.patient_self_access_log(subject, session, limit, before):
--    newest first, the patient's own successful application audit events
--    that record a clinician (or a facility's system) viewing or changing
--    the record (among them document downloads and OCR source reads, OCR
--    reads, routed orders sent, withdrawn, read, accepted and settled by the
--    receiving laboratory or pharmacy, and work items accepted), a grant of
--    access (the patient's approval, a clinician's
--    use of the Access PIN), an end of access (the clinician's close, the
--    patient's revoke) and emergency access, from audit.events through
--    audit_patient_time_idx; refused and failed attempts, interceptor rows,
--    authorization checks, replays, the patient's own reads, legacy and
--    migration rows are left out. Consecutive views (or changes) by the same
--    person at the same facility less than 10 minutes apart are one entry at
--    the latest time. Each entry: id (the latest event's id), at, action
--    (viewed, changed, access_granted, access_ended, emergency_access),
--    actorKind (clinician, facility, patient, support, system), actorName
--    (the clinician's name) and facilityName; never a record, a resource
--    id, a reason, an address or a user agent. At most 2000 audit rows are
--    read per call; next is the keyset (occurred_at, sequence_id) to
--    continue from, or null. Null without a live patient session.
-- 7. identity.activate_public_patient_signup (0092), replaced: 0092's body
--    byte for byte but the profile phone rule, '^\+234[0-9]{10}$' becomes
--    '^\+[1-9][0-9]{6,14}$' (E.164 of any country, 7-15 digits). Identity
--    still stores a Nigerian local number as +234; an old Identity image
--    only ever sends +234 numbers, which the new rule admits.
-- 8. identity.close_own_consent_grant (0010), replaced: 0010's body plus
--    one step: when the clinician ends an active grant before it expires
--    (not a replay), the patient gets CONSENT_GRANT_ENDED_BY_CLINICIAN
--    (resource type 'consent-grant', the grant's id, metadata facilityName
--    only; never the clinician's reason). Its answer, audit row and refusals
--    are unchanged.
-- 9. Post-checks: the replaced functions keep their owner, ACL, language,
--    volatility, SECURITY DEFINER and search_path, and their bodies are the
--    ones this file gives them; every new function belongs to the applying
--    role.
-- 10. Grants, here and in runtime-grants.sql: the six new functions to
--    hid_identity_runtime and hid_schema_test_runtime (revoked from PUBLIC);
--    the two replaced functions keep their ACLs (CREATE OR REPLACE).
--
-- Locks: none on any application table and none on any existing function.
-- No table, index, CHECK or trigger is created or altered, so the
-- convention's NOWAIT loop has no table to take. Every new and replaced body
-- is PL/pgSQL, so creating it reads no table; section 0 reads catalogs only.
-- Measured with pg_locks before commit (the file applied in an open
-- transaction): ACCESS SHARE on the auth and identity schemas, the plpgsql
-- language and the two runtime roles (the grants); SHARE UPDATE EXCLUSIVE on
-- the six new functions (their comments); ACCESS EXCLUSIVE on section 0's own
-- temporary table and helper and the session's temporary schema; the
-- catalogs' own locks. Replacing a function neither waits for nor blocks its
-- calls. Any catalog wait is bounded by the runner's lock_timeout (5
-- seconds), and the release then stops with nothing applied. The apply took
-- 27 ms on a copy migrated through 0092.
--
-- Old services on this schema: every change is additive. The previous
-- Identity image calls none of the new functions; its direct HID query
-- still finds public-enrollment patients only, as before; its sign-up
-- sends +234 numbers, which the replaced activation admits; a clinician's
-- close answers as before (one more inbox row the old website shows with its
-- generic title). Applied migrations 0001 through 0092 are immutable.

-- 0. Preconditions. Whether holder holds a privilege on an object by
-- ownership, membership (direct or through other roles) or grant (also to
-- PUBLIC), ignoring a superuser's bypass (0090's and 0091's helper).
create function pg_temp.parity_0093_holds(holder oid, object_owner oid, object_acl aclitem[],
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

create temporary table parity_0093_replaced as
  select proc.oid, proc.oid::regprocedure::text as what, proc.proowner, proc.proacl, proc.prolang,
         proc.provolatile, proc.prosecdef, proc.proconfig, proc.prorettype, proc.proretset,
         proc.proargnames, proc.proallargtypes
    from pg_proc proc
   where proc.oid in (to_regprocedure('identity.activate_public_patient_signup(uuid,char,text,text,text,text,char)'),
                      to_regprocedure('identity.close_own_consent_grant(uuid,text)'));

do $$
declare
  mismatch text;
  applier oid := (select oid from pg_roles where rolname = current_user);
begin
  -- a. Prerequisites.
  if to_regclass('notification.inbox_items') is null
     or to_regclass('notification.imported_inbox_items') is null
     or to_regclass('notification.imported_inbox_reads') is null
     or to_regclass('audit.events') is null
     or to_regclass('auth.external_identities') is null
     or to_regclass('auth.otp_challenges') is null
     or to_regclass('identity.public_patient_enrollments') is null
     or to_regprocedure('identity.activate_public_patient_signup(uuid,char,text,text,text,text,char)') is null
     or to_regprocedure('identity.close_own_consent_grant(uuid,text)') is null
     or to_regprocedure('notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)') is null
     or to_regprocedure('identity.patient_self_session(text,uuid)') is null then
    raise exception using errcode = '55000', message = '0093: 0001-0092 must be applied first';
  end if;
  -- b. Not applied yet, under any signature.
  if exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
              where (namespace.nspname, proc.proname) in (
                ('auth', 'find_patient_account'), ('auth', 'patient_email_registered'),
                ('auth', 'link_google_identity_by_verified_email'), ('auth', 'record_account_security_notice'),
                ('identity', 'count_my_unread_notifications'), ('identity', 'patient_self_access_log'))) then
    raise exception using errcode = '55000', message = '0093: already applied';
  end if;
  -- c. The bodies replaced (sections 7 and 8), as 0092 and 0010 left them.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('identity.activate_public_patient_signup(uuid,char,text,text,text,text,char)', 'bd9190beca14e04b46eb3399910dcd73'),
      ('identity.close_own_consent_grant(uuid,text)', '16b9fd3d2fe5d6f803d532e1dd0f91a7'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0093: a function this migration replaces has another body than 0001-0092 gave it: %s', mismatch);
  end if;
  -- d. The bodies the new and replaced ones call or rely on, unchanged: the
  -- actor and session readers, the inbox writer and readers, the Google
  -- resolver and explicit link (whose rules the automatic link mirrors), the
  -- recovery completion (the evidence of a changed password), the contact
  -- readiness and binding checks the sign-up activation calls, the
  -- membership check the close calls, and the audit table's triggers.
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none (missing)')), '; ')
    into mismatch
    from (values
      ('platform.current_actor_subject()', 'cf14c2d4a16d44a79ea9dbef9dc79c2b'),
      ('platform.current_correlation_id()', '48d3bf187101d33bfda51dac829aa223'),
      ('platform.current_account_id()', 'b715ffe72856836d13ab16656fa6e94a'),
      ('auth.account_id_for_subject(text)', '4678770cf6a210034740f09422fdfbaa'),
      ('identity.patient_self_session(text,uuid)', 'd4c7aeaf25317d0fae794a2764d7d72b'),
      ('notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)', '0b5689f31a3ce00f9313fe1e55244fad'),
      ('identity.list_my_notification_inbox(integer)', '7ac88e8722c52d5951cfb1f7d84313e0'),
      ('identity.list_my_imported_notifications(integer,integer)', 'e726978866795ea422e7b284d0319deb'),
      ('auth.resolve_google_identity(text)', 'a6a76f7789c33702071ed3716779afe9'),
      ('auth.link_google_identity_to_patient_account(uuid,text)', '5ff52c21d7b4fd6635d9a6692432601c'),
      ('auth.complete_recovery_otp(uuid,text,text,text)', '42664ddffa923bab2eb9de6f42456a82'),
      ('identity.patient_contact_lookup_ready()', 'd6838ccecab98c38059e66e04ad75cea'),
      ('identity.public_patient_contact_already_bound(text,char)', '85a6bec81c3b4769b3a3ec5d60ffbc5e'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('audit.authorize_platform_event()', '41e4102669ab23df53ac4d73badc8a8c'),
      ('platform.reject_mutation()', '398738f39f6eebed2c54da5009495def'),
      ('identity.current_patient_account(text)', '6c264821fe696a8c4c06667e4179b4c3'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0093: a function this migration relies on has another body than 0001-0092 gave it: %s', mismatch);
  end if;
  -- e. The inbox's CHECKs (0037) the new codes and resource types must
  -- pass, the audit index the access log reads (0003) and the unique
  -- Health ID and phone indexes the lookup relies on (0002).
  select string_agg(format('%s: %s', expected.what, coalesce(actual.definition, 'missing')), '; ')
    into mismatch
    from (values
      ('inbox_items_notification_code_check', $c$CHECK ((notification_code ~ '^[A-Z][A-Z0-9_]{2,79}$'::text))$c$),
      ('inbox_items_resource_type_check',
       $c$CHECK (((resource_type IS NULL) OR (resource_type ~ '^[a-z][a-z0-9._:-]{1,63}$'::text)))$c$),
      ('inbox_items_metadata_check', $c$CHECK ((jsonb_typeof(metadata) = 'object'::text))$c$),
      ('audit_patient_time_idx',
       'CREATE INDEX audit_patient_time_idx ON audit.events USING btree (patient_id, occurred_at DESC) WHERE (patient_id IS NOT NULL)'),
      ('patients_hid_code_ci_uq',
       'CREATE UNIQUE INDEX patients_hid_code_ci_uq ON identity.patients USING btree (upper(hid_code))'),
      ('patients_phone_hmac_uq',
       'CREATE UNIQUE INDEX patients_phone_hmac_uq ON identity.patients USING btree (phone_lookup_hmac) WHERE (phone_lookup_hmac IS NOT NULL)'))
         expected(what, definition)
    left join (
      select constraint_row.conname::text as what, pg_get_constraintdef(constraint_row.oid) as definition
        from pg_constraint constraint_row
       where constraint_row.conrelid = 'notification.inbox_items'::regclass and constraint_row.contype = 'c'
      union all
      select index_class.relname::text, pg_get_indexdef(index_class.oid)
        from pg_class index_class
       where index_class.oid in (to_regclass('audit.audit_patient_time_idx'),
                                 to_regclass('identity.patients_hid_code_ci_uq'),
                                 to_regclass('identity.patients_phone_hmac_uq'))) actual
      on actual.what = expected.what
   where actual.definition is distinct from expected.definition;
  if mismatch is not null then
    raise exception using errcode = '55000',
      message = format('0093: a CHECK or index this migration relies on differs from 0001-0092: %s', mismatch);
  end if;
  -- f. Privileges, never through a superuser's bypass (production's
  -- migrator has none). The applying role owns every new function: it must
  -- own identity.patients (through membership too) so that RLS does not hide
  -- migrated patients from them, read and write what they read and write,
  -- and run what they call; it must also be able to replace the two bodies
  -- (own them), and each replaced function's owner must run and read what
  -- its new body adds.
  select string_agg(missing.what, '; ') into mismatch
    from (
      select format('%s lacks %s on %s', holder.rolname, wanted.privilege, relation.oid::regclass) as what
        from (values
          ('identity.patients', 'OWNER'), ('auth.accounts', 'SELECT'), ('auth.account_roles', 'SELECT'),
          ('identity.staff', 'SELECT'), ('identity.staff_facility_memberships', 'SELECT'),
          ('identity.facilities', 'SELECT'), ('auth.external_identities', 'SELECT'),
          ('auth.external_identities', 'INSERT'), ('auth.otp_challenges', 'SELECT'),
          ('notification.inbox_items', 'SELECT'), ('notification.imported_inbox_items', 'SELECT'),
          ('notification.imported_inbox_reads', 'SELECT'), ('audit.events', 'SELECT'),
          ('audit.events', 'INSERT'), ('auth.accounts', 'UPDATE')) wanted(relation_name, privilege)
        join pg_class relation on relation.oid = wanted.relation_name::regclass
        join pg_roles holder on holder.oid = applier
       where case when wanted.privilege = 'OWNER'
               then not pg_temp.parity_0093_holds(applier, relation.relowner, null::aclitem[], 'r', 'OWNER')
               else not pg_temp.parity_0093_holds(applier, relation.relowner, relation.relacl, 'r', wanted.privilege) end
      union all
      select format('%s lacks EXECUTE on %s', holder.rolname, proc.oid::regprocedure)
        from (values
          ('notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)'),
          ('identity.patient_self_session(text,uuid)'), ('platform.current_actor_subject()'),
          ('platform.current_correlation_id()'), ('platform.current_account_id()'),
          ('auth.account_id_for_subject(text)')) wanted(proc_name)
        join pg_proc proc on proc.oid = wanted.proc_name::regprocedure
        join pg_roles holder on holder.oid = applier
       where not pg_temp.parity_0093_holds(applier, proc.proowner, proc.proacl, 'f', 'EXECUTE')
      union all
      select format('%s may not replace %s (owner %s)', current_user, replaced.what, pg_get_userbyid(replaced.proowner))
        from parity_0093_replaced replaced
       where not pg_temp.parity_0093_holds(applier, replaced.proowner, null::aclitem[], 'f', 'OWNER')
      union all
      select format('%s (owner of %s) lacks EXECUTE on notification.enqueue_patient_inbox_item', pg_get_userbyid(replaced.proowner), replaced.what)
        from parity_0093_replaced replaced
        join pg_proc proc on proc.oid = 'notification.enqueue_patient_inbox_item(uuid,text,text,uuid,jsonb)'::regprocedure
       where replaced.what like 'identity.close_own_consent_grant%'
         and not pg_temp.parity_0093_holds(replaced.proowner, proc.proowner, proc.proacl, 'f', 'EXECUTE')
      union all
      select format('%s (owner of %s) lacks SELECT on identity.facilities', pg_get_userbyid(replaced.proowner), replaced.what)
        from parity_0093_replaced replaced
        join pg_class relation on relation.oid = 'identity.facilities'::regclass
       where replaced.what like 'identity.close_own_consent_grant%'
         and not pg_temp.parity_0093_holds(replaced.proowner, relation.relowner, relation.relacl, 'r', 'SELECT')) missing;
  if mismatch is not null then
    raise exception using errcode = '42501', message = format('0093: missing privileges: %s', mismatch);
  end if;
  if (select count(*) from parity_0093_replaced) <> 2 then
    raise exception using errcode = '55000', message = '0093: the two replaced functions were not recorded';
  end if;
  raise notice '0093: owners checked: %', (
    select string_agg(format('%s=%s', owned.what, owned.owner), ', ' order by owned.what)
      from (select replaced.what, pg_get_userbyid(replaced.proowner) as owner from parity_0093_replaced replaced
            union all
            select 'identity.patients', pg_get_userbyid(relation.relowner) from pg_class relation
             where relation.oid = 'identity.patients'::regclass
            union all
            select 'new functions', current_user::text) owned);
end
$$;

-- 1. A patient's account by Health ID, phone (its contact lookup HMAC) or
-- account id, for sign-in, recovery and the reset emails.
create function auth.find_patient_account(requested_kind text, requested_value text)
returns table (
  account_id uuid, account_subject text, email text, email_verified boolean, display_name text,
  password_hash text, password_algorithm text, row_version bigint, token_version bigint,
  account_status text, disabled_now boolean, workforce boolean,
  patient_first_name text, patient_hid_code text
)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  matched_accounts uuid[];
  phone_hmacs char(64)[];
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'PATIENT_ACCOUNT_LOOKUP_DENIED';
  end if;
  if requested_kind = 'hid' and coalesce(requested_value, '') ~* '^HID-[A-HJ-NP-Z2-9]{6,32}$' then
    select array_agg(distinct patient.account_id) into matched_accounts
      from identity.patients patient
      join auth.accounts account on account.id = patient.account_id
     where upper(patient.hid_code) = upper(requested_value)
       and patient.status = 'active' and account.status <> 'deleted';
  elsif requested_kind = 'phone' and coalesce(requested_value, '') ~ '^[0-9a-f]{64}(,[0-9a-f]{64})?$' then
    -- char(64), the column's type: a text comparison would read every
    -- patient instead of patients_phone_hmac_uq.
    phone_hmacs := string_to_array(requested_value, ',')::char(64)[];
    select array_agg(distinct patient.account_id) into matched_accounts
      from identity.patients patient
      join auth.accounts account on account.id = patient.account_id
     where patient.phone_lookup_hmac = any (phone_hmacs)
       and patient.status = 'active' and account.status <> 'deleted';
  elsif requested_kind = 'account'
     and coalesce(requested_value, '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select array_agg(distinct patient.account_id) into matched_accounts
      from identity.patients patient
      join auth.accounts account on account.id = patient.account_id
     where patient.account_id = requested_value::uuid
       and patient.status = 'active' and account.status <> 'deleted';
  else
    return;
  end if;
  -- One account or none: a value two accounts share answers as unknown.
  if coalesce(cardinality(matched_accounts), 0) <> 1 then return; end if;
  return query
    select account.id, account.subject, account.email, account.email_verified_at is not null,
           account.display_name,
           case when requested_kind in ('hid', 'phone') then account.password_hash end,
           case when requested_kind in ('hid', 'phone') then account.password_algorithm end,
           account.row_version, account.token_version, account.status,
           coalesce(account.disabled_until > clock_timestamp(), false),
           (exists (select 1 from auth.account_roles role_assignment where role_assignment.account_id = account.id)
             or exists (select 1 from identity.staff staff_record where staff_record.account_id = account.id)
             or exists (select 1 from identity.staff_facility_memberships membership
                         where membership.account_id = account.id)),
           patient.first_name, patient.hid_code
      from auth.accounts account
      join identity.patients patient on patient.account_id = account.id and patient.status = 'active'
     where account.id = matched_accounts[1]
     order by patient.created_at, patient.id
     limit 1;
end
$$;

-- 2. Whether a patient account uses the email (Google sign-up).
create function auth.patient_email_registered(requested_email text, requested_email_lookup_hmac char(64))
returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  normalized_email text := lower(btrim(requested_email));
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'PATIENT_EMAIL_LOOKUP_DENIED';
  end if;
  if coalesce(normalized_email, '') = '' then return false; end if;
  return exists (
      select 1 from identity.patients patient
        join auth.accounts account on account.id = patient.account_id
       where lower(account.email) = normalized_email
         and account.status <> 'deleted' and patient.status <> 'deleted')
    or (coalesce(requested_email_lookup_hmac, '') ~ '^[0-9a-f]{64}$'
      and exists (
        select 1 from identity.patients patient
          join auth.accounts account on account.id = patient.account_id
         where patient.email_lookup_hmac = requested_email_lookup_hmac
           and account.status <> 'deleted' and patient.status <> 'deleted'));
end
$$;

-- 3. Google sign-in for a registered patient: link a Google subject to the
-- one patient account whose verified email Google verified (owner decision
-- of 2026-10-28).
create function auth.link_google_identity_by_verified_email(
  requested_google_subject text, requested_email text, requested_email_lookup_hmac char(64)
) returns table (outcome text, account_id uuid, account_subject text)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  normalized_email text := lower(btrim(requested_email));
  lookup_hmac char(64) := case when coalesce(requested_email_lookup_hmac, '') ~ '^[0-9a-f]{64}$'
    then requested_email_lookup_hmac end;
  linked_account auth.accounts%rowtype;
  linked_identity_status text;
  candidates uuid[];
  candidate_account uuid;
  account_row auth.accounts%rowtype;
  patient_row identity.patients%rowtype;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null
     or requested_google_subject is null
     or length(requested_google_subject) not between 1 and 255 then
    raise exception using errcode = '42501', message = 'GOOGLE_LINK_DENIED';
  end if;
  -- The subject is already linked (auth.resolve_google_identity found no
  -- active mapping to an active account): a suspended patient is told so,
  -- as the right password tells them; anything else keeps the link it has.
  select identity_row.status, identity_row.account_id into linked_identity_status, candidate_account
    from auth.external_identities identity_row
   where identity_row.issuer = 'https://accounts.google.com'
     and identity_row.subject = requested_google_subject;
  if found then
    select * into linked_account from auth.accounts account where account.id = candidate_account;
    if linked_identity_status <> 'revoked' and linked_account.status <> 'deleted'
       and (linked_account.status in ('disabled', 'locked') or linked_account.disabled_until > clock_timestamp())
       and exists (select 1 from identity.patients patient
                    where patient.account_id = linked_account.id and patient.status = 'active')
       and not exists (select 1 from auth.account_roles role_assignment where role_assignment.account_id = linked_account.id)
       and not exists (select 1 from identity.staff staff_record where staff_record.account_id = linked_account.id)
       and not exists (select 1 from identity.staff_facility_memberships membership
                        where membership.account_id = linked_account.id) then
      return query select 'suspended'::text, linked_account.id, linked_account.subject;
      return;
    end if;
    return query select 'already_linked'::text, null::uuid, null::text;
    return;
  end if;
  if normalized_email is null or length(normalized_email) > 254
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    return query select 'unverified'::text, null::uuid, null::text;
    return;
  end if;
  -- One decision per email at a time.
  perform pg_advisory_xact_lock(hashtextextended('google-email-link:' || normalized_email, 0));
  -- Two index lookups (accounts_email_ci_uq, patients_email_hmac_uq), not
  -- one OR across both tables, which would join every patient.
  select array_agg(distinct candidate.id) into candidates
    from (select patient.id
            from auth.accounts account
            join identity.patients patient on patient.account_id = account.id
           where lower(account.email) = normalized_email
             and account.status <> 'deleted' and patient.status = 'active'
          union
          select patient.id
            from identity.patients patient
            join auth.accounts account on account.id = patient.account_id
           where lookup_hmac is not null and patient.email_lookup_hmac = lookup_hmac
             and account.status <> 'deleted' and patient.status = 'active') candidate;
  if coalesce(cardinality(candidates), 0) = 0 then
    return query select 'none'::text, null::uuid, null::text;
    return;
  end if;
  if cardinality(candidates) > 1 then
    return query select 'ambiguous'::text, null::uuid, null::text;
    return;
  end if;
  select patient.account_id into candidate_account from identity.patients patient where patient.id = candidates[1];
  -- 0059's lock order: the account, then the patient.
  select * into account_row from auth.accounts account where account.id = candidate_account for update;
  select * into patient_row from identity.patients patient where patient.id = candidates[1] for update;
  if not found or patient_row.status <> 'active' or account_row.status = 'deleted' then
    return query select 'none'::text, null::uuid, null::text;
    return;
  end if;
  if exists (select 1 from auth.account_roles role_assignment where role_assignment.account_id = account_row.id)
     or exists (select 1 from identity.staff staff_record where staff_record.account_id = account_row.id)
     or exists (select 1 from identity.staff_facility_memberships membership
                 where membership.account_id = account_row.id) then
    return query select 'workforce'::text, null::uuid, null::text;
    return;
  end if;
  if account_row.email is null or lower(account_row.email) <> normalized_email
     or account_row.email_verified_at is null then
    return query select 'not_verified'::text, null::uuid, null::text;
    return;
  end if;
  if account_row.status in ('disabled', 'locked') or account_row.disabled_until > clock_timestamp() then
    return query select 'suspended'::text, account_row.id, account_row.subject;
    return;
  end if;
  if account_row.status <> 'active' then
    return query select 'not_verified'::text, null::uuid, null::text;
    return;
  end if;
  if exists (select 1 from auth.external_identities identity_row
              where identity_row.account_id = account_row.id
                and identity_row.issuer = 'https://accounts.google.com'
                and identity_row.status = 'active') then
    return query select 'linked_elsewhere'::text, null::uuid, null::text;
    return;
  end if;
  begin
    insert into auth.external_identities(id, account_id, issuer, subject, status, source_system)
      values (gen_random_uuid(), account_row.id, 'https://accounts.google.com', requested_google_subject,
        'active', 'hid-google-verified-email-link');
  exception when unique_violation then
    return query select 'already_linked'::text, null::uuid, null::text;
    return;
  end;
  insert into audit.events(correlation_id, actor_type, actor_subject, actor_account_id, patient_id,
    action, resource_type, resource_id, outcome, purpose_of_use, provenance, source_system, details)
  values (platform.current_correlation_id(), 'patient', account_row.subject, account_row.id, patient_row.id,
    'auth.google.auto-link', 'account', account_row.id::text, 'success', 'patient-self', 'application',
    'identity-api', jsonb_build_object('method', 'verified_email'));
  perform notification.enqueue_patient_inbox_item(patient_row.id, 'SECURITY_GOOGLE_LINKED', 'account', null,
    '{}'::jsonb);
  return query select 'linked'::text, account_row.id, account_row.subject;
end
$$;

-- 4. Security notices in the patient's inbox, bound to their evidence.
create function auth.record_account_security_notice(requested_account_id uuid, requested_code text)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  patient_id_value uuid;
  evidence_at timestamptz;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'ACCOUNT_SECURITY_NOTICE_DENIED';
  end if;
  if requested_account_id is null or requested_code is null or requested_code not in (
       'SECURITY_PASSWORD_RESET_REQUESTED', 'SECURITY_PASSWORD_CHANGED', 'SECURITY_GOOGLE_LINKED') then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'account-security-notice:' || requested_account_id::text || ':' || requested_code, 0));
  select patient.id into patient_id_value
    from identity.patients patient
    join auth.accounts account on account.id = patient.account_id
   where account.id = requested_account_id and account.status <> 'deleted' and patient.status = 'active'
   order by patient.created_at, patient.id
   limit 1;
  if patient_id_value is null then return null; end if;
  if requested_code = 'SECURITY_PASSWORD_RESET_REQUESTED' then
    select max(challenge.created_at) into evidence_at
      from auth.otp_challenges challenge
     where challenge.account_id = requested_account_id
       and challenge.purpose in ('PASSWORD_RESET', 'LEGACY_ACCOUNT_RECOVERY', 'LEGACY_SESSION_FALLBACK')
       and challenge.consumed_at is null and challenge.invalidated_at is null
       and challenge.created_at > clock_timestamp() - interval '10 minutes';
    if evidence_at is null or exists (select 1 from notification.inbox_items item
        where item.account_id = requested_account_id and item.notification_code = requested_code
          and item.created_at > clock_timestamp() - interval '1 hour') then
      return null;
    end if;
  elsif requested_code = 'SECURITY_PASSWORD_CHANGED' then
    select account.password_changed_at into evidence_at
      from auth.accounts account
     where account.id = requested_account_id
       and account.password_changed_at > clock_timestamp() - interval '10 minutes';
  else
    select max(identity_row.linked_at) into evidence_at
      from auth.external_identities identity_row
     where identity_row.account_id = requested_account_id
       and identity_row.issuer = 'https://accounts.google.com' and identity_row.status = 'active'
       and identity_row.linked_at > clock_timestamp() - interval '10 minutes';
  end if;
  -- Once per piece of evidence.
  if evidence_at is null or exists (select 1 from notification.inbox_items item
      where item.account_id = requested_account_id and item.notification_code = requested_code
        and item.created_at >= evidence_at) then
    return null;
  end if;
  return notification.enqueue_patient_inbox_item(patient_id_value, requested_code, 'account', null, '{}'::jsonb);
end
$$;

-- 5. The patient's unread count for the bell.
create function identity.count_my_unread_notifications(requested_subject text, requested_session uuid)
returns integer
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
  account_id_value uuid;
  inbox_unread integer;
  imported_unread integer;
begin
  if patient_id_value is null then return null; end if;
  select patient.account_id into account_id_value from identity.patients patient where patient.id = patient_id_value;
  if account_id_value is null then return null; end if;
  select count(*) into inbox_unread
    from (select 1 from notification.inbox_items item
           where item.account_id = account_id_value and item.read_at is null
           limit 1000) unread;
  select count(*) into imported_unread
    from (select 1 from notification.imported_inbox_items item
           where item.account_id = account_id_value and item.source_read_at is null
             and not exists (select 1 from notification.imported_inbox_reads read_row
                              where read_row.item_id = item.id and read_row.account_id = account_id_value)
           limit 1000) unread;
  return least(inbox_unread + imported_unread, 1000);
end
$$;

-- 6. Who viewed or changed the patient's record, newest first.
create function identity.patient_self_access_log(
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
           event.facility_id
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

-- 7. The sign-up activation (0092), replaced: 0092's body byte for byte but the
-- profile phone rule, which admits E.164 of any country (7-15 digits). CREATE
-- OR REPLACE keeps its owner and ACL.
create or replace function identity.activate_public_patient_signup(
  requested_enrollment_id uuid, requested_token_hmac char(64), requested_profile_json text,
  requested_contact text, requested_hid text, requested_password_hash text,
  requested_contact_lookup_hmac char(64)
) returns table (patient_id uuid, hid_code text, account_id uuid, replayed boolean)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, public, pg_temp
as $$
declare
  enrollment identity.public_patient_enrollments%rowtype;
  profile jsonb;
  new_account uuid;
  new_patient uuid;
  normalized_email text;
  first_name text;
  last_name text;
begin
  if platform.current_actor_subject() <> 'system:auth' or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED';
  end if;
  if not identity.patient_contact_lookup_ready() then
    raise exception using errcode = '55000', message = 'PATIENT_ENROLLMENT_RECONCILIATION_REQUIRED';
  end if;
  select * into enrollment from identity.public_patient_enrollments
    where id = requested_enrollment_id for update;
  if not found or enrollment.token_hmac <> requested_token_hmac
    or enrollment.nin_lookup_hmac is not null or enrollment.signup_email_lookup_hmac is null then
    raise exception using errcode = '42501', message = 'PATIENT_ENROLLMENT_DENIED';
  end if;
  if enrollment.state = 'active' then
    return query select enrollment.patient_id,
      (select patient.hid_code from identity.patients patient where patient.id = enrollment.patient_id),
      enrollment.account_id, true;
    return;
  end if;
  if enrollment.state <> 'set_password' or enrollment.expires_at <= clock_timestamp()
    or enrollment.contact_verified_at is null or enrollment.verified_challenge_id is null
    or enrollment.contact_channel is distinct from 'email'
    or enrollment.contact_lookup_hmac is null
    or enrollment.contact_lookup_hmac <> enrollment.signup_email_lookup_hmac
    or requested_contact_lookup_hmac is null
    or enrollment.contact_lookup_hmac <> requested_contact_lookup_hmac
    or requested_hid !~ '^HID-[A-HJ-NP-Z2-9]{6,32}$'
    or requested_password_hash !~ '^\$argon2id\$v=19\$m=65536,t=3,p=1\$'
    or length(requested_password_hash) not between 64 and 512
    or requested_profile_json is null or length(requested_profile_json) > 65536
    or encode(public.digest(requested_profile_json, 'sha256'), 'hex') <> enrollment.profile_sha256 then
    raise exception using errcode = '23514', message = 'PATIENT_ENROLLMENT_NOT_READY';
  end if;
  if not exists (select 1 from identity.public_patient_enrollment_otps challenge
    where challenge.id = enrollment.verified_challenge_id and challenge.enrollment_id = enrollment.id
      and challenge.channel = enrollment.contact_channel
      and challenge.recipient_hmac = enrollment.contact_hmac
      and challenge.verified_at is not null and challenge.consumed_at is not null
      and challenge.invalidated_at is null) then
    raise exception using errcode = '23514', message = 'PATIENT_CONTACT_NOT_VERIFIED';
  end if;
  profile := requested_profile_json::jsonb;
  normalized_email := lower(btrim(requested_contact));
  first_name := btrim(profile->>'firstName');
  last_name := btrim(profile->>'lastName');
  if jsonb_typeof(profile) <> 'object' or profile->>'kind' is distinct from 'signup'
    or profile ? 'nin'
    or coalesce(first_name, '') !~ '^[^[:cntrl:]]{1,80}$'
    or coalesce(last_name, '') !~ '^[^[:cntrl:]]{1,80}$'
    or coalesce(profile->>'gender', '') not in ('female','male','intersex','other','unknown')
    or coalesce(profile->>'phone', '') !~ '^\+[1-9][0-9]{6,14}$'
    or (profile ? 'hospitalCurrentlyUsing'
      and coalesce(profile->>'hospitalCurrentlyUsing', '') !~ '^[^[:cntrl:]]{1,120}$')
    or profile->>'email' is distinct from normalized_email
    or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or length(normalized_email) > 254 then
    raise exception using errcode = '23514', message = 'PATIENT_IDENTITY_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('patient-contact:email:' || enrollment.contact_lookup_hmac, 0));
  perform pg_advisory_xact_lock(hashtextextended('patient-contact:phone:' || enrollment.signup_phone_lookup_hmac, 0));
  if exists (select 1 from auth.accounts account
      where lower(account.email) = normalized_email and account.status <> 'deleted')
    or identity.public_patient_contact_already_bound('email', enrollment.contact_lookup_hmac) then
    raise exception using errcode = '23505', message = 'PATIENT_EMAIL_ALREADY_BOUND';
  end if;
  if identity.public_patient_contact_already_bound('phone', enrollment.signup_phone_lookup_hmac) then
    raise exception using errcode = '23505', message = 'PATIENT_PHONE_ALREADY_BOUND';
  end if;
  new_account := gen_random_uuid();
  new_patient := gen_random_uuid();
  -- Set IDs before inserting the canonical patient so RLS can prove the exact
  -- pending enrollment tuple. All writes commit or roll back together.
  update identity.public_patient_enrollments set account_id = new_account,
    patient_id = new_patient, updated_at = clock_timestamp(), row_version = row_version + 1
    where id = enrollment.id;
  insert into auth.accounts(id,subject,email,display_name,status,password_hash,
    password_algorithm,password_changed_at,email_verified_at,source_system)
  values(new_account,'patient:' || new_account::text,normalized_email,
    first_name || ' ' || last_name,'active',requested_password_hash,'argon2id',clock_timestamp(),
    enrollment.contact_verified_at,'hid-public-qoreid-enrollment');
  insert into identity.patients(id,account_id,hid_code,first_name,last_name,full_name,
    gender,dob,phone_e164_ciphertext,phone_lookup_hmac,email_ciphertext,email_lookup_hmac,
    contact_key_version,source_system,status)
  values(new_patient,new_account,requested_hid,first_name,last_name,first_name || ' ' || last_name,
    profile->>'gender',null,enrollment.signup_phone_ciphertext,enrollment.signup_phone_lookup_hmac,
    enrollment.contact_ciphertext,enrollment.contact_lookup_hmac,
    enrollment.key_version,'hid-public-qoreid-enrollment','active');
  insert into identity.patient_identifiers(id,patient_id,identifier_type,public_value,verified,source_system)
    values(gen_random_uuid(),new_patient,'hid_code',requested_hid,true,'hid-public-qoreid-enrollment');
  insert into identity.patient_assurance_states(patient_id,account_id,state,source_system,
    source_reference,contact_verified_at)
  values(new_patient,new_account,'CONTACT_VERIFIED','hid-public-signup',
    enrollment.id::text,enrollment.contact_verified_at);
  update identity.public_patient_enrollments set state = 'active', activated_at = clock_timestamp(),
    updated_at = clock_timestamp(), row_version = row_version + 1 where id = enrollment.id;
  insert into audit.events(correlation_id,actor_type,actor_subject,patient_id,
    action,resource_type,resource_id,outcome,purpose_of_use,provenance,source_system,details)
  values(platform.current_correlation_id(),'system',null,new_patient,
    'identity.public-patient-enrollment.activated','patient',new_patient::text,
    'success','patient-self','application','identity-api',
    jsonb_build_object('provider','none','enrollment','signup','contactChannel','email'));
  return query select new_patient, requested_hid, new_account, false;
end
$$;

-- 8. A clinician ending their own access (0010), replaced: 0010's body plus
-- the patient's notice. Same signature, result, SECURITY DEFINER and
-- search_path; CREATE OR REPLACE keeps its owner and ACL.
create or replace function identity.close_own_consent_grant(
  requested_grant_id uuid,
  requested_reason text
)
returns table (
  consent_grant_id uuid,
  subject_patient_id uuid,
  grant_status text,
  closed_at timestamptz,
  already_closed boolean
)
language plpgsql
security definer
set search_path = identity, auth, audit, platform, pg_temp
as $$
declare
  actor_subject text := platform.current_actor_subject();
  actor_account_id uuid := auth.account_id_for_subject(actor_subject);
  actor_membership_id uuid := platform.current_membership_id();
  actor_facility_id uuid := platform.current_facility_id();
  actor_correlation_id text := platform.current_correlation_id();
  actor_purpose text := platform.current_purpose_of_use();
  actor_organization_id uuid;
  patient_id_value uuid;
  current_status text;
  revoked_at_value timestamptz;
  prior_revoker uuid;
  replayed boolean := false;
  grant_expires_at timestamptz;
  facility_name_value text;
begin
  if actor_account_id is null
     or actor_membership_id is null
     or actor_facility_id is null
     or actor_correlation_id is null
     or not auth.membership_has_permission(
       actor_subject, actor_membership_id, actor_facility_id, 'identity.consent.write'
     ) then
    raise exception using errcode = '42501', message = 'Authorized consent command context is required';
  end if;
  if actor_purpose is null
     or not exists (
       select 1 from identity.purpose_of_use_codes purpose
       where purpose.code = actor_purpose and purpose.active
     ) then
    raise exception using errcode = '22023', message = 'A governed purpose of use is required';
  end if;
  if length(coalesce(btrim(requested_reason), '')) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'Invalid grant closure reason';
  end if;

  select grant_row.patient_id, grant_row.status, grant_row.revoked_at,
         grant_row.revoked_by, membership.organization_id, grant_row.expires_at
    into patient_id_value, current_status, revoked_at_value,
         prior_revoker, actor_organization_id, grant_expires_at
  from identity.consent_grants grant_row
  join identity.staff_facility_memberships membership
    on membership.id = grant_row.membership_id
   and membership.facility_id = grant_row.facility_id
   and membership.account_id = grant_row.account_id
  where grant_row.id = requested_grant_id
    and grant_row.account_id = actor_account_id
    and grant_row.membership_id = actor_membership_id
    and grant_row.facility_id = actor_facility_id
  for update of grant_row;
  if patient_id_value is null then
    raise exception using errcode = 'P0002', message = 'Consent grant is not available';
  end if;

  if current_status = 'active' then
    update identity.consent_grants
       set status = 'revoked',
           revoked_at = clock_timestamp(),
           revoked_by = actor_account_id,
           revoked_reason = btrim(requested_reason),
           updated_at = clock_timestamp(),
           row_version = row_version + 1
     where id = requested_grant_id
     returning revoked_at into revoked_at_value;
    -- 0093: the patient is told when a clinician ends their access early (never
    -- the clinician's reason; never on a replay or once the grant has expired).
    if grant_expires_at > revoked_at_value then
      select facility.name into facility_name_value
        from identity.facilities facility where facility.id = actor_facility_id;
      perform notification.enqueue_patient_inbox_item(patient_id_value, 'CONSENT_GRANT_ENDED_BY_CLINICIAN',
        'consent-grant', requested_grant_id, jsonb_build_object('facilityName', facility_name_value));
    end if;
  elsif current_status = 'revoked' and prior_revoker = actor_account_id then
    replayed := true;
  else
    raise exception using errcode = '55000', message = 'Only an active grant owned by the current staff member can be closed';
  end if;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id,
    actor_membership_id, organization_id, facility_id, patient_id,
    action, outcome, resource_type, resource_id, purpose_of_use,
    reason, provenance, source_system, details
  ) values (
    actor_correlation_id, 'staff', actor_subject, actor_account_id,
    actor_membership_id, actor_organization_id, actor_facility_id, patient_id_value,
    case when replayed then 'identity.consent-grant.close.replay' else 'identity.consent-grant.close' end,
    'success', 'consent-grant', requested_grant_id::text, actor_purpose,
    btrim(requested_reason), 'application', 'ehr-api',
    jsonb_build_object('existing_closure', replayed)
  );

  return query select
    requested_grant_id, patient_id_value, 'revoked'::text,
    revoked_at_value, replayed;
end;
$$;

-- 9. Post-checks.
do $$
declare mismatch text;
begin
  select string_agg(replaced.what, ', ') into mismatch
    from parity_0093_replaced replaced
    join pg_proc proc on proc.oid = replaced.oid
   where (proc.proowner, proc.proacl, proc.prolang, proc.provolatile, proc.prosecdef, proc.proconfig,
          proc.prorettype, proc.proretset, proc.proargnames, proc.proallargtypes)
     is distinct from (replaced.proowner, replaced.proacl, replaced.prolang, replaced.provolatile,
          replaced.prosecdef, replaced.proconfig, replaced.prorettype, replaced.proretset,
          replaced.proargnames, replaced.proallargtypes);
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0093: a replaced function changed more than its body: %s', mismatch);
  end if;
  select string_agg(format('%s md5 %s', expected.proc, coalesce(md5(proc.prosrc), 'none')), '; ') into mismatch
    from (values
      ('identity.activate_public_patient_signup(uuid,char,text,text,text,text,char)', 'b21ffc9d2426c988b0b358e5718542ed'),
      ('identity.close_own_consent_grant(uuid,text)', 'd13df3197640316324948268d7d9a18f'))
         expected(proc, digest)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc)
   where md5(proc.prosrc) is distinct from expected.digest;
  if mismatch is not null then
    raise exception using errcode = '55000', message = format('0093: a replaced body is not the one this file gives: %s', mismatch);
  end if;
  if exists (select 1 from pg_proc proc
              where proc.oid in ('auth.find_patient_account(text,text)'::regprocedure,
                                 'auth.patient_email_registered(text,char)'::regprocedure,
                                 'auth.link_google_identity_by_verified_email(text,text,char)'::regprocedure,
                                 'auth.record_account_security_notice(uuid,text)'::regprocedure,
                                 'identity.count_my_unread_notifications(text,uuid)'::regprocedure,
                                 'identity.patient_self_access_log(text,uuid,integer,timestamptz,bigint)'::regprocedure)
                and proc.proowner <> (select oid from pg_roles where rolname = current_user)) then
    raise exception using errcode = '55000', message = '0093: a new function does not belong to the applying role';
  end if;
end
$$;
drop function pg_temp.parity_0093_holds(oid, oid, aclitem[], "char", text);
drop table pg_temp.parity_0093_replaced;

-- 10. Grants (here and in runtime-grants.sql).
revoke all on function auth.find_patient_account(text,text),
  auth.patient_email_registered(text,char),
  auth.link_google_identity_by_verified_email(text,text,char),
  auth.record_account_security_notice(uuid,text),
  identity.count_my_unread_notifications(text,uuid),
  identity.patient_self_access_log(text,uuid,integer,timestamptz,bigint) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant execute on function auth.find_patient_account(text,text),
      auth.patient_email_registered(text,char),
      auth.link_google_identity_by_verified_email(text,text,char),
      auth.record_account_security_notice(uuid,text),
      identity.count_my_unread_notifications(text,uuid),
      identity.patient_self_access_log(text,uuid,integer,timestamptz,bigint)
      to hid_identity_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_schema_test_runtime') then
    grant execute on function auth.find_patient_account(text,text),
      auth.patient_email_registered(text,char),
      auth.link_google_identity_by_verified_email(text,text,char),
      auth.record_account_security_notice(uuid,text),
      identity.count_my_unread_notifications(text,uuid),
      identity.patient_self_access_log(text,uuid,integer,timestamptz,bigint)
      to hid_schema_test_runtime;
  end if;
end
$$;

comment on function auth.find_patient_account(text,text) is
  '0093: system:auth only. The one active patient''s account by Health ID, phone lookup HMAC (or a Nigerian number''s two, comma separated) or account id (any status but deleted), for patient sign-in, recovery and the reset emails; nothing when none or several match.';
comment on function auth.link_google_identity_by_verified_email(text,text,char) is
  '0093: system:auth only. Links a Google subject to the one active, non-workforce patient account whose verified email is the Google-verified email; answers the outcome.';
comment on function auth.record_account_security_notice(uuid,text) is
  '0093: system:auth only. A security notice in the patient''s inbox, bound to its evidence; null otherwise, never raises for an ineligible notice.';
comment on function identity.count_my_unread_notifications(text,uuid) is
  '0093: the live patient session''s unread inbox and imported hid-1.0 notifications, at most 1000.';
comment on function identity.patient_self_access_log(text,uuid,integer,timestamptz,bigint) is
  '0093: who viewed or changed the live patient session''s record, newest first, from its successful audit events; no record contents.';
