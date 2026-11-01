# Pharmacy guard (0100 and 0101): notes for the owner

Branch `pharm-guard`, local only (not pushed), built on the production
backend `origin/staging-novu-ci-20261005` at 82f52b9. Your decision of
1 Nov 2026 was "Fix it now". This file is for you; it is not part of the
release.

## In short

Before this change, Pharmacy could accept a prescription from the same
facility without the database checking that the prescription was real. The
database only trusted what the caller sent. Once accepted, the work item stayed
dispensable even if the doctor later cancelled or changed the prescription.

After this change:

- **Accepting:** the database accepts a same-facility work item only if it
  is exactly the EHR prescription it names. That means the prescription
  exists, is active, is at the version that was read, and matches on patient,
  facility, encounter, medicine, dose, route, frequency, instructions, dates,
  prescriber and time.
- **Dispensing:** the database refuses to dispense a same-facility work item
  once its prescription is no longer active at that version.
- **Existing rows:** nothing already in the database is changed. A read-only
  audit counts the existing work items that would not have passed.

## What changed

There are two migrations and small changes in two services. None of it
touches the website, Lab, any table, column, grant or policy, or any existing
row.

1. **Migration 0100** (`0100_pharmacy_prescription_source_check.sql`)
   replaces `pharmacy.validate_work_item()`. That is the check that runs when
   Pharmacy accepts a prescription.
   - Only the same-facility part changes. The part for prescriptions sent
     from another facility (order routes) is byte for byte as before.
   - For a same-facility acceptance it reads the prescription and locks it
     against changes until the acceptance is saved. It then refuses, in this
     order:
     - `PRESCRIPTION_SOURCE_NOT_FOUND`: there is no such prescription, or
       this staff session may not see it.
     - `PRESCRIPTION_SOURCE_NOT_ACTIVE`: the prescription is draft, on hold,
       completed, cancelled or entered in error.
     - `PRESCRIPTION_SOURCE_VERSION_MISMATCH`: the prescription changed since
       it was read.
     - `PRESCRIPTION_SOURCE_MISMATCH`: any field differs.
   - After those, the old checks run exactly as before.
2. **Migration 0101** (`0101_pharmacy_dispensing_source_check.sql`) replaces
   `pharmacy.validate_dispensing()`. That is the check that runs when Pharmacy
   dispenses.
   - For a same-facility work item it refuses with
     `PRESCRIPTION_SOURCE_NOT_DISPENSABLE` when any of these is true:
     - the prescription is gone;
     - it belongs to another patient, facility or encounter;
     - it is no longer active;
     - it is at a different version from the one Pharmacy accepted.
   - Reversing a dispensing that was already recorded still works.
3. **pharmacy-api** turns these refusals into clear answers:
   - 404 for "not found";
   - 409 for "not active" and for "changed, reload";
   - 422 for "does not match";
   - 409 `PHARMACY_PRESCRIPTION_NOT_DISPENSABLE` for a dispensing that is no
     longer allowed. The website already shows this one as "Not dispensable".
4. **ehr-api** changes in two ways:
   - **Send to another facility:** the send now runs in the strictest
     isolation mode (SERIALIZABLE) and is retried if the database cancels
     it. Without this, a send that overlapped a same-facility acceptance could
     leave both a live route and a dispensable work item.
   - **Dates:** prescription dates are now sent to Pharmacy as plain
     calendar dates (YYYY-MM-DD). This keeps acceptances working even if the
     EHR API's server time zone is ever set east of UTC.

**One rule this carries (as on main):** once its prescription has changed or
stopped, a same-facility work item can be neither dispensed nor accepted
again. The prescriber writes a new prescription.

**What staff may notice:**

- Normal use is unchanged. The website sends only "accept this prescription
  at this version", and the EHR API builds the rest from the stored row.
- Staff will see a refusal only if the prescription changed or stopped
  between the moment it was read and the moment Pharmacy saved or dispensed
  it.
- The website shows the refusal's message. It does not yet reload the list
  for the four new acceptance codes (an optional small website change; see
  "Questions for you").

## Before you release

1. **Sign the declaration.** In `config/production-schema-compatibility.json`,
   `reviewed_by` is empty. The production release refuses to run until it is
   signed. It lists the two migrations and `runtime-grants.sql` with these
   sha256 values:
   - 0100: `8c37599452f7432f7d2fa44c29cbf4ac8f6c7728809be28c553c2bd2f0d9927c`
   - 0101: `2c10b2adfc40bb68b46a57b94036daa2a391d62ec06bebfdde3aeaa26f2d18b6`
   - runtime-grants.sql: `3f3f20b17f8df284c1b97e938a595f7cd30332f0427feeeedc30ab60afb16522`
