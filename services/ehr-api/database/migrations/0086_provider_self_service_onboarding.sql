-- Facility self sign-up (provider self-service onboarding), switched off.
--
-- Owner decision D14 (2026-10-23): a hospital, laboratory or pharmacy signs
-- itself up through "Setup Your Facility" without a platform administrator
-- approving it first; the administrator finishes by setting a password
-- (second decision: no authenticator). Owner decision of 2026-10-24: every
-- self-signed-up facility appears for support, who review it within a
-- business day ("alert + daily review").
--
-- This ports main's 0061, 0062 (with db49a0d's loop fix and 46a173f's
-- activation wrapper) and 0063 (08c906f) onto this branch, with these
-- changes, recorded in docs/MAIN_TO_NOVU_PORT.md:
--   A1  the platform control provider_self_service_enabled, seeded OFF; the
--       submit command and the activation wrapper require it;
--   A4  prune_verification_quotas keeps the body live at merge (0049) and
--       adds this migration's two counter tables (not main 0085's body);
--   A5  the runtime grants are made here as well as in runtime-grants.sql,
--       since a release applies only migrations;
--   A6  a platform-wide daily QoreID CAC lookup cap, a third argument of the
--       quota command, with its own counter table;
--   A8  an unactivated self-service application lapses 24 hours after it was
--       submitted: the next submit for its CAC and product, on the
--       self-service or the governed path, rejects it (reviewed_at set, an
--       explanatory review_reason, row_version bumped), invalidates its email
--       challenges and sessions, audits identity.organization.self-service.lapse
--       and opens a new application;
--   A10 activation sets the account's email_verified_at and
--       password_changed_at (the email code has just proved the mailbox);
--   A11 the self-service commands take the governed path's advisory-lock
--       keys ('org-application:' and 'org-cac:'), so the two paths serialize;
--   the support review: three nullable review columns on the application
--       and two platform-administration commands that work for a standalone
--       platform administrator (no facility membership), as 0064's commands do.
-- main's 0061 interim review check and its re-add of the status check (same
-- values as 0046) are not ported, nor main's later migrations or staff MFA.
--
-- Locks, all taken inside the release's one transaction (and again in its
-- dry run of every pending migration): ACCESS EXCLUSIVE on
-- identity.organization_applications (new columns, the review check swap,
-- two partial indexes) and SHARE ROW EXCLUSIVE on auth.accounts (the
-- reviewer foreign key), both from the first statements; ACCESS EXCLUSIVE on
-- platform.control_settings, the hot-path table every authenticated request
-- reads, only in the control section, which is the last statements of this
-- file. The new tables and functions lock nothing that already exists.
--
-- Applied migrations 0001 through 0085 are immutable.

-- 0. Preconditions. The release dry-runs every pending migration in one
-- transaction before applying any, so a refusal here stops the release with
-- nothing changed.
--
-- The 0046 review check passes a closed (approved or rejected) application
-- whose review_reason is NULL, because a NULL check result counts as a pass;
-- the replacement check below (main 0062) wraps review_reason in coalesce and
-- refuses it. Every other closed row the 0046 check admits (reviewer and
-- reviewed_at set, reason of 8 or more characters) also passes the new check.
-- Every command that closes an application writes a reason of 8 or more
-- characters, so such a row can only come from a direct write; refuse to run
-- rather than fail later inside ADD CONSTRAINT.
do $$
declare
  unreviewable bigint;
begin
  select count(*) into unreviewable
    from identity.organization_applications application
   where application.status in ('approved', 'rejected')
     and (application.review_reason is null
       or length(btrim(application.review_reason)) < 8
       or application.reviewed_at is null
       or application.reviewed_by_account_id is null);
  if unreviewable <> 0 then
    raise exception '0086: % closed organization application(s) have no review reason of 8 or more characters, reviewer or review time; the self-service review check would refuse them. Resolve them before this release',
      unreviewable;
  end if;
end
$$;

-- 1. The application table.
alter table identity.organization_applications
  add column approval_mode text not null default 'admin_review'
    constraint organization_applications_approval_mode_check
    check (approval_mode in ('admin_review', 'self_service')),
  add column self_service_reviewed_at timestamptz,
  add column self_service_reviewed_by_account_id uuid references auth.accounts(id) on delete restrict,
  add column self_service_review_note text;

-- main 0062 with db49a0d's loop variable, asserting the single 0046 check.
do $$
declare
  matching_constraint record;
  matched integer := 0;
begin
  for matching_constraint in
    select constraint_row.conname
      from pg_constraint constraint_row
     where constraint_row.conrelid = 'identity.organization_applications'::regclass
       and constraint_row.contype = 'c'
       and pg_get_constraintdef(constraint_row.oid) like '%reviewed_by_account_id%'
       and pg_get_constraintdef(constraint_row.oid) like '%reviewed_at%'
       and pg_get_constraintdef(constraint_row.oid) like '%review_reason%'
  loop
    matched := matched + 1;
    execute format('alter table identity.organization_applications drop constraint %I',
      matching_constraint.conname);
  end loop;
  if matched <> 1 then
    raise exception '0086 expected exactly one reviewer check on identity.organization_applications, found %', matched;
  end if;
end
$$;

alter table identity.organization_applications
  add constraint organization_applications_review_check_self_service check (
    status not in ('approved', 'rejected')
    or (
      reviewed_at is not null
      and length(btrim(coalesce(review_reason, ''))) >= 8
      and (
        approval_mode = 'self_service'
        or reviewed_by_account_id is not null
      )
    )
  ),
  -- Support's review of an activated self-service facility: all three set
  -- together, only on an approved self-service application.
  add constraint organization_applications_self_service_review_ck check (
    (self_service_reviewed_at is null
      and self_service_reviewed_by_account_id is null
      and self_service_review_note is null)
    or (self_service_reviewed_at is not null
      and self_service_reviewed_by_account_id is not null
      and self_service_review_note is not null
      and length(btrim(self_service_review_note)) between 8 and 500
      and approval_mode = 'self_service'
      and status = 'approved')
  );

