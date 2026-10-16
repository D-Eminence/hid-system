// Approving a clinician application (0098, ADR-066) grants a doctor or nurse
// role pinned to the step-1 credential attestation. Merged with main's 0094
// (ADR-063) and break-glass's 0097 (D9), that role carries two authorities an
// account approved on a forged identity could misuse: break-glass emergency
// reads, and the in-person check of facility-assisted registration, whose own
// authorization accepts any facility role resting on a current attestation,
// so an approved clinician at a designated facility can vouch for another
// person's Health ID. After the merge the documents named break-glass only:
// ADR-066, SECURITY.md §5, P37 and its daily review of recent approvals, the
// launch decision CLIN-SIGNUP, and MIGRATION_RUNBOOK.md §6.
//
// These checks hold those documents to the migrations: each authority that a
// migration grants to every role an application can approve is named in each
// of them, P37 and the runbook review it daily for accounts approved in the
// last 90 days, P32 counts an approval as an attested grant, and the runbook's
// review queries are the ones clinician-applications.integration.sql runs.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repository = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(join(repository, path), 'utf8');
const migrationDirectory = join(repository, 'services/ehr-api/database/migrations');
const migrations = readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()
  .map((name) => ({ name, sql: readFileSync(join(migrationDirectory, name), 'utf8').replace(/--[^\n]*/g, '') }));
const flat = (text) => text.replace(/\s+/g, ' ');

/** The roles an application can request (the table's CHECK in the clinician migration). */
const clinician = migrations.find(({ sql }) => /create table identity\.clinician_applications\b/.test(sql));
const approvable = [...clinician.sql.match(/requested_role text not null check \(requested_role in \(([^)]*)\)\)/)[1]
  .matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);

/** The authorities that need a recent-approval review, how the documents name them, and what records their use. */
const authorities = [
  { permission: 'identity.break-glass.write', term: /\bbreak-glass\b/i, record: "'identity.break-glass.activate'" },
  { permission: 'identity.patient.assisted_registration', term: /\bin-person checks?\b/i,
    record: 'identity.assisted_registration_verifications' },
];

/** The roles a migration grants a permission to, from its auth.role_permissions inserts. */
function grantees(sql, permission) {
  return [...sql.matchAll(/insert\s+into\s+auth\.role_permissions\b[\s\S]*?;/gi)]
    .filter((statement) => statement[0].includes(`'${permission}'`))
    .flatMap((statement) => [...statement[0].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]));
}

const decisions = read('docs/DECISIONS.md');
const adr = decisions.slice(decisions.indexOf('\n# ADR-066:'));
const part = (start, end) => flat(adr.slice(adr.indexOf(`\n${start}:\n`), end ? adr.indexOf(`\n${end}:\n`) : undefined));
const context = part('Context', 'Decision');
const alternatives = part('Alternatives not taken', 'Consequences');
const consequences = part('Consequences');

const security = flat(read('docs/SECURITY.md'));
const signUp = security.slice(security.indexOf('Clinician self sign-up (ADR-066) answers every address alike'),
  security.indexOf('## 6. NIN Security'));
const residual = signUp.slice(signUp.indexOf('Residual risks:'));

const checklist = read('docs/PHASE_4_STAGE_5_RELEASE_READINESS.md');
const row = (id) => checklist.split('\n').find((line) => line.startsWith(`| ${id} |`));
const launch = read('docs/PHASE_3_LAUNCH_DECISIONS.md').split('\n').find((line) => line.startsWith('| CLIN-SIGNUP |'));

const runbook = read('docs/MIGRATION_RUNBOOK.md');
const section6 = runbook.slice(runbook.indexOf('\n## 6. '), runbook.indexOf('\n## 7. '));
const reviews = [...section6.matchAll(/```sql\n([\s\S]*?)\n```/g)].map((match) => match[1])
  .filter((sql) => sql.includes('identity.clinician_applications') && /interval '90 days'/.test(sql));
const suite = flat(read('services/ehr-api/database/tests/clinician-applications.integration.sql'));

test('the migrations give each authority to every role an application can approve', () => {
  assert.deepEqual(approvable, ['doctor', 'nurse']);
  for (const { permission } of authorities) {
    const granted = new Set(migrations.flatMap(({ sql }) => grantees(sql, permission)));
    assert.deepEqual(approvable.filter((role) => !granted.has(role)), [], `${permission} is not granted to every approvable role`);
  }
});

test('ADR-066 names each authority in its context, its alternatives and its consequences', () => {
  for (const { permission, term } of authorities) {
    assert.match(context, term, `ADR-066's context does not name ${permission}`);
    assert.match(alternatives, new RegExp(`probation[^.]*${term.source}`, 'i'), `ADR-066 does not weigh a probation for ${permission}`);
    assert.match(consequences, term, `ADR-066's consequences do not name ${permission}`);
  }
});

test('SECURITY.md §5 names each authority among the residual risks of clinician self sign-up', () => {
  for (const { permission, term } of authorities) assert.match(residual, term, `SECURITY.md §5 does not name ${permission}`);
});

test('P37 and CLIN-SIGNUP name each authority, and P37 reviews each daily for recent approvals', () => {
  const p37 = flat(row('P37'));
  const daily = p37.slice(p37.indexOf('daily review'));
  for (const { permission, term } of authorities) {
    assert.match(daily.slice(0, daily.indexOf('(6)')), term, `P37 (5) does not review ${permission} daily`);
    assert.match(flat(launch), term, `CLIN-SIGNUP does not name ${permission}`);
  }
  assert.match(p37, /in-person checks? it recorded/, 'P37 (6), the fraud runbook entry, does not list the in-person checks of the account');
});

test('P32 counts an approved clinician application as an attested grant', () => {
  assert.match(flat(row('P32')), /ADR-066/);
});

test('MIGRATION_RUNBOOK.md §6 has a recent-approval review query for each authority', () => {
  for (const { permission, record } of authorities) {
    assert.equal(reviews.filter((sql) => sql.includes(record)).length, 1, `MIGRATION_RUNBOOK.md §6 has no review query for ${permission}`);
  }
});

test('the in-person review reads the checks as the system actor', () => {
  const review = reviews.find((sql) => sql.includes('identity.assisted_registration_verifications'));
  assert.ok(review, 'MIGRATION_RUNBOOK.md §6 has no in-person review query');
  // The checks force row-level security: row_security off fails for the migration administrator.
  assert.match(review, /select set_config\('app\.actor_subject', 'system:auth', true\);/);
  assert.doesNotMatch(review, /row_security\s*=\s*off/);
});

test('clinician-applications.integration.sql runs each review query as the runbook writes it', () => {
  for (const { permission, record } of authorities) {
    const review = reviews.find((sql) => sql.includes(record));
    assert.ok(review, `MIGRATION_RUNBOOK.md §6 has no review query for ${permission}`);
    const query = review.slice(review.search(/^select (?!set_config)/m));
    const statement = flat(query.slice(0, query.indexOf(';') + 1));
    assert.ok(suite.includes(statement), `clinician-applications.integration.sql does not run the runbook's review of ${permission}`);
  }
});
