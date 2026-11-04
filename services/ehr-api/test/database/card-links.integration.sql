\set ON_ERROR_STOP on
-- Card links (0118; Akos handover step 8, the design and critique of
-- 2026-11-04 and the owner's answers "all recommended"). Rollback-only;
-- synthetic values only; uuid prefix e8. Identity commands run as
-- hid_identity_api_runtime and the EHR read as hid_ehr_api_runtime, as the
-- services run them. Ages are set with triggers off (session_replication_role
-- replica), as only a test may.
--   1. Shape and privileges: five tables under forced RLS with one owner
--      policy, no grant, no-delete and no-truncate triggers; the 13 identity
--      commands executable by the identity runtimes only, the two EHR
--      functions by the EHR runtimes only, the helpers by nobody; eleven
--      SELECT-only card_share_read policies; the deletion trigger.
--   2. Create: created, replayed (same key and body), IDEMPOTENCY_KEY_REUSED;
--      a second link to the same address ends the first (replaced, address
--      erased, view and code ended); invalid input; 2 a day per address, 5 a
--      day, 20 live; a blocked address and an address past 50 emails a day
--      across patients are made but not emailed, read by the patient as
--      not_sent; the new-link email to the patient queued; another patient's
--      session cannot end it; ending is idempotent.
--   3. Codes: unknown, ended and expired tokens answer the same 'ended'; a
--      code a minute, 3 an hour, 6 a Lagos day; a new code ends the old one.
--   4. Verify: wrong tries, a right code from another browser is wrong, 5
--      wrong kill the code, 3 dead codes lock the link an hour (patient told),
--      issue and verify refuse while locked, a second lock ends the link
--      (patient told once); an expired code; a right code opens one view
--      (open count, audit, inbox, one email row per Lagos day); a second open
--      ends the first view (one view per link).
--   5. EHR context: a live view reads its own patient's completed visits,
--      signed notes and their current revision, the imported history and
--      profile, the reported health information and active entries only;
--      "Card only" reads the reported health information only; nothing for
--      another patient, an ended, expired or replaced view, an ended link, an
--      inactive patient, a deletion-due login, or with a patient, account,
--      session, facility or membership set; SELECT only (no FOR UPDATE rows,
--      no UPDATE); the runtimes cannot read the identity tables or call each
--      other's functions; the patient's own read and a clinician's read are
--      unchanged; the view context audits ehr.card-share.records.read.
--   6. View, close and stop: the card again for a live view; Close; "Stop
--      these emails" blocks the address and ends every live link to it.
--   7. Lifecycle: the sweeper ends links past their end, ends views and codes,
--      erases network data after 30 days and the hint and address HMAC 12
--      months after the end; patient emails claim, lease, retry and record;
--      account deletion ends and anonymises at once and suppresses emails;
--      guards (identity fields, ended stays ended, counters, DELETE, TRUNCATE).
--   8. Audit and Activity: no address, hint, code or token in any audit row;
--      Activity shows card_opened by card_recipient with the hint, and
--      card_shared and card_ended; opens of two links stay two entries; the
--      EHR records read is not an entry.
set plpgsql.variable_conflict = error;
begin;
set constraints all deferred;

-- 1. Shape and privileges.
do $$
declare
  mismatch text;
  proc_name text;
  identity_commands text[] := array[
    'identity.create_my_card_share(text,uuid,uuid,text,text,bytea,text,text,text,text,text,text,text)',
    'identity.list_my_card_shares(text,uuid)', 'identity.end_my_card_share(text,uuid,uuid)',
    'identity.record_my_card_share_delivery(text,uuid,uuid,text,text,text)',
    'identity.issue_card_share_code(text,uuid,text,text,text,text)', 'identity.record_card_share_code_delivery(uuid,text)',
    'identity.verify_card_share_code(text,text,text,uuid,text,text)', 'identity.card_share_view(uuid,text)',
    'identity.end_card_share_view(uuid,text)', 'identity.stop_card_share_emails(uuid)',
    'identity.close_expired_card_shares(integer)', 'identity.claim_card_share_emails(text,integer,integer)',
    'identity.record_card_share_email_outcome(uuid,text,text,text,text)'];
  ehr_functions text[] := array['ehr.card_share_read_context(uuid,text)', 'ehr.card_share_view_context()'];
  helpers text[] := array['identity.guard_card_share_mutation()', 'identity.guard_card_share_code_mutation()',
    'identity.guard_card_share_view_mutation()', 'identity.guard_card_share_block_mutation()',
    'identity.card_share_audit(text,text,uuid,uuid,text,text,uuid,jsonb)', 'identity.card_share_patient_state(uuid)',
    'identity.end_card_share_row(uuid,text)', 'identity.close_card_share_if_due(identity.card_shares)',
    'identity.card_share_item(identity.card_shares)', 'identity.card_share_card(identity.card_shares,identity.card_share_views)',
    'identity.queue_card_share_patient_email(identity.card_shares,text)', 'identity.require_card_share_system()',
    'identity.close_card_shares_for_deleted_account()'];
begin
  select string_agg(relation.relname, ', ') into mismatch
    from pg_class relation
   where relation.relnamespace = 'identity'::regnamespace
     and relation.relname in ('card_shares', 'card_share_codes', 'card_share_views', 'card_share_patient_emails',
       'card_share_address_blocks')
     and (not relation.relrowsecurity or not relation.relforcerowsecurity
       or (select string_agg(policy.polname, ',') from pg_policy policy where policy.polrelid = relation.oid)
          is distinct from relation.relname || '_owner'
       or exists (select 1 from aclexplode(coalesce(relation.relacl, acldefault('r', relation.relowner))) acl
                   where acl.grantee <> relation.relowner)
       or (select count(*) from pg_trigger trigger_row where trigger_row.tgrelid = relation.oid
             and trigger_row.tgname in (relation.relname || '_no_delete', relation.relname || '_no_truncate')) <> 2);
  if mismatch is not null or (select count(*) from pg_class where relnamespace = 'identity'::regnamespace
      and relname in ('card_shares', 'card_share_codes', 'card_share_views', 'card_share_patient_emails',
        'card_share_address_blocks')) <> 5 then
    raise exception 'Card link tables not as 0118 makes them: %', coalesce(mismatch, 'missing');
  end if;
  foreach proc_name in array identity_commands loop
    select string_agg(coalesce(nullif(privilege.grantee::regrole::text, '-'), 'public'), ', '
        order by privilege.grantee::regrole::text) into mismatch
      from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
     where p.oid = proc_name::regprocedure and privilege.privilege_type = 'EXECUTE' and privilege.grantee <> p.proowner;
    if mismatch is distinct from 'hid_identity_runtime, hid_schema_test_runtime' then
      raise exception '% is executable by %', proc_name, coalesce(mismatch, 'its owner only');
    end if;
    if has_function_privilege('hid_ehr_api_runtime', proc_name, 'EXECUTE')
       or not has_function_privilege('hid_identity_api_runtime', proc_name, 'EXECUTE') then
      raise exception '% is not the identity runtime''s alone', proc_name;
    end if;
  end loop;
  foreach proc_name in array ehr_functions loop
    select string_agg(coalesce(nullif(privilege.grantee::regrole::text, '-'), 'public'), ', '
        order by privilege.grantee::regrole::text) into mismatch
      from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
     where p.oid = proc_name::regprocedure and privilege.privilege_type = 'EXECUTE' and privilege.grantee <> p.proowner;
    if mismatch is distinct from 'hid_ehr_runtime, hid_schema_test_runtime' then
      raise exception '% is executable by %', proc_name, coalesce(mismatch, 'its owner only');
    end if;
    if has_function_privilege('hid_identity_api_runtime', proc_name, 'EXECUTE') then
      raise exception 'The identity runtime may call %', proc_name;
    end if;
  end loop;
  foreach proc_name in array helpers loop
    if exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) privilege
                where p.oid = proc_name::regprocedure and privilege.privilege_type = 'EXECUTE'
                  and privilege.grantee <> p.proowner) then
      raise exception 'The helper % is executable by a role', proc_name;
    end if;
  end loop;
  select string_agg(expected, ', ') into mismatch
    from unnest(identity_commands || ehr_functions) expected
    left join pg_proc proc on proc.oid = to_regprocedure(expected)
   where proc.oid is null or not proc.prosecdef
      or proc.proconfig is distinct from '{"search_path=pg_catalog, pg_temp"}'::text[];
  if mismatch is not null then raise exception 'Without SECURITY DEFINER or search_path: %', mismatch; end if;
  if (select count(*) from pg_policies where schemaname = 'ehr' and policyname like '%\_card\_share\_read'
        and cmd = 'SELECT' and permissive = 'PERMISSIVE') <> 11
     or exists (select 1 from pg_policies where schemaname = 'ehr' and policyname like '%card_share%' and cmd <> 'SELECT') then
    raise exception 'The eleven card-link read policies are not SELECT-only';
  end if;
  if (select qual from pg_policies where schemaname = 'ehr' and tablename = 'patient_entries'
       and policyname = 'patient_entries_card_share_read')
     is distinct from '((status = ''active''::text) AND ehr.card_share_read_context(patient_id, ''records''::text))'
     or (select qual from pg_policies where schemaname = 'ehr' and tablename = 'patient_reported_health_profiles'
          and policyname = 'patient_reported_health_profiles_card_share_read')
        is distinct from 'ehr.card_share_read_context(patient_id, ''card''::text)' then
    raise exception 'Card-link read policies differ from the design';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'auth.accounts'::regclass
                  and tgname = 'accounts_deleted_card_shares' and tgenabled = 'O')
     or not exists (select 1 from pg_trigger where tgrelid = 'auth.accounts'::regclass
                     and tgname = 'accounts_deleted_web_push' and tgenabled = 'O') then
    raise exception 'The account deletion triggers are not both on auth.accounts';
  end if;
  if has_table_privilege('hid_identity_api_runtime', 'identity.card_shares', 'SELECT')
     or has_table_privilege('hid_ehr_api_runtime', 'identity.card_share_views', 'SELECT') then
    raise exception 'A runtime may read the card link tables';
  end if;
