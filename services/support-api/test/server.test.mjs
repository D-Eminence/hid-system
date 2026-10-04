import assert from 'node:assert/strict';
import { once } from 'node:events';
import { afterEach, test } from 'node:test';
import { supportServer } from '../src/server.mjs';

const servers = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

async function request(recognize, body, options) {
  const server = supportServer(recognize, options);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return fetch(`http://127.0.0.1:${server.address().port}/api/v1/support/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

test('passes only the support message and opaque session to Lex', async () => {
  const calls = [];
  const response = await request(async (...args) => { calls.push(args); return ['Open your profile page to update your details.']; }, { text: '  update my profile  ' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.sessionId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(body.messages, ['Open your profile page to update your details.']);
  assert.deepEqual(calls, [['update my profile', body.sessionId]]);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('unknown answers use the approved escalation route without inventing one', async () => {
  const response = await request(async () => [], { text: 'Unknown question' },
    { supportContact: 'mailto:support@example.invalid' });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).messages,
    ['I could not answer that. Contact Health ID support: mailto:support@example.invalid']);
});

test('rejects oversized input before invoking Lex', async () => {
  let called = false;
  const response = await request(async () => { called = true; return []; }, { text: 'x'.repeat(501) });
  assert.equal(response.status, 400);
  assert.equal(called, false);
});

test('hides Lex errors from callers', async () => {
  const response = await request(async () => { throw new Error('secret provider detail'); }, { text: 'help' });
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes('secret provider detail'), false);
});

test('rejects malformed JSON before invoking Lex', async () => {
  let called = false;
  const server = supportServer(async () => { called = true; return []; });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/support/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
  });
  assert.equal(response.status, 400);
  assert.equal(called, false);
});

test('bounds provider latency and hides timeout internals', async () => {
  const server = supportServer(async () => new Promise(() => {}), { timeoutMs: 20 });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/support/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'help' }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { code: 'SUPPORT_BOT_UNAVAILABLE' });
});

test('rejects oversized provider answers', async () => {
  const response = await request(async () => ['x'.repeat(1001)], { text: 'help' });
  assert.equal(response.status, 503);
});

test('limits repeated requests in one opaque support session', async () => {
  let calls = 0;
  const server = supportServer(async () => { calls += 1; return ['Approved answer']; });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/api/v1/support/chat`;
  const body = JSON.stringify({ text: 'help', sessionId: '11111111-1111-4111-8111-111111111111' });
  for (let i = 0; i < 10; i += 1) {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(response.status, 200); await response.arrayBuffer();
  }
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(response.status, 429); assert.equal(calls, 10);
});
