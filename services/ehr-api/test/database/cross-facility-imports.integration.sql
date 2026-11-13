\set ON_ERROR_STOP on
-- Cross-facility imported records on a patient's share (0124, Q64 option A):
-- the scoped share command (default off, sensitive only with other
-- facilities, replay, immutability), the two cross-facility reads (other
-- facilities only, never entered-in-error, the seal, sensitive records
-- withheld unless included, paging, one audit row per read, the marker
-- gone after the read), every refusal (no scope, another membership,
-- another facility, emergency purpose, break-glass, a PIN grant, a revoked
-- share), the sensitive-text check, and the privileges of every new object.
-- Rollback-only. Synthetic values only; uuid prefix 124.
set plpgsql.variable_conflict = error;
begin;

-- 1. Security properties and privileges.
do $$
declare
  command text;
begin
  foreach command in array array[
      'identity.create_my_consent_share_scoped(text,uuid,uuid,text,text,boolean,boolean,text,text)',
      'identity.list_my_share_scopes(text,uuid)',
      'lab.patient_imports_other_facilities(uuid,timestamptz,uuid,integer)',
      'pharmacy.patient_imports_other_facilities(uuid,timestamptz,uuid,integer)',
      'identity.cross_facility_source_name(uuid,uuid)',
      'identity.share_other_facilities_access(uuid,text,uuid,uuid,text)',
      'identity.cross_facility_read_audit(text,text,uuid,uuid,jsonb)'] loop
    if not exists (select 1 from pg_proc where oid = command::regprocedure and prosecdef
                    and proconfig = '{"search_path=pg_catalog, pg_temp"}'::text[]) then
      raise exception '% lost SECURITY DEFINER or its search_path', command;
    end if;
  end loop;
end $$;
do $$
declare
  pair text[];
  helper text;
  relation text;
  role_name text;
begin
  foreach pair slice 1 in array array[
      ['identity.create_my_consent_share_scoped(text,uuid,uuid,text,text,boolean,boolean,text,text)',
       'hid_identity_runtime, hid_schema_test_runtime'],
      ['identity.list_my_share_scopes(text,uuid)', 'hid_identity_runtime, hid_schema_test_runtime'],
      ['lab.patient_imports_other_facilities(uuid,timestamptz,uuid,integer)', 'hid_lab_runtime, hid_schema_test_runtime'],
      ['pharmacy.patient_imports_other_facilities(uuid,timestamptz,uuid,integer)',
       'hid_pharmacy_runtime, hid_schema_test_runtime']] loop
    if (select string_agg(privilege.grantee::regrole::text, ', ' order by privilege.grantee::regrole::text)
          from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
         where p.oid = pair[1]::regprocedure and privilege.privilege_type = 'EXECUTE'
           and privilege.grantee::regrole::text like 'hid\_%') is distinct from pair[2] then
      raise exception '% must be executable by % only', pair[1], pair[2];
    end if;
  end loop;
  foreach role_name in array array['hid_ehr_api_runtime', 'hid_pharmacy_api_runtime', 'hid_identity_api_runtime',
      'hid_outreach_api_runtime', 'hid_notification_worker', 'hid_event_dispatcher'] loop
    if has_function_privilege(role_name, 'lab.patient_imports_other_facilities(uuid,timestamptz,uuid,integer)', 'EXECUTE') then
      raise exception '% can run the lab cross-facility read', role_name;
    end if;
  end loop;
  foreach role_name in array array['hid_ehr_api_runtime', 'hid_lab_api_runtime', 'hid_identity_api_runtime',
      'hid_outreach_api_runtime', 'hid_notification_worker', 'hid_event_dispatcher'] loop
    if has_function_privilege(role_name, 'pharmacy.patient_imports_other_facilities(uuid,timestamptz,uuid,integer)',
         'EXECUTE') then
      raise exception '% can run the pharmacy cross-facility read', role_name;
    end if;
  end loop;
  foreach helper in array array['identity.cross_facility_text_sensitive(text)',
      'identity.cross_facility_source_name(uuid,uuid)',
      'identity.share_other_facilities_access(uuid,text,uuid,uuid,text)',
      'identity.cross_facility_read_audit(text,text,uuid,uuid,jsonb)', 'identity.patient_share_scopes_immutable()'] loop
    if exists (select 1 from pg_roles role_row where role_row.rolname like 'hid\_%'
                and has_function_privilege(role_row.oid, helper, 'EXECUTE')
                and not pg_has_role(role_row.oid, (select proowner from pg_proc where oid = helper::regprocedure),
                                    'MEMBER')) then
      raise exception 'Internal helper % must be granted to no runtime role', helper;
    end if;
  end loop;
  foreach relation in array array['identity.patient_share_scopes', 'lab.other_facility_import_reads',
      'pharmacy.other_facility_import_reads'] loop
    if exists (select 1 from pg_roles role_row where role_row.rolname like 'hid\_%'
                and not pg_has_role(role_row.oid, (select relowner from pg_class where oid = relation::regclass), 'MEMBER')
                and has_table_privilege(role_row.oid, relation, 'SELECT,INSERT,UPDATE,DELETE'))
       or not exists (select 1 from pg_class where oid = relation::regclass and relrowsecurity and relforcerowsecurity) then
      raise exception '% must have forced row security and no runtime grant', relation;
    end if;
  end loop;
  -- The new policies: SELECT, for the import tables' owner only.
  if (select count(*) from pg_policy policy_row
       where policy_row.polname in ('lab_imported_evidence_other_facilities', 'lab_imported_observations_other_facilities',
                                    'pharmacy_imports_other_facilities')
         and policy_row.polcmd = 'r' and policy_row.polroles = array[(select relowner from pg_class
                                                                       where oid = policy_row.polrelid)]) <> 3 then
    raise exception 'The cross-facility policies must be SELECT for the import tables'' owner only';
  end if;
