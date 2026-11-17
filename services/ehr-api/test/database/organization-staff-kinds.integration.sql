\set ON_ERROR_STOP on
-- The kinds of an organisation for the staff sign-in gate (0124, owner
-- decisions Q90 and Q91 of 17 November 2026). Rollback-only.
--   1. identity.organization_staff_kinds(uuid): STABLE, SECURITY DEFINER,
--      search_path pinned, the owner of identity.organization_self_service_state;
--      EXECUTE for hid_identity_runtime (and hid_identity_api_runtime through
--      it) only: not PUBLIC, not the schema test runtime, no other runtime; the
--      Identity runtime still holds no privilege on the application and product
--      tables;
--   2. what it answers, on fictional organisations: nothing recorded (no
--      application) is empty; a governed application behind an active product
--      gives its kind; a suspended product, an application with no product row
--      and another organisation's application give nothing; several products
--      (a reused organisation) give each kind once, sorted; 'other' gives
--      hospital with ehr or migrate and nothing with laboratory or pharmacy;
--      a pending or reviewed self sign-up gives its kind (also when its
--      product row is suspended); a released one gives nothing; null gives
--      empty; called as the Identity runtime it answers the same;
--   3. the sealed tenants, as 0098 and 0123 seed them (installed here as the
--      owner, as their suites do): QA Hospital, Demo Hospital and Demo
--      Outreach have no kind; QA Laboratory and Demo Laboratory are
--      laboratory; QA Pharmacy and Demo Pharmacy pharmacy. admin@'s three
--      memberships, read as the staff context reads them (one lateral call per
--      membership), give QA Hospital [], QA Laboratory {laboratory} and QA
--      Pharmacy {pharmacy}.
-- Synthetic values only: uuid prefix a124, @example.invalid addresses, CAC
-- numbers RC0000000000000124xxx.
set plpgsql.variable_conflict = error;
begin;
set constraints all deferred;

do $$
begin
  if not (select role_row.rolsuper or role_row.rolbypassrls from pg_proc proc
            join pg_roles role_row on role_row.oid = proc.proowner
           where proc.oid = 'platform.control_enabled(text)'::regprocedure) then
    alter table platform.control_settings no force row level security;
  end if;
end $$;
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'staff-kinds-test'), ('emergency', 'Emergency', 'staff-kinds-test')
  on conflict (code) do update set active = true;

create function pg_temp.assert(label text, condition boolean, detail text default null)
returns void language plpgsql as $f$
begin
  if condition is not true then
    raise exception 'organization staff kinds: % failed%', label, coalesce(': ' || detail, '');
  end if;
end
$f$;

-- 1. The function and its privileges.
do $$
declare
  runtime_role text;
  everyone constant text[] := array['hid_identity_runtime', 'hid_identity_api_runtime', 'hid_schema_test_runtime',
    'hid_ehr_runtime', 'hid_ehr_api_runtime', 'hid_api_runtime', 'hid_lab_runtime', 'hid_lab_api_runtime',
    'hid_pharmacy_runtime', 'hid_pharmacy_api_runtime', 'hid_outreach_runtime', 'hid_outreach_api_runtime',
    'hid_ocr_runtime', 'hid_ocr_api_runtime', 'hid_ocr_worker', 'hid_notification_api_runtime',
    'hid_notification_worker', 'hid_event_dispatcher', 'hid_audit_writer', 'hid_document_scanner'];