end $$;

-- Transaction contexts as the services set them.
create function pg_temp.as_patient(subject text, correlation text) returns void language sql as $$
  select set_config('app.actor_subject', subject, true), set_config('app.correlation_id', correlation, true);
$$;
create function pg_temp.as_system(correlation text) returns void language sql as $$
  select set_config('app.actor_subject', 'system:auth', true), set_config('app.correlation_id', correlation, true);
$$;
-- ehr-api's withCardShareTransaction.
create function pg_temp.as_card(digest text, correlation text) returns void language sql as $$
  select set_config('app.card_view_digest', digest, true), set_config('app.correlation_id', correlation, true),
    set_config('app.purpose_of_use', 'card-share', true), set_config('app.actor_subject', '', true),
    set_config('app.patient_id', '', true), set_config('app.account_id', '', true),
    set_config('app.session_id', '', true), set_config('app.facility_id', '', true),
    set_config('app.membership_id', '', true), set_config('app.self_authorized_until', '', true);
$$;
create function pg_temp.as_staff(correlation text) returns void language sql as $$
  select set_config('app.actor_subject', 'staff:e8-doctor', true), set_config('app.facility_id',
    'e8d10000-0000-4000-8000-000000000002', true), set_config('app.membership_id', 'e8d30000-0000-4000-8000-000000000001', true),
    set_config('app.purpose_of_use', 'direct-care', true), set_config('app.correlation_id', correlation, true),
    set_config('app.card_view_digest', '', true), set_config('app.patient_id', '', true),
    set_config('app.account_id', '', true), set_config('app.session_id', '', true),
    set_config('app.self_authorized_until', '', true);
$$;
create function pg_temp.h(value text) returns text language sql immutable as $$
  select encode(sha256(convert_to(value, 'UTF8')), 'hex');
$$;
create function pg_temp.sqlstate_of(statement text) returns text language plpgsql as $$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
-- Patient n (1 A, 2 B, 3 C) sends a link: 'outcome|share|replaced|send|capped' or the error.
create function pg_temp.send(n integer, share uuid, address text, token text, scope text, idem text, digest text)
returns text language plpgsql as $$
declare answer record;
begin
  perform pg_temp.as_patient('patient:e8a10000-0000-4000-8000-00000000000' || n, 'e8-send-' || idem);
  select * into answer from identity.create_my_card_share('patient:e8a10000-0000-4000-8000-00000000000' || n,
    ('e8f10000-0000-4000-8000-00000000000' || n)::uuid, share, pg_temp.h('address:' || address),
    left(address, 1) || '•••@' || split_part(address, '@', 2), decode(repeat('ab', 40), 'hex'), 'test-v1',
    pg_temp.h('token:' || token), scope, '24h', 'card-share-v1', idem, pg_temp.h(digest));
  return format('%s|%s|%s|%s|%s', answer.outcome, answer.share_id, coalesce(answer.replaced_share_id::text, ''),
    answer.send_email::text, answer.address_cap_reached::text);
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
-- "Email me a code": 'outcome|retry'.
create function pg_temp.ask(token text, code_id uuid, code text, browser text) returns text language plpgsql as $$
declare answer record;
begin
  perform pg_temp.as_system('e8-ask-' || code_id);
  select * into answer from identity.issue_card_share_code(pg_temp.h('token:' || token), code_id,
    pg_temp.h('code:' || token || ':' || code), 'test-v1', pg_temp.h('browser:' || browser), pg_temp.h('net:1'));
  return format('%s|%s', answer.outcome, coalesce(answer.retry_after_seconds::text, ''));
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
-- "Open the card": 'outcome|attemptsLeft|retry|viewId'.
create function pg_temp.open(token text, code text, browser text, view_id uuid, secret text) returns text
language plpgsql as $$
declare answer record;
begin
  perform pg_temp.as_system('e8-open-' || view_id);
  select * into answer from identity.verify_card_share_code(pg_temp.h('token:' || token),
    pg_temp.h('code:' || token || ':' || code), pg_temp.h('browser:' || browser), view_id, pg_temp.h('secret:' || secret),
    pg_temp.h('net:1'));
  return format('%s|%s|%s|%s', answer.outcome, coalesce(answer.attempts_left::text, ''),
    coalesce(answer.retry_after_seconds::text, ''), coalesce(answer.card->>'viewId', ''));
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
-- What a card-share transaction reads, as 'encounters,notes,revisions,imported,profile,reported,entries'.
create function pg_temp.reads(secret text) returns text language plpgsql as $$
begin
  perform pg_temp.as_card(pg_temp.h('secret:' || secret), 'e8-read-0001');
  return format('%s,%s,%s,%s,%s,%s,%s',
    (select count(*) from ehr.encounters), (select count(*) from ehr.clinical_notes),
    (select count(*) from ehr.clinical_note_revisions), (select count(*) from ehr.imported_medical_records),
    (select count(*) from ehr.imported_patient_health_profiles),
    (select count(*) from ehr.patient_reported_health_profiles), (select count(*) from ehr.patient_entries));
end $$;
create temporary table e8_ids (name text primary key, id uuid not null);
grant all on e8_ids to public;
grant execute on function pg_temp.as_patient(text, text), pg_temp.as_system(text), pg_temp.as_card(text, text),
  pg_temp.as_staff(text), pg_temp.h(text), pg_temp.sqlstate_of(text),
  pg_temp.send(integer, uuid, text, text, text, text, text), pg_temp.ask(text, uuid, text, text),
  pg_temp.open(text, text, text, uuid, text), pg_temp.reads(text) to public;

-- Fixtures. Accounts e8a1...: 1 patient A, 2 patient B, 3 patient C (deleted
-- later), 6 the doctor. A has visits, notes, history, health information and
-- entries; B has one visit.
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'card-links-test') on conflict (code) do update set active = true;
insert into auth.accounts (id, subject, email, display_name, status, email_verified_at, source_system) values
  ('e8a10000-0000-4000-8000-000000000001', 'patient:e8a10000-0000-4000-8000-000000000001', 'e8.ada@example.invalid',
   'Ada Cardlink', 'active', clock_timestamp(), 'hid'),
  ('e8a10000-0000-4000-8000-000000000002', 'patient:e8a10000-0000-4000-8000-000000000002', 'e8.bola@example.invalid',
   'Bola Cardlink', 'active', clock_timestamp(), 'hid'),
  ('e8a10000-0000-4000-8000-000000000003', 'patient:e8a10000-0000-4000-8000-000000000003', 'e8.chi@example.invalid',
   'Chi Cardlink', 'active', clock_timestamp(), 'hid'),
  ('e8a10000-0000-4000-8000-000000000006', 'staff:e8-doctor', 'e8-doctor@example.invalid',
   'Cardlink Doctor', 'active', clock_timestamp(), 'hid');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, status, notifications_enabled,
  source_system) values
  ('e8b10000-0000-4000-8000-000000000001', 'e8a10000-0000-4000-8000-000000000001', 'HID-E8ADAA', 'Ada', 'Cardlink',
   'Ada Cardlink', 'active', true, 'hid'),
  ('e8b10000-0000-4000-8000-000000000002', 'e8a10000-0000-4000-8000-000000000002', 'HID-E8BULB', 'Bola', 'Cardlink',
   'Bola Cardlink', 'active', true, 'hid'),
  ('e8b10000-0000-4000-8000-000000000003', 'e8a10000-0000-4000-8000-000000000003', 'HID-E8CHEC', 'Chi', 'Cardlink',
   'Chi Cardlink', 'active', true, 'hid');