2. **Choose the numbers.**
   - If the guard ships before the records processing, scanner, support and
     Health ID chain, it keeps 0100 and 0101. The chain then moves up by two.
   - If any of that chain ships first, follow `RENUMBER.md`, which sits at
     the root of this branch. The guard then becomes 0103/0104 or 0104/0105.
   - Renumbering does not change either function body or its md5.
3. **Optionally run the data audit first** (see "The data audit" below). It
   gives the same answer before or after the release.

## How to release

1. Make a release branch from `origin/staging-novu-ci-20261005` and
   cherry-pick, in this order:
   - `7ec05cd`: Pharmacy 0100, the acceptance check;
   - `c239e5a`: Pharmacy 0101, the dispensing check, plus the ehr-api and
     pharmacy-api changes.

   Leave out the owner-notes commits:
   - `a34f785` and `2265103`, which carry RENUMBER.md and the audit;
   - the commit that adds this file.

   I checked that the two cherry-picks apply cleanly to 82f52b9. The result is
   exactly c239e5a's files without RENUMBER.md and the audit.
2. If you renumber, do it now on that branch, following RENUMBER.md.
3. Sign `reviewed_by` on that branch.
4. Open the pull request into `staging-novu-ci-20261005`. When CI is green,
   merge it. Merging releases production.
   - The release first runs the database migration task: plan, dry run, then
     apply. It refuses if the pending migrations are not exactly the declared
     ones.
   - It then rolls out the services. ehr-api and pharmacy-api must go out in
     the same release, and they do.
5. The migrations take no lock on any application table until they commit.
   On a copy they applied in under 30 ms each. If a long schema change holds
   `ehr.prescriptions` or `pharmacy.work_items`, the migration stops after 5
   seconds with nothing applied, and you can simply run the release again.

## What to check after the release

1. **Release log.** The migration plan names exactly the two files, the apply
   succeeds, and the final plan shows 0 pending.
2. **Read-only checks in the production database:**

   ```sql
   select version, checksum_sha256 from migration.schema_migrations
    where version in ('0100_pharmacy_prescription_source_check.sql', '0101_pharmacy_dispensing_source_check.sql');
   -- 8c37599452f7432f7d2fa44c29cbf4ac8f6c7728809be28c553c2bd2f0d9927c and
   -- 2c10b2adfc40bb68b46a57b94036daa2a391d62ec06bebfdde3aeaa26f2d18b6
   select p.oid::regprocedure, md5(p.prosrc), p.proacl from pg_proc p
    where p.oid in ('pharmacy.validate_work_item()'::regprocedure, 'pharmacy.validate_dispensing()'::regprocedure);
   -- validate_work_item e2411539ee8c95a02dad46c03e24db05, validate_dispensing 17f7e8897bd2ab240332e4d2c9f757b7,
   -- each ACL naming only its owner
   ```

   (If you renumber, the file names change but the md5 values do not.)
3. **Try it on the demo tenant.** Use a facility where the clinic and the
   Pharmacy are the same facility. The tests use the sealed demo tenant's Demo
   Hospital with Patient One.
   - Write a prescription and Send to Pharmacy. It is accepted.
   - Dispense it. That works.
   - Write a second prescription and send it. Change its instructions in the
     EHR, then try to dispense. Pharmacy shows "Not dispensable".
4. **Watch the logs for a day.**
   - pharmacy-api should give no 500s caused by these checks.
   - A 409 `PRESCRIPTION_SOURCE_VERSION_MISMATCH`, `PRESCRIPTION_SOURCE_NOT_ACTIVE`
     or `PHARMACY_PRESCRIPTION_NOT_DISPENSABLE` now and then is expected.
   - A 404 `PRESCRIPTION_SOURCE_NOT_FOUND` or 422 `PRESCRIPTION_SOURCE_MISMATCH`
     should never come from normal use. If you see one, tell me. The most
     likely cause would be a data or time-zone problem, and the rollback below
     applies.
5. **Run the data audit** if you have not already.

## Rollback

There are two layers, and you may need one or both.

1. **The services.** Run "Approved production backend rollback" with the
   release ID that was live before this one.
   - The old ehr-api and pharmacy-api images work with the new database:
     normal acceptances and dispensings still pass. I proved this by running
     today's code against the upgraded database, under UTC and Africa/Lagos.
   - With the old images:
     - the new refusals show as a 500 error instead of a clear 404/409/422;
     - sends to another facility go back to the old mode, so an overlapping
       acceptance and send can again leave both;
     - dates go back to depending on the EHR API running in UTC, which it
       does today.
   - Rolling back the services does not switch the database checks off.
