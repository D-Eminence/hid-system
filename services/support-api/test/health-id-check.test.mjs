import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { HEALTH_ID_PLACEHOLDER, MAX_CANDIDATES, healthIdCandidates, healthIdCheck, replaceHealthIds } from '../src/health-id-check.mjs';
import { supportServer } from '../src/server.mjs';

// Fictional Health IDs only.
const ids = (text) => healthIdCandidates(text).map((candidate) => candidate.healthId).sort();
const TOKEN = 'eyJ.synthetic-workload-token.signature';
let folder;
let tokenFile;
before(async () => {
  folder = await mkdtemp(join(tmpdir(), 'support-health-id-'));
  tokenFile = join(folder, 'identity.jwt');
  await writeFile(tokenFile, `${TOKEN}\n`);
});
after(async () => { await rm(folder, { recursive: true, force: true }); });

describe('healthIdCandidates', () => {
  for (const [text, expected] of [
    ['My Health ID is HID-AB2CD3', ['HID-AB2CD3']],
    ['my health id is hid-ab2cd3', ['HID-AB2CD3']],
    ['HID AB2CD3', ['HID-AB2CD3']],
    ['HID: AB2 CD3', ['HID-AB2CD3']],
    ['HIDAB2CD3', ['HID-AB2CD3']],
    ['HID - AB2.CD3', ['HID-AB2CD3']],
    ['ＨＩＤ－ＡＢ２ＣＤ３', ['HID-AB2CD3']],
    ['HID–AB2CD3 (with an en dash)', ['HID-AB2CD3']],
    ['AB2CD3', ['HID-AB2CD3']],
    ['ab2 cd3', ['HID-AB2CD3']],
    ['AB-2CD-3', ['HID-AB2CD3']],
    ['HID SUPPRT', ['HID-SUPPRT']],
  ]) {
    test(`reads ${JSON.stringify(text)}`, () => {
      const found = ids(text);
      for (const id of expected) assert.ok(found.includes(id), `${id} in ${found}`);
      for (const id of found) assert.match(id, /^HID-[A-HJ-NP-Z2-9]{6,32}$/);
    });
  }

  test('reads an ordinary word of Health ID letters too, so identity-api can say it is not one', () => {
    assert.deepEqual(ids('Please reset'), ['HID-PLEASE']);
  });

  test('does not read words with I, O, 0 or 1, five characters, or more than 32', () => {
    assert.deepEqual(ids('password login HID-AB2C9 phone 08012345678'), []);
    assert.deepEqual(ids(`HID-${'A2'.repeat(17)}`), []);
    assert.deepEqual(ids('12345'), []);
  });

  test('reads 32 characters after the label', () => {
    assert.deepEqual(ids(`HID-${'A2'.repeat(16)}`), [`HID-${'A2'.repeat(16)}`]);
  });

  test('does not join letters-only words typed apart without a label', () => {
    assert.deepEqual(ids('ABC DEF'), []);
  });

  test('keeps the stretch of text each one was read from', () => {
    const [candidate] = healthIdCandidates('Mine is hid-ab2cd3.');
    assert.equal('Mine is hid-ab2cd3.'.slice(candidate.spans[0].start, candidate.spans[0].end), 'hid-ab2cd3');
  });
});

describe('replaceHealthIds', () => {
  const replace = (text, matches) => replaceHealthIds(text, healthIdCandidates(text), new Set(matches));
  test('replaces each issued one, label and all, and nothing else', () => {
    assert.equal(replace('My Health ID is HID-AB2CD3, please help', ['HID-AB2CD3']),
      `My Health ID is ${HEALTH_ID_PLACEHOLDER}, please help`);
    assert.equal(replace('please help', []), 'please help');
    assert.equal(replace('please help', ['HID-PLEASE']), `${HEALTH_ID_PLACEHOLDER} help`);
  });
  test('replaces a Health ID typed apart or in another case as one', () => {
    assert.equal(replace('it is hid: ab2 cd3 thanks', ['HID-AB2CD3']), `it is ${HEALTH_ID_PLACEHOLDER} thanks`);
    assert.equal(replace('code AB2-CD3 here', ['HID-AB2CD3']), `code ${HEALTH_ID_PLACEHOLDER} here`);
  });
  test('replaces every one in a message', () => {
    assert.equal(replace('HID-AB2CD3 and HID-EF4GH5 and HID-ZZ22ZZ', ['HID-AB2CD3', 'HID-EF4GH5']),
      `${HEALTH_ID_PLACEHOLDER} and ${HEALTH_ID_PLACEHOLDER} and HID-ZZ22ZZ`);
  });
});

