import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { planCloudflareReadiness, prepareCloudflareReadiness } from '../scripts/prepare-staging-readiness.mjs';

async function sources() {
  const configs = {};
  for (const app of ['web', 'ehr', 'lab', 'pharmacy', 'ocr', 'outreach', 'admin', 'legacyOcrRedirect', 'updates']) {
    const relative = app === 'updates' ? '../workers/hid-tuf-staging/wrangler.json'
      : app === 'legacyOcrRedirect' ? '../workers/hid-ocr-redirect/wrangler.json'
        : `../workers/hid-${app}/wrangler.json`;
    configs[app] = JSON.parse(await readFile(new URL(relative, import.meta.url)));
  }
  const manifest = JSON.parse(await readFile(new URL('../launch-deployment.json', import.meta.url)));
  return { configs, manifest };
}

const NOT_DEPLOYED = ['hid-ehr-staging', 'hid-lab-staging', 'hid-pharmacy-staging', 'hid-ocr-staging',
  'hid-outreach-staging', 'hid-ocr-redirect-staging'];

test('plan binds only the launch staging Workers and preserves unresolved external targets', async () => {
  const plan = await prepareCloudflareReadiness();
  assert.deepEqual(plan.frontends.map(frontend => [frontend.worker, frontend.hostname]), [
    ['hid-web-staging', 'staging.healthidentitydirectory.com'],
    ['hid-admin-staging', 'admin.staging.healthidentitydirectory.com'],
  ]);
  for (const frontend of plan.frontends) {
    const worker = frontend.worker.replace(/-staging$/, '');
    assert.equal(frontend.asset_source, 'health-id-patient-web');
    assert.equal(frontend.assets_directory, `infra/cloudflare/workers/${worker}/staged/staging/site`);
    assert.match(frontend.stage_command, new RegExp(`stage-health-id-build\\.mjs --worker ${worker} --environment staging`));
    assert.equal(frontend.origin_secret_binding, 'ORIGIN_AUTH_TOKEN');
  }
  assert.deepEqual(plan.not_deployed.map(entry => entry.worker), NOT_DEPLOYED);
  for (const entry of plan.not_deployed) assert.match(entry.reason, /\S/);
  assert.equal(plan.legacy_ocr_redirect, undefined, 'the legacy OCR redirect is not deployed at launch');
  assert.equal(plan.dns.inventory_required.length, 10);
  assert.equal(plan.dns.api.content, null);
  assert.equal(plan.publisher_secret.arn, null);
  assert.equal(plan.turnstile.sitekey, null);
  assert.equal(plan.turnstile.public_build_setting, 'VITE_HID_TURNSTILE_SITE_KEY');
  assert.deepEqual(plan.turnstile.proposed_create_body.domains,
    ['staging.healthidentitydirectory.com', 'admin.staging.healthidentitydirectory.com']);
  assert.match(plan.origin_auth.destinations[0], /hid-web-staging.*hid-admin-staging/);
  assert.equal(plan.deployment_authorized, false);
  assert.equal(plan.dns.nameserver_or_apex_changes, false);
  assert.equal(plan.publisher_secret.format, 'raw SecretString, not JSON');
  assert.equal(Object.keys(plan.source_sha256).length, 10);
  assert.ok(Object.hasOwn(plan.source_sha256, 'infra/cloudflare/launch-deployment.json'));

  // Every staging host is read; a binding on a host that is not deployed is a finding.
  const expectedWorkers = new Map([
    ...plan.frontends.map(frontend => [frontend.hostname, frontend.worker]),
    ...plan.not_deployed.map(entry => [entry.hostname, null]),
    [plan.release_repository.hostname, plan.release_repository.worker]]);
  assert.equal(plan.dns.custom_domain_reads_required.length, expectedWorkers.size);
  assert.equal(expectedWorkers.size, 9);
  for (const read of plan.dns.custom_domain_reads_required) {
    assert.equal(read.method, 'GET');
    const url = new URL(read.path, 'https://api.cloudflare.com');
    assert.equal(url.pathname, `/accounts/${plan.account_id}/workers/domains`);
    assert.deepEqual([...url.searchParams.keys()].sort(), ['hostname', 'zone_id']);
    assert.equal(url.searchParams.get('zone_id'), plan.zone_id);
    assert.equal(url.searchParams.get('hostname'), read.hostname);
    assert.ok(expectedWorkers.has(read.hostname), `${read.hostname} is not a staging host`);
    assert.equal(read.expected_worker, expectedWorkers.get(read.hostname));
    assert.equal(read.expect_no_binding, expectedWorkers.get(read.hostname) === null);
    expectedWorkers.delete(read.hostname);
  }
  assert.equal(expectedWorkers.size, 0);
});

test('rejects production routes, altered API origin, fallback default environments and a widened launch set', async () => {
  for (const change of [c => { c.configs.web.env.staging.routes[0].pattern = 'www.healthidentitydirectory.com'; },
    c => { c.configs.ehr.env.staging.vars.API_ORIGIN = 'https://api.healthidentitydirectory.com'; },
    c => { c.configs.web.routes = c.configs.web.env.production.routes; },
    c => { c.configs.updates.name = 'hid-tuf-production'; },
    c => { c.configs.legacyOcrRedirect.env.staging.vars.TARGET_ORIGIN = 'https://attacker.example'; },
    c => { c.configs.admin.env.staging.assets.directory = '../../../../apps/admin/dist'; },
    c => { c.configs.web.assets = { directory: '../../../../apps/web/dist', binding: 'ASSETS' }; },
    c => {
      c.manifest.environments.staging.not_deployed = c.manifest.environments.staging.not_deployed.filter(e => e.worker !== 'hid-lab');
      c.manifest.environments.staging.deploy.push({ worker: 'hid-lab', host: 'lab.staging.healthidentitydirectory.com', assets: 'health-id-patient-web', proxies_api: true });
    }]) {
    const source = await sources(); change(source);
    assert.throws(() => planCloudflareReadiness(source.configs, source.manifest));
  }
});

test('widget action plan matches the existing staging Identity validation allowlist for the launch hosts', async () => {
  const plan = await prepareCloudflareReadiness();
  const identity = await readFile(new URL('../../../services/identity-api/src/auth/turnstile.service.ts', import.meta.url), 'utf8');
  const block = identity.match(/staging: deploymentActions\(\{([\s\S]*?)\}\),/)[1];
  const actual = Object.fromEntries([...block.matchAll(/'([^']+)': \[([\s\S]*?)\]/g)].map(x => [x[1], [...x[2].matchAll(/'([^']+)'/g)].map(m => m[1])]));
  const launchHosts = plan.frontends.map(frontend => frontend.hostname);
  assert.deepEqual(plan.turnstile.browser_actions, Object.fromEntries(launchHosts.map(host => [host, actual[host]])));
  assert.deepEqual(plan.turnstile.proposed_create_body.domains, launchHosts);
  assert.deepEqual(plan.turnstile.browser_actions['admin.staging.healthidentitydirectory.com'], ['admin-login', 'admin-reset']);
});
