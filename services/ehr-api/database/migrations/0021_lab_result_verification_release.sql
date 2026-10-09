-- Exact-version manual verification and explicit release/attestation for Lab results.
-- No analyzer, QC, calibration, critical-notification, or cryptographic-signature claim.
-- Applied migrations 0001 through 0020 remain immutable.
insert into auth.permissions(code,description) values
 ('lab.result.verify','Manually verify an exact unverified Lab result version'),
 ('lab.result.release','Explicitly attest and release an exact verified Lab result version'),
 ('lab.result.revise-released','Create a correction or amendment after release'),
 ('lab.result.entered-in-error','Mark an exact Lab result version entered in error');
insert into auth.permissions(code,description) values ('lab.result.released.read','Read current released Lab result truth');
insert into auth.role_permissions(role_code,permission_code)
select role_code,permission_code from (values
 ('lab','lab.result.verify'),('lab','lab.result.release'),('lab','lab.result.revise-released'),('lab','lab.result.entered-in-error')
) mapping(role_code,permission_code);
insert into auth.role_permissions(role_code,permission_code) values
 ('doctor','lab.result.released.read'),('clinician','lab.result.released.read'),('nurse','lab.result.released.read'),
 ('lab','lab.result.released.read'),('admin','lab.result.released.read');

alter table lab.result_revisions add column revision_kind text;
alter table lab.result_revisions add column supersedes_version bigint;
update lab.result_revisions set revision_kind=case when version=1 then 'original' else 'correction' end,
 supersedes_version=case when version=1 then null else version-1 end;
alter table lab.result_revisions alter column revision_kind set not null;
alter table lab.result_revisions add constraint result_revision_kind_check check(revision_kind in ('original','correction','amendment'));
alter table lab.result_revisions add constraint result_revision_supersession_check check(
 (version=1 and revision_kind='original' and supersedes_version is null) or
 (version>1 and revision_kind in ('correction','amendment') and supersedes_version=version-1));

create table lab.result_verifications (
 id uuid primary key default gen_random_uuid(),result_id uuid not null,execution_id uuid not null,patient_id uuid not null,facility_id uuid not null,
 result_version bigint not null check(result_version>0),method text not null default 'manual' check(method='manual'),
 verified_by uuid not null,verified_by_membership_id uuid not null,verified_at timestamptz not null,
 reason text not null check(length(btrim(reason)) between 3 and 500),idempotency_key text not null,
 request_sha256 char(64) not null check(request_sha256~'^[0-9a-f]{64}$'),correlation_id text not null,
 foreign key(result_id,execution_id,patient_id,facility_id) references lab.results(id,execution_id,patient_id,facility_id),
 foreign key(verified_by_membership_id,facility_id,verified_by) references identity.staff_facility_memberships(id,facility_id,account_id),
 unique(result_id,result_version),unique(facility_id,verified_by,idempotency_key),unique(id,result_id,result_version,patient_id,facility_id)
);
create table lab.result_releases (
 id uuid primary key default gen_random_uuid(),verification_id uuid not null,result_id uuid not null,execution_id uuid not null,
 patient_id uuid not null,facility_id uuid not null,result_version bigint not null,
 attestation_method text not null default 'authenticated_manual_approval' check(attestation_method='authenticated_manual_approval'),
 released_by uuid not null,released_by_membership_id uuid not null,released_at timestamptz not null,
 reason text not null check(length(btrim(reason)) between 3 and 500),idempotency_key text not null,
 request_sha256 char(64) not null check(request_sha256~'^[0-9a-f]{64}$'),correlation_id text not null,
 foreign key(verification_id,result_id,result_version,patient_id,facility_id)
  references lab.result_verifications(id,result_id,result_version,patient_id,facility_id),
 foreign key(result_id,execution_id,patient_id,facility_id) references lab.results(id,execution_id,patient_id,facility_id),
 foreign key(released_by_membership_id,facility_id,released_by) references identity.staff_facility_memberships(id,facility_id,account_id),
 unique(result_id,result_version),unique(facility_id,released_by,idempotency_key)
);
create table lab.result_invalidations (
 id uuid primary key default gen_random_uuid(),result_id uuid not null,execution_id uuid not null,patient_id uuid not null,facility_id uuid not null,
 result_version bigint not null,disposition text not null check(disposition='entered_in_error'),actor_id uuid not null,actor_membership_id uuid not null,
 reason text not null check(length(btrim(reason)) between 8 and 500),idempotency_key text not null,request_sha256 char(64) not null,
 correlation_id text not null,occurred_at timestamptz not null default clock_timestamp(),
 foreign key(result_id,execution_id,patient_id,facility_id) references lab.results(id,execution_id,patient_id,facility_id),
 foreign key(actor_membership_id,facility_id,actor_id) references identity.staff_facility_memberships(id,facility_id,account_id),
 unique(result_id,result_version),unique(facility_id,actor_id,idempotency_key)
);