describe('healthIdCheck', () => {
  const answer = (matches, init = {}) => new Response(JSON.stringify({ matches }),
    { status: 200, headers: { 'content-type': 'application/json' }, ...init });
  const check = (fetch, options = {}) => healthIdCheck({ identityApiUrl: 'https://identity.internal.example', tokenFile, fetch, ...options });

  test('sends only the candidates, as support-api, with the workload token, and replaces the issued ones', async () => {
    const calls = [];
    const run = check(async (url, init) => { calls.push([String(url), init]); return answer(['HID-AB2CD3']); });
    assert.equal(await run('My Health ID is HID-AB2CD3, please'), `My Health ID is ${HEALTH_ID_PLACEHOLDER}, please`);
    assert.equal(calls.length, 1);
    const [url, init] = calls[0];
    assert.equal(url, 'https://identity.internal.example/api/v1/identity/service/support/health-id-matches');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['x-hid-internal-caller'], 'support-api');
    assert.equal(init.headers['x-hid-service-authorization'], `Bearer ${TOKEN}`);
    const body = JSON.parse(init.body);
    assert.deepEqual(Object.keys(body), ['candidates']);
    assert.ok(body.candidates.includes('HID-AB2CD3'));
    assert.ok(!init.body.includes('My Health ID'));
  });

  test('sends nothing to identity-api for a message with no candidate, and returns it as typed', async () => {
    let called = false;
    assert.equal(await check(async () => { called = true; return answer([]); })('how do I log in?'), 'how do I log in?');
    assert.equal(called, false);
  });

  test('uses the local secret in local development', async () => {
    let headers;
    const run = healthIdCheck({ identityApiUrl: 'http://127.0.0.1:3001', mode: 'local-secret',
      localToken: 'support-local-development-secret-0123456789',
      fetch: async (_url, init) => { headers = init.headers; return answer([]); } });
    await run('HID-AB2CD3');
    assert.equal(headers['x-hid-service-token'], 'support-local-development-secret-0123456789');
    assert.equal(headers['x-hid-service-authorization'], undefined);
  });

  for (const [name, options, fetch] of [
    ['without IDENTITY_API_URL', { identityApiUrl: undefined }, async () => answer([])],
    ['without the token file', { tokenFile: undefined }, async () => answer([])],
    ['when the token file is missing', { tokenFile: '/nonexistent/identity.jwt' }, async () => answer([])],
    ['when identity-api answers 503', {}, async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } })],
    ['when identity-api answers 401', {}, async () => new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } })],
    ['when the answer is not JSON', {}, async () => new Response('matches', { status: 200, headers: { 'content-type': 'text/plain' } })],
    ['when the answer is malformed', {}, async () => answer('HID-AB2CD3')],
    ['when the answer names something not asked', {}, async () => answer(['HID-OTHER2'])],
    ['when identity-api cannot be reached', {}, async () => { throw new TypeError('fetch failed'); }],
    ['when identity-api is slow', { timeoutMs: 20 }, (_url, init) => new Promise((_resolve, reject) => {
      // A stand-in that never answers; its own timer keeps the test process alive until the check gives up.
      const pending = setTimeout(() => {}, 5000);
      init.signal.addEventListener('abort', () => { clearTimeout(pending); reject(init.signal.reason); });
    })],
  ]) {
    test(`fails, so nothing reaches Lex, ${name}`, async () => {
      await assert.rejects(check(fetch, options)('My Health ID is HID-AB2CD3'));
    });
  }

  test('fails for a message with no candidate too when it has no credential, so nothing at all is sent', async () => {
    await assert.rejects(check(async () => answer([]), { tokenFile: undefined })('how do I log in?'));
    await assert.rejects(check(async () => answer([]), { identityApiUrl: undefined })('how do I log in?'));
  });

  test(`fails for more than ${MAX_CANDIDATES} candidates`, async () => {
    const words = Array.from({ length: MAX_CANDIDATES + 1 }, (_, n) => `AB${String.fromCharCode(65 + (n % 8))}${(n % 7) + 2}`
      + `${String.fromCharCode(65 + Math.floor(n / 8) % 8)}${String.fromCharCode(65 + Math.floor(n / 64) % 8)}`);
    assert.ok(healthIdCandidates(words.join(' ')).length > MAX_CANDIDATES);
    await assert.rejects(check(async () => answer([]))(words.join(' ')), /Too many/);
  });

  test('refuses a local secret, plain HTTP or a path in production, and an unknown mode', () => {
    assert.throws(() => healthIdCheck({ identityApiUrl: 'https://identity.internal.example', mode: 'local-secret', production: true }));
    assert.throws(() => healthIdCheck({ identityApiUrl: 'http://identity.internal.example', production: true }));
    assert.throws(() => healthIdCheck({ identityApiUrl: 'https://identity.internal.example/api' }));
    assert.throws(() => healthIdCheck({ identityApiUrl: 'https://identity.internal.example', mode: 'none' }));
  });
});

