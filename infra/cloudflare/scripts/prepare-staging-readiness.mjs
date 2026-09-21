#!/usr/bin/env node
// Offline source-bound preparation. No credential access, network or mutation API.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '../../..');
const domain = 'healthidentitydirectory.com';
const apps = ['web', 'ehr', 'lab', 'pharmacy', 'ocr', 'outreach', 'admin'];
const host = app => app === 'web' ? `staging.${domain}` : `${app}.staging.${domain}`;
const apiHost = `api.staging.${domain}`;

export function planCloudflareReadiness(configs) {
  assert.deepEqual(Object.keys(configs).sort(), [...apps, 'updates'].sort(), 'Exact staging worker set required');
  const frontends = apps.map(app => {
    const config = configs[app]; const stage = config.env?.staging;
    assert.equal(stage?.name, `hid-${app}-staging`, 'Staging worker identity required');
    assert.deepEqual(stage.routes, [{ pattern: host(app), custom_domain: true }], 'Exact staging custom domain required');
    assert.deepEqual(stage.vars, { DEPLOYMENT_ENV: 'staging', API_ORIGIN: `https://${apiHost}`, EXPECTED_HOST: host(app), APP_NAME: app });
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
    assert.equal(config.routes, undefined, 'Explicit named environment required');
    assert.equal(config.vars, undefined, 'Explicit named environment required');
    assert.equal(config.assets?.directory, `../../../../apps/${app}/dist`);
    return { app, worker: stage.name, hostname: host(app), environment: 'staging',
      config: `infra/cloudflare/workers/hid-${app}/wrangler.json`, origin_secret_binding: 'ORIGIN_AUTH_TOKEN',
      dns_mode: 'Worker Custom Domain; Cloudflare creates DNS and certificate at authorized deployment' };
  });
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
    release_repository: { worker: updates.name, hostname: host('updates'),
      config: 'infra/cloudflare/workers/hid-tuf-staging/wrangler.json',
      execution: 'Existing protected publication only; requires admitted signed repository and owner gate' },
    dns: { api: { name: apiHost, type: 'CNAME', content: null, proxied: null,
      source: 'Actual authorized staging ALB DNS readback; no placeholder target',
      requirement: 'Confirm API proxy/TLS choice against existing WAF/origin controls before completing record' },
      inventory_required: [host('web'), ...apps.filter(app => app !== 'web').map(host), host('updates'), apiHost],
      custom_domain_reads_required: [...apps, 'updates'].map(app => ({
        method: 'GET', hostname: host(app), expected_worker: app === 'updates' ? updates.name : `hid-${app}-staging`,
        path: `/accounts/20c809ffe35ccb2c240d19a664dff97a/workers/domains?hostname=${host(app)}&zone_id=69d385b9f6a3233a7113c525524f14fe`,
      })),
      do_not_precreate_cnames_for_worker_custom_domains: true,
      nameserver_or_apex_changes: false,
      conflict_policy: 'Read current staging records/custom domains first; do not replace unknown records' },
    turnstile: { inventory_path: '/accounts/20c809ffe35ccb2c240d19a664dff97a/challenges/widgets',
      proposed_create_body: { name: 'HID staging', mode: 'managed', domains: apps.map(host) },
      sitekey: null, secret_value_included: false,
      secret_destination: { aws_account_id: '659225405023', region: 'eu-west-1',
        secret_id: '/hid/staging/identity-sensitive', json_field: 'turnstileSecretKey', preserve_existing_fields: true },
      public_build_setting: 'VITE_TURNSTILE_SITE_KEY',
      runtime_validation: 'Existing Identity TurnstileService validates exact staging origin/hostname and action; retain replay rejection',
      browser_actions: { [host('web')]: ['patient-login', 'staff-login', 'admin-login', 'patient-reset-start', 'staff-reset', 'admin-reset', 'legacy-recovery'],
        [host('ehr')]: ['ehr-login', 'staff-login'], [host('lab')]: ['lab-login'], [host('pharmacy')]: ['pharmacy-login'],
        [host('ocr')]: ['ocr-login'], [host('outreach')]: ['outreach-login'], [host('admin')]: ['admin-login', 'admin-reset'] } },
    origin_auth: { value: null, generate_independent_staging_value: true,
      destinations: ['Seven named staging Worker ORIGIN_AUTH_TOKEN bindings', 'StagingCloudflareOriginSecret WAF parameter'],
      expose_in_frontend_or_plan: false },
    minimum_authority: {
      inventory: ['Zone Read for this zone', 'DNS Read for this zone', 'Workers Routes Read for this zone', 'Workers Scripts Read for this account', 'Turnstile Sites Read for this account'],
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
  for (const app of [...apps, 'updates']) {
    const path = app === 'updates' ? 'infra/cloudflare/workers/hid-tuf-staging/wrangler.json' : `infra/cloudflare/workers/hid-${app}/wrangler.json`;
    const bytes = await readFile(resolve(root, path));
    configs[app] = JSON.parse(bytes);
    hashes[path] = createHash('sha256').update(bytes).digest('hex');
  }
  return { ...planCloudflareReadiness(configs), source_sha256: hashes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 2, 'No credential or target arguments accepted');
    process.stdout.write(`${JSON.stringify(await prepareCloudflareReadiness(), null, 2)}\n`);
  } catch { process.stderr.write('Staging Cloudflare preparation rejected; no cloud operation performed\n'); process.exitCode = 1; }
}
