-- 0089 Read-only facts the website owes from the P4c fix (item 4, B1-B3;
-- owner decisions D1-D10 of 2026-10-26, with D4's alternative): whether the
-- session's facility receives orders of a kind from other facilities now,
-- and whether such orders wait for it or are held by it; when the receiving
-- facility's access to a route ends and whether support's Close would act on
-- it now; and what a facility is as a destination, for support's panel. No
-- stored row changes, no table is altered, no audit row is added or changed,
-- and nothing 0088 replaces or recreates is touched.
--
-- 0. Preconditions (catalog reads; see Locks): no object of this migration
--    exists; the two bodies this migration replaces or drops (support's
--    summary C20 and find C21) and the thirteen it relies on are byte for byte
--    0086's (md5 of pg_proc.prosrc, measured on 0001-0088; 0087 and 0088
--    replace none of them); ehr.order_routes_receiving_idx is 0086's, and
--    the respond-by and acceptance CHECKs of ehr.order_routes are 0086's and
--    validated (their definitions compared with the same CHECKs built in the
--    session); C20 and C21 have 0086's security, volatility and search path
--    and share one owner, which may create in ehr, lab, pharmacy and
--    identity, run every function the new and changed bodies call, read the
--    tables they read, and which the applying role may become. C20's and
--    C21's owner, attributes and ACL are recorded.
-- 1. B1, whether this facility receives: ehr.order_route_receives_here(text),
--    owner-only, through lab.order_route_receives_here() and
--    pharmacy.order_route_receives_here() (SECURITY DEFINER SQL wrappers, as
--    the route cards are): identity.order_route_destination_eligible (H4,
--    which reads no switch) for the live staff session's facility and the
--    kind, under any purpose; NULL to a member without the kind's receive
--    permission (the services then omit the field). Bound to the session as
--    the cards are: no facility argument, 42501 without a staff context (a
--    released or suspended facility included), 22023 for another kind.
-- 2. D4's alternative, whether orders of the kind wait for this facility or
--    are held by it: ehr.order_routes_here(text), owner-only, through
--    lab.order_routes_here() and pharmacy.order_routes_here(), bound and
--    gated as section 1 (NULL without the receive permission). It answers
--    {"waiting": boolean, "held": boolean}: waiting, a sent route of the kind
--    to the session's facility before its respond_by (what Incoming lists);
--    held, an accepted, completed or cancelled one whose access_ends_at is
--    still ahead (what route access, H6, may read). Booleans only: no
--    patient, no count, no reference. No switch is read, so the website can
--    show orders already sent to a facility that no longer receives, and the
--    paused notice for its accepted work, at every facility. Each is one
--    range of ehr.order_routes_receiving_idx (receiving facility, state,
--    created_at): waiting the last 168 hours, held the last 1272 (no route
--    is held longer after it was sent; see section 2).
-- 3. B2, support's find (C21) with two trailing columns: access_ends_at, the
--    stored column (null before acceptance), and closable, support's Close
--    refusal (C22's own predicate) negated, at the database clock, with the
--    effective state evaluated once per row so that both agree. The OUT
--    columns change, so C21 is dropped and created with 0086's body and
--    attributes otherwise, given back to its recorded owner and checked; the
--    six functions of sections 1 and 2 go to the same owner (a SECURITY
--    DEFINER created by a superuser release runner would otherwise run as
--    the superuser, and the wrappers could not run the owner-only helpers).
-- 4. B3, support's summary (C20) replaced in place with destination
--    {receivingTypes, review}: what H4's steps 2 and 3 see (the types of the
--    facility's active products whose source application is approved as a
--    laboratory or pharmacy; the self-service review state, else governed,
--    else legacy). No verification method. CREATE OR REPLACE keeps the owner
--    and the ACL; the statement restates 0086's language, volatility,
--    security and search path.
-- 5. Grants, here and in runtime-grants.sql: the four Lab and Pharmacy
--    wrappers to their runtimes and the schema test runtime; C21 again to the
--    Identity runtime alone. Every new or recreated function is revoked from
--    PUBLIC; the two helpers are granted to no role. Last, C20's owner,
--    attributes and ACL must be as recorded, and C21's grants, as a set of
--    (grantee, privilege), as before the DROP, or the release stops.
--
-- Locks. 0089 itself holds no table lock at any section boundary (measured
-- with pg_locks). Its only table locks are two momentary ACCESS SHARE locks,
-- each released at once: on ehr.order_routes, taken by pg_get_constraintdef
-- in the CHECK precondition (section 0 d), and on
-- identity.order_route_destination_settings, taken by the PL/pgSQL validator
-- when it resolves C20's %rowtype (measured: while another session holds
-- ACCESS EXCLUSIVE on either table, the runner's lock_timeout stops the dry
-- run or the apply after 5 seconds with nothing applied; with it held on
-- ehr.order_route_events, identity.facilities, identity.organizations,
-- identity.organization_applications, identity.organization_products,
-- identity.staff_facility_memberships, identity.patients, auth.accounts,
-- auth.account_roles, platform.control_settings or identity.consent_grants,
-- 0089 applies without waiting). The SQL wrappers name only functions, the
-- PL/pgSQL bodies are not planned at CREATE, the other preconditions read
-- the catalog only, and dropping and creating functions locks no table.
-- ACCESS SHARE conflicts only with ACCESS EXCLUSIVE, so no request waits for
-- 0089.
-- When 0088 is pending too, the dry run applies both in one transaction, and
-- 0088's ACCESS EXCLUSIVE on ehr.order_routes is then held through 0089 as
-- well.
--
-- Old services on this schema: the previous Lab and Pharmacy images call none
-- of the new functions; the previous Identity names its 13 C21 columns, so it
-- reads the recreated C21 unchanged, and spreads C20's jsonb, so destination
-- reaches its answer and the previous website ignores it. Applied migrations
-- 0001 through 0088 are immutable.

