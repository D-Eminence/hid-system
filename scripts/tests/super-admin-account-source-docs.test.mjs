// Where the first Super Admin accounts come from in production (review round 3
// of the sign-up production readiness branch, then the owner's decision).
//
// Round 2 named the HID 1.0 promotion as the production source of the
// accounts `admin:bootstrap` names. As deployed, the promotion cannot run in
// AWS: RDS accepts only the service tasks and the migration security group;
// the migration task maps only the migration administrator's URL, reaches
// only RDS, the AWS endpoints and Amazon S3, has a read-only root filesystem
// and its image holds no HID 1.0 export, so `migration:stage` cannot read its
// source; and `migration:promote` refuses to start without three keys that no
// task maps and that may never be RunTask overrides. Round 3 recorded that no
// production route to the accounts existed and that SUPERADMIN-ACCOUNTS
// blocked P6.
//
// Owner decision 2026-10-16 (SUPERADMIN-ACCOUNTS): "By email, own password".
// The one-time `admin:bootstrap` run takes two or three email addresses
// (`PLATFORM_ADMIN_EMAILS`), creates platform-only accounts with no password
// and grants each Super Admin; each person sets their own password with the
// admin reset and enrols an authenticator at the first platform sign-in. These
// tests pin the code facts above, still require every document to say the
// promotion has no AWS execution path, and now require the decision and the
// email path where they said no route existed. That is the decision changing,
// not a weaker test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repository = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(join(repository, path), 'utf8');
const flat = (text) => text.replace(/\s+/g, ' ');
const section = (text, start, end) => {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `missing section ${start}`);
  const to = text.indexOf(end, from + start.length);
  return text.slice(from, to > from ? to : undefined);
};

const runbook = read('docs/AWS_DEPLOYMENT_RUNBOOK.md');
const migrationRunbook = read('docs/MIGRATION_RUNBOOK.md');
const foundation = read('docs/SUPER_ADMIN_FOUNDATION.md');
const checklist = read('docs/PHASE_4_STAGE_5_RELEASE_READINESS.md');
const decisions = read('docs/PHASE_3_LAUNCH_DECISIONS.md');
const stagingPlan = read('docs/LAUNCH_STAGING_PLAN.md');
const regionalStack = read('infra/aws/src/hid-regional-stack.ts');
const dockerfile = read('services/ehr-api/Dockerfile');
const stage = read('services/ehr-api/scripts/stage-legacy-identity.mjs');
const promotion = read('services/ehr-api/scripts/promote-legacy-identity.mjs');

const PROMOTION_KEYS = ['MIGRATION_FIELD_ENCRYPTION_KEY_B64', 'MIGRATION_LOOKUP_HMAC_KEY_B64', 'CONTACT_LOOKUP_HMAC_KEY_B64'];
const NO_PATH = /no AWS execution path/;
const NO_ROUTE = /no (?:supported )?production route/;
const DECIDED = /owner decision 2026-10-16/i;
const EMAILS = /`PLATFORM_ADMIN_EMAILS`/;
const REPLACE = /`PLATFORM_ADMIN_REPLACE_PENDING=1`/;
/** Each pattern matches, in this order. */
const inOrder = (text, patterns, label) => {
  let from = 0;
  for (const pattern of patterns) {
    const at = text.slice(from).search(pattern);
    assert.ok(at >= 0, `${label}: ${pattern} after position ${from}`);
    from += at + 1;
  }
};

const migrationTask = flat(section(runbook, '### Running the migration task', '### Running the provisioning task'));
const provisioningTask = flat(section(runbook, '### Running the provisioning task', '\n## 5. '));
const legacyMigration = flat(section(runbook, '## 6. Migrate identity and data', '\n## 7. '));
const accountSource = flat(section(foundation, '### Where the accounts come from', '\n## '));
const p6 = flat(checklist.split('\n').find((line) => line.startsWith('| P6 |')) ?? '');
const superAdminAccounts = flat(decisions.split('\n').find((line) => line.startsWith('| SUPERADMIN-ACCOUNTS |')) ?? '');
const oneShotTasks = section(regionalStack, '  private createMigrationTask(', '  private configureRuntimeScaling(');

