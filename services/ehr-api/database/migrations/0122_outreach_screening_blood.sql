-- Outreach health checks: genotype and blood group (owner, 2026-11-14, during
-- the AccessCare Medical Outreach: "we should collect genotype and blood
-- group"). The number 0122 is a placeholder: it releases right after 0121,
-- ahead of the other queued migrations that also use 0122 or later, which are
-- renumbered after it. NOT SIGNED: the owner reviews and signs it before it
-- is released.
--
-- WHY
--   Volunteers at the outreach are asked to record a person's genotype and
--   blood group with the other health checks of 0118. Like every other health
--   check, both are optional: a screening saves without them.
--
-- WHAT IT DOES
--   outreach.registration_screenings (0118) gains two optional columns, each
--   null when not recorded:
--   - genotype: 'AA', 'AS', 'AC', 'SS', 'SC', 'CC' or 'unknown' (the person
--     does not know it), CHECK registration_screenings_genotype_check;
--   - blood_group: 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-' or
--     'unknown', CHECK registration_screenings_blood_group_check.
--   The same codes are used by outreach-api and the website (the website shows
--   the minus as a real minus sign; the stored code is the ASCII '-').
--   Nothing else changes:
--   - 0118's trigger outreach.validate_registration_screening never names the
--     clinical columns, so its version, facility, actor and redaction rules
--     apply to the new columns unchanged;
--   - row-level security, policies and the table grant (select, insert,
--     update to hid_outreach_runtime, here and in runtime-grants.sql) are per
--     table, so they cover the new columns; runtime-grants.sql is unchanged;
--   - a redaction deletes the whole screening row (0118), so the new values
--     go with it;
--   - audit rows stay ids only (no values).
--
-- OLD SERVICES: today's outreach-api reads with "select *" and maps the
-- fields it knows (the new columns are ignored); its insert names its
-- columns (the new ones stay null); its update names its columns, so it
-- leaves a recorded genotype and blood group as they are.
--
-- PRECONDITIONS (catalog reads only; 55000, nothing applied): 0118 applied
-- (the table and its trigger function exist); not applied yet (neither column
-- exists).
--
-- LOCKS: ACCESS EXCLUSIVE on outreach.registration_screenings (ADD COLUMN),
-- taken NOWAIT every 10 ms for at most 5 seconds (then 55P03, nothing
-- applied), held to commit. Both columns are nullable with no default, so no
-- row is rewritten. The CHECKs are added NOT VALID and then validated (the
-- house pattern; in this one transaction the ACCESS EXCLUSIVE lock is already
-- held, and the validation reads the screening rows once, every new value
-- being null).
--
-- ROLLBACK: a later migration dropping the two columns (their CHECKs go with
-- them); today's outreach-api never reads or writes them.

-- 0. Preconditions.
do $$
begin
  if to_regclass('outreach.registration_screenings') is null
     or to_regprocedure('outreach.validate_registration_screening()') is null then
    raise exception using errcode = '55000', message = '0122: 0118 must be applied first';
  end if;
  if exists (select 1 from pg_attribute where attrelid = 'outreach.registration_screenings'::regclass
              and attname in ('genotype', 'blood_group') and not attisdropped) then
    raise exception using errcode = '55000', message = '0122: already applied';
  end if;
end
$$;

-- 1. The lock, bounded.
do $$
declare
  attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      lock table outreach.registration_screenings in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 500 then
        raise exception using errcode = '55P03',
          message = '0122: outreach.registration_screenings stayed busy for 5 seconds; run the release again later';
      end if;
      perform pg_sleep(0.01);
    end;
  end loop;
end
$$;

-- 2. The two columns and their checks.
alter table outreach.registration_screenings
  add column genotype text,
  add column blood_group text;

alter table outreach.registration_screenings
  add constraint registration_screenings_genotype_check
    check (genotype in ('AA', 'AS', 'AC', 'SS', 'SC', 'CC', 'unknown')) not valid,
  add constraint registration_screenings_blood_group_check
    check (blood_group in ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown')) not valid;
alter table outreach.registration_screenings validate constraint registration_screenings_genotype_check;
alter table outreach.registration_screenings validate constraint registration_screenings_blood_group_check;

comment on column outreach.registration_screenings.genotype is
  '0122: the person''s genotype as recorded at the outreach (optional): AA, AS, AC, SS, SC, CC, or unknown (the person does not know it).';
comment on column outreach.registration_screenings.blood_group is
  '0122: the person''s blood group as recorded at the outreach (optional): A+, A-, B+, B-, AB+, AB-, O+, O-, or unknown (the person does not know it).';

-- 3. Post-checks.
do $$
begin
  if (select count(*) from pg_attribute
       where attrelid = 'outreach.registration_screenings'::regclass
         and attname in ('genotype', 'blood_group') and not attisdropped and not attnotnull
         and atttypid = 'text'::regtype and not atthasdef) <> 2
     or (select count(*) from pg_constraint
          where conrelid = 'outreach.registration_screenings'::regclass and contype = 'c' and convalidated
            and conname in ('registration_screenings_genotype_check', 'registration_screenings_blood_group_check')) <> 2 then
    raise exception using errcode = '55000', message = '0122: the columns or their checks are not as written';
  end if;
  if exists (select 1 from pg_roles role_row
              where role_row.rolname like 'hid\_%'
                and role_row.oid <> (select relowner from pg_class where oid = 'outreach.registration_screenings'::regclass)
                and has_table_privilege(role_row.oid, 'outreach.registration_screenings', 'DELETE')) then
    raise exception using errcode = '55000', message = '0122: a runtime role may delete a screening';
  end if;
end
$$;
