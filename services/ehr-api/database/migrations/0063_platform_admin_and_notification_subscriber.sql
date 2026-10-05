-- Platform administrators are account-scoped and can operate without a
-- workforce facility. Their administrative actions remain attributable to the
-- account while retaining the stricter membership tuple for all other staff
-- activity.
do $$
declare
  facility_context_constraint text;
  staff_context_constraint text;
begin
  select constraint_row.conname into facility_context_constraint
    from pg_constraint constraint_row
   where constraint_row.conrelid = 'audit.events'::regclass
     and constraint_row.contype = 'c'
     and pg_get_constraintdef(constraint_row.oid) like '%facility_id%'
     and pg_get_constraintdef(constraint_row.oid) like '%resource_type%'
     and pg_get_constraintdef(constraint_row.oid) like '%authentication%'
   order by constraint_row.conname
   limit 1;
  if facility_context_constraint is null then
    raise exception 'Expected audit facility-context constraint is missing';
  end if;
  execute format('alter table audit.events drop constraint %I', facility_context_constraint);

  select constraint_row.conname into staff_context_constraint
    from pg_constraint constraint_row
   where constraint_row.conrelid = 'audit.events'::regclass
     and constraint_row.contype = 'c'
     and pg_get_constraintdef(constraint_row.oid) like '%actor_membership_id%'
     and pg_get_constraintdef(constraint_row.oid) like '%actor_account_id%'
     and pg_get_constraintdef(constraint_row.oid) like '%action%'
   order by constraint_row.conname
   limit 1;
  if staff_context_constraint is null then
    raise exception 'Expected audit staff-actor constraint is missing';
  end if;
  execute format('alter table audit.events drop constraint %I', staff_context_constraint);
end
$$;

alter table audit.events
  add constraint audit_events_facility_context_check check (
    facility_id is not null
    or actor_type in ('patient', 'workload', 'system', 'legacy')
    or (
      actor_type = 'staff'
      and (
        (action like 'auth.%' and resource_type in ('authentication', 'session'))
        or action like 'admin.%'
        or action like 'api.admin.%'
      )
    )
  ),
  add constraint audit_events_staff_actor_context_check check (
    actor_type <> 'staff'
    or action like 'auth.%'
    or (
      (action like 'admin.%' or action like 'api.admin.%')
      and actor_account_id is not null
      and actor_membership_id is null
      and facility_id is null
    )
    or (actor_account_id is not null and actor_membership_id is not null and facility_id is not null)
  );

-- The notification worker may read only the verified account email needed to
-- synchronize a Novu subscriber. It cannot read patient ciphertext or general
-- Identity tables.
create or replace function notification.verified_patient_email(requested_patient_id uuid)
returns text
language sql
stable
strict
security definer
set search_path = pg_catalog, identity, auth, pg_temp
as $$
  select account.email
  from identity.patients patient
  join auth.accounts account on account.id = patient.account_id
  where patient.id = requested_patient_id
    and patient.status = 'active'
    and account.status = 'active'
    and account.email is not null
    and account.email_verified_at is not null
  limit 1
$$;

revoke all on function notification.verified_patient_email(uuid) from public;