insert into identity.organizations (id, name, slug) values
  ('e8d10000-0000-4000-8000-000000000001', 'Cardlink Test Org', 'e8-cardlink-test-org');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e8d10000-0000-4000-8000-000000000002', 'e8d10000-0000-4000-8000-000000000001', 'Cardlink Test Hospital', 'E8P-H',
   'Africa/Lagos', true, 'verified');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('e8d20000-0000-4000-8000-000000000001', 'e8a10000-0000-4000-8000-000000000006', 'Cardlink Doctor',
   'e8-doctor@example.invalid', 'verified', 'doctor');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active) values
  ('e8d30000-0000-4000-8000-000000000001', 'e8d20000-0000-4000-8000-000000000001', 'e8a10000-0000-4000-8000-000000000006',
   'e8d10000-0000-4000-8000-000000000001', 'e8d10000-0000-4000-8000-000000000002', 'doctor', 'doctor', true, true);
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at, break_glass, correlation_id, source_system) values
  ('e8c30000-0000-4000-8000-000000000001', 'e8b10000-0000-4000-8000-000000000001', 'e8d20000-0000-4000-8000-000000000001',
   'e8a10000-0000-4000-8000-000000000006', 'e8d30000-0000-4000-8000-000000000001', 'e8d10000-0000-4000-8000-000000000002',
   'write_records', 'direct-care', 'active', 'Cardlink test grant', clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '1 hour', false, 'e8-grant-0001', 'hid');
insert into auth.sessions (id, account_id, family_id, refresh_token_sha256, access_jti, account_token_version,
  authentication_method, issued_at, expires_at, absolute_expires_at, session_kind, patient_id, revoked_at,
  revocation_reason)
select ('e8f10000-0000-4000-8000-00000000000' || n)::uuid, ('e8a10000-0000-4000-8000-00000000000' || n)::uuid,
  ('e8f10000-0000-4000-8000-00000000000' || n)::uuid, md5('e8-' || n) || md5('e8-' || n), gen_random_uuid(), 1,
  'password', clock_timestamp(), clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours',
  'patient', ('e8b10000-0000-4000-8000-00000000000' || n)::uuid, null, null
  from unnest(array[1, 2, 3]) n;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
values ('e8d40000-0000-4000-8000-000000000001', 'e8a10000-0000-4000-8000-000000000006', 'doctor', 'facility',
  'e8d30000-0000-4000-8000-000000000001', 'e8d10000-0000-4000-8000-000000000002', 'Synthetic clinical fixture author');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at, break_glass, correlation_id, source_system) values
  ('e8c30000-0000-4000-8000-000000000002', 'e8b10000-0000-4000-8000-000000000002', 'e8d20000-0000-4000-8000-000000000001',
   'e8a10000-0000-4000-8000-000000000006', 'e8d30000-0000-4000-8000-000000000001', 'e8d10000-0000-4000-8000-000000000002',
   'write_records', 'direct-care', 'active', 'Cardlink test grant', clock_timestamp() - interval '1 minute',
   clock_timestamp() + interval '1 hour', false, 'e8-grant-0002', 'hid');
do $$ begin perform pg_temp.as_staff('e8-fixture-0001'); end $$;
-- A's record: visits 1 (completed) and 2 (in progress); notes 1 (signed) and 2 (draft); B's visit 3.
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at, ended_at)
select ('e8e10000-0000-4000-8000-00000000000' || n)::uuid,
  case when n = 3 then 'e8b10000-0000-4000-8000-000000000002' else 'e8b10000-0000-4000-8000-000000000001' end::uuid,
  'e8d10000-0000-4000-8000-000000000002', 'e8a10000-0000-4000-8000-000000000006', 'e8d30000-0000-4000-8000-000000000001',
  'ambulatory', case when n = 2 then 'in_progress' else 'completed' end, clock_timestamp() - interval '1 hour',
  case when n = 2 then null else clock_timestamp() end
  from generate_series(1, 3) n;
insert into ehr.clinical_notes (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
  note_type, title, status, current_revision_no, signed_at, signed_by)
select ('e8e20000-0000-4000-8000-00000000000' || n)::uuid, 'e8e10000-0000-4000-8000-000000000001',
  'e8b10000-0000-4000-8000-000000000001', 'e8d10000-0000-4000-8000-000000000002', 'e8a10000-0000-4000-8000-000000000006',
  'e8d30000-0000-4000-8000-000000000001', 'progress', 'Synthetic note', case when n = 2 then 'draft' else 'signed' end, 1,
  case when n = 2 then null else clock_timestamp() end,
  case when n = 2 then null else 'e8a10000-0000-4000-8000-000000000006'::uuid end
  from generate_series(1, 2) n;
insert into ehr.clinical_note_revisions (clinical_note_id, patient_id, facility_id, revision_no, content, change_reason,
  created_by, created_by_membership_id)
select id, patient_id, facility_id, 1, 'Synthetic clinical content', 'Synthetic fixture create', created_by,
  created_by_membership_id
  from ehr.clinical_notes where id::text like 'e8e20000-%';
insert into ehr.patient_reported_health_profiles (patient_id, blood_group, genotype, allergies, updated_by_account_id)
values ('e8b10000-0000-4000-8000-000000000001', 'O+', 'AA', 'Synthetic allergy', 'e8a10000-0000-4000-8000-000000000001'),
  ('e8b10000-0000-4000-8000-000000000002', 'A+', 'AS', null, 'e8a10000-0000-4000-8000-000000000002');
insert into ehr.patient_entries (id, patient_id, kind, title, occurred_on, status, withdrawn_at, created_by_account_id,
  request_sha256)
values ('e8e30000-0000-4000-8000-000000000001', 'e8b10000-0000-4000-8000-000000000001', 'visit', 'Synthetic visit',
   current_date - 3, 'active', null, 'e8a10000-0000-4000-8000-000000000001', repeat('a', 64)),
  ('e8e30000-0000-4000-8000-000000000002', 'e8b10000-0000-4000-8000-000000000001', 'test', 'Synthetic removed test',
   current_date - 2, 'withdrawn', clock_timestamp(), 'e8a10000-0000-4000-8000-000000000001', repeat('b', 64));

do $$ begin perform set_config('app.actor_subject', '', true), set_config('app.membership_id', '', true),
  set_config('app.facility_id', '', true), set_config('app.purpose_of_use', '', true); end $$;

-- 2. Create, replay, replace, limits.
set local role hid_identity_api_runtime;
do $$
declare
  answer text;
  first_id uuid := 'e8510000-0000-4000-8000-000000000001';
  listed jsonb;
