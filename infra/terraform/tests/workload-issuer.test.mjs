import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { issuerConfiguration, createIssuer } from '../modules/application/runtime/workload-issuer/issuer.mjs';

test('Terraform caller policy can mint a staging token for its ECS role', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keyId = 'arn:aws:kms:eu-west-1:123456789012:key/12345678-1234-4234-8234-123456789abc';
  const issuer = 'https://abc123.execute-api.eu-west-1.amazonaws.com/staging';
  const configuration = issuerConfiguration({
    HID_DEPLOYMENT_ENV: 'staging',
    WORKLOAD_ISSUER_URL: issuer,
    WORKLOAD_API_ID: 'abc123',
    WORKLOAD_SIGNING_KEY_ID: keyId,
    WORKLOAD_CALLER_POLICY_JSON: JSON.stringify([{
      role_arn: 'arn:aws:iam::123456789012:role/hid-staging-ehr-api-task-test',
      subject: 'hid:staging:ehr-api',
      audiences: ['hid-identity-api'],
    }]),
  });
  const handler = createIssuer(configuration, {
    now: () => 2_000_000_000_000,
    getPublicKey: async () => ({
      KeyId: keyId,
      KeySpec: 'ECC_NIST_P256',
      KeyUsage: 'SIGN_VERIFY',
      SigningAlgorithms: ['ECDSA_SHA_256'],
      PublicKey: publicKey.export({ format: 'der', type: 'spki' }),
    }),
    sign: async (_key, message) => ({
      KeyId: keyId,
      SigningAlgorithm: 'ECDSA_SHA_256',
      Signature: sign('sha256', message, privateKey),
    }),
  });
  const event = {
    httpMethod: 'POST',
    resource: '/token',
    body: JSON.stringify({ audience: 'hid-identity-api' }),
    requestContext: {
      apiId: 'abc123',
      stage: 'staging',
      accountId: '123456789012',
      domainName: 'abc123.execute-api.eu-west-1.amazonaws.com',
      httpMethod: 'POST',
      resourcePath: '/token',
      identity: {
        accountId: '123456789012',
        userArn: 'arn:aws:sts::123456789012:assumed-role/hid-staging-ehr-api-task-test/task123',
      },
    },
  };

  const response = await handler(event);
  assert.equal(response.statusCode, 200);
  const { token } = JSON.parse(response.body);
  const [header, payload, signature] = token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(claims.sub, 'hid:staging:ehr-api');
  assert.equal(claims.aud, 'hid-identity-api');
  assert.equal(claims.exp - claims.iat, 300);
  assert(verify('sha256', Buffer.from(`${header}.${payload}`),
    { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));

  event.requestContext.identity.userArn = 'arn:aws:sts::123456789012:assumed-role/other-task/task123';
  assert.equal((await handler(event)).statusCode, 403);
});

test('production issuer binds the stage, role and subject to production', async () => {
  const issuer = 'https://abc123.execute-api.eu-west-1.amazonaws.com/production';
  const keyId = 'arn:aws:kms:eu-west-1:123456789012:key/12345678-1234-4234-8234-123456789abc';
  const configuration = issuerConfiguration({
    HID_DEPLOYMENT_ENV: 'production', WORKLOAD_ISSUER_URL: issuer,
    WORKLOAD_API_ID: 'abc123', WORKLOAD_SIGNING_KEY_ID: keyId,
    WORKLOAD_CALLER_POLICY_JSON: JSON.stringify([{
      role_arn: 'arn:aws:iam::123456789012:role/hid-production-ehr-api-task',
      subject: 'hid:production:ehr-api', audiences: ['hid-identity-api'],
    }]),
  });
  assert.equal(configuration.deployment, 'production');
  const event = {
    httpMethod: 'POST', resource: '/token', body: JSON.stringify({ audience: 'hid-identity-api' }),
    requestContext: {
      apiId: 'abc123', stage: 'production', accountId: '123456789012',
      domainName: 'abc123.execute-api.eu-west-1.amazonaws.com',
      httpMethod: 'POST', resourcePath: '/token',
      identity: { accountId: '123456789012',
        userArn: 'arn:aws:sts::123456789012:assumed-role/hid-production-ehr-api-task/task123' },
    },
  };
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const handler = createIssuer(configuration, {
    now: () => 2_000_000_000_000,
    getPublicKey: async () => ({ KeyId: keyId, KeySpec: 'ECC_NIST_P256', KeyUsage: 'SIGN_VERIFY',
      SigningAlgorithms: ['ECDSA_SHA_256'], PublicKey: publicKey.export({ format: 'der', type: 'spki' }) }),
    sign: async (_key, message) => ({ KeyId: keyId, SigningAlgorithm: 'ECDSA_SHA_256',
      Signature: sign('sha256', message, privateKey) }),
  });
  assert.equal((await handler(event)).statusCode, 200);
  event.requestContext.stage = 'staging';
  assert.equal((await handler(event)).statusCode, 403);
  assert.throws(() => issuerConfiguration({ HID_DEPLOYMENT_ENV: 'production',
    WORKLOAD_ISSUER_URL: issuer.replace('/production', '/staging'),
    WORKLOAD_API_ID: 'abc123', WORKLOAD_SIGNING_KEY_ID: keyId,
    WORKLOAD_CALLER_POLICY_JSON: JSON.stringify([]) }));
});

