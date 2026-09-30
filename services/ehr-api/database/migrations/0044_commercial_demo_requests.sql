-- One governed intake for Health ID product demonstrations, including API interest.
-- Contact details remain inside the Identity-owned commercial boundary.

insert into auth.permissions (code, description) values
  ('platform.demo.read', 'Read commercial demonstration requests'),
  ('platform.demo.manage', 'Manage commercial demonstration request state')
on conflict (code) do update set description = excluded.description;

insert into auth.role_permissions (role_code, permission_code)
select role_code, permission_code from (values
  ('platform_admin', 'platform.demo.read'),
  ('platform_admin', 'platform.demo.manage'),
  ('platform_super_admin', 'platform.demo.read'),
  ('platform_super_admin', 'platform.demo.manage')
) as mapping(role_code, permission_code)
on conflict (role_code, permission_code) do nothing;

create table identity.demo_requests (
  id uuid primary key,
  idempotency_key_sha256 char(64) not null unique,
  contact_name text not null check (length(btrim(contact_name)) between 2 and 160),
  contact_email text not null check (length(btrim(contact_email)) between 3 and 254),
  contact_phone text check (contact_phone is null or length(btrim(contact_phone)) between 7 and 32),
  contact_role text check (contact_role is null or length(btrim(contact_role)) between 2 and 120),
  organization_name text check (organization_name is null or length(btrim(organization_name)) between 2 and 200),
  organization_type text check (organization_type is null or organization_type in
    ('clinic', 'hospital', 'laboratory', 'pharmacy', 'other')),
  product_code text not null check (product_code in
    ('ehr', 'migrate', 'laboratory', 'pharmacy', 'outreach', 'api', 'general')),
  message text check (message is null or length(btrim(message)) between 8 and 2000),
  source_page text check (source_page is null or length(btrim(source_page)) between 1 and 200),
  source_section text check (source_section is null or length(btrim(source_section)) between 1 and 120),
  cta_label text check (cta_label is null or length(btrim(cta_label)) between 1 and 120),
  status text not null default 'new' check (status in ('new', 'contacted', 'qualified', 'closed')),
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create index demo_requests_admin_queue_idx on identity.demo_requests
  (status, created_at desc, id);

create table identity.demo_request_events (
  sequence_id bigint generated always as identity primary key,
  request_id uuid not null references identity.demo_requests(id) on delete restrict,
  from_status text not null check (from_status in ('new', 'contacted', 'qualified', 'closed')),
  to_status text not null check (to_status in ('new', 'contacted', 'qualified', 'closed')),
  reason text not null check (length(btrim(reason)) between 8 and 500),
  actor_account_id uuid not null references auth.accounts(id) on delete restrict,
  correlation_id text not null check (length(correlation_id) between 8 and 128),
  occurred_at timestamptz not null default clock_timestamp()
);

create trigger demo_request_events_no_mutation
  before update or delete on identity.demo_request_events
  for each row execute function platform.reject_mutation();

alter table identity.demo_requests enable row level security;
alter table identity.demo_requests force row level security;
alter table identity.demo_request_events enable row level security;
alter table identity.demo_request_events force row level security;

create policy demo_requests_public_intake on identity.demo_requests
  for insert with check (platform.current_actor_subject() = 'system:auth');
create policy demo_requests_admin_read on identity.demo_requests
  for select using (auth.account_has_platform_permission(
    platform.current_account_id(), 'platform.demo.read'));
create policy demo_requests_admin_update on identity.demo_requests
  for update using (auth.account_has_platform_permission(
    platform.current_account_id(), 'platform.demo.manage'))
  with check (auth.account_has_platform_permission(
    platform.current_account_id(), 'platform.demo.manage'));

create policy demo_request_events_admin_read on identity.demo_request_events
  for select using (auth.account_has_platform_permission(
    platform.current_account_id(), 'platform.demo.read'));
create policy demo_request_events_admin_append on identity.demo_request_events
  for insert with check (auth.account_has_platform_permission(
    platform.current_account_id(), 'platform.demo.manage'));

revoke all on identity.demo_requests, identity.demo_request_events from public;
revoke all on sequence identity.demo_request_events_sequence_id_seq from public;
