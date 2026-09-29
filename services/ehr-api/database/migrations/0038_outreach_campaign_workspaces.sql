-- Outreach campaign/workspace lifecycle, adapted to HID's canonical staff identity model.
-- Campaign workers are existing facility staff memberships, not a second account system.

insert into auth.permissions (code, description) values
  ('outreach.campaign.read', 'Read facility-scoped Outreach campaigns and workspace membership'),
  ('outreach.campaign.write', 'Create and govern facility-scoped Outreach campaigns and workspace membership')
on conflict (code) do update set description = excluded.description;

insert into auth.role_permissions (role_code, permission_code)
select mapping.role_code, mapping.permission_code
from (values
  ('doctor','outreach.campaign.read'),('doctor','outreach.campaign.write'),
  ('clinician','outreach.campaign.read'),('clinician','outreach.campaign.write'),
  ('nurse','outreach.campaign.read'),('nurse','outreach.campaign.write'),
  ('receptionist','outreach.campaign.read'),('receptionist','outreach.campaign.write'),
  ('admin','outreach.campaign.read'),('admin','outreach.campaign.write'),
  ('org_admin','outreach.campaign.read'),('org_admin','outreach.campaign.write')
) as mapping(role_code, permission_code)
on conflict do nothing;

create table outreach.campaigns (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  created_by_account_id uuid not null references auth.accounts(id) on delete restrict,
  created_by_membership_id uuid not null,
  name text not null check (length(btrim(name)) between 2 and 200),
  services text[] not null default array['registration']::text[] check (
    cardinality(services) between 1 and 12
    and services <@ array['registration','vitals','vaccination','lab_sample','referral']::text[]
  ),
  status text not null default 'planned' check (status in ('planned','active','closed')),
  starts_at timestamptz not null,
  ends_at timestamptz,
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (created_by_membership_id, facility_id, created_by_account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  check (ends_at is null or ends_at > starts_at)
);
create index outreach_campaigns_facility_status_idx on outreach.campaigns(facility_id,status,starts_at desc,id);

create table outreach.campaign_members (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references outreach.campaigns(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  membership_id uuid not null,
  role text not null default 'enumerator' check (role in ('enumerator','health_worker','admin')),
  added_by_account_id uuid not null references auth.accounts(id) on delete restrict,
  added_by_membership_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (membership_id, facility_id) references identity.staff_facility_memberships(id, facility_id) on delete restrict,
  foreign key (added_by_membership_id, facility_id, added_by_account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict,
  unique(campaign_id,membership_id)
);
create index outreach_campaign_members_membership_idx on outreach.campaign_members(membership_id,created_at desc);

create table outreach.campaign_events (
  sequence_id bigint generated always as identity primary key,
  event_id uuid not null unique default gen_random_uuid(),
  campaign_id uuid not null references outreach.campaigns(id) on delete restrict,
  facility_id uuid not null references identity.facilities(id) on delete restrict,
  event_type text not null check (event_type in ('campaign_created','campaign_status_changed','campaign_member_added','campaign_member_removed')),
  actor_account_id uuid not null references auth.accounts(id) on delete restrict,
  actor_membership_id uuid not null,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details)='object'),
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  occurred_at timestamptz not null default clock_timestamp(),
  foreign key (actor_membership_id, facility_id, actor_account_id)
    references identity.staff_facility_memberships(id, facility_id, account_id) on delete restrict
);
create index outreach_campaign_events_idx on outreach.campaign_events(campaign_id,sequence_id);

create trigger outreach_campaign_events_no_mutation
before update or delete on outreach.campaign_events for each row execute function platform.reject_mutation();

alter table outreach.campaigns enable row level security;
alter table outreach.campaigns force row level security;
alter table outreach.campaign_members enable row level security;
alter table outreach.campaign_members force row level security;
alter table outreach.campaign_events enable row level security;
alter table outreach.campaign_events force row level security;

create policy outreach_campaigns_read on outreach.campaigns
for select using (outreach.context_allows(facility_id,'outreach.campaign.read'));
create policy outreach_campaigns_create on outreach.campaigns
for insert with check (
  outreach.context_allows(facility_id,'outreach.campaign.write')
  and created_by_account_id = platform.current_account_id()
  and created_by_membership_id = platform.current_membership_id()
);
create policy outreach_campaigns_update on outreach.campaigns
for update using (outreach.context_allows(facility_id,'outreach.campaign.write'))
with check (outreach.context_allows(facility_id,'outreach.campaign.write'));

create policy outreach_campaign_members_read on outreach.campaign_members
for select using (outreach.context_allows(facility_id,'outreach.campaign.read'));
create policy outreach_campaign_members_create on outreach.campaign_members
for insert with check (
  outreach.context_allows(facility_id,'outreach.campaign.write')
  and added_by_account_id = platform.current_account_id()
  and added_by_membership_id = platform.current_membership_id()
);
create policy outreach_campaign_members_delete on outreach.campaign_members
for delete using (outreach.context_allows(facility_id,'outreach.campaign.write'));

create policy outreach_campaign_events_read on outreach.campaign_events
for select using (outreach.context_allows(facility_id,'outreach.campaign.read'));
create policy outreach_campaign_events_create on outreach.campaign_events
for insert with check (
  outreach.context_allows(facility_id,'outreach.campaign.write')
  and actor_account_id = platform.current_account_id()
  and actor_membership_id = platform.current_membership_id()
);

create trigger outreach_campaigns_no_delete before delete on outreach.campaigns
for each row execute function platform.reject_mutation();
create trigger outreach_campaign_members_no_update before update on outreach.campaign_members
for each row execute function platform.reject_mutation();

create or replace function outreach.validate_campaign_write()
returns trigger language plpgsql security definer
set search_path = pg_catalog,platform,auth,identity,outreach
as $$
begin
  if new.facility_id <> platform.current_facility_id()
     or new.created_by_account_id <> platform.current_account_id()
     or new.created_by_membership_id <> platform.current_membership_id() and tg_op='INSERT' then
    raise exception using errcode='42501',message='Valid Outreach campaign context is required';
  end if;
  if tg_op='UPDATE' then
    if old.id <> new.id or old.facility_id <> new.facility_id or old.created_by_account_id <> new.created_by_account_id
       or old.created_by_membership_id <> new.created_by_membership_id or old.created_at <> new.created_at
       or new.row_version <> old.row_version + 1 then
      raise exception using errcode='55000',message='Outreach campaign history cannot be overwritten';
    end if;
    new.updated_at := clock_timestamp();
  end if;
  return new;
end $$;
create trigger outreach_campaign_validate before insert or update on outreach.campaigns
for each row execute function outreach.validate_campaign_write();

revoke all on function outreach.validate_campaign_write() from public;
alter default privileges in schema outreach revoke all on tables from public;
alter default privileges in schema outreach revoke all on sequences from public;
alter default privileges in schema outreach revoke all on functions from public;

comment on table outreach.campaigns is 'Facility-scoped Outreach workspace; canonical staff identity remains in Identity.';
comment on table outreach.campaign_members is 'Campaign membership binds existing facility staff memberships to an Outreach workspace.';