2. **The database checks.** Migrations only move forward and are never
   undone, so switching the checks off takes a new migration (the next free
   number). It puts back the two functions exactly as 0086 left them and
   drops the two comments 0100 and 0101 added:
   - `pharmacy.validate_work_item()` from 0086 lines 9424-9491;
   - `pharmacy.validate_dispensing()` from 0086 lines 9497-9533;
   - then `comment on function pharmacy.validate_work_item() is null;` and
     `comment on function pharmacy.validate_dispensing() is null;`.

   I proved this on a copy:
   - both bodies came back with 0086's md5 values (`bc7df9aadfcc5f99965bcba0cfb2a5d7`
     and `23d9b6a9a9d09b106f685679df84f74f`);
   - the database schema came out identical to the 0099 database;
   - 82f52b9's own Pharmacy suites passed on it.

   This undo migration would need its own declaration and your signature.
   I can prepare it on a branch in advance if you want it ready.

## The data audit

The file is `audit-existing-work-items.sql`, at the root of this branch. It is
not part of the release.

**What it does:**

- It counts the existing same-facility work items, as they stand in the
  database today, that 0100 would have refused.
- It also counts what has happened to them since they were accepted.
- It returns counts only: no id, name, patient, medicine or other value leaves
  the database.
- It runs in a read-only transaction that it rolls back, with a 60-second
  limit.
- It never waits for, or blocks, an acceptance, a dispensing or an EHR
  change.

**How to run it.** Use a database login that bypasses row-level security
(superuser or `BYPASSRLS`):

```
psql "$DATABASE_URL" -X -x -f audit-existing-work-items.sql
```

To check your login first:

```sql
select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user;
```

If the login does not bypass row-level security, the audit stops with "query
would be affected by row-level security policy". It does that instead of
giving counts that are too low.

**How it judges.** Each work item is compared with the prescription as it
stood at the version the work item names, taken from the EHR's own version
history. It also uses the version that was current at the moment Pharmacy
accepted it. It applies the same matching rules as 0100: spaces trimmed as
pharmacy-api trims them, the dose by value, and the time to the millisecond.

Each work item lands in exactly one of these rows:

| Count | Meaning | Expected |
| --- | --- | --- |
| `total` | Same-facility work items. | any |
| `missing` | No such prescription exists. | 0 |
| `other_patient_or_facility` | The prescription belongs to another patient or facility. | 0 |
| `other_encounter` | Same patient and facility, but another encounter. | 0 |
| `version_not_found` | Neither the history nor the current row has the version the work item names. | 0 |
| `not_active_at_acceptance` | The prescription was not active when Pharmacy accepted it (for example already cancelled or completed). | 0 |
| `stale_version_at_acceptance` | When Pharmacy accepted it, a newer version of the prescription already existed. | 0 |
| `fields_differ` | Medicine, dose, route, frequency, instructions, dates, prescriber or time differ from the version named. | 0 |
| `matches` | 0100 would have accepted it. | any |
| `matches_exactly` | Of those, the ones that needed no trimming or millisecond rule. | any |

These counts sit beside the table:

| Count | Meaning | Expected |
| --- | --- | --- |
| `not_active_dispensed`, `stale_version_dispensed`, `fields_differ_dispensed` | How many of those three rows were dispensed and not reversed. These matter clinically. | 0 |
| `route_backed` | Work items from another facility's route. They were already checked against their route, and the audit does not judge them. | any |

The last four count what happened after acceptance, judged against the
prescription as it stands now:

| Count | Meaning | Expected |
| --- | --- | --- |
| `undispensed_now_not_active` | Not dispensed, and the prescription is no longer active. From 0101 Pharmacy cannot dispense these. | any |
| `undispensed_now_changed` | Not dispensed, and the prescription has changed in any way since acceptance. From 0101 none of these can be dispensed; the prescriber writes a new prescription if it is still needed. | any |
| `dispensed_now_changed` | Dispensed, and the prescription changed afterwards. This is usually normal, for example marked completed after it was dispensed. | any |
| `dispensed_after_a_change` | Dispensed after the prescription had already been cancelled, held or changed. This is what 0101 now refuses. | 0 |

**What to do with the answer:**