-- 0. Preconditions. The release dry-runs every pending migration in one
-- transaction before applying any, so a refusal here stops the release with
-- nothing changed. Catalog reads; only pg_get_constraintdef takes a table
-- lock, a momentary ACCESS SHARE on ehr.order_routes (see Locks).
do $$
declare
  mismatch text;
  owners oid[];
  o oid;
begin
  -- a. No collision, under any signature.
  if exists (select 1 from pg_proc proc join pg_namespace namespace on namespace.oid = proc.pronamespace
              where (namespace.nspname, proc.proname) in (
                ('ehr', 'order_route_receives_here'), ('lab', 'order_route_receives_here'),
                ('pharmacy', 'order_route_receives_here'), ('ehr', 'order_routes_here'),
                ('lab', 'order_routes_here'), ('pharmacy', 'order_routes_here'))) then
    raise exception '0089: a function this migration creates already exists; this release would collide with it';
  end if;
  -- b. The bodies this migration replaces (C20) or drops (C21): md5 of
  -- pg_proc.prosrc measured on 0001-0088, equal to the md5 of the body text
  -- in 0086 (0087 and 0088 replace neither).
  select string_agg(format('%s md5 %s', expected.proc, md5(proc.prosrc)), '; ') into mismatch
    from (values ('identity.admin_order_route_summary(uuid)'::regprocedure, '38ca27cad723425a2cab4725c7603e8e'),
                 ('identity.admin_find_order_routes(text,text)'::regprocedure, '818a4b363e7476edfd22ec690d69aed1'))
         expected(proc, digest)
    join pg_proc proc on proc.oid = expected.proc
   where md5(proc.prosrc) <> expected.digest;
  if mismatch is not null then
    raise exception '0089: a function this migration replaces or drops has another body than 0086 gave it: %', mismatch;
  end if;
  -- c. The bodies the new fields call or mirror (0086's, measured on
  -- 0001-0088): H4 and what it calls or derives from (H3, the self-service
  -- state, the kind's receive permission and destination type, the
  -- membership permission check), the staff and platform actors, H9, the
  -- Health ID normalizer, support's Close (C22) and listing (C23), which
  -- closable and the panel's form rule mirror, and the acceptance, whose
  -- refusal at respond_by bounds section 2's held read.
  select string_agg(format('%s md5 %s', expected.proc, md5(proc.prosrc)), '; ') into mismatch
    from (values
      ('identity.order_route_destination_eligible(uuid,text)'::regprocedure, '6b274d9be9056cefc831a9fd92040bc6'),
      ('identity.order_route_destination_listed(uuid)'::regprocedure, '2a2025d538db2686c1ca5a03e0354923'),
      ('identity.organization_self_service_state(uuid)'::regprocedure, 'c67aa5224b2aa3d95e4415e26787d470'),
      ('ehr.order_route_staff_actor(boolean)'::regprocedure, 'b1873dca92164652cc1977a90acb6184'),
      ('ehr.order_route_receive_permission(text)'::regprocedure, '4c9f4acbafb062ff9a2cda113ccad037'),
      ('ehr.order_route_destination_type(text)'::regprocedure, '9ce8c8706abc84e98ae3e1c86a24515f'),
      ('auth.membership_has_permission(text,uuid,uuid,text)'::regprocedure, '65e3eaff93fe729fd5c5b986b80c9dd6'),
      ('ehr.order_route_effective_state(ehr.order_routes)'::regprocedure, '934300a9e58a7f6789b1dc24520fabad'),
      ('identity.admin_close_order_route(uuid,bigint,text)'::regprocedure, 'e0ea834d458863ec19a94b4853e2a32c'),
      ('identity.admin_set_order_route_destination(uuid,boolean,text)'::regprocedure,
       '3a5586cc088f3dc2467d52636976739f'),
      ('identity.order_route_platform_actor(text[])'::regprocedure, '599cccfdba5e9b4c46cde4dd2814a541'),
      ('ehr.order_route_health_id(text)'::regprocedure, 'f336e87adb3ac67fd83ac1de7b3efa7d'),
      ('ehr.accept_receiving_order_route(text,uuid,bigint,text,text,text,text,character,text)'::regprocedure,
       '1d4a77de6316fa95a539d8151c8604df'))
         expected(proc, digest)
    join pg_proc proc on proc.oid = expected.proc
   where md5(proc.prosrc) <> expected.digest;
  if mismatch is not null then
    raise exception '0089: a function the new fields rely on has another body than 0086 gave it: %', mismatch;
  end if;
  -- d. Section 2's index and bounds: 0086's ehr.order_routes_receiving_idx
  -- on (receiving_facility_id, state, created_at), not partial (pg_index);
  -- and the two CHECKs the bounds derive from, validated and exactly 0086's
  -- (0086:6376 and 6394-6406), compared with the same CHECKs built on a
  -- temporary table in this session, as 0088 compares its CHECKs.
  if to_regclass('ehr.order_routes_receiving_idx') is null
     or (select index_row.indrelid <> 'ehr.order_routes'::regclass or index_row.indpred is not null
                or index_row.indexprs is not null
                or (select array_agg(attribute.attname::text order by key_column.position)
                      from unnest(index_row.indkey::int2[]) with ordinality key_column(attnum, position)
                      join pg_attribute attribute
                        on attribute.attrelid = index_row.indrelid and attribute.attnum = key_column.attnum)
                   is distinct from array['receiving_facility_id', 'state', 'created_at']
           from pg_index index_row where index_row.indexrelid = to_regclass('ehr.order_routes_receiving_idx')) then
    raise exception '0089: ehr.order_routes_receiving_idx is not 0086''s (receiving_facility_id, state, created_at)';
  end if;
  create temporary table order_route_bounds_0089 (
    kind text,
    state text,
    created_at timestamptz,
    respond_by timestamptz,
    accepted_at timestamptz,
    accepted_by_account_id uuid,
    accepted_by_membership_id uuid,
    accept_idempotency_key text,
    accept_request_sha256 char(64),
    lab_work_item_id uuid,
    pharmacy_work_item_id uuid,
    writes_end_at timestamptz,
    access_ends_at timestamptz,
    constraint order_routes_respond_by_ck check (respond_by = created_at + interval '168 hours'),
    constraint order_routes_acceptance_ck check (
      (accepted_at is null and accepted_by_account_id is null and accepted_by_membership_id is null
        and accept_idempotency_key is null and accept_request_sha256 is null
        and lab_work_item_id is null and pharmacy_work_item_id is null
        and writes_end_at is null and access_ends_at is null
        and state in ('sent', 'declined', 'withdrawn', 'expired'))
      or (accepted_at is not null and accepted_by_account_id is not null and accepted_by_membership_id is not null
        and accept_idempotency_key is not null and accept_request_sha256 is not null
        and ((kind = 'lab_request' and lab_work_item_id is not null)
          or (kind = 'prescription' and pharmacy_work_item_id is not null))
        and writes_end_at is not null and access_ends_at is not null
        and writes_end_at <= access_ends_at and access_ends_at <= accepted_at + interval '1080 hours'
        and state in ('accepted', 'completed', 'cancelled')))
  ) on commit drop;
  select string_agg(expected.conname, ', ' order by expected.conname) into mismatch
    from (values ('order_routes_respond_by_ck'), ('order_routes_acceptance_ck')) expected(conname)
   where (select pg_get_constraintdef(live.oid) from pg_constraint live
           where live.conrelid = 'ehr.order_routes'::regclass and live.conname = expected.conname
             and live.contype = 'c' and live.convalidated)
         is distinct from
         (select pg_get_constraintdef(built.oid) from pg_constraint built
           where built.conrelid = 'pg_temp.order_route_bounds_0089'::regclass and built.conname = expected.conname
             and built.contype = 'c');
  if mismatch is not null then
    raise exception '0089: a CHECK section 2''s bounds derive from is not 0086''s validated CHECK: %', mismatch;
  end if;
  -- e. C20's and C21's attributes and ACL before the change.
  create temporary table order_route_contract_0089 on commit drop as
    select proc.oid::regprocedure::text as signature, proc.proowner, proc.prosecdef, proc.provolatile,
           proc.proconfig, proc.proacl
      from pg_proc proc
     where proc.oid in ('identity.admin_order_route_summary(uuid)'::regprocedure,
                        'identity.admin_find_order_routes(text,text)'::regprocedure);
  if (select count(*) from pg_temp.order_route_contract_0089) <> 2
     or exists (select 1 from pg_temp.order_route_contract_0089 recorded
                 where not recorded.prosecdef or recorded.provolatile <> 's'
                    or recorded.proconfig is distinct from
                       array['search_path=pg_catalog, identity, ehr, auth, platform, pg_temp']) then
    raise exception '0089: support''s summary or find has other attributes than 0086 gave it';
  end if;
  -- f. One owner o for C20 and C21, which may create the new functions, may
  -- run every function the new and changed bodies call as o, and may read
  -- the tables they read; and the applying role may become o (ALTER OWNER
  -- needs SET on PostgreSQL 16).
  select array_agg(distinct recorded.proowner) into owners from pg_temp.order_route_contract_0089 recorded;
  o := owners[1];
  if cardinality(owners) <> 1
     or not has_schema_privilege(o, 'ehr', 'CREATE') or not has_schema_privilege(o, 'lab', 'CREATE')
     or not has_schema_privilege(o, 'pharmacy', 'CREATE') or not has_schema_privilege(o, 'identity', 'CREATE')
     or exists (select 1 from unnest(array[
          'ehr.order_route_staff_actor(boolean)', 'ehr.order_route_receive_permission(text)',
          'auth.membership_has_permission(text,uuid,uuid,text)',
          'identity.order_route_destination_eligible(uuid,text)',
          'ehr.order_route_effective_state(ehr.order_routes)', 'identity.order_route_platform_actor(text[])',
          'ehr.order_route_health_id(text)', 'identity.order_route_destination_listed(uuid)',
          'identity.organization_self_service_state(uuid)']::regprocedure[]) callee
         where not has_function_privilege(o, callee, 'EXECUTE'))
     or exists (select 1 from unnest(array['ehr.order_routes', 'identity.facilities', 'identity.patients',
          'identity.organization_products', 'identity.organization_applications',
          'identity.order_route_destination_settings']::regclass[]) relation
         where not has_table_privilege(o, relation, 'SELECT'))
     or not pg_has_role(current_user, o, 'USAGE')
     or (o <> (select role_row.oid from pg_roles role_row where role_row.rolname = current_user)
         and not pg_has_role(current_user, o, 'SET')) then
    raise exception '0089: support''s summary and find must share one owner that may create in ehr, lab, pharmacy '
      'and identity, run and read what the new fields call and read, and that the applying role may become';
  end if;