begin
  perform pg_temp.assert('the function is STABLE, SECURITY DEFINER, returns text[] and pins its search_path',
    exists (select 1 from pg_proc proc
             where proc.oid = 'identity.organization_staff_kinds(uuid)'::regprocedure
               and proc.prosecdef and proc.provolatile = 's' and not proc.proretset
               and proc.prorettype = 'text[]'::regtype
               and proc.proconfig = array['search_path=pg_catalog, identity, pg_temp']));
  perform pg_temp.assert('its owner is the owner of identity.organization_self_service_state',
    (select proowner from pg_proc where oid = 'identity.organization_staff_kinds(uuid)'::regprocedure)
    = (select proowner from pg_proc where oid = 'identity.organization_self_service_state(uuid)'::regprocedure));
  perform pg_temp.assert('PUBLIC cannot execute it',
    not exists (select 1 from pg_proc proc, lateral aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
                 where proc.oid = 'identity.organization_staff_kinds(uuid)'::regprocedure and acl.grantee = 0));
  foreach runtime_role in array everyone loop
    continue when not exists (select 1 from pg_roles where rolname = runtime_role);
    perform pg_temp.assert(runtime_role || ' has the right EXECUTE',
      has_function_privilege(runtime_role, 'identity.organization_staff_kinds(uuid)', 'EXECUTE')
        = (runtime_role in ('hid_identity_runtime', 'hid_identity_api_runtime')));
    perform pg_temp.assert(runtime_role || ' holds no privilege on the application and product tables',
      not has_table_privilege(runtime_role, 'identity.organization_applications', 'SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege(runtime_role, 'identity.organization_products', 'SELECT,INSERT,UPDATE,DELETE'));
  end loop;
end $$;

-- 2. Fictional organisations. A reviewer account, then one organisation and
-- facility per case.
insert into auth.accounts (id, subject, email, display_name, status) values
  ('a1240003-0000-4000-8000-000000000001', 'synthetic:staff-kinds:reviewer', 'staff-kinds-reviewer@example.invalid',
   'Staff Kinds Reviewer', 'active');

create temp table kinds_case (key text primary key, organization_id uuid not null, facility_id uuid not null);
insert into kinds_case (key, organization_id, facility_id)
select key, ('a1240001-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       ('a1240002-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
  from unnest(array['none', 'lab', 'pharmacy', 'hospital', 'clinic', 'lab_and_pharmacy', 'lab_and_hospital',
    'suspended', 'no_product', 'other_ehr', 'other_migrate', 'other_lab', 'other_pharmacy_with_lab',
    'self_pending', 'self_reviewed', 'self_released', 'self_pending_suspended', 'self_other_ehr'])
       with ordinality listed(key, n);
insert into identity.organizations (id, name, slug)
select organization_id, 'Staff Kinds ' || key, 'staff-kinds-' || replace(key, '_', '-') from kinds_case;
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
select facility_id, organization_id, 'Staff Kinds ' || key, 'SK-' || upper(replace(key, '_', '-')), 'Africa/Lagos',
       true, 'verified'
  from kinds_case;

-- An application (governed unless self_service) and, unless product_status is null, its product row.
create function pg_temp.application(case_key text, n integer, product text, kind text,
  product_status text default 'active', self_service text default null)
returns void language plpgsql as $f$
declare
  target kinds_case%rowtype;
  application_id uuid := ('a1240007-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid;
begin
  select * into strict target from kinds_case where key = case_key;
  insert into identity.organization_applications (id, product_code, organization_name, organization_type,
    cac_registration_number, administrator_name, administrator_email, status, verification_result, verified_at,
    organization_id, facility_id, first_admin_account_id, reviewed_by_account_id, review_reason, reviewed_at,
    verified_organization_name, approval_mode)
  values (application_id, product, 'Staff Kinds ' || case_key, kind, 'RC0000000000000124' || lpad(n::text, 3, '0'),
    'Staff Kinds Admin', 'staff-kinds-admin@example.invalid', 'approved', 'verified', clock_timestamp(),
    target.organization_id, target.facility_id, 'a1240003-0000-4000-8000-000000000001',
    case when self_service is null then 'a1240003-0000-4000-8000-000000000001'::uuid end,
    'Staff kinds suite application', clock_timestamp() - make_interval(secs => 1000 - n), 'Staff Kinds ' || case_key,
    case when self_service is null then 'admin_review' else 'self_service' end);
  if self_service = 'reviewed' then
    update identity.organization_applications
       set self_service_reviewed_at = clock_timestamp(),
           self_service_reviewed_by_account_id = 'a1240003-0000-4000-8000-000000000001',
           self_service_review_note = 'Staff kinds suite review', self_service_granted_role = 'none',
           self_service_verification_method = 'other'
     where id = application_id;
  elsif self_service = 'released' then
    update identity.organization_applications
       set status = 'rejected', self_service_released_at = clock_timestamp(),
           self_service_released_by_account_id = 'a1240003-0000-4000-8000-000000000001',
           self_service_release_reason = 'Staff kinds suite release'
     where id = application_id;
  end if;
  if product_status is not null then
    insert into identity.organization_products (organization_id, product_code, facility_id, status,
      source_application_id)
    values (target.organization_id, product, target.facility_id, product_status, application_id);
  end if;
end
$f$;

select pg_temp.application('lab', 1, 'laboratory', 'laboratory');
select pg_temp.application('pharmacy', 2, 'pharmacy', 'pharmacy');
select pg_temp.application('hospital', 3, 'ehr', 'hospital');
select pg_temp.application('clinic', 4, 'migrate', 'clinic');
select pg_temp.application('lab_and_pharmacy', 5, 'laboratory', 'laboratory');
select pg_temp.application('lab_and_pharmacy', 6, 'pharmacy', 'pharmacy');
select pg_temp.application('lab_and_hospital', 7, 'laboratory', 'laboratory');
select pg_temp.application('lab_and_hospital', 8, 'ehr', 'hospital');
select pg_temp.application('lab_and_hospital', 9, 'migrate', 'hospital');
select pg_temp.application('suspended', 10, 'laboratory', 'laboratory', 'suspended');
select pg_temp.application('no_product', 11, 'pharmacy', 'pharmacy', null);
select pg_temp.application('other_ehr', 12, 'ehr', 'other');
select pg_temp.application('other_migrate', 13, 'migrate', 'other');
select pg_temp.application('other_lab', 14, 'laboratory', 'other');
select pg_temp.application('other_pharmacy_with_lab', 15, 'pharmacy', 'other');
select pg_temp.application('other_pharmacy_with_lab', 16, 'laboratory', 'laboratory');
select pg_temp.application('self_pending', 17, 'laboratory', 'laboratory', 'active', 'pending');
select pg_temp.application('self_reviewed', 18, 'pharmacy', 'pharmacy', 'active', 'reviewed');
select pg_temp.application('self_released', 19, 'laboratory', 'laboratory', 'suspended', 'released');
select pg_temp.application('self_pending_suspended', 20, 'pharmacy', 'pharmacy', 'suspended', 'pending');
select pg_temp.application('self_other_ehr', 21, 'ehr', 'other', 'active', 'pending');

create temp table kinds_expected (key text primary key, kinds text[] not null);
insert into kinds_expected values
  ('none', '{}'), ('lab', '{laboratory}'), ('pharmacy', '{pharmacy}'), ('hospital', '{hospital}'),
  ('clinic', '{clinic}'), ('lab_and_pharmacy', '{laboratory,pharmacy}'), ('lab_and_hospital', '{hospital,laboratory}'),
  ('suspended', '{}'), ('no_product', '{}'), ('other_ehr', '{hospital}'), ('other_migrate', '{hospital}'),
  ('other_lab', '{}'), ('other_pharmacy_with_lab', '{laboratory}'), ('self_pending', '{laboratory}'),
  ('self_reviewed', '{pharmacy}'), ('self_released', '{}'), ('self_pending_suspended', '{pharmacy}'),
  ('self_other_ehr', '{hospital}');
grant select on kinds_case, kinds_expected to hid_identity_runtime;

do $$
declare
  mismatch text;
begin
  select string_agg(format('%s: %s, expected %s', kinds_case.key,
           identity.organization_staff_kinds(kinds_case.organization_id), kinds_expected.kinds), '; ')
    into mismatch
    from kinds_case join kinds_expected using (key)
   where identity.organization_staff_kinds(kinds_case.organization_id) is distinct from kinds_expected.kinds;
  perform pg_temp.assert('every fictional organisation answers its kinds', mismatch is null, mismatch);
  perform pg_temp.assert('the self sign-up cases are the state organization_self_service_state reads',
    (select array_agg(kinds_case.key || ':' || coalesce(state.review_state, 'none') order by kinds_case.key)
       from kinds_case left join lateral identity.organization_self_service_state(kinds_case.organization_id) state on true
      where kinds_case.key like 'self%')
    = array['self_other_ehr:pending', 'self_pending:pending', 'self_pending_suspended:pending',
            'self_released:released', 'self_reviewed:reviewed']);
  perform pg_temp.assert('null and an unknown organisation answer empty',
    identity.organization_staff_kinds(null) = '{}'::text[]
    and identity.organization_staff_kinds('a1240001-0000-4000-8000-0000000000ff') = '{}'::text[]);
  perform pg_temp.assert('an organisation answers only its own applications (a facility id is not an organisation)',
    identity.organization_staff_kinds((select facility_id from kinds_case where key = 'lab')) = '{}'::text[]);
end $$;

-- Called as the Identity runtime: the same answers, and still no direct read.
set local role hid_identity_runtime;
do $$
begin
  perform pg_temp.assert('the Identity runtime reads the same kinds',
    not exists (select 1 from kinds_case join kinds_expected using (key)
                 where identity.organization_staff_kinds(kinds_case.organization_id) is distinct from kinds_expected.kinds));
  begin
    perform 1 from identity.organization_applications limit 1;
    perform pg_temp.assert('the Identity runtime cannot read the applications', false);
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- 3. The sealed tenants (installed here as the owner, as their suites do).
update platform.control_settings set enabled = true
 where control_key in ('cross_facility_orders_enabled', 'outreach_organiser_signup_enabled');
select identity.sealed_demo_install();
select identity.sealed_qa_install();

do $$
declare
  answered text[];
begin
  select array_agg(organization.name || '=' || identity.organization_staff_kinds(organization.id)::text
                   order by organization.name)
    into answered
    from identity.organizations organization
   where organization.slug like 'sealed-qa-%' or organization.slug like 'sealed-demo-%';
  perform pg_temp.assert('the sealed tenants answer their kinds',
    answered = array['Demo Hospital={}', 'Demo Laboratory={laboratory}', 'Demo Outreach={}',
      'Demo Pharmacy={pharmacy}', 'QA Hospital={}', 'QA Laboratory={laboratory}', 'QA Pharmacy={pharmacy}'],
    answered::text);
  -- admin@ (QA Facility Admin, org_admin at all three), one lateral call per
  -- membership as the staff context makes it.
  select array_agg(facility.name || '=' || kinds.organization_kinds::text order by facility.name)
    into answered
    from identity.staff_facility_memberships membership
    join identity.facilities facility on facility.id = membership.facility_id
    left join lateral identity.organization_staff_kinds(membership.organization_id) kinds(organization_kinds) on true
   where membership.account_id = 'c0a00003-0000-4000-8000-000000000006' and membership.active;
  perform pg_temp.assert('admin@: QA Hospital no kind, QA Laboratory laboratory, QA Pharmacy pharmacy',
    answered = array['QA Hospital={}', 'QA Laboratory={laboratory}', 'QA Pharmacy={pharmacy}'], answered::text);
end $$;

select 'organization staff kinds: passed' as result;
rollback;
