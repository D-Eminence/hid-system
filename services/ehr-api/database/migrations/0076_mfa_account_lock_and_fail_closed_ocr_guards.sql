-- Phase 4 Stage 7: the OCR patient-confirmation and validation guards fail
-- closed (7B), and the account row lock for platform MFA transactions (7A).
-- Applied migrations 0001 through 0075 are immutable.
--
-- 7B.
-- ocr.validate_patient_confirmation (0016) and ocr.validate_validation_insert
-- (0013) are the BEFORE INSERT triggers that refuse a confirmation or a
-- validation that does not match the canonical OCR source and the reviewing
-- session. They compared with <>, which yields NULL, not true, when either
-- side is NULL, and IF does not raise on NULL. So a write passed whenever a
-- compared value was missing:
-- * a patient confirmation whose source document the guard could not read
--   (missing, or hidden by row-level security from a definer owner that does
--   not bypass it; release checklist P8) was accepted for any patient;
-- * a validation whose extraction the guard could not read (missing, or in
--   another facility under such an owner), or written by a session without an
--   account or a membership (platform.current_account_id() or
--   platform.current_membership_id() NULL), was accepted.
--
-- Both guards now refuse a missing job, source patient, extraction, account
-- or membership explicitly, and compare with IS DISTINCT FROM. The
-- confirmation guard also binds the confirming account and membership to the
-- session, as the validation guard already did for the reviewer: before, any
-- session in the facility could attribute a confirmation to another member.
-- The OCR API always writes the session's own account and membership, so a
-- write it makes with every value present still passes; the error codes and
-- messages are unchanged. CREATE OR REPLACE keeps each function's owner and
-- ACL; the SECURITY DEFINER attribute, search_path and volatility are restated
-- exactly as before (0013, 0016), and the triggers are unchanged.

create or replace function ocr.validate_patient_confirmation()
returns trigger language plpgsql security definer
set search_path = ocr, ehr, pg_temp as $$
declare job_row ocr.jobs%rowtype; source_patient uuid; expected_version integer;
  actor_account uuid := platform.current_account_id();
  actor_membership uuid := platform.current_membership_id();
begin
  select * into job_row from ocr.jobs where id = new.job_id for update;
  select patient_id into source_patient from ehr.documents where id = job_row.document_id;
  select coalesce(max(confirmation_version), 0) + 1 into expected_version
    from ocr.patient_confirmations where job_id = new.job_id;
  if job_row.id is null or source_patient is null or new.patient_id is null
     or actor_account is null or actor_membership is null
     or job_row.facility_id is distinct from new.facility_id
     or source_patient is distinct from new.patient_id
     or (job_row.patient_id is not null and job_row.patient_id is distinct from new.patient_id)
     or new.confirmation_version is distinct from expected_version
     or new.confirmed_by is distinct from actor_account
     or new.confirmed_by_membership_id is distinct from actor_membership then
    raise exception using errcode = '23514', message = 'Patient confirmation does not match the canonical OCR source patient';
  end if;
  return new;
end
$$;

create or replace function ocr.validate_validation_insert()
returns trigger language plpgsql security definer set search_path = ocr, platform, pg_temp as $$
declare job_row ocr.jobs%rowtype; extraction_job uuid; expected_version integer;
  actor_account uuid := platform.current_account_id();
  actor_membership uuid := platform.current_membership_id();
begin
  select * into job_row from ocr.jobs where id = new.job_id for update;
  select job_id into extraction_job from ocr.extractions where id = new.extraction_id;
  if job_row.id is null or extraction_job is null or actor_account is null or actor_membership is null
     or job_row.facility_id is distinct from new.facility_id
     or job_row.status is distinct from 'awaiting_validation'
     or extraction_job is distinct from new.job_id
     or new.validated_by is distinct from actor_account
     or new.validated_by_membership_id is distinct from actor_membership then
    raise exception using errcode = '23514', message = 'Validation does not match the authorized OCR review context';
  end if;
  select coalesce(max(validation_version), 0) + 1 into expected_version
    from ocr.validations where job_id = new.job_id;
  if new.validation_version is distinct from expected_version then
    raise exception using errcode = '23514', message = 'Validation version is not the next immutable version';
  end if;
  return new;
end
$$;

-- 7A. An approved MFA reset (auth.admin_decide_approval, 0070) locks the
-- target account row FOR UPDATE, then revokes its factors, recovery codes and
-- sessions. A platform MFA transaction (sign-in, step-up, recovery-code
-- regeneration, enrolment) locked its challenge and factor first and reached
-- the account row only through the FOR KEY SHARE of its later inserts, so the
-- two could deadlock. The Identity API now calls this helper first in every
-- MFA transaction.
--
-- FOR KEY SHARE is the weakest row lock that conflicts with FOR UPDATE. An MFA
-- transaction therefore waits for an approved reset or a session revocation
-- (0073) of the account, and they wait for it, but it does not wait for a
-- refresh rotation, a staff sign-in or another MFA transaction of the account,
-- which take FOR KEY SHARE too. auth.lock_account_sessions (0073, FOR UPDATE)
-- would also have serialized those: a step-up that raced a refresh found its
-- session rotated and was refused, and the password step could deadlock with a
-- staff sign-in of the same administrator through the principal's
-- login-attempt row. It only locks. The role bootstrap grants it to the
-- Identity runtime only.
create function auth.lock_account_for_mfa(target_account uuid)
returns void
language plpgsql
security definer
set search_path = auth, pg_temp
as $$
begin
  perform 1 from auth.accounts account_row where account_row.id = target_account for key share;
end
$$;
revoke all on function auth.lock_account_for_mfa(uuid) from public;
comment on function auth.lock_account_for_mfa(uuid) is
  'Serializes a platform MFA transaction with an approved MFA reset and the session revocations of the account (0076). Call first in the transaction.';