begin
  answer := pg_temp.send(1, first_id, 'kemi.doctor@example.com', 't1', 'card_and_records', 'e8-idem-0000000001', 'body-1');
  if answer is distinct from format('created|%s||true|false', first_id) then raise exception 'Create: %', answer; end if;
  answer := pg_temp.send(1, 'e8510000-0000-4000-8000-0000000000ff', 'kemi.doctor@example.com', 't1', 'card_and_records',
    'e8-idem-0000000001', 'body-1');
  if answer is distinct from format('replayed|%s||false|false', first_id) then raise exception 'Replay: %', answer; end if;
  answer := pg_temp.send(1, 'e8510000-0000-4000-8000-0000000000ff', 'kemi.doctor@example.com', 't1', 'card_and_records',
    'e8-idem-0000000001', 'body-2');
  if answer not like '55000 IDEMPOTENCY_KEY_REUSED%' then raise exception 'Reused key: %', answer; end if;
  -- Invalid input.
  perform pg_temp.as_patient('patient:e8a10000-0000-4000-8000-000000000001', 'e8-invalid-0001');
  foreach answer in array array[
    format('select identity.create_my_card_share(%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L)',
      'patient:e8a10000-0000-4000-8000-000000000001', 'e8f10000-0000-4000-8000-000000000001', gen_random_uuid(),
      pg_temp.h('x'), 'k•••@example.com', '\x' || repeat('ab', 40), 'test-v1', pg_temp.h('tx'), 'card', '30d',
      'card-share-v1', 'e8-idem-0000000099', pg_temp.h('b')),
    format('select identity.create_my_card_share(%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L)',
      'patient:e8a10000-0000-4000-8000-000000000001', 'e8f10000-0000-4000-8000-000000000001', gen_random_uuid(),
      pg_temp.h('x'), 'kemi@example.com', '\x' || repeat('ab', 40), 'test-v1', pg_temp.h('tx'), 'card', '24h',
      'card-share-v1', 'e8-idem-0000000099', pg_temp.h('b')),
    format('select identity.create_my_card_share(%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L)',
      'patient:e8a10000-0000-4000-8000-000000000001', 'e8f10000-0000-4000-8000-000000000001', gen_random_uuid(),
      pg_temp.h('x'), 'k•••@example.com', '\x' || repeat('ab', 40), 'test-v1', pg_temp.h('tx'), 'everything', '24h',
      'card-share-v1', 'e8-idem-0000000099', pg_temp.h('b'))] loop
    if pg_temp.sqlstate_of(answer) not like '22023 CARD_SHARE_REQUEST_INVALID%' then
      raise exception 'Invalid input accepted: %', pg_temp.sqlstate_of(answer);
    end if;
  end loop;
  -- Another session: refused.
  perform pg_temp.as_patient('patient:e8a10000-0000-4000-8000-000000000001', 'e8-wrong-session');
  answer := pg_temp.sqlstate_of(format('select identity.end_my_card_share(%L,%L,%L)',
    'patient:e8a10000-0000-4000-8000-000000000001', 'e8f10000-0000-4000-8000-000000000002', first_id));
  if answer not like '42501%' then raise exception 'Another session ended a link: %', answer; end if;
  -- B cannot end A's link.
  perform pg_temp.as_patient('patient:e8a10000-0000-4000-8000-000000000002', 'e8-other-patient');
  answer := pg_temp.sqlstate_of(format('select identity.end_my_card_share(%L,%L,%L)',
    'patient:e8a10000-0000-4000-8000-000000000002', 'e8f10000-0000-4000-8000-000000000002', first_id));
  if answer not like 'P0002 CARD_SHARE_NOT_FOUND%' then raise exception 'B ended A''s link: %', answer; end if;
  perform pg_temp.as_patient('patient:e8a10000-0000-4000-8000-000000000002', 'e8-other-list');
  listed := identity.list_my_card_shares('patient:e8a10000-0000-4000-8000-000000000002',
    'e8f10000-0000-4000-8000-000000000002');
  if jsonb_array_length(listed->'items') <> 0 then raise exception 'B lists A''s links'; end if;
  insert into e8_ids values ('first', first_id);
end $$;

-- A view and a live code on the first link, then a second link to the same address replaces it.
do $$
declare answer text;
begin
  answer := pg_temp.ask('t1', 'e8610000-0000-4000-8000-000000000001', '111111', 'browser-1');
  if answer <> 'issued|' then raise exception 'First code: %', answer; end if;
  answer := pg_temp.open('t1', '111111', 'browser-1', 'e8710000-0000-4000-8000-000000000001', 's1');
  if answer <> 'opened|||e8710000-0000-4000-8000-000000000001' then raise exception 'First open: %', answer; end if;
end $$;
reset role;
-- A code asked 2 minutes ago, still live, so the replacement must end it.
set local session_replication_role = replica;
update identity.card_share_codes set created_at = created_at - interval '2 minutes', expires_at = expires_at - interval '2 minutes'
 where share_id = 'e8510000-0000-4000-8000-000000000001';
set local session_replication_role = origin;
set local role hid_identity_api_runtime;
do $$
declare answer text;
begin
  answer := pg_temp.ask('t1', 'e8610000-0000-4000-8000-000000000002', '222222', 'browser-1');
  if answer <> 'issued|' then raise exception 'Second code: %', answer; end if;
  answer := pg_temp.send(1, 'e8510000-0000-4000-8000-000000000002', 'kemi.doctor@example.com', 't2', 'card_and_records',
    'e8-idem-0000000002', 'body-2');
  if answer is distinct from 'created|e8510000-0000-4000-8000-000000000002|e8510000-0000-4000-8000-000000000001|true|false' then
    raise exception 'Replace: %', answer;
  end if;
  -- 2 a day to one address: the third is refused.
  answer := pg_temp.send(1, 'e8510000-0000-4000-8000-000000000003', 'kemi.doctor@example.com', 't3', 'card',
    'e8-idem-0000000003', 'body-3');
  if answer not like 'P0001 CARD_SHARE_ADDRESS_LIMITED%' then raise exception 'Third to one address: %', answer; end if;
  -- The old link reads as ended and replaced, and old token answers ended.
  if pg_temp.ask('t1', 'e8610000-0000-4000-8000-000000000003', '333333', 'browser-1') <> 'ended|' then
    raise exception 'A replaced link still issues codes';
  end if;
end $$;
reset role;
do $$
begin
  if (select (ended_reason, recipient_ciphertext is null, recipient_key_version is null, replaced_by)
        from identity.card_shares where id = 'e8510000-0000-4000-8000-000000000001')
     is distinct from ('replaced'::text, true, true, 'e8510000-0000-4000-8000-000000000002'::uuid)
     or exists (select 1 from identity.card_share_views where share_id = 'e8510000-0000-4000-8000-000000000001'
                 and ended_at is null)
     or exists (select 1 from identity.card_share_codes where share_id = 'e8510000-0000-4000-8000-000000000001'
                 and consumed_at is null and invalidated_at is null)
     or (select invalidated_reason from identity.card_share_codes where id = 'e8610000-0000-4000-8000-000000000002')
        is distinct from 'share_ended' then
    raise exception 'The replaced link was not ended, erased and closed';
  end if;
  if (select count(*) from audit.events where action = 'identity.card-share.replace'
        and resource_id = 'e8510000-0000-4000-8000-000000000001') <> 1
     or (select count(*) from audit.events where action = 'identity.card-share.create' and actor_type = 'patient'
           and patient_id = 'e8b10000-0000-4000-8000-000000000001') <> 2
     or (select count(*) from identity.card_share_patient_emails where patient_id = 'e8b10000-0000-4000-8000-000000000001'
           and kind = 'created') <> 2 then
    raise exception 'Create and replace were not audited, or the patient was not emailed';
  end if;
end $$;

-- 5 a day; 20 live (aged rows); blocked and capped addresses.
do $$
declare n integer;
begin
  -- B: four links today to four addresses, then the 5th and 6th.
  set local role hid_identity_api_runtime;
  for n in 1..5 loop
    if pg_temp.send(2, ('e8520000-0000-4000-8000-00000000000' || n)::uuid, 'b' || n || '@example.com', 'b' || n, 'card',
         'e8-idem-b00000000' || n, 'b' || n) not like 'created|%' then
      raise exception 'B''s link % refused', n;
    end if;
  end loop;
  if pg_temp.send(2, 'e8520000-0000-4000-8000-000000000006', 'b6@example.com', 'b6', 'card', 'e8-idem-b000000006', 'b6')
     not like 'P0001 CARD_SHARE_CREATE_LIMITED%' then
    raise exception 'A 6th link in a day was not refused';
  end if;
  reset role;
end $$;
set local session_replication_role = replica;
-- C already has 20 live links, sent two days ago.
insert into identity.card_shares (id, patient_id, reference, scope, duration_preset, consent_version, recipient_ciphertext,
  recipient_key_version, recipient_hmac, recipient_hint, token_hmac, created_at, expires_at, delivery_outcome,
  idempotency_key, request_sha256)
