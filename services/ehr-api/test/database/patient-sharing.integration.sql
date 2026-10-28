\set ON_ERROR_STOP on
-- Patient sharing (0095, B4 P1-P3 and S1): the eligibility matrix (D3), the
-- directory's escaping, limit and fields (D4), levels and durations with the
-- until-revoked horizon (D1, D2), replacement (D5), write implying read,
-- 0087's revoke on a share, the access history's three new keys, the
-- Idempotency-Key, the daily limit, another session refused, the staff
-- "shared with you" list, and the privileges of every new object.
-- Rollback-only. Synthetic values only; uuid prefix 95a.
set plpgsql.variable_conflict = error;
begin;

-- 1. Security properties and privileges.
do $$
declare
  command text;
  role_name text;
begin
  foreach command in array array['identity.search_share_providers(text,uuid,text)',
      'identity.create_my_consent_share(text,uuid,uuid,text,text,text,text)', 'identity.list_my_share_invitations(text,uuid)',
      'identity.create_my_share_invitation(text,uuid,text,text,text,text,text,text)',
      'identity.record_my_share_invitation_delivery(text,uuid,uuid,text,text,text)',
      'identity.cancel_my_share_invitation(text,uuid,uuid)', 'identity.confirm_my_share_invitation(text,uuid,uuid)',
      'identity.list_shared_with_me()', 'identity.list_share_invitations_for_me()', 'identity.accept_share_invitation(uuid)',
      'identity.expire_share_invitations(integer)', 'identity.note_record_access(uuid)',
      'identity.claim_record_access_alerts(text,integer,integer)',
      'identity.record_record_access_alert_outcome(uuid,text,text,text,text)'] loop
    if not exists (select 1 from pg_proc where oid = command::regprocedure and prosecdef
                    and proconfig = '{"search_path=pg_catalog, pg_temp"}'::text[]) then
      raise exception '% lost SECURITY DEFINER or its search_path', command;
    end if;
    if (select string_agg(privilege.grantee::regrole::text, ', ' order by privilege.grantee::regrole::text)
          from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
         where p.oid = command::regprocedure and privilege.privilege_type = 'EXECUTE'
           and privilege.grantee <> p.proowner) is distinct from 'hid_identity_runtime, hid_schema_test_runtime' then
      raise exception '% must be executable by the Identity and schema test runtimes only', command;
    end if;
    if not has_function_privilege('hid_identity_api_runtime', command, 'EXECUTE') then
      raise exception 'The Identity API runtime cannot run %', command;
    end if;
    foreach role_name in array array['hid_ehr_api_runtime', 'hid_lab_api_runtime', 'hid_pharmacy_api_runtime',
        'hid_outreach_api_runtime', 'hid_notification_api_runtime', 'hid_notification_worker', 'hid_event_dispatcher'] loop
      if has_function_privilege(role_name, command, 'EXECUTE') then
        raise exception 'Unrelated service % can run %', role_name, command;
      end if;
    end loop;
  end loop;
  foreach command in array array['identity.share_provider_eligible(uuid)', 'identity.share_provider_role(uuid)',
      'identity.share_staff_actor()', 'identity.write_patient_share(uuid,uuid,text,uuid,text,text,text,uuid,text,text)',
      'identity.close_expired_share_invitations(uuid,integer)',
      'identity.share_audit(text,text,uuid,uuid,uuid,uuid,text,text,text,uuid,text,jsonb)'] loop
    if has_function_privilege('hid_identity_api_runtime', command, 'EXECUTE')
       or has_function_privilege('hid_schema_test_runtime', command, 'EXECUTE') then
      raise exception 'Internal helper % must be granted to no role', command;
    end if;
  end loop;
  foreach command in array array['identity.patient_share_invitations', 'identity.patient_consent_shares',
      'identity.record_access_notices'] loop
    if has_table_privilege('hid_identity_api_runtime', command, 'SELECT')
       or has_table_privilege('hid_identity_api_runtime', command, 'INSERT')
       or has_table_privilege('hid_ehr_api_runtime', command, 'SELECT')
       or not exists (select 1 from pg_class where oid = command::regclass and relrowsecurity and relforcerowsecurity) then
      raise exception '% must have forced row security and no runtime grant', command;
    end if;
  end loop;
  if not exists (select 1 from pg_proc where oid = 'identity.patient_self_access_history(text,uuid)'::regprocedure
                  and prosecdef and provolatile = 's' and proconfig = '{"search_path=pg_catalog, pg_temp"}'::text[]) then
    raise exception 'The replaced access history changed its security properties';
  end if;