create index organization_applications_self_service_idx
  on identity.organization_applications (cac_registration_number, product_code, administrator_email)
  where approval_mode = 'self_service' and status in ('pending_verification', 'ready_for_review');

-- The support list reads activated self-service applications, newest first.
create index organization_applications_self_service_activation_idx
  on identity.organization_applications (reviewed_at desc, id desc)
  where approval_mode = 'self_service' and status = 'approved';

-- 2. Self-service commands (main 0061 and 0062).
create function identity.public_get_organization_application(
  requested_cac_number text,
  requested_email text,
  requested_product text
) returns table (
  application_id uuid,
  application_status text,
  verification_result text,
  provider_verified_registration_number text,
  row_version bigint
)
language plpgsql stable security definer
set search_path = pg_catalog, identity, platform, pg_temp
as $$
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null
     or requested_cac_number !~ '^(RC|BN|IT)[0-9]{4,20}$'
     or requested_email is null
     or requested_product not in ('ehr', 'migrate', 'laboratory', 'pharmacy') then
    raise exception using errcode = '42501', message = 'Public organization enrollment context is required';
  end if;

  return query
    select application.id, application.status, application.verification_result,
      application.provider_verified_registration_number, application.row_version
    from identity.organization_applications application
    where application.cac_registration_number = upper(btrim(requested_cac_number))
      and application.administrator_email = lower(btrim(requested_email))
      and application.product_code = requested_product
      and application.status <> 'rejected'
    order by application.created_at desc
    limit 1;
end;
$$;

create function identity.public_record_organization_cac_result(
  requested_application_id uuid,
  expected_version bigint,
  requested_result text,
  requested_provider_reference text,
  requested_registration_number text,
  requested_organization_name text,
  requested_entity_type text,
  requested_registration_date text,
  requested_address text,
  requested_registry_status text
) returns table (
  application_status text,
  row_version bigint
)
language plpgsql security definer
set search_path = pg_catalog, identity, audit, platform, pg_temp
as $$
declare
  application identity.organization_applications%rowtype;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null
     or requested_result not in ('verified', 'not_verified', 'incomplete', 'provider_error', 'disabled')
     or requested_application_id is null then
    raise exception using errcode = '42501', message = 'Public organization verification context is required';
  end if;

  select * into application
    from identity.organization_applications row
   where row.id = requested_application_id
     and row.approval_mode = 'self_service'
     and row.status in ('pending_verification', 'ready_for_review')
   for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Organization application not found';
  end if;

  if application.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'Organization application version conflict';
  end if;

  if requested_result = 'verified' then
    if requested_registration_number is null
       or requested_registration_number <> application.cac_registration_number
       or length(btrim(coalesce(requested_organization_name, ''))) not between 2 and 200
       or length(btrim(coalesce(requested_entity_type, ''))) not between 2 and 120
       or requested_registration_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       or length(btrim(coalesce(requested_address, ''))) not between 5 and 1000
       or lower(btrim(coalesce(requested_registry_status, ''))) <> 'active'
       or requested_provider_reference is null
       or requested_provider_reference !~ '^[0-9]+$' then
      raise exception using errcode = '22023', message = 'Invalid CAC verification evidence';
    end if;
  end if;

  update identity.organization_applications row
     set approval_mode = 'self_service',
         verification_result = requested_result,
         verification_failure_category = case
           when requested_result = 'verified' then null
           when requested_result = 'not_verified' then 'not_verified'
           when requested_result = 'incomplete' then 'incomplete'
           when requested_result = 'disabled' then 'disabled'
           else 'unexpected_response'
         end,
         provider_reference = requested_provider_reference,
         provider_verified_registration_number = requested_registration_number,
         qoreid_organization_name = case when requested_result = 'verified'
           then btrim(requested_organization_name) else null end,
         qoreid_entity_type = case when requested_result = 'verified'
           then btrim(requested_entity_type) else null end,
         qoreid_registration_date = case when requested_result = 'verified'
           then requested_registration_date::date else null end,
         qoreid_address = case when requested_result = 'verified'
           then btrim(requested_address) else null end,
         qoreid_registry_status = case when requested_result = 'verified'
           then lower(btrim(requested_registry_status)) else null end,
         verified_organization_name = case when requested_result = 'verified'
           then btrim(requested_organization_name) else row.verified_organization_name end,
         verified_entity_type = case when requested_result = 'verified'
           then btrim(requested_entity_type) else row.verified_entity_type end,
         verified_registration_date = case when requested_result = 'verified'
           then requested_registration_date::date else row.verified_registration_date end,
         verified_address = case when requested_result = 'verified'
           then btrim(requested_address) else row.verified_address end,
         verified_registry_status = case when requested_result = 'verified'
           then lower(btrim(requested_registry_status)) else row.verified_registry_status end,
         organization_name = case when requested_result = 'verified'
           then btrim(requested_organization_name) else row.organization_name end,
         organization_name_source = case when requested_result = 'verified'
           then 'qoreid' else row.organization_name_source end,
         entity_type_source = case when requested_result = 'verified'
           then 'qoreid' else row.entity_type_source end,
         registration_date_source = case when requested_result = 'verified'
           then 'qoreid' else row.registration_date_source end,
         address_source = case when requested_result = 'verified'
           then 'qoreid' else row.address_source end,
         registry_status_source = case when requested_result = 'verified'
           then 'qoreid' else row.registry_status_source end,
         profile_state = case when requested_result = 'verified' then 'complete' else row.profile_state end,
         status = case when requested_result = 'verified' then 'ready_for_review'
           else 'pending_verification' end,
         verified_at = case when requested_result = 'verified' then clock_timestamp() else null end,
         updated_at = clock_timestamp(),
         row_version = row.row_version + 1
   where row.id = application.id
   returning row.* into application;

  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'system',
    'identity.organization.self-service.cac-verify',
    case when requested_result = 'verified' then 'success' else 'denied' end,
    'organization-application', application.id::text,
    'application', 'identity-api',
    jsonb_build_object('productCode', application.product_code, 'result', requested_result)
  );

  return query select application.status, application.row_version;