end
$$;

-- 1. B1. Whether the session's facility receives orders of this kind from
-- other facilities now: H4, which reads no switch, answered only to a member
-- holding the kind's receive permission (NULL otherwise). Bound to the staff
-- session as the route cards are (any purpose: a work list may be read under
-- one other than direct care); reads identity and auth only (no control),
-- takes no row lock, writes nothing.
create function ehr.order_route_receives_here(requested_kind text)
returns boolean
language plpgsql stable
set search_path = pg_catalog, ehr, identity, auth, pg_temp
as $$
declare
  actor record;
  receive_permission text := ehr.order_route_receive_permission(requested_kind);
begin
  select * into actor from ehr.order_route_staff_actor(false);
  if receive_permission is null then
    raise exception using errcode = '22023', message = 'ORDER_ROUTE_INVALID';
  end if;
  if not auth.membership_has_permission(actor.actor_subject, actor.actor_membership_id, actor.actor_facility_id,
           receive_permission) then
    return null;
  end if;
  return identity.order_route_destination_eligible(actor.actor_facility_id, requested_kind);
end;
$$;

create function lab.order_route_receives_here()
returns boolean
language sql stable security definer
set search_path = pg_catalog, lab, ehr, pg_temp
as $$
  select ehr.order_route_receives_here('lab_request')
