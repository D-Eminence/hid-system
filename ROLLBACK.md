# Switching off the Pharmacy prescription checks (the rollback)

This branch, `claude/ecstatic-ramanujan-q4i1eo-pharmacy-rollback`, is a ready
undo for the Pharmacy guard (migrations 0100 and 0101). It is kept ready and
is never merged unless it is needed. This file is for you; it is not part of
the release. Leave the commits that add and update it out of what is merged
(or delete the file on the release branch).

## In short

The guard made the database check two things for prescriptions written and
filled in the same facility:

- **Accepting:** Pharmacy can accept a prescription only if it is exactly the
  prescription in the patient's record, still active, at the version that was
  read.
- **Dispensing:** Pharmacy cannot dispense once the doctor has cancelled, held
  or changed that prescription.

The rollback switches both checks off. The database goes back to exactly how
it was before the guard (as after 0099). Nothing else changes.

## When to use it

Use it only if the checks themselves are causing harm that cannot wait for a
proper fix. For example:

- Pharmacy staff keep being refused acceptances or dispensings that should go
  through, and the cause cannot be fixed quickly. The "not found" and "does not
  match the prescription" refusals should never come from normal use; if they
  do, and keep coming, this is the case it is for.
- A database problem is traced to the checks, such as prescriptions being held
  up while Pharmacy works.

Do not use it for:

- an occasional "this prescription changed, reload it" or "no longer active"
  refusal. Those are the checks doing their job;
- a problem in the services only. First run "Approved production backend
  rollback" with the release that was live before. That puts back the old
  services but does not switch the database checks off, and it is often
  enough.

**What it costs.** The gap the guard closed comes back:

- the database no longer compares a same-facility acceptance with the
  prescription in the record;
- a work item stays dispensable after the doctor cancels, holds or changes the
  prescription.

Until the checks are back, pharmacists should check each prescription against
the record by eye before they dispense.

## What it changes

- **One migration, 0102** (`0102_pharmacy_source_checks_rollback.sql`). It
  puts the acceptance check and the dispensing check back exactly as they were
  before the guard, word for word, and removes the two notes the guard added.
  - On a copy, the database afterwards was identical to a 0099 database (its
    full schema, compared line by line), and both checks matched the
    pre-guard versions exactly.
  - It refuses to run, and changes nothing, unless the database has exactly
    the guard's two checks as released. So it cannot run twice, or on a
    database the guard never reached.
  - No record is changed or lost. Work items and dispensings stay as they are.
  - No permission changes.
- **Tests.** The guard's two test suites are removed, because they test the
  checks this switches off. Two other test files go back to their text before
  the guard.
- **The services stay as released with the guard.** The Pharmacy and EHR
  services keep working: their new messages for the checks simply never
  appear. The EHR service's safer "send to another facility" and its date
  handling do not depend on the checks, so they stay.
- **What staff notice.** For prescriptions written and filled in the same
  facility, the refusals "not found", "no longer active", "changed, reload",
  "does not match" and "not dispensable" stop appearing. Nothing else changes.
  Work sent between facilities is not affected.

## How to use it

1. **Check the number** (see "If 0102 is already taken" below).
2. **Bring the branch up to date** with the production branch
   (`origin/staging-novu-ci-20261005`): rebase it onto the newest release.
   Leave out the commits that only touch this file (their subjects end
   "not for release"). The rollback itself is every other commit on this
   branch after the guard's (a25fc7a): the migration, and a later commit
   that corrects its notes; both go in. If other migrations shipped
   after the guard, renumber now.
3. **Re-run the checks** on the updated branch:
   - `node scripts/verify-migration-ledger.mjs`;
   - the release tests (`release/test/staging-migration-ledger.test.mjs` and
     the release contract);
   - a fresh install and an upgrade on a throwaway PostgreSQL 16, with every
     database test suite.
