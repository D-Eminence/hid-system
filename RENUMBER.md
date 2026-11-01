# Renumbering the pharmacy source check (0100) at release

This file and `audit-existing-work-items.sql` sit at the repository root of
branch `pharm-guard` for the owner and the release; neither is part of the
release (remove both from the commit that is merged, or leave them out of the
merge, as the owner prefers).

The migration is `0100_pharmacy_prescription_source_check.sql`, built on the
released 0099 (82f52b9). Three unreleased migrations also claim the numbers
after 0099:

| Number | Branch / worktree | What |
| --- | --- | --- |
| 0100 | `rp-db` (records processing) | `0100_records_processing_purpose.sql` |
| 0101 | `scan-be` (document scanner) | `0101_document_scanner.sql` |
| 0102 | `sup-be` (support check) | the support Health ID check |

This migration depends on none of them: its preconditions read only objects
0001-0099 created (the 0099 marker is `ehr.offline_audit_patient_allowed(uuid)`),
and none of the three touches `pharmacy.validate_work_item()`,
`ehr.prescriptions`, `pharmacy.work_items`, their policies, or the functions it
pins (`platform.current_facility_id()`, `current_account_id()`,
`current_membership_id()`, `ehr.context_allows(uuid,uuid,text)`,
`identity.has_active_consent_grant(...)`). Check that again at release: if any
of them changed one of those, the pins in section 0 must be re-measured on a
database with that migration applied.

## A. It ships first (before the chain)

Nothing to renumber. The chain then renumbers itself after it (0101, 0102,
0103), and its declarations and ledgers follow 0100.

## B. The chain ships first (0100, 0101, 0102 released): this becomes 0103

Do every step in one commit on top of the released chain.

1. Rename the file:
   `git mv services/ehr-api/database/migrations/0100_pharmacy_prescription_source_check.sql services/ehr-api/database/migrations/0103_pharmacy_prescription_source_check.sql`
2. In the file, replace every `0100` that names this migration with `0103`:
   the title line, `"0100: 0001-0099 must be applied first"`,
   `'0100: already applied'`, `'0100: owners checked: ...'`,
   `'0100: a function this migration relies on differs from 0001-0099: %s'`,
   `'0100: a column ...'`, `'0100: missing privileges: %s'`,
   `'0100: not as this file makes it: %s'`, `'0100: an ACL is not this file''s: %s'`,
   the helper name `pg_temp.pharmacy_source_0100_holds` (rename to
   `pharmacy_source_0103_holds`, all occurrences), the header's
   "0100 Pharmacy acceptance ..." and every "0001-0099" that means "the
   migrations before this one": make them "0001-0102". Then:
   - section 0 a. (prerequisites): keep the 0099 marker and add the
     released chain's newest object as the marker that 0001-0102 are applied
     (for example the 0102 support check's function); the message becomes
     `0103: 0001-0102 must be applied first`;
   - the comment on the function (section 2) starts `0103:`;
   - the header line "Numbered 0100 while it sits on the released 0099 ..."
     becomes "0103 (built as 0100 on 0099, renumbered after 0100-0102)".
   Do not change the function body itself (section 1): its md5
   (`8fb2944de050dedd973e5d7f07d9c301`, pinned in sections 0 b. and 3 and in
   the suite) does not depend on the number. If the body must change, re-pin
   it in all three places.
3. Re-measure the pins on a database with 0001-0102 applied: every md5 in
   section 0 c. (they must still be the values written there; if one differs,
   one of the chain changed it, and the guard must be re-checked against it).
4. `services/ehr-api/database/runtime-grants.sql`: the block
   "Pharmacy acceptance source check (0100)" becomes "(0103)"; keep it after
   the chain's own blocks (resolve the merge so all blocks stay, in number
   order).
5. Ledger, `scripts/verify-migration-ledger.mjs`: remove the
   `0100_pharmacy_prescription_source_check.sql` entry and add
   `['0103_pharmacy_prescription_source_check.sql', '<sha256 of the renamed file>']`
   after the 0102 entry.
6. Release manifest, `release/config/components.json`: `"last": "0103"`,
   `"count"`: one more than the released chain's count (104 if the chain left
   103); the files entry renamed to `0103_...` with the new sha256, after the
   0102 entry.
7. `release/test/staging-migration-ledger.test.mjs`: the title and the two
   asserts to the new count and `'0103'`.
8. Declaration, `config/production-schema-compatibility.json`: `files` names
   only `services/ehr-api/database/migrations/0103_pharmacy_prescription_source_check.sql`
   and `services/ehr-api/database/runtime-grants.sql`, each with its new
   sha256; `reviewed_by` empty again (the owner signs the renumbered file);
   in `evidence` replace "0100" with "0103", "0001-0099" with "0001-0102",
   "a 0099 database" with "a 0102 database", and the measured numbers
   (suite count, grant count, apply time, rehearsal baseline/integrated) with
   the re-run's.
9. Docs: `docs/INTERFACE_CONTRACT.md` section "Pharmacy acceptance checks its
   EHR prescription (0100)" becomes "(0103)" and takes the next free section
   number after the chain's sections (the chain adds 28 and later; renumber
   this section and its references, for example in `docs/MAIN_TO_NOVU_PORT.md`
   "INTERFACE_CONTRACT.md §28"); the `MAIN_TO_NOVU_PORT.md` row says 0103.
   The suites need no change (they name no migration number except in
   comments: `pharmacy-prescription-source.integration.sql`,
   `pharmacy-session-guards.integration.sql` say "0100"; update those
   comments to 0103).
10. Re-run, on throwaway PostgreSQL 16: a fresh install of 0001-0103, an
    upgrade from the released 0102, every DB suite on both, the new suite,
    `services/ehr-api/scripts/test-staging-schema-upgrade.mjs`, the TUF
    rehearsal, `node scripts/verify-migration-ledger.mjs`, the release tests,
    and pharmacy-api's jest. Hashes to recompute after any edit:
    `sha256sum services/ehr-api/database/migrations/0103_pharmacy_prescription_source_check.sql services/ehr-api/database/runtime-grants.sql`.

## C. Only part of the chain ships first

Take the next number after the newest released migration (0101 or 0102) and
follow B with that number.