$$;

create function pharmacy.order_route_receives_here()
returns boolean
language sql stable security definer
set search_path = pg_catalog, pharmacy, ehr, pg_temp
as $$
  select ehr.order_route_receives_here('prescription')
$$;

-- 2. D4's alternative. Whether orders of this kind wait for the session's
-- facility (a sent route before its respond_by, as Incoming lists them) or
-- are held by it (an accepted, completed or cancelled route whose
-- access_ends_at is still ahead, as H6 reads them), whatever the switches
-- and the listing say. Bound and gated as section 1 (NULL without the
-- receive permission). Two booleans: no patient, no count, no reference.
-- The clock is read once. Each read is a range of
-- ehr.order_routes_receiving_idx (facility, state, created_at), so it does
-- not grow with the facility's history (both CHECKs named below are
-- compared with 0086's in section 0):
--   - waiting: respond_by = created_at + 168 hours (0086's
--     order_routes_respond_by_ck), so the created_at bound is the same
--     condition;
--   - held: no route is held past created_at + 1248 hours, because
--     access_ends_at <= accepted_at + 1080 hours (0086's
--     order_routes_acceptance_ck; the guard never lets it grow) and the one
--     command that accepts (ehr.accept_receiving_order_route, pinned in
--     section 0) refuses at respond_by and stamps accepted_at in the same
--     statement; the bound keeps a day's margin (1272 hours).
-- Each call is planned for its own facility and clock (plan_cache_mode
-- force_custom_plan): a generic plan cannot see the bounds and, at a
-- facility holding most routes, scans the table (measured: 45 ms against
-- 2 ms per call with 100,000 routes at one laboratory).
create function ehr.order_routes_here(requested_kind text)
returns jsonb
language plpgsql stable
set search_path = pg_catalog, ehr, auth, pg_temp
set plan_cache_mode = force_custom_plan
as $$
declare
  actor record;
  receive_permission text := ehr.order_route_receive_permission(requested_kind);
  checked_at timestamptz := clock_timestamp();
