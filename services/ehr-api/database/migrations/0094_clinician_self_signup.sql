-- Clinician self sign-up with two-admin approval (owner decision 2 of
-- 2026-10-14, "self sign-up + admin approval"; ADR-064, decision row
-- CLIN-SIGNUP, release rows P25 and S4y). Applied migrations 0001 through
-- 0093 are immutable. This extends ADR-049 (0087); it changes neither
-- NO-MEMBERSHIP-SIGN-IN nor staff MFA (ADR-054, 0088, P22).
--
-- A doctor (MDCN) or a nurse or midwife (NMCN) creates a Health ID account
-- by themselves: a work email proven by a six-digit code, a password, their
-- name, their licence and one verified facility. The submission creates an
-- active account with a 'pending' staff record and an application, and no
-- membership, role or session. The applicant then sets up an authenticator
-- through the unchanged 0088 staff enrolment (a second emailed code bound to
-- the factor's challenge); Identity drives that 0088 challenge itself and
-- never gives its token to the browser, so it never yields a session. Only
-- then can the application be reviewed. Two different platform Super Admins
-- who do not work at the facility review it:
--
-- * step 1 (under_review): the register check, a live video or in-person
--   check of a photo ID during which the applicant reads a current
--   authenticator code (Identity verifies it against the applicant's factor
--   before this command runs), an employment check through a channel
--   independent of the facility administrator, and the 0087 credential
--   attestation for exactly the requested role, capped at the end of the
--   licence's expiry date in Africa/Lagos;
-- * step 2 (approved): a different Super Admin attaches the account by id and
--   grants the role in one transaction, pinned to the step-1 attestation.
--
-- The two-person rule is enforced three times: the approve command refuses
-- the step-1 administrator (CLINICIAN_APPLICATION_SECOND_ADMIN_REQUIRED), a
-- table CHECK refuses approved_by = attested_by, and 0087's independent
-- reviewer rule runs inside the pinned grant.
--
-- Reserved attestations: until its application is approved, a step-1
-- attestation supports only that application's own pinned step 2 (its own
-- account at its own facility), while the application is under review and not
-- overdue (identity.workforce_attestation_usable, computed at read time). So no role
-- ever rests on it before approval, and rejecting, withdrawing or expiring an
-- application revokes nothing anywhere. identity.admin_change_workforce_role
-- keeps its signature, result, owner and grants and delegates to
-- identity.workforce_change_role, whose body is 0087's with exactly three
-- documented insertions (scripts/tests/workforce-role-change-body.test.mjs).
-- auth.facility_role_is_effective and auth.membership_has_permission are not
-- changed.
--
-- Intake starts closed: the platform control clinician_signup_enabled is
-- seeded off and is opened by an operator through POST /admin/controls after
-- release gate P25. Intake is also closed while provider_portal_enabled is off
-- or maintenance_mode is on.
--
-- platform.control_enabled keeps its technical owner. The role bootstrap
-- (runtime-grants.sql) gives it to hid_platform_control_reader, which the
-- migration administrator is not a member of on RDS. Replacing it needs the
-- owner's privileges, so this migration grants that role to the current user
-- (INHERIT, no SET) only when the current user has neither the owner's
-- privileges nor is the owner, revokes it again before the next statement
-- that touches a table, and fails if the owner changed or a membership is
-- left. It needs the ADMIN OPTION the role's creator holds.
--
-- Lock order. Each lock is held until commit; each statement waits at most the
-- runner's 5 s lock_timeout. A timeout or a deadlock rolls 0094 back whole and
-- it can be run again.
-- 1. platform.control_settings ACCESS EXCLUSIVE (section 1), first, as 0091
--    and the role bootstrap take it. No outbox table is locked, so 0094 cannot
--    deadlock with a break-glass activation.
-- 2. The function replacements (no table lock; the temporary membership
--    touches only pg_auth_members).
-- 3. The new tables' foreign keys take SHARE ROW EXCLUSIVE on, in this order,
--    auth.accounts, identity.facilities, identity.staff,
--    identity.staff_facility_memberships and
--    identity.staff_credential_attestations. Nothing references auth.mfa_* or
--    auth.account_roles.
-- 4. Functions and the workforce redefinitions (no table lock).

-- 1. The platform control.
lock table platform.control_settings in access exclusive mode;

do $$
declare
  matching record;
  matched integer := 0;
  constraint_name name;
begin
  for matching in
    select constraint_row.conname, pg_get_constraintdef(constraint_row.oid) as definition
      from pg_constraint constraint_row
     where constraint_row.conrelid = 'platform.control_settings'::regclass
       and constraint_row.contype = 'c'
       and pg_get_constraintdef(constraint_row.oid) like '%control_key%'
  loop
    if matching.definition like '%''patient_portal_enabled''%'
       and matching.definition like '%''provider_portal_enabled''%'
       and matching.definition like '%''outreach_portal_enabled''%'
       and matching.definition like '%''maintenance_mode''%'
       and matching.definition like '%''uploads_enabled''%'
       and matching.definition like '%''break_glass_enabled''%'
       and matching.definition not like '%''clinician_signup_enabled''%' then
      matched := matched + 1;
      constraint_name := matching.conname;
    end if;
  end loop;
  if matched <> 1 then
    raise exception '0094 expected one control_key check on platform.control_settings with the six 0039 keys, found %',
      matched;
  end if;
  execute format('alter table platform.control_settings drop constraint %I', constraint_name);
end
$$;

alter table platform.control_settings add constraint control_settings_control_key_check check (control_key in (
  'patient_portal_enabled', 'provider_portal_enabled', 'outreach_portal_enabled',
  'maintenance_mode', 'uploads_enabled', 'break_glass_enabled', 'clinician_signup_enabled'
));

-- platform.control_enabled keeps its technical owner (P1 of the design). The
-- membership is taken only when the current user is not the owner and lacks
-- its privileges: a chain migrated before the first role bootstrap owns the
-- function itself, and a superuser has every role's privileges. The owner's
-- plain name is read (pg_get_userbyid): a regrole cast quotes a name that
-- needs quoting, which would then compare unequal to current_user and name no
-- role in pg_has_role or the grant.
do $$
declare
  owner_name name;
begin
  select pg_get_userbyid(proc.proowner) into owner_name
    from pg_proc proc where proc.oid = 'platform.control_enabled(text)'::regprocedure;
  perform set_config('hid.m0094_control_owner', owner_name, true);
  perform set_config('hid.m0094_owner_grant', '', true);
  if owner_name <> current_user and not pg_has_role(current_user, owner_name, 'USAGE') then
    if not pg_has_role(current_user, owner_name, 'MEMBER WITH ADMIN OPTION') then
      raise exception '0094 needs ADMIN OPTION on % to replace platform.control_enabled', owner_name;
    end if;
    execute format('grant %I to current_user with inherit true, set false', owner_name);
    perform set_config('hid.m0094_owner_grant', owner_name, true);
  end if;
end
$$;

-- 0040's body, language, volatility, security and search path, with the new
-- key added. CREATE OR REPLACE keeps the owner and the ACL (EXECUTE to PUBLIC).
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
    'maintenance_mode','uploads_enabled','break_glass_enabled','clinician_signup_enabled'
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

do $$
declare
  granted text := nullif(current_setting('hid.m0094_owner_grant', true), '');
begin
  if granted is not null then
    execute format('revoke %I from current_user', granted);
  end if;
  if (select pg_get_userbyid(proc.proowner) from pg_proc proc
        where proc.oid = 'platform.control_enabled(text)'::regprocedure)
       <> current_setting('hid.m0094_control_owner')
     or exists (
       select 1 from pg_auth_members membership
        where membership.member = (select role_row.oid from pg_roles role_row where role_row.rolname = current_user)
          and membership.roleid = (select proc.proowner from pg_proc proc
                                    where proc.oid = 'platform.control_enabled(text)'::regprocedure)
          and membership.roleid <> (select role_row.oid from pg_roles role_row where role_row.rolname = current_user)
          and (membership.inherit_option or membership.set_option)) then
    raise exception '0094 changed the owner of platform.control_enabled or left a temporary membership';
  end if;
end
$$;

-- 0071's body with the new key. Owned by the migration administrator (the
-- role bootstrap transfers only control_enabled among the control functions).
create or replace function platform.admin_set_control(
 requested_key text, requested_enabled boolean, expected_version bigint, requested_reason text)
returns table(control_key text,enabled boolean,row_version bigint,replayed boolean)
language plpgsql security definer
set search_path=platform,auth,pg_temp
as $$
declare actor uuid:=platform.current_account_id(); current_row platform.control_settings%rowtype;
begin
 if not auth.account_has_platform_permission(actor,'platform.control.manage') then
   raise exception using errcode='42501',message='ADMIN_PERMISSION_DENIED';
 end if;
 if requested_key not in ('patient_portal_enabled','provider_portal_enabled','outreach_portal_enabled','maintenance_mode','uploads_enabled','break_glass_enabled','clinician_signup_enabled')
    or requested_reason is null or length(btrim(requested_reason))<8 then
   raise exception using errcode='22023',message='ADMIN_INVALID_CONTROL';
 end if;
 select * into current_row from platform.control_settings setting
 where setting.control_key=requested_key for update;
 if current_row.row_version<>expected_version then
   raise exception using errcode='40001',message='ADMIN_VERSION_CONFLICT';
 end if;
 if current_row.enabled=requested_enabled then
   return query select current_row.control_key,current_row.enabled,current_row.row_version,true; return;
 end if;
 update platform.control_settings setting set enabled=requested_enabled,reason=btrim(requested_reason),
   row_version=setting.row_version+1,updated_by=actor,updated_at=clock_timestamp()
 where setting.control_key=requested_key returning setting.* into current_row;
 insert into platform.control_events(control_key,previous_enabled,enabled,reason,actor_account_id,correlation_id)
 values(current_row.control_key,not current_row.enabled,current_row.enabled,current_row.reason,actor,platform.current_correlation_id());
 return query select current_row.control_key,current_row.enabled,current_row.row_version,false;
end $$;

-- The seed, as 0091 section 1 changes control rows: forced row-level
-- security is lifted for this transaction only, since its policies need a
-- platform account, and restored before any other table is touched.
alter table platform.control_settings no force row level security;
insert into platform.control_settings (control_key, enabled, reason, updated_by)
values ('clinician_signup_enabled', false,
  'Off until an administrator opens clinician self sign-up (0094, ADR-064)', null)
on conflict do nothing;
alter table platform.control_settings force row level security;

-- 2. Tables. RLS is enabled with no policy on the application, challenge,
-- capability and idempotency tables: the definer commands below, owned by the
-- migration administrator, are the only path, as 0087's are. No runtime holds
-- a privilege on any of them (runtime-grants.sql).

-- The canonical licence key: the regulator, then the letters and digits of the
-- licence number in upper case, without a leading copy of the regulator code.
-- 'MDCN/12345', 'mdcn 12345' and '12345' are all MDCN:12345 for MDCN.
create function identity.clinician_licence_key(regulator text, licence text)
returns text
language sql
immutable
strict
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select regulator || ':' || case
    when left(compact.value, length(regulator)) = regulator then substr(compact.value, length(regulator) + 1)
    else compact.value end
  from (select regexp_replace(upper(licence), '[^A-Z0-9]', '', 'g') as value) compact
$$;
revoke all on function identity.clinician_licence_key(text, text) from public;

create table identity.clinician_applications (
  id uuid primary key,
  account_id uuid not null references auth.accounts(id) on delete restrict,
  staff_id uuid not null,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  requested_role text not null check (requested_role in ('doctor', 'nurse')),
  regulator_code text not null check (regulator_code in ('MDCN', 'NMCN')),
  issuing_authority text not null check (length(btrim(issuing_authority)) between 2 and 200),
  licence_number text not null check (licence_number ~ '^[A-Z0-9][A-Z0-9/. -]{1,98}[A-Z0-9]$'
    and licence_number !~ '  '),
  licence_key text generated always as (identity.clinician_licence_key(regulator_code, licence_number)) stored,
  licence_valid_until date not null,
  applicant_full_name text not null check (length(btrim(applicant_full_name)) between 2 and 200),
  state text not null check (state in ('awaiting_authenticator', 'submitted', 'under_review', 'approved',
    'rejected', 'withdrawn', 'expired')),
  submitted_at timestamptz not null,
  expires_at timestamptz not null,
  authenticator_ready_at timestamptz,
  attested_by uuid references auth.accounts(id) on delete restrict,
  attested_at timestamptz,
  attestation_id uuid,
  attestation_checklist jsonb,
  factor_id uuid,
  factor_confirmed_at timestamptz,
  approved_by uuid references auth.accounts(id) on delete restrict,
  approved_at timestamptz,
  membership_id uuid,
  decided_by uuid references auth.accounts(id) on delete restrict,
  decided_at timestamptz,
  decision_code text check (decision_code in ('licence_not_verified', 'licence_not_current', 'details_mismatch',
    'identity_not_confirmed', 'employment_not_confirmed', 'facility_not_available', 'duplicate',
    'existing_account', 'other')),
  decision_reason text check (length(btrim(decision_reason)) between 8 and 500),
  withdrawn_at timestamptz,
  expired_at timestamptz,
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  updated_at timestamptz not null,
  row_version bigint not null default 1 check (row_version > 0),
  foreign key (staff_id, account_id) references identity.staff(id, account_id) on delete restrict,
  foreign key (membership_id) references identity.staff_facility_memberships(id) on delete restrict,
  foreign key (attestation_id, account_id)
    references identity.staff_credential_attestations(id, account_id) on delete restrict,
  constraint clinician_applications_role_regulator_check check (
    (requested_role = 'doctor' and regulator_code = 'MDCN') or (requested_role = 'nurse' and regulator_code = 'NMCN')),
  constraint clinician_applications_licence_key_check check (licence_key ~ '^(MDCN|NMCN):[A-Z0-9]{1,100}$'),
  constraint clinician_applications_expiry_check check (expires_at = submitted_at + interval '30 days'),
  constraint clinician_applications_checklist_check check (
    attestation_checklist is null or jsonb_typeof(attestation_checklist) = 'object'),
  constraint clinician_applications_attestation_pairing_check check (
    (attested_by is null) = (attested_at is null)
    and (attested_at is null) = (attestation_id is null)
    and (attestation_id is null) = (attestation_checklist is null)
    and (attestation_checklist is null) = (factor_id is null)
    and (factor_id is null) = (factor_confirmed_at is null)),
  constraint clinician_applications_approval_pairing_check check (
    (approved_by is null) = (approved_at is null) and (approved_at is null) = (membership_id is null)),
  constraint clinician_applications_decision_pairing_check check (
    (decided_by is null) = (decided_at is null)
    and (decided_at is null) = (decision_code is null)
    and (decision_code is null) = (decision_reason is null)),
  constraint clinician_applications_not_self_check check (
    attested_by is distinct from account_id and approved_by is distinct from account_id
    and decided_by is distinct from account_id),
  -- The two-person rule: whoever approves did not record step 1.
  constraint clinician_applications_two_person_check check (
    approved_by is null or (attested_by is not null and approved_by <> attested_by)),
  constraint clinician_applications_lifecycle_check check (
    (state = 'awaiting_authenticator' and authenticator_ready_at is null and attested_at is null
      and approved_at is null and decided_at is null and withdrawn_at is null and expired_at is null)
    or (state = 'submitted' and authenticator_ready_at is not null and attested_at is null
      and approved_at is null and decided_at is null and withdrawn_at is null and expired_at is null)
    or (state = 'under_review' and authenticator_ready_at is not null and attested_at is not null
      and approved_at is null and decided_at is null and withdrawn_at is null and expired_at is null)
    or (state = 'approved' and authenticator_ready_at is not null and attested_at is not null
      and approved_at is not null and decided_at is null and withdrawn_at is null and expired_at is null)
    or (state = 'rejected' and decided_at is not null
      and approved_at is null and withdrawn_at is null and expired_at is null)
    or (state = 'withdrawn' and withdrawn_at is not null
      and approved_at is null and decided_at is null and expired_at is null)
    or (state = 'expired' and expired_at is not null
      and approved_at is null and decided_at is null and withdrawn_at is null))
);
create unique index clinician_applications_one_open_uq on identity.clinician_applications (account_id, facility_id)
  where state in ('awaiting_authenticator', 'submitted', 'under_review');
create unique index clinician_applications_attestation_uq on identity.clinician_applications (attestation_id)
  where attestation_id is not null;
create index clinician_applications_queue_idx on identity.clinician_applications (state, submitted_at, id);
create index clinician_applications_account_idx on identity.clinician_applications (account_id, submitted_at desc);
create index clinician_applications_licence_key_idx on identity.clinician_applications (licence_key);
create index clinician_applications_due_idx on identity.clinician_applications (expires_at)
  where state in ('awaiting_authenticator', 'submitted', 'under_review');
create index clinician_applications_facility_open_idx on identity.clinician_applications (facility_id)
  where state in ('awaiting_authenticator', 'submitted', 'under_review');
alter table identity.clinician_applications enable row level security;
comment on table identity.clinician_applications is
  'Clinician self sign-up applications (0094, ADR-064). Written only by the clinician application commands; no runtime role reads it directly. A step-1 attestation is reserved for its application until approval.';

