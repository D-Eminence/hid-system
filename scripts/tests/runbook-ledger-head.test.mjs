// docs/MIGRATION_RUNBOOK.md has two checkpoints at which the operator confirms
// the candidate ledger's head: §6 ("Confirm the candidate ledger reaches ...")
// before the cutover rehearsal and §11 step 6 ("Verify the ledger at ...") at
// the cutover. Each branch that adds a migration moves both to its own head,
// and a merge or a renumber can keep an earlier one: after clinician self
// sign-up was renumbered to 0096 both still named 0095, so an operator could
// sign off a database that stopped before 0096.
//
// The release checklist's P1 row names the ledger head after the release in
// the same way ("After this release the last applied version is `NNNN_...`"),
// and it drifted the same way: after the 0098 renumber it still named 0097,
// the break-glass head that the merge brought in.
//
// These checks hold both checkpoints and P1 to the newest migration file.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repository = resolve(import.meta.dirname, '../..');
const migrationDirectory = join(repository, 'services/ehr-api/database/migrations');
const runbook = readFileSync(join(repository, 'docs/MIGRATION_RUNBOOK.md'), 'utf8');
const checklist = readFileSync(join(repository, 'docs/PHASE_4_STAGE_5_RELEASE_READINESS.md'), 'utf8');

const latest = readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort().at(-1).slice(0, 4);
/** Each "ledger reaches `NNNN`" or "ledger at `NNNN`" of the runbook, with its line. */
const checkpoints = runbook.split('\n').flatMap((line, index) => [...line.matchAll(/\bledger (reaches|at) `(\d{4})`/g)]
  .map((match) => ({ line: index + 1, phrase: match[1], migration: match[2] })));

test('the runbook has both ledger-head checkpoints', () => {
  assert.deepEqual(checkpoints.map((checkpoint) => checkpoint.phrase).sort(), ['at', 'reaches'],
    'MIGRATION_RUNBOOK.md needs "ledger reaches" (§6) and "ledger at" (§11 step 6) once each');
});

test('each ledger-head checkpoint names the newest migration', () => {
  const stale = checkpoints.filter((checkpoint) => checkpoint.migration !== latest);
  assert.deepEqual(stale.map((checkpoint) => `line ${checkpoint.line}: ledger ${checkpoint.phrase} \`${checkpoint.migration}\``),
    [], `MIGRATION_RUNBOOK.md must name ${latest}, the newest migration, at each ledger-head checkpoint`);
});

test('the release checklist P1 names the newest migration as the ledger head after this release', () => {
  const rows = checklist.split('\n').filter((line) => line.startsWith('| P1 |'));
  assert.equal(rows.length, 1, 'PHASE_4_STAGE_5_RELEASE_READINESS.md needs exactly one P1 row');
  const heads = [...rows[0].matchAll(/After this release the last applied version is `(\d{4})_[^`]+\.sql`/g)]
    .map((match) => match[1]);
  assert.deepEqual(heads, [latest],
    `P1 must say "After this release the last applied version is \`${latest}_...\`", the newest migration`);
});
