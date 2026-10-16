#!/usr/bin/env node
// Offline source-bound preparation. No credential access, network or mutation API.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HEALTH_ID_ARTIFACT_SOURCE, HEALTH_ID_WORKERS, assertHealthIdWorkerConfig, assertLaunchManifest,
} from './launch-manifest.mjs';

const root = resolve(import.meta.dirname, '../../..');
const domain = 'healthidentitydirectory.com';
const apps = ['web', 'ehr', 'lab', 'pharmacy', 'ocr', 'outreach', 'admin'];
const host = app => app === 'web' ? `staging.${domain}` : app === 'ocr' ? `migrate.staging.${domain}` : `${app}.staging.${domain}`;
const legacyOcrHost = `ocr.staging.${domain}`;
const apiHost = `api.staging.${domain}`;
// Identity's staging Turnstile allowlist (services/identity-api/src/auth/turnstile-actions.ts).
const stagingActions = Object.freeze({
  [host('web')]: ['patient-login', 'staff-login', 'admin-login', 'patient-reset-start', 'staff-reset', 'admin-reset', 'legacy-recovery', 'book-demo', 'organization-application', 'organization-completion', 'patient-enrollment', 'provider-enrollment', 'clinician-application', 'clinician-application-status'],
  [host('ehr')]: ['ehr-login', 'staff-login'], [host('lab')]: ['lab-login'], [host('pharmacy')]: ['pharmacy-login'],
  [host('ocr')]: ['ocr-login'], [host('outreach')]: ['outreach-login'], [host('admin')]: ['admin-login', 'admin-reset'],
});

