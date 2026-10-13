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
test('configuration permits only staging or production, the exact HTTPS issuer/JWKS and fixed audience filenames', () => {
  // Another environment is refused by the allowlist itself, even with an issuer path and subject of its own name.
  const development = { HID_DEPLOYMENT_ENV: 'development',
    WORKLOAD_ISSUER_URL: 'https://abc123.execute-api.eu-west-2.amazonaws.com/development',
    WORKLOAD_JWKS_URL: 'https://abc123.execute-api.eu-west-2.amazonaws.com/development/.well-known/jwks.json',
    WORKLOAD_SUBJECT: 'hid:development:ehr-api' };
  assert.throws(() => agentConfiguration({ ...environment, ...development }), /^Error: Workload token agent environment is not allowed$/);
  assert.throws(() => agentConfiguration({ ...environment, HID_DEPLOYMENT_ENV: 'production' }), /^Error: Invalid workload issuer URL$/);
  for (const changed of [development, { WORKLOAD_JWKS_URL: 'https://attacker.invalid/jwks' },
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

const productionEnvironment = { ...environment, HID_DEPLOYMENT_ENV: 'production',
  WORKLOAD_ISSUER_URL: 'https://abc123.execute-api.eu-west-2.amazonaws.com/production',
  WORKLOAD_JWKS_URL: 'https://abc123.execute-api.eu-west-2.amazonaws.com/production/.well-known/jwks.json',
  WORKLOAD_SUBJECT: 'hid:production:ehr-api' };
test('production binds its own issuer stage path and subject prefix', () => {
  const production = agentConfiguration(productionEnvironment);
  assert.equal(production.stage, 'production');
  assert.equal(production.issuer, 'https://abc123.execute-api.eu-west-2.amazonaws.com/production');
  assert.equal(production.subject, 'hid:production:ehr-api');
  assert.equal(configuration.stage, 'staging');
});
test('the deployment environment, issuer path and subject prefix must name the same stage', () => {
  const stagingIssuer = { WORKLOAD_ISSUER_URL: environment.WORKLOAD_ISSUER_URL, WORKLOAD_JWKS_URL: environment.WORKLOAD_JWKS_URL };
  const productionIssuer = { WORKLOAD_ISSUER_URL: productionEnvironment.WORKLOAD_ISSUER_URL, WORKLOAD_JWKS_URL: productionEnvironment.WORKLOAD_JWKS_URL };
  for (const changed of [
    { ...productionEnvironment, ...stagingIssuer },
    { ...productionEnvironment, WORKLOAD_SUBJECT: 'hid:staging:ehr-api' },
    { ...environment, ...productionIssuer },
    { ...environment, WORKLOAD_SUBJECT: 'hid:production:ehr-api' },
    { ...productionEnvironment, HID_DEPLOYMENT_ENV: 'development' },
    { ...productionEnvironment, HID_DEPLOYMENT_ENV: 'Production' },
    { ...productionEnvironment, HID_DEPLOYMENT_ENV: '' },
    { ...productionEnvironment, HID_DEPLOYMENT_ENV: undefined },
  ]) assert.throws(() => agentConfiguration(changed));
  assert.throws(() => agentConfiguration({ ...productionEnvironment, ...stagingIssuer }), /^Error: Invalid workload issuer URL$/);
  assert.throws(() => agentConfiguration({ ...environment, ...productionIssuer }), /^Error: Invalid workload issuer URL$/);
});
test('production SigV4 matches the AWS Smithy signer reference for /production/token', () => {
  // Reference independently generated with @smithy/signature-v4 5.6.12, applyChecksum:false,
  // the same inputs as the staging vector and path /production/token.
  const production = agentConfiguration(productionEnvironment);
  const result = signTokenRequest(production, credentials, 'hid-identity-api', new Date(now));
  assert.equal(result.url, 'https://abc123.execute-api.eu-west-2.amazonaws.com/production/token');
  assert.equal(result.headers.authorization, `AWS4-HMAC-SHA256 Credential=${syntheticAccessKey}/20260910/eu-west-2/execute-api/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=2b1187afe0227a0328262b1c17f8c1544663d9b758f4d72693da3547458e5abd`);
  for (const mixed of [{ ...production, issuer: configuration.issuer }, { ...configuration, issuer: production.issuer },
    { ...production, stage: undefined }]) {
    assert.throws(() => signTokenRequest(mixed, credentials, 'hid-identity-api', new Date(now)), /Invalid token endpoint/);
  }
});
test('a production agent rejects a staging-issued or staging-subject token', () => {
  const production = agentConfiguration(productionEnvironment);
  const productionToken = minted({ iss: production.issuer, sub: production.subject });
  assert.equal(verifyMintedToken(productionToken, jwks, production, 'hid-identity-api', now).expiresAt, now + 300_000);
  for (const claims of [{ iss: configuration.issuer, sub: production.subject }, { iss: production.issuer, sub: 'hid:staging:ehr-api' }]) {
    assert.throws(() => verifyMintedToken(minted(claims), jwks, production, 'hid-identity-api', now), /claims are invalid/);
  }
  assert.throws(() => verifyMintedToken(productionToken, jwks, configuration, 'hid-identity-api', now), /claims are invalid/);
});

// DEP-4-DOS: the agent keeps the verified key set by kid, so a JWKS outage or
// flood does not stop renewal, and it refetches only for an unknown kid, at
// most once every 30 seconds.
function rotatingIssuer() {
  const keys = new Map();
  const addKey = kid => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    keys.set(kid, { privateKey: pair.privateKey,
      jwk: { ...pair.publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' } });
  };
  const state = { clock: now, signingKid: 'key-a', published: ['key-a'], jwksStatus: 200, jwksFetches: 0, mints: 0 };
  addKey('key-a'); addKey('key-b'); addKey('key-c');
  state.replaceKey = addKey;
  const mint = () => {
    const seconds = Math.floor(state.clock / 1000);
    const claims = { iss: configuration.issuer, sub: configuration.subject, aud: 'hid-identity-api', iat: seconds,
      nbf: seconds, exp: seconds + 300, token_use: 'workload', jti: `jti-${state.mints}` };
    const message = [{ alg: 'ES256', typ: 'JWT', kid: state.signingKid }, claims]
      .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
    const signature = sign('sha256', Buffer.from(message),
      { key: keys.get(state.signingKid).privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return { token: `${message}.${signature}`, expiresAt: new Date((seconds + 300) * 1000).toISOString() };
  };
  const transport = async (url) => {
    if (url === configuration.credentialUrl) return Response.json({ ...credentials,
      Expiration: new Date(state.clock + 3_600_000).toISOString() });
    if (url === configuration.jwks) {
      state.jwksFetches += 1;
      if (state.jwksStatus !== 200) return new Response('{"message":"Too Many Requests"}', { status: state.jwksStatus });
      return Response.json({ keys: state.published.map(kid => keys.get(kid).jwk) });
    }
    assert.equal(url, `${configuration.issuer}/token`);
    state.mints += 1;
    return Response.json(mint());
  };
  return { state, transport };
}
async function withAgent(run) {
  const directory = await mkdtemp(join(tmpdir(), 'hid-agent-cache-'));
  const issuer = rotatingIssuer();
  const agent = new TokenAgent({ ...configuration, directory }, { fetch: issuer.transport, now: () => issuer.state.clock });
  try { await agent.start(); await run(agent, issuer.state, directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
const readyAt = async directory => JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8')).expiresAt;

test('renewals reuse the verified key set: one JWKS fetch for many renewals', async () => {
  await withAgent(async (agent, state, directory) => {
    for (let renewal = 0; renewal < 4; renewal += 1) {
      await agent.renew();
      assert.equal(await readyAt(directory), state.clock + 300_000);
      state.clock += 90_000;
    }
    assert.equal(state.mints, 4);
    assert.equal(state.jwksFetches, 1);
  });
});

test('renewal keeps working while the JWKS endpoint is throttled or failing', async () => {
  await withAgent(async (agent, state, directory) => {
    await agent.renew();
    for (const status of [429, 503, 403]) {
      state.jwksStatus = status; state.clock += 90_000;
      await agent.renew();
      assert.equal(await readyAt(directory), state.clock + 300_000);
    }
    assert.equal(state.jwksFetches, 1);
  });
});

test('an unknown kid refetches the JWKS at most once every 30 seconds and drops withdrawn keys', async () => {
  await withAgent(async (agent, state, directory) => {
    await agent.renew();
    assert.equal(state.jwksFetches, 1);
    // Rotation: the issuer signs with a new key and publishes only that key.
    state.signingKid = 'key-b'; state.published = ['key-b']; state.clock += 90_000;
    await agent.renew();
    assert.equal(state.jwksFetches, 2);
    assert.equal(await readyAt(directory), state.clock + 300_000);
    // A token under a kid the JWKS does not publish is never written, and the
    // agent does not refetch within 30 seconds of the last fetch.
    const before = await readFile(join(directory, 'identity.jwt'), 'utf8');
    state.signingKid = 'key-c'; state.clock += 10_000;
    await assert.rejects(agent.renew());
    assert.equal(state.jwksFetches, 2);
    state.clock += 20_000;
    await assert.rejects(agent.renew(), /Invalid workload JWT key/);
    assert.equal(state.jwksFetches, 3);
    assert.equal(await readFile(join(directory, 'identity.jwt'), 'utf8'), before);
    // The withdrawn key is no longer trusted from the cache.
    state.signingKid = 'key-a'; state.clock += 30_000;
    await assert.rejects(agent.renew(), /Invalid workload JWT key/);
    assert.equal(state.jwksFetches, 4);
  });
});

test('a JWKS outage at start is retried no more than once every 30 seconds', async () => {
  await withAgent(async (agent, state, directory) => {
    state.jwksStatus = 503;
    await assert.rejects(agent.renew());
    assert.equal(state.jwksFetches, 1);
    state.jwksStatus = 200;
    for (const step of [10_000, 10_000]) {
      state.clock += step;
      await assert.rejects(agent.renew());
      assert.equal(state.jwksFetches, 1);
    }
    await assert.rejects(readFile(join(directory, 'ready.json')), { code: 'ENOENT' });
    state.clock += 10_000;
    await agent.renew();
    assert.equal(state.jwksFetches, 2);
    assert.equal(await readyAt(directory), state.clock + 300_000);
  });
});

test('a cached key that stops verifying is dropped, so the next renewal fetches the JWKS again', async () => {
  await withAgent(async (agent, state, directory) => {
    await agent.renew();
    // The same kid now carries different key material, published by the JWKS.
    state.replaceKey('key-a'); state.clock += 90_000;
    await assert.rejects(agent.renew(), /signature is invalid/);
    assert.equal(state.jwksFetches, 1);
    state.clock += 10_000;
    await agent.renew();
    assert.equal(state.jwksFetches, 2);
    assert.equal(await readyAt(directory), state.clock + 300_000);
  });
});
