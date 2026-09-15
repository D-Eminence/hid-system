import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { planCloudflareReadiness, prepareCloudflareReadiness } from '../scripts/prepare-staging-readiness.mjs';

async function sources() {
  const configs = {};
  for (const app of ['web', 'ehr', 'lab', 'pharmacy', 'ocr', 'outreach', 'admin', 'updates']) {
    configs[app] = JSON.parse(await readFile(new URL(app === 'updates' ? '../workers/hid-tuf-staging/wrangler.json' : `../workers/hid-${app}/wrangler.json`, import.meta.url)));
  }
  return configs;
}

test('plan binds all existing staging workers and preserves unresolved external targets', async () => {
  const plan = await prepareCloudflareReadiness();
  assert.equal(plan.frontends.length, 7);
  assert.equal(plan.dns.inventory_required.length, 9);
  assert.equal(plan.dns.api.content, null);
  assert.equal(plan.publisher_secret.arn, null);
  assert.equal(plan.turnstile.sitekey, null);
  assert.equal(plan.deployment_authorized, false);
  assert.equal(plan.dns.nameserver_or_apex_changes, false);
  assert.equal(plan.publisher_secret.format, 'raw SecretString, not JSON');
  assert.equal(Object.keys(plan.source_sha256).length, 8);
});

test('rejects production routes, altered API origin and fallback default environments', async () => {
  for (const change of [c => { c.web.env.staging.routes[0].pattern = 'www.healthidentitydirectory.com'; },
    c => { c.ehr.env.staging.vars.API_ORIGIN = 'https://api.healthidentitydirectory.com'; },
    c => { c.web.routes = c.web.env.production.routes; },
    c => { c.updates.name = 'hid-tuf-production'; }]) {
    const config = await sources(); change(config); assert.throws(() => planCloudflareReadiness(config));
  }
});

test('widget action plan matches the existing staging Identity validation allowlist', async () => {
  const plan = await prepareCloudflareReadiness();
  const identity = await readFile(new URL('../../../services/identity-api/src/auth/turnstile.service.ts', import.meta.url), 'utf8');
  const block = identity.match(/staging: deploymentActions\(\{([\s\S]*?)\}\),/)[1];
  const actual = Object.fromEntries([...block.matchAll(/'([^']+)': \[([\s\S]*?)\]/g)].map(x => [x[1], [...x[2].matchAll(/'([^']+)'/g)].map(m => m[1])]));
  assert.deepEqual(plan.turnstile.browser_actions, actual);
  assert.deepEqual(plan.turnstile.proposed_create_body.domains, Object.keys(actual));
});
