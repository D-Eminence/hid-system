-- Phase 4 Stage 9: two defects that stopped commands of the runtime roles
-- once their row locks were fixed. Both date from earlier migrations and were
-- hidden because each command failed first at its lock (42501 or 0A000); the
-- rollback-only suites ran these statements as hid_schema_test_runtime, with
-- triggers off, or as a superuser. Applied migrations 0001 through 0077 are
-- immutable.

-- 1. The Identity runtime can insert patient identifiers again.
--
-- 0058 added patient_identifiers_self_nin_insert for every role (no TO
-- clause). Its WITH CHECK reads identity.verification_evidence in a
-- sub-select. PostgreSQL combines permissive policies with OR, but checks the
-- privileges of every table they read before evaluating any of them, as the
-- querying role. The Identity runtime has no SELECT on verification_evidence
-- (it reads evidence only through definer functions), so since 0058 every
-- Identity runtime insert into patient_identifiers failed with 42501
-- "permission denied for table verification_evidence", including the governed
-- NIN registration review (approve-new and link-existing), which the
-- patient_identifiers_registration_insert policy allows. hid_schema_test_runtime
-- can read verification_evidence, so the schema suite did not show this.
--
-- The policy is dropped, not repaired. The only writer of self-NIN identifiers
-- is identity.bind_my_verified_nin, a SECURITY DEFINER function owned by the
-- owner of identity.patient_identifiers, which does not force row-level
-- security, so that function never used the policy. The policy only let a
-- role other than the owner insert a self-NIN identifier directly, without the
-- binding function's checks (the patient's own session, crosswalk ownership,
-- manual review, single-NIN eligibility, the per-NIN lock). Repairing its
-- privileges would have given exactly that to the Identity runtime; granting
-- it SELECT on verification_evidence would also have exposed every patient's
-- evidence.
drop policy patient_identifiers_self_nin_insert on identity.patient_identifiers;

-- 2. Lab can record the acceptance event of a work item.
--
-- lab.validate_work_item_child (0018) guards both lab.work_item_requested_tests
-- and lab.work_item_events. Its requested-test check read new.ordinal, new.code
-- and the other snapshot columns in the same IF condition as the table-name
-- test. PL/pgSQL compiles a trigger function for each table and resolves the
-- record fields of a condition when it first runs it, before AND short-circuits,
-- so on lab.work_item_events, which has no ordinal column, the condition failed
-- with 42703 "record "new" has no field "ordinal"". Every Lab acceptance of an
-- EHR order inserts its acceptance event, so every acceptance failed. The
-- requested-test check now sits in its own block, reached only for
-- lab.work_item_requested_tests. The checks themselves are unchanged; they
-- compare with IS DISTINCT FROM (ADR-040), the same as <> here because every
-- compared column is NOT NULL. Signature, owner, ACL, SECURITY DEFINER,
-- search_path, volatility and the error code and messages are kept.
create or replace function lab.validate_work_item_child()
returns trigger language plpgsql security definer set search_path=lab,pg_temp as $$
declare parent_row lab.work_items%rowtype;
begin
  select * into parent_row from lab.work_items where id=new.work_item_id;
  if parent_row.id is null or parent_row.facility_id is distinct from new.facility_id
     or parent_row.patient_id is distinct from new.patient_id then
    raise exception using errcode='23514',message='Lab work-item evidence does not match its parent';
  end if;
  if tg_table_name='work_item_requested_tests' then
    if new.ordinal is distinct from 1 or new.code_system is distinct from parent_row.test_code_system
       or new.code is distinct from parent_row.test_code or new.name is distinct from parent_row.test_name then
      raise exception using errcode='23514',message='Requested-test snapshot differs from accepted EHR order';
    end if;
  end if;
  return new;
end
$$;