// The staging plan covers the launch subset only (ADR-052, launch-deployment.json):
// the Health-id web and admin Workers are deployed; every other staging host is
// inventoried so that a binding on a host that is not deployed is a finding.
export function planCloudflareReadiness(configs, manifest) {
  assert.deepEqual(Object.keys(configs).sort(), [...apps, 'legacyOcrRedirect', 'updates'].sort(), 'Exact staging worker set required');
  assertLaunchManifest(manifest, {
    ...Object.fromEntries(apps.map(app => [`hid-${app}`, configs[app]])),
    'hid-ocr-redirect': configs.legacyOcrRedirect, 'hid-tuf-staging': configs.updates,
  }, { environments: ['staging'] });
  const launch = manifest.environments.staging;
  const deployed = new Set(launch.deploy.map(entry => entry.worker));
  const reasons = Object.fromEntries(launch.not_deployed.map(entry => [entry.worker, entry.reason]));
  const checked = apps.map(app => {
    const config = configs[app]; const stage = config.env?.staging; const worker = `hid-${app}`;
    assert.equal(stage?.name, `${worker}-staging`, 'Staging worker identity required');
    assert.deepEqual(stage.routes, [{ pattern: host(app), custom_domain: true }], 'Exact staging custom domain required');
    assert.deepEqual(stage.vars, { DEPLOYMENT_ENV: 'staging', API_ORIGIN: `https://${apiHost}`, EXPECTED_HOST: host(app), APP_NAME: app });
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
    assert.equal(config.routes, undefined, 'Explicit named environment required');
    assert.equal(config.vars, undefined, 'Explicit named environment required');
    if (HEALTH_ID_WORKERS.includes(worker)) assertHealthIdWorkerConfig(worker, config);
    else assert.equal(config.assets?.directory, `../../../../apps/${app}/dist`);
    return { app, worker, stage };
  });
  const frontends = checked.filter(({ worker }) => deployed.has(worker)).map(({ app, worker, stage }) => ({
    app, worker: stage.name, hostname: host(app), environment: 'staging',
    config: `infra/cloudflare/workers/${worker}/wrangler.json`,
    asset_source: HEALTH_ID_ARTIFACT_SOURCE,
    assets_directory: `infra/cloudflare/workers/${worker}/staged/staging/site`,
    stage_command: `node infra/cloudflare/scripts/stage-health-id-build.mjs --worker ${worker} --environment staging --build <Health-id apps/patient-web/dist> --source-commit <40-hex Health-id commit>`,
    origin_secret_binding: 'ORIGIN_AUTH_TOKEN',
    dns_mode: 'Worker Custom Domain; Cloudflare creates DNS and certificate at authorized deployment' }));
  const legacyOcrRedirect = configs.legacyOcrRedirect;
  const legacyStage = legacyOcrRedirect.env?.staging;
  assert.equal(legacyOcrRedirect.name, 'hid-ocr-redirect');
  assert.equal(legacyStage?.name, 'hid-ocr-redirect-staging');
  assert.deepEqual(legacyStage?.routes, [{ pattern: legacyOcrHost, custom_domain: true }]);
  assert.deepEqual(legacyStage?.vars, {
    DEPLOYMENT_ENV: 'staging', EXPECTED_HOST: legacyOcrHost, TARGET_ORIGIN: `https://${host('ocr')}`,
  });
  assert.equal(legacyOcrRedirect.workers_dev, false);
  assert.equal(legacyOcrRedirect.preview_urls, false);
  assert.equal(legacyOcrRedirect.routes, undefined, 'Explicit named environment required');
  assert.equal(legacyOcrRedirect.vars, undefined, 'Explicit named environment required');
  const hostOf = Object.fromEntries([...apps.map(app => [`hid-${app}`, host(app)]), ['hid-ocr-redirect', legacyOcrHost]]);
  const notDeployed = launch.not_deployed.map(entry => ({
    worker: `${entry.worker}-staging`, hostname: hostOf[entry.worker],
    config: `infra/cloudflare/workers/${entry.worker}/wrangler.json`, reason: reasons[entry.worker] }));
  const updates = configs.updates;
  assert.equal(updates.name, 'hid-tuf-staging');
  assert.deepEqual(updates.routes, [{ pattern: host('updates'), custom_domain: true }]);
  assert.equal(updates.vars?.DEPLOYMENT_ENV, 'staging');
  assert.equal(updates.vars?.EXPECTED_HOST, host('updates'));
  return {
    schema_version: 'hid.staging-cloudflare-preparation/v1', status: 'PREPARED_OFFLINE_ONLY', environment: 'staging',
    account_id: '20c809ffe35ccb2c240d19a664dff97a', zone_id: '69d385b9f6a3233a7113c525524f14fe', zone_name: domain,
    cloud_calls: false, deployment_authorized: false, staging_accepted: false, production_changes: false,
    quota_hold_applies_to_all_deployments: true,
    frontends,
    not_deployed: notDeployed,
    api_route_closure: 'Deferred modules stay closed at the gateway (HID_ENABLED_API_ROUTES); a host that is not deployed does not close its API',
    release_repository: { worker: updates.name, hostname: host('updates'),
      config: 'infra/cloudflare/workers/hid-tuf-staging/wrangler.json',
      execution: 'Existing protected publication only; requires admitted signed repository and owner gate' },
    dns: { api: { name: apiHost, type: 'CNAME', content: null, proxied: null,
      source: 'Actual authorized staging ALB DNS readback; no placeholder target',
      requirement: 'Confirm API proxy/TLS choice against existing WAF/origin controls before completing record' },
      inventory_required: [host('web'), ...apps.filter(app => app !== 'web').map(host), legacyOcrHost, host('updates'), apiHost],
      custom_domain_reads_required: [...apps, 'legacyOcrRedirect', 'updates'].map(app => {
        const hostname = app === 'legacyOcrRedirect' ? legacyOcrHost : host(app);
        const worker = app === 'updates' ? updates.name : app === 'legacyOcrRedirect' ? 'hid-ocr-redirect' : `hid-${app}`;
        const expected = app === 'updates' ? updates.name : deployed.has(worker) ? `${worker}-staging` : null;
        return { method: 'GET', hostname, expected_worker: expected, expect_no_binding: expected === null,
          path: `/accounts/20c809ffe35ccb2c240d19a664dff97a/workers/domains?hostname=${hostname}&zone_id=69d385b9f6a3233a7113c525524f14fe` };
      }),
      do_not_precreate_cnames_for_worker_custom_domains: true,
      nameserver_or_apex_changes: false,
      conflict_policy: 'Read current staging records/custom domains first; do not replace unknown records' },
    turnstile: { inventory_path: '/accounts/20c809ffe35ccb2c240d19a664dff97a/challenges/widgets',
      proposed_create_body: { name: 'HID staging', mode: 'managed', domains: frontends.map(frontend => frontend.hostname) },
      sitekey: null, secret_value_included: false,
      secret_destination: { aws_account_id: '659225405023', region: 'eu-west-1',
        secret_id: '/hid/staging/identity-sensitive', json_field: 'turnstileSecretKey', preserve_existing_fields: true },
      public_build_setting: 'VITE_HID_TURNSTILE_SITE_KEY',
      runtime_validation: 'Existing Identity TurnstileService validates exact staging origin/hostname and action; retain replay rejection',
      browser_actions: Object.fromEntries(frontends.map(frontend => [frontend.hostname, stagingActions[frontend.hostname]])) },
    origin_auth: { value: null, generate_independent_staging_value: true,
      destinations: [`${frontends.length} named staging Worker ORIGIN_AUTH_TOKEN bindings (${frontends.map(frontend => frontend.worker).join(', ')})`,
        'StagingCloudflareOriginSecret WAF parameter'],
      expose_in_frontend_or_plan: false },
    minimum_authority: {
      inventory: ['DNS Read for this zone (also accepted by the initial zone read)', 'Workers Routes Read for this zone', 'Workers Scripts Read for this account', 'Turnstile Sites Read for this account'],
      setup: ['DNS Edit for this zone', 'Turnstile Sites Write for this account'],
      publisher: ['Workers Scripts Edit for this account', 'Workers Routes Edit for this zone'],
      scope_limitation: 'Account/zone permissions are not per-worker staging isolation; protected tooling must enforce exact staging names' },
    publisher_secret: { aws_account_id: '659225405023', region: 'eu-west-1',
      name_prefix: 'hid-staging-cloudflare-publisher-token-', format: 'raw SecretString, not JSON',
      arn: null, version_id: null, values_included: false,
      requirement: 'Discover ARN/version after secure entry, then bind exact version in existing publisher configuration' },
    live_checks_remaining: ['Authenticated account/zone and active authoritative DNS', 'Existing staging DNS/custom-domain conflicts',
      'Widget configuration and backend secret match', 'Real browser Siteverify success, wrong hostname/action and replay rejection',
      'TLS, Worker proxy, direct-origin denial and protected publication readback'],
  };
}