- Every "expected 0" count is 0: nothing in the past slipped through.
- A non-zero acceptance count (`missing` to `fields_differ`) means some work
  items were accepted that should not have been. The two `undispensed_now_*`
  counts tell you how many Pharmacy will now hold back. Staff may ask about
  those, and the answer is a new prescription.
- A non-zero `*_dispensed` count or `dispensed_after_a_change` means medicine
  was given against a prescription that was wrong or no longer valid at the
  time. That needs a clinical review. Finding the cases means a follow-up
  query that returns ids; it should be run by someone authorised to see
  patient data, and I have not written it.
- The "now" counts move as the EHR and Pharmacy keep working, so the answer
  is a snapshot.

## What I rechecked on the final head

I re-ran every check on a throwaway PostgreSQL 16.15 run as `pgrun`. The
cluster and its folders are stopped and deleted. The logs are in
`/tmp/claude-0/-home-user/9e2fd816-d904-5725-a775-049f6f6c7bf9/scratchpad/pharm-recheck-tools`.

**The review's findings are all fixed:**

1. **Work items stayed dispensable after the prescription changed (major).**
   Fixed by 0101.
   - The new dispensing suite (25 cases) passes.
   - It fails on 0099, and on the earlier build head a34f785, where 16
     dispensings that should be refused went through.
   - I re-ran the reviewer's own probe on this head:
     - it accepts five prescriptions;
     - the EHR then cancels one, holds one, changes one and marks one entered
       in error;
     - Pharmacy tries to dispense all five.

     The four changed ones are now refused and only the unchanged one is
     dispensed. Before the fix all five were dispensed.
   - 23 of 23 deliberate breakages of 0101 are caught. A 24th makes no
     difference, because a missing prescription is already caught another way.
   - pharmacy-api's new answer is tested, and that test failed on the old code.
2. **The audit counted wrong acceptances as matches (major, two findings).**
   Fixed.
   - The audit test builds a real history through the services' own database
     roles, then upgrades. It gives every expected count.
   - I re-ran the reviewer's own scenario: acceptances made after the
     prescription had been completed, changed or cancelled, one of them then
     dispensed. It now gives exactly the reviewer's corrected counts: 4 in
     total, 2 not active at acceptance, 1 stale version, 1 match, 1 dispensed
     wrongly. The old audit called all four "matches".
3. **A send to another facility could overlap a same-facility acceptance
   (minor).** Fixed in ehr-api. I ran the two-session test in all six forms:
   - with today's send mode, the overlap still leaves both a route and a
     work item;
   - with this release's send, the acceptance is cancelled and its retry
     answers `PRESCRIPTION_ROUTED`;
   - the send's daily limits stay exact.
   - The new tests failed on the old code.
4. **Dates were wrong east of UTC (minor).** Fixed in ehr-api.
   - The tests run the real date parser under seven time zones, and they
     failed on the old code.
   - With today's code under Africa/Lagos, the four dated prescriptions are
     refused. With this release's code all nine are accepted.
5. **Renumbering broke the md5 pin (minor).** Fixed.
   - Neither function body contains a migration number.
   - Every "0100" and "0101" in the two files is a migration number.
   - Renumbered rehearsals on both unreleased chains applied cleanly with
     unchanged bodies, and the guard's suites passed.
6. **RENUMBER.md missed a migration that also claims 0103 (minor).** Fixed. A
   scan of every local worktree finds four other unreleased migrations, and
   RENUMBER.md names all four.

**`reviewed_by`** is empty in `config/production-schema-compatibility.json`,
the only declaration this branch touches. Its file hashes match the files. Its
evidence names only current hashes.

**Database checks:**

- **Fresh install.** All 102 migrations applied; both functions have
  owner-only access before and after the role setup.
- **Upgrade from 0099:**
  - plan, dry run (rolled back) and apply all worked;
  - nothing was left pending, and re-applying either file answers "already
    applied";
  - the schema changed only in the two functions and their two comments;
  - only the migration ledger changed in row count;
  - the role setup changed no permission (1283 grants, the same as before).
- **Test suites.** All 75 database test suites pass on both the fresh and the
  upgraded database.
- **Unchanged parts.** The parts that must not change are byte for byte
  unchanged: 2394 and 956 characters in 0100, 411 and 923 characters in 0101.
- **Production-style owner.** The migrations were applied by a database owner
  set up like production's (no superuser, no row-level security bypass), and
  by a login that is a member of that owner. A stranger is refused. The same
  seven owner-mode suites fail on 0099 and on 0101, and no others.
- **Damaged databases.** On 13 deliberately damaged copies, each migration
  stops with nothing applied.