4. **Sign the declaration.** In `config/production-schema-compatibility.json`,
   `reviewed_by` is empty on purpose. The production release refuses to run
   until you sign it.
5. **Open the pull request** into `staging-novu-ci-20261005`. When the checks
   are green, merge it. Merging releases production: the release plans, does
   a dry run, then applies 0102. It applies in well under a second. If a long
   database change is holding the Pharmacy tables at that moment, it stops
   after 5 seconds with nothing applied, and you simply run the release again.
6. **Check afterwards** in the production database (read only):

   ```sql
   select version from migration.schema_migrations where version like '%pharmacy_source_checks_rollback%';
   select p.oid::regprocedure, md5(p.prosrc), obj_description(p.oid, 'pg_proc') from pg_proc p
    where p.oid in ('pharmacy.validate_work_item()'::regprocedure, 'pharmacy.validate_dispensing()'::regprocedure);
   -- validate_work_item bc7df9aadfcc5f99965bcba0cfb2a5d7, validate_dispensing 23d9b6a9a9d09b106f685679df84f74f,
   -- and no comment on either
   ```

**The release-script fix must come with it.** This branch starts from the
guard's own commits (a25fc7a), before #141. The first guard release (#139) was
refused because the release counted the test file
`database/tests/schema.integration.sql` as a schema change that could not be
declared. #141 (6c6fc18) fixed that: test suites are no longer counted. This
rollback changes that same test file back, so it needs #141 too. Rebasing onto
the production branch (step 2) brings it in. Without it, the release refuses
the rollback in the same way and changes nothing.

**Turning the checks back on later** takes a new migration with the next free
number that puts 0100's and 0101's checks back. Migrations only move forward;
0100 and 0101 cannot be applied again.

## If 0102 is already taken

The rollback takes the next free number after the newest released migration.
For example, if records processing, the scanner and the support check shipped
as 0102, 0103 and 0104 after the guard, the rollback becomes 0105.

Steps, in one commit:

1. Rename the file:

   ```
   git mv services/ehr-api/database/migrations/0102_pharmacy_source_checks_rollback.sql services/ehr-api/database/migrations/<N>_pharmacy_source_checks_rollback.sql
   ```

2. In that file, replace `0102` with the new number. Change nothing else. If
   the guard itself shipped under other numbers (for example 0103 and 0104),
   also replace `0100` and `0101` with those, in the same pass, so that a
   number already replaced is not replaced again:

   ```
   N=0105 N1=0100 N2=0101 python3 - <<'PY'
   import os, re, pathlib
   n, n1, n2 = os.environ['N'], os.environ['N1'], os.environ['N2']
   mapping = {'0102': n, '0100': n1, '0101': n2}
   path = pathlib.Path(f'services/ehr-api/database/migrations/{n}_pharmacy_source_checks_rollback.sql')
   path.write_text(re.sub(r'010[012]', lambda m: mapping[m.group(0)], path.read_text()))
   PY
   ```

   None of these numbers appears inside a hash or inside either check, so the
   checks' fingerprints (md5) stay the same.
3. In `services/ehr-api/database/runtime-grants.sql`, change "0102" in the
   rollback block's comment to the new number.
4. In `scripts/verify-migration-ledger.mjs` and `release/config/components.json`,
   move the rollback's entry to the end (after the newest migration), with the
   new file name and its new sha256. Update `last` and `count` in
   `components.json`, and the two numbers in
   `release/test/staging-migration-ledger.test.mjs`.
5. In `config/production-schema-compatibility.json`, change the file name and
   its sha256, and the number in the evidence text. `runtime-grants.sql`'s
   sha256 changes too.
6. In `docs/INTERFACE_CONTRACT.md`, change the number in the rollback
   section's heading and first paragraph. Sections 28 and 29 (the guard's
   sections) also name 0102 twice each, where they say the guard's test
   suites were removed with it: change those four too.
7. Run the checks in "How to use it", step 3.