test('RDS accepts only the service tasks and the migration security group', () => {
  const sources = [...regionalStack.matchAll(/databaseSecurityGroup\.addIngressRule\(([^,]+),/g)].map((match) => match[1]);
  assert.deepEqual(sources, ['resource.securityGroup', 'migration.securityGroup']);
  assert.match(regionalStack, /publiclyAccessible: false,/);
});

test('the migration task maps only the administrator, reaches only RDS, the endpoints and S3, and holds no export', () => {
  assert.match(oneShotTasks, /secrets: \{ DATABASE_URL: migrationAdministrator, DATABASE_ADMIN_URL: migrationAdministrator \},/);
  assert.match(oneShotTasks, /readonlyRootFilesystem: true,/);
  assert.match(oneShotTasks, /allowAllOutbound: false,/);
  const egress = [...regionalStack.matchAll(/migration\.securityGroup\.addEgressRule\(([^,]+(?:\([^)]*\)[^,]*)?),/g)]
    .map((match) => match[1].trim());
  assert.deepEqual(egress, [
    'databaseSecurityGroup',
    'endpointSecurityGroup',
    "ec2.Peer.prefixList(this.parameter('S3PrefixListId').valueAsString)",
  ]);
  // Neither one-shot task maps the HID 1.0 source or the promotion's keys.
  for (const name of ['LEGACY_DATABASE_URL', 'MIGRATION_FIXTURE_PATH', ...PROMOTION_KEYS]) {
    assert.doesNotMatch(oneShotTasks, new RegExp(name), name);
  }
  // The image's migration target copies the scripts and database files, not the test fixtures.
  const target = section(dockerfile, 'AS migration', 'AS runtime');
  const copies = target.split('\n').filter((line) => line.startsWith('COPY'));
  assert.ok(copies.length >= 4, 'the migration target copies its files');
  for (const line of copies) assert.doesNotMatch(line, /\btest\b|fixture/, line);
});

test('stage needs the HID 1.0 source or a fixture file, and promote needs three keys', () => {
  assert.match(stage, /const sourceUrl = process\.env\.LEGACY_DATABASE_URL;/);
  assert.match(stage, /if \(!sourceUrl && !fixturePath\) throw new Error\('LEGACY_DATABASE_URL or MIGRATION_FIXTURE_PATH is required'\);/);
  for (const name of PROMOTION_KEYS) assert.match(promotion, new RegExp(`= decodeKey\\('${name}', 32\\);`), name);
  assert.match(migrationTask, /Never pass a database URL, password or other secret as an override/);
});

test('AWS runbook §6 says the promotion has no AWS execution path yet, and why', () => {
  assert.match(legacyMigration, NO_PATH);
  assert.match(legacyMigration, /`DATABASE_ADMIN_URL`/);
  assert.match(legacyMigration, /`LEGACY_DATABASE_URL`/);
  for (const name of PROMOTION_KEYS) assert.match(legacyMigration, new RegExp(`\`${name}\``), name);
  assert.match(legacyMigration, /override/);
  assert.match(legacyMigration, /SUPERADMIN-ACCOUNTS/);
  const path = legacyMigration.search(NO_PATH);
  assert.ok(path >= 0 && path < legacyMigration.indexOf('`admin:bootstrap`'),
    '§6 says so before it names the bootstrap');
});

test('AWS runbook §4 seeds the first Super Admins by email once the services and SES are live, then each person resets and enrols', () => {
  for (const [name, text] of [['migration task', migrationTask], ['provisioning task', provisioningTask]]) {
    assert.match(text, NO_PATH, `${name}: the promotion still has no AWS path`);
    assert.doesNotMatch(text, NO_ROUTE, `${name}: the email path is a production route`);
    assert.match(text, EMAILS, `${name}: names the email form`);
    assert.match(text, /after the services and SES are live/, `${name}: when the email form runs`);
  }
  const row = flat(runbook.split('\n').find((line) => line.startsWith('| `admin:bootstrap` (P6) |')) ?? '');
  assert.match(row, EMAILS);
  assert.match(row, /`PLATFORM_ADMIN_ACCOUNT_IDS`/);
  assert.match(row, REPLACE);
  assert.match(migrationTask, /email addresses, account IDs and reason of `admin:bootstrap` are not secret/);
  assert.match(migrationTask, DECIDED);
  assert.match(migrationTask, /SUPERADMIN-ACCOUNTS/);
  inOrder(migrationTask, [
    /after the services and SES are live/,
    /`PLATFORM_ADMIN_EMAILS`/,
    /`https:\/\/admin\.healthidentitydirectory\.com\/admin\/recover`/,
    /`https:\/\/www\.healthidentitydirectory\.com\/admin\/recover`/,
    /admin reset \(Turnstile action `admin-reset`\)/,
    /sets their own password/,
    /signs in at `https:\/\/admin\.healthidentitydirectory\.com`/,
    /enrols an authenticator app/,
    /`qoreid`/,
    /`clinician_signup_enabled`/,
    /designates/,
  ], 'the email procedure');
  assert.match(migrationTask, /Nobody else ever knows (?:it|the password)/);
  // A mistyped address: replaced while nobody has used the accounts, refused after.
  const replace = migrationTask.slice(migrationTask.search(/If an address was mistyped/));
  assert.match(replace, REPLACE);
  assert.match(replace, /`pending_reset`/);
  assert.match(replace, /no password, session or authenticator/);
  assert.match(replace, /Once anyone has set a password it refuses/);
});

test('SUPER_ADMIN_FOUNDATION.md records the owner decision and the email path; the promotion still has no AWS path', () => {
  assert.doesNotMatch(accountSource, /In production they come from the HID 1\.0 promotion/);
  assert.match(accountSource, NO_PATH);
  for (const name of PROMOTION_KEYS) assert.match(accountSource, new RegExp(`\`${name}\``), name);
  assert.match(accountSource, /`LEGACY_DATABASE_URL`/);
  assert.doesNotMatch(accountSource, NO_ROUTE);
  assert.doesNotMatch(accountSource, /SUPERADMIN-ACCOUNTS[^.]*blocks P6/);
  assert.match(accountSource, /Owner decision 2026-10-16 \(SUPERADMIN-ACCOUNTS[^)]*\): "By email, own password"/);
  assert.match(accountSource, EMAILS);
  assert.match(accountSource, /platform-only account/);
  assert.match(accountSource, /no password/);
  assert.match(accountSource, /`pending_reset`/);
  assert.match(accountSource, /admin reset/);
  assert.match(accountSource, /Nobody else ever knows the password/);
  assert.match(accountSource, /authenticator/);
  assert.match(accountSource, REPLACE);
});