end $$;

-- 2. The sensitive-text check (hid.ocr.sensitive/v2's lists).
do $$
declare
  sample text;
  differs boolean;
begin
  foreach sample in array array['Truvada 1 tab daily', 'TLD', 'HIV 1/2 rapid test', 'Viral load', 'GeneXpert MTB/RIF',
      'Rifampicin/Isoniazid', 'Olanzapine 10mg', 'Hb electrophoresis', 'Sickle cell screen', 'PrEP', 'CD4 count',
      'Sample ART Clinic', 'tenofovir disoproxil'] loop
    if not identity.cross_facility_text_sensitive(sample) then
      raise exception '% must be sensitive', sample;
    end if;
  end loop;
  foreach sample in array array['Full blood count', 'Paracetamol 500 mg', 'Preparation H', 'Peptic ulcer', 'Truvadax',
      'Malaria parasite', 'Fasting blood sugar', 'Amoxicillin', 'Sharing Clinic B'] loop
    if identity.cross_facility_text_sensitive(sample) then
      raise exception '% must not be sensitive', sample;
    end if;
  end loop;
  if identity.cross_facility_text_sensitive(null) then
    raise exception 'A null text is not sensitive';
  end if;
  -- With #237's 0118 applied, the two checks agree.
  if to_regprocedure('ocr.learning_value_sensitive(text)') is not null then
    foreach sample in array array['Truvada 1 tab daily', 'TLD', 'Full blood count', 'Paracetamol 500 mg', 'PrEP',
        'Preparation H', 'Peptic ulcer', 'Hb SS', 'Olanzapine', 'Malaria parasite'] loop
      execute 'select ocr.learning_value_sensitive($1) is distinct from identity.cross_facility_text_sensitive($1)'
        into strict differs using sample;
      if differs then
        raise exception 'The two sensitive checks differ on %', sample;
      end if;
    end loop;
  end if;
end $$;

-- 3. Fixtures. Facilities: A (the reader's), B (a real source), C (a real
-- source whose name is sensitive), D (a sealed demo facility). Staff: 1 a
-- doctor at A (the share's), 2 a doctor at B, 3 a doctor at A without a
-- share. Patients P1 (who will share with other facilities) and P2 (who
-- shares without), each with a live session.
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'xfac-test'), ('emergency', 'Emergency treatment', 'xfac-test')
  on conflict (code) do update set active = true;
insert into auth.accounts (id, subject, email, display_name, status, email_verified_at)
select ('12400000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'synthetic:xfac:' || n,
  'xfac-' || n || '@example.invalid', 'Xfac ' || n, 'active', clock_timestamp()
from generate_series(1, 10) n;
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status) values
  ('12420000-0000-4000-8000-000000000001', '12400000-0000-4000-8000-000000000009', 'HID-XFCPAA', 'Ada', 'Cross',
   'Ada Cross', 'active'),
  ('12420000-0000-4000-8000-000000000002', '12400000-0000-4000-8000-000000000010', 'HID-XFCPBB', 'Bola', 'Cross',
   'Bola Cross', 'active');
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id)
select ('12430000-0000-4000-8000-00000000000' || n)::uuid,
  ('12400000-0000-4000-8000-0000000000' || lpad((n + 8)::text, 2, '0'))::uuid,
  ('12430000-0000-4000-8000-00000000000' || n)::uuid, md5('xfac' || n) || md5('xfac' || n), gen_random_uuid(), 1,
  'password', clock_timestamp(), clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours',
  'patient', ('12420000-0000-4000-8000-00000000000' || n)::uuid