select ('e8530000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'e8b10000-0000-4000-8000-000000000003',
  'CCCC-' || substr('ABCDEFGHJKLMNPQRSTUVWXYZ', n, 1) || 'AAA', 'card', '7d', 'card-share-v1', decode(repeat('ab', 40), 'hex'),
  'test-v1', pg_temp.h('address:c' || n || '@example.com'), 'c•••@example.com', pg_temp.h('token:c' || n),
  now() - interval '2 days', now() - interval '2 days' + interval '7 days', 'sent',
  'e8-idem-c0000000' || lpad(n::text, 2, '0'), pg_temp.h('c' || n)
  from generate_series(1, 20) n;
-- 50 emails to clinic@example.com today from patient B (ended links).
insert into identity.card_shares (id, patient_id, reference, scope, duration_preset, consent_version, recipient_hmac,
  recipient_hint, token_hmac, created_at, expires_at, ended_at, ended_reason, delivery_outcome, idempotency_key,
  request_sha256)
select gen_random_uuid(), 'e8b10000-0000-4000-8000-000000000002',
  'DDDD-' || substr('ABCDEFGH', 1 + n / 8, 1) || substr('ABCDEFGH', 1 + n % 8, 1) || 'ZZ', 'card', '24h',
  'card-share-v1', pg_temp.h('address:clinic@example.com'), 'c•••@example.com', pg_temp.h('token:d' || n),
  now() - interval '2 hours', now() - interval '2 hours' + interval '24 hours',
  clock_timestamp() - interval '1 hour', 'patient_ended', 'sent', 'e8-idem-d000000' || lpad(n::text, 3, '0'),
  pg_temp.h('d' || n)
  from generate_series(1, 50) n;
insert into identity.card_share_address_blocks (id, recipient_hmac, source)
values (gen_random_uuid(), pg_temp.h('address:blocked@example.com'), 'recipient');
set local session_replication_role = origin;
set local role hid_identity_api_runtime;
do $$
declare
  answer text;
  listed jsonb;
begin
  answer := pg_temp.send(3, 'e8530000-0000-4000-8000-000000000021', 'c21@example.com', 'c21', 'card',
    'e8-idem-c000000021', 'c21');
  if answer not like '55000 CARD_SHARE_LIVE_LIMIT%' then raise exception 'A 21st live link: %', answer; end if;
  -- Sending again to a live address still replaces (it is not a 21st).
  answer := pg_temp.send(3, 'e8530000-0000-4000-8000-000000000022', 'c1@example.com', 'c1-again', 'card',
    'e8-idem-c000000022', 'c22');
  if answer not like 'created|%|e8530000-0000-4000-8000-000000000001|true|false' then
    raise exception 'Replacing at 20 live: %', answer;
  end if;
  answer := pg_temp.send(1, 'e8510000-0000-4000-8000-000000000004', 'blocked@example.com', 'blocked', 'card',
    'e8-idem-0000000004', 'body-4');
  if answer <> 'created|e8510000-0000-4000-8000-000000000004||false|false' then raise exception 'Blocked: %', answer; end if;
  answer := pg_temp.send(1, 'e8510000-0000-4000-8000-000000000005', 'clinic@example.com', 'clinic', 'card',
    'e8-idem-0000000005', 'body-5');
  if answer <> 'created|e8510000-0000-4000-8000-000000000005||false|true' then raise exception 'Capped: %', answer; end if;
  perform pg_temp.as_patient('patient:e8a10000-0000-4000-8000-000000000001', 'e8-list-0001');
  listed := identity.list_my_card_shares('patient:e8a10000-0000-4000-8000-000000000001',
    'e8f10000-0000-4000-8000-000000000001');
  if (select string_agg(item->>'delivery', ',' order by item->>'id') from jsonb_array_elements(listed->'items') item
       where item->>'id' in ('e8510000-0000-4000-8000-000000000004', 'e8510000-0000-4000-8000-000000000005'))
     is distinct from 'not_sent,not_sent'
     or (select item->>'status' from jsonb_array_elements(listed->'items') item
          where item->>'id' = 'e8510000-0000-4000-8000-000000000001') is distinct from 'ended'
     or (select item->>'recipientCiphertext' from jsonb_array_elements(listed->'items') item
          where item->>'id' = 'e8510000-0000-4000-8000-000000000001') is not null
     or (select item->>'recipientHint' from jsonb_array_elements(listed->'items') item
          where item->>'id' = 'e8510000-0000-4000-8000-000000000002') is distinct from 'k•••@example.com'
     or (listed->>'createdToday')::integer <> 4 or (listed->>'liveCount')::integer <> 3 then
    raise exception 'The patient''s list: %', listed;
  end if;
end $$;
reset role;
do $$
begin
  if (select details->>'notSentReason' from audit.events where action = 'identity.card-share.create'
        and resource_id = 'e8510000-0000-4000-8000-000000000004') is distinct from 'address_blocked'
     or (select details->>'notSentReason' from audit.events where action = 'identity.card-share.create'
           and resource_id = 'e8510000-0000-4000-8000-000000000005') is distinct from 'address_cap' then
    raise exception 'The not-sent reason is not in the audit';
  end if;
end $$;

-- 3 and 4. Codes and verify on link 2 (t2).
set local role hid_identity_api_runtime;
do $$
declare answer text;
begin
  -- Unknown, ended and expired answer the same.
  if pg_temp.ask('no-such-token', 'e8620000-0000-4000-8000-000000000001', '000000', 'b') <> 'ended|'
     or pg_temp.open('no-such-token', '000000', 'b', 'e8720000-0000-4000-8000-000000000001', 'x') <> 'ended|||' then
    raise exception 'An unknown token answered differently';
  end if;
  if pg_temp.open('t2', '444444', 'browser-2', 'e8720000-0000-4000-8000-000000000002', 'x') <> 'code_expired|||' then
    raise exception 'Verify without a code';
  end if;
  answer := pg_temp.ask('t2', 'e8620000-0000-4000-8000-000000000002', '444444', 'browser-2');
  if answer <> 'issued|' then raise exception 'Code on link 2: %', answer; end if;
  answer := pg_temp.ask('t2', 'e8620000-0000-4000-8000-000000000003', '555555', 'browser-2');
  if answer not like 'limited|%' or split_part(answer, '|', 2)::integer not between 1 and 60 then
    raise exception 'A second code within a minute: %', answer;
  end if;
  -- Wrong, then the right code from another browser (wrong), then 3 more wrong: the code dies.
  if pg_temp.open('t2', '000000', 'browser-2', 'e8720000-0000-4000-8000-000000000003', 'x') <> 'wrong|4||' then
    raise exception 'First wrong try';
  end if;
  if pg_temp.open('t2', '444444', 'another-browser', 'e8720000-0000-4000-8000-000000000003', 'x') <> 'wrong|3||' then
    raise exception 'The right code from another browser opened the card';
  end if;
  perform pg_temp.open('t2', '000000', 'browser-2', 'e8720000-0000-4000-8000-000000000003', 'x');
  perform pg_temp.open('t2', '000000', 'browser-2', 'e8720000-0000-4000-8000-000000000003', 'x');
  answer := pg_temp.open('t2', '000000', 'browser-2', 'e8720000-0000-4000-8000-000000000003', 'x');
  if answer <> 'code_expired|||' then raise exception 'The 5th wrong try: %', answer; end if;
  if pg_temp.open('t2', '444444', 'browser-2', 'e8720000-0000-4000-8000-000000000003', 'x') <> 'code_expired|||' then
    raise exception 'A dead code opened the card';
  end if;
end $$;
reset role;
do $$
begin
  if (select (invalidated_reason, failed_attempts) from identity.card_share_codes
       where id = 'e8620000-0000-4000-8000-000000000002') is distinct from ('attempts_exhausted'::text, 5)
     or (select dead_codes from identity.card_shares where id = 'e8510000-0000-4000-8000-000000000002') <> 1
     or (select count(*) from audit.events where action = 'identity.card-share.open.refused'
           and resource_id = 'e8510000-0000-4000-8000-000000000002') <> 7 then
    raise exception 'Five wrong tries did not kill the code';
  end if;
end $$;

-- Two more dead codes lock the link; the codes are aged past the minute and hour limits each time.
create function pg_temp.age_codes(share uuid) returns void language plpgsql as $$
begin
  set local session_replication_role = replica;
  update identity.card_share_codes set created_at = created_at - interval '2 hours', expires_at = expires_at - interval '2 hours'
   where share_id = share and consumed_at is null and invalidated_at is not null;
  update identity.card_share_codes set created_at = created_at - interval '61 seconds',
         expires_at = expires_at - interval '61 seconds'
   where share_id = share and consumed_at is null and invalidated_at is null;
  set local session_replication_role = origin;
end $$;
do $$
declare
  round integer;
  try integer;
  answer text;
begin
  for round in 2..3 loop
    perform pg_temp.age_codes('e8510000-0000-4000-8000-000000000002');
    set local role hid_identity_api_runtime;
    answer := pg_temp.ask('t2', ('e8620000-0000-4000-8000-00000000001' || round)::uuid, '444444', 'browser-2');
    if answer <> 'issued|' then raise exception 'Round % code: %', round, answer; end if;
    for try in 1..5 loop
      answer := pg_temp.open('t2', '999999', 'browser-2', 'e8720000-0000-4000-8000-000000000004', 'x');
    end loop;
    reset role;
  end loop;
  if answer <> 'locked||3600|' then raise exception 'The third dead code did not lock: %', answer; end if;
  set local role hid_identity_api_runtime;
  if pg_temp.ask('t2', 'e8620000-0000-4000-8000-000000000020', '444444', 'browser-2') not like 'locked|%'
     or pg_temp.open('t2', '444444', 'browser-2', 'e8720000-0000-4000-8000-000000000004', 'x') not like 'locked||%' then
    raise exception 'A locked link issued or verified';
  end if;
  reset role;
  if (select (lock_count, dead_codes, locked_until > clock_timestamp() + interval '59 minutes')
        from identity.card_shares where id = 'e8510000-0000-4000-8000-000000000002')
     is distinct from (1, 0, true)
     or (select count(*) from notification.inbox_items where notification_code = 'SHARED_CARD_LOCKED'
           and resource_id = 'e8510000-0000-4000-8000-000000000002') <> 1 then
    raise exception 'The first lock was not recorded or the patient not told';
  end if;
end $$;

-- The lock ends after an hour; a second lock ends the link and tells the patient once.
do $$
declare
  round integer;
  try integer;
  answer text;
begin
  set local session_replication_role = replica;
  update identity.card_shares set locked_until = clock_timestamp() - interval '1 second'
   where id = 'e8510000-0000-4000-8000-000000000002';
  set local session_replication_role = origin;
  for round in 4..6 loop
    perform pg_temp.age_codes('e8510000-0000-4000-8000-000000000002');
    set local session_replication_role = replica;
    update identity.card_share_codes set created_at = created_at - interval '1 day', expires_at = expires_at - interval '1 day'
     where share_id = 'e8510000-0000-4000-8000-000000000002';
    set local session_replication_role = origin;
    set local role hid_identity_api_runtime;
    answer := pg_temp.ask('t2', ('e8620000-0000-4000-8000-00000000001' || round)::uuid, '444444', 'browser-2');
    if answer <> 'issued|' then raise exception 'Round % code: %', round, answer; end if;
    for try in 1..5 loop
      answer := pg_temp.open('t2', '999999', 'browser-2', 'e8720000-0000-4000-8000-000000000004', 'x');
    end loop;
    reset role;
  end loop;
  if answer <> 'ended|||' then raise exception 'The second lock did not end the link: %', answer; end if;
  if (select ended_reason from identity.card_shares where id = 'e8510000-0000-4000-8000-000000000002')
       is distinct from 'too_many_wrong_codes'
     or (select count(*) from notification.inbox_items where notification_code = 'SHARED_CARD_ENDED'
           and resource_id = 'e8510000-0000-4000-8000-000000000002') <> 1
     or (select count(*) from notification.inbox_items where notification_code = 'SHARED_CARD_LOCKED'
           and resource_id = 'e8510000-0000-4000-8000-000000000002') <> 1 then
    raise exception 'The second lock was not one end and one notice';
  end if;
end $$;

-- Links 1 and 2 were sent yesterday, so A may send three more today.
set local session_replication_role = replica;
update identity.card_shares set created_at = created_at - interval '25 hours', expires_at = expires_at - interval '25 hours'
 where id in ('e8510000-0000-4000-8000-000000000001', 'e8510000-0000-4000-8000-000000000002');
set local session_replication_role = origin;
-- A right code: link 6 (t6) to dami@example.com, "Card and records"; link 7 (t7) to eze@example.com, "Card only".
set local role hid_identity_api_runtime;
do $$
declare
  answer text;
  card jsonb;
begin
  if pg_temp.send(1, 'e8510000-0000-4000-8000-000000000006', 'dami@example.com', 't6', 'card_and_records',
       'e8-idem-0000000006', 'body-6') not like 'created|%'
     or pg_temp.send(1, 'e8510000-0000-4000-8000-000000000007', 'eze@example.com', 't7', 'card',
       'e8-idem-0000000007', 'body-7') not like 'created|%' then
    raise exception 'Links 6 and 7 not created';
  end if;
  if pg_temp.ask('t6', 'e8630000-0000-4000-8000-000000000001', '123456', 'browser-6') <> 'issued|'
     or pg_temp.ask('t7', 'e8630000-0000-4000-8000-000000000002', '654321', 'browser-7') <> 'issued|' then
    raise exception 'Codes for links 6 and 7';
  end if;
  answer := pg_temp.open('t6', '123456', 'browser-6', 'e8730000-0000-4000-8000-000000000001', 's6');
  if answer <> 'opened|||e8730000-0000-4000-8000-000000000001' then raise exception 'Open link 6: %', answer; end if;
  if pg_temp.open('t6', '123456', 'browser-6', 'e8730000-0000-4000-8000-000000000009', 's6-again') <> 'code_expired|||' then
    raise exception 'A code was used twice';
  end if;
  answer := pg_temp.open('t7', '654321', 'browser-7', 'e8730000-0000-4000-8000-000000000002', 's7');
  if answer <> 'opened|||e8730000-0000-4000-8000-000000000002' then raise exception 'Open link 7: %', answer; end if;
  perform pg_temp.as_system('e8-view-0001');
  select view_answer.card into card from identity.card_share_view('e8730000-0000-4000-8000-000000000001',
    pg_temp.h('secret:s6')) view_answer;
  if card->>'fullName' <> 'Ada Cardlink' or card->>'healthId' <> 'HID-E8ADAA' or card->>'sharedByFirstName' <> 'Ada'
     or card->>'recipientHint' <> 'd•••@example.com' or card->>'scope' <> 'card_and_records'
     or (card->>'ninVerified')::boolean or card ? 'recipientEmail' then
    raise exception 'The card: %', card;
  end if;
  if (select outcome from identity.card_share_view('e8730000-0000-4000-8000-000000000001', pg_temp.h('secret:wrong')))
     <> 'ended' then
    raise exception 'A wrong secret read the card';
  end if;
end $$;
reset role;
do $$
begin
  if (select (open_count, last_opened_at is not null) from identity.card_shares
       where id = 'e8510000-0000-4000-8000-000000000006') is distinct from (1, true)
     or (select count(*) from audit.events where action = 'identity.card-share.open' and actor_type = 'system'
           and actor_subject is null and patient_id = 'e8b10000-0000-4000-8000-000000000001'
           and resource_id = 'e8510000-0000-4000-8000-000000000006') <> 1
     or (select metadata from notification.inbox_items where notification_code = 'SHARED_CARD_OPENED'
           and resource_id = 'e8510000-0000-4000-8000-000000000006')
        is distinct from jsonb_build_object('recipientHint', 'd•••@example.com',
          'reference', (select reference from identity.card_shares where id = 'e8510000-0000-4000-8000-000000000006'))
     or (select count(*) from identity.card_share_patient_emails where share_id = 'e8510000-0000-4000-8000-000000000006'
           and kind = 'opened') <> 1 then
    raise exception 'The open was not counted, audited, put in the inbox and emailed';
  end if;
end $$;

-- 5. EHR context.
set local role hid_ehr_api_runtime;
do $$
declare answer text;
begin
  answer := pg_temp.reads('s6');
  if answer <> '1,1,1,0,0,1,1' then raise exception 'Card and records read: %', answer; end if;
  answer := pg_temp.reads('s7');
  if answer <> '0,0,0,0,0,1,0' then raise exception 'Card only read: %', answer; end if;
  if pg_temp.reads('nobody') <> '0,0,0,0,0,0,0' then raise exception 'An unknown digest read'; end if;
  -- Only its own patient, only completed visits and signed notes.
  perform pg_temp.as_card(pg_temp.h('secret:s6'), 'e8-read-0002');
  if exists (select 1 from ehr.encounters where patient_id <> 'e8b10000-0000-4000-8000-000000000001' or status <> 'completed')
     or exists (select 1 from ehr.clinical_notes where status not in ('signed', 'amended'))
     or exists (select 1 from ehr.patient_entries where status <> 'active')
     or exists (select 1 from ehr.patient_reported_health_profiles where patient_id <> 'e8b10000-0000-4000-8000-000000000001') then
    raise exception 'The card view read beyond its patient''s shared records';
  end if;
  if ehr.card_share_read_context('e8b10000-0000-4000-8000-000000000002', 'card') then
    raise exception 'A view of A read B';
  end if;
  -- SELECT only: no rows to lock, none to update.
  if (select count(*) from ehr.encounters) <> 1
     or (select count(*) from (select 1 from ehr.encounters for update) locked) <> 0 then
    raise exception 'A card view may lock visit rows';
  end if;
  update ehr.encounters set chief_complaint = 'changed' where patient_id = 'e8b10000-0000-4000-8000-000000000001';
  if found then raise exception 'A card view updated a visit'; end if;
  -- Any patient, account, session, facility or membership setting: nothing.
  foreach answer in array array['app.patient_id', 'app.account_id', 'app.session_id', 'app.facility_id',
      'app.membership_id', 'app.self_authorized_until'] loop
    perform pg_temp.as_card(pg_temp.h('secret:s6'), 'e8-read-0003');
    perform set_config(answer, 'e8b10000-0000-4000-8000-000000000001', true);
    if ehr.card_share_read_context('e8b10000-0000-4000-8000-000000000001', 'card')
       or (select count(*) from ehr.encounters) <> 0 then
      raise exception 'The card context combined with %', answer;
    end if;
  end loop;
  perform pg_temp.as_card(pg_temp.h('secret:s6'), 'e8-read-0004');
  perform set_config('app.purpose_of_use', 'direct-care', true);
  if ehr.card_share_read_context('e8b10000-0000-4000-8000-000000000001', 'card') then
    raise exception 'The card context read under another purpose';
  end if;
  -- The view context answers and audits; the runtime cannot read the identity tables.
  perform pg_temp.as_card(pg_temp.h('secret:s6'), 'e8-read-0005');
  if (select scope from ehr.card_share_view_context()) <> 'card_and_records' then
    raise exception 'The view context';
  end if;
  if pg_temp.sqlstate_of('select 1 from identity.card_shares') not like '42501%'
     or pg_temp.sqlstate_of('select identity.list_my_card_shares(''x'', null)') not like '42501%' then
    raise exception 'The EHR runtime reached an identity table or command';
  end if;
  perform pg_temp.as_card(pg_temp.h('secret:nobody'), 'e8-read-0006');
  if pg_temp.sqlstate_of('select * from ehr.card_share_view_context()') not like '55000 CARD_SHARE_VIEW_ENDED%' then
    raise exception 'The view context of an unknown digest';
  end if;
  -- A clinician's read is unchanged: their facility's records of A by the grant.
  perform pg_temp.as_staff('e8-staff-0001');
  if (select count(*) from ehr.encounters where patient_id = 'e8b10000-0000-4000-8000-000000000001') <> 2 then
    raise exception 'The clinician''s read changed';
  end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from audit.events where action = 'ehr.card-share.records.read' and actor_type = 'system'
        and source_system = 'ehr-api' and resource_id = 'e8510000-0000-4000-8000-000000000006') <> 1 then
    raise exception 'The records read was not audited';
  end if;
  if has_function_privilege('hid_identity_api_runtime', 'ehr.card_share_view_context()', 'EXECUTE') then
    raise exception 'The identity runtime may open the EHR view context';
  end if;
