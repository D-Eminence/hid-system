// Termii sends on the route the message names: `generic`, which Termii
// documents as promotional (it warns that OTP on it may fail or be blocked,
// and it does not reach a number on the Do-Not-Disturb register), or `dnd`,
// the transactional route an account must have activated for its sender ID
// (STAGING_PROVIDER_ACCOUNTS.md). notification-api's TERMII_CHANNEL defaults
// to `generic`, the regional stack does not set it, and the only production
// control is the Termii integration configuration (`channel`), which Identity
// passes with each send. P18 opened NIN_HOLDER_SMS_ENABLED once one test
// handset received a code: on `generic` that passes on a handset without DND
// while every holder whose registry phone has DND gets no code.
//
// These checks hold the release checklist (P18) and the production launch
// plan (AWS_DEPLOYMENT_RUNBOOK.md §13) to that code: while production leaves
// TERMII_CHANNEL at `generic`, both require Termii's DND route for the sender
// ID, the integration configuration set to `dnd` through the audited admin
// route before NIN_HOLDER_SMS_ENABLED, and the test SMS on a handset with DND
// active.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repository = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(join(repository, path), 'utf8');
const flat = (text) => text.replace(/\s+/g, ' ');

const notificationEnvironment = read('services/notification-api/src/config/environment.ts');
const notificationService = read('services/notification-api/src/notification/notification.service.ts');
const integrationAdmin = read('services/identity-api/src/integrations/integration-admin.service.ts');
const regionalStack = read('infra/aws/src/hid-regional-stack.ts');
const checklist = read('docs/PHASE_4_STAGE_5_RELEASE_READINESS.md');
const runbook = read('docs/AWS_DEPLOYMENT_RUNBOOK.md');

const p18 = flat(checklist.split('\n').find((line) => line.startsWith('| P18 |')) ?? '');
const launchPlan = flat(runbook.slice(runbook.indexOf('\n## 13. '), runbook.indexOf('\n## 14. ') > 0
  ? runbook.indexOf('\n## 14. ') : undefined));

test('production leaves Termii on its promotional route unless the integration configuration says dnd', () => {
  assert.match(notificationEnvironment, /TERMII_CHANNEL: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(32\)\.default\('generic'\)/);
  assert.match(integrationAdmin, /termii: \{ senderId: .*, channel: \/\^\(generic\|dnd\)\$\/ \}/);
  assert.match(notificationService, /configuration\.channel \? \{ TERMII_CHANNEL: configuration\.channel \}/);
  assert.doesNotMatch(regionalStack, /TERMII_CHANNEL/, 'the regional stack sets TERMII_CHANNEL: revisit P18 and §13');
});

for (const [name, text] of [['release checklist P18', p18], ['AWS_DEPLOYMENT_RUNBOOK.md §13', launchPlan]]) {
  test(`${name} requires Termii's DND route before NIN_HOLDER_SMS_ENABLED`, () => {
    assert.ok(text.length > 0, `${name} is missing`);
    assert.match(text, /DND/, `${name} names Termii's DND (transactional) route`);
    assert.match(text, /`generic`[^.]*promotional/, `${name} says the default route is promotional`);
    assert.match(text, /`POST \/api\/v1\/admin\/integrations\/termii\/configuration`/,
      `${name} names the audited configuration route`);
    assert.match(text, /"channel": ?"dnd"/, `${name} sets the channel to dnd`);
    assert.match(text, /handset (?:with|that has) DND (?:active|on)/, `${name} tests on a handset with DND active`);
    const configured = text.search(/"channel": ?"dnd"/);
    const enabled = text.indexOf('NIN_HOLDER_SMS_ENABLED', configured);
    assert.ok(enabled > configured, `${name} sets the channel before NIN_HOLDER_SMS_ENABLED`);
  });
}