describe('supportServer with the Health ID check', () => {
  const servers = [];
  afterEach(async () => { for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve)); });
  async function ask(recognize, checkHealthIds, text) {
    const server = supportServer(recognize, checkHealthIds ? { checkHealthIds } : {});
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return fetch(`http://127.0.0.1:${server.address().port}/api/v1/support/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  }

  test('sends Lex the checked text only, and answers as for any message', async () => {
    const sent = [];
    const response = await ask(async (text) => { sent.push(text); return ['Your Health ID is on your card.']; },
      async (text) => text.replace('HID-AB2CD3', HEALTH_ID_PLACEHOLDER), 'Where is HID-AB2CD3 shown?');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ['messages', 'sessionId']);
    assert.deepEqual(sent, [`Where is ${HEALTH_ID_PLACEHOLDER} shown?`]);
  });

  test('answers 503 and sends nothing to Lex when the check fails', async () => {
    let called = false;
    const response = await ask(async () => { called = true; return ['x']; },
      async () => { throw new Error('identity-api unavailable: HID-AB2CD3'); }, 'Where is HID-AB2CD3 shown?');
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { code: 'SUPPORT_BOT_UNAVAILABLE' });
    assert.equal(called, false);
  });

  test('answers 503 and sends nothing to Lex with no check configured', async () => {
    let called = false;
    const response = await ask(async () => { called = true; return ['x']; }, undefined, 'help');
    assert.equal(response.status, 503);
    assert.equal(called, false);
  });

  test('answers 503 when the check returns something other than text', async () => {
    let called = false;
    const response = await ask(async () => { called = true; return ['x']; }, async () => undefined, 'help');
    assert.equal(response.status, 503);
    assert.equal(called, false);
  });

  test('end to end against a stand-in identity-api: only issued Health IDs are replaced', async () => {
    const { createServer } = await import('node:http');
    const asked = [];
    const identity = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        asked.push({ headers: request.headers, body: JSON.parse(body), url: request.url });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ matches: JSON.parse(body).candidates.filter((id) => id === 'HID-AB2CD3') }));
      });
    });
    identity.listen(0, '127.0.0.1');
    await once(identity, 'listening');
    try {
      const sent = [];
      const check = healthIdCheck({ identityApiUrl: `http://127.0.0.1:${identity.address().port}`, tokenFile });
      const response = await ask(async (text) => { sent.push(text); return ['Thanks.']; }, check,
        'Please help, my Health ID hid-ab2cd3 and my friend HID-ZZ22ZZ cannot sign in');
      assert.equal(response.status, 200);
      assert.deepEqual(sent, [`Please help, my Health ID ${HEALTH_ID_PLACEHOLDER} and my friend HID-ZZ22ZZ cannot sign in`]);
      assert.equal(asked.length, 1);
      assert.equal(asked[0].url, '/api/v1/identity/service/support/health-id-matches');
      assert.equal(asked[0].headers['x-hid-internal-caller'], 'support-api');
      assert.equal(asked[0].headers['x-hid-service-authorization'], `Bearer ${TOKEN}`);
      assert.ok(!JSON.stringify(asked[0].body).includes('friend'));
    } finally {
      await new Promise((resolve) => identity.close(resolve));
    }
  });
});