end;
$$;

-- main 0061's activation (owner-only), with A10 (email_verified_at and
-- password_changed_at), A11 (the governed approval's 'org-cac:' lock key) and
-- the administrator email check written against accounts_email_ci_uq and
-- staff_email_ci_uq. The exact message "Administrator email already belongs
-- to an account" is what Identity answers as 409
-- PROVIDER_EMAIL_ALREADY_REGISTERED (#81).
create function identity.activate_self_service_organization_application(
  requested_session_hmac char(64),
  requested_password_hash text
) returns table (
  organization_id uuid,
  facility_id uuid,
  account_id uuid,
  row_version bigint,
  hid_subject text
)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  challenge identity.organization_profile_completion_challenges%rowtype;
  application identity.organization_applications%rowtype;
  existing_registration identity.organization_cac_registrations%rowtype;
  new_organization_id uuid;
  new_facility_id uuid;
  new_account_id uuid;
  new_staff_id uuid;
  new_membership_id uuid;
  new_application identity.organization_applications%rowtype;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null
     or requested_session_hmac is null
     or requested_session_hmac !~ '^[a-f0-9]{64}$'
     or requested_password_hash is null
     or length(requested_password_hash) < 20 then
    raise exception using errcode = '42501', message = 'Self-service activation context is required';
  end if;

  select * into challenge
    from identity.organization_profile_completion_challenges row
   where row.session_hmac = requested_session_hmac
     and row.consumed_at is not null
     and row.invalidated_at is null
     and row.session_expires_at > clock_timestamp()
   for update;

  if not found then
    raise exception using errcode = '42501', message = 'Organization enrollment session is invalid';
  end if;

  select * into application
    from identity.organization_applications row
   where row.id = challenge.application_id
   for update;

  if not found
     or application.approval_mode <> 'self_service'
     or application.status <> 'ready_for_review'
     or application.verification_result <> 'verified'
     or application.verified_at is null
     or application.provider_verified_registration_number <> application.cac_registration_number
     or application.qoreid_registry_status <> 'active'
     or application.qoreid_organization_name is null
     or application.qoreid_entity_type is null
     or application.qoreid_registration_date is null
     or application.qoreid_address is null then
    raise exception using errcode = '23514', message = 'Verified CAC enrollment is not ready for activation';
  end if;

  if exists (
    select 1 from auth.accounts account
    where lower(account.email) = lower(application.administrator_email)
      and account.email is not null and account.status <> 'deleted'
  ) or exists (
    select 1 from identity.staff staff
    where lower(staff.email) = lower(application.administrator_email)
  ) then
    raise exception using errcode = '23505', message = 'Administrator email already belongs to an account';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('org-cac:' || application.cac_registration_number, 0));

  select * into existing_registration
    from identity.organization_cac_registrations row
   where row.cac_registration_number = application.cac_registration_number
   for update;

  if found then
    raise exception using errcode = '23514', message = 'This CAC is already bound to an HID organization and requires manual resolution';
  end if;

  if exists (
    select 1 from identity.organizations row
    where lower(row.name) = lower(application.qoreid_organization_name)
  ) then
    raise exception using errcode = '23514', message = 'An organization with this verified name already exists and requires manual resolution';
  end if;

  new_organization_id := gen_random_uuid();
  new_facility_id := gen_random_uuid();
  new_account_id := gen_random_uuid();
  new_staff_id := gen_random_uuid();
  new_membership_id := gen_random_uuid();

  insert into identity.organizations (id, name, slug, active, source_system)
  values (
    new_organization_id, application.qoreid_organization_name,
    'org-' || replace(new_organization_id::text, '-', ''), true, 'hid'
  );

  insert into identity.facilities (
    id, organization_id, name, code, active, lifecycle_status, timezone, source_system
  ) values (
    new_facility_id, new_organization_id, application.qoreid_organization_name,
    'ORG-' || replace(new_facility_id::text, '-', ''), true, 'verified', 'Africa/Lagos', 'hid'
  );

  insert into identity.organization_cac_registrations (
    cac_registration_number, organization_id, primary_facility_id, source_application_id
  ) values (
    application.cac_registration_number, new_organization_id, new_facility_id, application.id
  );

  insert into identity.organization_products (
    organization_id, product_code, facility_id, source_application_id
  ) values (
    new_organization_id, application.product_code, new_facility_id, application.id
  );

  insert into auth.accounts (
    id, subject, email, display_name, password_hash, password_algorithm, password_changed_at,
    email_verified_at, status, source_system
  ) values (
    new_account_id, 'org-onboarding:' || new_account_id::text,
    lower(application.administrator_email), application.administrator_name,
    requested_password_hash, 'argon2id', clock_timestamp(), clock_timestamp(), 'active', 'hid'
  );

  insert into identity.staff (
    id, account_id, full_name, email, verification_status, default_role, active, source_system
  ) values (
    new_staff_id, new_account_id, application.administrator_name,
    lower(application.administrator_email), 'verified', 'org_admin', true, 'hid'
  );

  insert into identity.staff_facility_memberships (
    id, staff_id, account_id, organization_id, facility_id,
    membership_role, app_role, is_primary, active, source_system
  ) values (
    new_membership_id, new_staff_id, new_account_id, new_organization_id, new_facility_id,
    'org_admin', 'org_admin', true, true, 'hid'
  );

  insert into auth.account_roles (
    id, account_id, role_code, scope_type, membership_id, facility_id,
    granted_by, grant_reason
  ) values (
    gen_random_uuid(), new_account_id, 'org_admin', 'facility', new_membership_id,
    new_facility_id, null, 'Automated CAC and administrator-email self-service onboarding'
  );

  update identity.organization_applications row
     set status = 'approved',
         organization_id = new_organization_id,
         facility_id = new_facility_id,
         first_admin_account_id = new_account_id,
         reviewed_by_account_id = null,
         review_reason = 'Automated CAC and administrator-email verification',
         reviewed_at = clock_timestamp(),
         updated_at = clock_timestamp(),
         row_version = row.row_version + 1
   where row.id = application.id
   returning row.* into new_application;

  update identity.organization_profile_completion_challenges
     set invalidated_at = clock_timestamp()
   where id = challenge.id;

  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id,
    organization_id, facility_id, purpose_of_use, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'system',
    'identity.organization.self-service.activate', 'success',
    'organization-application', application.id::text,
    new_organization_id, new_facility_id, 'healthcare-operations',
    'application', 'identity-api',
    jsonb_build_object(
      'productCode', application.product_code,
      'cacVerified', true,
      'emailVerified', true,
      'approvalMode', 'self_service'
    )
  );

  return query select new_organization_id, new_facility_id, new_account_id,
    new_application.row_version, 'org-onboarding:' || new_account_id::text;