end $$;

-- 2. Fixtures. Facilities: A (governed, no self-service application), B (a
-- self-service facility reviewed yesterday: on probation, new), C (a
-- self-service facility not yet reviewed: pending). Memberships: a doctor
-- and a nurse at A, a lab scientist at A, a doctor at B, a doctor at C, a
-- doctor at A whose role was revoked, a doctor at A whose membership is
-- inactive, and the patient P1's own staff membership at A. Patients P1 and
-- P2 with a live session each.
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'sharing-test'), ('emergency', 'Emergency treatment', 'sharing-test')
  on conflict (code) do update set active = true;
insert into auth.accounts (id, subject, email, display_name, status, email_verified_at)
select ('95a10000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'synthetic:sharing:' || n,
  'sharing-' || n || '@example.invalid', 'Sharing ' || n, 'active', clock_timestamp()
from generate_series(1, 10) n;
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status) values
  ('95a20000-0000-4000-8000-000000000001', '95a10000-0000-4000-8000-000000000009', 'HID-SHRPAA', 'Ada', 'Share', 'Ada Share', 'active'),
  ('95a20000-0000-4000-8000-000000000002', '95a10000-0000-4000-8000-000000000010', 'HID-SHRPBB', 'Bola', 'Share', 'Bola Share', 'active');
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id)
select ('95a30000-0000-4000-8000-00000000000' || n)::uuid,
  ('95a10000-0000-4000-8000-0000000000' || lpad((n + 8)::text, 2, '0'))::uuid,
  ('95a30000-0000-4000-8000-00000000000' || n)::uuid, md5('sharing' || n) || md5('sharing' || n), gen_random_uuid(), 1,
  'password', clock_timestamp(), clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours',
  'patient', ('95a20000-0000-4000-8000-00000000000' || n)::uuid
from generate_series(1, 2) n;
insert into identity.organizations (id, name, slug) values
  ('95a40000-0000-4000-8000-000000000001', 'Sharing Governed Org', 'sharing-governed-org'),
  ('95a40000-0000-4000-8000-000000000002', 'Sharing Probation Org', 'sharing-probation-org'),
  ('95a40000-0000-4000-8000-000000000003', 'Sharing Pending Org', 'sharing-pending-org');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('95a41000-0000-4000-8000-000000000001', '95a40000-0000-4000-8000-000000000001', 'Sharing Hospital A', 'SHR-A', 'Africa/Lagos', true, 'verified'),
  ('95a41000-0000-4000-8000-000000000002', '95a40000-0000-4000-8000-000000000002', 'Sharing Clinic B', 'SHR-B', 'Africa/Lagos', true, 'verified'),
  ('95a41000-0000-4000-8000-000000000003', '95a40000-0000-4000-8000-000000000003', 'Sharing Clinic C', 'SHR-C', 'Africa/Lagos', true, 'verified');
insert into identity.organization_applications (id, product_code, organization_name, organization_type,
  cac_registration_number, administrator_name, administrator_email, status, verification_result, provider_reference,
  verified_at, organization_id, facility_id, review_reason, reviewed_at, approval_mode,
  verified_organization_name, verified_entity_type, verified_registration_date, verified_address, verified_registry_status,
  self_service_reviewed_at, self_service_reviewed_by_account_id, self_service_review_note, self_service_granted_role,
  self_service_verification_method)