- **Deliberate breakages.** 0100 catches 43 of 43; 0101 catches 23 of 23, plus
  the one that makes no difference.
- **Locks while migrating:**
  - no application table is locked;
  - behind a schema change holding `ehr.prescriptions`, the migration stops
    after about 5.3 s with nothing applied, then applies once the schema
    change ends;
  - behind ordinary row writes, it applies at once.
- **Locks at run time**, with two sessions and both kinds of owner:
  - an acceptance or a dispensing holds the prescription;
  - an EHR change that overlaps it waits, then is cancelled;
  - the retry gets the right refusal.
- **Today's services against the new database.** Today's EHR and pharmacy-api
  code, taken from 82f52b9, ran against it: 27 of 27 cases pass under UTC and
  Africa/Lagos, on both kinds of owner.
- **The audit:**
  - it is read-only;
  - it returns counts only;
  - it refuses to run under a login that does not bypass row-level security.
- **Staging rehearsal** (`test-staging-schema-upgrade.mjs`) passed: baseline
  100, integrated 102, both migrations declared, 2564 grants, row-level
  security unchanged on 185 tables.
- **Rollback.** Proved as described under "Rollback".

**Services and release checks:**

- pharmacy-api: 207 of 207 tests pass, and the type check is clean.
- ehr-api: 522 of 522 tests pass, and the type check is clean.
- The new tests fail on the old code: 7 in pharmacy-api, and 6 plus a missing
  module in ehr-api.
- The migration ledger check passed.
- Release: 83 of 83 tests pass, and the release contract verifies.
- production-backend-build: 19 of 19 tests pass.
- The CI's Python tests: 41 of 41 pass.
- The source admission check finds both c239e5a and 2265103 compatible, with
  no blockers.
- TUF rehearsal: passed on a clean checkout of 2265103, run as `pgrun`. All
  19 of its checks passed, including the order-route, facility self sign-up,
  patient, emergency-contact and code-recovery runs, the backup and the
  restore. Its own temporary database was removed. A first attempt stopped
  early because my checkout lacked the notification-api install; it passed
  once I added that install, which matches 82f52b9's lockfile.

**Website.** The health website at main bb3775c still sends only "this
prescription, at this version, with a reason" to the EHR API. Both Pharmacy
pages already handle "Not dispensable". No website change is required.

**Fixes to the test harness during this recheck.** These are not product
problems:

- **Two-session send test.** It wrote a route with two separate clock
  readings, which the database rejects whenever the two differ by a
  microsecond. I fixed it, and all six cases now match the earlier report.
- **Send-limit test.** Its script had not been kept, so I rewrote it. It gives
  the same result as before.
- **Reviewer's probe.** It checked the earlier 0100 body's md5. I moved that
  check to this head's body, which differs only by one comment line.
- **Release tests.** The release and infra/cloudflare installs used before did
  not match their lockfiles:
  - fast-uri 3.1.8 was installed where the lockfile says 3.1.9;
  - undici 7.30.0 was installed where the lockfile says 7.30.1.

  I reinstalled the release package from its lockfile, and gave
  infra/cloudflare only the two packages the release tests need, at their
  lockfile versions. The release tests then passed again, 83 of 83.
- **Service installs.** The ehr-api, pharmacy-api and identity-api installs
  match 82f52b9's lockfiles exactly, package by package.

## Things to know

- **Old images.** Until the new pharmacy-api is running, the new refusals show
  as a 500 error. They ship in the same release, so this lasts only for the
  rollout.
- **Send limits during the rollout.** While an old ehr-api and a new one both
  run, a send to another facility can exceed a daily send limit by one. That
  happens only if an old send and a new send overlap.
- **Staff without consent.** In production, a staff session without consent
  for that patient at that facility cannot see the prescription. Its
  acceptance is therefore refused as "not found" before the older session
  checks run. The answer is still a refusal; only the message differs.
- **Changed prescriptions.** Once its prescription has changed or stopped, a
  same-facility work item can be neither dispensed nor accepted again (as on
  main). The prescriber writes a new prescription.

## Questions for you

1. **Sign `reviewed_by`**, and choose whether the guard ships before or after
   the records processing, scanner, support and Health ID chain.
2. **Optional website change.** Do you want the small website change that maps
   the four new acceptance codes to the existing "reload" messages? Without
   it, staff still see a clear message, but the list does not reload.
3. **Running the audit.** Who runs it, with a login that bypasses row-level
   security?
4. **Rollback migration.** Do you want the database undo migration prepared
   in advance, as a ready branch that is never merged unless needed?