end;
$$;

-- A8. Called by both submit commands while they hold the CAC and product's
-- 'org-application:' lock. An application lapses when it is self-service,
-- still open (pending_verification or ready_for_review) and was submitted more
-- than 24 hours ago: it becomes rejected with an explanatory reason and no
-- reviewer (the self-service review check admits that), its email challenges
-- and completion sessions are invalidated, and the lapse is audited. Returns
-- the lapsed application's id, or null. Owner-only: it runs inside the
-- definer submit commands and is granted to no role.
--
-- Lock order: the completion sessions first, then the application row, then
-- the challenges without a session. Activation locks its session and then the
-- application; starting an email challenge locks the application and then the
-- challenges without a session; so neither can deadlock with a lapse.
create function identity.lapse_stale_self_service_organization_application(
  requested_cac_number text,
  requested_product text
) returns uuid
language plpgsql
set search_path = pg_catalog, identity, audit, platform, pg_temp
as $$
declare
  candidate uuid;
  stale identity.organization_applications%rowtype;
begin
  select application.id into candidate
    from identity.organization_applications application
   where application.cac_registration_number = requested_cac_number
     and application.product_code = requested_product
     and application.approval_mode = 'self_service'
     and application.status in ('pending_verification', 'ready_for_review')
     and application.created_at < clock_timestamp() - interval '24 hours';
  if candidate is null then return null; end if;

  perform 1 from identity.organization_profile_completion_challenges challenge
   where challenge.application_id = candidate
     and challenge.session_hmac is not null
     and challenge.invalidated_at is null
   order by challenge.id
   for update;

  select * into stale
    from identity.organization_applications application
   where application.id = candidate
     and application.approval_mode = 'self_service'
     and application.status in ('pending_verification', 'ready_for_review')
     and application.created_at < clock_timestamp() - interval '24 hours'
   for update;
  if not found then return null; end if;

  update identity.organization_applications application
     set status = 'rejected',
         reviewed_at = clock_timestamp(),
         review_reason = 'Self-service application lapsed: not activated within 24 hours of submission',
         updated_at = clock_timestamp(),
         row_version = application.row_version + 1
   where application.id = stale.id;

  update identity.organization_profile_completion_challenges challenge
     set invalidated_at = clock_timestamp()
   where challenge.application_id = stale.id
     and challenge.invalidated_at is null;

  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'system',
    'identity.organization.self-service.lapse', 'success',
    'organization-application', stale.id::text,
    'application', 'identity-api',
    jsonb_build_object('productCode', stale.product_code, 'previousStatus', stale.status,
      'lapseAfterHours', 24)
  );

  return stale.id;
end;
$$;

-- main 0062's submit with A1 (the control, after the context check), A8 (the
-- lapse, under the lock), A11 (the governed submit's lock key) and explicit
-- NULL product and organization type refusals (22023, as 0052's governed
-- submit). Both 23514 messages are main's.
create function identity.submit_self_service_organization_application(
  requested_product text,
  requested_organization_type text,
  requested_cac_number text,
  requested_administrator_name text,
  requested_administrator_email text
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, identity, audit, platform, pg_temp
as $$
declare
  normalized_cac text := upper(regexp_replace(coalesce(requested_cac_number, ''), '[[:space:]]+', '', 'g'));
  normalized_email text := lower(btrim(coalesce(requested_administrator_email, '')));
  application identity.organization_applications%rowtype;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'Organization enrollment context is required';
  end if;

  perform platform.require_control_enabled('provider_self_service_enabled');

  if requested_product is null
     or requested_product not in ('ehr', 'migrate', 'laboratory', 'pharmacy')
     or requested_organization_type is null
     or requested_organization_type not in ('clinic', 'hospital', 'laboratory', 'pharmacy', 'other')
     or normalized_cac !~ '^(RC|BN|IT)[0-9]{4,20}$'
     or length(btrim(coalesce(requested_administrator_name, ''))) not between 2 and 200
     or length(normalized_email) not between 3 and 254
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception using errcode = '22023', message = 'Invalid provider enrollment';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('org-application:' || normalized_cac || ':' || requested_product, 0)
  );

  perform identity.lapse_stale_self_service_organization_application(normalized_cac, requested_product);

  select * into application
    from identity.organization_applications row
   where row.cac_registration_number = normalized_cac
     and row.product_code = requested_product
     and row.status <> 'rejected'
   order by row.created_at desc
   limit 1
   for update;

  if found then
    if application.approval_mode <> 'self_service'
       or lower(application.administrator_email) <> normalized_email then
      raise exception using errcode = '23514',
        message = 'This organization application requires manual resolution';
    end if;
    if application.status = 'approved' then
      raise exception using errcode = '23514',
        message = 'This CAC is already registered with HID';
    end if;
    return application.id;
  end if;

  insert into identity.organization_applications (
    product_code, organization_name, organization_type, cac_registration_number,
    administrator_name, administrator_email, approval_mode
  ) values (
    requested_product, 'Pending CAC verification', requested_organization_type,
    normalized_cac, btrim(requested_administrator_name), normalized_email, 'self_service'
  ) returning * into application;

  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'system',
    'identity.organization.self-service.submit', 'success',
    'organization-application', application.id::text,
    'application', 'identity-api',
    jsonb_build_object(
      'productCode', requested_product,
      'organizationType', requested_organization_type
    )
  );

  return application.id;
