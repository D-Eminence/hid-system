# Renumbering the Pharmacy guard (0100 and 0101) at release

This file and `audit-existing-work-items.sql` sit at the repository root of
branch `pharm-guard` for the owner and the release; neither is part of the
release (leave the commits that add or change them out of the merge, or
remove both files from what is merged, as the owner prefers).

The guard is two migrations, written on the released 0099 (82f52b9):

- `0100_pharmacy_prescription_source_check.sql` (a same-facility acceptance
  must be exactly its EHR prescription);
- `0101_pharmacy_dispensing_source_check.sql` (a same-facility work item is
  dispensable only while that prescription is still active at the version
  accepted). It needs the first one (its marker is the first one's function
  body) and must keep the number right after it.

## Who else claims the numbers after 0099

Four unreleased migrations, in local worktrees, also number themselves after
0099 (found by listing every `01NN_*.sql` in every local worktree; check
again at release, the list grows):

| Number | Worktree (branch) | File | What |
| --- | --- | --- | --- |
| 0100 | `rp-db` (`rp-db`) | `0100_records_processing_purpose.sql` | records processing (OCR purpose) |
| 0101 | `scan-be` (`scan-be`) | `0101_document_scanner.sql` | document scanner |
| 0102 | `sup-be` (`sup-be`) | `0102_support_health_id_matches.sql` | support Health ID check |
| 0103 | `hid-replace` (`hid-replace`; the file is untracked work in progress) | `0103_health_id_replacement.sql` | replacement of single-kind Health IDs |

Each of the later ones carries the earlier ones in its worktree (scan-be has
0100-0101, sup-be 0100-0102, hid-replace 0100-0103).

The guard depends on none of them: 0100's preconditions read only objects
0001-0099 created (the 0099 marker is
`ehr.offline_audit_patient_allowed(uuid)`), 0101's read only those and
0100's function, and none of the four touches `pharmacy.validate_work_item()`,
`pharmacy.validate_dispensing()`, `pharmacy.validate_dispensing_reversal()`,
`ehr.prescriptions`, `pharmacy.work_items`, `pharmacy.dispensings`, their
policies, or the functions the guard pins (`platform.current_facility_id()`,
`current_account_id()`, `current_membership_id()`,
`ehr.context_allows(uuid,uuid,text)`, `identity.has_active_consent_grant(...)`).
Proved on throwaway PostgreSQL 16: the released 0099 base, then sup-be's
0100-0102 by its runner, then the guard renumbered 0103 and 0104 by the
procedure below, applied by the same runner (bodies as pinned; the guard's
two suites and the session-guard suite pass); the same with hid-replace's
0100-0103 and the guard as 0104 and 0105. If a later migration in the chain
does change one of those objects, the guard's own preconditions refuse to
apply (nothing is applied) and its pins must be re-checked against it.

## The rule

The guard takes the next two free numbers after the newest migration released
before it: N1 for the acceptance check, N2 = N1 + 1 for the dispensing check.

- It ships first: N1 = 0100, N2 = 0101, nothing to do here. The chain then
  renumbers itself after it, two later than it is written today (records
  processing 0102, scanner 0103, support check 0104, Health ID replacement
  0105).
- 0100-0102 ship first: N1 = 0103, N2 = 0104.
- 0100-0103 (with the Health ID replacement) ship first: N1 = 0104, N2 = 0105.
- Only part of the chain ships first: N1 = the newest released number + 1.

## The steps (one commit on top of what was released)

1. Rename both files:

   ```
   git mv services/ehr-api/database/migrations/0100_pharmacy_prescription_source_check.sql services/ehr-api/database/migrations/<N1>_pharmacy_prescription_source_check.sql
   git mv services/ehr-api/database/migrations/0101_pharmacy_dispensing_source_check.sql services/ehr-api/database/migrations/<N2>_pharmacy_dispensing_source_check.sql
   ```

