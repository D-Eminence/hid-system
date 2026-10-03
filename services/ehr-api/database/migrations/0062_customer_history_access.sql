-- Additive historical access. Import is owner-only; no fabricated clinical care,
-- delivery events, provider approval or elevated legacy permissions.
create table ehr.imported_patient_health_profiles (
  patient_id uuid primary key references identity.patients(id) on delete restrict,
  source_run_id uuid not null references migration.runs(id) on delete restrict,
  clinical_payload jsonb not null check (jsonb_typeof(clinical_payload)='object'),
  source_sha256 char(64) not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_updated_at timestamptz not null,
  imported_at timestamptz not null default clock_timestamp()
);

alter table ehr.imported_medical_record_files add unique(id,patient_id);
create table ehr.imported_attachment_bindings (
  file_id uuid primary key,
  patient_id uuid not null,
  storage_bucket text not null,
  storage_key text not null check (storage_key like 'migration-quarantine/%/medical-files/%'),
  object_version_id text not null check (length(object_version_id)>0 and object_version_id<>'null'),
  sha256_hex char(64) not null check (sha256_hex ~ '^[a-f0-9]{64}$'),
  size_bytes bigint not null check (size_bytes between 1 and 20971520),
  manifest_sha256 char(64) not null check (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  manifest_version_id text not null,
  foreign key(file_id,patient_id) references ehr.imported_medical_record_files(id,patient_id) on delete restrict,
  unique(storage_bucket,storage_key,object_version_id),
  unique(file_id,patient_id,sha256_hex,object_version_id)
);
create table ehr.imported_attachment_scan_events (
  sequence_id bigint generated always as identity primary key,
  id uuid not null unique,
  file_id uuid not null,
  patient_id uuid not null,
  sha256_hex char(64) not null,
  object_version_id text not null,
  result text not null check (result in ('clean','infected','error')),
  detected_media_type text not null,
  scanner text not null check(scanner='clamav'),
  scanner_version text not null,
  signatures_version text not null,
  signatures_updated_at timestamptz not null,
  scanned_at timestamptz not null,
  report_sha256 char(64) not null check(report_sha256 ~ '^[a-f0-9]{64}$'),
  recorded_by text not null,
  foreign key(file_id,patient_id,sha256_hex,object_version_id)
    references ehr.imported_attachment_bindings(file_id,patient_id,sha256_hex,object_version_id) on delete restrict,
  check(signatures_updated_at<=scanned_at and scanned_at-signatures_updated_at<=interval '24 hours')
);
create index imported_attachment_latest_scan on ehr.imported_attachment_scan_events(file_id,sequence_id desc);

do $$ declare table_name text; begin
  foreach table_name in array array['imported_patient_health_profiles','imported_attachment_bindings','imported_attachment_scan_events'] loop
    execute format('alter table ehr.%I enable row level security',table_name);
    execute format('alter table ehr.%I force row level security',table_name);
    execute format('create policy imported_customer_read on ehr.%I for select using (ehr.imported_record_read_context(patient_id))',table_name);
    execute format('create policy imported_customer_owner on ehr.%I for all using (current_user=%L) with check(current_user=%L)',table_name,current_user,current_user);
    execute format('create trigger imported_customer_no_mutation before update or delete on ehr.%I for each row execute function platform.reject_mutation()',table_name);
    execute format('revoke all on ehr.%I from public',table_name);
  end loop;
end $$;

-- Historical text has a separate private representation. Native operational
-- notifications retain their existing non-PHI/code-only contract. No enqueue,
-- outbox or delivery trigger is attached to these imported rows.
create table notification.imported_inbox_items (
  id uuid primary key,
  account_id uuid not null references auth.accounts(id) on delete restrict,
  patient_id uuid references identity.patients(id) on delete restrict,
  source_run_id uuid not null references migration.runs(id) on delete restrict,
  title text not null,
  message text not null,
  notification_type text not null,
  source_read_at timestamptz,
  source_created_at timestamptz not null,
  source_payload jsonb not null,
  source_sha256 char(64) not null check(source_sha256 ~ '^[a-f0-9]{64}$')
);
create index imported_inbox_recipient on notification.imported_inbox_items(account_id,source_created_at desc,id);
create table notification.imported_inbox_reads (
  item_id uuid primary key references notification.imported_inbox_items(id) on delete restrict,
  account_id uuid not null references auth.accounts(id) on delete restrict,
  read_at timestamptz not null default clock_timestamp()
);
alter table notification.imported_inbox_items enable row level security;
alter table notification.imported_inbox_items force row level security;
alter table notification.imported_inbox_reads enable row level security;
alter table notification.imported_inbox_reads force row level security;
create policy imported_inbox_self on notification.imported_inbox_items for select using(account_id=platform.current_account_id());
create policy imported_inbox_reads_self on notification.imported_inbox_reads for select using(account_id=platform.current_account_id());
create policy imported_inbox_reads_insert on notification.imported_inbox_reads for insert with check (
  account_id=platform.current_account_id() and exists(select 1 from notification.imported_inbox_items i
    where i.id=item_id and i.account_id=notification.imported_inbox_reads.account_id));
do $$ begin
  execute format('create policy imported_inbox_owner on notification.imported_inbox_items for all using(current_user=%L) with check(current_user=%L)',current_user,current_user);
end $$;
create trigger imported_inbox_no_mutation before update or delete on notification.imported_inbox_items
for each row execute function platform.reject_mutation();
create trigger imported_inbox_reads_no_mutation before update or delete on notification.imported_inbox_reads
for each row execute function platform.reject_mutation();
revoke all on notification.imported_inbox_items,notification.imported_inbox_reads from public;

create function identity.list_my_imported_notifications(requested_limit integer default 50, requested_offset integer default 0)
returns table(id uuid,title text,message text,notification_type text,read_at timestamptz,created_at timestamptz)
language plpgsql stable security definer set search_path=pg_catalog,notification,platform,pg_temp as $$
declare actor uuid:=platform.current_account_id(); begin
  if actor is null then raise exception using errcode='42501',message='SESSION_REQUIRED'; end if;
  return query select i.id,i.title,i.message,i.notification_type,coalesce(i.source_read_at,r.read_at),i.source_created_at
    from notification.imported_inbox_items i left join notification.imported_inbox_reads r on r.item_id=i.id and r.account_id=actor
    where i.account_id=actor order by i.source_created_at desc,i.id desc
    limit least(greatest(coalesce(requested_limit,50),1),100) offset greatest(coalesce(requested_offset,0),0);
end $$;
create function identity.mark_my_imported_notification_read(requested_id uuid)
returns table(id uuid,read_at timestamptz)
language plpgsql security definer set search_path=pg_catalog,notification,platform,pg_temp as $$
declare actor uuid:=platform.current_account_id(); begin
  if actor is null then raise exception using errcode='42501',message='SESSION_REQUIRED'; end if;
  if not exists(select 1 from notification.imported_inbox_items i where i.id=requested_id and i.account_id=actor) then
    raise exception using errcode='P0002',message='NOTIFICATION_NOT_FOUND'; end if;
  insert into notification.imported_inbox_reads(item_id,account_id) values(requested_id,actor) on conflict(item_id) do nothing;
  return query select i.id,coalesce(i.source_read_at,r.read_at) from notification.imported_inbox_items i
    join notification.imported_inbox_reads r on r.item_id=i.id and r.account_id=actor where i.id=requested_id and i.account_id=actor;
end $$;
revoke all on function identity.list_my_imported_notifications(integer,integer),identity.mark_my_imported_notification_read(uuid) from public;

-- Exact source configuration, retained for explicit reviewed mapping. No source
-- JSON is executable and no legacy AI route can enable a model or provider.
create table platform.imported_customer_configuration (
  category text not null check(category in ('commercial_products','commercial_prices','platform_billing_settings','platform_controls','staff_role_policies','ai_workload_routes')),
  source_pk text not null,
  source_run_id uuid not null references migration.runs(id) on delete restrict,
  source_payload jsonb not null check(jsonb_typeof(source_payload)='object'),
  source_sha256 char(64) not null check(source_sha256 ~ '^[a-f0-9]{64}$'),
  disposition text not null check(disposition in ('mapped','retained-pending-activation')),
  target_reference text,
  primary key(category,source_pk)
);
alter table platform.imported_customer_configuration enable row level security;
alter table platform.imported_customer_configuration force row level security;
create policy imported_configuration_admin on platform.imported_customer_configuration for select
using(auth.account_has_platform_permission(platform.current_account_id(),'platform.admin.access') and
  auth.account_has_platform_permission(platform.current_account_id(),case
    when category in ('commercial_products','commercial_prices','platform_billing_settings') then 'platform.pricing.read'
    when category='platform_controls' then 'platform.control.read'
    when category='staff_role_policies' then 'platform.role.manage'
    else 'platform.integration.read' end));
do $$ begin
  execute format('create policy imported_configuration_owner on platform.imported_customer_configuration for all using(current_user=%L) with check(current_user=%L)',current_user,current_user);
end $$;
create trigger imported_configuration_no_mutation before update or delete on platform.imported_customer_configuration
for each row execute function platform.reject_mutation();
revoke all on platform.imported_customer_configuration from public;

-- Separate append-only activation evidence permits preservation first, followed
-- by reviewed field mappings without mutating the original configuration.
create table platform.imported_configuration_mappings (
  category text not null,
  source_pk text not null,
  mapping_sha256 char(64) not null check(mapping_sha256 ~ '^[a-f0-9]{64}$'),
  target_reference text not null,
  approved_by text not null,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key(category,source_pk),
  foreign key(category,source_pk) references platform.imported_customer_configuration(category,source_pk)
);
alter table platform.imported_configuration_mappings enable row level security;
alter table platform.imported_configuration_mappings force row level security;
do $$ begin
  execute format('create policy imported_mapping_owner on platform.imported_configuration_mappings for all using(current_user=%L) with check(current_user=%L)',current_user,current_user);
end $$;
create trigger imported_mapping_no_mutation before update or delete on platform.imported_configuration_mappings
for each row execute function platform.reject_mutation();
revoke all on platform.imported_configuration_mappings from public;

-- The view exposes only the agreed configuration field allowlists. Full source
-- JSON stays owner-only; model/provider identifiers are provenance, not approval.
create function platform.admin_imported_customer_configuration()
returns table(category text,source_pk text,disposition text,target_reference text,value jsonb)
language sql stable security definer set search_path=pg_catalog,platform,auth,pg_temp as $$
  select c.category,c.source_pk,case when m.source_pk is null then c.disposition else 'mapped-target-fields' end,
    coalesce(m.target_reference,c.target_reference),
    (select coalesce(jsonb_object_agg(e.key,e.value),'{}'::jsonb) from jsonb_each(c.source_payload) e where e.key=any(case c.category
      when 'commercial_products' then array['slug','name','description','status','available_standalone','available_addon','public_visible','trial_eligible','subscription_type','default_billing_cycle','setup_fee_minor','currency','display_order']
      when 'commercial_prices' then array['product_id','context','visibility','amount_minor','currency','billing_period','unit','active']
      when 'platform_billing_settings' then array['default_currency','default_trial_days','grace_period_days','proration_enabled','late_fee_minor','restriction_policy']
      when 'platform_controls' then array['maintenance_mode','patient_signup_enabled','hospital_signup_enabled','patient_portal_enabled','hospital_portal_enabled','break_glass_enabled','uploads_enabled','outreach_signup_enabled','outreach_portal_enabled','migrate_portal_enabled']
      when 'staff_role_policies' then array['role','can_open_dashboard','can_use_standard_access','can_view_patient_records','can_create_records','can_use_break_glass','can_view_history']
      else array['workload','processing_strategy','primary_model_id','fallback_model_id','configuration_version'] end))
  from platform.imported_customer_configuration c
  left join platform.imported_configuration_mappings m on m.category=c.category and m.source_pk=c.source_pk
  where auth.account_has_platform_permission(platform.current_account_id(),'platform.admin.access')
    and auth.account_has_platform_permission(platform.current_account_id(),case
      when c.category in ('commercial_products','commercial_prices','platform_billing_settings') then 'platform.pricing.read'
      when c.category='platform_controls' then 'platform.control.read'
      when c.category='staff_role_policies' then 'platform.role.manage' else 'platform.integration.read' end)
  order by c.category,c.source_pk
$$;
revoke all on function platform.admin_imported_customer_configuration() from public;

create table migration.customer_table_dispositions (
  run_id uuid not null references migration.runs(id) on delete restrict,
  source_table text not null check(source_table ~ '^public\.hid_[a-z_]+$'),
  source_count bigint not null check(source_count>=0),
  source_checksum_sha256 char(64) not null check(source_checksum_sha256 ~ '^[a-f0-9]{64}$'),
  disposition text not null check(disposition in ('canonical','imported-history','mapped-configuration','retained-pending-activation','expired-no-replay','excluded-invalid-outreach')),
  primary key(run_id,source_table)
);
create trigger customer_dispositions_no_mutation before update or delete on migration.customer_table_dispositions
for each row execute function platform.reject_mutation();
revoke all on migration.customer_table_dispositions from public;