test('P6 has the email path and names the evidence that passes it', () => {
  assert.doesNotMatch(p6, NO_ROUTE);
  assert.match(p6, NO_PATH, 'P6 still says the promotion has no AWS path');
  assert.doesNotMatch(p6, /blocked, for every owner/);
  assert.doesNotMatch(p6, /the accounts come from the HID 1\.0 promotion/);
  assert.doesNotMatch(p6, /for an owner without a HID 1\.0 account/);
  assert.match(p6, EMAILS);
  assert.match(p6, DECIDED);
  assert.match(p6, /admin reset/);
  for (const evidence of [/`admin\.platform-role\.bootstrap`/, /`auth\.otp\.recovery\.completed`/,
    /`GET \/api\/v1\/admin\/session`/, /`platform_super_admin`/]) {
    assert.match(p6, evidence, String(evidence));
  }
  assert.match(p6, /Passes when/);
});

test('SUPERADMIN-ACCOUNTS is decided by the owner: by email, own password', () => {
  assert.ok(superAdminAccounts, 'PHASE_3_LAUNCH_DECISIONS.md records the question');
  assert.match(superAdminAccounts, /\*\*Decided by the owner 2026-10-16: by email, own password\.\*\*/);
  assert.doesNotMatch(superAdminAccounts, /\*\*Open/);
  assert.doesNotMatch(superAdminAccounts, NO_ROUTE);
  assert.match(superAdminAccounts, NO_PATH);
  for (const name of PROMOTION_KEYS) assert.match(superAdminAccounts, new RegExp(`\`${name}\``), name);
  assert.match(superAdminAccounts, EMAILS);
  assert.match(superAdminAccounts, REPLACE);
  assert.match(superAdminAccounts, /admin reset/);
  assert.match(superAdminAccounts, /Never open RDS to another network/);
});

test('the migration runbook, the release checklist §10 and the launch plan say the same', () => {
  const taskParagraph = flat(section(migrationRunbook, 'The one-shot ECS migration task defaults to', '\n## 7. '));
  assert.match(taskParagraph, NO_PATH);
  assert.match(taskParagraph, EMAILS);
  assert.match(taskParagraph, /SUPERADMIN-ACCOUNTS/);
  assert.doesNotMatch(taskParagraph, NO_ROUTE);
  const stageSection = flat(section(migrationRunbook, '## 7. Stage a controlled snapshot', '\n## 8. '));
  assert.match(stageSection, NO_PATH, 'MIGRATION_RUNBOOK.md §7');
  const databaseSteps = flat(checklist.split('\n').find((line) => line.startsWith('- the database steps in AWS')) ?? '');
  assert.match(databaseSteps, /`admin:bootstrap`/);
  assert.match(databaseSteps, EMAILS);
  assert.match(databaseSteps, NO_PATH);
  assert.match(databaseSteps, /SUPERADMIN-ACCOUNTS/);
  assert.doesNotMatch(databaseSteps, /which blocks P6/);
  assert.doesNotMatch(databaseSteps, NO_ROUTE);
  const gates = flat(stagingPlan.split('\n').find((line) => line.includes('Production gates: P6')) ?? '');
  assert.match(gates, /P6 \(two Super Admins, seeded by email/);
  assert.doesNotMatch(gates, /blocked by SUPERADMIN-ACCOUNTS/);
});
