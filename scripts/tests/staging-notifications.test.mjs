import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, stat, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planStagingNotifications, prepareStagingNotifications, workflowEvents } from '../prepare-staging-notifications.mjs';

const input = JSON.parse(await readFile(new URL('../../release/config/staging-notification-input.template.json', import.meta.url)));
const journey = JSON.parse(await readFile(new URL('../../release/config/staging-journey-input.template.json', import.meta.url)));
const contacts = { ...journey, patient_email: 'patient@example.invalid', staff_email: 'staff@example.invalid', controlled_test_recipients_confirmed: true };
const selected = () => ({ ...structuredClone(input), ses_from_address: 'sender@example.invalid', novu: {
  region: 'eu', organization_id: 'test-org', environment_id: 'test-env', isolated_staging_environment_confirmed: true,
  email_channel: 'demo-email', demo_account_email: contacts.patient_email, ses_connector_credential_design_approved: false } });

test('unselected inputs produce preparation, with no fabricated subscribers or delivery approval', () => {
  const plan = planStagingNotifications(input, journey);
  assert.equal(plan.novu.subscriber.canonical_patient_uuid, null);
  assert.equal(plan.proposed_runtime_configuration.NOVU_API_URL, null);
  assert.equal(plan.messages_sent, false);
  assert.equal(plan.deployment_authorized, false);
  assert(plan.user_input_required.some(x => x.code === 'select_two_controlled_inboxes'));
  assert.equal(JSON.stringify(plan).includes('example.invalid'), false);
});

test('owning contacts does not authorize sends and EU selection uses the actual worker setting', () => {
  const plan = planStagingNotifications(selected(), contacts);
  assert.equal(plan.proposed_runtime_configuration.NOVU_API_URL, 'https://eu.api.novu.co');
  assert.deepEqual(plan.staging_cloudformation_parameters, { StagingNovuApiUrl: 'https://eu.api.novu.co' });
  assert.equal(plan.ses.requires_static_aws_credentials, false);
  assert.equal(plan.novu.connector_inherits_hid_ecs_task_role, false);
  assert.equal(plan.user_input_required.filter(x => x.code.startsWith('authorize_')).length, 3);
  assert.equal(plan.provider_configuration_verified, false);
});

test('demo delivery refuses a different inbox; SES connector requires separate design approval', () => {
  const data = selected(); data.novu.demo_account_email = 'other@example.invalid';
  assert.throws(() => planStagingNotifications(data, contacts));
  data.novu.demo_account_email = null; data.novu.email_channel = 'amazon-ses';
  const plan = planStagingNotifications(data, contacts);
  assert.equal(plan.novu.separate_ses_connector_credentials_required, true);
  assert(plan.user_input_required.some(x => x.code === 'approve_separate_novu_ses_connector_credential_design'));
});

test('rejects secrets, production/account drift, unknown endpoints, duplicate contacts and nonboolean approval', () => {
  const mutations = [d => {d.apiKey = 'must-never-enter-plan';}, d => {d.environment = 'production';},
    d => {d.aws_account_id = '000000000000';}, d => {d.aws_region = 'us-east-1';},
    d => {d.novu.region = 'https://attacker.invalid';}, d => {d.novu.novuApiKey = 'private';},
    d => {d.message_authorizations.recovery_otp_to_controlled_inboxes = 'true';}];
  for (const mutate of mutations) { const data = selected(); mutate(data); assert.throws(() => planStagingNotifications(data, contacts)); }
  assert.throws(() => planStagingNotifications(selected(), { ...contacts, staff_email: contacts.patient_email.toUpperCase() }));
});

test('prepared workflow IDs and events exactly match runtime event contract', async () => {
  const source = await readFile(new URL('../../services/notification-worker/src/event.ts', import.meta.url), 'utf8');
  const actual = Object.fromEntries([...source.matchAll(/^  (\w+): '([a-z-]+-v1)',/gm)].map(x => [x[1], x[2]]));
  assert.deepEqual(Object.fromEntries(Object.entries(workflowEvents).flatMap(([id, events]) => events.map(event => [event, id]))), actual);
});

test('private planner rejects duplicate JSON, weak permissions and overwrite; console summary omits contacts', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'hid-notification-plan-'));
  try {
    const root = join(temp, 'release', 'local'); await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
    const inPath = join(root, 'input.json'), journeyPath = join(root, 'journey.json'), outPath = join(root, 'staging-notification-plan-test.json');
    await writeFile(inPath, JSON.stringify(selected()), { mode: 0o600 });
    await writeFile(journeyPath, JSON.stringify(contacts), { mode: 0o600 });
    const summary = await prepareStagingNotifications(inPath, journeyPath, outPath, { root });
    assert.equal((await stat(outPath)).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(summary).includes('@'), false);
    await assert.rejects(prepareStagingNotifications(inPath, journeyPath, outPath, { root }));
    await writeFile(inPath, '{"environment":"staging","environment":"production"}');
    await assert.rejects(prepareStagingNotifications(inPath, journeyPath, join(root, 'staging-notification-plan-duplicate.json'), { root }));
    await writeFile(inPath, JSON.stringify(selected())); await chmod(inPath, 0o644);
    await assert.rejects(prepareStagingNotifications(inPath, journeyPath, join(root, 'staging-notification-plan-permissions.json'), { root }));
  } finally { await rm(temp, { recursive: true, force: true }); }
});
