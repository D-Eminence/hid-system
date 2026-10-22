-- Patient-self reads are bound to the patient's own live session (PSELF-RLS,
-- main D-Eminence/hid-system#75, main 0091 section 3; sections 1, 2, 4 and 5
-- are not part of this migration). Applied migrations 0001 through 0082 are
-- immutable.
--
-- The patient-self policies (0030 encounters, notes and revisions; 0033
-- embeddings; 0061 imported records; 0066 chat history; 0067 diagnoses,
-- prescriptions, lab requests, vitals, vital corrections, chat evidence and,
-- through lab.patient_self_context, eight Lab tables; 0068 attachment
-- extraction; 0069 documents and scan events) trust ehr.patient_self_context,
-- which checked only that the transaction settings were present and fresh:
-- a context naming another patient and a session that does not exist read
-- that patient's records, against 0005's rule that a custom setting is never
-- trusted without a relational check. The same signature is kept, so no
-- policy changes, and the function becomes SECURITY DEFINER with a pinned
-- search_path. It keeps the setting checks and adds the binding: the named
-- patient must be the one identity.patient_self_session would return for the
-- named subject and session (live, not revoked or expired, current token
-- version, active account and patient, the subject the transaction acts as),
-- and must belong to the named account. Unlike main, the session conditions
-- are written inline rather than as a call to that SQL function: a policy
-- calls this function once per row, and the nested call was planned again on
-- every row: about 500 microseconds per row of the patient's own records,
-- against 25 inline and 7 for the unbound 0030 body (PostgreSQL 16, local).
-- A malformed account or session id is refused, not raised. CREATE OR
-- REPLACE keeps the owner and the EXECUTE grants to
-- hid_ehr_runtime, hid_lab_runtime and hid_schema_test_runtime, so neither
-- this migration nor runtime-grants.sql changes a grant. The EHR and Lab APIs
-- already set the subject, account and session Identity returns for the
-- patient's own session.
create or replace function ehr.patient_self_context(requested_patient uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  uuid_shape constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  claimed_patient text := nullif(current_setting('app.patient_id', true), '');
  claimed_subject text := nullif(current_setting('app.actor_subject', true), '');
  claimed_account text := nullif(current_setting('app.account_id', true), '');
  claimed_session text := nullif(current_setting('app.session_id', true), '');
  authorized_until text := nullif(current_setting('app.self_authorized_until', true), '');
begin
  if requested_patient is null or claimed_patient is null or claimed_subject is null
     or claimed_account is null or claimed_session is null or authorized_until is null
     or nullif(current_setting('app.correlation_id', true), '') is null
     or current_setting('app.purpose_of_use', true) is distinct from 'patient-self'
     or claimed_patient <> requested_patient::text then
    return false;
  end if;
  if authorized_until::timestamptz <= statement_timestamp() then
    return false;
  end if;
  if claimed_account !~ uuid_shape or claimed_session !~ uuid_shape then
    return false;
  end if;
  -- The session conditions of identity.patient_self_session (0030), inline:
  -- PL/pgSQL keeps this one plan for the connection, whereas a nested call to
  -- that SQL function is planned again on every row a policy checks.
  return exists (
    select 1
      from identity.patients patient
      join auth.accounts account on account.id = patient.account_id
      join auth.sessions session on session.account_id = account.id and session.patient_id = patient.id
     where patient.id = requested_patient
       and account.id = claimed_account::uuid
       and account.subject = claimed_subject
       and session.id = claimed_session::uuid
       and session.session_kind = 'patient'
       and session.revoked_at is null
       and session.expires_at > statement_timestamp()
       and session.absolute_expires_at > statement_timestamp()
       and session.account_token_version = account.token_version
       and account.status = 'active'
       and (account.disabled_until is null or account.disabled_until <= statement_timestamp())
       and patient.status = 'active'
  );
end
$$;

revoke all on function ehr.patient_self_context(uuid) from public;
comment on function ehr.patient_self_context(uuid) is
  'True only in a fresh patient-self transaction whose patient, account, subject and live session match identity.patient_self_session (0030, bound 0083).';