end;
$$;

-- The Identity runtime activates through this command rather than calling the
-- activation function directly. It returns the new login email from the same
-- transaction, so the API never reads application or challenge tables and can
-- never report a failure after the organization, facility, membership and
-- account have been committed (main 0062, 46a173f). A1: the control first.
create function identity.activate_self_service_provider_enrollment(
  requested_session_hmac char(64),
  requested_password_hash text
) returns table (
  organization_id uuid,
  facility_id uuid,
  account_id uuid,
  row_version bigint,
  hid_subject text,
  account_email text
)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  activated record;
  activated_email text;
begin
  perform platform.require_control_enabled('provider_self_service_enabled');

  select * into activated
    from identity.activate_self_service_organization_application(
      requested_session_hmac, requested_password_hash);

  select account.email into activated_email
    from auth.accounts account
   where account.id = activated.account_id;

  if activated_email is null then
    raise exception using errcode = 'P0002', message = 'Activated provider account was not found';
  end if;

  return query select activated.organization_id, activated.facility_id, activated.account_id,
    activated.row_version, activated.hid_subject, activated_email;
end;
$$;

-- C9: the governed submit (0052) lapses a stale self-service application the
-- same way before it looks for an open application, so neither path stays
-- blocked by an abandoned self-service row. Otherwise 0052's body, signature,
-- owner and grants are unchanged.
create or replace function identity.submit_organization_application(
  requested_product text,
  requested_organization_type text,
  requested_cac_number text,
  requested_administrator_name text,
  requested_administrator_email text
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, identity, audit, platform, pg_temp
as $$
declare
  normalized_cac text := upper(regexp_replace(coalesce(requested_cac_number, ''), '[[:space:]]+', '', 'g'));
  normalized_email text := lower(btrim(coalesce(requested_administrator_email, '')));
  application_id_value uuid;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'Organization application context is required';
  end if;
  if requested_product is null
     or requested_product not in ('ehr', 'migrate', 'laboratory', 'pharmacy')
     or requested_organization_type is null
     or requested_organization_type not in ('clinic', 'hospital', 'laboratory', 'pharmacy', 'other')
     or normalized_cac !~ '^(RC|BN|IT)[0-9]{4,20}$'
     or length(btrim(coalesce(requested_administrator_name, ''))) not between 2 and 200
     or length(normalized_email) not between 3 and 254
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception using errcode = '22023', message = 'Invalid organization application';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('org-application:' || normalized_cac || ':' || requested_product, 0));
  perform identity.lapse_stale_self_service_organization_application(normalized_cac, requested_product);
  select application.id into application_id_value
    from identity.organization_applications application
   where application.cac_registration_number = normalized_cac
     and application.product_code = requested_product
     and application.status <> 'rejected';
  if application_id_value is not null then return application_id_value; end if;

  insert into identity.organization_applications (
    product_code, organization_type, cac_registration_number,
    administrator_name, administrator_email
  ) values (
    requested_product, requested_organization_type, normalized_cac,
    btrim(requested_administrator_name), normalized_email
  ) returning id into application_id_value;

  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'system', 'identity.organization.application.submit',
    'success', 'organization-application', application_id_value::text,
    'application', 'identity-api', jsonb_build_object(
      'productCode', requested_product, 'organizationType', requested_organization_type)
  );
  return application_id_value;
end;
$$;

revoke all on function identity.public_get_organization_application(text,text,text),
  identity.public_record_organization_cac_result(uuid,bigint,text,text,text,text,text,text,text,text),
  identity.activate_self_service_organization_application(char,text),
  identity.lapse_stale_self_service_organization_application(text,text),
  identity.submit_self_service_organization_application(text,text,text,text,text),
  identity.activate_self_service_provider_enrollment(char,text)
  from public;

-- 3. QoreID CAC lookup quota for accountless self-service (main 0063, 08c906f).
-- The lookup is charged to a keyed digest of the client network (5 an hour,
-- 15 a day), to the application's 0049 daily CAC counter shared with the
-- reviewed path (3 a day) and (A6) to a platform-wide daily counter whose
-- limit Identity passes (PROVIDER_SELF_SERVICE_QOREID_DAILY_CAP, 1-100000).
-- Request fields cannot select or reset a scope. No CAC number, raw IP, email
-- or provider payload is stored. Every decision is audited, including denials.
create table platform.self_service_cac_quota_counters (
  network_digest char(64) not null check (network_digest ~ '^[a-f0-9]{64}$'),
  bucket_period text not null check (bucket_period in ('hour', 'day')),
  bucket_start timestamptz not null,
  attempt_count integer not null check (attempt_count between 1 and 1000000),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (network_digest, bucket_period, bucket_start)
);
create index self_service_cac_quota_expiry_idx on platform.self_service_cac_quota_counters(bucket_start);
alter table platform.self_service_cac_quota_counters enable row level security;
alter table platform.self_service_cac_quota_counters force row level security;
-- As in 0049, the security-definer command is the only runtime access path.
create policy self_service_cac_quota_command_read on platform.self_service_cac_quota_counters
  for select using (true);
create policy self_service_cac_quota_command_insert on platform.self_service_cac_quota_counters
  for insert with check (true);
create policy self_service_cac_quota_command_update on platform.self_service_cac_quota_counters
  for update using (true) with check (true);
create policy self_service_cac_quota_command_delete on platform.self_service_cac_quota_counters
  for delete using (true);
revoke all on platform.self_service_cac_quota_counters from public;

-- A6: one row per day across every self-service applicant. Its primary key
-- is the expiry index.
create table platform.self_service_cac_platform_quota_counters (
  bucket_start timestamptz primary key,
  attempt_count integer not null check (attempt_count between 1 and 1000000),
  updated_at timestamptz not null default clock_timestamp()
);
alter table platform.self_service_cac_platform_quota_counters enable row level security;
alter table platform.self_service_cac_platform_quota_counters force row level security;
create policy self_service_cac_platform_quota_command_read on platform.self_service_cac_platform_quota_counters
  for select using (true);