-- Only the state machine's transitions; identity, licence, facility and dates
-- never change; every recorded decision column is final.
create function identity.guard_clinician_application_change()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'CLINICIAN_APPLICATION_IMMUTABLE';
  end if;
  if new.id <> old.id or new.account_id <> old.account_id or new.staff_id <> old.staff_id
     or new.facility_id <> old.facility_id or new.requested_role <> old.requested_role
     or new.regulator_code <> old.regulator_code or new.issuing_authority <> old.issuing_authority
     or new.licence_number <> old.licence_number or new.licence_valid_until <> old.licence_valid_until
     or new.applicant_full_name <> old.applicant_full_name or new.submitted_at <> old.submitted_at
     or new.expires_at <> old.expires_at or new.correlation_id <> old.correlation_id
     or new.row_version <> old.row_version + 1
     or (old.authenticator_ready_at is not null and new.authenticator_ready_at is distinct from old.authenticator_ready_at)
     or (old.attested_by is not null and new.attested_by is distinct from old.attested_by)
     or (old.attested_at is not null and new.attested_at is distinct from old.attested_at)
     or (old.attestation_id is not null and new.attestation_id is distinct from old.attestation_id)
     or (old.attestation_checklist is not null and new.attestation_checklist is distinct from old.attestation_checklist)
     or (old.factor_id is not null and new.factor_id is distinct from old.factor_id)
     or (old.factor_confirmed_at is not null and new.factor_confirmed_at is distinct from old.factor_confirmed_at)
     or (old.approved_by is not null and new.approved_by is distinct from old.approved_by)
     or (old.approved_at is not null and new.approved_at is distinct from old.approved_at)
     or (old.membership_id is not null and new.membership_id is distinct from old.membership_id)
     or (old.decided_by is not null and new.decided_by is distinct from old.decided_by)
     or (old.decided_at is not null and new.decided_at is distinct from old.decided_at)
     or (old.decision_code is not null and new.decision_code is distinct from old.decision_code)
     or (old.decision_reason is not null and new.decision_reason is distinct from old.decision_reason)
     or (old.withdrawn_at is not null and new.withdrawn_at is distinct from old.withdrawn_at)
     or (old.expired_at is not null and new.expired_at is distinct from old.expired_at)
     or not (
       (old.state = 'awaiting_authenticator' and new.state in ('submitted', 'rejected', 'withdrawn', 'expired'))
       or (old.state = 'submitted' and new.state in ('under_review', 'rejected', 'withdrawn', 'expired'))
       or (old.state = 'under_review' and new.state in ('approved', 'rejected', 'withdrawn', 'expired'))) then
    raise exception using errcode = '55000', message = 'CLINICIAN_APPLICATION_IMMUTABLE';
  end if;
  return new;
end
$$;
revoke all on function identity.guard_clinician_application_change() from public;
create trigger clinician_applications_guard
  before update or delete on identity.clinician_applications
  for each row execute function identity.guard_clinician_application_change();

-- Email codes of the two public starts (sign-up and status). Only keyed
-- digests: no plaintext email is stored for anyone who has not submitted.
create table identity.clinician_application_challenges (
  id uuid primary key,
  purpose text not null check (purpose in ('signup', 'status')),
  email_hmac char(64) not null check (email_hmac ~ '^[0-9a-f]{64}$'),
  account_id uuid references auth.accounts(id) on delete restrict,
  code_hmac char(64) not null check (code_hmac ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 5),
  consumed_at timestamptz,
  invalidated_at timestamptz,
  constraint clinician_application_challenges_window_check check (expires_at = created_at + interval '10 minutes'),
  constraint clinician_application_challenges_account_check check (purpose = 'status' or account_id is null),
  constraint clinician_application_challenges_state_check check (not (consumed_at is not null and invalidated_at is not null))
);
create index clinician_application_challenges_email_idx
  on identity.clinician_application_challenges (purpose, email_hmac, created_at desc);
create index clinician_application_challenges_expiry_idx on identity.clinician_application_challenges (expires_at);
alter table identity.clinician_application_challenges enable row level security;
comment on table identity.clinician_application_challenges is
  'Email-code challenges of clinician sign-up and of the application status page (0094). A status challenge for an ineligible address is a decoy (no account) that can never verify.';

