#!/usr/bin/env node
// Offline configuration plan only: no SDK, network, process execution or secret reads.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateJourneyInput } from './prepare-staging-journey-fixture.mjs';

const require = createRequire(new URL('../release/package.json', import.meta.url));
const duplicateKeyJson = require('json-dup-key-validator');
const localRoot = resolve(import.meta.dirname, '../release/local');
const account = '659225405023', region = 'eu-west-1';
const hosts = { us: 'https://api.novu.co', eu: 'https://eu.api.novu.co' };
export const workflowEvents = Object.freeze({
  'patient-update-v1': ['EmergencyAccessActivated', 'LabResultReleased', 'MedicationDispensed'],
  'identity-registration-update-v1': ['PatientRegistered'],
  'identity-resolution-update-v1': ['PatientIdentityResolved', 'OutreachPatientResolved'],
  'document-update-v1': ['OcrPublicationSucceeded'],
});
function check(value) { if (!value) throw new Error('Staging notification preparation rejected'); }
function exact(value, keys) {
  check(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join() === [...keys].sort().join());
}
function email(value) {
  if (value === null) return null;
  check(typeof value === 'string' && value.length <= 254
    && /^[A-Za-z0-9][A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]*@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value)
    && !value.includes('..'));
  return value.toLowerCase();
}
function nullableId(value) {
  check(value === null || (typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)));
}

export function planStagingNotifications(input, journey) {
  exact(input, ['schema_version', 'environment', 'aws_account_id', 'aws_region', 'ses_from_address', 'novu', 'message_authorizations']);
  check(input.schema_version === 'hid.staging-notification-input/v1' && input.environment === 'staging'
    && input.aws_account_id === account && input.aws_region === region);
  exact(input.novu, ['region', 'organization_id', 'environment_id', 'isolated_staging_environment_confirmed',
    'email_channel', 'demo_account_email', 'ses_connector_credential_design_approved']);
  const novu = input.novu;
  check(novu.region === null || Object.hasOwn(hosts, novu.region));
  check([null, 'demo-email', 'amazon-ses'].includes(novu.email_channel));
  nullableId(novu.organization_id); nullableId(novu.environment_id);
  for (const field of ['isolated_staging_environment_confirmed', 'ses_connector_credential_design_approved']) check(typeof novu[field] === 'boolean');
  exact(input.message_authorizations, ['ses_identity_verification_emails', 'recovery_otp_to_controlled_inboxes', 'novu_notification_to_controlled_patient']);
  for (const value of Object.values(input.message_authorizations)) check(typeof value === 'boolean');
  check(journey && typeof journey.controlled_test_recipients_confirmed === 'boolean');
  const patientEmail = email(journey.patient_email), staffEmail = email(journey.staff_email);
  // Validate the existing journey contract even while its nullable contacts are unselected.
  // These reserved syntax-only sentinels never enter the plan or a provider request.
  validateJourneyInput({ ...journey, controlled_test_recipients_confirmed: true,
    patient_email: patientEmail ?? 'unselected-patient@example.invalid', staff_email: staffEmail ?? 'unselected-staff@example.invalid' });
  const sender = email(input.ses_from_address), demoEmail = email(novu.demo_account_email);
  check(novu.email_channel === 'demo-email' || demoEmail === null);
  check(novu.email_channel === 'amazon-ses' || novu.ses_connector_credential_design_approved === false);
  if (novu.email_channel === 'demo-email' && demoEmail && patientEmail) check(demoEmail === patientEmail);

  const userInput = [];
  function missing(code, complete, stage) { if (!complete) userInput.push({ code, blocks: stage }); }
  missing('select_ses_from_address', sender, 'functional_deployment');
  missing('select_novu_region', novu.region, 'functional_deployment');
  missing('select_novu_staging_organization_and_environment', novu.organization_id && novu.environment_id, 'functional_deployment');
  missing('confirm_novu_environment_is_isolated_staging', novu.isolated_staging_environment_confirmed, 'functional_deployment');
  missing('select_novu_email_channel', novu.email_channel, 'delivery_acceptance');
  missing('select_two_controlled_inboxes', patientEmail && staffEmail, 'browser_and_delivery_acceptance');
  missing('confirm_control_of_selected_inboxes', patientEmail && staffEmail && journey.controlled_test_recipients_confirmed, 'browser_and_delivery_acceptance');
  if (novu.email_channel === 'demo-email') missing('confirm_demo_account_inbox_matches_patient_inbox', demoEmail && patientEmail, 'delivery_acceptance');
  if (novu.email_channel === 'amazon-ses') missing('approve_separate_novu_ses_connector_credential_design', novu.ses_connector_credential_design_approved, 'delivery_acceptance');
  // Mail authorization is separate from owning a contact, and never authorizes a deployment.
  for (const [key, authorized] of Object.entries(input.message_authorizations)) missing(`authorize_${key}`, authorized, 'corresponding_message_test_only');

  const configured = {
    NOTIFICATION_PROVIDER_MODE: 'live', NOTIFICATION_DELIVERY_PROFILE: 'email-only', AWS_REGION: region,
    SES_FROM_ADDRESS: sender, NOVU_MODE: 'live', NOVU_API_URL: novu.region ? hosts[novu.region] : null,
  };
  return {
    schema_version: 'hid.staging-notification-plan/v1', environment: 'staging', status: 'PREPARED_OFFLINE_ONLY',
    target: { aws_account_id: account, aws_region: region },
    deployment_authorized: false, provider_mutations_performed: false, messages_sent: false, provider_configuration_verified: false,
    proposed_runtime_configuration: configured,
    staging_cloudformation_parameters: { StagingNovuApiUrl: configured.NOVU_API_URL },
    secret_configuration: { secret_id: '/hid/staging/notification-provider', format: 'JSON',
      required_fields: ['sesFromAddress', 'novuApiKey'], values_included: false,
      instruction: 'Use the staging Secrets Manager console to merge the approved sender and environment secret key; preserve existing fields. Never place keys in this input or shell arguments.' },
    ses: { identity: 'HID Notification API ECS task role', runtime_actions: ['ses:SendEmail'],
      requires_static_aws_credentials: false, sender, sandbox_recipients: [patientEmail, staffEmail].filter(Boolean),
      checks: ['Read current regional sandbox and sending status', 'Verify the approved sender identity',
        'If sandboxed, verify both controlled recipient identities before recovery tests',
        'Review runtime IAM identity and recipient restrictions against verified identities'] },
    novu: { ...novu, api_url: configured.NOVU_API_URL,
      connector_inherits_hid_ecs_task_role: false,
      separate_ses_connector_credentials_required: novu.email_channel === 'amazon-ses',
      subscriber: { canonical_patient_uuid: null, email: patientEmail,
        identity_source: 'Accepted staging journey manifest.ids.patient; never the authentication account UUID' },
      workflows: Object.entries(workflowEvents).map(([identifier, events]) => ({ identifier, events, channel: 'email',
        message: 'You have a new update in HID. Sign in securely to view it.' })),
      checks: ['Read the actual selected organization and environment before any configuration changes',
        'Inspect existing workflow IDs and active email integration before proposing modifications',
        'Bind subscriber to the accepted synthetic patient UUID and its controlled inbox',
        'Record provider acceptance, delivery activity, inbox receipt and duplicate/retry results separately'] },
    message_authorizations: { ...input.message_authorizations },
    user_input_required: userInput,
    operator_prerequisites: ['Securely bind the selected Novu environment key after authorization',
      'Inspect actual SES identities and Novu environment/workflows/integration',
      'Prepare and approve the synthetic journey fixture before binding its canonical patient UUID',
      'Set the existing staging template parameter StagingNovuApiUrl to the confirmed Novu API URL',
      'Require applied AWS capacity, release admission and all staging deployment gates before deployment',
      'Perform each approved message test only after its service, identity and delivery prerequisites pass'],
    provider_classification: { AWS_SES: 'REQUIRED', Novu: 'REQUIRED', Termii: 'OPTIONAL', Meta_WhatsApp: 'OPTIONAL', Infobip: 'FALLBACK' },
  };
}