create policy self_service_cac_platform_quota_command_insert on platform.self_service_cac_platform_quota_counters
  for insert with check (true);
create policy self_service_cac_platform_quota_command_update on platform.self_service_cac_platform_quota_counters
  for update using (true) with check (true);
create policy self_service_cac_platform_quota_command_delete on platform.self_service_cac_platform_quota_counters
  for delete using (true);
revoke all on platform.self_service_cac_platform_quota_counters from public;

-- Returns true when the lookup may proceed. A denial returns false rather than
-- raising, so its audit event commits while every counter stays unchanged.
-- The platform day is charged last, so a network or application denial is
-- reported as such and never spends the platform's lookups.
create function platform.consume_self_service_cac_quota(
  requested_application uuid,
  requested_network_digest char(64),
  platform_daily_limit integer
) returns boolean
language plpgsql security definer
set search_path = pg_catalog, platform, identity, audit, pg_temp
as $$
declare
  quota record;
  new_attempts integer;
  exhausted_limit text;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null
     or platform.current_account_id() is not null
     or requested_application is null
     or requested_network_digest is null
     or requested_network_digest !~ '^[a-f0-9]{64}$'
     or not exists (
       select 1 from identity.organization_applications application
        where application.id = requested_application
          and application.approval_mode = 'self_service'
          and application.status = 'pending_verification'
     ) then
    raise exception using errcode = '42501', message = 'QOREID_QUOTA_PERMISSION_DENIED';
  end if;
  if platform_daily_limit is null or platform_daily_limit not between 1 and 100000 then
    raise exception using errcode = '22023', message = 'QOREID_QUOTA_LIMIT_INVALID';
  end if;

  delete from platform.self_service_cac_quota_counters old
   where old.ctid in (select stale.ctid from platform.self_service_cac_quota_counters stale
     where stale.bucket_start < statement_timestamp() - interval '48 hours'
     order by stale.bucket_start limit 100);
  delete from platform.self_service_cac_platform_quota_counters old
   where old.bucket_start < statement_timestamp() - interval '48 hours';

  begin
    for quota in
      select * from (values
        ('network_hour'::text, 'hour'::text, date_trunc('hour', statement_timestamp()), 5),
        ('network_day'::text, 'day'::text, date_trunc('day', statement_timestamp()), 15)
      ) as limits(limit_name, bucket_period, bucket_start, max_attempts)
    loop
      insert into platform.self_service_cac_quota_counters as counter
        (network_digest, bucket_period, bucket_start, attempt_count)
      values (requested_network_digest, quota.bucket_period, quota.bucket_start, 1)
      on conflict (network_digest, bucket_period, bucket_start)
      do update set attempt_count = counter.attempt_count + 1, updated_at = clock_timestamp()
        where counter.attempt_count < quota.max_attempts
      returning attempt_count into new_attempts;
      if not found then
        exhausted_limit := quota.limit_name;
        raise exception using errcode = 'P4290', message = 'QOREID_QUOTA_EXCEEDED';
      end if;
    end loop;

    -- The same per-application row and limit 0049 uses for `application_cac`.
    insert into platform.qoreid_quota_counters as counter
      (operation, scope_type, scope_id, bucket_period, bucket_start, attempt_count)
    values ('application_cac', 'target', requested_application, 'day',
      date_trunc('day', statement_timestamp()), 1)
    on conflict (operation, scope_type, scope_id, bucket_period, bucket_start)
    do update set attempt_count = counter.attempt_count + 1, updated_at = clock_timestamp()
      where counter.attempt_count < 3
    returning attempt_count into new_attempts;
    if not found then
      exhausted_limit := 'application_day';
      raise exception using errcode = 'P4290', message = 'QOREID_QUOTA_EXCEEDED';
    end if;

    insert into platform.self_service_cac_platform_quota_counters as counter
      (bucket_start, attempt_count)
    values (date_trunc('day', statement_timestamp()), 1)
    on conflict (bucket_start)
    do update set attempt_count = counter.attempt_count + 1, updated_at = clock_timestamp()
      where counter.attempt_count < platform_daily_limit
    returning attempt_count into new_attempts;
    if not found then
      exhausted_limit := 'platform_day';
      raise exception using errcode = 'P4290', message = 'QOREID_QUOTA_EXCEEDED';
    end if;
  exception when sqlstate 'P4290' then
    -- Leaving the block rolls back any increment made before the exhausted scope.
    null;
  end;

  insert into audit.events (
    correlation_id, actor_type, action, outcome, resource_type, resource_id,
    provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'system',
    'identity.organization.self-service.cac-quota',
    case when exhausted_limit is null then 'success' else 'denied' end,
    'organization-application', requested_application::text,
    'application', 'identity-api',
    jsonb_build_object('operation', 'self_service_cac', 'exhaustedLimit', exhausted_limit,
      'networkDigest', requested_network_digest, 'platformDailyLimit', platform_daily_limit)
  );

  return exhausted_limit is null;
end
$$;

revoke all on function platform.consume_self_service_cac_quota(uuid,char,integer) from public;

-- A4 (C11): the hourly prune keeps the body live at merge, 0049's, and also
-- drains this migration's two counter tables. Refuse to run if another
-- migration already changed which tables it prunes, rather than drop them.
do $$
declare
  pruned text[];
begin
  select array_agg(distinct match[1] order by match[1]) into pruned
    from pg_proc proc, regexp_matches(proc.prosrc, 'delete from platform\.([a-z_]+)', 'g') match
   where proc.oid = 'platform.prune_verification_quotas()'::regprocedure;
  if pruned is distinct from array['public_application_quota_counters', 'qoreid_quota_counters',
       'qoreid_test_quota_reservations']::text[] then
    raise exception '0086 expected platform.prune_verification_quotas to prune exactly the 0049 tables, found %', pruned;
  end if;
end
$$;