from generate_series(1, 2) n;
insert into identity.organizations (id, name, slug)
select ('12440000-0000-4000-8000-00000000000' || n)::uuid, 'Xfac Org ' || n, 'xfac-org-' || n
from generate_series(1, 4) n;
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('12441000-0000-4000-8000-000000000001', '12440000-0000-4000-8000-000000000001', 'Xfac Hospital A', 'XFC-A',
   'Africa/Lagos', true, 'verified'),
  ('12441000-0000-4000-8000-000000000002', '12440000-0000-4000-8000-000000000002', 'Xfac Clinic B', 'XFC-B',
   'Africa/Lagos', true, 'verified'),
  ('12441000-0000-4000-8000-000000000003', '12440000-0000-4000-8000-000000000003', 'Xfac ART Clinic C', 'XFC-C',
   'Africa/Lagos', true, 'verified'),
  ('12441000-0000-4000-8000-000000000004', '12440000-0000-4000-8000-000000000004', 'Xfac Demo Clinic D', 'XFC-D',
   'Africa/Lagos', true, 'verified');
insert into identity.sealed_demo_members (member_kind, member_id) values
  ('organization', '12440000-0000-4000-8000-000000000004'), ('facility', '12441000-0000-4000-8000-000000000004');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('12450000-0000-4000-8000-00000000000' || n)::uuid, ('12400000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  name, 'xfac-' || n || '@example.invalid', 'verified', 'doctor'
from (values (1, 'Doctor Adaeze Cross'), (2, 'Doctor Bayo Cross'), (3, 'Doctor Chika Cross')) staff_row(n, name);
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('12460000-0000-4000-8000-00000000000' || n)::uuid, ('12450000-0000-4000-8000-00000000000' || n)::uuid,
  ('12400000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  ('12440000-0000-4000-8000-00000000000' || f)::uuid, ('12441000-0000-4000-8000-00000000000' || f)::uuid,
  'doctor', 'doctor', true, true
from (values (1, 1), (2, 2), (3, 1)) m(n, f);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('12470000-0000-4000-8000-00000000000' || n)::uuid, ('12400000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
  'doctor', 'facility', ('12460000-0000-4000-8000-00000000000' || n)::uuid,
  ('12441000-0000-4000-8000-00000000000' || f)::uuid, 'Xfac suite role'
from (values (1, 1), (2, 2), (3, 1)) r(n, f);

-- Imports, written as the OCR publication would have (foreign keys and the
-- publication guards are not under test here: replica mode).
set local session_replication_role = replica;
insert into lab.imported_evidence (id, patient_id, facility_id, status, external_lab_name, external_reference,
  collected_at, reported_at, received_at, source_document_id, ocr_job_id, extraction_id, validation_id,
  validation_version, publication_id, reviewed_by, created_by, created_by_membership_id, idempotency_key,
  request_sha256, correlation_id)
select ('12480000-0000-4000-8000-00000000000' || n)::uuid, ('12420000-0000-4000-8000-00000000000' || p)::uuid,
  ('12441000-0000-4000-8000-00000000000' || f)::uuid, status, lab_name, null, null, null,
  clock_timestamp() - make_interval(days => n), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), 1, gen_random_uuid(), '12400000-0000-4000-8000-000000000002',
  '12400000-0000-4000-8000-000000000002', '12460000-0000-4000-8000-000000000002', 'xfac-lab-import-' || n,
  repeat('c', 64), 'xfac-suite'
from (values
  -- n, patient, facility, status, external laboratory
  (1, 1, 2, 'accepted', 'Xfac Diagnostics'),          -- B, ordinary: shown
  (2, 1, 2, 'accepted', 'Xfac Diagnostics'),          -- B, an HIV test: sensitive
  (3, 1, 2, 'entered_in_error', 'Xfac Diagnostics'),  -- B, entered in error: never shown
  (4, 1, 1, 'accepted', 'Xfac Diagnostics'),          -- A, the reader's own facility: not "other"
  (5, 1, 3, 'accepted', 'Xfac Diagnostics'),          -- C, a sensitive facility name
  (6, 1, 4, 'accepted', 'Xfac Diagnostics'),          -- D, demo: across the seal
  (7, 2, 2, 'accepted', 'Xfac Diagnostics'),          -- P2 at B
  (8, 1, 2, 'accepted', 'Xfac TB Laboratory')         -- B, a sensitive external laboratory
) imports(n, p, f, status, lab_name);
insert into lab.imported_observations (import_id, facility_id, patient_id, ordinal, test_code, test_name, value,
  value_text, unit, reference_range, abnormal_flag, reported_at, status)
select evidence.id, evidence.facility_id, evidence.patient_id, 1, null,
  case evidence.id when '12480000-0000-4000-8000-000000000002' then 'HIV 1/2 rapid test' else 'Haemoglobin' end,
  case evidence.id when '12480000-0000-4000-8000-000000000002' then 'Reactive' else '12.5' end, null,
  case evidence.id when '12480000-0000-4000-8000-000000000002' then null else 'g/dL' end, null, 'unknown', null, 'reported'
from lab.imported_evidence evidence where evidence.id::text like '12480000-%';
insert into pharmacy.imported_medication_evidence (id, patient_id, facility_id, source_document_id, ocr_job_id,
  extraction_id, validation_id, validation_version, publication_id, medication_text, strength_text, dose_text,
  frequency_text, historical_context, reviewed_by, created_by, created_by_membership_id, idempotency_key,
  request_sha256, correlation_id, created_at)
select ('12490000-0000-4000-8000-00000000000' || n)::uuid, ('12420000-0000-4000-8000-00000000000' || p)::uuid,
  ('12441000-0000-4000-8000-00000000000' || f)::uuid, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), 1, gen_random_uuid(), medicine, null, null, null, context, '12400000-0000-4000-8000-000000000002',
  '12400000-0000-4000-8000-000000000002', '12460000-0000-4000-8000-000000000002', 'xfac-pharmacy-import-' || n,
  repeat('d', 64), 'xfac-suite', clock_timestamp() - make_interval(days => n)
from (values
  (1, 1, 2, 'Paracetamol 500 mg', null),                     -- B, ordinary: shown
  (2, 1, 2, 'Tenofovir/Lamivudine/Dolutegravir', null),      -- B, sensitive medicine
  (3, 1, 2, 'Amoxicillin 500 mg', 'Given at the TB clinic'), -- B, sensitive context
  (4, 1, 1, 'Ibuprofen 400 mg', null),                       -- A: not "other"
  (5, 1, 4, 'Metformin 500 mg', null),                       -- D, demo: across the seal
  (6, 2, 2, 'Vitamin C', null)                               -- P2 at B
) imports(n, p, f, medicine, context);
set local session_replication_role = origin;

create function pg_temp.as_patient(n integer, correlation text) returns void language sql as $$
  select set_config('app.actor_subject', 'synthetic:xfac:' || (n + 8), true),
    set_config('app.correlation_id', correlation, true);
$$;
create function pg_temp.as_staff(n integer, facility integer, purpose text, correlation text) returns void language sql as $$
  select set_config('app.actor_subject', 'synthetic:xfac:' || n, true),
    set_config('app.facility_id', '12441000-0000-4000-8000-00000000000' || facility, true),
    set_config('app.membership_id', '12460000-0000-4000-8000-00000000000' || n, true),
    set_config('app.purpose_of_use', purpose, true), set_config('app.correlation_id', correlation, true);
$$;
create function pg_temp.share(n integer, membership integer, include_other boolean, include_sensitive boolean,
  key text, digest text) returns text language plpgsql as $$
declare outcome record;
begin
  select * into outcome from identity.create_my_consent_share_scoped('synthetic:xfac:' || (n + 8),
    ('12430000-0000-4000-8000-00000000000' || n)::uuid, ('12460000-0000-4000-8000-00000000000' || membership)::uuid,
    'clinical_review', '30d', include_other, include_sensitive, key, digest);
  return format('ok %s replayed=%s other=%s sensitive=%s', outcome.consent_grant_id, outcome.replayed::text,
    outcome.include_other_facilities::text, outcome.include_sensitive::text);
exception when others then
  return format('%s %s', sqlstate, sqlerrm);
end $$;
create function pg_temp.lab_read(patient integer, before_at timestamptz default null, before_id uuid default null,
  page integer default 20) returns text language plpgsql as $$
declare listed text;
begin
  select coalesce(string_agg(format('%s@%s', right(read_row.import_id::text, 1), right(read_row.source_facility_id::text, 1)),
      ',' order by read_row.received_at desc, read_row.import_id desc), '')
    into listed
    from lab.patient_imports_other_facilities(('12420000-0000-4000-8000-00000000000' || patient)::uuid, before_at,
      before_id, page) read_row;
  return listed;
exception when others then
  return format('%s %s', sqlstate, sqlerrm);
end $$;
create function pg_temp.pharmacy_read(patient integer) returns text language plpgsql as $$
declare listed text;
begin
  select coalesce(string_agg(format('%s@%s', right(read_row.import_id::text, 1), right(read_row.source_facility_id::text, 1)),
      ',' order by read_row.created_at desc, read_row.import_id desc), '')
    into listed
    from pharmacy.patient_imports_other_facilities(('12420000-0000-4000-8000-00000000000' || patient)::uuid, null, null,
      null) read_row;
  return listed;
exception when others then
  return format('%s %s', sqlstate, sqlerrm);
end $$;
grant execute on function pg_temp.as_patient(integer, text), pg_temp.as_staff(integer, integer, text, text),
  pg_temp.share(integer, integer, boolean, boolean, text, text),
  pg_temp.lab_read(integer, timestamptz, uuid, integer), pg_temp.pharmacy_read(integer) to public;

-- 4. Before any share: nothing crosses. A plain share (0095's command) is
-- facility-only.
set local role hid_lab_api_runtime;
select pg_temp.as_staff(1, 1, 'direct-care', 'xfac-read-00');
do $$
begin
  if pg_temp.lab_read(1) <> '42501 OTHER_FACILITIES_NOT_SHARED' then
    raise exception 'Without a share: %', pg_temp.lab_read(1);
  end if;
end $$;
reset role;

-- 5. The scoped share command (as the Identity API runtime).
set local role hid_identity_api_runtime;
select pg_temp.as_patient(1, 'xfac-share-01');
do $$
declare
  answer text;
begin
  -- Sensitive only with other facilities; nulls refused.
  answer := pg_temp.share(1, 1, false, true, 'xfac-share-invalid-0001', repeat('1', 64));
  if answer <> '22023 SHARE_REQUEST_INVALID' then raise exception 'Sensitive without other: %', answer; end if;
  answer := pg_temp.share(1, 1, null, false, 'xfac-share-invalid-0002', repeat('1', 64));
  if answer <> '22023 SHARE_REQUEST_INVALID' then raise exception 'Null scope: %', answer; end if;
  -- P2 shares with doctor 1 without other facilities: facility-only.
  perform pg_temp.as_patient(2, 'xfac-share-02');
  answer := pg_temp.share(2, 1, false, false, 'xfac-share-p2-000001', repeat('2', 64));
  if answer not like 'ok % replayed=false other=false sensitive=false' then raise exception 'P2 share: %', answer; end if;
  -- P1 shares with doctor 1, other facilities, sensitive excluded.
  perform pg_temp.as_patient(1, 'xfac-share-03');
  answer := pg_temp.share(1, 1, true, false, 'xfac-share-p1-000001', repeat('3', 64));
  if answer not like 'ok % replayed=false other=true sensitive=false' then raise exception 'P1 share: %', answer; end if;
  perform set_config('xfac.first_grant', split_part(answer, ' ', 2), true);
  -- A replay names the same scope; another scope is refused.
  answer := pg_temp.share(1, 1, true, false, 'xfac-share-p1-000001', repeat('3', 64));
  if answer <> format('ok %s replayed=true other=true sensitive=false', current_setting('xfac.first_grant')) then
    raise exception 'Replay: %', answer;
  end if;
  answer := pg_temp.share(1, 1, true, true, 'xfac-share-p1-000001', repeat('3', 64));
  if answer not like '22023 %' then raise exception 'A replay with another scope: %', answer; end if;
  answer := pg_temp.share(1, 1, false, false, 'xfac-share-p1-000001', repeat('3', 64));
  if answer not like '22023 %' then raise exception 'A replay without the scope: %', answer; end if;
  -- The patient's own scopes; another session is refused.
  if (select string_agg(format('%s %s %s', listed.consent_grant_id, listed.include_other_facilities,
                                 listed.include_sensitive), ';')
        from identity.list_my_share_scopes('synthetic:xfac:9', '12430000-0000-4000-8000-000000000001') listed)
     is distinct from format('%s t f', current_setting('xfac.first_grant')) then
    raise exception 'The patient''s scopes are wrong';
  end if;
  begin
    perform identity.list_my_share_scopes('synthetic:xfac:9', '12430000-0000-4000-8000-000000000002');
    raise exception 'Another patient''s session listed scopes';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
do $$
begin
  if (select count(*) from identity.patient_share_scopes where patient_id::text like '12420000-%') <> 1
     or not exists (select 1 from audit.events where action = 'identity.consent-grant.patient-share-scope'
                     and resource_id = current_setting('xfac.first_grant')
                     and details = '{"includeSensitive": false, "includeOtherFacilities": true}'::jsonb
                     and purpose_of_use = 'patient-self') then
    raise exception 'The scope row or its audit row is wrong';
  end if;
  begin
    update identity.patient_share_scopes set include_sensitive = true
     where consent_grant_id = current_setting('xfac.first_grant')::uuid;
    raise exception 'A scope was changed';
  exception when object_not_in_prerequisite_state then
    if sqlerrm <> 'PATIENT_SHARE_SCOPE_IMMUTABLE' then raise; end if;
  end;
end $$;

-- 6. The reads, sensitive excluded: B's ordinary records only.
set local role hid_lab_api_runtime;
select pg_temp.as_staff(1, 1, 'direct-care', 'xfac-read-01');
do $$
declare
  answer text;
  read_row record;
begin
  answer := pg_temp.lab_read(1);
  if answer <> '1@2' then raise exception 'Lab read, sensitive excluded: %', answer; end if;
  select * into read_row from lab.patient_imports_other_facilities('12420000-0000-4000-8000-000000000001', null, null, 5);
  if read_row.source_facility_name <> 'Xfac Clinic B' or read_row.status <> 'accepted'
     or read_row.external_lab_name <> 'Xfac Diagnostics'
     or read_row.observations <> '[{"unit": "g/dL", "value": "12.5", "ordinal": 1, "testCode": null, "testName": "Haemoglobin", "valueText": null, "reportedAt": null, "abnormalFlag": "unknown", "referenceRange": null}]'::jsonb then
    raise exception 'The lab row is wrong: %', row_to_json(read_row);
  end if;
  -- The runtime still reads nothing of another facility directly.
  if exists (select 1 from lab.imported_evidence where facility_id = '12441000-0000-4000-8000-000000000002')
     or exists (select 1 from lab.imported_observations where facility_id = '12441000-0000-4000-8000-000000000002') then
    raise exception 'The runtime read another facility''s imports directly';
  end if;
  -- P2's share has no scope.
  if pg_temp.lab_read(2) <> '42501 OTHER_FACILITIES_NOT_SHARED' then
    raise exception 'P2 without scope: %', pg_temp.lab_read(2);
  end if;
end $$;
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_staff(1, 1, 'direct-care', 'xfac-read-02');
do $$
begin
  if pg_temp.pharmacy_read(1) <> '1@2' then raise exception 'Pharmacy read: %', pg_temp.pharmacy_read(1); end if;
  if exists (select 1 from pharmacy.imported_medication_evidence
              where facility_id = '12441000-0000-4000-8000-000000000002') then
    raise exception 'The pharmacy runtime read another facility''s imports directly';
  end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from lab.other_facility_import_reads) <> 0
     or (select count(*) from pharmacy.other_facility_import_reads) <> 0 then
    raise exception 'A read marker outlived its read';
  end if;
  if (select count(*) from audit.events where correlation_id = 'xfac-read-01'
        and action = 'lab.import.other-facilities.list' and outcome = 'success'
        and resource_type = 'lab-imported-evidence-other-facilities'
        and resource_id = current_setting('xfac.first_grant')
        and patient_id = '12420000-0000-4000-8000-000000000001'
        and facility_id = '12441000-0000-4000-8000-000000000001'
        and actor_membership_id = '12460000-0000-4000-8000-000000000001' and purpose_of_use = 'direct-care'
        and details @> '{"returnedCount": 1, "importIds": ["12480000-0000-4000-8000-000000000001"], "sourceFacilityIds": ["12441000-0000-4000-8000-000000000002"], "includeSensitive": false, "paged": false}'::jsonb) <> 2
     or (select count(*) from audit.events where correlation_id = 'xfac-read-02'
           and action = 'pharmacy.import.other-facilities.list'
           and details @> '{"returnedCount": 1, "importIds": ["12490000-0000-4000-8000-000000000001"]}'::jsonb) <> 1 then
    raise exception 'One audit row per read, with ids and counts';
  end if;
  -- No value read is in an audit row.
  if exists (select 1 from audit.events where correlation_id like 'xfac-read-%'
              and (details::text ilike '%haemoglobin%' or details::text ilike '%paracetamol%'
                   or details::text ilike '%Xfac Clinic%')) then
    raise exception 'An audit row carries record text';
  end if;
end $$;

-- 7. Refusals: another membership at A, a doctor at B, emergency purpose,
-- break-glass, a PIN grant.
set local role hid_lab_api_runtime;
do $$
begin
  perform pg_temp.as_staff(3, 1, 'direct-care', 'xfac-refuse-01');
  if pg_temp.lab_read(1) <> '42501 OTHER_FACILITIES_NOT_SHARED' then
    raise exception 'Another membership: %', pg_temp.lab_read(1);
  end if;
  perform pg_temp.as_staff(2, 2, 'direct-care', 'xfac-refuse-02');
  if pg_temp.lab_read(1) <> '42501 OTHER_FACILITIES_NOT_SHARED' then
    raise exception 'Another facility: %', pg_temp.lab_read(1);
  end if;
  perform pg_temp.as_staff(1, 1, 'emergency', 'xfac-refuse-03');
  if pg_temp.lab_read(1) <> '42501 OTHER_FACILITIES_NOT_SHARED' then
    raise exception 'Emergency purpose: %', pg_temp.lab_read(1);
  end if;
  -- A session without a facility, or half a cursor.
  perform set_config('app.facility_id', '', true);
  if pg_temp.lab_read(1) not like '22023 %' then raise exception 'No facility: %', pg_temp.lab_read(1); end if;
  perform pg_temp.as_staff(1, 1, 'direct-care', 'xfac-refuse-04');
  if pg_temp.lab_read(1, clock_timestamp(), null) not like '22023 %' then raise exception 'Half a cursor'; end if;
end $$;
reset role;
-- Break-glass and a PIN grant for doctor 3 at A: neither is a share.
set local session_replication_role = replica;
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope, status,
  starts_at, expires_at, reason, break_glass, purpose_of_use)
