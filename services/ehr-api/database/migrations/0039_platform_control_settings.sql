insert into auth.permissions(code,description) values
 ('platform.control.read','Read platform runtime controls'),
 ('platform.control.manage','Change platform runtime controls')
on conflict(code) do update set description=excluded.description;

insert into auth.role_permissions(role_code,permission_code)
select r.role_code,r.permission_code from (values
 ('platform_super_admin','platform.control.read'),('platform_super_admin','platform.control.manage'),
 ('platform_operations_admin','platform.control.read'),('platform_operations_admin','platform.control.manage')
) r(role_code,permission_code) on conflict do nothing;

create table platform.control_settings (
  control_key text primary key check (control_key in (
    'patient_portal_enabled','provider_portal_enabled','outreach_portal_enabled',
    'maintenance_mode','uploads_enabled','break_glass_enabled'
  )),
  enabled boolean not null,
  reason text not null check (length(btrim(reason)) between 8 and 500),
  row_version bigint not null default 1 check (row_version > 0),
  updated_by uuid references auth.accounts(id) on delete restrict,
  updated_at timestamptz not null default clock_timestamp()
);

insert into platform.control_settings(control_key,enabled,reason,updated_by)
select key,
       case when key = 'maintenance_mode' then false else true end,
       'Initial platform control state',
       null
from (values
  ('patient_portal_enabled'),('provider_portal_enabled'),('outreach_portal_enabled'),
  ('maintenance_mode'),('uploads_enabled'),('break_glass_enabled')
 ) v(key)
on conflict do nothing;

alter table platform.control_settings enable row level security;
alter table platform.control_settings force row level security;

create policy platform_controls_read on platform.control_settings
for select using (auth.account_has_platform_permission(platform.current_account_id(),'platform.control.read'));
create policy platform_controls_update on platform.control_settings
for update using (auth.account_has_platform_permission(platform.current_account_id(),'platform.control.manage'))
with check (auth.account_has_platform_permission(platform.current_account_id(),'platform.control.manage'));

create table platform.control_events (
  sequence_id bigint generated always as identity primary key,
  event_id uuid not null unique default gen_random_uuid(),
  control_key text not null references platform.control_settings(control_key),
  previous_enabled boolean not null,
  enabled boolean not null,
  reason text not null,
  actor_account_id uuid not null references auth.accounts(id),
  correlation_id text not null,
  occurred_at timestamptz not null default clock_timestamp()
);
create index platform_control_events_idx on platform.control_events(sequence_id desc);
create trigger platform_control_events_no_mutation before update or delete on platform.control_events
for each row execute function platform.reject_mutation();

create or replace function platform.admin_list_controls()
returns table(control_key text, enabled boolean, reason text, row_version bigint, updated_at timestamptz)
language plpgsql stable security definer
set search_path=platform,auth,pg_temp
as $$
begin
 if not auth.account_has_platform_permission(platform.current_account_id(),'platform.control.read') then
   raise exception using errcode='42501',message='ADMIN_PERMISSION_DENIED';
 end if;
 return query select c.control_key,c.enabled,c.reason,c.row_version,c.updated_at
 from platform.control_settings c order by c.control_key;
end $$;

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
 if requested_key not in ('patient_portal_enabled','provider_portal_enabled','outreach_portal_enabled','maintenance_mode','uploads_enabled','break_glass_enabled')
    or requested_reason is null or length(btrim(requested_reason))<8 then
   raise exception using errcode='22023',message='ADMIN_INVALID_CONTROL';
 end if;
 select * into current_row from platform.control_settings where control_key=requested_key for update;
 if current_row.row_version<>expected_version then
   raise exception using errcode='40001',message='ADMIN_VERSION_CONFLICT';
 end if;
 if current_row.enabled=requested_enabled then
   return query select current_row.control_key,current_row.enabled,current_row.row_version,true; return;
 end if;
 update platform.control_settings set enabled=requested_enabled,reason=btrim(requested_reason),
   row_version=row_version+1,updated_by=actor,updated_at=clock_timestamp()
 where control_key=requested_key returning * into current_row;
 insert into platform.control_events(control_key,previous_enabled,enabled,reason,actor_account_id,correlation_id)
 values(current_row.control_key,not current_row.enabled,current_row.enabled,current_row.reason,actor,platform.current_correlation_id());
 return query select current_row.control_key,current_row.enabled,current_row.row_version,false;
end $$;

revoke all on table platform.control_settings, platform.control_events from public;
revoke all on function platform.admin_list_controls() from public;
revoke all on function platform.admin_set_control(text,boolean,bigint,text) from public;