-- Application capabilities: a draft (a verified email, before submission) or
-- an account capability (an applicant reading or changing their own
-- applications). Never a session: no patient data, no staff authorization.
create table identity.clinician_application_sessions (
  id uuid primary key,
  token_hmac char(64) not null unique check (token_hmac ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('draft', 'account')),
  email_hmac char(64) check (email_hmac ~ '^[0-9a-f]{64}$'),
  challenge_id uuid references identity.clinician_application_challenges(id) on delete restrict,
  email_verified_at timestamptz,
  account_id uuid references auth.accounts(id) on delete restrict,
  stage text check (stage in ('enrolment_required', 'authenticator_required', 'ready')),
  mfa_challenge_id uuid,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  ended_at timestamptz,
  facility_searches integer not null default 0 check (facility_searches between 0 and 30),
  submit_idempotency_key text check (submit_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  submit_sha256 char(64) check (submit_sha256 ~ '^[0-9a-f]{64}$'),
  submit_response jsonb,
  constraint clinician_application_sessions_draft_check check (
    (kind = 'draft') = (email_hmac is not null and challenge_id is not null and email_verified_at is not null)),
  constraint clinician_application_sessions_account_check check (
    (kind = 'account') = (account_id is not null and stage is not null)),
  constraint clinician_application_sessions_window_check check (
    expires_at > created_at
    and expires_at <= created_at + case kind when 'draft' then interval '60 minutes' else interval '30 minutes' end),
  constraint clinician_application_sessions_consumed_check check (consumed_at is null or kind = 'draft'),
  constraint clinician_application_sessions_submit_check check (
    (submit_idempotency_key is null) = (submit_sha256 is null)
    and (submit_sha256 is null) = (submit_response is null)
    and (submit_response is null) = (consumed_at is null))
);
create index clinician_application_sessions_account_idx on identity.clinician_application_sessions (account_id)
  where account_id is not null;
create index clinician_application_sessions_expiry_idx on identity.clinician_application_sessions (expires_at);
create index clinician_application_sessions_challenge_idx on identity.clinician_application_sessions (challenge_id)
  where challenge_id is not null;
alter table identity.clinician_application_sessions enable row level security;
comment on table identity.clinician_application_sessions is
  'Clinician application capabilities (0094): a 60-minute draft after a verified sign-up email, or a 30-minute account capability. Only the keyed digest of the httpOnly cookie token is stored. Not a session.';

-- Idempotency of applying to another facility (per account and key).
create table identity.clinician_application_idempotency (
  account_id uuid not null references auth.accounts(id) on delete restrict,
  idempotency_key text not null check (length(idempotency_key) between 16 and 128),
  request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  response jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (account_id, idempotency_key)
);
alter table identity.clinician_application_idempotency enable row level security;

-- Per-network and platform-wide quotas of the public operations (0085's
-- counters, keyed by operation).
create table platform.clinician_application_quota_counters (
  scope text not null check (scope in ('network', 'platform')),
  operation text not null check (operation in ('email_code', 'status_code', 'facility_search', 'submit')),
  scope_key text not null,
  bucket_period text not null check (bucket_period in ('hour', 'day')),
  bucket_start timestamptz not null,
  attempt_count integer not null check (attempt_count between 1 and 1000000),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (scope, operation, scope_key, bucket_period, bucket_start),
  check ((scope = 'network' and scope_key ~ '^[a-f0-9]{64}$')
    or (scope = 'platform' and scope_key = 'all' and bucket_period = 'day'))
);
create index clinician_application_quota_expiry_idx on platform.clinician_application_quota_counters (bucket_start);
alter table platform.clinician_application_quota_counters enable row level security;
alter table platform.clinician_application_quota_counters force row level security;
-- As in 0085, the security-definer command is the only runtime access path.
create policy clinician_application_quota_command_read on platform.clinician_application_quota_counters
  for select using (true);
create policy clinician_application_quota_command_insert on platform.clinician_application_quota_counters
  for insert with check (true);
create policy clinician_application_quota_command_update on platform.clinician_application_quota_counters
  for update using (true) with check (true);
create policy clinician_application_quota_command_delete on platform.clinician_application_quota_counters
  for delete using (true);

revoke all on identity.clinician_applications, identity.clinician_application_challenges,
  identity.clinician_application_sessions, identity.clinician_application_idempotency,
  platform.clinician_application_quota_counters from public;

-- 3. Shared helpers. None is granted to a runtime role.

-- The state an application is shown and treated in: an open application past
-- its expiry is expired at once, before the sweeper records it.
create function identity.clinician_application_displayed_state(requested_state text,
  requested_expires_at timestamptz)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select case when requested_state in ('awaiting_authenticator', 'submitted', 'under_review')
      and requested_expires_at <= clock_timestamp() then 'expired' else requested_state end
$$;
revoke all on function identity.clinician_application_displayed_state(text, timestamptz) from public;

-- Reserved attestations. True unless an application that is not approved
-- holds this attestation, except that application's own pinned step 2 while it
-- is under review and not overdue: the pin names this attestation and the
-- grant is for the application's own account at its own facility. A null pin
-- never unlocks a reservation.
create function identity.workforce_attestation_usable(requested_attestation_id uuid, pinned_attestation_id uuid,
  requested_account_id uuid, requested_facility_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
  select not exists (
    select 1 from identity.clinician_applications application
     where application.attestation_id = requested_attestation_id
       and application.state <> 'approved'
       and not coalesce(pinned_attestation_id is not null
         and pinned_attestation_id = requested_attestation_id
         and application.state = 'under_review'
         and application.expires_at > clock_timestamp()
         and application.account_id = requested_account_id
         and application.facility_id = requested_facility_id, false))
$$;
revoke all on function identity.workforce_attestation_usable(uuid, uuid, uuid, uuid) from public;

-- Every public, capability and system command runs only in Identity's system
-- context: the system:auth subject, a correlation id, and no signed-in account.
create function identity.clinician_application_require_system()
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
begin
  if platform.current_actor_subject() is distinct from 'system:auth'
     or platform.current_correlation_id() is null
     or platform.current_account_id() is not null then
    raise exception using errcode = '42501', message = 'CLINICIAN_APPLICATION_PERMISSION_DENIED';
  end if;
end
$$;
revoke all on function identity.clinician_application_require_system() from public;

create function identity.clinician_application_require_not_maintenance()
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
begin
  if platform.control_enabled('maintenance_mode') then
    raise exception using errcode = '55000', message = 'PLATFORM_MAINTENANCE';
  end if;
end
$$;
revoke all on function identity.clinician_application_require_not_maintenance() from public;

-- Intake (sign-up, its email verification, facility search, submission and
-- applying again) is open only while clinician_signup_enabled and
-- provider_portal_enabled are on and maintenance_mode is off.
create function identity.clinician_intake_require_open()
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
begin
  perform platform.require_control_enabled('clinician_signup_enabled');
  perform platform.require_control_enabled('provider_portal_enabled');
  perform identity.clinician_application_require_not_maintenance();
end
$$;
revoke all on function identity.clinician_intake_require_open() from public;

-- The capability row of a token digest (locked when asked), or a row of nulls.
create function identity.clinician_application_session_row(requested_session_hmac char(64), lock_row boolean)
returns identity.clinician_application_sessions
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
declare
  found_row identity.clinician_application_sessions%rowtype;
begin
  if requested_session_hmac is null or requested_session_hmac !~ '^[0-9a-f]{64}$' then
    return found_row;
  end if;
  if lock_row then
    select * into found_row from identity.clinician_application_sessions capability
     where capability.token_hmac = requested_session_hmac for update;
  else
    select * into found_row from identity.clinician_application_sessions capability
     where capability.token_hmac = requested_session_hmac;
  end if;
  return found_row;
end
$$;
revoke all on function identity.clinician_application_session_row(character, boolean) from public;

-- A live account capability at one of the allowed stages, checked against its
-- account now. A missing, expired, ended or draft capability is
-- CLINICIAN_APPLICATION_SESSION_INVALID (the only refusal Identity answers
-- 401); one whose account is no longer active or is disabled (the fraud
-- runbook's lock) is CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE; a live one at
-- another stage (its effective stage) is `stage_refusal`. The row returned
-- carries the effective stage.
create function identity.clinician_application_account_session(requested_session_hmac char(64),
  allowed_stages text[], stage_refusal text, lock_row boolean)
returns identity.clinician_application_sessions
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
declare
  capability identity.clinician_application_sessions%rowtype;
begin
  capability := identity.clinician_application_session_row(requested_session_hmac, lock_row);
  if capability.id is null or capability.kind <> 'account' or capability.ended_at is not null
     or capability.expires_at <= clock_timestamp() then
    raise exception using errcode = '42501', message = 'CLINICIAN_APPLICATION_SESSION_INVALID';
  end if;
  if not identity.clinician_application_account_usable(capability.account_id) then
    raise exception using errcode = '23514', message = 'CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE';
  end if;
  capability.stage := identity.clinician_application_effective_stage(capability);
  if not (capability.stage = any(allowed_stages)) then
    raise exception using errcode = '42501', message = stage_refusal;
  end if;
  return capability;
end
$$;
revoke all on function identity.clinician_application_account_session(character, text[], text, boolean) from public;

-- The capability stage an account opens at: authenticator_required with an
-- active staff-proven factor, enrolment_required with no active factor, and
-- null with only a factor platform sign-in enrolled on a password.
create function identity.clinician_application_account_stage(requested_account_id uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
  select case
    when exists (select 1 from auth.mfa_factors factor where factor.account_id = requested_account_id
      and factor.status = 'active' and factor.enrollment_proof is not null) then 'authenticator_required'
    when exists (select 1 from auth.mfa_factors factor where factor.account_id = requested_account_id
      and factor.status = 'active') then null
    else 'enrolment_required' end
$$;
revoke all on function identity.clinician_application_account_stage(uuid) from public;

-- The stage a live account capability is at now. A capability keeps the
-- stage it opened at, except that enrolment_required (no active factor) ends
-- once the account holds an active factor: it then needs the authenticator's
-- code (authenticator_required) like a capability opened now. A ready
-- capability stays ready (its authenticator was verified in it).
create function identity.clinician_application_effective_stage(capability identity.clinician_application_sessions)
returns text
language sql
stable
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
  select case when capability.stage = 'enrolment_required'
    then coalesce(identity.clinician_application_account_stage(capability.account_id), 'authenticator_required')
    else capability.stage end
$$;
revoke all on function identity.clinician_application_effective_stage(identity.clinician_application_sessions) from public;

-- Whether a capability's account can still use it: active and not disabled
-- (the fraud runbook's lock stops every capability of the account).
create function identity.clinician_application_account_usable(requested_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
  select exists (select 1 from auth.accounts account_row
                  where account_row.id = requested_account_id and account_row.status = 'active'
                    and (account_row.disabled_until is null or account_row.disabled_until <= clock_timestamp()))
$$;
revoke all on function identity.clinician_application_account_usable(uuid) from public;

-- An account whose authenticator is set up again only through staff sign-in
-- (the password, then the emailed enrolment code; P22 query (3) reviews it),
-- never through an application capability that the mailbox alone opened: it
-- holds an approved clinician application, or a staff membership that is
-- active or pending. After a two-person MFA reset such an account has no
-- factor, and the status page must not offer the enrolment.
create function identity.clinician_application_staff_enrolment_only(requested_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
  select exists (select 1 from identity.clinician_applications application
                  where application.account_id = requested_account_id and application.state = 'approved')
      or exists (select 1 from identity.staff_facility_memberships membership
                   left join identity.workforce_memberships lifecycle on lifecycle.membership_id = membership.id
                  where membership.account_id = requested_account_id
                    and (membership.active or lifecycle.state = 'pending'))
$$;
revoke all on function identity.clinician_application_staff_enrolment_only(uuid) from public;

-- An account the status page serves: active and not disabled, holding a
-- clinician application, with no platform role and no patient record.
create function identity.clinician_application_status_eligible(requested_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
  select exists (
    select 1 from auth.accounts account_row
     where account_row.id = requested_account_id and account_row.status = 'active'
       and (account_row.disabled_until is null or account_row.disabled_until <= clock_timestamp())
       and exists (select 1 from identity.clinician_applications application
                    where application.account_id = account_row.id)
       and not exists (select 1 from auth.account_roles assignment
                        where assignment.account_id = account_row.id and assignment.scope_type = 'platform'
                          and assignment.revoked_at is null)
       and not exists (select 1 from identity.patients patient where patient.account_id = account_row.id))
$$;
revoke all on function identity.clinician_application_status_eligible(uuid) from public;

-- An account that a Super Admin refused for identity can file nothing more,
-- and its other open applications cannot pass step 1.
create function identity.clinician_application_identity_refused(requested_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
  select exists (select 1 from identity.clinician_applications application
                  where application.account_id = requested_account_id and application.state = 'rejected'
                    and application.decision_code = 'identity_not_confirmed')
$$;
revoke all on function identity.clinician_application_identity_refused(uuid) from public;

-- Why an account may not apply to another facility now (null when it may):
-- it must be served by the status page, hold an active staff record and an
-- active staff-proven factor, and carry no identity refusal.
create function identity.clinician_application_account_refusal(requested_account_id uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
  select case
    when not identity.clinician_application_status_eligible(requested_account_id)
      or not exists (select 1 from identity.staff staff_row
                      where staff_row.account_id = requested_account_id and staff_row.active)
      or not exists (select 1 from auth.mfa_factors factor where factor.account_id = requested_account_id
                      and factor.status = 'active' and factor.enrollment_proof is not null)
      or identity.clinician_application_identity_refused(requested_account_id)
      then 'CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE'
    when (select count(*) from identity.clinician_applications application
           where application.account_id = requested_account_id
             and application.state in ('awaiting_authenticator', 'submitted', 'under_review')
             and application.expires_at > clock_timestamp()) >= 3
      or (select count(*) from identity.clinician_applications application
           where application.account_id = requested_account_id
             and application.submitted_at > clock_timestamp() - interval '30 days') >= 10
      then 'CLINICIAN_APPLICATION_LIMIT_REACHED'
    end
$$;
revoke all on function identity.clinician_application_account_refusal(uuid) from public;

-- An approved application's current access: active, lapsed (the role's
-- attestation lapsed), ended (the membership ended or the role is revoked) or
-- account_unavailable (the account cannot sign in).
create function identity.clinician_application_access_state(application identity.clinician_applications)
returns text
language sql
stable
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
  select case
    when account_row.status <> 'active'
      or coalesce(account_row.disabled_until > clock_timestamp(), false) then 'account_unavailable'
    when membership.id is null or not membership.active or lifecycle.state is distinct from 'active'
      or not exists (select 1 from auth.account_roles assignment
                      where assignment.membership_id = membership.id and assignment.scope_type = 'facility'
                        and assignment.role_code = application.requested_role and assignment.revoked_at is null)
      then 'ended'
    when exists (select 1 from auth.account_roles assignment
                  where assignment.membership_id = membership.id and assignment.scope_type = 'facility'
                    and assignment.role_code = application.requested_role and assignment.revoked_at is null
                    and auth.facility_role_is_effective(assignment.id)) then 'active'
    else 'lapsed' end
  from auth.accounts account_row
  left join identity.staff_facility_memberships membership on membership.id = application.membership_id
  left join identity.workforce_memberships lifecycle on lifecycle.membership_id = membership.id
  where account_row.id = application.account_id
$$;
revoke all on function identity.clinician_application_access_state(identity.clinician_applications) from public;

-- The applicant's view of one application: fixed fields only, never an
-- administrator's free text, and only the last four characters of the licence.
create function identity.clinician_application_view(application identity.clinician_applications)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
declare
  displayed text := identity.clinician_application_displayed_state(application.state, application.expires_at);
  facility_name text;
begin
  select facility.name into facility_name from identity.facilities facility where facility.id = application.facility_id;
  return jsonb_build_object(
    'applicationId', application.id,
    'state', displayed,
    'version', application.row_version,
    'facility', jsonb_build_object('id', application.facility_id, 'name', facility_name),
    'profession', application.requested_role,
    'regulator', jsonb_build_object('code', application.regulator_code, 'name', application.issuing_authority),
    'licenceNumberHint', right(application.licence_number, 4),
    'submittedAt', application.submitted_at,
    'expiresAt', application.expires_at,
    'decidedAt', case displayed when 'approved' then application.approved_at
      when 'rejected' then application.decided_at when 'withdrawn' then application.withdrawn_at
      when 'expired' then coalesce(application.expired_at, application.expires_at) end,
    'decisionCode', case when displayed = 'rejected' then application.decision_code end,
    'accessState', case when displayed = 'approved' then identity.clinician_application_access_state(application) end,
    'canWithdraw', displayed in ('awaiting_authenticator', 'submitted', 'under_review'));
end
$$;
revoke all on function identity.clinician_application_view(identity.clinician_applications) from public;

-- The application capability's page: the account, its stage, its applications
-- (newest first) and whether it may apply to another facility now.
create function identity.clinician_application_account_view(requested_account_id uuid, requested_stage text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
declare
  refusal text;
  account_row auth.accounts%rowtype;
  full_name text;
begin
  select * into account_row from auth.accounts account where account.id = requested_account_id;
  select staff_row.full_name into full_name from identity.staff staff_row where staff_row.account_id = requested_account_id;
  if requested_stage <> 'ready' then
    refusal := 'CLINICIAN_APPLICATION_AUTHENTICATOR_REQUIRED';
  elsif not (platform.control_enabled('clinician_signup_enabled') and platform.control_enabled('provider_portal_enabled')) then
    refusal := 'CLINICIAN_SIGNUP_CLOSED';
  else
    refusal := identity.clinician_application_account_refusal(requested_account_id);
  end if;
  return jsonb_build_object(
    'account', jsonb_build_object('email', account_row.email, 'fullName', coalesce(full_name, account_row.display_name)),
    'stage', requested_stage,
    'applications', coalesce((select jsonb_agg(identity.clinician_application_view(application)
        order by application.submitted_at desc, application.id desc)
      from identity.clinician_applications application where application.account_id = requested_account_id), '[]'::jsonb),
    'canApply', refusal is null,
    'applyRefusal', refusal);
end
$$;
revoke all on function identity.clinician_application_account_view(uuid, text) from public;

-- The public audit row of a clinician application command (actor system, as
-- 0085's public enrollment events). Details never carry an email, name,
-- licence, password, code or search query.
create function identity.clinician_application_audit(requested_action text, requested_resource_type text,
  requested_resource_id text, requested_outcome text, requested_details jsonb)
returns void
language sql
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
  insert into audit.events (correlation_id, actor_type, actor_subject, action, resource_type, resource_id, outcome,
    provenance, source_system, details)
  values (platform.current_correlation_id(), 'system', null, requested_action, requested_resource_type,
    requested_resource_id, requested_outcome, 'application', 'identity-api', requested_details)
$$;
revoke all on function identity.clinician_application_audit(text, text, text, text, jsonb) from public;
create function identity.workforce_change_role(
  requested_membership_id uuid,
  requested_facility_id uuid,
  expected_membership_version bigint,
  requested_role_code text,
  requested_action text,
  requested_reason text,
  requested_idempotency_key text,
  requested_sha256 char(64),
  pinned_attestation_id uuid
) returns table (membership_id uuid, facility_id uuid, role_code text, role_active boolean,
  membership_active boolean, membership_state text, membership_version bigint, attestation_id uuid,
  renewed boolean, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
#variable_conflict use_column
declare
  actor_account uuid := identity.workforce_command_actor();
  correlation text := platform.current_correlation_id();
  prior auth.admin_command_idempotency%rowtype;
  membership_row identity.staff_facility_memberships%rowtype;
  lifecycle_state text;
  facility_row identity.facilities%rowtype;
  target auth.accounts%rowtype;
  target_staff identity.staff%rowtype;
  chosen_attestation uuid;
  chosen_until timestamptz;
  live_role uuid;
  live_until timestamptz;
  role_renewed boolean := false;
  new_role uuid;
  revoked_role uuid;
  response jsonb;
begin
  if requested_membership_id is null or requested_facility_id is null or expected_membership_version is null
     or requested_action is null or requested_action not in ('grant', 'revoke')
     or requested_reason is null or length(btrim(requested_reason)) not between 8 and 500 then
    raise exception using errcode = '22023', message = 'WORKFORCE_INVALID_COMMAND';
  end if;
  if requested_role_code is null
     or (requested_action = 'grant' and requested_role_code not in ('doctor', 'clinician', 'nurse'))
     or (requested_action = 'revoke'
       and requested_role_code not in ('doctor', 'clinician', 'nurse', 'lab', 'pharmacist')) then
    raise exception using errcode = '22023', message = 'WORKFORCE_ROLE_NOT_GRANTABLE';
  end if;
  perform identity.workforce_require_assurance(actor_account);
  select * into prior from auth.admin_command_idempotency command
  where command.actor_account_id = actor_account
    and command.operation = 'workforce.role.change'
    and command.idempotency_key = requested_idempotency_key;
  if found then
    if prior.request_sha256 <> requested_sha256 then
      raise exception using errcode = '23505', message = 'ADMIN_IDEMPOTENCY_CONFLICT';
    end if;
    return query select (prior.response->>'membershipId')::uuid, (prior.response->>'facilityId')::uuid,
      prior.response->>'roleCode', (prior.response->>'roleActive')::boolean,
      (prior.response->>'membershipActive')::boolean, prior.response->>'membershipState',
      (prior.response->>'membershipVersion')::bigint, (prior.response->>'attestationId')::uuid,
      coalesce((prior.response->>'renewed')::boolean, false), true;
    return;
  end if;

  select * into membership_row from identity.staff_facility_memberships membership
   where membership.id = requested_membership_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'WORKFORCE_MEMBERSHIP_NOT_FOUND';
  end if;
  if membership_row.facility_id is distinct from requested_facility_id then
    raise exception using errcode = '23514', message = 'WORKFORCE_FACILITY_MISMATCH';
  end if;
  if membership_row.account_id = actor_account then
    raise exception using errcode = '42501', message = 'WORKFORCE_SELF_CHANGE_DENIED';
  end if;
  perform 1 from auth.accounts account_row
   where account_row.id in (membership_row.account_id, actor_account)
   order by account_row.id
   for update;
  select * into membership_row from identity.staff_facility_memberships membership
   where membership.id = requested_membership_id for no key update;
  if membership_row.row_version <> expected_membership_version then
    raise exception using errcode = '40001', message = 'ADMIN_VERSION_CONFLICT';
  end if;
  select lifecycle.state into lifecycle_state from identity.workforce_memberships lifecycle
   where lifecycle.membership_id = membership_row.id;
  if lifecycle_state = 'ended' then
    raise exception using errcode = '23514', message = 'WORKFORCE_MEMBERSHIP_ENDED';
  end if;
  if membership_row.migration_hold_reason is not null then
    raise exception using errcode = '23514', message = 'WORKFORCE_MEMBERSHIP_HELD';
  end if;

  if requested_action = 'grant' then
    select * into facility_row from identity.facilities facility
     where facility.id = membership_row.facility_id for share;
    if facility_row.lifecycle_status <> 'verified' or not facility_row.active
       or not exists (select 1 from identity.organizations organization
         where organization.id = facility_row.organization_id and organization.active) then
      raise exception using errcode = '23514', message = 'WORKFORCE_FACILITY_NOT_VERIFIED';
    end if;
    if identity.workforce_works_at(actor_account, facility_row.id) then
      raise exception using errcode = '42501', message = 'WORKFORCE_FACILITY_CONFLICT';
    end if;
    if not membership_row.active and lifecycle_state is distinct from 'pending' then
      raise exception using errcode = '23514', message = 'WORKFORCE_MEMBERSHIP_INACTIVE';
    end if;
    select * into target from auth.accounts account_row where account_row.id = membership_row.account_id;
    select * into target_staff from identity.staff staff_row where staff_row.id = membership_row.staff_id;
    if not target_staff.active or not identity.workforce_target_eligible(target) then
      raise exception using errcode = '23514', message = 'WORKFORCE_ACCOUNT_INELIGIBLE';
    end if;
    -- org_admin stays non-clinical: a membership that administers the
    -- facility cannot also hold a clinical role.
    if membership_row.membership_role in ('org_admin', 'admin', 'platform_admin')
       or membership_row.app_role in ('org_admin', 'admin', 'platform_admin')
       or exists (select 1 from auth.account_roles assignment
         where assignment.membership_id = membership_row.id and assignment.scope_type = 'facility'
           and assignment.revoked_at is null and assignment.role_code in ('org_admin', 'admin')) then
      raise exception using errcode = '23514', message = 'WORKFORCE_ROLE_CONFLICT';
    end if;
    -- The live assignment of this role, if any, and when the attestation it
    -- rests on lapses. A role granted any other way (onboarding, the legacy
    -- promotion) rests on no attestation and never lapses, so it is never
    -- renewed.
    select assignment.id, attestation.valid_until into live_role, live_until
    from auth.account_roles assignment
    left join identity.workforce_role_grants role_grant on role_grant.account_role_id = assignment.id
    left join identity.staff_credential_attestations attestation on attestation.id = role_grant.attestation_id
    where assignment.membership_id = membership_row.id and assignment.scope_type = 'facility'
      and assignment.role_code = requested_role_code and assignment.revoked_at is null
    for no key update of assignment;
    if live_role is not null and live_until is null then
      raise exception using errcode = '23505', message = 'WORKFORCE_ROLE_ALREADY_ACTIVE';
    end if;
    -- A current attestation for this role by an independent reviewer: not the
    -- target (a table constraint), not working at this facility, and not the
    -- administrator granting the role.
    select attestation.id, attestation.valid_until into chosen_attestation, chosen_until
    from identity.staff_credential_attestations attestation
    where attestation.account_id = target.id
      and attestation.valid_until > clock_timestamp()
      and requested_role_code = any(attestation.attested_roles)
      and attestation.reviewer_account_id <> actor_account
      and not identity.workforce_works_at(attestation.reviewer_account_id, facility_row.id)
      and identity.workforce_attestation_usable(attestation.id, pinned_attestation_id, target.id, facility_row.id)
      and (pinned_attestation_id is null or attestation.id = pinned_attestation_id)
    order by attestation.valid_until desc, attestation.recorded_at desc, attestation.id
    limit 1;
    -- A role whose attestation is still current is renewed only by an
    -- attestation that lasts longer; one whose attestation has lapsed by any
    -- current one.
    if live_role is not null and live_until > clock_timestamp()
       and (chosen_attestation is null or chosen_until <= live_until) then
      raise exception using errcode = '23505', message = 'WORKFORCE_ROLE_ALREADY_ACTIVE';
    end if;
    if chosen_attestation is null then
      if exists (select 1 from identity.staff_credential_attestations attestation
          where attestation.account_id = target.id
            and attestation.valid_until > clock_timestamp()
            and requested_role_code = any(attestation.attested_roles)
            and attestation.reviewer_account_id = actor_account
            and not identity.workforce_works_at(attestation.reviewer_account_id, facility_row.id)
            and identity.workforce_attestation_usable(attestation.id, pinned_attestation_id, target.id, facility_row.id)
            and (pinned_attestation_id is null or attestation.id = pinned_attestation_id)) then
        raise exception using errcode = '42501', message = 'WORKFORCE_SECOND_PERSON_REQUIRED';
      end if;
      raise exception using errcode = '23514', message = 'WORKFORCE_ATTESTATION_REQUIRED';
    end if;
    if lower(btrim(target_staff.verification_status)) not in ('verified', 'approved', 'active') then
      raise exception using errcode = '23514', message = 'WORKFORCE_STAFF_INELIGIBLE';
    end if;

    -- Renewal: the old assignment is revoked, never edited, before the new one.
    if live_role is not null then
      update auth.account_roles as assignment
         set revoked_at = clock_timestamp(), revoked_by = actor_account,
             revocation_reason = btrim(requested_reason), row_version = assignment.row_version + 1
       where assignment.id = live_role;
      role_renewed := true;
    end if;
    insert into auth.account_roles (
      id, account_id, role_code, scope_type, membership_id, facility_id, granted_by, grant_reason
    ) values (
      gen_random_uuid(), target.id, requested_role_code, 'facility', membership_row.id, membership_row.facility_id,
      actor_account, btrim(requested_reason)
    ) returning id into new_role;
    insert into identity.workforce_role_grants (
      account_role_id, attestation_id, account_id, membership_id, facility_id, role_code, granted_by,
      correlation_id
    ) values (
      new_role, chosen_attestation, target.id, membership_row.id, membership_row.facility_id,
      requested_role_code, actor_account, correlation
    );
    if not membership_row.active then
      begin
        update identity.staff_facility_memberships as membership
           set active = true, membership_role = requested_role_code, app_role = requested_role_code,
               updated_at = clock_timestamp(), row_version = membership.row_version + 1
         where membership.id = membership_row.id
        returning membership.* into membership_row;
      exception when unique_violation then
        raise exception using errcode = '23505', message = 'WORKFORCE_MEMBERSHIP_EXISTS';
      end;
      update identity.workforce_memberships as lifecycle
         set state = 'active', activated_by = actor_account, activated_at = clock_timestamp(),
             correlation_id = correlation, updated_at = clock_timestamp(),
             row_version = lifecycle.row_version + 1
       where lifecycle.membership_id = membership_row.id;
      lifecycle_state := 'active';
    else
      update identity.staff_facility_memberships as membership
         set updated_at = clock_timestamp(), row_version = membership.row_version + 1
       where membership.id = membership_row.id
      returning membership.* into membership_row;
    end if;
  else
    update auth.account_roles as assignment
       set revoked_at = clock_timestamp(), revoked_by = actor_account,
           revocation_reason = btrim(requested_reason), row_version = assignment.row_version + 1
     where assignment.membership_id = membership_row.id and assignment.scope_type = 'facility'
       and assignment.role_code = requested_role_code and assignment.revoked_at is null
    returning assignment.id into revoked_role;
    if revoked_role is null then
      raise exception using errcode = '23514', message = 'WORKFORCE_ROLE_NOT_ACTIVE';
    end if;
    update identity.staff_facility_memberships as membership
       set updated_at = clock_timestamp(), row_version = membership.row_version + 1
     where membership.id = membership_row.id
    returning membership.* into membership_row;
  end if;

  response := jsonb_build_object('membershipId', membership_row.id, 'facilityId', membership_row.facility_id,
    'roleCode', requested_role_code, 'roleActive', requested_action = 'grant',
    'membershipActive', membership_row.active,
    'membershipState', coalesce(lifecycle_state, case when membership_row.active then 'active' else 'inactive' end),
    'membershipVersion', membership_row.row_version, 'attestationId', chosen_attestation,
    'renewed', role_renewed);
  insert into auth.admin_command_idempotency (
    actor_account_id, operation, idempotency_key, request_sha256, response
  ) values (actor_account, 'workforce.role.change', requested_idempotency_key, requested_sha256, response);
  return query select membership_row.id, membership_row.facility_id, requested_role_code,
    requested_action = 'grant', membership_row.active, response->>'membershipState', membership_row.row_version,
    chosen_attestation, role_renewed, false;
end
$$;

revoke all on function identity.workforce_change_role(uuid, uuid, bigint, text, text, text, text, character, uuid)
  from public;
comment on function identity.workforce_change_role(uuid, uuid, bigint, text, text, text, text, character, uuid) is
  '0094: the body of 0087''s identity.admin_change_workforce_role with exactly three insertions: the pinned attestation parameter, and in the chosen-attestation query and the second-person probe the reservation (identity.workforce_attestation_usable, bound to the target account and the facility) and the pin. Internal; granted to no runtime.';

-- The 0087 command keeps its signature, result, owner and grants; it is the
-- workforce_change_role with no pin, so an application's step-1 attestation
-- supports no generic grant until its application is approved.
create or replace function identity.admin_change_workforce_role(
  requested_membership_id uuid,
  requested_facility_id uuid,
  expected_membership_version bigint,
  requested_role_code text,
  requested_action text,
  requested_reason text,
  requested_idempotency_key text,
  requested_sha256 char(64)
) returns table (membership_id uuid, facility_id uuid, role_code text, role_active boolean,
  membership_active boolean, membership_state text, membership_version bigint, attestation_id uuid,
  renewed boolean, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
begin
  return query select * from identity.workforce_change_role(requested_membership_id, requested_facility_id,
    expected_membership_version, requested_role_code, requested_action, requested_reason, requested_idempotency_key,
    requested_sha256, null);
end
$$;

-- 0087's profile with two keys added per attestation: the clinician
-- application that reserves it (or null) and whether a grant can rest on it
-- now. Every existing key keeps its value.
create or replace function identity.admin_workforce_profile(requested_account_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, identity, auth, platform, pg_temp
as $$
declare
  actor_account uuid := identity.workforce_command_actor();
  account_row auth.accounts%rowtype;
  staff_row identity.staff%rowtype;
begin
  select * into account_row from auth.accounts account where account.id = requested_account_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'WORKFORCE_ACCOUNT_NOT_FOUND';
  end if;
  select * into staff_row from identity.staff staff where staff.account_id = account_row.id;
  return jsonb_build_object(
    'account', jsonb_build_object('id', account_row.id, 'email', account_row.email,
      'displayName', account_row.display_name, 'status', account_row.status, 'version', account_row.row_version,
      'patientAccount', exists (select 1 from identity.patients patient where patient.account_id = account_row.id)),
    'staff', case when staff_row.id is null then null else jsonb_build_object('id', staff_row.id,
      'fullName', staff_row.full_name, 'verificationStatus', staff_row.verification_status,
      'active', staff_row.active, 'version', staff_row.row_version) end,
    'attestations', coalesce((
      select jsonb_agg(jsonb_build_object('id', attestation.id, 'attestedRoles', to_jsonb(attestation.attested_roles),
          'credentialReference', attestation.credential_reference, 'issuingAuthority', attestation.issuing_authority,
          'verificationMethod', attestation.verification_method,
          'evidenceReference', attestation.evidence_reference, 'validUntil', attestation.valid_until,
          'current', attestation.valid_until > clock_timestamp(),
          'reviewerAccountId', attestation.reviewer_account_id, 'recordedAt', attestation.recorded_at,
          'clinicianApplication', (select jsonb_build_object('id', application.id,
              'state', identity.clinician_application_displayed_state(application.state, application.expires_at))
            from identity.clinician_applications application where application.attestation_id = attestation.id),
          'usableForGrant', attestation.valid_until > clock_timestamp()
            and identity.workforce_attestation_usable(attestation.id, null, null, null))
        order by attestation.recorded_at desc, attestation.id)
      from identity.staff_credential_attestations attestation
      where attestation.account_id = account_row.id), '[]'::jsonb),
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object('id', membership.id, 'facilityId', membership.facility_id,
          'facilityName', facility.name,
          'state', coalesce(lifecycle.state, case when membership.active then 'active' else 'inactive' end),
          'active', membership.active, 'held', membership.migration_hold_reason is not null,
          'version', membership.row_version,
          'roles', coalesce((select jsonb_agg(jsonb_build_object('roleCode', assignment.role_code,
              'effective', auth.facility_role_is_effective(assignment.id),
              'grantedAt', assignment.granted_at) order by assignment.role_code)
            from auth.account_roles assignment
            where assignment.membership_id = membership.id and assignment.scope_type = 'facility'
              and assignment.revoked_at is null), '[]'::jsonb))
        order by facility.name, membership.id)
      from identity.staff_facility_memberships membership
      join identity.facilities facility on facility.id = membership.facility_id
      left join identity.workforce_memberships lifecycle on lifecycle.membership_id = membership.id
      where membership.account_id = account_row.id), '[]'::jsonb)
  );
end
$$;


-- 4. Public, capability and system commands (the Identity runtime, in its
-- system context; identity.clinician_application_require_system).

-- C1. Whether intake is open, for the availability route.
create function identity.clinician_signup_open()
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
begin
  perform identity.clinician_application_require_system();
  return platform.control_enabled('clinician_signup_enabled') and platform.control_enabled('provider_portal_enabled')
    and not platform.control_enabled('maintenance_mode');
end
$$;

-- C2. Per-network and platform quotas of the public operations: 0085's
-- algorithm per operation. A denial returns false with every counter
-- unchanged; it is audited (with the success of every operation but the
-- facility search). The platform's daily submit cap is the exception: it
-- counts created applications (C8 and C13 add one each through
-- platform.count_clinician_application_submission, which enforces the cap
-- under the counter's row lock), not attempts, so a submission refused after
-- the charge, a forged or spent capability, or a replay never uses it; C2
-- only refuses early, once the day's count has reached it.
create function platform.consume_clinician_application_quota(
  requested_network_digest char(64),
  requested_operation text,
  network_hourly_limit integer,
  network_daily_limit integer,
  platform_daily_limit integer
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
declare
  quota record;
  new_attempts integer;
  exhausted_limit text;
  hourly_max integer := case when requested_operation = 'facility_search' then 1000 else 200 end;
  daily_max integer := case when requested_operation = 'facility_search' then 5000 else 2000 end;
begin
  perform identity.clinician_application_require_system();
  if requested_network_digest is null or requested_network_digest !~ '^[a-f0-9]{64}$'
     or requested_operation is null
     or requested_operation not in ('email_code', 'status_code', 'facility_search', 'submit')
     or network_hourly_limit is null or network_daily_limit is null or platform_daily_limit is null
     or network_hourly_limit not between 1 and hourly_max
     or network_daily_limit not between network_hourly_limit and daily_max
     or platform_daily_limit not between 1 and 100000 then
    raise exception using errcode = '22023', message = 'CLINICIAN_APPLICATION_QUOTA_INVALID';
  end if;

  delete from platform.clinician_application_quota_counters old
   where old.ctid in (select stale.ctid from platform.clinician_application_quota_counters stale
     where stale.bucket_start < statement_timestamp() - interval '48 hours'
     order by stale.bucket_start limit 100);

  begin
    for quota in
      select * from (values
        ('network_hour'::text, 'network'::text, requested_network_digest::text, 'hour'::text,
          date_trunc('hour', statement_timestamp()), network_hourly_limit),
        ('network_day'::text, 'network'::text, requested_network_digest::text, 'day'::text,
          date_trunc('day', statement_timestamp()), network_daily_limit),
        ('platform_day'::text, 'platform'::text, 'all'::text, 'day'::text,
          date_trunc('day', statement_timestamp()), platform_daily_limit)
      ) as limits(limit_name, scope, scope_key, bucket_period, bucket_start, max_attempts)
    loop
      if quota.scope = 'platform' and requested_operation = 'submit' then
        if coalesce((select counter.attempt_count from platform.clinician_application_quota_counters counter
              where counter.scope = 'platform' and counter.operation = 'submit' and counter.scope_key = 'all'
                and counter.bucket_period = 'day' and counter.bucket_start = quota.bucket_start), 0)
           >= quota.max_attempts then
          exhausted_limit := quota.limit_name;
          raise exception using errcode = 'P4290', message = 'CLINICIAN_APPLICATION_QUOTA_EXCEEDED';
        end if;
        continue;
      end if;
      insert into platform.clinician_application_quota_counters as counter
        (scope, operation, scope_key, bucket_period, bucket_start, attempt_count)
      values (quota.scope, requested_operation, quota.scope_key, quota.bucket_period, quota.bucket_start, 1)
      on conflict (scope, operation, scope_key, bucket_period, bucket_start)
      do update set attempt_count = counter.attempt_count + 1, updated_at = clock_timestamp()
        where counter.attempt_count < quota.max_attempts
      returning attempt_count into new_attempts;
      if not found then
        exhausted_limit := quota.limit_name;
        raise exception using errcode = 'P4290', message = 'CLINICIAN_APPLICATION_QUOTA_EXCEEDED';
      end if;
    end loop;
  exception when sqlstate 'P4290' then
    -- Leaving the block rolls back any increment made before the exhausted scope.
    null;
  end;

  if exhausted_limit is not null or requested_operation <> 'facility_search' then
    perform identity.clinician_application_audit('identity.clinician-application.quota', 'clinician-application',
      null, case when exhausted_limit is null then 'success' else 'denied' end,
      jsonb_build_object('operation', requested_operation, 'exhaustedLimit', exhausted_limit,
        'networkDigest', requested_network_digest));
  end if;
  return exhausted_limit is null;
end
$$;

-- One created clinician application, counted against the platform's daily
-- submit cap in the transaction that creates it (C8 and C13 call this once
-- per application they create, never for a refusal or a replay). The count
-- and the check are one statement under the counter row's lock: at the cap it
-- is refused (P4290 CLINICIAN_APPLICATION_QUOTA_EXCEEDED, and the creation
-- rolls back), so creations whose C2 checks all passed while the count was
-- under the cap take the last slots in turn and never go past it. C2's check
-- (a read) only refuses early. Internal.
create function platform.count_clinician_application_submission(platform_daily_limit integer)
returns void
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
begin
  if platform_daily_limit is null or platform_daily_limit not between 1 and 100000 then
    raise exception using errcode = '22023', message = 'CLINICIAN_APPLICATION_QUOTA_INVALID';
  end if;
  insert into platform.clinician_application_quota_counters as counter
    (scope, operation, scope_key, bucket_period, bucket_start, attempt_count)
  values ('platform', 'submit', 'all', 'day', date_trunc('day', statement_timestamp()), 1)
  on conflict (scope, operation, scope_key, bucket_period, bucket_start)
  do update set attempt_count = counter.attempt_count + 1, updated_at = clock_timestamp()
    where counter.attempt_count < platform_daily_limit;
  if not found then
    raise exception using errcode = 'P4290', message = 'CLINICIAN_APPLICATION_QUOTA_EXCEEDED';
  end if;
end
$$;
revoke all on function platform.count_clinician_application_submission(integer) from public;

-- C3. Starts an email-code challenge of sign-up or of the status page. Every
-- address gets a row; a status challenge for an address that is not an
-- eligible applicant's is a decoy (no account) and can never verify. Returns
-- whether the code should be delivered. Over an address's cooldown nothing is
-- inserted and nothing is delivered (the caller answers the same either way).
create function identity.begin_clinician_application_challenge(
  requested_purpose text,
  requested_challenge_id uuid,
  requested_email_hmac char(64),
  requested_email text,
  requested_code_hmac char(64)
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
declare
  normalized_email text := lower(btrim(requested_email));
  now_value timestamptz := clock_timestamp();
  target_account uuid;
begin
  perform identity.clinician_application_require_system();
  if requested_purpose is null or requested_purpose not in ('signup', 'status') or requested_challenge_id is null
     or requested_email_hmac is null or requested_email_hmac !~ '^[0-9a-f]{64}$'
     or requested_code_hmac is null or requested_code_hmac !~ '^[0-9a-f]{64}$'
     or normalized_email is null or length(normalized_email) > 254
     or normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception using errcode = '22023', message = 'CLINICIAN_APPLICATION_INVALID';
  end if;
  -- One start per address and purpose at a time (0046's pattern).
  perform pg_advisory_xact_lock(hashtextextended(
    'clinician-application-email:' || requested_purpose || ':' || requested_email_hmac, 0));
  if requested_purpose = 'signup' then
    perform identity.clinician_intake_require_open();
  else
    perform identity.clinician_application_require_not_maintenance();
  end if;

  delete from identity.clinician_application_challenges stale
   where stale.id in (select old.id from identity.clinician_application_challenges old
     where old.expires_at < now_value - interval '48 hours'
       and not exists (select 1 from identity.clinician_application_sessions capability
                        where capability.challenge_id = old.id)
     order by old.expires_at limit 100);

  if exists (select 1 from identity.clinician_application_challenges recent
              where recent.purpose = requested_purpose and recent.email_hmac = requested_email_hmac
                and recent.created_at > now_value - interval '60 seconds')
     or (select count(*) from identity.clinician_application_challenges recent
          where recent.purpose = requested_purpose and recent.email_hmac = requested_email_hmac
            and recent.created_at > now_value - interval '1 hour') >= 5
     or (select count(*) from identity.clinician_application_challenges recent
          where recent.purpose = requested_purpose and recent.email_hmac = requested_email_hmac
            and recent.created_at > now_value - interval '1 day') >= 15 then
    return false;
  end if;

  update identity.clinician_application_challenges earlier
     set invalidated_at = now_value
   where earlier.purpose = requested_purpose and earlier.email_hmac = requested_email_hmac
     and earlier.consumed_at is null and earlier.invalidated_at is null;

  if requested_purpose = 'status' then
    select account_row.id into target_account from auth.accounts account_row
     where lower(account_row.email) = normalized_email and account_row.status = 'active';
    if target_account is not null and not identity.clinician_application_status_eligible(target_account) then
      target_account := null;
    end if;
  end if;

  insert into identity.clinician_application_challenges (id, purpose, email_hmac, account_id, code_hmac, created_at,
    expires_at)
  values (requested_challenge_id, requested_purpose, requested_email_hmac, target_account, requested_code_hmac,
    now_value, now_value + interval '10 minutes');
  return requested_purpose = 'signup' or target_account is not null;
end
$$;

-- C4. A code that could not be delivered is withdrawn (after the response).
create function identity.invalidate_clinician_application_challenge(requested_challenge_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
begin
  perform identity.clinician_application_require_system();
  update identity.clinician_application_challenges challenge
     set invalidated_at = clock_timestamp()
   where challenge.id = requested_challenge_id and challenge.consumed_at is null and challenge.invalidated_at is null;
end
$$;

-- C5. Verifies a sign-up code. Returns 'invalid' (a wrong, expired, used or
-- unknown code; the fifth failure ends the challenge), 'email_in_use' (the
-- correct code for an address an account or staff record already uses; no
-- draft) or 'verified' (a 60-minute draft for the session digest). Both
-- outcomes of a correct code are audited without the address.
create function identity.verify_clinician_application_signup_code(
  requested_challenge_id uuid,
  requested_email_hmac char(64),
  requested_email text,
  requested_code_hmac char(64),
  requested_session_hmac char(64)
) returns text
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
declare
  challenge identity.clinician_application_challenges%rowtype;
  normalized_email text := lower(btrim(requested_email));
  now_value timestamptz := clock_timestamp();
  outcome text;
begin
  perform identity.clinician_application_require_system();
  if requested_challenge_id is null or requested_email_hmac is null or requested_email_hmac !~ '^[0-9a-f]{64}$'
     or requested_code_hmac is null or requested_code_hmac !~ '^[0-9a-f]{64}$'
     or requested_session_hmac is null or requested_session_hmac !~ '^[0-9a-f]{64}$'
     or normalized_email is null or length(normalized_email) > 254
     or normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception using errcode = '22023', message = 'CLINICIAN_APPLICATION_INVALID';
  end if;
  perform identity.clinician_intake_require_open();
  select * into challenge from identity.clinician_application_challenges row_lock
   where row_lock.id = requested_challenge_id for update;
  if not found or challenge.purpose <> 'signup' or challenge.consumed_at is not null
     or challenge.invalidated_at is not null or challenge.expires_at <= now_value or challenge.failed_attempts >= 5 then
    return 'invalid';
  end if;
  if challenge.email_hmac <> requested_email_hmac or challenge.code_hmac <> requested_code_hmac then
    update identity.clinician_application_challenges failed
       set failed_attempts = failed.failed_attempts + 1,
           invalidated_at = case when failed.failed_attempts + 1 >= 5 then now_value end
     where failed.id = challenge.id;
    return 'invalid';
  end if;
  update identity.clinician_application_challenges used set consumed_at = now_value where used.id = challenge.id;
  if exists (select 1 from auth.accounts account_row
              where lower(account_row.email) = normalized_email and account_row.status <> 'deleted')
     or exists (select 1 from identity.staff staff_row where lower(staff_row.email) = normalized_email) then
    outcome := 'email_in_use';
  else
    insert into identity.clinician_application_sessions (id, token_hmac, kind, email_hmac, challenge_id,
      email_verified_at, created_at, expires_at)
    values (gen_random_uuid(), requested_session_hmac, 'draft', challenge.email_hmac, challenge.id, now_value,
      now_value, now_value + interval '60 minutes');
    outcome := 'verified';
  end if;
  perform identity.clinician_application_audit('identity.clinician-application.email-verified',
    'clinician-application-challenge', challenge.id::text, 'success',
    jsonb_build_object('challengeId', challenge.id, 'purpose', 'signup', 'outcome', outcome));
  return outcome;
end
$$;

-- C6. Verifies a status code. A decoy never verifies and still counts. A
-- correct code opens a 30-minute account capability at the stage the account's
-- authenticator requires, or answers factor_unproven (no capability) when its
-- only factor was enrolled by platform sign-in, or staff_sign_in_required (no
-- capability, audited as denied) when the account has no factor but sets one
-- up only through staff sign-in (an approved clinician after an MFA reset).
create function identity.verify_clinician_application_status_code(
  requested_challenge_id uuid,
  requested_email_hmac char(64),
  requested_code_hmac char(64),
  requested_session_hmac char(64)
) returns table (outcome text, account_id uuid, stage text)
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
#variable_conflict use_column
declare
  challenge identity.clinician_application_challenges%rowtype;
  now_value timestamptz := clock_timestamp();
  opened_stage text;
begin
  perform identity.clinician_application_require_system();
  if requested_challenge_id is null or requested_email_hmac is null or requested_email_hmac !~ '^[0-9a-f]{64}$'
     or requested_code_hmac is null or requested_code_hmac !~ '^[0-9a-f]{64}$'
     or requested_session_hmac is null or requested_session_hmac !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'CLINICIAN_APPLICATION_INVALID';
  end if;
  perform identity.clinician_application_require_not_maintenance();
  select * into challenge from identity.clinician_application_challenges row_lock
   where row_lock.id = requested_challenge_id for update;
  if not found or challenge.purpose <> 'status' or challenge.consumed_at is not null
     or challenge.invalidated_at is not null or challenge.expires_at <= now_value or challenge.failed_attempts >= 5 then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;
  if challenge.account_id is null or challenge.email_hmac <> requested_email_hmac
     or challenge.code_hmac <> requested_code_hmac then
    update identity.clinician_application_challenges failed
       set failed_attempts = failed.failed_attempts + 1,
           invalidated_at = case when failed.failed_attempts + 1 >= 5 then now_value end
     where failed.id = challenge.id;
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;
  update identity.clinician_application_challenges used set consumed_at = now_value where used.id = challenge.id;
  if not identity.clinician_application_status_eligible(challenge.account_id) then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;
  opened_stage := identity.clinician_application_account_stage(challenge.account_id);
  if opened_stage is null then
    return query select 'factor_unproven'::text, null::uuid, null::text;
    return;
  end if;
  if opened_stage = 'enrolment_required' and identity.clinician_application_staff_enrolment_only(challenge.account_id) then
    perform identity.clinician_application_audit('identity.clinician-application.status-code-verified',
      'clinician-application-session', challenge.id::text, 'denied',
      jsonb_build_object('challengeId', challenge.id, 'accountId', challenge.account_id,
        'refusal', 'staff_sign_in_required'));
    return query select 'staff_sign_in_required'::text, null::uuid, null::text;
    return;
  end if;
  insert into identity.clinician_application_sessions (id, token_hmac, kind, account_id, stage, created_at, expires_at)
  values (gen_random_uuid(), requested_session_hmac, 'account', challenge.account_id, opened_stage, now_value,
    now_value + interval '30 minutes');
  perform identity.clinician_application_audit('identity.clinician-application.status-code-verified',
    'clinician-application-session', challenge.id::text, 'success',
    jsonb_build_object('challengeId', challenge.id, 'accountId', challenge.account_id, 'stage', opened_stage));
  return query select 'verified'::text, challenge.account_id, opened_stage;
end
$$;

-- The live capability a token digest names, for the authenticator routes (the
-- 0088 challenge it drives). Closed in maintenance. An account capability is
-- checked against its account now (as clinician_application_account_session
-- does): CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE when the account is no
-- longer active or is disabled, and otherwise answered at its effective stage.
create function identity.clinician_application_session(requested_session_hmac char(64))
returns table (kind text, stage text, account_id uuid, mfa_challenge_id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
#variable_conflict use_column
declare
  capability identity.clinician_application_sessions%rowtype;
begin
  perform identity.clinician_application_require_system();
  perform identity.clinician_application_require_not_maintenance();
  capability := identity.clinician_application_session_row(requested_session_hmac, false);
  if capability.id is null or capability.ended_at is not null or capability.expires_at <= clock_timestamp()
     or capability.consumed_at is not null then
    raise exception using errcode = '42501', message = 'CLINICIAN_APPLICATION_SESSION_INVALID';
  end if;
  if capability.kind = 'account' and not identity.clinician_application_account_usable(capability.account_id) then
    raise exception using errcode = '23514', message = 'CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE';
  end if;
  return query select capability.kind,
    case when capability.kind = 'account' then identity.clinician_application_effective_stage(capability) end,
    capability.account_id, capability.mfa_challenge_id, capability.expires_at;
end
$$;

-- The submit's capability check, before Identity charges the submit quota and
-- hashes the password (P4): 'new' for a live, unconsumed draft of this
-- address, 'replay' for a live draft that this key and request already
-- consumed; anything else is CLINICIAN_APPLICATION_SESSION_INVALID, as C8
-- would answer. A read only; C8 checks everything again.
create function identity.clinician_application_submit_probe(requested_session_hmac char(64),
  requested_email_hmac char(64), requested_idempotency_key text, requested_sha256 char(64))
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
declare
  draft identity.clinician_application_sessions%rowtype;
begin
  perform identity.clinician_application_require_system();
  if requested_session_hmac is not null and requested_session_hmac ~ '^[0-9a-f]{64}$' then
    select * into draft from identity.clinician_application_sessions capability
     where capability.token_hmac = requested_session_hmac;
  end if;
  if draft.id is null or draft.kind <> 'draft' or draft.ended_at is not null
     or draft.expires_at <= clock_timestamp() then
    raise exception using errcode = '42501', message = 'CLINICIAN_APPLICATION_SESSION_INVALID';
  end if;
  if draft.consumed_at is not null then
    if draft.submit_idempotency_key = requested_idempotency_key and draft.submit_sha256 = requested_sha256 then
      return 'replay';
    end if;
    raise exception using errcode = '42501', message = 'CLINICIAN_APPLICATION_SESSION_INVALID';
  end if;
  if draft.email_hmac is distinct from requested_email_hmac then
    raise exception using errcode = '42501', message = 'CLINICIAN_APPLICATION_SESSION_INVALID';
  end if;
  return 'new';
end
$$;

-- C7. Facility search: a live unconsumed draft or a ready account capability,
-- 30 searches each; only verified, active facilities of active organizations.
create function identity.search_clinician_application_facilities(requested_session_hmac char(64),
  requested_query text)
returns table (facility_id uuid, facility_name text, organization_name text)
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
#variable_conflict use_column
declare
  capability identity.clinician_application_sessions%rowtype;
  normalized text := btrim(requested_query);
  pattern text;
begin
  perform identity.clinician_application_require_system();
  if normalized is null or length(normalized) not between 3 and 80 then
    raise exception using errcode = '22023', message = 'CLINICIAN_APPLICATION_INVALID';
  end if;
  perform identity.clinician_intake_require_open();
  capability := identity.clinician_application_session_row(requested_session_hmac, true);
  if capability.id is null or capability.ended_at is not null or capability.expires_at <= clock_timestamp()
     or (capability.kind = 'draft' and capability.consumed_at is not null)
     or (capability.kind = 'account' and capability.stage <> 'ready') then
    raise exception using errcode = '42501', message = 'CLINICIAN_APPLICATION_SESSION_INVALID';
  end if;
  if capability.facility_searches >= 30 then
    raise exception using errcode = 'P4290', message = 'CLINICIAN_APPLICATION_SEARCH_BUDGET';
  end if;
  update identity.clinician_application_sessions counted
     set facility_searches = counted.facility_searches + 1
   where counted.id = capability.id;
  pattern := '%' || replace(replace(replace(lower(normalized), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return query
    select facility.id, facility.name, organization.name
      from identity.facilities facility
      join identity.organizations organization on organization.id = facility.organization_id
     where facility.active and facility.lifecycle_status = 'verified' and organization.active
       and (lower(facility.name) like pattern escape '\' or lower(organization.name) like pattern escape '\')
     order by facility.name, facility.id
     limit 10;
end
$$;

-- C8. Submits a sign-up: a new active account (argon2id password, verified
-- email), a pending staff record and an application awaiting its
-- authenticator; no membership, no role, no session. The draft is consumed
-- and the next token digest becomes an account capability at
-- enrolment_required. A replay with the same key and digest while the draft
-- is unexpired opens a fresh capability and answers the same application.
create function identity.submit_clinician_application(
  requested_session_hmac char(64),
  requested_next_session_hmac char(64),
  requested_idempotency_key text,
  requested_sha256 char(64),
  requested_email text,
  requested_email_hmac char(64),
  requested_full_name text,
  requested_password_hash text,
  requested_role text,
  requested_regulator_code text,
  requested_licence_number text,
  requested_licence_valid_until date,
  requested_facility_id uuid,
  facility_open_limit integer,
  platform_daily_limit integer
) returns table (application_id uuid, account_id uuid, state text, submitted_at timestamptz, expires_at timestamptz,
  facility_id uuid, facility_name text, application_version bigint, session_stage text, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
#variable_conflict use_column
declare
  now_value timestamptz := clock_timestamp();
  lagos_today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
  normalized_email text := lower(btrim(requested_email));
  full_name text := btrim(regexp_replace(coalesce(requested_full_name, ''), '\s+', ' ', 'g'));
  licence text := upper(btrim(regexp_replace(coalesce(requested_licence_number, ''), '\s+', ' ', 'g')));
  draft identity.clinician_application_sessions%rowtype;
  facility_row identity.facilities%rowtype;
  organization_name text;
  new_account uuid := gen_random_uuid();
  new_staff uuid := gen_random_uuid();
  created identity.clinician_applications%rowtype;
  stored jsonb;
  opened_stage text;
begin
  perform identity.clinician_application_require_system();
  if requested_session_hmac is null or requested_session_hmac !~ '^[0-9a-f]{64}$'
     or requested_next_session_hmac is null or requested_next_session_hmac !~ '^[0-9a-f]{64}$'
     or requested_next_session_hmac = requested_session_hmac
     or requested_idempotency_key is null or requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
     or requested_sha256 is null or requested_sha256 !~ '^[0-9a-f]{64}$'
     or requested_email_hmac is null or requested_email_hmac !~ '^[0-9a-f]{64}$'
     or normalized_email is null or length(normalized_email) > 254
     or normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     or length(full_name) not between 2 and 200
     or requested_password_hash is null or requested_password_hash !~ '^\$argon2id\$v=19\$m=65536,t=3,p=1\$'
     or requested_role is null or requested_regulator_code is null
     or not ((requested_role = 'doctor' and requested_regulator_code = 'MDCN')
       or (requested_role = 'nurse' and requested_regulator_code = 'NMCN'))
     or licence !~ '^[A-Z0-9][A-Z0-9/. -]{1,98}[A-Z0-9]$'
     or identity.clinician_licence_key(requested_regulator_code, licence) !~ '^(MDCN|NMCN):[A-Z0-9]{1,100}$'
     or requested_licence_valid_until is null or requested_licence_valid_until <= lagos_today
     or requested_licence_valid_until > lagos_today + interval '5 years'
     or requested_facility_id is null
     or facility_open_limit is null or facility_open_limit not between 1 and 500
     or platform_daily_limit is null or platform_daily_limit not between 1 and 100000 then
    raise exception using errcode = '22023', message = 'CLINICIAN_APPLICATION_INVALID';
  end if;
  perform identity.clinician_intake_require_open();

  select * into draft from identity.clinician_application_sessions capability
   where capability.token_hmac = requested_session_hmac and capability.kind = 'draft'
   for update;
  if not found then
    raise exception using errcode = '42501', message = 'CLINICIAN_APPLICATION_SESSION_INVALID';
  end if;
  if draft.consumed_at is not null then
    if draft.submit_idempotency_key = requested_idempotency_key and draft.submit_sha256 = requested_sha256
       and draft.expires_at > now_value and draft.ended_at is null then
      stored := draft.submit_response;
      opened_stage := identity.clinician_application_account_stage((stored->>'accountId')::uuid);
      if opened_stage is null then
        raise exception using errcode = '42501', message = 'CLINICIAN_APPLICATION_SESSION_INVALID';
      end if;
      insert into identity.clinician_application_sessions (id, token_hmac, kind, account_id, stage, created_at,
        expires_at)
      values (gen_random_uuid(), requested_next_session_hmac, 'account', (stored->>'accountId')::uuid,
        opened_stage, now_value, now_value + interval '30 minutes');
      return query
        select application.id, application.account_id,
          identity.clinician_application_displayed_state(application.state, application.expires_at),
          application.submitted_at, application.expires_at, application.facility_id, stored->>'facilityName',
          application.row_version, opened_stage, true
          from identity.clinician_applications application
         where application.id = (stored->>'applicationId')::uuid;
      return;
    end if;
    raise exception using errcode = '42501', message = 'CLINICIAN_APPLICATION_SESSION_INVALID';
  end if;
  if draft.expires_at <= now_value or draft.ended_at is not null or draft.email_hmac <> requested_email_hmac then
    raise exception using errcode = '42501', message = 'CLINICIAN_APPLICATION_SESSION_INVALID';
  end if;

  select * into facility_row from identity.facilities facility where facility.id = requested_facility_id for share;
  select organization.name into organization_name from identity.organizations organization
   where organization.id = facility_row.organization_id and organization.active;
  if facility_row.id is null or facility_row.lifecycle_status <> 'verified' or not facility_row.active
     or organization_name is null then
    raise exception using errcode = '23514', message = 'CLINICIAN_APPLICATION_FACILITY_UNAVAILABLE';
  end if;
  -- The facility's open applications are counted under its lock (C13 takes
  -- the same one), held to the end of this transaction: two submissions to
  -- one facility count in turn and never both take its last slot.
  perform pg_advisory_xact_lock(hashtextextended('clinician-application-facility:' || facility_row.id::text, 0));
  if (select count(*) from identity.clinician_applications application
       where application.facility_id = facility_row.id
         and application.state in ('awaiting_authenticator', 'submitted', 'under_review')
         and application.expires_at > now_value) >= facility_open_limit then
    raise exception using errcode = '23514', message = 'CLINICIAN_APPLICATION_FACILITY_BUSY';
  end if;
  if exists (select 1 from auth.accounts account_row
              where lower(account_row.email) = normalized_email and account_row.status <> 'deleted')
     or exists (select 1 from identity.staff staff_row where lower(staff_row.email) = normalized_email) then
    raise exception using errcode = '23505', message = 'CLINICIAN_EMAIL_IN_USE';
  end if;
  begin
    insert into auth.accounts (id, subject, email, display_name, status, password_hash, password_algorithm,
      password_changed_at, email_verified_at, source_system)
    values (new_account, 'workforce:' || new_account::text, normalized_email, full_name, 'active',
      requested_password_hash, 'argon2id', now_value, draft.email_verified_at, 'hid');
    insert into identity.staff (id, account_id, full_name, email, verification_status, license_number, default_role,
      active, source_system)
    values (new_staff, new_account, full_name, normalized_email, 'pending', licence, 'staff', true, 'hid');
  exception when unique_violation then
    raise exception using errcode = '23505', message = 'CLINICIAN_EMAIL_IN_USE';
  end;
  insert into identity.clinician_applications (id, account_id, staff_id, facility_id, requested_role, regulator_code,
    issuing_authority, licence_number, licence_valid_until, applicant_full_name, state, submitted_at, expires_at,
    correlation_id, updated_at)
  values (gen_random_uuid(), new_account, new_staff, facility_row.id, requested_role, requested_regulator_code,
    case requested_regulator_code when 'MDCN' then 'Medical and Dental Council of Nigeria'
      else 'Nursing and Midwifery Council of Nigeria' end,
    licence, requested_licence_valid_until, full_name, 'awaiting_authenticator', now_value,
    now_value + interval '30 days', platform.current_correlation_id(), now_value)
  returning * into created;
  perform identity.clinician_application_audit('identity.clinician-application.submitted', 'clinician-application',
    created.id::text, 'success',
    jsonb_build_object('applicationId', created.id, 'accountId', new_account, 'facilityId', facility_row.id,
      'requestedRole', created.requested_role, 'regulatorCode', created.regulator_code,
      'initialState', created.state, 'additional', false));

  stored := jsonb_build_object('applicationId', created.id, 'accountId', new_account, 'facilityId', facility_row.id,
    'facilityName', facility_row.name);
  update identity.clinician_application_sessions consumed
     set consumed_at = now_value, submit_idempotency_key = requested_idempotency_key,
         submit_sha256 = requested_sha256, submit_response = stored
   where consumed.id = draft.id;
  insert into identity.clinician_application_sessions (id, token_hmac, kind, account_id, stage, created_at, expires_at)
  values (gen_random_uuid(), requested_next_session_hmac, 'account', new_account, 'enrolment_required', now_value,
    now_value + interval '30 minutes');
  perform platform.count_clinician_application_submission(platform_daily_limit);
  return query select created.id, new_account, created.state, created.submitted_at, created.expires_at,
    facility_row.id, facility_row.name, created.row_version, 'enrolment_required'::text, false;
end
$$;

-- C9. Records which 0088 staff challenge (of the capability's own account)
-- the capability drives, and the stage that challenge serves. A capability
-- that is already ready answers CLINICIAN_APPLICATION_AUTHENTICATOR_READY
-- (never the 401 marker: it is live), and an enrolment challenge is not bound
-- for an account that sets its authenticator up only through staff sign-in.
create function identity.bind_clinician_application_mfa_challenge(requested_session_hmac char(64),
  requested_mfa_challenge_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
declare
  capability identity.clinician_application_sessions%rowtype;
  challenge_purpose text;
begin
  perform identity.clinician_application_require_system();
  perform identity.clinician_application_require_not_maintenance();
  capability := identity.clinician_application_account_session(requested_session_hmac,
    array['enrolment_required', 'authenticator_required'], 'CLINICIAN_APPLICATION_AUTHENTICATOR_READY', true);
  select challenge.purpose into challenge_purpose from auth.mfa_login_challenges challenge
   where challenge.id = requested_mfa_challenge_id and challenge.account_id = capability.account_id
     and challenge.session_kind = 'staff' and challenge.consumed_at is null and challenge.invalidated_at is null
     and challenge.expires_at > clock_timestamp();
  if challenge_purpose is null then
    raise exception using errcode = '42501', message = 'CLINICIAN_APPLICATION_PERMISSION_DENIED';
  end if;
  if challenge_purpose = 'enroll' and identity.clinician_application_staff_enrolment_only(capability.account_id) then
    raise exception using errcode = '42501', message = 'CLINICIAN_APPLICATION_STAFF_SIGN_IN_REQUIRED';
  end if;
  update identity.clinician_application_sessions bound
     set mfa_challenge_id = requested_mfa_challenge_id,
         stage = case challenge_purpose when 'enroll' then 'enrolment_required' else 'authenticator_required' end
   where bound.id = capability.id;
end
$$;

-- C10. Runs inside Identity's 0088 activation or verification transaction:
-- the factor must be the capability account's active staff-proven factor and
-- have been used in this transaction (activated, a TOTP step accepted, or one
-- of its recovery codes used). The capability becomes ready, and the
-- account's applications awaiting an authenticator (and not overdue) are
-- submitted for review.
create function identity.clinician_application_authenticator_ready(requested_session_hmac char(64),
  requested_factor_id uuid, requested_method text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
declare
  capability identity.clinician_application_sessions%rowtype;
  application identity.clinician_applications%rowtype;
begin
  perform identity.clinician_application_require_system();
  if requested_method is null or requested_method not in ('enrolment', 'totp', 'recovery_code') then
    raise exception using errcode = '22023', message = 'CLINICIAN_APPLICATION_INVALID';
  end if;
  perform identity.clinician_application_require_not_maintenance();
  capability := identity.clinician_application_account_session(requested_session_hmac,
    array['enrolment_required', 'authenticator_required'], 'CLINICIAN_APPLICATION_SESSION_INVALID', true);
  -- The enrolment of an account that sets its authenticator up only through
  -- staff sign-in readies nothing (and the enrolment fails with it).
  if requested_method = 'enrolment' and identity.clinician_application_staff_enrolment_only(capability.account_id) then
    raise exception using errcode = '42501', message = 'CLINICIAN_APPLICATION_STAFF_SIGN_IN_REQUIRED';
  end if;
  if not exists (
    select 1 from auth.mfa_factors factor
     where factor.id = requested_factor_id and factor.account_id = capability.account_id
       and factor.status = 'active' and factor.enrollment_proof is not null
       and case requested_method
         when 'enrolment' then factor.activated_at >= now() and factor.last_used_at >= now()
         when 'totp' then factor.last_used_at >= now()
         else exists (select 1 from auth.mfa_recovery_codes code
                       where code.factor_id = factor.id and code.account_id = factor.account_id
                         and code.used_at >= now()) end) then
    raise exception using errcode = '42501', message = 'CLINICIAN_APPLICATION_PERMISSION_DENIED';
  end if;
  update identity.clinician_application_sessions readied set stage = 'ready' where readied.id = capability.id;
  for application in
    select * from identity.clinician_applications waiting
     where waiting.account_id = capability.account_id and waiting.state = 'awaiting_authenticator'
       and waiting.expires_at > clock_timestamp()
     order by waiting.submitted_at, waiting.id
     for no key update
  loop
    update identity.clinician_applications ready_application
       set state = 'submitted', authenticator_ready_at = clock_timestamp(), updated_at = clock_timestamp(),
           row_version = ready_application.row_version + 1
     where ready_application.id = application.id;
    perform identity.clinician_application_audit('identity.clinician-application.authenticator-ready',
      'clinician-application', application.id::text, 'success',
      jsonb_build_object('applicationId', application.id, 'accountId', capability.account_id,
        'factorId', requested_factor_id));
  end loop;
  if requested_method <> 'enrolment' then
    perform identity.clinician_application_audit('identity.clinician-application.authenticator.verified',
      'clinician-application-session', capability.id::text, 'success',
      jsonb_build_object('accountId', capability.account_id, 'method', requested_method));
  end if;
  return identity.clinician_application_account_view(capability.account_id, 'ready');
end
$$;

-- C11. The applicant's applications. An account capability that still needs
-- its authenticator code is refused with CLINICIAN_APPLICATION_AUTHENTICATOR_REQUIRED.
create function identity.current_clinician_applications(requested_session_hmac char(64))
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
declare
  capability identity.clinician_application_sessions%rowtype;
begin
  perform identity.clinician_application_require_system();
  perform identity.clinician_application_require_not_maintenance();
  capability := identity.clinician_application_account_session(requested_session_hmac,
    array['ready', 'enrolment_required'], 'CLINICIAN_APPLICATION_AUTHENTICATOR_REQUIRED', false);
  return identity.clinician_application_account_view(capability.account_id, capability.stage);
end
$$;

-- C12. The applicant withdraws one open application. Nothing else changes: no
-- attestation, role or membership is touched.
create function identity.withdraw_clinician_application(requested_session_hmac char(64),
  requested_application_id uuid, expected_version bigint)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
declare
  capability identity.clinician_application_sessions%rowtype;
  application identity.clinician_applications%rowtype;
begin
  perform identity.clinician_application_require_system();
  if requested_application_id is null or expected_version is null or expected_version < 1 then
    raise exception using errcode = '22023', message = 'CLINICIAN_APPLICATION_INVALID';
  end if;
  perform identity.clinician_application_require_not_maintenance();
  capability := identity.clinician_application_account_session(requested_session_hmac,
    array['ready', 'enrolment_required'], 'CLINICIAN_APPLICATION_AUTHENTICATOR_REQUIRED', false);
  -- The account first, then the capability again and the application.
  perform 1 from auth.accounts account_row where account_row.id = capability.account_id for no key update;
  capability := identity.clinician_application_account_session(requested_session_hmac,
    array['ready', 'enrolment_required'], 'CLINICIAN_APPLICATION_AUTHENTICATOR_REQUIRED', false);
  select * into application from identity.clinician_applications row_lock
   where row_lock.id = requested_application_id and row_lock.account_id = capability.account_id
   for no key update;
  if not found then
    raise exception using errcode = 'P0002', message = 'CLINICIAN_APPLICATION_NOT_FOUND';
  end if;
  if application.state = 'withdrawn' then
    return identity.clinician_application_view(application);
  end if;
  if application.state not in ('awaiting_authenticator', 'submitted', 'under_review')
     or application.expires_at <= clock_timestamp() then
    raise exception using errcode = '23514', message = 'CLINICIAN_APPLICATION_STATE_INVALID';
  end if;
  if application.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'CLINICIAN_APPLICATION_VERSION_CONFLICT';
  end if;
  update identity.clinician_applications withdrawn
     set state = 'withdrawn', withdrawn_at = clock_timestamp(), updated_at = clock_timestamp(),
         row_version = withdrawn.row_version + 1
   where withdrawn.id = application.id
  returning withdrawn.* into application;
  perform identity.clinician_application_audit('identity.clinician-application.withdrawn', 'clinician-application',
    application.id::text, 'success',
    jsonb_build_object('applicationId', application.id, 'accountId', application.account_id,
      'facilityId', application.facility_id, 'fromState',
      case when application.attested_at is not null then 'under_review'
        when application.authenticator_ready_at is not null then 'submitted' else 'awaiting_authenticator' end));
  return identity.clinician_application_view(application);
end
$$;

-- C13. A ready account applies to another facility. The new application is
-- submitted for review at once (its account already holds a staff-proven
-- authenticator).
create function identity.file_clinician_application(
  requested_session_hmac char(64),
  requested_idempotency_key text,
  requested_sha256 char(64),
  requested_role text,
  requested_regulator_code text,
  requested_licence_number text,
  requested_licence_valid_until date,
  requested_facility_id uuid,
  facility_open_limit integer,
  platform_daily_limit integer
) returns table (application jsonb, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
#variable_conflict use_column
declare
  now_value timestamptz := clock_timestamp();
  lagos_today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
  licence text := upper(btrim(regexp_replace(coalesce(requested_licence_number, ''), '\s+', ' ', 'g')));
  capability identity.clinician_application_sessions%rowtype;
  prior identity.clinician_application_idempotency%rowtype;
  facility_row identity.facilities%rowtype;
  staff_row identity.staff%rowtype;
  refusal text;
  overdue identity.clinician_applications%rowtype;
  created identity.clinician_applications%rowtype;
  current_view jsonb;
begin
  perform identity.clinician_application_require_system();
  if requested_idempotency_key is null or requested_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
     or requested_sha256 is null or requested_sha256 !~ '^[0-9a-f]{64}$'
     or requested_role is null or requested_regulator_code is null
     or not ((requested_role = 'doctor' and requested_regulator_code = 'MDCN')
       or (requested_role = 'nurse' and requested_regulator_code = 'NMCN'))
     or licence !~ '^[A-Z0-9][A-Z0-9/. -]{1,98}[A-Z0-9]$'
     or identity.clinician_licence_key(requested_regulator_code, licence) !~ '^(MDCN|NMCN):[A-Z0-9]{1,100}$'
     or requested_licence_valid_until is null or requested_licence_valid_until <= lagos_today
     or requested_licence_valid_until > lagos_today + interval '5 years'
     or requested_facility_id is null
     or facility_open_limit is null or facility_open_limit not between 1 and 500
     or platform_daily_limit is null or platform_daily_limit not between 1 and 100000 then
    raise exception using errcode = '22023', message = 'CLINICIAN_APPLICATION_INVALID';
  end if;
  perform identity.clinician_intake_require_open();
  capability := identity.clinician_application_account_session(requested_session_hmac,
    array['ready'], 'CLINICIAN_APPLICATION_AUTHENTICATOR_REQUIRED', false);
  perform 1 from auth.accounts account_row where account_row.id = capability.account_id for no key update;
  capability := identity.clinician_application_account_session(requested_session_hmac,
    array['ready'], 'CLINICIAN_APPLICATION_AUTHENTICATOR_REQUIRED', false);

  select * into prior from identity.clinician_application_idempotency stored
   where stored.account_id = capability.account_id and stored.idempotency_key = requested_idempotency_key;
  if found then
    if prior.request_sha256 <> requested_sha256 then
      raise exception using errcode = '23505', message = 'CLINICIAN_APPLICATION_IDEMPOTENCY_CONFLICT';
    end if;
    select identity.clinician_application_view(stored_application) into current_view
      from identity.clinician_applications stored_application
     where stored_application.id = (prior.response->>'applicationId')::uuid;
    return query select current_view, true;
    return;
  end if;

  refusal := identity.clinician_application_account_refusal(capability.account_id);
  if refusal = 'CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE' then
    raise exception using errcode = '23514', message = refusal;
  end if;
  select * into facility_row from identity.facilities facility where facility.id = requested_facility_id for share;
  if facility_row.id is null or facility_row.lifecycle_status <> 'verified' or not facility_row.active
     or not exists (select 1 from identity.organizations organization
                     where organization.id = facility_row.organization_id and organization.active) then
    raise exception using errcode = '23514', message = 'CLINICIAN_APPLICATION_FACILITY_UNAVAILABLE';
  end if;
  -- Counted under the facility's lock, as in C8.
  perform pg_advisory_xact_lock(hashtextextended('clinician-application-facility:' || facility_row.id::text, 0));
  if (select count(*) from identity.clinician_applications open_application
       where open_application.facility_id = facility_row.id
         and open_application.state in ('awaiting_authenticator', 'submitted', 'under_review')
         and open_application.expires_at > now_value) >= facility_open_limit then
    raise exception using errcode = '23514', message = 'CLINICIAN_APPLICATION_FACILITY_BUSY';
  end if;
  if exists (
    select 1 from identity.staff_facility_memberships membership
    left join identity.workforce_memberships lifecycle on lifecycle.membership_id = membership.id
    where membership.account_id = capability.account_id and membership.facility_id = facility_row.id
      and (membership.active or lifecycle.state = 'pending')
      and (membership.membership_role in ('org_admin', 'admin', 'platform_admin')
        or membership.app_role in ('org_admin', 'admin', 'platform_admin')
        or exists (select 1 from auth.account_roles assignment
                    where assignment.membership_id = membership.id and assignment.scope_type = 'facility'
                      and assignment.revoked_at is null and assignment.role_code in ('org_admin', 'admin')))) then
    raise exception using errcode = '23514', message = 'CLINICIAN_APPLICATION_ROLE_CONFLICT';
  end if;
  if exists (
    select 1 from identity.staff_facility_memberships membership
    left join identity.workforce_memberships lifecycle on lifecycle.membership_id = membership.id
    where membership.account_id = capability.account_id and membership.facility_id = facility_row.id
      and (membership.active or lifecycle.state = 'pending')) then
    raise exception using errcode = '23505', message = 'CLINICIAN_APPLICATION_MEMBERSHIP_EXISTS';
  end if;
  if refusal = 'CLINICIAN_APPLICATION_LIMIT_REACHED' then
    raise exception using errcode = '23514', message = refusal;
  end if;

  -- An overdue application at this facility that the sweeper has not recorded
  -- yet is recorded as expired now, so it does not hold the facility's slot.
  for overdue in
    select * from identity.clinician_applications stale
     where stale.account_id = capability.account_id and stale.facility_id = facility_row.id
       and stale.state in ('awaiting_authenticator', 'submitted', 'under_review')
       and stale.expires_at <= now_value
     for no key update
  loop
    update identity.clinician_applications expired_row
       set state = 'expired', expired_at = clock_timestamp(), updated_at = clock_timestamp(),
           row_version = expired_row.row_version + 1
     where expired_row.id = overdue.id;
    perform identity.clinician_application_audit('identity.clinician-application.expired', 'clinician-application',
      overdue.id::text, 'success',
      jsonb_build_object('applicationId', overdue.id, 'accountId', overdue.account_id,
        'facilityId', overdue.facility_id, 'fromState', overdue.state));
  end loop;

  select * into staff_row from identity.staff staff_record where staff_record.account_id = capability.account_id;
  begin
    insert into identity.clinician_applications (id, account_id, staff_id, facility_id, requested_role, regulator_code,
      issuing_authority, licence_number, licence_valid_until, applicant_full_name, state, submitted_at, expires_at,
      authenticator_ready_at, correlation_id, updated_at)
    values (gen_random_uuid(), capability.account_id, staff_row.id, facility_row.id, requested_role,
      requested_regulator_code,
      case requested_regulator_code when 'MDCN' then 'Medical and Dental Council of Nigeria'
        else 'Nursing and Midwifery Council of Nigeria' end,
      licence, requested_licence_valid_until, staff_row.full_name, 'submitted', now_value,
      now_value + interval '30 days', now_value, platform.current_correlation_id(), now_value)
    returning * into created;
  exception when unique_violation then
    raise exception using errcode = '23505', message = 'CLINICIAN_APPLICATION_ALREADY_OPEN';
  end;
  perform identity.clinician_application_audit('identity.clinician-application.submitted', 'clinician-application',
    created.id::text, 'success',
    jsonb_build_object('applicationId', created.id, 'accountId', capability.account_id,
      'facilityId', facility_row.id, 'requestedRole', created.requested_role,
      'regulatorCode', created.regulator_code, 'initialState', created.state, 'additional', true));
  insert into identity.clinician_application_idempotency (account_id, idempotency_key, request_sha256, response)
  values (capability.account_id, requested_idempotency_key, requested_sha256,
    jsonb_build_object('applicationId', created.id));
  perform platform.count_clinician_application_submission(platform_daily_limit);
  return query select identity.clinician_application_view(created), false;
end
$$;

-- C14. Ends a capability and invalidates the 0088 challenge it drives.
create function identity.end_clinician_application_session(requested_session_hmac char(64))
returns void
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
declare
  capability identity.clinician_application_sessions%rowtype;
begin
  perform identity.clinician_application_require_system();
  capability := identity.clinician_application_session_row(requested_session_hmac, false);
  if capability.id is null then
    return;
  end if;
  -- The account first (as every MFA transaction), then the challenge, then the capability.
  if capability.account_id is not null then
    perform 1 from auth.accounts account_row where account_row.id = capability.account_id for no key update;
    capability := identity.clinician_application_session_row(requested_session_hmac, false);
    if capability.mfa_challenge_id is not null then
      update auth.mfa_login_challenges challenge
         set invalidated_at = clock_timestamp(), invalidation_reason = 'superseded',
             row_version = challenge.row_version + 1
       where challenge.id = capability.mfa_challenge_id and challenge.account_id = capability.account_id
         and challenge.consumed_at is null and challenge.invalidated_at is null;
    end if;
  end if;
  update identity.clinician_application_sessions ended
     set ended_at = coalesce(ended.ended_at, clock_timestamp())
   where ended.id = capability.id;
end
$$;

-- C15. Records due applications as expired. Busy rows are skipped and taken
-- on a later run; every reader already treats an overdue application as
-- expired, so nothing waits for this sweep.
create function identity.expire_clinician_applications(requested_limit integer)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
declare
  due record;
  locked_account uuid;
  application identity.clinician_applications%rowtype;
  expired_count integer := 0;
begin
  perform identity.clinician_application_require_system();
  if requested_limit is null or requested_limit not between 1 and 500 then
    raise exception using errcode = '22023', message = 'CLINICIAN_APPLICATION_INVALID';
  end if;
  for due in
    select candidate.id, candidate.account_id from identity.clinician_applications candidate
     where candidate.state in ('awaiting_authenticator', 'submitted', 'under_review')
       and candidate.expires_at <= clock_timestamp()
     order by candidate.expires_at, candidate.id
     limit requested_limit
  loop
    locked_account := null;
    select account_row.id into locked_account from auth.accounts account_row
     where account_row.id = due.account_id for update skip locked;
    continue when locked_account is null;
    select * into application from identity.clinician_applications row_lock
     where row_lock.id = due.id for no key update skip locked;
    continue when application.id is null or application.id <> due.id
      or application.state not in ('awaiting_authenticator', 'submitted', 'under_review')
      or application.expires_at > clock_timestamp();
    update identity.clinician_applications expired_row
       set state = 'expired', expired_at = clock_timestamp(), updated_at = clock_timestamp(),
           row_version = expired_row.row_version + 1
     where expired_row.id = application.id;
    perform identity.clinician_application_audit('identity.clinician-application.expired', 'clinician-application',
      application.id::text, 'success',
      jsonb_build_object('applicationId', application.id, 'accountId', application.account_id,
        'facilityId', application.facility_id, 'fromState', application.state));
    expired_count := expired_count + 1;
    application := null;
  end loop;
  return expired_count;
end
$$;

-- C16. Prunes stale capabilities, challenges, idempotency rows and counters
-- (application rows and accounts are kept), at most 500 rows of each per call.
create function identity.prune_clinician_application_artifacts()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
declare
  pruned integer := 0;
  batch integer;
begin
  perform identity.clinician_application_require_system();
  delete from identity.clinician_application_sessions stale
   where stale.id in (select old.id from identity.clinician_application_sessions old
     where old.expires_at < clock_timestamp() - interval '48 hours' order by old.expires_at limit 500);
  get diagnostics batch = row_count;
  pruned := pruned + batch;
  delete from identity.clinician_application_challenges stale
   where stale.id in (select old.id from identity.clinician_application_challenges old
     where old.expires_at < clock_timestamp() - interval '48 hours'
       and not exists (select 1 from identity.clinician_application_sessions capability
                        where capability.challenge_id = old.id)
     order by old.expires_at limit 500);
  get diagnostics batch = row_count;
  pruned := pruned + batch;
  delete from identity.clinician_application_idempotency stale
   where (stale.account_id, stale.idempotency_key) in (select old.account_id, old.idempotency_key
     from identity.clinician_application_idempotency old
     where old.created_at < clock_timestamp() - interval '30 days' order by old.created_at limit 500);
  get diagnostics batch = row_count;
  pruned := pruned + batch;
  delete from platform.clinician_application_quota_counters stale
   where stale.ctid in (select old.ctid from platform.clinician_application_quota_counters old
     where old.bucket_start < statement_timestamp() - interval '48 hours' order by old.bucket_start limit 500);
  get diagnostics batch = row_count;
  return pruned + batch;
end
$$;

-- 5. Platform administration commands (Super Admin: platform.workforce.manage,
-- an MFA-verified platform session and, for the three mutations, a step-up
-- from the last five minutes). Each begins with
-- identity.workforce_command_actor() (0087).

-- C17. The verification queue. 'open' lists the three open states that are
-- not overdue, oldest first; a named state lists newest first, and 'expired'
-- includes overdue open applications.
create function identity.admin_list_clinician_applications(requested_state text, cursor_at timestamptz,
  cursor_id uuid, requested_limit integer)
returns table (id uuid, state text, version bigint, submitted_at timestamptz, expires_at timestamptz,
  account_id uuid, applicant_full_name text, email text, requested_role text, regulator_code text,
  issuing_authority text, licence_number text, licence_valid_until date, facility_id uuid, facility_name text,
  organization_name text, attested_by uuid, attested_by_name text, attested_at timestamptz,
  authenticator_ready boolean)
language plpgsql
stable
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
#variable_conflict use_column
declare
  actor_account uuid := identity.workforce_command_actor();
begin
  if requested_state is null or requested_state not in ('open', 'awaiting_authenticator', 'submitted',
       'under_review', 'approved', 'rejected', 'withdrawn', 'expired')
     or requested_limit is null or requested_limit not between 1 and 50
     or (cursor_at is null) <> (cursor_id is null) then
    raise exception using errcode = '22023', message = 'CLINICIAN_APPLICATION_COMMAND_INVALID';
  end if;
  return query
    select application.id,
      identity.clinician_application_displayed_state(application.state, application.expires_at),
      application.row_version, application.submitted_at, application.expires_at, application.account_id,
      application.applicant_full_name, account_row.email, application.requested_role, application.regulator_code,
      application.issuing_authority, application.licence_number, application.licence_valid_until,
      application.facility_id, facility.name, organization.name, application.attested_by,
      coalesce(attester.display_name, attester.email), application.attested_at,
      application.authenticator_ready_at is not null
      from identity.clinician_applications application
      join auth.accounts account_row on account_row.id = application.account_id
      join identity.facilities facility on facility.id = application.facility_id
      join identity.organizations organization on organization.id = facility.organization_id
      left join auth.accounts attester on attester.id = application.attested_by
     where case when requested_state = 'open'
             then identity.clinician_application_displayed_state(application.state, application.expires_at)
               in ('awaiting_authenticator', 'submitted', 'under_review')
             else identity.clinician_application_displayed_state(application.state, application.expires_at)
               = requested_state end
       and (cursor_at is null
         or (requested_state = 'open' and (application.submitted_at, application.id) > (cursor_at, cursor_id))
         or (requested_state <> 'open' and (application.submitted_at, application.id) < (cursor_at, cursor_id)))
     order by case when requested_state = 'open' then application.submitted_at end asc,
       case when requested_state = 'open' then application.id end asc,
       case when requested_state <> 'open' then application.submitted_at end desc,
       case when requested_state <> 'open' then application.id end desc
     limit requested_limit;
end
$$;

-- C18. One application with everything step 1 and step 2 need, including
-- warnings and the caller's display hints (the commands check again).
create function identity.admin_get_clinician_application(requested_application_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
declare
  actor_account uuid := identity.workforce_command_actor();
  application identity.clinician_applications%rowtype;
  displayed text;
  account_row auth.accounts%rowtype;
  staff_row identity.staff%rowtype;
  facility_row identity.facilities%rowtype;
  organization_row identity.organizations%rowtype;
  factor_row auth.mfa_factors%rowtype;
  attestation_row identity.staff_credential_attestations%rowtype;
  first_submitted timestamptz;
  works_at boolean;
  refused_identity boolean;
  normalized_name text;
  email_domain text;
  attest_reason text;
  approve_reason text;
  reject_reason text;
begin
  select * into application from identity.clinician_applications row_read where row_read.id = requested_application_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'CLINICIAN_APPLICATION_NOT_FOUND';
  end if;
  displayed := identity.clinician_application_displayed_state(application.state, application.expires_at);
  select * into account_row from auth.accounts account where account.id = application.account_id;
  select * into staff_row from identity.staff staff where staff.id = application.staff_id;
  select * into facility_row from identity.facilities facility where facility.id = application.facility_id;
  select * into organization_row from identity.organizations organization
   where organization.id = facility_row.organization_id;
  select * into factor_row from auth.mfa_factors factor
   where factor.account_id = application.account_id and factor.status = 'active';
  select * into attestation_row from identity.staff_credential_attestations attestation
   where attestation.id = application.attestation_id;
  select min(other.submitted_at) into first_submitted from identity.clinician_applications other
   where other.account_id = application.account_id;
  works_at := identity.workforce_works_at(actor_account, application.facility_id);
  refused_identity := identity.clinician_application_identity_refused(application.account_id);
  normalized_name := lower(btrim(regexp_replace(application.applicant_full_name, '\s+', ' ', 'g')));
  email_domain := lower(split_part(account_row.email, '@', 2));

  attest_reason := case
    when actor_account = application.account_id then 'SELF'
    when works_at then 'WORKS_AT_FACILITY'
    when displayed <> 'submitted' then 'STATE'
    when factor_row.id is null or factor_row.enrollment_proof is null then 'AUTHENTICATOR_REQUIRED'
    when refused_identity or not identity.workforce_target_eligible(account_row) then 'ACCOUNT_INELIGIBLE'
    end;
  approve_reason := case
    when actor_account = application.account_id then 'SELF'
    when works_at then 'WORKS_AT_FACILITY'
    when displayed <> 'under_review' then 'STATE'
    when actor_account = application.attested_by then 'STEP1_BY_YOU'
    when factor_row.id is null or factor_row.id is distinct from application.factor_id
      or factor_row.enrollment_proof is null then 'AUTHENTICATOR_REQUIRED'
    when refused_identity or not identity.workforce_target_eligible(account_row) then 'ACCOUNT_INELIGIBLE'
    end;
  reject_reason := case
    when actor_account = application.account_id then 'SELF'
    when works_at then 'WORKS_AT_FACILITY'
    when displayed not in ('awaiting_authenticator', 'submitted', 'under_review') then 'STATE'
    end;

  return jsonb_build_object(
    'applicationId', application.id,
    'state', displayed,
    'version', application.row_version,
    'submittedAt', application.submitted_at,
    'expiresAt', application.expires_at,
    'applicant', jsonb_build_object('accountId', application.account_id, 'fullName', application.applicant_full_name,
      'email', account_row.email),
    'profession', application.requested_role,
    'regulator', jsonb_build_object('code', application.regulator_code, 'name', application.issuing_authority),
    'licenceNumber', application.licence_number,
    'licenceValidUntil', application.licence_valid_until,
    'authenticatorReady', application.authenticator_ready_at is not null,
    'account', jsonb_build_object('status', account_row.status, 'createdAt', account_row.created_at,
      'emailVerifiedAt', account_row.email_verified_at,
      'patientAccount', exists (select 1 from identity.patients patient where patient.account_id = account_row.id),
      'identityRejection', refused_identity),
    'staff', case when staff_row.id is null then null else jsonb_build_object('id', staff_row.id,
      'verificationStatus', staff_row.verification_status, 'version', staff_row.row_version) end,
    'authenticator', jsonb_build_object('enrolled', factor_row.id is not null and factor_row.enrollment_proof is not null,
      'factorId', factor_row.id, 'activatedAt', factor_row.activated_at,
      'enrolledAfterRecovery', coalesce(factor_row.activated_at > account_row.password_changed_at
        and account_row.password_changed_at > first_submitted, false)),
    'otherMemberships', coalesce((select jsonb_agg(jsonb_build_object('facilityName', other_facility.name,
        'state', coalesce(lifecycle.state, case when membership.active then 'active' else 'inactive' end),
        'roles', coalesce((select jsonb_agg(assignment.role_code order by assignment.role_code)
          from auth.account_roles assignment where assignment.membership_id = membership.id
            and assignment.scope_type = 'facility' and assignment.revoked_at is null), '[]'::jsonb))
        order by other_facility.name, membership.id)
      from identity.staff_facility_memberships membership
      join identity.facilities other_facility on other_facility.id = membership.facility_id
      left join identity.workforce_memberships lifecycle on lifecycle.membership_id = membership.id
      where membership.account_id = application.account_id), '[]'::jsonb),
    'facility', jsonb_build_object('id', facility_row.id, 'name', facility_row.name,
      'organizationName', organization_row.name, 'lifecycleStatus', facility_row.lifecycle_status,
      'active', facility_row.active,
      'cacHint', (select left(registration.cac_registration_number, 2)
          || repeat('*', length(registration.cac_registration_number) - 4)
          || right(registration.cac_registration_number, 2)
        from identity.organization_cac_registrations registration
        where registration.organization_id = facility_row.organization_id),
      'orgAdmins', coalesce((select jsonb_agg(jsonb_build_object('displayName',
            coalesce(admin_staff.full_name, admin_account.display_name), 'email', admin_account.email)
          order by admin_account.email)
        from identity.staff_facility_memberships admin_membership
        join auth.accounts admin_account on admin_account.id = admin_membership.account_id
        left join identity.staff admin_staff on admin_staff.id = admin_membership.staff_id
        where admin_membership.organization_id = facility_row.organization_id and admin_membership.active
          and (admin_membership.membership_role = 'org_admin' or admin_membership.app_role = 'org_admin')),
        '[]'::jsonb)),
    'attestation', case when attestation_row.id is null then null else jsonb_build_object(
      'id', attestation_row.id, 'reviewerAccountId', attestation_row.reviewer_account_id,
      'reviewerName', (select coalesce(reviewer.display_name, reviewer.email) from auth.accounts reviewer
        where reviewer.id = attestation_row.reviewer_account_id),
      'validUntil', attestation_row.valid_until, 'evidenceReference', attestation_row.evidence_reference,
      'reason', attestation_row.reason, 'recordedAt', attestation_row.recorded_at,
      'checklist', application.attestation_checklist, 'factorConfirmedAt', application.factor_confirmed_at) end,
    'approval', case when application.approved_at is null then null else jsonb_build_object(
      'by', application.approved_by, 'at', application.approved_at, 'membershipId', application.membership_id) end,
    'decision', case when application.decided_at is null then null else jsonb_build_object(
      'code', application.decision_code, 'reason', application.decision_reason, 'by', application.decided_by,
      'at', application.decided_at) end,
    'accessState', case when displayed = 'approved' then identity.clinician_application_access_state(application) end,
    'rolePermissions', coalesce((select jsonb_agg(role_permission.permission_code order by role_permission.permission_code)
      from auth.role_permissions role_permission
      join auth.permissions permission_row on permission_row.code = role_permission.permission_code
        and permission_row.active
      where role_permission.role_code = application.requested_role), '[]'::jsonb),
    'flags', jsonb_build_object(
      'sameLicenceKeyOtherAccounts', (select count(distinct other_account) from (
          select other.account_id as other_account from identity.clinician_applications other
           where other.licence_key = application.licence_key and other.account_id <> application.account_id
          union
          select other_staff.account_id from identity.staff other_staff
           where other_staff.license_number is not null and other_staff.account_id <> application.account_id
             and identity.clinician_licence_key(application.regulator_code, other_staff.license_number)
               = application.licence_key) holders),
      'sameLicenceKeyOtherOpenApplications', (select count(*) from identity.clinician_applications other
        where other.licence_key = application.licence_key and other.account_id <> application.account_id
          and identity.clinician_application_displayed_state(other.state, other.expires_at)
            in ('awaiting_authenticator', 'submitted', 'under_review')),
      'sameLicenceAttestedElsewhere', exists (select 1 from identity.staff_credential_attestations attested
        where attested.account_id <> application.account_id
          and identity.clinician_licence_key(application.regulator_code, attested.credential_reference)
            = application.licence_key),
      'orgAdminNameMatch', exists (select 1 from identity.staff_facility_memberships admin_membership
        join auth.accounts admin_account on admin_account.id = admin_membership.account_id
        left join identity.staff admin_staff on admin_staff.id = admin_membership.staff_id
        where admin_membership.organization_id = facility_row.organization_id and admin_membership.active
          and admin_membership.account_id <> application.account_id
          and (admin_membership.membership_role = 'org_admin' or admin_membership.app_role = 'org_admin')
          and normalized_name in (lower(btrim(regexp_replace(coalesce(admin_staff.full_name, ''), '\s+', ' ', 'g'))),
            lower(btrim(regexp_replace(coalesce(admin_account.display_name, ''), '\s+', ' ', 'g'))))),
      'orgAdminEmailDomainMatch', exists (select 1 from identity.staff_facility_memberships admin_membership
        join auth.accounts admin_account on admin_account.id = admin_membership.account_id
        where admin_membership.organization_id = facility_row.organization_id and admin_membership.active
          and admin_membership.account_id <> application.account_id
          and (admin_membership.membership_role = 'org_admin' or admin_membership.app_role = 'org_admin')
          and lower(split_part(admin_account.email, '@', 2)) = email_domain)),
    'callerHints', jsonb_build_object(
      'attest', jsonb_build_object('allowed', attest_reason is null, 'reason', attest_reason),
      'approve', jsonb_build_object('allowed', approve_reason is null, 'reason', approve_reason),
      'reject', jsonb_build_object('allowed', reject_reason is null, 'reason', reject_reason)));
end
$$;

-- The step-1 pre-check, before Identity checks the applicant's live code: it
-- refuses whatever step 1 (C20) would refuse, in C20's order and with C20's
-- markers, so a call that would be refused anyway never reaches the
-- applicant's authenticator or failure budget (a wrong code counts against
-- the applicant). It names the applicant's account otherwise. A read only:
-- Identity calls it again after taking both account locks, and C20 checks
-- everything again under them.
create function identity.admin_clinician_application_attest_precheck(requested_application_id uuid,
  expected_version bigint)
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
declare
  actor_account uuid := identity.workforce_command_actor();
  application identity.clinician_applications%rowtype;
  facility_row identity.facilities%rowtype;
begin
  if requested_application_id is null or expected_version is null then
    raise exception using errcode = '22023', message = 'CLINICIAN_APPLICATION_COMMAND_INVALID';
  end if;
  perform identity.workforce_require_assurance(actor_account);
  select * into application from identity.clinician_applications row_read where row_read.id = requested_application_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'CLINICIAN_APPLICATION_NOT_FOUND';
  end if;
  if application.account_id = actor_account then
    raise exception using errcode = '42501', message = 'WORKFORCE_SELF_CHANGE_DENIED';
  end if;
  if application.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'ADMIN_VERSION_CONFLICT';
  end if;
  if identity.clinician_application_displayed_state(application.state, application.expires_at) <> 'submitted' then
    raise exception using errcode = '23514', message = 'CLINICIAN_APPLICATION_STATE_INVALID';
  end if;
  if identity.clinician_application_identity_refused(application.account_id) then
    raise exception using errcode = '23514', message = 'CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE';
  end if;
  select * into facility_row from identity.facilities facility where facility.id = application.facility_id;
  if facility_row.lifecycle_status <> 'verified' or not facility_row.active
     or not exists (select 1 from identity.organizations organization
                     where organization.id = facility_row.organization_id and organization.active) then
    raise exception using errcode = '23514', message = 'WORKFORCE_FACILITY_NOT_VERIFIED';
  end if;
  if identity.workforce_works_at(actor_account, facility_row.id) then
    raise exception using errcode = '42501', message = 'WORKFORCE_FACILITY_CONFLICT';
  end if;
  return application.account_id;
end
$$;

-- C19. The stored answer of an earlier command with this key, or null; a
-- different request under the key is ADMIN_IDEMPOTENCY_CONFLICT. A probe
-- only: a replay of step 1 never needs a fresh authenticator code.
create function identity.admin_clinician_application_prior(requested_operation text,
  requested_idempotency_key text, requested_sha256 char(64))
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
declare
  actor_account uuid := identity.workforce_command_actor();
  prior auth.admin_command_idempotency%rowtype;
begin
  if requested_operation is null or requested_operation not in ('workforce.clinician-application.attest',
       'workforce.clinician-application.approve', 'workforce.clinician-application.reject') then
    raise exception using errcode = '22023', message = 'CLINICIAN_APPLICATION_COMMAND_INVALID';
  end if;
  perform identity.workforce_require_assurance(actor_account);
  select * into prior from auth.admin_command_idempotency command
   where command.actor_account_id = actor_account and command.operation = requested_operation
     and command.idempotency_key = requested_idempotency_key;
  if not found then
    return null;
  end if;
  if prior.request_sha256 <> requested_sha256 then
    raise exception using errcode = '23505', message = 'ADMIN_IDEMPOTENCY_CONFLICT';
  end if;
  return prior.response;
end
$$;

-- An inner 0087 command reuses the wrapper's key under its own operation. A
-- key already used for one of those operations without this wrapper would
-- replay that other command's answer, so it is refused.
create function identity.clinician_application_inner_key_free(actor_account uuid, requested_operations text[],
  requested_idempotency_key text)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
begin
  if exists (select 1 from auth.admin_command_idempotency command
              where command.actor_account_id = actor_account and command.operation = any(requested_operations)
                and command.idempotency_key = requested_idempotency_key) then
    raise exception using errcode = '23505', message = 'ADMIN_IDEMPOTENCY_CONFLICT';
  end if;
end
$$;
revoke all on function identity.clinician_application_inner_key_free(uuid, text[], text) from public;

-- C20. Step 1: Identity has verified a live code from the applicant's
-- authenticator in this transaction (its factor is passed). Records the 0087
-- credential attestation for exactly the requested role, capped at the end of
-- the licence's expiry date (Africa/Lagos) and three years, and reserves it
-- for this application.
create function identity.admin_attest_clinician_application(
  requested_application_id uuid,
  expected_version bigint,
  requested_valid_until timestamptz,
  requested_evidence_reference text,
  requested_checklist jsonb,
  requested_factor_id uuid,
  requested_reason text,
  requested_idempotency_key text,
  requested_sha256 char(64)
) returns table (application_id uuid, state text, attestation_id uuid, valid_until timestamptz,
  application_version bigint, account_id uuid, facility_id uuid, role_code text, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
#variable_conflict use_column
declare
  actor_account uuid := identity.workforce_command_actor();
  prior auth.admin_command_idempotency%rowtype;
  application identity.clinician_applications%rowtype;
  facility_row identity.facilities%rowtype;
  staff_row identity.staff%rowtype;
  factor_row auth.mfa_factors%rowtype;
  attestation record;
  licence_end timestamptz;
  response jsonb;
begin
  if requested_application_id is null or expected_version is null
     or requested_checklist is null or jsonb_typeof(requested_checklist) <> 'object'
     or (select count(*) from jsonb_object_keys(requested_checklist)) <> 6
     or requested_checklist->'registerChecked' is distinct from 'true'::jsonb
     or requested_checklist->'licenceCurrentUntilRecorded' is distinct from 'true'::jsonb
     or requested_checklist->'identityConfirmed' is distinct from 'true'::jsonb
     or requested_checklist->'employmentConfirmed' is distinct from 'true'::jsonb
     or coalesce(requested_checklist->>'identityMethod', '') not in ('video_call_photo_id', 'in_person_photo_id')
     or jsonb_typeof(requested_checklist->'identityMethod') is distinct from 'string'
     or coalesce(requested_checklist->>'employmentChannel', '') not in ('facility_public_phone', 'in_person_visit')
     or jsonb_typeof(requested_checklist->'employmentChannel') is distinct from 'string'
     or requested_factor_id is null
     or requested_evidence_reference is null or length(btrim(requested_evidence_reference)) not between 8 and 500
     or requested_reason is null or length(btrim(requested_reason)) not between 8 and 500
     or requested_valid_until is null or requested_valid_until <= clock_timestamp()
     or requested_valid_until > clock_timestamp() + interval '3 years'
     or requested_idempotency_key is null or requested_sha256 is null then
    raise exception using errcode = '22023', message = 'CLINICIAN_APPLICATION_COMMAND_INVALID';
  end if;
  select * into application from identity.clinician_applications row_read where row_read.id = requested_application_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'CLINICIAN_APPLICATION_NOT_FOUND';
  end if;
  if application.account_id = actor_account then
    raise exception using errcode = '42501', message = 'WORKFORCE_SELF_CHANGE_DENIED';
  end if;
  perform identity.workforce_require_assurance(actor_account);
  select * into prior from auth.admin_command_idempotency command
   where command.actor_account_id = actor_account and command.operation = 'workforce.clinician-application.attest'
     and command.idempotency_key = requested_idempotency_key;
  if found then
    if prior.request_sha256 <> requested_sha256 then
      raise exception using errcode = '23505', message = 'ADMIN_IDEMPOTENCY_CONFLICT';
    end if;
    return query select (prior.response->>'applicationId')::uuid, prior.response->>'state',
      (prior.response->>'attestationId')::uuid, (prior.response->>'validUntil')::timestamptz,
      (prior.response->>'applicationVersion')::bigint, (prior.response->>'accountId')::uuid,
      (prior.response->>'facilityId')::uuid, prior.response->>'roleCode', true;
    return;
  end if;

  -- Accounts first, in id order (0073), then the application.
  perform 1 from auth.accounts account_row
   where account_row.id in (application.account_id, actor_account)
   order by account_row.id
   for update;
  select * into application from identity.clinician_applications row_lock
   where row_lock.id = requested_application_id for no key update;
  if application.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'ADMIN_VERSION_CONFLICT';
  end if;
  if identity.clinician_application_displayed_state(application.state, application.expires_at) <> 'submitted' then
    raise exception using errcode = '23514', message = 'CLINICIAN_APPLICATION_STATE_INVALID';
  end if;
  if identity.clinician_application_identity_refused(application.account_id) then
    raise exception using errcode = '23514', message = 'CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE';
  end if;
  select * into facility_row from identity.facilities facility where facility.id = application.facility_id for share;
  if facility_row.lifecycle_status <> 'verified' or not facility_row.active
     or not exists (select 1 from identity.organizations organization
                     where organization.id = facility_row.organization_id and organization.active) then
    raise exception using errcode = '23514', message = 'WORKFORCE_FACILITY_NOT_VERIFIED';
  end if;
  if identity.workforce_works_at(actor_account, facility_row.id) then
    raise exception using errcode = '42501', message = 'WORKFORCE_FACILITY_CONFLICT';
  end if;
  licence_end := (application.licence_valid_until + 1)::timestamp at time zone 'Africa/Lagos';
  if requested_valid_until > licence_end then
    raise exception using errcode = '22023', message = 'CLINICIAN_APPLICATION_COMMAND_INVALID';
  end if;
  select * into factor_row from auth.mfa_factors factor
   where factor.id = requested_factor_id and factor.account_id = application.account_id
     and factor.status = 'active' and factor.enrollment_proof is not null and factor.last_used_at >= now();
  if not found then
    raise exception using errcode = '23514', message = 'CLINICIAN_APPLICATION_AUTHENTICATOR_REQUIRED';
  end if;
  perform identity.clinician_application_inner_key_free(actor_account, array['workforce.credential.attest'],
    requested_idempotency_key);
  select * into staff_row from identity.staff staff where staff.id = application.staff_id;
  select * into attestation from identity.admin_record_credential_attestation(application.account_id,
    staff_row.row_version, array[application.requested_role], application.licence_number,
    application.issuing_authority, btrim(requested_evidence_reference), requested_valid_until,
    btrim(requested_reason), requested_idempotency_key, requested_sha256);

  update identity.clinician_applications attested
     set state = 'under_review', attested_by = actor_account, attested_at = clock_timestamp(),
         attestation_id = attestation.attestation_id,
         attestation_checklist = jsonb_build_object('registerChecked', true, 'licenceCurrentUntilRecorded', true,
           'identityMethod', requested_checklist->>'identityMethod', 'identityConfirmed', true,
           'employmentChannel', requested_checklist->>'employmentChannel', 'employmentConfirmed', true),
         factor_id = factor_row.id, factor_confirmed_at = factor_row.last_used_at,
         updated_at = clock_timestamp(), row_version = attested.row_version + 1
   where attested.id = application.id
  returning attested.* into application;

  response := jsonb_build_object('applicationId', application.id, 'state', application.state,
    'attestationId', attestation.attestation_id, 'validUntil', attestation.valid_until,
    'applicationVersion', application.row_version, 'accountId', application.account_id,
    'facilityId', application.facility_id, 'roleCode', application.requested_role);
  insert into auth.admin_command_idempotency (actor_account_id, operation, idempotency_key, request_sha256, response)
  values (actor_account, 'workforce.clinician-application.attest', requested_idempotency_key, requested_sha256,
    response);
  return query select application.id, application.state, attestation.attestation_id, attestation.valid_until,
    application.row_version, application.account_id, application.facility_id, application.requested_role, false;
end
$$;

-- C21. Step 2 by a different Super Admin: attach the account by id and grant
-- the role pinned to the step-1 attestation, in one transaction. The
-- authenticator confirmed at step 1 must still be the account's active one,
-- and no application of the account may have been rejected since with
-- identity_not_confirmed.
create function identity.admin_approve_clinician_application(
  requested_application_id uuid,
  expected_version bigint,
  requested_reason text,
  requested_idempotency_key text,
  requested_sha256 char(64)
) returns table (application_id uuid, state text, membership_id uuid, account_id uuid, facility_id uuid,
  role_code text, attestation_id uuid, attested_by uuid, application_version bigint, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
#variable_conflict use_column
declare
  actor_account uuid := identity.workforce_command_actor();
  prior auth.admin_command_idempotency%rowtype;
  application identity.clinician_applications%rowtype;
  attached record;
  granted record;
  response jsonb;
begin
  if requested_application_id is null or expected_version is null
     or requested_reason is null or length(btrim(requested_reason)) not between 8 and 500
     or requested_idempotency_key is null or requested_sha256 is null then
    raise exception using errcode = '22023', message = 'CLINICIAN_APPLICATION_COMMAND_INVALID';
  end if;
  select * into application from identity.clinician_applications row_read where row_read.id = requested_application_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'CLINICIAN_APPLICATION_NOT_FOUND';
  end if;
  if application.account_id = actor_account then
    raise exception using errcode = '42501', message = 'WORKFORCE_SELF_CHANGE_DENIED';
  end if;
  perform identity.workforce_require_assurance(actor_account);
  select * into prior from auth.admin_command_idempotency command
   where command.actor_account_id = actor_account and command.operation = 'workforce.clinician-application.approve'
     and command.idempotency_key = requested_idempotency_key;
  if found then
    if prior.request_sha256 <> requested_sha256 then
      raise exception using errcode = '23505', message = 'ADMIN_IDEMPOTENCY_CONFLICT';
    end if;
    return query select (prior.response->>'applicationId')::uuid, prior.response->>'state',
      (prior.response->>'membershipId')::uuid, (prior.response->>'accountId')::uuid,
      (prior.response->>'facilityId')::uuid, prior.response->>'roleCode', (prior.response->>'attestationId')::uuid,
      (prior.response->>'attestedBy')::uuid, (prior.response->>'applicationVersion')::bigint, true;
    return;
  end if;

  perform 1 from auth.accounts account_row
   where account_row.id in (application.account_id, actor_account)
   order by account_row.id
   for update;
  select * into application from identity.clinician_applications row_lock
   where row_lock.id = requested_application_id for no key update;
  if application.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'ADMIN_VERSION_CONFLICT';
  end if;
  if identity.clinician_application_displayed_state(application.state, application.expires_at) <> 'under_review' then
    raise exception using errcode = '23514', message = 'CLINICIAN_APPLICATION_STATE_INVALID';
  end if;
  if actor_account = application.attested_by then
    raise exception using errcode = '42501', message = 'CLINICIAN_APPLICATION_SECOND_ADMIN_REQUIRED';
  end if;
  if identity.workforce_works_at(actor_account, application.facility_id) then
    raise exception using errcode = '42501', message = 'WORKFORCE_FACILITY_CONFLICT';
  end if;
  -- An identity_not_confirmed rejection of any application of the account
  -- since step 1: no grant may rest on the earlier check.
  if identity.clinician_application_identity_refused(application.account_id) then
    raise exception using errcode = '23514', message = 'CLINICIAN_APPLICATION_ACCOUNT_INELIGIBLE';
  end if;
  if not exists (select 1 from auth.mfa_factors factor
                  where factor.id = application.factor_id and factor.account_id = application.account_id
                    and factor.status = 'active' and factor.enrollment_proof is not null) then
    raise exception using errcode = '23514', message = 'CLINICIAN_APPLICATION_AUTHENTICATOR_CHANGED';
  end if;
  perform identity.clinician_application_inner_key_free(actor_account,
    array['workforce.membership.attach', 'workforce.role.change'], requested_idempotency_key);

  select * into attached from identity.admin_attach_workforce_member(application.facility_id,
    application.account_id, null, null, btrim(requested_reason), requested_idempotency_key, requested_sha256);
  select * into granted from identity.workforce_change_role(attached.membership_id, application.facility_id,
    attached.membership_version, application.requested_role, 'grant', btrim(requested_reason),
    requested_idempotency_key, requested_sha256, application.attestation_id);
  if granted.attestation_id is distinct from application.attestation_id or not granted.role_active
     or not granted.membership_active or granted.replayed or attached.replayed then
    raise exception 'CLINICIAN_APPLICATION_GRANT_MISMATCH: the grant did not rest on the step-1 attestation';
  end if;

  update identity.clinician_applications approved
     set state = 'approved', approved_by = actor_account, approved_at = clock_timestamp(),
         membership_id = attached.membership_id, updated_at = clock_timestamp(),
         row_version = approved.row_version + 1
   where approved.id = application.id
  returning approved.* into application;

  response := jsonb_build_object('applicationId', application.id, 'state', application.state,
    'membershipId', application.membership_id, 'accountId', application.account_id,
    'facilityId', application.facility_id, 'roleCode', application.requested_role,
    'attestationId', application.attestation_id, 'attestedBy', application.attested_by,
    'applicationVersion', application.row_version);
  insert into auth.admin_command_idempotency (actor_account_id, operation, idempotency_key, request_sha256, response)
  values (actor_account, 'workforce.clinician-application.approve', requested_idempotency_key, requested_sha256,
    response);
  return query select application.id, application.state, application.membership_id, application.account_id,
    application.facility_id, application.requested_role, application.attestation_id, application.attested_by,
    application.row_version, false;
end
$$;

-- C22. Any eligible Super Admin rejects an open application with one of nine
-- fixed reasons (shown to the applicant) and an internal reason (never shown).
-- Nothing else changes: no attestation, role or membership is touched.
create function identity.admin_reject_clinician_application(
  requested_application_id uuid,
  expected_version bigint,
  requested_decision_code text,
  requested_reason text,
  requested_idempotency_key text,
  requested_sha256 char(64)
) returns table (application_id uuid, state text, decision_code text, from_state text, account_id uuid,
  facility_id uuid, further_applications_blocked boolean, application_version bigint, replayed boolean)
language plpgsql
security definer
set search_path = pg_catalog, identity, auth, platform, audit, pg_temp
as $$
#variable_conflict use_column
declare
  actor_account uuid := identity.workforce_command_actor();
  prior auth.admin_command_idempotency%rowtype;
  application identity.clinician_applications%rowtype;
  previous_state text;
  response jsonb;
begin
  if requested_application_id is null or expected_version is null
     or requested_decision_code is null or requested_decision_code not in ('licence_not_verified',
       'licence_not_current', 'details_mismatch', 'identity_not_confirmed', 'employment_not_confirmed',
       'facility_not_available', 'duplicate', 'existing_account', 'other')
     or requested_reason is null or length(btrim(requested_reason)) not between 8 and 500
     or requested_idempotency_key is null or requested_sha256 is null then
    raise exception using errcode = '22023', message = 'CLINICIAN_APPLICATION_COMMAND_INVALID';
  end if;
  select * into application from identity.clinician_applications row_read where row_read.id = requested_application_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'CLINICIAN_APPLICATION_NOT_FOUND';
  end if;
  if application.account_id = actor_account then
    raise exception using errcode = '42501', message = 'WORKFORCE_SELF_CHANGE_DENIED';
  end if;
  perform identity.workforce_require_assurance(actor_account);
  select * into prior from auth.admin_command_idempotency command
   where command.actor_account_id = actor_account and command.operation = 'workforce.clinician-application.reject'
     and command.idempotency_key = requested_idempotency_key;
  if found then
    if prior.request_sha256 <> requested_sha256 then
      raise exception using errcode = '23505', message = 'ADMIN_IDEMPOTENCY_CONFLICT';
    end if;
    return query select (prior.response->>'applicationId')::uuid, prior.response->>'state',
      prior.response->>'decisionCode', prior.response->>'fromState', (prior.response->>'accountId')::uuid,
      (prior.response->>'facilityId')::uuid, (prior.response->>'furtherApplicationsBlocked')::boolean,
      (prior.response->>'applicationVersion')::bigint, true;
    return;
  end if;

  perform 1 from auth.accounts account_row
   where account_row.id in (application.account_id, actor_account)
   order by account_row.id
   for update;
  select * into application from identity.clinician_applications row_lock
   where row_lock.id = requested_application_id for no key update;
  if application.row_version <> expected_version then
    raise exception using errcode = '40001', message = 'ADMIN_VERSION_CONFLICT';
  end if;
  if identity.workforce_works_at(actor_account, application.facility_id) then
    raise exception using errcode = '42501', message = 'WORKFORCE_FACILITY_CONFLICT';
  end if;
  if identity.clinician_application_displayed_state(application.state, application.expires_at)
       not in ('awaiting_authenticator', 'submitted', 'under_review') then
    raise exception using errcode = '23514', message = 'CLINICIAN_APPLICATION_STATE_INVALID';
  end if;
  previous_state := application.state;
  update identity.clinician_applications rejected
     set state = 'rejected', decided_by = actor_account, decided_at = clock_timestamp(),
         decision_code = requested_decision_code, decision_reason = btrim(requested_reason),
         updated_at = clock_timestamp(), row_version = rejected.row_version + 1
   where rejected.id = application.id
  returning rejected.* into application;

  response := jsonb_build_object('applicationId', application.id, 'state', application.state,
    'decisionCode', application.decision_code, 'fromState', previous_state, 'accountId', application.account_id,
    'facilityId', application.facility_id,
    'furtherApplicationsBlocked', application.decision_code = 'identity_not_confirmed',
    'applicationVersion', application.row_version);
  insert into auth.admin_command_idempotency (actor_account_id, operation, idempotency_key, request_sha256, response)
  values (actor_account, 'workforce.clinician-application.reject', requested_idempotency_key, requested_sha256,
    response);
  return query select application.id, application.state, application.decision_code, previous_state,
    application.account_id, application.facility_id, application.decision_code = 'identity_not_confirmed',
    application.row_version, false;
end
$$;

-- 6. Privileges. Every command and helper is revoked from PUBLIC here; the
-- role bootstrap (runtime-grants.sql) grants the commands to the Identity
-- runtime and keeps the helpers internal.
revoke all on function identity.clinician_signup_open(),
  platform.consume_clinician_application_quota(character, text, integer, integer, integer),
  identity.begin_clinician_application_challenge(text, uuid, character, text, character),
  identity.invalidate_clinician_application_challenge(uuid),
  identity.verify_clinician_application_signup_code(uuid, character, text, character, character),
  identity.verify_clinician_application_status_code(uuid, character, character, character),
  identity.clinician_application_session(character),
  identity.clinician_application_submit_probe(character, character, text, character),
  identity.search_clinician_application_facilities(character, text),
  identity.submit_clinician_application(character, character, text, character, text, character, text, text, text,
    text, text, date, uuid, integer, integer),
  identity.bind_clinician_application_mfa_challenge(character, uuid),
  identity.clinician_application_authenticator_ready(character, uuid, text),
  identity.current_clinician_applications(character),
  identity.withdraw_clinician_application(character, uuid, bigint),
  identity.file_clinician_application(character, text, character, text, text, text, date, uuid, integer, integer),
  identity.end_clinician_application_session(character),
  identity.expire_clinician_applications(integer),
  identity.prune_clinician_application_artifacts(),
  identity.admin_list_clinician_applications(text, timestamptz, uuid, integer),
  identity.admin_get_clinician_application(uuid),
  identity.admin_clinician_application_attest_precheck(uuid, bigint),
  identity.admin_clinician_application_prior(text, text, character),
  identity.admin_attest_clinician_application(uuid, bigint, timestamptz, text, jsonb, uuid, text, text, character),
  identity.admin_approve_clinician_application(uuid, bigint, text, text, character),
  identity.admin_reject_clinician_application(uuid, bigint, text, text, text, character)
  from public;

comment on function identity.admin_attest_clinician_application(uuid, bigint, timestamptz, text, jsonb, uuid, text, text,
  character) is
  'ADR-064 step 1: the 0087 attestation for exactly the requested role, after Identity verified a live code from the applicant''s authenticator in this transaction; reserved for this application until approval.';
comment on function identity.admin_approve_clinician_application(uuid, bigint, text, text, character) is
  'ADR-064 step 2 by a different Super Admin: attach by account id and grant the role pinned to the step-1 attestation, in one transaction.';
comment on function identity.admin_reject_clinician_application(uuid, bigint, text, text, text, character) is
  'ADR-064: reject an open application with a fixed applicant-facing code; revokes nothing.';