test('caller policy holds up to eight callers and refuses a ninth at load', () => {
  const keyId = 'arn:aws:kms:eu-west-1:123456789012:key/12345678-1234-4234-8234-123456789abc';
  const names = ['identity-api', 'ehr-api', 'lab-api', 'pharmacy-api', 'ocr-api', 'outreach-api', 'support-api', 'document-scanner', 'ninth-caller'];
  const environment = count => ({
    HID_DEPLOYMENT_ENV: 'staging',
    WORKLOAD_ISSUER_URL: 'https://abc123.execute-api.eu-west-1.amazonaws.com/staging',
    WORKLOAD_API_ID: 'abc123',
    WORKLOAD_SIGNING_KEY_ID: keyId,
    WORKLOAD_CALLER_POLICY_JSON: JSON.stringify(names.slice(0, count).map(name => ({
      role_arn: `arn:aws:iam::123456789012:role/hid-staging-${name}-role`,
      subject: `hid:staging:${name}`,
      audiences: ['hid-identity-api'],
    }))),
  });
  // Six ECS callers, plus support-api (support bot on) and the document scanner
  // bridge (document scanning on), make eight; a ninth is refused.
  assert.equal(issuerConfiguration(environment(6)).rules.length, 6);
  assert.equal(issuerConfiguration(environment(7)).rules.length, 7);
  assert.equal(issuerConfiguration(environment(8)).rules.length, 8);
  assert.throws(() => issuerConfiguration(environment(9)), /Invalid workload caller policy/);
  assert.throws(() => issuerConfiguration(environment(0)), /Invalid workload caller policy/);
});

test('support-api\'s caller rule gets identity-api tokens under its own subject only', async () => {
  // The promoted production stack keeps the hid-staging role names and the
  // hid:staging: issuer namespace (workload_identity.tf).
  const keyId = 'arn:aws:kms:eu-west-1:123456789012:key/12345678-1234-4234-8234-123456789abc';
  const audiences = {
    'identity-api': ['hid-notification-api'],
    'ehr-api': ['hid-identity-api', 'hid-lab-api', 'hid-pharmacy-api'],
    'lab-api': ['hid-identity-api'],
    'pharmacy-api': ['hid-identity-api'],
    'ocr-api': ['hid-identity-api', 'hid-ehr-api', 'hid-lab-api', 'hid-pharmacy-api'],
    'outreach-api': ['hid-identity-api'],
    'support-api': ['hid-identity-api'],
  };
  const configuration = issuerConfiguration({
    HID_DEPLOYMENT_ENV: 'staging',
    WORKLOAD_ISSUER_URL: 'https://abc123.execute-api.eu-west-1.amazonaws.com/staging',
    WORKLOAD_API_ID: 'abc123',
    WORKLOAD_SIGNING_KEY_ID: keyId,
    WORKLOAD_CALLER_POLICY_JSON: JSON.stringify(Object.entries(audiences).map(([name, list]) => ({
      role_arn: `arn:aws:iam::123456789012:role/hid-staging-${name}-task`,
      subject: `hid:staging:${name}`,
      audiences: list,
    }))),
  });
  assert.equal(configuration.rules.length, 7);
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const handler = createIssuer(configuration, {
    now: () => 2_000_000_000_000,
    getPublicKey: async () => ({ KeyId: keyId, KeySpec: 'ECC_NIST_P256', KeyUsage: 'SIGN_VERIFY',
      SigningAlgorithms: ['ECDSA_SHA_256'], PublicKey: publicKey.export({ format: 'der', type: 'spki' }) }),
    sign: async (_key, message) => ({ KeyId: keyId, SigningAlgorithm: 'ECDSA_SHA_256',
      Signature: sign('sha256', message, privateKey) }),
  });
  const request = (role, audience) => handler({
    httpMethod: 'POST', resource: '/token', body: JSON.stringify({ audience }),
    requestContext: {
      apiId: 'abc123', stage: 'staging', accountId: '123456789012',
      domainName: 'abc123.execute-api.eu-west-1.amazonaws.com', httpMethod: 'POST', resourcePath: '/token',
      identity: { accountId: '123456789012', userArn: `arn:aws:sts::123456789012:assumed-role/${role}/task123` },
    },
  });
  const claims = response => JSON.parse(Buffer.from(JSON.parse(response.body).token.split('.')[1], 'base64url'));

  const support = await request('hid-staging-support-api-task', 'hid-identity-api');
  assert.equal(support.statusCode, 200);
  assert.equal(claims(support).sub, 'hid:staging:support-api');
  assert.equal(claims(support).aud, 'hid-identity-api');
  for (const audience of ['hid-ehr-api', 'hid-lab-api', 'hid-pharmacy-api', 'hid-notification-api']) {
    assert.equal((await request('hid-staging-support-api-task', audience)).statusCode, 403);
  }
  // The other callers keep their own subjects.
  assert.equal(claims(await request('hid-staging-outreach-api-task', 'hid-identity-api')).sub, 'hid:staging:outreach-api');
});