2. In both files replace the two numbers mechanically, in one pass (so a
   number already replaced is not replaced again), and nothing else:

   ```
   N1=0103 N2=0104 python3 - <<'PY'
   import os, re, pathlib
   n1, n2 = os.environ['N1'], os.environ['N2']
   mapping = {'0100': n1, '0101': n2}
   d = pathlib.Path('services/ehr-api/database/migrations')
   for name in (f'{n1}_pharmacy_prescription_source_check.sql', f'{n2}_pharmacy_dispensing_source_check.sql'):
       f = d / name
       f.write_text(re.sub('0100|0101', lambda m: mapping[m.group(0)], f.read_text()))
   PY
   ```

   Every `0100` and `0101` in the two files names one of the two migrations
   (messages such as `'0100: already applied'`, `'0101: 0001-0100 must be
   applied first'`, the helpers `pg_temp.pharmacy_source_0100_holds` and
   `pg_temp.pharmacy_dispensing_0101_holds`, the comments on the functions,
   the headers); no hash, id or other number contains either string, and
   neither function body contains a migration number. So the bodies, and
   their md5 pins, do not change: `pharmacy.validate_work_item()`
   `e2411539ee8c95a02dad46c03e24db05` (pinned in 0100 sections 0 b. and 3,
   in 0101 section 0 a. as its marker, and in
   `pharmacy-prescription-source.integration.sql`) and
   `pharmacy.validate_dispensing()` `17f7e8897bd2ab240332e4d2c9f757b7` (0101
   sections 0 b. and 3, and `pharmacy-dispensing-source.integration.sql`).
   Leave `0001-0099` as it is: 0100 needs only those migrations. Do not edit
   a function body; if one must change, re-measure its md5 and re-pin it in
   every place listed.

3. Apply both files on a copy of the released database (or a throwaway one
   built from the released files) with the runner. Their preconditions are
   the check of the pins in sections 0 c.: if one stops with "a function this
   migration relies on differs", one of the released migrations changed it,
   and the guard must be re-checked against that change before release.

4. `services/ehr-api/database/runtime-grants.sql`: the blocks "Pharmacy
   acceptance source check (0100)" and "Pharmacy dispensing source check
   (0101)" take N1 and N2; keep them after the released migrations' own
   blocks (resolve the merge so every block stays, in number order).

5. Ledger, `scripts/verify-migration-ledger.mjs`: replace the two entries
   with `['<N1>_pharmacy_prescription_source_check.sql', '<sha256>']` and
   `['<N2>_pharmacy_dispensing_source_check.sql', '<sha256>']`, after the
   released migrations' entries.

6. Release manifest, `release/config/components.json`: `"last": "<N2>"`,
   `"count"`: the released count plus 2; the two files entries renamed, with
   their new sha256, after the released ones.

7. `release/test/staging-migration-ledger.test.mjs`: the title and the two
   asserts to the new count and `'<N2>'`.

8. Declaration, `config/production-schema-compatibility.json`: `files` names
   exactly the two renamed migrations and
   `services/ehr-api/database/runtime-grants.sql`, each with its new sha256
   (the release declares exactly the migrations that are newer than
   production's); `reviewed_by` empty again (the owner signs the renumbered
   files); in `evidence` apply the same mapping (0100 to N1, 0101 to N2),
   make "0001-0099" and "a 0099 database" the released chain's newest
   migration, and replace the measured numbers (suite count, grant count,
   apply time, rehearsal baseline and integrated counts) with the re-run's.

9. Docs: `docs/INTERFACE_CONTRACT.md` sections 28 ("Pharmacy acceptance
   checks its EHR prescription (0100)") and 29 ("Pharmacy dispensing checks
   its EHR prescription (0101)") take N1 and N2 and the next free section
   numbers after the chain's own sections (renumber the references too, for
   example "INTERFACE_CONTRACT.md §28" and "§29" in
   `docs/MAIN_TO_NOVU_PORT.md`, whose two rows say N1 and N2). The suites
   name the migrations only in comments and messages
   (`pharmacy-prescription-source.integration.sql`,
   `pharmacy-dispensing-source.integration.sql`,
   `pharmacy-session-guards.integration.sql`); update those words to N1 and
   N2.

10. Re-run, on throwaway PostgreSQL 16: a fresh install of 0001-N2, an
    upgrade from the released database, every DB suite on both (the merged
    suites: the chain's and the guard's changes to `schema.integration.sql`
    and `pharmacy-session-guards.integration.sql` must both be kept),
    `services/ehr-api/scripts/test-staging-schema-upgrade.mjs`, the TUF
    rehearsal, `node scripts/verify-migration-ledger.mjs`, the release tests,
    and pharmacy-api's and ehr-api's jest. Hashes to recompute after any edit:

    ```
    sha256sum services/ehr-api/database/migrations/<N1>_pharmacy_prescription_source_check.sql \
      services/ehr-api/database/migrations/<N2>_pharmacy_dispensing_source_check.sql \
      services/ehr-api/database/runtime-grants.sql
    ```
