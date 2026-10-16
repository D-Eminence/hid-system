// docs/MIGRATION_RUNBOOK.md has two checkpoints at which the operator confirms
// the candidate ledger's head: §6 ("Confirm the candidate ledger reaches ...")
// before the cutover rehearsal and §11 step 6 ("Verify the ledger at ...") at
// the cutover. Each branch that adds a migration moves both to its own head,
// and a merge or a renumber can keep an earlier one: after clinician self
// sign-up was renumbered to 0096 both still named 0095, so an operator could
// sign off a database that stopped before 0096.
//
// These checks hold both checkpoints to the newest migration file.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repository = resolve(import.meta.dirname, '../..');
const migrationDirectory = join(repository, 'services/ehr-api/database/migrations');
const runbook = readFileSync(join(repository, 'docs/MIGRATION_RUNBOOK.md'), 'utf8');

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