begin
  select * into actor from ehr.order_route_staff_actor(false);
  if receive_permission is null then
    raise exception using errcode = '22023', message = 'ORDER_ROUTE_INVALID';
  end if;
  if not auth.membership_has_permission(actor.actor_subject, actor.actor_membership_id, actor.actor_facility_id,
           receive_permission) then
    return null;
  end if;
  return jsonb_build_object(
    'waiting', exists (
      select 1 from ehr.order_routes route
       where route.receiving_facility_id = actor.actor_facility_id
         and route.state = 'sent'
         and route.created_at > checked_at - interval '168 hours'
         and route.kind = requested_kind
         and route.respond_by > checked_at),
    'held', exists (
      select 1 from ehr.order_routes route
       where route.receiving_facility_id = actor.actor_facility_id
         and route.state in ('accepted', 'completed', 'cancelled')
         and route.created_at > checked_at - interval '1272 hours'
         and route.kind = requested_kind
         and route.access_ends_at > checked_at));
end;
$$;

create function lab.order_routes_here()
returns jsonb
language sql stable security definer
set search_path = pg_catalog, lab, ehr, pg_temp
as $$
  select ehr.order_routes_here('lab_request')
$$;

create function pharmacy.order_routes_here()
returns jsonb
language sql stable security definer
set search_path = pg_catalog, pharmacy, ehr, pg_temp
as $$
  select ehr.order_routes_here('prescription')