end $$;

-- A second open of link 6 ends the first view (one view per link); then the
-- link's end, an expired view, an inactive patient and a deletion-due login read nothing.
do $$
declare answer text;
begin
  perform pg_temp.age_codes('e8510000-0000-4000-8000-000000000006');
  set local session_replication_role = replica;
  update identity.card_share_codes set created_at = created_at - interval '2 minutes',
         expires_at = expires_at - interval '2 minutes'
   where share_id = 'e8510000-0000-4000-8000-000000000006';
  set local session_replication_role = origin;
  set local role hid_identity_api_runtime;
  if pg_temp.ask('t6', 'e8630000-0000-4000-8000-000000000003', '777777', 'browser-6b') <> 'issued|'
     or pg_temp.open('t6', '777777', 'browser-6b', 'e8730000-0000-4000-8000-000000000003', 's6b')
        <> 'opened|||e8730000-0000-4000-8000-000000000003' then
    raise exception 'A second open of link 6';
  end if;
  reset role;
  set local role hid_ehr_api_runtime;
  if pg_temp.reads('s6') <> '0,0,0,0,0,0,0' or pg_temp.reads('s6b') <> '1,1,1,0,0,1,1' then
    raise exception 'The first view was not ended by the second';
  end if;
  reset role;
  if (select ended_reason from identity.card_share_views where id = 'e8730000-0000-4000-8000-000000000001')
     is distinct from 'replaced' then
    raise exception 'The first view was not ended as replaced';
  end if;
  -- An expired view.
  set local session_replication_role = replica;
  update identity.card_share_views set created_at = created_at - interval '31 minutes',
         expires_at = expires_at - interval '31 minutes'
   where id = 'e8730000-0000-4000-8000-000000000002';
  set local session_replication_role = origin;
  set local role hid_ehr_api_runtime;
  if pg_temp.reads('s7') <> '0,0,0,0,0,0,0' then raise exception 'An expired view read'; end if;
  reset role;
  -- An inactive patient: the view reads nothing, and the next code ends the link.
  update identity.patients set status = 'inactive' where id = 'e8b10000-0000-4000-8000-000000000001';
  set local role hid_ehr_api_runtime;
  answer := pg_temp.reads('s6b');
  reset role;
  if answer <> '0,0,0,0,0,0,0' then raise exception 'An inactive patient''s card was read: %', answer; end if;
  update identity.patients set status = 'active' where id = 'e8b10000-0000-4000-8000-000000000001';
