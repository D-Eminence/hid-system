import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, writeFile, stat, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentConfiguration, signTokenRequest, verifyMintedToken, atomicToken, boundedJson, TokenAgent } from '../src/agent.mjs';

const now = Date.parse('2026-09-10T00:00:00.000Z');
const environment = { HID_DEPLOYMENT_ENV: 'staging', AWS_REGION: 'eu-west-2',
  WORKLOAD_ISSUER_URL: 'https://abc123.execute-api.eu-west-2.amazonaws.com/staging',
  WORKLOAD_JWKS_URL: 'https://abc123.execute-api.eu-west-2.amazonaws.com/staging/.well-known/jwks.json',
  WORKLOAD_SUBJECT: 'hid:staging:ehr-api', WORKLOAD_TOKEN_FILES_JSON: JSON.stringify([{ audience: 'hid-identity-api', file: 'identity.jwt' }]),
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/synthetic-ecs-task' };
const configuration = agentConfiguration(environment);
const syntheticAccessKey = 'ASIA' + Array.from({ length: 16 }, (_, index) => String.fromCharCode(65 + index)).join('');
const credentials = { AccessKeyId: syntheticAccessKey, SecretAccessKey: 'public-synthetic-secret-key-for-test-only',
  Token: 'public-synthetic-session-token', Expiration: new Date(now + 3_600_000).toISOString() };
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'synthetic-key', alg: 'ES256', use: 'sig' };
const jwks = { keys: [jwk] };
function minted(overrides = {}, headerOverrides = {}) {
  const claims = { iss: configuration.issuer, sub: configuration.subject, aud: 'hid-identity-api',
    iat: now / 1000, nbf: now / 1000, exp: now / 1000 + 300, token_use: 'workload', jti: 'synthetic-jti', ...overrides };
  const header = { alg: 'ES256', typ: 'JWT', kid: jwk.kid, ...headerOverrides };
  const message = [header, claims].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return { token: `${message}.${sign('sha256', Buffer.from(message), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`,
    expiresAt: new Date(claims.exp * 1000).toISOString() };
}
test('SigV4 matches the AWS Smithy signer reference with temporary ECS credentials', () => {
  // Reference independently generated with @smithy/signature-v4, applyChecksum:false.
  const result = signTokenRequest(configuration, credentials, 'hid-identity-api', new Date(now));
  assert.equal(result.headers.authorization, `AWS4-HMAC-SHA256 Credential=${syntheticAccessKey}/20260910/eu-west-2/execute-api/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=64fc94c77ba947e873bb7b791087408e74fbf356a4a6d2e9a77ba4f35a6115e3`);
  assert.equal(result.redirect, 'error'); assert.equal(result.body, '{"audience":"hid-identity-api"}');
  assert.throws(() => signTokenRequest(configuration, { ...credentials, Expiration: new Date(now).toISOString() }, 'hid-identity-api', new Date(now)));
});
test('configuration permits only staging, the exact HTTPS issuer/JWKS and fixed audience filenames', () => {
  for (const changed of [{ HID_DEPLOYMENT_ENV: 'production' }, { WORKLOAD_JWKS_URL: 'https://attacker.invalid/jwks' },
    { WORKLOAD_ISSUER_URL: 'http://abc123.execute-api.eu-west-2.amazonaws.com/staging' },
    { WORKLOAD_TOKEN_FILES_JSON: '[{"audience":"hid-identity-api","file":"../../outside"}]' },
    { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '//attacker.invalid/' }, { WORKLOAD_TOKEN_DIRECTORY: '/tmp/arbitrary' }]) {
    assert.throws(() => agentConfiguration({ ...environment, ...changed }));
  }
  assert.equal(configuration.credentialUrl, 'http://169.254.170.2/v2/credentials/synthetic-ecs-task');
});
test('accepts only a cryptographically valid subject/audience/issuer-bound five-minute JWT', () => {
  const response = minted(); const result = verifyMintedToken(response, jwks, configuration, 'hid-identity-api', now);
  assert.equal(result.expiresAt, now + 300_000);
  for (const claims of [{ sub: 'hid:staging:identity-api' }, { aud: 'hid-lab-api' }, { iss: 'https://other.invalid' },
    { exp: now / 1000 + 301 }, { exp: now / 1000 }, { token_use: 'access' }, { iat: now / 1000 + 60 }, { nbf: now / 1000 + 60 }]) {
    assert.throws(() => verifyMintedToken(minted(claims), jwks, configuration, 'hid-identity-api', now));
  }
  assert.throws(() => verifyMintedToken(minted({}, { alg: 'HS256' }), jwks, configuration, 'hid-identity-api', now));
  assert.throws(() => verifyMintedToken(minted({}, { jku: 'https://other.invalid' }), jwks, configuration, 'hid-identity-api', now));
  assert.throws(() => verifyMintedToken(response, { keys: [jwk, jwk] }, configuration, 'hid-identity-api', now));
  const tampered = { ...response, token: response.token.slice(0, -8) + 'AAAAAAAA' };
  assert.throws(() => verifyMintedToken(tampered, jwks, configuration, 'hid-identity-api', now));
});
test('HTTP JSON reads enforce byte limits before parsing untrusted response bodies', async () => {
  await assert.rejects(boundedJson(new Response('x'.repeat(20)), 10), /exceeds limit/);
  await assert.rejects(boundedJson(new Response('{}', { status: 503 })), /rejected request/);
});
test('writes atomically with0600 permissions and replaces a symlink without following it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hid-agent-test-'));
  try {
    const outside = join(directory, 'outside'); await writeFile(outside, 'unchanged');
    await symlink(outside, join(directory, 'identity.jwt'));
    await atomicToken(directory, 'identity.jwt', 'synthetic-token');
    assert.equal(await readFile(outside, 'utf8'), 'unchanged');
    assert.equal(await readFile(join(directory, 'identity.jwt'), 'utf8'), 'synthetic-token');
    assert.equal((await stat(join(directory, 'identity.jwt'))).mode & 0o777, 0o600);
    await assert.rejects(atomicToken(directory, '../outside', 'invalid'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('startup removes stale files, renewal verifies before writing, outages retain only unexpired tokens', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hid-agent-test-')); let clock = now, unavailable = false;
  const observed = [];
  const transport = async (url, options) => {
    observed.push({ url, options });
    if (unavailable) throw new Error('synthetic outage');
    if (url === configuration.credentialUrl) return Response.json(credentials);
    if (url === configuration.jwks) return Response.json(jwks);
    assert.equal(url, `${configuration.issuer}/token`); assert.match(options.headers.authorization, /^AWS4-HMAC-SHA256 /);
    return Response.json(minted());
  };
  const agent = new TokenAgent({ ...configuration, directory }, { fetch: transport, now: () => clock });
  try {
    await writeFile(join(directory, 'identity.jwt'), 'stale-unverified');
    await agent.start(); await assert.rejects(readFile(join(directory, 'identity.jwt')), { code: 'ENOENT' });
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    await agent.renew();
    verifyMintedToken({ token: await readFile(join(directory, 'identity.jwt'), 'utf8'), expiresAt: new Date(now + 300_000).toISOString() }, jwks, configuration, 'hid-identity-api', now);
    assert.equal(JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8')).expiresAt, now + 300_000);
    assert.equal((await stat(join(directory, 'identity.jwt'))).mode & 0o777, 0o600);
    assert(observed.every(call => call.options.redirect === 'error'));
    unavailable = true; await assert.rejects(agent.renew(), /outage/); await agent.purgeExpired();
    assert((await readFile(join(directory, 'identity.jwt'), 'utf8')).length > 20);
    clock = now + 300_000; await agent.purgeExpired();
    await assert.rejects(readFile(join(directory, 'identity.jwt')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(directory, 'ready.json')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