values
  ('95a42000-0000-4000-8000-000000000002', 'ehr', 'Sharing Probation Org Ltd', 'clinic', 'RC9595002', 'Probation Admin',
   'admin2@sharing.invalid', 'approved', 'verified', '9502', clock_timestamp() - interval '2 days',
   '95a40000-0000-4000-8000-000000000002', '95a41000-0000-4000-8000-000000000002', 'Self-service approval for the suite',
   clock_timestamp() - interval '2 days', 'self_service', 'Sharing Probation Org Ltd', 'Private Company Limited by Shares',
   '2019-05-01', '2 Probation Road, Ikeja, Lagos', 'active', clock_timestamp() - interval '1 day',
   '95a10000-0000-4000-8000-000000000001', 'Reviewed by support for the suite', 'doctor', 'other'),
  ('95a42000-0000-4000-8000-000000000003', 'ehr', 'Sharing Pending Org Ltd', 'clinic', 'RC9595003', 'Pending Admin',
   'admin3@sharing.invalid', 'approved', 'verified', '9503', clock_timestamp() - interval '2 days',
   '95a40000-0000-4000-8000-000000000003', '95a41000-0000-4000-8000-000000000003', 'Self-service approval for the suite',
   clock_timestamp() - interval '2 days', 'self_service', 'Sharing Pending Org Ltd', 'Private Company Limited by Shares',
   '2019-05-01', '3 Pending Road, Ikeja, Lagos', 'active', null, null, null, null, null);