export async function prepareCloudflareReadiness() {
  const configs = {}, hashes = {};
  for (const app of [...apps, 'legacyOcrRedirect', 'updates']) {
    const path = app === 'updates' ? 'infra/cloudflare/workers/hid-tuf-staging/wrangler.json'
      : app === 'legacyOcrRedirect' ? 'infra/cloudflare/workers/hid-ocr-redirect/wrangler.json'
        : `infra/cloudflare/workers/hid-${app}/wrangler.json`;
    const bytes = await readFile(resolve(root, path));
    configs[app] = JSON.parse(bytes);
    hashes[path] = createHash('sha256').update(bytes).digest('hex');
  }
  const manifestPath = 'infra/cloudflare/launch-deployment.json';
  const manifestBytes = await readFile(resolve(root, manifestPath));
  hashes[manifestPath] = createHash('sha256').update(manifestBytes).digest('hex');
  return { ...planCloudflareReadiness(configs, JSON.parse(manifestBytes)), source_sha256: hashes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 2, 'No credential or target arguments accepted');
    process.stdout.write(`${JSON.stringify(await prepareCloudflareReadiness(), null, 2)}\n`);
  } catch { process.stderr.write('Staging Cloudflare preparation rejected; no cloud operation performed\n'); process.exitCode = 1; }
}
