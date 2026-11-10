import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Card links (0118): the receiver's public routes sit under one prefix,
// /api/v1/card-share/, so the view cookie's Path covers nothing else. Each is
// rate limited per client address (a flood guard; the per-link limits in the
// database are the real control, since carrier NAT shares addresses), takes
// at most 1 KB of body, and the link's token travels only in a POST body,
// never in a path. Mixed case and trailing slashes cannot skip a limit.
const config = await readFile(new URL('../../gateway/nginx.conf.template', import.meta.url), 'utf8');

function location(selector) {
  const start = config.indexOf(`location ${selector} {`);
  assert.notEqual(start, -1, `missing location ${selector}`);
  return config.slice(start, config.indexOf('\n  }', start));
}

test('declares the two card-share zones keyed by the client address', () => {
  assert.match(config, /^limit_req_zone \$binary_remote_addr zone=hid_card_code:1m rate=10r\/m;$/m);
  assert.match(config, /^limit_req_zone \$binary_remote_addr zone=hid_card_view:1m rate=30r\/m;$/m);
});

test('code and verify: POST only, 10 a minute (burst 3), 1 KB, to Identity', () => {
  for (const path of ['code', 'verify']) {
    const block = location(`= /api/v1/card-share/${path}`);
    assert.match(block, /limit_except POST \{ deny all; \}/);
    assert.match(block, /limit_req zone=hid_card_code burst=3 nodelay;/);
    assert.match(block, /limit_req_status 429;/);
    assert.match(block, /client_max_body_size 1k;/);
    assert.match(block, /proxy_pass \$hid_identity_upstream;/);
  }
});

test('records: GET only, to the EHR API, under the view limit', () => {
  const block = location('= /api/v1/card-share/records');
  assert.match(block, /limit_except GET \{ deny all; \}/);
  assert.match(block, /limit_req zone=hid_card_view burst=10 nodelay;/);
  assert.match(block, /proxy_pass \$hid_ehr_upstream;/);
});

test('every other card-share route goes to Identity under the view limit, aliases of the exact routes refused', () => {
  const block = location('^~ /api/v1/card-share/');
  assert.match(block, /if \(\$uri ~\* "\^\/api\/v1\/card-share\/\(code\|verify\|records\)\/\?\$"\) \{ return 404; \}/);
  assert.match(block, /limit_req zone=hid_card_view burst=10 nodelay;/);
  assert.match(block, /limit_req_status 429;/);
  assert.match(block, /client_max_body_size 1k;/);
  assert.match(block, /proxy_pass \$hid_identity_upstream;/);
  // The exact locations come before the prefix location's catch-all for /api/.
  assert.ok(config.indexOf('location ^~ /api/v1/card-share/ {') < config.indexOf('location ^~ /api/ {'));
});

test('the log format records the path only, so nothing after # or in a body is logged', () => {
  assert.doesNotMatch(config, /\$request_body|\$args|\$request_uri/);
});