end $$;

-- 6. View, close and stop.
set local role hid_identity_api_runtime;
do $$
declare answer text;
begin
  perform pg_temp.as_system('e8-close-0001');
  if identity.end_card_share_view('e8730000-0000-4000-8000-000000000003', pg_temp.h('secret:s6b')) <> 'closed'
     or identity.end_card_share_view('e8730000-0000-4000-8000-000000000003', pg_temp.h('secret:s6b')) <> 'closed'
     or identity.end_card_share_view(gen_random_uuid(), pg_temp.h('secret:none')) <> 'closed' then
    raise exception 'Close';
  end if;
  if (select outcome from identity.card_share_view('e8730000-0000-4000-8000-000000000003', pg_temp.h('secret:s6b')))
     <> 'ended' then
    raise exception 'A closed view still answered';
  end if;
  -- B also sends to dami@example.com; the receiver presses "Stop these emails" on A's link.
  if pg_temp.send(2, 'e8520000-0000-4000-8000-000000000009', 'dami@example.com', 'b-dami', 'card', 'e8-idem-b000000009',
       'b-dami') not like 'P0001 CARD_SHARE_CREATE_LIMITED%' then
    raise exception 'B''s 6th link was not limited';
  end if;
  perform pg_temp.as_patient('patient:e8a10000-0000-4000-8000-000000000003', 'e8-end-c2');
  perform identity.end_my_card_share('patient:e8a10000-0000-4000-8000-000000000003',
    'e8f10000-0000-4000-8000-000000000003', 'e8530000-0000-4000-8000-000000000002');
  if pg_temp.send(3, 'e8530000-0000-4000-8000-000000000031', 'dami@example.com', 'c-dami', 'card', 'e8-idem-c000000031',
       'c-dami') not like 'created|%' then
    raise exception 'C''s link to dami';
  end if;
  perform pg_temp.as_system('e8-stop-0001');
  if identity.stop_card_share_emails('e8510000-0000-4000-8000-000000000006') <> 'blocked'
     or identity.stop_card_share_emails('e8510000-0000-4000-8000-000000000006') <> 'already_blocked'
     or identity.stop_card_share_emails(gen_random_uuid()) <> 'unknown' then
    raise exception 'Stop these emails';
  end if;
  answer := pg_temp.send(1, 'e8510000-0000-4000-8000-000000000008', 'dami@example.com', 't8', 'card',
    'e8-idem-0000000008', 'body-8');
  if answer not like 'created|%||false|false' then raise exception 'A blocked address was emailed: %', answer; end if;
end $$;
reset role;
do $$
begin
  if (select string_agg(ended_reason, ',' order by id) from identity.card_shares
       where id in ('e8510000-0000-4000-8000-000000000006', 'e8530000-0000-4000-8000-000000000031'))
     is distinct from 'address_blocked,address_blocked'
     or (select count(*) from notification.inbox_items where notification_code = 'SHARED_CARD_STOPPED') <> 2 then
    raise exception 'A block did not end every live link to the address and tell each patient';
  end if;
end $$;

-- The patient ends a link; ending it again answers already_ended.
set local role hid_identity_api_runtime;
do $$
declare answer record;
begin
  perform pg_temp.as_patient('patient:e8a10000-0000-4000-8000-000000000001', 'e8-end-0001');
  select * into answer from identity.end_my_card_share('patient:e8a10000-0000-4000-8000-000000000001',
    'e8f10000-0000-4000-8000-000000000001', 'e8510000-0000-4000-8000-000000000007');
  if answer.outcome <> 'ended' or answer.item->>'status' <> 'ended' or answer.item->>'endedReason' <> 'patient_ended'
     or answer.item->>'recipientCiphertext' is not null then
    raise exception 'End: %', answer.item;
  end if;
  select * into answer from identity.end_my_card_share('patient:e8a10000-0000-4000-8000-000000000001',
    'e8f10000-0000-4000-8000-000000000001', 'e8510000-0000-4000-8000-000000000007');
  if answer.outcome <> 'already_ended' then raise exception 'End again: %', answer.outcome; end if;
  if pg_temp.ask('t7', 'e8630000-0000-4000-8000-000000000009', '000000', 'browser-7') <> 'ended|' then
    raise exception 'An ended link issued a code';
  end if;
  perform pg_temp.as_patient('patient:e8a10000-0000-4000-8000-000000000001', 'e8-delivery-0001');
  perform identity.record_my_card_share_delivery('patient:e8a10000-0000-4000-8000-000000000001',
    'e8f10000-0000-4000-8000-000000000001', 'e8510000-0000-4000-8000-000000000008', 'accepted', 'ses', null);