alter table lab.outbox_events drop constraint outbox_events_event_type_check;
alter table lab.outbox_events add constraint outbox_events_event_type_check check(event_type in
 ('LabImportedEvidenceCreated','LabImportedEvidenceAmended','LabWorkItemCreated','LabAccessionCreated','LabSpecimenCollected',
 'LabSpecimenReceived','LabSpecimenRejected','LabTestExecutionStarted','LabTestExecutionCompleted','LabResultEntered',
 'LabResultCorrected','LabResultVerified','LabResultReleased','LabResultAmended','LabResultEnteredInError'));

create or replace function lab.validate_result_governance() returns trigger language plpgsql security definer
set search_path=lab,platform,pg_temp as $$ declare head lab.results%rowtype; rev lab.result_revisions%rowtype; verifier uuid; begin
 select * into head from lab.results where id=new.result_id; select * into rev from lab.result_revisions where result_id=new.result_id and version=new.result_version;
 if head.id is null or rev.id is null or head.execution_id<>new.execution_id or head.patient_id<>new.patient_id or head.facility_id<>new.facility_id
  or head.current_version<>new.result_version or new.facility_id<>platform.current_facility_id() then
  raise exception using errcode='23514',message='Governance command must bind the exact current result version'; end if;
 if tg_table_name='result_verifications' then
  if new.verified_by<>platform.current_account_id() or new.verified_by_membership_id<>platform.current_membership_id() then
   raise exception using errcode='42501',message='Verifier must match authenticated database context'; end if;
  if rev.entered_by=new.verified_by or exists(select 1 from lab.result_invalidations i where i.result_id=new.result_id and i.result_version=new.result_version) then
   raise exception using errcode='23514',message='Result verifier must be independent and result must be eligible'; end if;
 elsif tg_table_name='result_releases' then
  if new.released_by<>platform.current_account_id() or new.released_by_membership_id<>platform.current_membership_id() then
   raise exception using errcode='42501',message='Release actor must match authenticated database context'; end if;
  select verified_by into verifier from lab.result_verifications where id=new.verification_id and result_id=new.result_id and result_version=new.result_version;
  if verifier is null or exists(select 1 from lab.result_invalidations i where i.result_id=new.result_id and i.result_version=new.result_version) then
   raise exception using errcode='23514',message='Release requires exact valid verification'; end if;
 else
  if new.actor_id<>platform.current_account_id() or new.actor_membership_id<>platform.current_membership_id() then
   raise exception using errcode='42501',message='Invalidation actor must match authenticated database context'; end if;
 end if; return new; end $$;
create trigger lab_verification_validate before insert on lab.result_verifications for each row execute function lab.validate_result_governance();
create trigger lab_release_validate before insert on lab.result_releases for each row execute function lab.validate_result_governance();
create trigger lab_invalidation_validate before insert on lab.result_invalidations for each row execute function lab.validate_result_governance();
create trigger lab_verifications_immutable before update or delete on lab.result_verifications for each row execute function lab.reject_immutable_evidence();
create trigger lab_releases_immutable before update or delete on lab.result_releases for each row execute function lab.reject_immutable_evidence();
create trigger lab_invalidations_immutable before update or delete on lab.result_invalidations for each row execute function lab.reject_immutable_evidence();

alter table lab.result_verifications enable row level security;alter table lab.result_verifications force row level security;
alter table lab.result_releases enable row level security;alter table lab.result_releases force row level security;
alter table lab.result_invalidations enable row level security;alter table lab.result_invalidations force row level security;
create policy lab_verifications_read on lab.result_verifications for select using(lab.context_allows(patient_id,facility_id,'read_records'));
create policy lab_verifications_insert on lab.result_verifications for insert with check(lab.context_allows(patient_id,facility_id,'write_records'));
create policy lab_releases_read on lab.result_releases for select using(lab.context_allows(patient_id,facility_id,'read_records'));
create policy lab_releases_insert on lab.result_releases for insert with check(lab.context_allows(patient_id,facility_id,'write_records'));
create policy lab_invalidations_read on lab.result_invalidations for select using(lab.context_allows(patient_id,facility_id,'read_records'));
create policy lab_invalidations_insert on lab.result_invalidations for insert with check(lab.context_allows(patient_id,facility_id,'write_records'));
revoke all on lab.result_verifications,lab.result_releases,lab.result_invalidations from public;
comment on table lab.result_verifications is 'Manual exact-version verification evidence; not release, QC, or cryptographic signature.';
comment on table lab.result_releases is 'Explicit authenticated manual attestation/release for one verified result version.';