$$;

-- 3. B2. C21 (0086:9154-9205) with two trailing columns: when the receiving
-- facility's access ends (null before acceptance), and whether support's
-- Close (C22) would act now: C22's own refusal (0086:9230-9234), negated, at
-- the database clock. The effective state is evaluated once per row (the
-- lateral), so effective_state and closable always agree. Identity names or
-- selects its columns, so an image reading 13 columns reads this function
-- unchanged.
drop function identity.admin_find_order_routes(text,text);

create function identity.admin_find_order_routes(requested_reference text, requested_health_id text)
returns table (
  route_id uuid,
  reference text,
  kind text,
  row_version bigint,
  effective_state text,
  ordering_facility_id uuid,
  ordering_facility_name text,
  receiving_facility_id uuid,
  receiving_facility_name text,
  created_at timestamptz,
  accepted_at timestamptz,
  ended_at timestamptz,
  ended_kind text,
  access_ends_at timestamptz,
  closable boolean
)
language plpgsql stable security definer
set search_path = pg_catalog, identity, ehr, auth, platform, pg_temp
as $$
declare
  wanted_reference text := upper(btrim(requested_reference));
  wanted_patient uuid;
begin
  perform identity.order_route_platform_actor(array['platform.principal.read']);
  if (requested_reference is null) = (requested_health_id is null)
     or (requested_reference is not null and not coalesce(wanted_reference ~ '^[0-9A-F]{8}$', false))
     or (requested_health_id is not null and ehr.order_route_health_id(requested_health_id) is null) then
    raise exception using errcode = '22023', message = 'ORDER_ROUTE_LOOKUP_INVALID';
  end if;
  if requested_health_id is not null then
    select patient.id into wanted_patient from identity.patients patient
     where patient.hid_code = ehr.order_route_health_id(requested_health_id);
    if wanted_patient is null then
      return;
    end if;
  end if;
  return query
    select route.id, route.reference::text, route.kind, route.row_version, now_state.effective,
      route.ordering_facility_id,
      (select facility.name from identity.facilities facility where facility.id = route.ordering_facility_id),
      route.receiving_facility_id,
      (select facility.name from identity.facilities facility where facility.id = route.receiving_facility_id),
      route.created_at, route.accepted_at, route.ended_at, route.ended_kind,
      route.access_ends_at,
      not coalesce(now_state.effective not in ('sent', 'accepted', 'completed')
        or (route.state = 'completed'
          and (route.ended_at is not null or clock_timestamp() >= route.access_ends_at)), false)
      from ehr.order_routes route
      cross join lateral (select ehr.order_route_effective_state(route) as effective) now_state
     where (requested_reference is not null and route.reference = wanted_reference)
        or (wanted_patient is not null and route.patient_id = wanted_patient)
     order by route.created_at desc, route.id desc
     limit case when requested_reference is not null then 5 else 20 end;
end;
$$;

-- C21 and the six new functions go to the owner recorded in section 0 (a
-- CREATE makes the applying role their owner), then C21's owner, security,
-- volatility and search path must equal 0086's, and the new functions'
-- owner the recorded one, or the release stops.
do $$
declare
  recorded record;
  signature text;
  mismatch text;
