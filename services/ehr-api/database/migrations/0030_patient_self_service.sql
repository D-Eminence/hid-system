-- Patient sessions are authentication accounts linked to existing canonical
-- Identity patients. They never acquire staff memberships or clinical writers.
alter table auth.sessions add column session_kind text not null default 'staff'
  check (session_kind in ('staff', 'patient'));
alter table auth.sessions add column patient_id uuid references identity.patients(id) on delete restrict;
alter table auth.sessions add constraint patient_session_identity_binding
  check ((session_kind='patient') = (patient_id is not null));

create function identity.current_patient_account(requested_subject text)
returns table(account_id uuid, subject text, email text, display_name text, patient_id uuid)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select a.id, a.subject, a.email, a.display_name, p.id
  from auth.accounts a join identity.patients p on p.account_id = a.id
  where a.subject = requested_subject and a.status = 'active'
    and (a.disabled_until is null or a.disabled_until <= statement_timestamp())
    and p.status = 'active'
$$;

create function identity.patient_self_session(requested_subject text, requested_session uuid)
returns uuid language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select p.id from auth.accounts a
  join auth.sessions s on s.account_id = a.id
  join identity.patients p on p.account_id = a.id and p.id = s.patient_id
  where a.subject = requested_subject
    and requested_subject = nullif(current_setting('app.actor_subject', true), '')
    and nullif(current_setting('app.correlation_id', true), '') is not null
    and s.id = requested_session and s.session_kind = 'patient'
    and s.revoked_at is null and s.expires_at > statement_timestamp()
    and s.absolute_expires_at > statement_timestamp()
    and s.account_token_version = a.token_version
    and a.status = 'active'
    and (a.disabled_until is null or a.disabled_until <= statement_timestamp())
    and p.status = 'active'
$$;

create function identity.patient_self_profile(requested_subject text, requested_session uuid)
returns jsonb language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('patientId',p.id,'hid',p.hid_code,
    'firstName',p.first_name,'lastName',p.last_name,'fullName',p.full_name,
    'dateOfBirth',p.dob,'gender',p.gender,'country',p.country,'state',p.state,'version',p.row_version)
  from identity.patients p
  where p.id = identity.patient_self_session(requested_subject,requested_session)
$$;

create function identity.authorize_patient_self(requested_subject text, requested_session uuid)
returns uuid language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select p.id from identity.patients p
  where p.id = identity.patient_self_session(requested_subject,requested_session)
    and not exists (
      select 1 from identity.consent_directives d
      join identity.consent_directive_versions v on v.directive_id=d.id and v.version_no=d.current_version
      where d.patient_id=p.id and v.status='active' and v.provision_type='deny'
        and v.grantee_type='all' and v.starts_at <= statement_timestamp()
        and (v.expires_at is null or v.expires_at > statement_timestamp())
        and (cardinality(v.actions)=0 or 'read_records'=any(v.actions) or '*'=any(v.actions))
    )
$$;

create function identity.patient_self_access_history(requested_subject text, requested_session uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare patient uuid; result jsonb;
begin
  patient := identity.patient_self_session(requested_subject,requested_session);
  if patient is null then return null; end if;
  select jsonb_build_object('items',coalesce(jsonb_agg(item),'[]'::jsonb)) into result from (
    select jsonb_build_object('consentGrantId',g.id,'scope',g.scope,'purpose',g.purpose_of_use,
      'status',case when g.status='active' and g.expires_at<=statement_timestamp() then 'expired' else g.status end,
      'startsAt',g.starts_at,'expiresAt',g.expires_at,'reason',g.reason,'facilityName',f.name) as item
    from identity.consent_grants g join identity.facilities f on f.id=g.facility_id
    where g.patient_id=patient order by g.created_at desc,g.id desc limit 50
  ) entries;
  return result;
end;
$$;

-- The owning EHR runtime installs this private transaction-local context only
-- after a fresh authenticated Identity self-authorization response. No patient
-- or facility supplied by the browser is used to construct that context.
create function ehr.patient_self_context(requested_patient uuid)
returns boolean language sql stable set search_path = pg_catalog, pg_temp as $$
  select coalesce(
    nullif(current_setting('app.patient_id',true),'')=requested_patient::text
    and current_setting('app.purpose_of_use',true)='patient-self'
    and nullif(current_setting('app.actor_subject',true),'') is not null
    and nullif(current_setting('app.account_id',true),'') is not null
    and nullif(current_setting('app.session_id',true),'') is not null
    and nullif(current_setting('app.correlation_id',true),'') is not null
    and nullif(current_setting('app.self_authorized_until',true),'')::timestamptz > statement_timestamp(),false)
$$;

create policy encounters_patient_self_read on ehr.encounters for select
  using (ehr.patient_self_context(patient_id) and status='completed');
create policy clinical_notes_patient_self_read on ehr.clinical_notes for select
  using (ehr.patient_self_context(patient_id) and status in ('signed','amended'));
create policy note_revisions_patient_self_read on ehr.clinical_note_revisions for select
  using (ehr.patient_self_context(patient_id) and exists (
    select 1 from ehr.clinical_notes n where n.id=clinical_note_id
      and n.patient_id=clinical_note_revisions.patient_id
      and n.facility_id=clinical_note_revisions.facility_id
      and n.current_revision_no=clinical_note_revisions.revision_no
      and n.status in ('signed','amended')
  ));

revoke all on function identity.current_patient_account(text) from public;
revoke all on function identity.patient_self_session(text,uuid) from public;
revoke all on function identity.patient_self_profile(text,uuid) from public;
revoke all on function identity.authorize_patient_self(text,uuid) from public;
revoke all on function identity.patient_self_access_history(text,uuid) from public;
revoke all on function ehr.patient_self_context(uuid) from public;
