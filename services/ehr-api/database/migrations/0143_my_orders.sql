-- 0143: "Ordered by me" (MY-1, Akos P1-4, Release B; the planned contract's
-- "MY-1: Ordered by me list"). Booked as 0143 on hid-system#258; numbers are
-- given in merge order at the Release B cut-off. This file requires
-- 0001-0137 applied.
--
-- One list of the lab requests and prescriptions this member ordered at this
-- facility (created_by_membership_id is the session's membership), so
-- doctors stop using the lab and pharmacy work queues.
--
-- D1 Two indexes, prescriptions_my_orders_idx and lab_requests_my_orders_idx,
--    on (facility_id, created_by_membership_id, created_at desc, id desc);
--    and prescriptions_owner_read and lab_requests_owner_read: row-level
--    security on both tables is forced, and the function below must see
--    this member's orders for patients the member can no longer read, to
--    count them (never to show them), so the tables' owner may read them,
--    as 0131's encounters_owner_read. No runtime role is a member of the
--    owner.
-- D2 ehr.list_my_orders(requested_kinds text[], requested_open_only boolean,
--    requested_since date, cursor_created_at timestamptz, cursor_kind text,
--    cursor_id uuid, requested_limit integer), SECURITY DEFINER, for the EHR
--    runtime:
--    - the session is a staff member with an active, unheld membership at
--      the session facility, for direct care (else 42501
--      MY_ORDERS_NOT_PERMITTED or 22023 MY_ORDERS_DIRECT_CARE_ONLY);
--      'lab_request' needs ehr.lab-request.read and 'prescription'
--      ehr.prescription.read (else 42501);
--    - the reach: orders this membership created at this facility, never
--      entered in error; open ones (draft, active, on hold) of any age, and
--      ended ones (completed, cancelled) created on or after the Lagos day
--      `requested_since` (at most 2 years back, else 22023
--      MY_ORDERS_SINCE_TOO_OLD); `requested_open_only` keeps the open ones;
--    - a row is listed only while the session may read that patient's
--      records now: ehr.context_allows(patient, facility, 'read_records')
--      under the session's own direct-care context, the rule row-level
--      security applies (a consent grant, 0131's own-facility opening
--      included; never break-glass, which is emergency only). Every other
--      matching order is counted in hidden_count, never shown;
--    - newest first (created_at, kind, id descending), keyset paging after
--      the cursor, 1-50 rows, has_more; an empty page is one row with no
--      order (kind null) that still carries hidden_count;
--    - each row: the order (kind, id, visit, display, status, priority,
--      times) and the waiting-list card's patient fields (0135: name, sex,
--      date of birth, last 4 of the Health ID); never a full Health ID;
--    - audited: one ehr.my-orders.list row (filters, count, hiddenCount,
--      patient ids shown) and one ehr.my-orders.list.shown row per patient
--      shown, as the waiting list does.
-- D3 EXECUTE on the function to hid_ehr_runtime where it exists (the runtime
--    roles' bootstrap may come after the migrations), here and in
--    runtime-grants.sql; revoked from PUBLIC.
--
-- Locks: ACCESS EXCLUSIVE on ehr.prescriptions and ehr.lab_requests (the two
-- owner read policies; the index builds need less), held to commit. Taken first,
-- NOWAIT: a busy table fails the attempt at once and its subtransaction
-- releases what it took; the attempt is made again every 100 ms for at most
-- 5 seconds, then 55P03 (nothing applied). When this transaction already
-- holds an earlier migration's locks that stop other sessions' reads or
-- writes (the runner's dry run), one attempt and no sleep: 55P03 at once,
-- nothing applied. Both tables are small on the live system.
--
-- Old services on this schema: nothing reads the function or the indexes.
--
-- 0. Preconditions (catalog reads only; 55000 and nothing applied).
-- 0b. Locks, NOWAIT (55P03 and nothing applied).
-- 1. The indexes and the owner's read (D1).
-- 2. The function (D2).
-- 3. Grants (D3).
-- 4. Post-checks.

-- 0. Preconditions.
do $$
declare
  mismatch text;
begin
  if to_regclass('auth.session_facility_selection') is null
     or to_regprocedure('identity.qoreid_nin_record_used(character,text)') is null then
    raise exception using errcode = '55000', message = '0143: 0001-0137 must be applied first';
  end if;
  if to_regprocedure('ehr.list_my_orders(text[],boolean,date,timestamp with time zone,text,uuid,integer)') is not null
     or exists (select 1 from pg_policy policy_row
                 where policy_row.polname in ('prescriptions_owner_read', 'lab_requests_owner_read'))
     or to_regclass('ehr.prescriptions_my_orders_idx') is not null
     or to_regclass('ehr.lab_requests_my_orders_idx') is not null then
    raise exception using errcode = '55000', message = '0143: already applied';
  end if;
  select string_agg(expected.signature, ', ') into mismatch
    from (values
      ('ehr.context_allows(uuid,uuid,text)', '75016690184a80bd246c365b4d108082'),
      ('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamp with time zone)', '732d11892dd4e27e1ff9093ae3b7de5a'),
      ('auth.membership_has_permission(text,uuid,uuid,text)', '65e3eaff93fe729fd5c5b986b80c9dd6')
    ) expected(signature, body_md5)
   where to_regprocedure(expected.signature) is null
      or (select md5(proc.prosrc) from pg_proc proc where proc.oid = to_regprocedure(expected.signature))
         is distinct from expected.body_md5;
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0143: these functions are not the ones this file relies on: ' || mismatch;
  end if;
  select string_agg(expected.table_name || '.' || expected.column_name, ', ') into mismatch
    from (values
      ('ehr.prescriptions', 'medication_display', 'text'), ('ehr.prescriptions', 'priority', 'text'),
      ('ehr.lab_requests', 'test_display', 'text'), ('ehr.lab_requests', 'priority', 'text'),
      ('ehr.prescriptions', 'created_by_membership_id', 'uuid'), ('ehr.lab_requests', 'created_by_membership_id', 'uuid'),
      ('ehr.prescriptions', 'encounter_id', 'uuid'), ('ehr.lab_requests', 'encounter_id', 'uuid'),
      ('ehr.prescriptions', 'status', 'text'), ('ehr.lab_requests', 'status', 'text'),
      ('ehr.prescriptions', 'created_at', 'timestamp with time zone'),
      ('ehr.lab_requests', 'created_at', 'timestamp with time zone'),
      ('ehr.prescriptions', 'updated_at', 'timestamp with time zone'),
      ('ehr.lab_requests', 'updated_at', 'timestamp with time zone'),
      ('identity.patients', 'hid_code', 'text'), ('identity.patients', 'gender', 'text'),
      ('identity.patients', 'dob', 'date')) expected(table_name, column_name, type_name)
   where not exists (select 1 from pg_attribute attribute
                      where attribute.attrelid = to_regclass(expected.table_name)
                        and attribute.attname = expected.column_name and not attribute.attisdropped
                        and format_type(attribute.atttypid, attribute.atttypmod) = expected.type_name);
  if mismatch is not null then
    raise exception using errcode = '55000', message = '0143: these columns are not as this file reads them: ' || mismatch;
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
      lock table ehr.prescriptions, ehr.lab_requests in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if holding then
        raise exception using errcode = '55P03',
          message = '0143: ehr.prescriptions or ehr.lab_requests is busy, and this transaction already holds an earlier migration''s '
            || 'locks, so it does not wait; nothing applied; run the release again at a quieter time';
      end if;
      if attempt >= 50 then
        raise exception using errcode = '55P03',
          message = '0143: ehr.prescriptions or ehr.lab_requests stayed busy for 5 seconds; nothing applied; run the release again at a '
            || 'quieter time';
      end if;
      perform pg_sleep(0.1);
    end;
  end loop;
end
$locks$;

-- 1. The indexes and the owner's read (D1).
create index prescriptions_my_orders_idx on ehr.prescriptions
  (facility_id, created_by_membership_id, created_at desc, id desc);
create index lab_requests_my_orders_idx on ehr.lab_requests
  (facility_id, created_by_membership_id, created_at desc, id desc);
create policy prescriptions_owner_read on ehr.prescriptions
  for select
  using (pg_has_role((select relation.relowner from pg_class relation
                       where relation.oid = 'ehr.prescriptions'::regclass), 'USAGE'));
create policy lab_requests_owner_read on ehr.lab_requests
  for select
  using (pg_has_role((select relation.relowner from pg_class relation
                       where relation.oid = 'ehr.lab_requests'::regclass), 'USAGE'));

-- 2. The function (D2).
create function ehr.list_my_orders(requested_kinds text[], requested_open_only boolean, requested_since date,
  cursor_created_at timestamptz, cursor_kind text, cursor_id uuid, requested_limit integer)
returns table (kind text, order_id uuid, encounter_id uuid, patient_id uuid, full_name text, sex text,
  date_of_birth date, health_id_last4 text, display text, status text, priority text, created_at timestamptz,
  updated_at timestamptz, hidden_count bigint, has_more boolean)
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
  actor_purpose text := platform.current_purpose_of_use();
  actor_organization uuid;
  today date := (clock_timestamp() at time zone 'Africa/Lagos')::date;
  since_start timestamptz;
  page_limit integer;
  hidden bigint;
  more boolean;
  page_kinds text[];
  page_ids uuid[];
  page_patients uuid[];
  shown_patients uuid[];
begin
  if actor_account is null or actor_membership is null or actor_facility is null or actor_correlation is null then
    raise exception using errcode = '42501', message = 'MY_ORDERS_NOT_PERMITTED';
  end if;
  select membership.organization_id into actor_organization
    from identity.staff_facility_memberships membership
   where membership.id = actor_membership and membership.account_id = actor_account
     and membership.facility_id = actor_facility and membership.active
     and membership.migration_hold_reason is null;
  if not found then
    raise exception using errcode = '42501', message = 'MY_ORDERS_NOT_PERMITTED';
  end if;
  if actor_purpose is distinct from 'direct-care' then
    raise exception using errcode = '22023', message = 'MY_ORDERS_DIRECT_CARE_ONLY';
  end if;
  if requested_kinds is null or cardinality(requested_kinds) not between 1 and 2
     or not (requested_kinds <@ array['lab_request', 'prescription'])
     or ('lab_request' = any (requested_kinds)
         and not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.lab-request.read'))
     or ('prescription' = any (requested_kinds)
         and not auth.membership_has_permission(actor_subject, actor_membership, actor_facility, 'ehr.prescription.read')) then
    raise exception using errcode = '42501', message = 'MY_ORDERS_NOT_PERMITTED';
  end if;
  if requested_since is null or requested_since > today or requested_since < (today - interval '2 years')::date then
    raise exception using errcode = '22023', message = 'MY_ORDERS_SINCE_TOO_OLD';
  end if;
  if (cursor_created_at is null) <> (cursor_id is null) or (cursor_created_at is null) <> (cursor_kind is null)
     or (cursor_kind is not null and cursor_kind not in ('lab_request', 'prescription')) then
    raise exception using errcode = '22023', message = 'MY_ORDERS_CURSOR_INVALID';
  end if;
  page_limit := least(greatest(coalesce(requested_limit, 25), 1), 50);
  since_start := requested_since::timestamp at time zone 'Africa/Lagos';

  -- The reach, then the session's own rule once per patient (may it read this
  -- patient's records now, for direct care?), then one page of the rest.
  with found as (
    select 'prescription'::text as kind, prescription.id as order_id, prescription.patient_id,
           prescription.created_at
      from ehr.prescriptions prescription
     where 'prescription' = any (requested_kinds)
       and prescription.facility_id = actor_facility and prescription.created_by_membership_id = actor_membership
       and prescription.status <> 'entered_in_error'
       and (prescription.status in ('draft', 'active', 'on_hold')
            or (not coalesce(requested_open_only, false) and prescription.created_at >= since_start))
    union all
    select 'lab_request'::text, lab.id, lab.patient_id, lab.created_at
      from ehr.lab_requests lab
     where 'lab_request' = any (requested_kinds)
       and lab.facility_id = actor_facility and lab.created_by_membership_id = actor_membership
       and lab.status <> 'entered_in_error'
       and (lab.status in ('draft', 'active', 'on_hold')
            or (not coalesce(requested_open_only, false) and lab.created_at >= since_start))
  ), access_rows as (
    select distinct_patient.patient_id,
           coalesce(ehr.context_allows(distinct_patient.patient_id, actor_facility, 'read_records'), false) as allowed
      from (select distinct found.patient_id from found) distinct_patient
  ), page as (
    select found.kind, found.order_id, found.patient_id, found.created_at
      from found join access_rows on access_rows.patient_id = found.patient_id and access_rows.allowed
     where cursor_created_at is null
        or (found.created_at, found.kind, found.order_id) < (cursor_created_at, cursor_kind, cursor_id)
     order by found.created_at desc, found.kind desc, found.order_id desc
     limit page_limit + 1
  )
  select (select count(*) from found join access_rows on access_rows.patient_id = found.patient_id
           where not access_rows.allowed),
         coalesce(array_agg(page.kind order by page.created_at desc, page.kind desc, page.order_id desc), array[]::text[]),
         coalesce(array_agg(page.order_id order by page.created_at desc, page.kind desc, page.order_id desc), array[]::uuid[]),
         coalesce(array_agg(page.patient_id order by page.created_at desc, page.kind desc, page.order_id desc), array[]::uuid[])
    into hidden, page_kinds, page_ids, page_patients
    from page;
  more := cardinality(page_ids) > page_limit;
  page_kinds := page_kinds[1:page_limit];
  page_ids := page_ids[1:page_limit];
  page_patients := page_patients[1:page_limit];
  select coalesce(array_agg(first_seen.patient_id order by first_seen.first_position), array[]::uuid[]) into shown_patients
    from (select listed.patient_id, min(listed.position) as first_position
            from unnest(page_patients) with ordinality listed(patient_id, position)
           group by listed.patient_id) first_seen;

  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  ) values (
    actor_correlation, 'staff', actor_subject, actor_account, actor_membership,
    actor_organization, actor_facility, null, 'ehr.my-orders.list', 'success',
    'my-orders', null, actor_purpose, 'application', 'ehr-api',
    jsonb_build_object('kinds', to_jsonb(requested_kinds), 'openOnly', coalesce(requested_open_only, false),
      'since', requested_since, 'paged', cursor_created_at is not null,
      'resultCount', cardinality(page_ids), 'hiddenCount', hidden, 'hasMore', more,
      'patientIds', to_jsonb(shown_patients))
  );
  insert into audit.events (
    correlation_id, actor_type, actor_subject, actor_account_id, actor_membership_id,
    organization_id, facility_id, patient_id, action, outcome, resource_type, resource_id,
    purpose_of_use, provenance, source_system, details
  )
  select actor_correlation, 'staff', actor_subject, actor_account, actor_membership,
         actor_organization, actor_facility, shown.patient_id, 'ehr.my-orders.list.shown', 'success',
         'my-orders', null, actor_purpose, 'application', 'ehr-api', '{}'::jsonb
    from unnest(shown_patients) with ordinality shown(patient_id, position)
   order by shown.position;

  if cardinality(page_ids) = 0 then
    -- An empty page still says how many matching orders are hidden: one row
    -- with no order in it (kind null).
    return query select null::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::date,
      null::text, null::text, null::text, null::text, null::timestamptz, null::timestamptz, hidden, false;
    return;
  end if;
  return query
    select listed.kind, listed_order.id, listed_order.encounter_id, listed_order.patient_id, patient.full_name,
           patient.gender, patient.dob, right(patient.hid_code, 4), listed_order.display, listed_order.status,
           listed_order.priority, listed_order.created_at, listed_order.updated_at, hidden, more
      from unnest(page_kinds, page_ids) with ordinality listed(kind, id, position)
      cross join lateral (
        select prescription.id, prescription.encounter_id, prescription.patient_id,
               prescription.medication_display as display, prescription.status, prescription.priority,
               prescription.created_at, prescription.updated_at
          from ehr.prescriptions prescription
         where listed.kind = 'prescription' and prescription.id = listed.id
        union all
        select lab.id, lab.encounter_id, lab.patient_id, lab.test_display, lab.status, lab.priority,
               lab.created_at, lab.updated_at
          from ehr.lab_requests lab
         where listed.kind = 'lab_request' and lab.id = listed.id
      ) listed_order
      join identity.patients patient on patient.id = listed_order.patient_id
     order by listed.position;
end
$$;
comment on function ehr.list_my_orders(text[], boolean, date, timestamptz, text, uuid, integer) is
  '0143 (MY-1): the lab requests and prescriptions this membership created at the session facility, never entered in error; open ones of any age and ended ones created on or after the Lagos day given (at most 2 years back); listed only while the session may read the patient''s records now for direct care (ehr.context_allows), the rest counted in hidden_count; newest first, keyset paged, 1-50 rows; the waiting-list card''s patient fields, never a full Health ID. Needs ehr.lab-request.read for lab rows and ehr.prescription.read for prescriptions. Audited: one ehr.my-orders.list row and one ehr.my-orders.list.shown row per patient shown.';
revoke all on function ehr.list_my_orders(text[], boolean, date, timestamptz, text, uuid, integer) from public;

-- 3. Grants (D3; here and in runtime-grants.sql).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'hid_ehr_runtime') then
    grant execute on function ehr.list_my_orders(text[], boolean, date, timestamptz, text, uuid, integer) to hid_ehr_runtime;
  end if;
end
$$;

-- 4. Post-checks.
do $$
begin
  if not exists (select 1 from pg_proc proc
                  where proc.oid = 'ehr.list_my_orders(text[],boolean,date,timestamp with time zone,text,uuid,integer)'::regprocedure
                    and proc.prosecdef and proc.proconfig = array['search_path=pg_catalog, pg_temp']) then
    raise exception using errcode = '55000', message = '0143: ehr.list_my_orders is not as created';
  end if;
  if exists (select 1 from pg_proc proc, aclexplode(proc.proacl) acl
              where proc.oid = 'ehr.list_my_orders(text[],boolean,date,timestamp with time zone,text,uuid,integer)'::regprocedure
                and acl.privilege_type = 'EXECUTE' and acl.grantee <> proc.proowner
                and acl.grantee not in (select oid from pg_roles where rolname = 'hid_ehr_runtime')) then
    raise exception using errcode = '55000', message = '0143: ehr.list_my_orders may be run by a role other than the EHR runtime';
  end if;
  if (select count(*) from pg_index index_row
       where index_row.indexrelid in ('ehr.prescriptions_my_orders_idx'::regclass, 'ehr.lab_requests_my_orders_idx'::regclass)
         and index_row.indisvalid) <> 2 then
    raise exception using errcode = '55000', message = '0143: the two indexes are not valid';
  end if;
  if exists (select 1 from pg_roles role_row
              where role_row.rolname in ('hid_ehr_runtime', 'hid_ehr_api_runtime', 'hid_identity_runtime',
                                         'hid_lab_runtime', 'hid_pharmacy_runtime', 'hid_ocr_runtime',
                                         'hid_outreach_runtime', 'hid_schema_test_runtime')
                and pg_has_role(role_row.oid, (select relation.relowner from pg_class relation
                                                where relation.oid = 'ehr.prescriptions'::regclass), 'USAGE')) then
    raise exception using errcode = '55000', message = '0143: a runtime role is a member of the order tables'' owner';
  end if;
end
$$;