begin
  select * into recorded from pg_temp.order_route_contract_0089 recorded_row
   where recorded_row.signature::regprocedure = 'identity.admin_find_order_routes(text,text)'::regprocedure;
  foreach signature in array array['identity.admin_find_order_routes(text,text)',
      'ehr.order_route_receives_here(text)', 'lab.order_route_receives_here()', 'pharmacy.order_route_receives_here()',
      'ehr.order_routes_here(text)', 'lab.order_routes_here()', 'pharmacy.order_routes_here()'] loop
    if (select proc.proowner from pg_proc proc where proc.oid = signature::regprocedure) <> recorded.proowner then
      execute format('alter function %s owner to %I', signature, pg_get_userbyid(recorded.proowner));
    end if;
  end loop;
  select string_agg(proc.oid::regprocedure::text, ', ') into mismatch
    from pg_proc proc
   where (proc.oid = 'identity.admin_find_order_routes(text,text)'::regprocedure
          and (proc.proowner, proc.prosecdef, proc.provolatile, proc.proconfig)
              is distinct from (recorded.proowner, recorded.prosecdef, recorded.provolatile, recorded.proconfig))
      or (proc.oid in ('ehr.order_route_receives_here(text)'::regprocedure,
                       'lab.order_route_receives_here()'::regprocedure,
                       'pharmacy.order_route_receives_here()'::regprocedure,
                       'ehr.order_routes_here(text)'::regprocedure,
                       'lab.order_routes_here()'::regprocedure,
                       'pharmacy.order_routes_here()'::regprocedure)
          and proc.proowner <> recorded.proowner);
  if mismatch is not null then
    raise exception '0089: a recreated or new function differs from 0086''s owner or attributes: %', mismatch;
  end if;
end
$$;

