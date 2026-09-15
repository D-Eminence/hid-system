import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify, createPublicKey } from 'node:crypto';
import { issuerConfiguration, createIssuer, derToJose } from '../../../infra/aws/runtime/workload-issuer/issuer.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const keyArn = 'arn:aws:kms:eu-west-2:123456789012:key/12345678-1234-4234-8234-123456789abc';
const env = { HID_DEPLOYMENT_ENV: 'staging', WORKLOAD_API_ID: 'abc123',
  WORKLOAD_ISSUER_URL: 'https://abc123.execute-api.eu-west-2.amazonaws.com/staging', WORKLOAD_SIGNING_KEY_ID: keyArn,
  WORKLOAD_CALLER_POLICY_JSON: JSON.stringify([{ roleArn: 'arn:aws:iam::123456789012:role/service/hid-staging-ehr',
    subject: 'hid:staging:ehr-api', audiences: ['hid-identity-api', 'hid-lab-api', 'hid-pharmacy-api'] }]) };
const publicResult = { KeyId: keyArn, KeySpec: 'ECC_NIST_P256', KeyUsage: 'SIGN_VERIFY', SigningAlgorithms: ['ECDSA_SHA_256'],
  PublicKey: publicKey.export({ format: 'der', type: 'spki' }) };
const makeEvent = (body = { audience: 'hid-identity-api' }) => ({ httpMethod: 'POST', resource: '/token', body: JSON.stringify(body), isBase64Encoded: false,
  requestContext: { apiId: 'abc123', stage: 'staging', accountId: '123456789012', domainName: 'abc123.execute-api.eu-west-2.amazonaws.com',
    httpMethod: 'POST', resourcePath: '/token', identity: { accountId: '123456789012', userArn: 'arn:aws:sts::123456789012:assumed-role/hid-staging-ehr/task123' } } });
function setup() {
  let signed = 0;
  const handler = createIssuer(issuerConfiguration(env), { now: () => 2_000_000_000_000,
    getPublicKey: async () => publicResult,
    sign: async (key, message) => { assert.equal(key, keyArn); signed++; return { KeyId: keyArn,
      SigningAlgorithm: 'ECDSA_SHA_256', Signature: sign('sha256', message, privateKey) }; } });
  return { handler, signed: () => signed };
}
test('IAM role determines subject, issuer and five-minute lifetime; KMS DER is a verifiable ES256 JWS', async () => {
  const { handler, signed } = setup();
  const response = await handler(makeEvent()); assert.equal(response.statusCode, 200); assert.equal(signed(), 1);
  const data = JSON.parse(response.body), parts = data.token.split('.');
  assert.equal(Buffer.from(parts[2], 'base64url').length, 64);
  assert(verify('sha256', Buffer.from(parts.slice(0, 2).join('.')), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url')));
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  assert.equal(claims.sub, 'hid:staging:ehr-api'); assert.equal(claims.aud, 'hid-identity-api');
  assert.equal(claims.exp - claims.iat, 300); assert.equal(claims.nbf, claims.iat); assert.equal(claims.token_use, 'workload');
  assert.equal(Date.parse(data.expiresAt), claims.exp * 1000); assert.equal(response.headers['cache-control'], 'no-store');
});
test('the exact API can publish a public JWKS without mint authority or private key material', async () => {
  const { handler, signed } = setup(); const event = makeEvent();
  event.httpMethod = event.requestContext.httpMethod = 'GET'; event.resource = event.requestContext.resourcePath = '/.well-known/jwks.json';
  delete event.requestContext.identity;
  const response = await handler(event); assert.equal(response.statusCode, 200); assert.equal(signed(), 0);
  const [jwk] = JSON.parse(response.body).keys; assert(!jwk.d); assert.equal(jwk.alg, 'ES256');
  assert.deepEqual(createPublicKey({ key: jwk, format: 'jwk' }).export({ format: 'der', type: 'spki' }), publicResult.PublicKey);
});
for (const [label, mutate] of [
  ['missing IAM context', e => { delete e.requestContext.identity; }],
  ['unapproved role', e => { e.requestContext.identity.userArn = 'arn:aws:sts::123456789012:assumed-role/hid-staging-admin/task123'; }],
  ['role prefix collision', e => { e.requestContext.identity.userArn = 'arn:aws:sts::123456789012:assumed-role/hid-staging-ehr-evil/task123'; }],
  ['foreign account', e => { e.requestContext.identity.userArn = 'arn:aws:sts::999999999999:assumed-role/hid-staging-ehr/task123'; }],
  ['IAM user', e => { e.requestContext.identity.userArn = 'arn:aws:iam::123456789012:user/operator'; }],
  ['forged header principal', e => { delete e.requestContext.identity; e.headers = { 'x-role-arn': 'arn:aws:iam::123456789012:role/service/hid-staging-ehr' }; }],
  ['wrong deployment stage', e => { e.requestContext.stage = 'production'; }],
  ['wrong API binding', e => { e.requestContext.apiId = 'different'; }],
]) test(`denies ${label} before any KMS signing`, async () => {
  const { handler, signed } = setup(); const event = makeEvent(); mutate(event);
  assert.equal((await handler(event)).statusCode, 403); assert.equal(signed(), 0);
});
test('rejects disallowed audiences and caller-supplied claims instead of signing arbitrary messages', async () => {
  const { handler, signed } = setup();
  assert.equal((await handler(makeEvent({ audience: 'hid-notification-api' }))).statusCode, 403);
  for (const extra of [{ sub: 'hid:staging:identity-api' }, { exp: 9_999_999_999 }, { message: 'arbitrary' }, { roleArn: 'admin' }]) {
    assert.equal((await handler(makeEvent({ audience: 'hid-identity-api', ...extra }))).statusCode, 400);
  }
  assert.equal(signed(), 0);
});
test('fails closed on unavailable or mismatched KMS key without leaking error or token material', async () => {
  const handler = createIssuer(issuerConfiguration(env), { getPublicKey: async () => ({ ...publicResult, KeyId: 'other-key' }) });
  const response = await handler(makeEvent()); assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(response.body), { code: 'WORKLOAD_ISSUER_UNAVAILABLE' });
});
test('configuration rejects production, ambiguous roles, shared subjects, and foreign signing regions', () => {
  assert.throws(() => issuerConfiguration({ ...env, HID_DEPLOYMENT_ENV: 'production' }));
  const policy = JSON.parse(env.WORKLOAD_CALLER_POLICY_JSON);
  assert.throws(() => issuerConfiguration({ ...env, WORKLOAD_CALLER_POLICY_JSON: JSON.stringify([...policy, ...policy]) }));
  assert.throws(() => issuerConfiguration({ ...env, WORKLOAD_SIGNING_KEY_ID: keyArn.replace('eu-west-2', 'us-east-1') }));
});
test('DER conversion rejects malformed or non-minimal integers', () => {
  for (const bytes of [[], [0x30, 0], [0x30, 6, 2, 1, 0, 2, 1, 1], [0x30, 7, 2, 2, 0, 1, 2, 1, 1]]) assert.throws(() => derToJose(bytes));
});