end $$;
reset role;

-- 7. Lifecycle: expiry, retention, emails, account deletion, guards.
set local session_replication_role = replica;
update identity.card_shares set created_at = created_at - interval '25 hours', expires_at = expires_at - interval '25 hours'
 where id = 'e8510000-0000-4000-8000-000000000004';
update identity.card_shares set ended_at = clock_timestamp() - interval '13 months'
 where id = 'e8510000-0000-4000-8000-000000000001';
update identity.card_share_views set created_at = created_at - interval '31 days', expires_at = expires_at - interval '31 days'
 where id = 'e8730000-0000-4000-8000-000000000001';
set local session_replication_role = origin;
set local role hid_identity_api_runtime;
do $$
declare
  swept jsonb;
  claimed record;
  claimed_count integer := 0;
begin
  if pg_temp.ask('blocked', 'e8640000-0000-4000-8000-000000000001', '000000', 'b') <> 'ended|' then
    raise exception 'An expired link issued a code';
  end if;
  perform pg_temp.as_system('e8-sweep-0001');
  swept := identity.close_expired_card_shares(100);
  if (swept->>'anonymised')::integer < 1 or (swept->>'networksErased')::integer < 1 then
    raise exception 'Retention: %', swept;
  end if;
  for claimed in select * from identity.claim_card_share_emails('e8-worker-1', 50, 60) loop
    claimed_count := claimed_count + 1;
    if claimed.recipient <> 'e8.ada@example.invalid' and claimed.recipient <> 'e8.bola@example.invalid'
       and claimed.recipient <> 'e8.chi@example.invalid' then
      raise exception 'An email went to %', claimed.recipient;
    end if;
    if claimed.kind = 'created' then
      perform identity.record_card_share_email_outcome(claimed.email_id, 'e8-worker-1', 'unknown', 'ses', 'timeout');
    else
      perform identity.record_card_share_email_outcome(claimed.email_id, 'e8-worker-1', 'accepted', 'ses', null);
    end if;
  end loop;
  if claimed_count = 0 then raise exception 'No patient email was claimed'; end if;
  if exists (select 1 from identity.claim_card_share_emails('e8-worker-2', 50, 60)) then
    raise exception 'A retry was claimed before its time';
  end if;
end $$;
reset role;
do $$
begin
  if (select (recipient_hmac, recipient_hint, anonymised_at is not null) from identity.card_shares
        where id = 'e8510000-0000-4000-8000-000000000001') is distinct from (null::char(64), null::text, true)
     or (select network_hmac from identity.card_share_views where id = 'e8730000-0000-4000-8000-000000000001') is not null
     or (select ended_reason from identity.card_shares where id = 'e8510000-0000-4000-8000-000000000004') <> 'expired'
     or exists (select 1 from identity.card_share_patient_emails where kind = 'opened' and email_status <> 'delivered')
     or not exists (select 1 from identity.card_share_patient_emails where kind = 'created' and email_status = 'pending'
                     and attempt_count = 1 and next_attempt_at > clock_timestamp()) then
    raise exception 'The sweeper or the email outcomes';
  end if;
end $$;

-- Account deletion (0096's completion sets the status): C's links end and are anonymised at once.
update auth.accounts set status = 'deleted' where id = 'e8a10000-0000-4000-8000-000000000003';
do $$
begin
  if exists (select 1 from identity.card_shares where patient_id = 'e8b10000-0000-4000-8000-000000000003'
              and (ended_at is null or recipient_hmac is not null or recipient_hint is not null
                or recipient_ciphertext is not null))
     or (select count(*) from identity.card_shares where patient_id = 'e8b10000-0000-4000-8000-000000000003'
           and ended_reason = 'account_deleted') <> 19
     or exists (select 1 from identity.card_share_patient_emails where patient_id = 'e8b10000-0000-4000-8000-000000000003'
                 and email_status = 'pending')
     or (select count(*) from audit.events where action = 'identity.card-share.anonymise'
           and patient_id = 'e8b10000-0000-4000-8000-000000000003') <> 1 then
    raise exception 'Account deletion left a link or an address behind';
  end if;
  if identity.card_share_patient_state('e8b10000-0000-4000-8000-000000000003') <> 'account_deleted'
     or identity.card_share_patient_state('e8b10000-0000-4000-8000-000000000001') <> 'active' then
    raise exception 'The patient state';
  end if;
end $$;

-- Guards.
do $$
declare answer text;
begin
  foreach answer in array array[
    'update identity.card_shares set reference = ''ZZZZ-ZZZZ'' where id = ''e8510000-0000-4000-8000-000000000008''',
    'update identity.card_shares set scope = ''card_and_records'' where id = ''e8510000-0000-4000-8000-000000000008''',
    'update identity.card_shares set expires_at = expires_at + interval ''1 day'' where id = ''e8510000-0000-4000-8000-000000000008''',
    'update identity.card_shares set ended_at = null, ended_reason = null where id = ''e8510000-0000-4000-8000-000000000007''',
    'update identity.card_shares set open_count = 0 where id = ''e8510000-0000-4000-8000-000000000006''',
    'update identity.card_shares set recipient_hint = ''x•••@example.org'' where id = ''e8510000-0000-4000-8000-000000000008''',
    'update identity.card_shares set recipient_hmac = null where id = ''e8510000-0000-4000-8000-000000000008''',
    'update identity.card_share_codes set failed_attempts = 0 where id = ''e8620000-0000-4000-8000-000000000002''',
    'update identity.card_share_views set ended_at = null, ended_reason = null where id = ''e8730000-0000-4000-8000-000000000001''',
    'delete from identity.card_shares where id = ''e8510000-0000-4000-8000-000000000007''',
    'delete from identity.card_share_codes where id = ''e8620000-0000-4000-8000-000000000002''',
    'delete from identity.card_share_views where id = ''e8730000-0000-4000-8000-000000000001''',
    'delete from identity.card_share_address_blocks',
    'delete from identity.card_share_patient_emails',
    'truncate identity.card_share_views'] loop
    if pg_temp.sqlstate_of(answer) not like '55000%' and pg_temp.sqlstate_of(answer) not like '23514%' then
      raise exception 'Allowed: % (%)', answer, pg_temp.sqlstate_of(answer);
    end if;
  end loop;
end $$;

-- 8. Audit and Activity.
do $$
declare
  logged jsonb;
  bad text;
begin
  select string_agg(event.action, ', ') into bad from audit.events event
   where (event.resource_type = 'card-share' or event.action like 'identity.card-share%' or event.action like 'ehr.card-share%')
     and (event.details::text ~ '@|•••' or event.details::text like '%' || pg_temp.h('token:t6') || '%'
       or event.details::text ~ '444444|123456|654321|999999|777777' or event.resource_id ~ '@');
  if bad is not null then raise exception 'An audit row holds an address, hint, code or token: %', bad; end if;
  if (select count(*) from audit.events where action like 'identity.card-share%') < 10 then
    raise exception 'Too few card-link audit rows';
  end if;
  perform pg_temp.as_patient('patient:e8a10000-0000-4000-8000-000000000001', 'e8-log-0001');
  logged := identity.patient_self_access_log('patient:e8a10000-0000-4000-8000-000000000001',
    'e8f10000-0000-4000-8000-000000000001', 100, null, null);
  if (select count(*) from jsonb_array_elements(logged->'events') entry
       where entry->>'action' = 'card_opened' and entry->>'actorKind' = 'card_recipient') <> 4
     or (select string_agg(distinct entry->>'actorName', ',') from jsonb_array_elements(logged->'events') entry
          where entry->>'action' = 'card_opened') is distinct from 'd•••@example.com,e•••@example.com'
     or not exists (select 1 from jsonb_array_elements(logged->'events') entry
                     where entry->>'action' = 'card_shared' and entry->>'actorKind' = 'patient')
     or not exists (select 1 from jsonb_array_elements(logged->'events') entry
                     where entry->>'action' = 'card_ended' and entry->>'actorKind' = 'patient'
                       and entry->>'actorName' = 'e•••@example.com')
     or exists (select 1 from jsonb_array_elements(logged->'events') entry where entry ? 'share') then
    raise exception 'Activity: %', logged;
  end if;
end $$;

rollback;
