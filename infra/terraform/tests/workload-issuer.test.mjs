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