values ('124a0000-0000-4000-8000-000000000001', '12420000-0000-4000-8000-000000000001',
  '12450000-0000-4000-8000-000000000003',
  '12400000-0000-4000-8000-000000000003', '12460000-0000-4000-8000-000000000003', '12441000-0000-4000-8000-000000000001',
  'break_glass', 'active', clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour',
  'Xfac suite emergency', true, 'emergency');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope, status,
  starts_at, expires_at, granted_by_patient_id, reason, break_glass, purpose_of_use, authorization_method)
values ('124a0000-0000-4000-8000-000000000002', '12420000-0000-4000-8000-000000000001',
  '12450000-0000-4000-8000-000000000003',
  '12400000-0000-4000-8000-000000000003', '12460000-0000-4000-8000-000000000003', '12441000-0000-4000-8000-000000000001',
  'read_records', 'active', clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour',
  '12420000-0000-4000-8000-000000000001', 'Xfac suite PIN', false, 'direct-care', 'patient_access_pin');
set local session_replication_role = origin;
set local role hid_lab_api_runtime;
do $$
begin
  perform pg_temp.as_staff(3, 1, 'emergency', 'xfac-refuse-05');
  if pg_temp.lab_read(1) <> '42501 OTHER_FACILITIES_NOT_SHARED' then
    raise exception 'Break-glass: %', pg_temp.lab_read(1);
  end if;
  perform pg_temp.as_staff(3, 1, 'direct-care', 'xfac-refuse-06');
  if pg_temp.lab_read(1) <> '42501 OTHER_FACILITIES_NOT_SHARED' then
    raise exception 'A PIN grant: %', pg_temp.lab_read(1);
  end if;