async function privateFile(path, root) {
  check(isAbsolute(path) && resolve(path) === path && dirname(path) === root && await realpath(path) === path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    check(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600 && stat.size > 0 && stat.size <= 8192);
    const bytes = await handle.readFile();
    check(bytes.length === stat.size);
    return duplicateKeyJson.parse(bytes.toString('utf8'), false);
  } finally { await handle.close(); }
}

// Root override is only for isolated filesystem tests; the CLI pins this checkout.
export async function prepareStagingNotifications(inputPath, journeyPath, outputPath, { root = localRoot } = {}) {
  check(isAbsolute(root) && resolve(root) === root && root.endsWith(`${sep}release${sep}local`));
  const stat = await lstat(root);
  check(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid()
    && (stat.mode & 0o777) === 0o700 && await realpath(root) === root);
  check(isAbsolute(outputPath) && resolve(outputPath) === outputPath && dirname(outputPath) === root
    && /^staging-notification-plan-[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.json$/.test(basename(outputPath)));
  const input = await privateFile(inputPath, root), journey = await privateFile(journeyPath, root);
  const plan = planStagingNotifications(input, journey);
  const bytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`);
  const output = await open(outputPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await output.chmod(0o600); await output.writeFile(bytes); await output.sync(); }
  finally { await output.close(); }
  return { schema_version: 'hid.staging-notification-plan-summary/v1', status: plan.status,
    plan_sha256: createHash('sha256').update(bytes).digest('hex'),
    user_input_required: plan.user_input_required, provider_configuration_verified: false, deployment_authorized: false, messages_sent: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    check(process.argv.length === 5);
    process.stdout.write(`${JSON.stringify(await prepareStagingNotifications(...process.argv.slice(2)), null, 2)}\n`);
  } catch {
    process.stderr.write('Staging notification preparation rejected; use non-secret inputs and new private paths under release/local.\n');
    process.exitCode = 1;
  }
}
