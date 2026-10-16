// Two operator sequences the runbooks must get right (review round 2 of the
// sign-up production readiness branch).
//
// 1. A new RDS instance has no account: no migration seeds one, and no
//    service runs while the database is provisioned. So admin:bootstrap is no
//    step of the new-instance order. Its account ID form names accounts that
//    must already exist, active with an email address and a password. The
//    HID 1.0 promotion (AWS_DEPLOYMENT_RUNBOOK.md §6) would create them: it
//    keeps each HID 1.0 user's UUID, email and password and holds a legacy
//    platform_admin membership for re-approval without granting a platform
//    role; admin:bootstrap is that re-approval, and the operator takes each
//    UUID from the HID 1.0 source. The promotion has no AWS execution path
//    yet. By the owner's decision of 2026-10-16 (SUPERADMIN-ACCOUNTS) the
//    email form creates the accounts instead, once the services and SES are
//    live (super-admin-account-source-docs.test.mjs).
// 2. Rotating a runtime secret: `--runtime-logins` sets the new password in
//    place, so PostgreSQL refuses the old one at once, while running tasks
//    keep the value ECS injected when they started. The runbooks give the
//    order: write the secret, run step 6, replace the service's tasks
//    (`--force-new-deployment`; ocr-worker has no health check and never
//    replaces itself), then step 7.
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
const promotion = read('services/ehr-api/scripts/promote-legacy-identity.mjs');
const bootstrap = read('services/ehr-api/scripts/platform-admin-bootstrap.mjs');
const localAuth = read('services/identity-api/src/auth/local-auth.provider.ts');
const provisioning = read('services/ehr-api/scripts/database-login-provisioning.mjs');
const regionalStack = read('infra/aws/src/hid-regional-stack.ts');
const workloads = read('infra/aws/src/workloads.ts');

const provisioningTask = section(runbook, '### Running the provisioning task', '\n## 5. ');
const migrationTask = section(runbook, '### Running the migration task', '### Running the provisioning task');
const legacyMigration = section(runbook, '## 6. Migrate identity and data', '\n## 7. ');
const p6 = flat(checklist.split('\n').find((line) => line.startsWith('| P6 |')) ?? '');