-- Staff n uses account n; facility per row.
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('95a50000-0000-4000-8000-00000000000' || n)::uuid, ('95a10000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  name, 'sharing-' || n || '@example.invalid', 'verified', role
from (values (1, 'Doctor Adaeze Okafor', 'doctor'), (2, 'Nurse Bisi Lawal', 'nurse'), (3, 'Lab Chidi Eze', 'lab'),
             (4, 'Doctor Dayo Bello', 'doctor'), (5, 'Doctor Emeka Pending', 'doctor'),
             (6, 'Doctor Funmi Revoked', 'doctor'), (7, 'Doctor Gbenga Inactive', 'doctor')) staff_row(n, name, role);
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('95a50000-0000-4000-8000-000000000009', '95a10000-0000-4000-8000-000000000009', 'Doctor Ada Share', 'sharing-9@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('95a60000-0000-4000-8000-00000000000' || n)::uuid, ('95a50000-0000-4000-8000-00000000000' || n)::uuid,
  ('95a10000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('95a40000-0000-4000-8000-00000000000' || f)::uuid, ('95a41000-0000-4000-8000-00000000000' || f)::uuid,
  role, role, true, active
from (values (1, 1, 'doctor', true), (2, 1, 'nurse', true), (3, 1, 'lab', true), (4, 2, 'doctor', true),
             (5, 3, 'doctor', true), (6, 1, 'doctor', true), (7, 1, 'doctor', false), (9, 1, 'doctor', true)) m(n, f, role, active);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('95a70000-0000-4000-8000-00000000000' || n)::uuid, ('95a10000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  role, 'facility', ('95a60000-0000-4000-8000-00000000000' || n)::uuid, ('95a41000-0000-4000-8000-00000000000' || f)::uuid,
  'Sharing suite role'
from (values (1, 1, 'doctor'), (2, 1, 'nurse'), (3, 1, 'lab'), (4, 2, 'doctor'), (6, 1, 'doctor'),
             (7, 1, 'doctor'), (9, 1, 'doctor')) r(n, f, role);
update auth.account_roles set revoked_at = clock_timestamp(), revoked_by = '95a10000-0000-4000-8000-000000000001',
  revocation_reason = 'Sharing suite revocation' where id = '95a70000-0000-4000-8000-000000000006';
-- A facility pending review takes no clinical role (0086's trigger refuses it,
-- FACILITY_REVIEW_PENDING); D3 also refuses it by its review state.
do $$
begin
  insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
  values ('95a70000-0000-4000-8000-000000000005', '95a10000-0000-4000-8000-000000000005', 'doctor', 'facility',
    '95a60000-0000-4000-8000-000000000005', '95a41000-0000-4000-8000-000000000003', 'Sharing suite role');
  raise exception 'A pending facility took a clinical role';
exception when raise_exception then
  if sqlerrm <> 'FACILITY_REVIEW_PENDING' then raise; end if;
end $$;

create function pg_temp.as_patient(n integer, correlation text) returns void language sql as $$
  select set_config('app.actor_subject', 'synthetic:sharing:' || (n + 8), true),
    set_config('app.correlation_id', correlation, true);
$$;
create function pg_temp.as_staff(n integer, facility integer, correlation text) returns void language sql as $$
  select set_config('app.actor_subject', 'synthetic:sharing:' || n, true),
    set_config('app.facility_id', '95a41000-0000-4000-8000-00000000000' || facility, true),
    set_config('app.membership_id', '95a60000-0000-4000-8000-00000000000' || n, true),
    set_config('app.purpose_of_use', 'direct-care', true), set_config('app.correlation_id', correlation, true);
$$;
create function pg_temp.session(n integer) returns uuid language sql as $$
  select ('95a30000-0000-4000-8000-00000000000' || n)::uuid;
$$;
create function pg_temp.share(n integer, membership integer, level text, duration text, key text, digest text)
returns text language plpgsql as $$
declare outcome record;
begin
  select * into outcome from identity.create_my_consent_share('synthetic:sharing:' || (n + 8), pg_temp.session(n),
    ('95a60000-0000-4000-8000-00000000000' || membership)::uuid, level, duration, key, digest);
  return format('ok %s %s %s replayed=%s replaced=%s', outcome.consent_grant_id, outcome.scope,
    extract(epoch from outcome.expires_at - outcome.starts_at)::bigint, outcome.replayed::text,
    (outcome.replaced_consent_grant_id is not null)::text);
exception when others then
  return format('%s %s', sqlstate, sqlerrm);
end $$;
create function pg_temp.search(n integer, session_n integer, query text) returns text language plpgsql as $$
declare listed text;
begin
  select string_agg(format('%s|%s|%s|%s|%s', result.clinician_name, result.role_code, result.facility_name,
      result.organization_name, result.new_on_health_id), ';' order by result.clinician_name)
    into listed
    from identity.search_share_providers('synthetic:sharing:' || (n + 8), pg_temp.session(session_n), query) result;
  return coalesce(listed, '');
exception when others then
  return format('%s %s', sqlstate, sqlerrm);
end $$;
grant execute on function pg_temp.as_patient(integer, text), pg_temp.as_staff(integer, integer, text),
  pg_temp.session(integer), pg_temp.share(integer, integer, text, text, text, text),
  pg_temp.search(integer, integer, text) to public;

-- 3. The directory (D3, D4), as the Identity API runtime.
set local role hid_identity_api_runtime;
select pg_temp.as_patient(1, 'sharing-search-01');
do $$
declare found text;
begin
  -- Facility A's eligible clinicians: the doctor and the nurse; never the lab
  -- scientist, the revoked role, the inactive membership or the patient's
  -- own membership.
  found := pg_temp.search(1, 1, 'Sharing Hospital');
  if found <> 'Doctor Adaeze Okafor|doctor|Sharing Hospital A|Sharing Governed Org|f;Nurse Bisi Lawal|nurse|Sharing Hospital A|Sharing Governed Org|f' then
    raise exception 'Facility A search: %', found;
  end if;
  -- Facility B (reviewed, on probation) is listed and new; C (pending) is not.
  found := pg_temp.search(1, 1, 'Probation');
  if found <> 'Doctor Dayo Bello|doctor|Sharing Clinic B|Sharing Probation Org|t' then
    raise exception 'Probation search: %', found;
  end if;
  if pg_temp.search(1, 1, 'Pending') <> '' or pg_temp.search(1, 1, 'Emeka') <> '' then
    raise exception 'A pending self-service facility must not be listed';
  end if;
  -- By the clinician's name; contains-match, any case.
  if pg_temp.search(1, 1, 'adaeze') <> 'Doctor Adaeze Okafor|doctor|Sharing Hospital A|Sharing Governed Org|f' then
    raise exception 'Name search: %', pg_temp.search(1, 1, 'adaeze');
  end if;
  -- Escaping: % and _ match themselves only.
  if pg_temp.search(1, 1, '%%%') <> '' or pg_temp.search(1, 1, '___') <> '' or pg_temp.search(1, 1, 'a\%') <> '' then
    raise exception 'Wildcards must be escaped';
  end if;
  -- Length 3-80 after trimming: 22023.
  if pg_temp.search(1, 1, '  ab ') not like '22023 %' or pg_temp.search(1, 1, repeat('a', 81)) not like '22023 %' then
    raise exception 'Query length must be 3-80';
  end if;
  -- Another patient's session is refused.
  if pg_temp.search(1, 2, 'Sharing') not like '42501 %' then
    raise exception 'Another session must be refused: %', pg_temp.search(1, 2, 'Sharing');
  end if;
end $$;
reset role;
do $$
begin
  if not exists (select 1 from audit.events where action = 'identity.share-providers.search'
                  and patient_id = '95a20000-0000-4000-8000-000000000001' and details = '{"resultCount": 2}'::jsonb
                  and actor_type = 'patient' and outcome = 'success')
     or exists (select 1 from audit.events where action = 'identity.share-providers.search'
                  and (details::text ilike '%sharing%' or details::text ilike '%adaeze%')) then
    raise exception 'The search audit must hold the result count only';
  end if;
end $$;

-- 3b. At most 25 candidates: 30 more eligible doctors at facility A.
insert into auth.accounts (id, subject, email, display_name, status)
select ('95a18000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'synthetic:sharing:many:' || n,
  'sharing-many-' || n || '@example.invalid', 'Many ' || n, 'active' from generate_series(1, 30) n;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('95a58000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('95a18000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'Doctor Many Zed ' || chr(64 + n % 26 + 1) || 'x',
  'sharing-many-' || n || '@example.invalid', 'verified', 'doctor' from generate_series(1, 30) n;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('95a68000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, ('95a58000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('95a18000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, '95a40000-0000-4000-8000-000000000001',
  '95a41000-0000-4000-8000-000000000001', 'doctor', 'doctor', true, true from generate_series(1, 30) n;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('95a78000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, ('95a18000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  'doctor', 'facility', ('95a68000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  '95a41000-0000-4000-8000-000000000001', 'Sharing suite role' from generate_series(1, 30) n;
set local role hid_identity_api_runtime;
select pg_temp.as_patient(1, 'sharing-search-02');
do $$
begin
  if (select count(*) from identity.search_share_providers('synthetic:sharing:9', pg_temp.session(1), 'Many Zed')) <> 25 then
    raise exception 'The directory must answer at most 25 candidates';
  end if;
end $$;
reset role;

-- 4. Shares: levels, durations, replacement, idempotency, eligibility.
set local role hid_identity_api_runtime;
select pg_temp.as_patient(1, 'sharing-create-01');
do $$
declare
  answer text;
  first_grant text;
begin
  -- view_only, 24h: read_records, 86400 s.
  answer := pg_temp.share(1, 1, 'view_only', '24h', 'share-key-0000000001', repeat('a', 64));
  if answer !~ '^ok \S+ read_records 86400 replayed=false replaced=false$' then raise exception 'view_only 24h: %', answer; end if;
  first_grant := split_part(answer, ' ', 2);
  perform set_config('hid.first_grant', first_grant, true);
  -- The same key and digest replays; another digest is refused.
  answer := pg_temp.share(1, 1, 'view_only', '24h', 'share-key-0000000001', repeat('a', 64));
  if answer <> format('ok %s read_records 86400 replayed=true replaced=false', first_grant) then
    raise exception 'Replay: %', answer;
  end if;
  answer := pg_temp.share(1, 1, 'view_only', '7d', 'share-key-0000000001', repeat('b', 64));
  if answer <> '55000 IDEMPOTENCY_KEY_REUSED' then raise exception 'Key reuse: %', answer; end if;
  -- clinical_collaboration, until revoked: write_records for 365 days, and it
  -- replaces the earlier share to the same membership (D5).
  answer := pg_temp.share(1, 1, 'clinical_collaboration', 'until_revoked', 'share-key-0000000002', repeat('c', 64));
  if answer !~ '^ok \S+ write_records 31536000 replayed=false replaced=true$' then
    raise exception 'collaboration until_revoked: %', answer;
  end if;
  perform set_config('hid.write_grant', split_part(answer, ' ', 2), true);
  -- clinical_review, 7d and 30d to the nurse: read_records.
  answer := pg_temp.share(1, 2, 'clinical_review', '7d', 'share-key-0000000003', repeat('d', 64));
  if answer !~ '^ok \S+ read_records 604800 replayed=false replaced=false$' then raise exception 'review 7d: %', answer; end if;
  answer := pg_temp.share(1, 4, 'clinical_review', '30d', 'share-key-0000000004', repeat('e', 64));
  if answer !~ '^ok \S+ read_records 2592000 replayed=false replaced=false$' then raise exception 'review 30d: %', answer; end if;
  perform set_config('hid.probation_grant', split_part(answer, ' ', 2), true);
  -- Ineligible: lab, pending facility, revoked role, inactive membership,
  -- the patient's own membership, an unknown membership: all P0002.
  foreach answer in array array[pg_temp.share(1, 3, 'view_only', '24h', 'share-key-0000000005', repeat('f', 64)),
      pg_temp.share(1, 5, 'view_only', '24h', 'share-key-0000000006', repeat('f', 64)),
      pg_temp.share(1, 6, 'view_only', '24h', 'share-key-0000000007', repeat('f', 64)),
      pg_temp.share(1, 7, 'view_only', '24h', 'share-key-0000000008', repeat('f', 64)),
      pg_temp.share(1, 9, 'view_only', '24h', 'share-key-0000000009', repeat('f', 64)),
      pg_temp.share(1, 8, 'view_only', '24h', 'share-key-0000000010', repeat('f', 64))] loop
    if answer <> 'P0002 SHARE_PROVIDER_UNAVAILABLE' then raise exception 'Ineligible provider: %', answer; end if;
  end loop;
  -- Invalid values: 22023; another patient's session: 42501.
  if pg_temp.share(1, 1, 'full_access', '24h', 'share-key-0000000011', repeat('f', 64)) <> '22023 SHARE_REQUEST_INVALID'
     or pg_temp.share(1, 1, 'view_only', '90d', 'share-key-0000000012', repeat('f', 64)) <> '22023 SHARE_REQUEST_INVALID'
     or pg_temp.share(1, 1, 'view_only', '24h', 'short', repeat('f', 64)) <> '22023 SHARE_REQUEST_INVALID' then
    raise exception 'Invalid values must be 22023';
  end if;
end $$;
reset role;
do $$
declare
  first_grant identity.consent_grants%rowtype;
  write_grant identity.consent_grants%rowtype;
begin
  select * into first_grant from identity.consent_grants where id = current_setting('hid.first_grant')::uuid;
  select * into write_grant from identity.consent_grants where id = current_setting('hid.write_grant')::uuid;
  if first_grant.status <> 'revoked' or first_grant.revoked_reason <> 'Replaced by a new share'
     or first_grant.revoked_by <> '95a10000-0000-4000-8000-000000000009' then
    raise exception 'D5: the earlier share must be revoked as replaced';
  end if;
  if write_grant.request_id is not null or write_grant.granted_by_patient_id <> '95a20000-0000-4000-8000-000000000001'
     or write_grant.purpose_of_use <> 'direct-care' or write_grant.break_glass or write_grant.authorization_method is not null
     or write_grant.reason <> 'Shared by the patient' or write_grant.status <> 'active'
     or (select replaced_consent_grant_id from identity.patient_consent_shares
          where consent_grant_id = write_grant.id) <> first_grant.id then
    raise exception 'The share grant is not as P2 writes it';
  end if;
  -- Write implies read, through the existing consent check.
  if not identity.has_active_consent_grant('95a20000-0000-4000-8000-000000000001', 'synthetic:sharing:1',
       '95a60000-0000-4000-8000-000000000001', '95a41000-0000-4000-8000-000000000001', 'read_records', 'direct-care',
       clock_timestamp())
     or not identity.has_active_consent_grant('95a20000-0000-4000-8000-000000000001', 'synthetic:sharing:1',
       '95a60000-0000-4000-8000-000000000001', '95a41000-0000-4000-8000-000000000001', 'write_records', 'direct-care',
       clock_timestamp())
     or identity.has_active_consent_grant('95a20000-0000-4000-8000-000000000001', 'synthetic:sharing:2',
       '95a60000-0000-4000-8000-000000000002', '95a41000-0000-4000-8000-000000000001', 'write_records', 'direct-care',
       clock_timestamp()) then
    raise exception 'A collaboration share must allow read and write; a review share read only';
  end if;
  if (select count(*) from identity.patient_consent_shares share join identity.consent_grants g on g.id = share.consent_grant_id
       where share.patient_id = '95a20000-0000-4000-8000-000000000001'
         and share.membership_id = '95a60000-0000-4000-8000-000000000001' and g.status = 'active') <> 1 then
    raise exception 'There must never be two active shares to one membership';
  end if;
  if not exists (select 1 from audit.events where action = 'identity.consent-grant.patient-share'
                  and resource_id = current_setting('hid.write_grant')
                  and details @> '{"scope": "write_records", "level": "clinical_collaboration", "duration": "until_revoked", "replaced": true}'::jsonb) then
    raise exception 'The share audit row is missing';
  end if;
  begin
    update identity.patient_consent_shares set level = 'view_only' where consent_grant_id = write_grant.id;
    raise exception 'A share row must not change';
  exception when sqlstate '55000' then null; when raise_exception then
    if sqlerrm = 'A share row must not change' then raise; end if;
  end;
end $$;

-- 5. The access history's new keys, and 0087's revoke on a share.
set local role hid_identity_api_runtime;
select pg_temp.as_patient(1, 'sharing-history-01');
do $$
declare
  item jsonb;
  revoked record;
begin
  select entry into item from jsonb_array_elements(identity.patient_self_access_history('synthetic:sharing:9',
    pg_temp.session(1))->'items') entry where entry->>'consentGrantId' = current_setting('hid.write_grant');
  if item->>'shareLevel' <> 'clinical_collaboration' or item->>'shareDuration' <> 'until_revoked'
     or item->>'clinicianName' <> 'Doctor Adaeze Okafor' or (item->>'revocableByPatient')::boolean is not true then
    raise exception 'History item of a share: %', item;
  end if;
  select * into revoked from identity.revoke_my_consent_grant('synthetic:sharing:9', pg_temp.session(1),
    current_setting('hid.write_grant')::uuid, 'No longer needed');
  if revoked.grant_status <> 'revoked' or revoked.replayed then raise exception '0087 revoke of a share failed'; end if;
end $$;
reset role;

-- 6. The staff "shared with you" list (S1).
set local role hid_identity_api_runtime;
select pg_temp.as_staff(4, 2, 'sharing-staff-01');
do $$
declare listed record; total integer;
begin
  select count(*) into total from identity.list_shared_with_me();
  select * into listed from identity.list_shared_with_me() limit 1;
  if total <> 1 or listed.hid <> 'HID-SHRPAA' or listed.full_name <> 'Ada Share' or listed.level <> 'clinical_review'
     or listed.duration_preset <> '30d' or listed.scope <> 'read_records'
     or listed.consent_grant_id <> current_setting('hid.probation_grant')::uuid then
    raise exception 'Shared with you at facility B: % rows, %', total, listed;
  end if;
end $$;
select pg_temp.as_staff(1, 1, 'sharing-staff-02');
do $$
begin
  -- The doctor's share was revoked (section 5): nothing listed.
  if (select count(*) from identity.list_shared_with_me()) <> 0 then raise exception 'A revoked share is listed'; end if;
end $$;
-- Another facility's context for the same membership is refused.
select pg_temp.as_staff(1, 2, 'sharing-staff-03');
do $$
begin
  perform identity.list_shared_with_me();
  raise exception 'A membership at another facility must be refused';
exception when insufficient_privilege then null;
end $$;
reset role;

-- 7. At most 20 shares in 24 hours (P0001).
set local role hid_identity_api_runtime;
select pg_temp.as_patient(2, 'sharing-limit-01');
do $$
declare answer text;
begin
  for n in 1..20 loop
    answer := pg_temp.share(2, 1, 'view_only', '24h', 'limit-key-' || lpad(n::text, 10, '0'), repeat('a', 64));
    if answer not like 'ok %' then raise exception 'Share % refused: %', n, answer; end if;
  end loop;
  answer := pg_temp.share(2, 1, 'view_only', '24h', 'limit-key-0000000021', repeat('a', 64));
  if answer <> 'P0001 SHARE_CREATE_LIMITED' then raise exception 'The 21st share: %', answer; end if;
  -- A replay of an earlier key still answers.
  if pg_temp.share(2, 1, 'view_only', '24h', 'limit-key-0000000001', repeat('a', 64)) not like 'ok % replayed=true %' then
    raise exception 'A replay after the limit must answer';
  end if;
end $$;
reset role;

rollback;