create or replace function platform.prune_verification_quotas() returns integer
language plpgsql security definer
set search_path = pg_catalog, platform, pg_temp
as $$
declare
  deleted_count integer := 0;
  batch_count integer;
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null then
    raise exception using errcode = '42501', message = 'QOREID_QUOTA_PERMISSION_DENIED';
  end if;
  delete from platform.qoreid_quota_counters
    where bucket_start < statement_timestamp() - interval '48 hours';
  get diagnostics batch_count = row_count;
  deleted_count := deleted_count + batch_count;
  delete from platform.qoreid_test_quota_reservations
    where reserved_at < statement_timestamp() - interval '48 hours';
  get diagnostics batch_count = row_count;
  deleted_count := deleted_count + batch_count;
  delete from platform.public_application_quota_counters
    where bucket_start < statement_timestamp() - interval '48 hours';
  get diagnostics batch_count = row_count;
  deleted_count := deleted_count + batch_count;
  delete from platform.self_service_cac_quota_counters
    where bucket_start < statement_timestamp() - interval '48 hours';
  get diagnostics batch_count = row_count;
  deleted_count := deleted_count + batch_count;
  delete from platform.self_service_cac_platform_quota_counters
    where bucket_start < statement_timestamp() - interval '48 hours';
  get diagnostics batch_count = row_count;
  return deleted_count + batch_count;
end
$$;
revoke all on function platform.prune_verification_quotas() from public;

-- 4. Support's review of activated self-service facilities (owner decision of
-- 2026-10-24). An activated self-service application is an approved
-- self-service application without a human reviewer: the activation command
-- approves it with reviewed_by_account_id null; an administrator's approval
-- of a self-service row always names the administrator.
--
-- Permission and context are those of the governed application commands
-- (0046): a platform account (resolved from the actor subject), a correlation
-- ID, the healthcare-operations purpose of use, platform.identity-review.read
-- to list and platform.facility.manage to review. Unlike them, and like 0064's
-- standalone administration commands, no facility membership is required,
-- because Identity's administrators sign in as staff sessions without one.
-- Refusals raise 42501 ADMIN_PERMISSION_DENIED.
create function identity.admin_list_self_service_facilities(requested_state text)
returns table (
  application_id uuid,
  row_version bigint,
  organization_id uuid,
  organization_name text,
  facility_id uuid,
  facility_name text,
  facility_lifecycle_status text,
  product_code text,
  organization_type text,
  cac_hint text,
  administrator_name text,
  administrator_email text,
  administrator_account_id uuid,
  administrator_account_status text,
  activated_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by_account_id uuid,
  review_note text
)
language plpgsql stable security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
begin
  if actor_account is null
     or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not auth.account_has_platform_permission(actor_account, 'platform.identity-review.read') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  if requested_state is null or requested_state not in ('unreviewed', 'reviewed', 'all') then
    raise exception using errcode = '22023', message = 'SELF_SERVICE_FACILITY_STATE_INVALID';
  end if;
  return query
    select app.id, app.row_version, app.organization_id, app.verified_organization_name,
      app.facility_id, facility.name, facility.lifecycle_status, app.product_code,
      app.organization_type,
      left(app.cac_registration_number, 2)
        || repeat('*', length(app.cac_registration_number) - 4)
        || right(app.cac_registration_number, 2),
      app.administrator_name, app.administrator_email,
      app.first_admin_account_id, account.status,
      app.reviewed_at, app.self_service_reviewed_at,
      app.self_service_reviewed_by_account_id, app.self_service_review_note
    from identity.organization_applications app
    left join identity.facilities facility on facility.id = app.facility_id
    left join auth.accounts account on account.id = app.first_admin_account_id
    where app.approval_mode = 'self_service'
      and app.status = 'approved'
      and app.reviewed_by_account_id is null
      and (requested_state = 'all'
        or (requested_state = 'unreviewed' and app.self_service_reviewed_at is null)
        or (requested_state = 'reviewed' and app.self_service_reviewed_at is not null))
    order by app.reviewed_at desc, app.id desc
    limit 200;
end;
$$;

-- Records support's review once, at the expected application version, and
-- audits it as the platform administrator (the actor's facility, membership
-- and organization are left out, as audit_platform_scope_ck requires; the
-- reviewed organization and facility are in the details).
create function identity.admin_review_self_service_facility(
  target_application_id uuid,
  expected_version bigint,
  review_note text
) returns table (
  application_id uuid,
  reviewed_at timestamptz,
  row_version bigint
)
language plpgsql security definer
set search_path = pg_catalog, identity, auth, audit, platform, pg_temp
as $$
declare
  actor_account uuid := platform.current_account_id();
  note text := btrim(coalesce(review_note, ''));
  current_row identity.organization_applications%rowtype;
begin
  if actor_account is null
     or platform.current_correlation_id() is null
     or platform.current_purpose_of_use() is distinct from 'healthcare-operations'
     or not auth.account_has_platform_permission(actor_account, 'platform.admin.access')
     or not auth.account_has_platform_permission(actor_account, 'platform.facility.manage') then
    raise exception using errcode = '42501', message = 'ADMIN_PERMISSION_DENIED';
  end if;
  if target_application_id is null or expected_version is null
     or length(note) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'SELF_SERVICE_REVIEW_INVALID';
  end if;

  select * into current_row
    from identity.organization_applications app
   where app.id = target_application_id
   for no key update;
  if not found
     or current_row.approval_mode <> 'self_service'
     or current_row.status <> 'approved'
     or current_row.reviewed_by_account_id is not null then
    raise exception using errcode = 'P0002', message = 'SELF_SERVICE_FACILITY_NOT_FOUND';
  end if;
  if current_row.self_service_reviewed_at is not null then
    raise exception using errcode = '23505', message = 'SELF_SERVICE_FACILITY_ALREADY_REVIEWED';
  end if;
  if current_row.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'Organization application version conflict';
  end if;

  update identity.organization_applications app
     set self_service_reviewed_at = clock_timestamp(),
         self_service_reviewed_by_account_id = actor_account,
         self_service_review_note = note,
         updated_at = clock_timestamp(),
         row_version = app.row_version + 1
   where app.id = current_row.id
   returning app.* into current_row;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, action, outcome,
    resource_type, resource_id, purpose_of_use, reason, provenance, source_system, details
  ) values (
    platform.current_correlation_id(), 'platform', platform.current_actor_subject(), actor_account,
    'admin.self-service-facility.review', 'success',
    'organization-application', current_row.id::text, 'healthcare-operations', note,
    'application', 'identity-api',
    jsonb_build_object('productCode', current_row.product_code,
      'organizationId', current_row.organization_id, 'facilityId', current_row.facility_id,
      'administratorAccountId', current_row.first_admin_account_id,
      'version', current_row.row_version)
  );

  return query select current_row.id, current_row.self_service_reviewed_at, current_row.row_version;