-- 4. B3. C20 (0086:9099-9152) with destination after listed: what H4's steps
-- 2 and 3 see (0086:6780-6801), for support's panel. The rest of the body is
-- 0086's.
create or replace function identity.admin_order_route_summary(target_facility_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, identity, ehr, auth, platform, pg_temp
as $$
declare
  latest identity.order_route_destination_settings%rowtype;
  summary jsonb;
begin
  perform identity.order_route_platform_actor(array['platform.facility.read']);
  if target_facility_id is null
     or not exists (select 1 from identity.facilities facility where facility.id = target_facility_id) then
    raise exception using errcode = 'P0002', message = 'ADMIN_FACILITY_NOT_FOUND';
  end if;
  select setting.* into latest from identity.order_route_destination_settings setting
   where setting.facility_id = target_facility_id
   order by setting.set_at desc, setting.id desc limit 1;
  select jsonb_build_object(
    'listed', jsonb_build_object('value', identity.order_route_destination_listed(target_facility_id),
      'byDefault', latest.id is null, 'reason', latest.reason, 'setAt', latest.set_at),
    'destination', (
      select jsonb_build_object(
        -- H4 step 3: the types of the active products at this facility whose
        -- source application is approved; empty for a facility that is no
        -- laboratory or pharmacy on Health ID (a hospital, clinic or other).
        'receivingTypes', coalesce((
          select jsonb_agg(distinct source_application.organization_type
                           order by source_application.organization_type)
            from identity.organization_products product
            join identity.organization_applications source_application
              on source_application.id = product.source_application_id
           where product.facility_id = facility.id
             and product.organization_id = facility.organization_id
             and product.status = 'active'
             and source_application.status = 'approved'
             and source_application.organization_type in ('laboratory', 'pharmacy')), '[]'::jsonb),
        -- H4 step 2: the self-service review, else governed (an approved
        -- admin_review application), else legacy.
        'review', coalesce(
          (select state_row.review_state
             from identity.organization_self_service_state(facility.organization_id) state_row),
          case when exists (select 1 from identity.organization_applications governed
                             where governed.organization_id = facility.organization_id
                               and governed.approval_mode = 'admin_review'
                               and governed.status = 'approved')
               then 'governed' else 'legacy' end))
        from identity.facilities facility
       where facility.id = target_facility_id),
    'receivedAcceptedLifetime', (select count(*) from ehr.order_routes route
      where route.receiving_facility_id = target_facility_id and route.accepted_at is not null),
    'receivedPatientsLifetime', (select count(distinct route.patient_id) from ehr.order_routes route
      where route.receiving_facility_id = target_facility_id and route.accepted_at is not null),
    'counterparts', coalesce((
      select jsonb_agg(jsonb_build_object('direction', counterpart.direction, 'facilityId', counterpart.facility_id,
               'facilityName', counterpart.facility_name, 'last30Days', counterpart.states)
             order by counterpart.direction, counterpart.facility_name, counterpart.facility_id)
        from (
          select grouped.direction, grouped.facility_id,
            (select facility.name from identity.facilities facility where facility.id = grouped.facility_id)
              as facility_name,
            jsonb_object_agg(grouped.effective_state, grouped.route_count) as states
            from (
              select case when route.ordering_facility_id = target_facility_id then 'sent' else 'received' end
                       as direction,
                     case when route.ordering_facility_id = target_facility_id then route.receiving_facility_id
                          else route.ordering_facility_id end as facility_id,
                     ehr.order_route_effective_state(route) as effective_state,
                     count(*) as route_count
                from ehr.order_routes route
               where (route.ordering_facility_id = target_facility_id
                   or route.receiving_facility_id = target_facility_id)
                 and route.created_at > clock_timestamp() - interval '720 hours'
               group by 1, 2, 3) grouped
           group by grouped.direction, grouped.facility_id) counterpart), '[]'::jsonb))
    into summary;
  return summary;
end;
$$;

-- 5. Grants (as 0086 section 7; runtime-grants.sql carries the same). The
-- login roles (hid_lab_api_runtime, hid_pharmacy_api_runtime,
-- hid_identity_api_runtime) inherit their group's.
revoke all on function ehr.order_route_receives_here(text), lab.order_route_receives_here(),
  pharmacy.order_route_receives_here(), ehr.order_routes_here(text), lab.order_routes_here(),
  pharmacy.order_routes_here(), identity.admin_find_order_routes(text,text)
  from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_lab_runtime') then
    grant execute on function lab.order_route_receives_here(), lab.order_routes_here() to hid_lab_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_pharmacy_runtime') then
    grant execute on function pharmacy.order_route_receives_here(), pharmacy.order_routes_here()
      to hid_pharmacy_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_identity_runtime') then
    grant execute on function identity.admin_find_order_routes(text,text) to hid_identity_runtime;
  end if;
  if exists (select 1 from pg_roles where rolname = 'hid_schema_test_runtime') then
    grant execute on function lab.order_route_receives_here(), lab.order_routes_here(),
      pharmacy.order_route_receives_here(), pharmacy.order_routes_here()
      to hid_schema_test_runtime;
  end if;
end
$$;

-- Last: C20 kept its owner, attributes and ACL (CREATE OR REPLACE keeps
-- them); C21's grants are, as a set of (grantee, privilege), what they were
-- before the DROP (the grantor may differ when a superuser applies it).
-- Another grant on C21 that production holds would otherwise be lost
-- silently: restate it in this migration first.
do $$
declare
  mismatch text;
begin
  select string_agg(recorded.signature, ', ') into mismatch
    from pg_temp.order_route_contract_0089 recorded
    join pg_proc proc on proc.oid = recorded.signature::regprocedure
   where recorded.signature::regprocedure = 'identity.admin_order_route_summary(uuid)'::regprocedure
     and (proc.proowner, proc.prosecdef, proc.provolatile, proc.proconfig, proc.proacl)
         is distinct from (recorded.proowner, recorded.prosecdef, recorded.provolatile, recorded.proconfig,
           recorded.proacl);
  if mismatch is not null then
    raise exception '0089: support''s summary changed owner, attributes or grants: %', mismatch;
  end if;
  if exists (
      (select acl.grantee, acl.privilege_type
         from pg_temp.order_route_contract_0089 recorded,
              aclexplode(coalesce(recorded.proacl, acldefault('f', recorded.proowner))) acl
        where recorded.signature::regprocedure = 'identity.admin_find_order_routes(text,text)'::regprocedure
       except
       select acl.grantee, acl.privilege_type
         from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
        where proc.oid = 'identity.admin_find_order_routes(text,text)'::regprocedure)
      union all
      (select acl.grantee, acl.privilege_type
         from pg_proc proc, aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) acl
        where proc.oid = 'identity.admin_find_order_routes(text,text)'::regprocedure
       except
       select acl.grantee, acl.privilege_type
         from pg_temp.order_route_contract_0089 recorded,
              aclexplode(coalesce(recorded.proacl, acldefault('f', recorded.proowner))) acl
        where recorded.signature::regprocedure = 'identity.admin_find_order_routes(text,text)'::regprocedure)) then
    raise exception '0089: support''s find has other grants than before; restate them in this migration first';
  end if;
end
$$;