end $$;
reset role;
do $$
begin
  if exists (select 1 from audit.events where correlation_id like 'xfac-refuse-%'
              and action like '%.import.other-facilities.list') then
    raise exception 'A refused read wrote a success audit row';
  end if;
end $$;

-- 8. Sensitive included: a new share replaces the first (0095 D5) and so ends
-- its scope. B's sensitive records and C's appear; never D's (demo), A's or
-- the entered-in-error one. Paging by received_at and id.
set local role hid_identity_api_runtime;
select pg_temp.as_patient(1, 'xfac-share-04');
do $$
declare answer text;
begin
  answer := pg_temp.share(1, 1, true, true, 'xfac-share-p1-000002', repeat('4', 64));
  if answer not like 'ok % replayed=false other=true sensitive=true' then raise exception 'Sensitive share: %', answer; end if;
  perform set_config('xfac.second_grant', split_part(answer, ' ', 2), true);
end $$;
reset role;
-- The cursor of import 2 (read here: the runtime cannot read B's row).
select set_config('xfac.cursor_at', received_at::text, true) from lab.imported_evidence
 where id = '12480000-0000-4000-8000-000000000002';
set local role hid_lab_api_runtime;
select pg_temp.as_staff(1, 1, 'direct-care', 'xfac-read-03');
do $$
declare
  answer text;
begin
  answer := pg_temp.lab_read(1);
  if answer <> '1@2,2@2,5@3,8@2' then raise exception 'Lab read, sensitive included: %', answer; end if;
  answer := pg_temp.lab_read(1, null, null, 2);
  if answer <> '1@2,2@2' then raise exception 'First page: %', answer; end if;
  answer := pg_temp.lab_read(1, current_setting('xfac.cursor_at')::timestamptz,
    '12480000-0000-4000-8000-000000000002', 2);
  if answer <> '5@3,8@2' then raise exception 'Second page: %', answer; end if;
end $$;
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_staff(1, 1, 'direct-care', 'xfac-read-04');
do $$
begin
  if pg_temp.pharmacy_read(1) <> '1@2,2@2,3@2' then
    raise exception 'Pharmacy read, sensitive included: %', pg_temp.pharmacy_read(1);
  end if;
end $$;
reset role;
do $$
begin
  if not exists (select 1 from audit.events where correlation_id = 'xfac-read-03'
                  and resource_id = current_setting('xfac.second_grant')
                  and details @> '{"includeSensitive": true, "paged": true, "returnedCount": 2}'::jsonb) then
    raise exception 'The paged read''s audit row is wrong';
  end if;
end $$;

-- 9. A revoked share stops the next read.
set local role hid_identity_api_runtime;
select pg_temp.as_patient(1, 'xfac-revoke-01');
select 1 from identity.revoke_my_consent_grant('synthetic:xfac:9', '12430000-0000-4000-8000-000000000001',
  current_setting('xfac.second_grant')::uuid, 'Xfac suite revocation');
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_staff(1, 1, 'direct-care', 'xfac-read-05');
do $$
begin
  if pg_temp.lab_read(1) <> '42501 OTHER_FACILITIES_NOT_SHARED' then
    raise exception 'After revocation: %', pg_temp.lab_read(1);
  end if;
end $$;
reset role;

-- 10. With 0123 applied, a QA facility is across the seal from a real patient.
do $$
begin
  if to_regclass('identity.sealed_qa_members') is not null then
    insert into identity.sealed_qa_members (member_kind, member_id) values
      ('facility', '12441000-0000-4000-8000-000000000002');
    if identity.cross_facility_source_name('12420000-0000-4000-8000-000000000001',
         '12441000-0000-4000-8000-000000000002') is not null then
      raise exception 'A QA facility is on a real patient''s side';
    end if;
  end if;
  if identity.cross_facility_source_name('12420000-0000-4000-8000-000000000001',
       '12441000-0000-4000-8000-000000000004') is not null
     or identity.cross_facility_source_name('12420000-0000-4000-8000-000000000001',
       '12441000-0000-4000-8000-000000000003') <> 'Xfac ART Clinic C' then
    raise exception 'The demo seal or a real facility''s name is wrong';
  end if;
end $$;

rollback;
