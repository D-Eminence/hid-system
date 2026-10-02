-- Associate optional field-registration intake with an active Outreach campaign.
-- Existing facility-only registrations remain valid and visible under their
-- existing facility authorization; linked cases require exact workspace membership.

alter table outreach.campaigns
  add constraint outreach_campaigns_id_facility_key unique (id, facility_id);

alter table outreach.campaign_members
  add constraint outreach_campaign_members_campaign_facility_fk
  foreign key (campaign_id, facility_id)
  references outreach.campaigns (id, facility_id) on delete restrict;

alter table outreach.registration_cases
  add column campaign_id uuid,
  add constraint outreach_registration_cases_campaign_facility_fk
  foreign key (campaign_id, facility_id)
  references outreach.campaigns (id, facility_id) on delete restrict;

create index outreach_registration_cases_campaign_created_idx
  on outreach.registration_cases (campaign_id, created_at desc, id)
  where campaign_id is not null;

-- A campaign creator needs a membership before they can record a registration.
-- The accepted campaign migration predates that invariant, so seed its creators.
alter table outreach.campaign_members no force row level security;
alter table outreach.campaigns no force row level security;
insert into outreach.campaign_members (
  campaign_id, facility_id, membership_id, role,
  added_by_account_id, added_by_membership_id
)
select id, facility_id, created_by_membership_id, 'admin',
  created_by_account_id, created_by_membership_id
from outreach.campaigns
on conflict (campaign_id, membership_id) do nothing;
alter table outreach.campaigns force row level security;
alter table outreach.campaign_members force row level security;

create or replace function outreach.registration_campaign_member(
  registration_campaign_id uuid, registration_facility_id uuid
)
returns boolean
language sql stable security definer
set search_path = pg_catalog, platform, auth, identity, outreach
as $$
  select registration_campaign_id is null or exists (
    select 1 from outreach.campaign_members member
    where member.campaign_id = registration_campaign_id
      and member.facility_id = registration_facility_id
      and member.membership_id = platform.current_membership_id()
  )
$$;

revoke all on function outreach.registration_campaign_member(uuid, uuid) from public;

create policy outreach_registration_campaign_read on outreach.registration_cases
  as restrictive for select
  using (outreach.registration_campaign_member(campaign_id, facility_id));
create policy outreach_registration_campaign_create on outreach.registration_cases
  as restrictive for insert
  with check (outreach.registration_campaign_member(campaign_id, facility_id));
create policy outreach_registration_campaign_resolve on outreach.registration_cases
  as restrictive for update
  using (outreach.registration_campaign_member(campaign_id, facility_id))
  with check (outreach.registration_campaign_member(campaign_id, facility_id));

create or replace function outreach.validate_registration_campaign_write()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, platform, auth, identity, outreach
as $$
declare
  campaign_status text;
  campaign_services text[];
  campaign_starts_at timestamptz;
  campaign_ends_at timestamptz;
begin
  if tg_op = 'UPDATE' and new.campaign_id is distinct from old.campaign_id then
    raise exception using errcode = '55000',
      message = 'Outreach registration campaign association cannot be overwritten';
  end if;
  if new.campaign_id is null then return new; end if;

  -- Row locks serialize capture with campaign close and membership removal.
  select campaign.status, campaign.services, campaign.starts_at, campaign.ends_at
    into campaign_status, campaign_services, campaign_starts_at, campaign_ends_at
  from outreach.campaigns campaign
  join outreach.campaign_members member
    on member.campaign_id = campaign.id
   and member.facility_id = campaign.facility_id
   and member.membership_id = platform.current_membership_id()
  where campaign.id = new.campaign_id and campaign.facility_id = new.facility_id
  for share of campaign, member;
  if not found then
    raise exception using errcode = '42501',
      message = 'Exact Outreach campaign membership is required';
  end if;

  if tg_op = 'INSERT' and (
    campaign_status <> 'active'
    or not ('registration' = any(campaign_services))
    or campaign_starts_at > clock_timestamp()
    or (campaign_ends_at is not null and campaign_ends_at <= clock_timestamp())
  ) then
    raise exception using errcode = '23514',
      message = 'Outreach campaign is not accepting registrations';
  end if;
  return new;
end
$$;

create trigger outreach_registration_campaign_validate
  before insert or update on outreach.registration_cases
  for each row execute function outreach.validate_registration_campaign_write();
revoke all on function outreach.validate_registration_campaign_write() from public;

-- The accepted campaign trigger accidentally compares the creator with the
-- current actor on UPDATE. Preserve immutable authorship while allowing an
-- authorized campaign manager to change status.
create or replace function outreach.validate_campaign_write()
returns trigger language plpgsql security definer
set search_path = pg_catalog, platform, auth, identity, outreach
as $$
begin
  if new.facility_id <> platform.current_facility_id() then
    raise exception using errcode='42501',message='Valid Outreach campaign context is required';
  end if;
  if tg_op = 'INSERT' then
    if new.created_by_account_id <> platform.current_account_id()
       or new.created_by_membership_id <> platform.current_membership_id() then
      raise exception using errcode='42501',message='Valid Outreach campaign creator is required';
    end if;
  else
    if old.id <> new.id or old.facility_id <> new.facility_id
       or old.created_by_account_id <> new.created_by_account_id
       or old.created_by_membership_id <> new.created_by_membership_id
       or old.created_at <> new.created_at
       or new.row_version <> old.row_version + 1 then
      raise exception using errcode='55000',message='Outreach campaign history cannot be overwritten';
    end if;
    new.updated_at := clock_timestamp();
  end if;
  return new;
end $$;

comment on column outreach.registration_cases.campaign_id is
  'Optional campaign association. Campaign-linked capture requires an active registration service and exact staff workspace membership.';