test('the HID 1.0 promotion creates the accounts admin:bootstrap can name, and grants no platform role', () => {
  // Each promoted account keeps the HID 1.0 auth user UUID, email and bcrypt password.
  assert.match(promotion, /const data = \{\s+id: source\.id,\s+subject: source\.id,\s+email: textOrNull\(source\.email\),/);
  assert.match(promotion, /password_algorithm: passwordHash \? 'bcrypt_legacy' : null,/);
  assert.match(promotion, /legacy_identity_user_id: source\.id,/);
  // Active only with a confirmed HID 1.0 email; otherwise pending_reset, which the bootstrap refuses.
  assert.match(promotion, /return source\.deleted_at \? 'deleted' : source\.email_confirmed_at \? 'active' : 'pending_reset';/);
  // A legacy platform_admin membership is held and grants no role.
  assert.match(promotion, /source\.app_role === 'platform_admin'\s+\? 'privileged_role_requires_reapproval'/);
  assert.match(promotion, /if \(source\.facility_id && source\.app_role !== 'platform_admin'\) \{/);
  // Platform sign-in accepts the HID 1.0 password; the bootstrap counts only platform role grants.
  assert.match(localAuth, /\['argon2id', 'bcrypt_legacy'\]\.includes\(account\.password_algorithm/);
  assert.match(bootstrap, /join auth\.account_roles assignment on assignment\.account_id = account\.id/);
});

test('the new-instance provisioning order has no admin:bootstrap step', () => {
  const rows = provisioningTask.split('\n').filter((line) => /^\| \d+ \|/.test(line));
  assert.ok(rows.length >= 7, 'the order table');
  for (const row of rows) assert.doesNotMatch(row, /admin:bootstrap/, row.slice(0, 40));
});

test('the runbooks run the account ID form only once its accounts exist, and the email form once the services and SES are live', () => {
  for (const [name, text] of [['provisioning task', provisioningTask], ['migration task', migrationTask]]) {
    assert.match(flat(text), /`PLATFORM_ADMIN_ACCOUNT_IDS`[^.]*only once the (?:two or three )?accounts it names exist/,
      `${name}: the account ID form waits for its accounts`);
    assert.match(flat(text), /HID 1\.0 promotion of §6/, `${name}: names where existing accounts come from`);
    assert.match(flat(text), /`PLATFORM_ADMIN_EMAILS`[^.]*after the services and SES are live/,
      `${name}: the email form creates the accounts once a reset code can be delivered`);
  }
  const legacy = flat(legacyMigration);
  assert.match(legacy, /`admin:bootstrap`/, '§6 runs the bootstrap after the promotion');
  assert.match(legacy, /`privileged_role_requires_reapproval`/);
  assert.ok(legacy.indexOf('`admin:bootstrap`') > legacy.indexOf('promote idempotently'),
    '§6 names the bootstrap after the promotion');
});

test('SUPER_ADMIN_FOUNDATION.md and P6 say where the accounts and their UUIDs come from', () => {
  const text = flat(foundation);
  assert.match(text, /HID 1\.0 promotion/);
  assert.match(text, /`privileged_role_requires_reapproval`/);
  assert.match(text, /HID 1\.0 auth user ID/, 'the UUID source');
  assert.match(text, /never (?:by )?guess/i, 'never a UUID guessed from an email');
  assert.match(text, /confirmed (?:its |their )?email in HID 1\.0|email confirmed in HID 1\.0/, 'active only once confirmed');
  assert.match(text, /SUPERADMIN-ACCOUNTS/);
  assert.match(p6, /HID 1\.0 promotion/);
  assert.match(p6, /HID 1\.0 auth user ID/);
  const row = decisions.split('\n').find((line) => line.startsWith('| SUPERADMIN-ACCOUNTS |'));
  assert.ok(row, 'PHASE_3_LAUNCH_DECISIONS.md records the question');
  assert.match(row, /\*\*Decided by the owner 2026-10-16/);
});

test('a runtime password is changed in place and running tasks keep the value they started with', () => {
  assert.match(provisioning, /await admin\.query\(`alter role \$\{identifier\(login\.user\)\} with password \$\{verifier\}`\);/);
  assert.match(regionalStack, /output\[databaseField\] = ecs\.Secret\.fromSecretsManager\(secrets\[`\$\{name\}Database`\]!, 'url'\);/);
  assert.match(workloads, /'ocr-worker': worker\('ocr-worker',/);
  assert.doesNotMatch(workloads.slice(workloads.indexOf('function worker(')), /healthPath/,
    'a worker() workload (ocr-worker) has no health check');
});

test('rotating a runtime secret replaces the service\'s running tasks after step 6, then runs step 7', () => {
  const text = flat(provisioningTask);
  const start = text.search(/To rotate a runtime secret/);
  assert.ok(start >= 0, 'the rotation procedure');
  const procedure = text.slice(start, text.indexOf('Require exit code', start));
  const step6 = procedure.indexOf('step 6');
  const redeploy = procedure.indexOf('--force-new-deployment');
  const step7 = procedure.indexOf('step 7');
  assert.ok(step6 >= 0 && redeploy > step6 && step7 > redeploy, 'step 6, then the new deployment, then step 7');
  assert.match(procedure, /aws ecs update-service --cluster hid-<environment> --service hid-<environment>-<workload> --force-new-deployment/);
  assert.match(procedure, /`ocr-worker`/, 'names the worker that never replaces itself');
  assert.match(procedure, /old password at once/);
  const verifyLogins = flat(section(migrationRunbook, '### 6.3 Runtime LOGINs', '\n## 7. '));
  assert.match(verifyLogins, /after every credential rotation[^.]*\. [^.]*running tasks/,
    'MIGRATION_RUNBOOK.md §6.3 replaces the running tasks after a rotation');
});
