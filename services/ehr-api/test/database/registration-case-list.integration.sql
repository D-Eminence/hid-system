\set ON_ERROR_STOP on
-- SX-10 and ID-0 (Akos wave 1, no migration): the registration-case list
-- read, word for word as Identity sends it (registration-case-list.spec.ts
-- checks that), run under row-level security as Identity's runtime role in
-- the context Identity's transactions set. Rollback-only. Fictional people,
-- places and identifiers only; ids start a5100.
--
--   1. a registration member at facility B reads none of facility A's cases,
--      whatever view; a member of B who names facility A reads nothing; a
--      member at A without identity.registration.write reads nothing;
--   2. view=mine shows only the member's own cases; view=facility every case
--      at the facility; the status filter;
--   3. paging: two cases with the same created_at are both shown, once each,
--      across pages, with the cursor's created_at::text round trip in
--      Africa/Lagos time (what Identity sends back as $4);
--   4. ninStatus (patientHasVerifiedNinSql): a case with no patient yet is
--      verified; a patient with a checked NIN is verified; a patient whose
--      NIN was revoked, or who has none, is not.
--
-- Each case records its outcome and the suite fails at the end listing every
-- case whose outcome differs.
begin;

-- Fixtures, without triggers or foreign-key checks. Facility A (a5100000-..02)
-- and facility B (..12). At A: desk 1 (n=1) and desk 2 (n=2), receptionists;
-- approver (n=3), admin; lab member (n=4), no registration permission; desk 6
-- (n=6), a receptionist who also reviews registrations for the platform (so
-- row-level security lets them read every facility's cases). At B: desk B
-- (n=5), receptionist.
set local session_replication_role = replica;
insert into identity.organizations (id, name, slug) values
  ('a5100000-0000-4000-8000-000000000001', 'List Test Group A', 'list-test-group-a'),
  ('a5100000-0000-4000-8000-000000000011', 'List Test Group B', 'list-test-group-b');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('a5100000-0000-4000-8000-000000000002', 'a5100000-0000-4000-8000-000000000001', 'List Test Clinic A',
   'LIST-TEST-A', 'Africa/Lagos', true, 'verified'),
  ('a5100000-0000-4000-8000-000000000012', 'a5100000-0000-4000-8000-000000000011', 'List Test Clinic B',
   'LIST-TEST-B', 'Africa/Lagos', true, 'verified');
create temporary table list_members (n integer primary key, facility uuid, organization uuid, role_code text, name text)
  on commit drop;
insert into list_members values
  (1, 'a5100000-0000-4000-8000-000000000002', 'a5100000-0000-4000-8000-000000000001', 'receptionist', 'Ada Desk'),
  (2, 'a5100000-0000-4000-8000-000000000002', 'a5100000-0000-4000-8000-000000000001', 'receptionist', 'Bola Desk'),
  (3, 'a5100000-0000-4000-8000-000000000002', 'a5100000-0000-4000-8000-000000000001', 'admin', 'Chidi Approver'),
  (4, 'a5100000-0000-4000-8000-000000000002', 'a5100000-0000-4000-8000-000000000001', 'lab', 'Dayo Lab'),
  (5, 'a5100000-0000-4000-8000-000000000012', 'a5100000-0000-4000-8000-000000000011', 'receptionist', 'Efe Desk'),
  (6, 'a5100000-0000-4000-8000-000000000002', 'a5100000-0000-4000-8000-000000000001', 'receptionist', 'Femi Desk');
insert into auth.accounts (id, subject, email, display_name, status)
select ('a5100100-0000-4000-8000-00000000000' || n)::uuid, 'synthetic:list-member-' || n,
  'list-member-' || n || '@example.invalid', name, 'active' from list_members;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('a5100200-0000-4000-8000-00000000000' || n)::uuid, ('a5100100-0000-4000-8000-00000000000' || n)::uuid,
  name, 'list-member-' || n || '@example.invalid', 'verified', role_code from list_members;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('a5100300-0000-4000-8000-00000000000' || n)::uuid, ('a5100200-0000-4000-8000-00000000000' || n)::uuid,
  ('a5100100-0000-4000-8000-00000000000' || n)::uuid, organization, facility, role_code, role_code, true, true
from list_members;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select gen_random_uuid(), ('a5100100-0000-4000-8000-00000000000' || n)::uuid, role_code, 'facility',
  ('a5100300-0000-4000-8000-00000000000' || n)::uuid, facility, 'Synthetic registration list suite role'
from list_members;
insert into auth.account_roles (id, account_id, role_code, scope_type, grant_reason) values
  (gen_random_uuid(), 'a5100100-0000-4000-8000-000000000006', 'identity_review_admin', 'platform',
   'Synthetic registration list suite platform reviewer');

-- Patients: 1 holds a checked NIN; 2 held one that was revoked; 3 has none.
insert into identity.patients (id, hid_code, first_name, last_name, full_name, status) values
  ('a5100400-0000-4000-8000-000000000001', 'HID-LST2A3', 'Ada', 'Checked', 'Ada Checked', 'active'),
  ('a5100400-0000-4000-8000-000000000002', 'HID-LST4B5', 'Bola', 'Revoked', 'Bola Revoked', 'active'),
  ('a5100400-0000-4000-8000-000000000003', 'HID-LST6C7', 'Chidi', 'Without', 'Chidi Without', 'active');

-- Cases. At A: 1 (desk 1, pending, no patient yet) and 2 (desk 1, approved,
-- patient 1) started at the same moment; 3 (desk 2, linked, patient 2) a
-- second earlier; 4 (desk 1, existing identity, patient 3) a second earlier
-- again. At B: 5 (desk B, pending).
create temporary table list_cases (n integer primary key, member integer, status text, patient uuid, created timestamptz)
  on commit drop;
insert into list_cases values
  (1, 1, 'pending_new_identity_approval', null, '2026-11-18 10:00:58.123456+00'),
  (2, 1, 'approved_new_identity', 'a5100400-0000-4000-8000-000000000001', '2026-11-18 10:00:58.123456+00'),
  (3, 2, 'linked_existing', 'a5100400-0000-4000-8000-000000000002', '2026-11-18 10:00:57.123456+00'),
  (4, 1, 'resolved_existing_identity', 'a5100400-0000-4000-8000-000000000003', '2026-11-18 10:00:56.123456+00'),
  (5, 5, 'pending_new_identity_approval', null, '2026-11-18 10:00:59.123456+00');
insert into identity.registration_cases (id, facility_id, created_by_account_id, created_by_membership_id, status,
  first_name, last_name, full_name, dob, gender, nin_ciphertext, nin_lookup_hmac, nin_last4, nin_key_version,
  verification_provider, verification_reference, verified_at, idempotency_key, request_sha256, resolved_patient_id,
  review_idempotency_key, review_request_sha256, reviewed_by_account_id, reviewed_by_membership_id, review_reason,
  created_at, updated_at)
select ('a5100500-0000-4000-8000-00000000000' || c.n)::uuid, m.facility,
  ('a5100100-0000-4000-8000-00000000000' || c.member)::uuid, ('a5100300-0000-4000-8000-00000000000' || c.member)::uuid,
  c.status, 'Case', 'Person ' || c.n, 'Case Person ' || c.n, '1991-04-05', 'female', decode(repeat('ab', 32), 'hex'),
  repeat(c.n::text, 64), '890' || c.n, 'k1', 'deterministic-test', 'list-ref-' || c.n, c.created,
  'list-suite-key-000' || c.n, repeat('e', 64), c.patient,
  case when c.status in ('approved_new_identity', 'linked_existing') then 'list-review-key-00' || c.n end,
  case when c.status in ('approved_new_identity', 'linked_existing') then repeat('d', 64) end,
  case when c.status in ('approved_new_identity', 'linked_existing') then 'a5100100-0000-4000-8000-000000000003'::uuid end,
  case when c.status in ('approved_new_identity', 'linked_existing') then 'a5100300-0000-4000-8000-000000000003'::uuid end,
  case when c.status in ('approved_new_identity', 'linked_existing') then 'Checked by the approver' end,
  c.created, c.created
from list_cases c join list_members m on m.n = c.member;
insert into identity.patient_identifiers (id, patient_id, identifier_type, value_ciphertext, lookup_hmac,
  encryption_key_version, display_hint, verified, verified_at, verification_provider, verification_reference,
  registration_case_id, revoked_at, revocation_reason) values
  ('a5100600-0000-4000-8000-000000000001', 'a5100400-0000-4000-8000-000000000001', 'nin', decode(repeat('ab', 32), 'hex'),
   repeat('a', 64), 'k1', '****8902', true, '2026-11-18 10:00:58+00', 'deterministic-test', 'list-ref-2',
   'a5100500-0000-4000-8000-000000000002', null, null),
  ('a5100600-0000-4000-8000-000000000002', 'a5100400-0000-4000-8000-000000000002', 'nin', decode(repeat('ab', 32), 'hex'),
   repeat('b', 64), 'k1', '****8903', true, '2026-11-18 10:00:57+00', 'deterministic-test', 'list-ref-3',
   'a5100500-0000-4000-8000-000000000003', '2026-11-18 11:00:00+00', 'Synthetic: the NIN was revoked');
set local session_replication_role = origin;
-- Identity's sessions do not set a time zone; the cursor's text must survive
-- one that is not UTC.
set local timezone = 'Africa/Lagos';

-- The list read, word for word as NinRegistrationService.listCases sends it:
-- $1 view, $2 the member's account, $3 status, $4/$5 the cursor, $6 limit + 1.
create function pg_temp.registration_case_list(text, uuid, text, timestamptz, uuid, integer)
returns table (id text, status text, row_version text, resolved_patient_id text, resolved_hid_code text,
  candidate_count text, contact_recorded boolean, nin_verified boolean, full_name text, dob text,
  created_at timestamptz, updated_at timestamptz, created_at_cursor text, created_by_me boolean)
language sql stable as $$
  select
             registration.id::text,
             registration.status,
             registration.row_version::text,
             registration.resolved_patient_id::text,
             patient.hid_code as resolved_hid_code,
             (select count(*)::text from identity.registration_case_candidates candidate
               where candidate.case_id = registration.id) as candidate_count,
             exists (select 1 from identity.registration_case_contacts contact
                      where contact.registration_case_id = registration.id and contact.erased_at is null) as contact_recorded,
             case
        when registration.verified_at is null then false
        when registration.resolved_patient_id is null then true
        else exists (select 1 from identity.patient_identifiers nin_identifier
       where nin_identifier.patient_id = registration.resolved_patient_id
         and nin_identifier.identifier_type = 'nin'
         and nin_identifier.verified
         and nin_identifier.revoked_at is null)
      end as nin_verified,
             registration.full_name,
             registration.dob::text as dob,
             registration.created_at,
             registration.updated_at,
             registration.created_at::text as created_at_cursor,
             (registration.created_by_account_id = $2::uuid) as created_by_me
           from identity.registration_cases registration
           left join identity.patients patient on patient.id = registration.resolved_patient_id
          where registration.facility_id = platform.current_facility_id()
            and ($1::text = 'facility' or registration.created_by_account_id = $2::uuid)
            and ($3::text is null or registration.status = $3::text)
            and ($4::timestamptz is null or (registration.created_at, registration.id) < ($4::timestamptz, $5::uuid))
          order by registration.created_at desc, registration.id desc
          limit $6
$$;
grant execute on function pg_temp.registration_case_list(text, uuid, text, timestamptz, uuid, integer)
  to hid_identity_api_runtime;

create temporary table list_outcomes (seq serial, name text primary key, expected text not null, actual text)
  on commit drop;
grant select, insert on pg_temp.list_outcomes to hid_identity_api_runtime;
grant usage on sequence pg_temp.list_outcomes_seq_seq to hid_identity_api_runtime;

-- Runs the list as member n in facility at_facility (Identity's transaction
-- context) and answers its rows in order as case:ninStatus, e.g.
-- 'c2:verified,c1:verified', 'none' for no rows, or the SQLSTATE and message.
create function pg_temp.list_as(n integer, at_facility uuid, view text, status text, lim integer,
  cursor_at timestamptz default null, cursor_id uuid default null) returns text language plpgsql as $f$
declare outcome text;
begin
  set local role hid_identity_api_runtime;
  perform set_config('app.actor_subject', 'synthetic:list-member-' || n, true),
    set_config('app.facility_id', at_facility::text, true),
    set_config('app.correlation_id', 'list-suite-' || n, true),
    set_config('app.membership_id', 'a5100300-0000-4000-8000-00000000000' || n, true),
    set_config('app.purpose_of_use', 'healthcare-operations', true);
  begin
    select coalesce(string_agg('c' || right(listed.id, 1) || ':'
        || case when listed.nin_verified then 'verified' else 'not_verified' end, ',' order by listed.ord), 'none')
      into outcome
      from (select row_number() over () as ord, page.* from pg_temp.registration_case_list(view,
              ('a5100100-0000-4000-8000-00000000000' || n)::uuid, status, cursor_at, cursor_id, lim) page) listed;
  exception when others then
    outcome := sqlstate || ' ' || sqlerrm;
  end;
  reset role;
  return outcome;
end $f$;
create function pg_temp.list_case(case_name text, expected text, actual text) returns void language sql as $f$
  insert into pg_temp.list_outcomes (name, expected, actual) values (case_name, expected, actual)
$f$;

-- 1. Another facility, and no permission.
select pg_temp.list_case('1a a member of B, view=facility at B, reads only B''s case', 'c5:verified',
  pg_temp.list_as(5, 'a5100000-0000-4000-8000-000000000012', 'facility', null, 101));
select pg_temp.list_case('1b a member of B, view=mine at B, reads only own case', 'c5:verified',
  pg_temp.list_as(5, 'a5100000-0000-4000-8000-000000000012', 'mine', null, 101));
select pg_temp.list_case('1c a member of B who names facility A reads none of A''s cases', 'none',
  pg_temp.list_as(5, 'a5100000-0000-4000-8000-000000000002', 'facility', null, 101));
select pg_temp.list_case('1d a member of A without identity.registration.write reads nothing', 'none',
  pg_temp.list_as(4, 'a5100000-0000-4000-8000-000000000002', 'facility', null, 101));
-- Row-level security lets a platform reviewer read every facility's cases;
-- the read's own facility filter still keeps B's case out of A's list.
select pg_temp.list_case('1e a platform reviewer at A sees only A''s cases in A''s list',
  'c2:verified,c1:verified,c3:not_verified,c4:not_verified',
  pg_temp.list_as(6, 'a5100000-0000-4000-8000-000000000002', 'facility', null, 101));

-- 2. Views and status, with ninStatus (4): case 1 has no patient yet (verified),
-- 2's patient holds a checked NIN, 3's patient's NIN was revoked, 4's patient
-- has none.
select pg_temp.list_case('2a desk 1, view=mine: own cases only, newest first', 'c2:verified,c1:verified,c4:not_verified',
  pg_temp.list_as(1, 'a5100000-0000-4000-8000-000000000002', 'mine', null, 101));
select pg_temp.list_case('2b desk 2, view=mine: own case only; the revoked NIN is not verified', 'c3:not_verified',
  pg_temp.list_as(2, 'a5100000-0000-4000-8000-000000000002', 'mine', null, 101));
select pg_temp.list_case('2c approver, view=facility: every case at A, none of B''s',
  'c2:verified,c1:verified,c3:not_verified,c4:not_verified',
  pg_temp.list_as(3, 'a5100000-0000-4000-8000-000000000002', 'facility', null, 101));
select pg_temp.list_case('2d approver, view=mine: none started by the approver', 'none',
  pg_temp.list_as(3, 'a5100000-0000-4000-8000-000000000002', 'mine', null, 101));
select pg_temp.list_case('2e approver, view=facility, status approved_new_identity', 'c2:verified',
  pg_temp.list_as(3, 'a5100000-0000-4000-8000-000000000002', 'facility', 'approved_new_identity', 101));
select pg_temp.list_case('2f desk 1, view=mine, status linked_existing (desk 2''s)', 'none',
  pg_temp.list_as(1, 'a5100000-0000-4000-8000-000000000002', 'mine', 'linked_existing', 101));

-- 3. Paging one case at a time (limit 1, so $6 = 2) through desk 1's cases,
-- two of which share created_at: each page continues from the cursor of the
-- last row shown, as Identity's nextCursor carries it (created_at::text, id).
do $$
declare
  page_one text;
  shown text[] := '{}';
  cursor_at text;
  cursor_id uuid;
  step integer;
  last_row record;
begin
  for step in 1..4 loop
    set local role hid_identity_api_runtime;
    perform set_config('app.actor_subject', 'synthetic:list-member-1', true),
      set_config('app.facility_id', 'a5100000-0000-4000-8000-000000000002', true),
      set_config('app.membership_id', 'a5100300-0000-4000-8000-000000000001', true),
      set_config('app.purpose_of_use', 'healthcare-operations', true);
    select array_agg(page.id order by ord) as ids, (array_agg(page.created_at_cursor order by ord))[1] as at_text,
           count(*) as fetched
      into last_row
      from (select row_number() over () as ord, listed.* from pg_temp.registration_case_list('mine',
              'a5100100-0000-4000-8000-000000000001', null, cursor_at::timestamptz, cursor_id, 2) listed) page;
    reset role;
    exit when last_row.fetched = 0;
    shown := shown || ('c' || right(last_row.ids[1], 1));
    if step = 1 then page_one := last_row.at_text; end if;
    -- More rows than the page: a next page exists (the service's nextCursor).
    exit when last_row.fetched < 2;
    cursor_at := last_row.at_text;
    cursor_id := last_row.ids[1]::uuid;
  end loop;
  perform pg_temp.list_case('3a paging one at a time shows each of desk 1''s cases once, in order', 'c2,c1,c4',
    array_to_string(shown, ','));
  perform pg_temp.list_case('3b the cursor text is Lagos time with microseconds', '2026-11-18 11:00:58.123456+01',
    page_one);
end $$;

-- Result.
do $$
declare
  failed text;
begin
  select string_agg(format('%s: expected [%s] got [%s]', name, expected, coalesce(actual, 'null')), E'\n' order by seq)
    into failed
    from pg_temp.list_outcomes
   where actual is distinct from expected;
  if failed is not null then
    raise exception E'registration-case list suite failed:\n%', failed;
  end if;
  raise notice 'registration-case list suite: % cases passed', (select count(*) from pg_temp.list_outcomes);
end $$;

rollback;