end;
$$;

revoke all on function identity.admin_list_self_service_facilities(text),
  identity.admin_review_self_service_facility(uuid,bigint,text)
  from public;

-- 5. Runtime grants (A5). runtime-grants.sql carries the same grants for a
-- later role bootstrap; this grants them to the roles that already exist,
-- since a release applies only migrations. The owner-only activation and the
-- lapse helper are granted to no role, and no role receives a privilege on
-- the counter tables. hid_identity_api_runtime inherits hid_identity_runtime.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant execute on function identity.submit_self_service_organization_application(text,text,text,text,text),
      identity.public_get_organization_application(text,text,text),
      identity.public_record_organization_cac_result(uuid,bigint,text,text,text,text,text,text,text,text),
      identity.activate_self_service_provider_enrollment(char,text),
      platform.consume_self_service_cac_quota(uuid,char,integer),
      identity.admin_list_self_service_facilities(text),
      identity.admin_review_self_service_facility(uuid,bigint,text)
      to hid_identity_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_schema_test_runtime') then
    grant execute on function identity.submit_self_service_organization_application(text,text,text,text,text),
      identity.public_get_organization_application(text,text,text),
      identity.public_record_organization_cac_result(uuid,bigint,text,text,text,text,text,text,text,text),
      identity.activate_self_service_provider_enrollment(char,text),
      platform.consume_self_service_cac_quota(uuid,char,integer)
      to hid_schema_test_runtime;
  end if;
end
$$;

-- 6. The control (last). These statements take ACCESS EXCLUSIVE on
-- platform.control_settings, which every non-admin authenticated request
-- reads through platform.control_enabled, and hold it until commit; nothing
-- follows them. The live key list is asserted first (C10): the CHECK
-- constraint and platform.control_enabled must name exactly the six keys of
-- 0039 and 0040, as this branch has them, so a migration that changed either
-- first makes this one stop instead of dropping its key. Every later control
-- migration must carry provider_self_service_enabled in its CHECK and in
-- control_enabled.
do $$
declare
  live_keys constant text[] := array['break_glass_enabled', 'maintenance_mode', 'outreach_portal_enabled',
    'patient_portal_enabled', 'provider_portal_enabled', 'uploads_enabled'];
  matching record;
  matched integer := 0;
  constraint_name name;
  check_keys text[];
  function_keys text[];
begin
  for matching in
    select constraint_row.conname, pg_get_constraintdef(constraint_row.oid) as definition
      from pg_constraint constraint_row
     where constraint_row.conrelid = 'platform.control_settings'::regclass
       and constraint_row.contype = 'c'
       and pg_get_constraintdef(constraint_row.oid) like '%control_key%'
  loop
    matched := matched + 1;
    constraint_name := matching.conname;
    select array_agg(distinct match[1] order by match[1]) into check_keys
      from regexp_matches(matching.definition, '''([a-z_]+)''', 'g') match;
  end loop;
  if matched <> 1 or check_keys is distinct from live_keys then
    raise exception '0086 expected one control_key check on platform.control_settings with the six live keys, found % with %',
      matched, check_keys;
  end if;
  select array_agg(distinct match[1] order by match[1]) into function_keys
    from pg_proc proc, regexp_matches(proc.prosrc, '''([a-z_]+)''', 'g') match
   where proc.oid = 'platform.control_enabled(text)'::regprocedure;
  if function_keys is distinct from live_keys then
    raise exception '0086 expected platform.control_enabled to accept the six live keys, found %', function_keys;
  end if;
  execute format('alter table platform.control_settings drop constraint %I', constraint_name);
end
$$;

alter table platform.control_settings add constraint control_settings_control_key_check check (control_key in (
  'patient_portal_enabled', 'provider_portal_enabled', 'outreach_portal_enabled',
  'maintenance_mode', 'uploads_enabled', 'break_glass_enabled', 'provider_self_service_enabled'
));

-- The seed (C2, as main 0098 does): the table forces row-level security and
-- has no INSERT policy, so forcing is lifted for this transaction only and
-- restored before anything else is touched. Off: an administrator opens
-- facility self sign-up with the audited admin command.
alter table platform.control_settings no force row level security;
insert into platform.control_settings (control_key, enabled, reason, updated_by)
values ('provider_self_service_enabled', false,
  'Facility self sign-up ships closed (P4); enable by audited admin command', null)
on conflict do nothing;
alter table platform.control_settings force row level security;

-- 0040's body, language, volatility, security and search path, with the new
-- key added. CREATE OR REPLACE keeps the owner and the ACL (EXECUTE to PUBLIC).
-- platform.require_control_enabled and platform.admin_set_control (0078, which
-- validates the key by its row) need no change.
create or replace function platform.control_enabled(requested_key text)
returns boolean
language plpgsql
stable
security definer
set search_path=platform,pg_catalog,pg_temp
as $$
declare enabled_state boolean;
begin
  if requested_key not in (
    'patient_portal_enabled','provider_portal_enabled','outreach_portal_enabled',
    'maintenance_mode','uploads_enabled','break_glass_enabled','provider_self_service_enabled'
  ) then
    raise exception using errcode='22023', message='PLATFORM_CONTROL_INVALID';
  end if;

  select enabled into enabled_state
  from platform.control_settings
  where control_key = requested_key;

  if enabled_state is null then
    raise exception using errcode='55000', message='PLATFORM_CONTROL_UNAVAILABLE';
  end if;

  return enabled_state;
end
$$;
