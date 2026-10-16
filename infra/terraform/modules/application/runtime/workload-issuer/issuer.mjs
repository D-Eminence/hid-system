import { createPublicKey, randomUUID } from 'node:crypto';

const audiences = new Set(['hid-identity-api', 'hid-ehr-api', 'hid-lab-api', 'hid-pharmacy-api', 'hid-notification-api']);
const rolePattern = /^arn:(aws):iam::(\d{12}):role\/([A-Za-z0-9_+=,.@/-]{1,512})$/;
const assumedRolePattern = /^arn:(aws):sts::(\d{12}):assumed-role\/([A-Za-z0-9_+=,.@-]{1,64})\/([A-Za-z0-9_+=,.@-]{1,64})$/;
const json = (statusCode, payload, publicCache = false) => ({
  statusCode,
  headers: {
    'content-type': 'application/json',
    'cache-control': publicCache ? 'public,max-age=60' : 'no-store',
    'x-content-type-options': 'nosniff',
  },
  body: JSON.stringify(payload),
});
const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');

export function issuerConfiguration(environment) {
  if (environment.HID_DEPLOYMENT_ENV !== 'staging') throw new Error('Workload issuer is staging only');
  const issuer = environment.WORKLOAD_ISSUER_URL;
  const parsed = new URL(issuer);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
    || parsed.pathname !== '/staging' || !/^[a-z0-9]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(parsed.hostname)) {
    throw new Error('Invalid staging issuer URL');
  }
  const apiId = environment.WORKLOAD_API_ID;
  if (!apiId || parsed.hostname.split('.')[0] !== apiId) throw new Error('Issuer API binding is missing');
  const keyId = environment.WORKLOAD_SIGNING_KEY_ID;
  const key = /^arn:aws:kms:([a-z0-9-]+):(\d{12}):key\/([a-f0-9-]{36})$/.exec(keyId ?? '');
  if (!key || parsed.hostname.split('.')[2] !== key[1]) throw new Error('Issuer KMS binding is invalid');
  const policy = JSON.parse(environment.WORKLOAD_CALLER_POLICY_JSON ?? 'null');
  if (!Array.isArray(policy) || policy.length < 1 || policy.length > 6) throw new Error('Invalid workload caller policy');
  const seen = new Set();
  const subjects = new Set();
  const rules = policy.map(rule => {
    const role = rolePattern.exec(rule?.role_arn ?? rule?.roleArn ?? '');
    if (!role || role[2] !== key[2] || typeof rule.subject !== 'string'
      || !/^hid:staging:[a-z-]+$/.test(rule.subject) || !Array.isArray(rule.audiences)
      || rule.audiences.length < 1 || rule.audiences.length > 4 || rule.audiences.some(audience => !audiences.has(audience))) {
      throw new Error('Invalid workload caller policy');
    }
    const principal = `arn:aws:sts::${role[2]}:assumed-role/${role[3].split('/').at(-1)}/`;
    if (seen.has(principal) || subjects.has(rule.subject)) throw new Error('Ambiguous workload caller policy');
    seen.add(principal);
    subjects.add(rule.subject);
    return Object.freeze({ roleArn: role[0], principal, subject: rule.subject, audiences: Object.freeze([...new Set(rule.audiences)]) });
  });
  return Object.freeze({
    issuer, apiId, hostname: parsed.hostname, accountId: key[2], keyId,
    kid: key[3], ttlSeconds: 300, rules: Object.freeze(rules),
  });
}

export function derToJose(signature) {
  const bytes = Buffer.from(signature);
  if (bytes.length < 8 || bytes.length > 72 || bytes[0] !== 0x30 || bytes[1] !== bytes.length - 2) throw new Error('Invalid KMS signature');
  let offset = 2;
  const integer = () => {
    if (bytes[offset++] !== 0x02) throw new Error('Invalid KMS signature');
    const size = bytes[offset++];
    if (!size || size > 33 || offset + size > bytes.length) throw new Error('Invalid KMS signature');
    let value = bytes.subarray(offset, offset + size);
    offset += size;
    if (value[0] & 0x80 || (value.length > 1 && value[0] === 0 && !(value[1] & 0x80))) throw new Error('Invalid KMS signature');
    if (value[0] === 0 && value.length > 1) value = value.subarray(1);
    if (value.length > 32 || value.every(byte => byte === 0)) throw new Error('Invalid KMS signature');
    return Buffer.concat([Buffer.alloc(32 - value.length), value]);
  };
  const result = Buffer.concat([integer(), integer()]);
  if (offset !== bytes.length) throw new Error('Invalid KMS signature');
  return result;
}

export function publicJwk(result, configuration) {
  if (result.KeyId !== configuration.keyId || result.KeySpec !== 'ECC_NIST_P256' || result.KeyUsage !== 'SIGN_VERIFY'
    || !result.SigningAlgorithms?.includes('ECDSA_SHA_256') || !result.PublicKey) throw new Error('Invalid workload public key');
  const key = createPublicKey({ key: Buffer.from(result.PublicKey), format: 'der', type: 'spki' }).export({ format: 'jwk' });
  if (key.kty !== 'EC' || key.crv !== 'P-256') throw new Error('Invalid workload public key');
  return { kty: 'EC', crv: 'P-256', x: key.x, y: key.y, kid: configuration.kid, alg: 'ES256', use: 'sig' };
}

export function createIssuer(configuration, dependencies) {
  let cachedKey;
  const getKey = async () => {
    if (!cachedKey) cachedKey = Promise.resolve(dependencies.getPublicKey(configuration.keyId))
      .then(result => publicJwk(result, configuration)).catch(error => {
        cachedKey = undefined;
        throw error;
      });
    return cachedKey;
  };
  return async event => {
    const context = event?.requestContext;
    if (context?.apiId !== configuration.apiId || context?.stage !== 'staging'
      || context?.accountId !== configuration.accountId || context?.domainName !== configuration.hostname
      || context.httpMethod !== event?.httpMethod || context.resourcePath !== event?.resource) {
      return json(403, { code: 'WORKLOAD_CALLER_DENIED' });
    }
    if (event.httpMethod === 'GET' && event.resource === '/.well-known/jwks.json') {
      try {
        return json(200, { keys: [await getKey()] }, true);
      } catch {
        return json(503, { code: 'WORKLOAD_ISSUER_UNAVAILABLE' });
      }
    }
    if (event.httpMethod !== 'POST' || event.resource !== '/token') return json(404, { code: 'NOT_FOUND' });
    const principal = context.identity?.userArn;
    if (typeof principal !== 'string' || !assumedRolePattern.test(principal)
      || context.identity?.accountId !== configuration.accountId) return json(403, { code: 'WORKLOAD_CALLER_DENIED' });
    const rule = configuration.rules.find(candidate => principal.startsWith(candidate.principal));
    if (!rule) return json(403, { code: 'WORKLOAD_CALLER_DENIED' });
    let input;
    try {
      if (event.isBase64Encoded || typeof event.body !== 'string' || Buffer.byteLength(event.body) > 256
        || event.queryStringParameters && Object.keys(event.queryStringParameters).length > 0) throw new Error();
      input = JSON.parse(event.body);
      if (input === null || Array.isArray(input) || Object.keys(input).length !== 1 || typeof input.audience !== 'string') throw new Error();
    } catch {
      return json(400, { code: 'INVALID_WORKLOAD_REQUEST' });
    }
    if (!rule.audiences.includes(input.audience)) return json(403, { code: 'WORKLOAD_AUDIENCE_DENIED' });
    try {
      await getKey();
      const now = Math.floor((dependencies.now?.() ?? Date.now()) / 1000);
      const exp = now + configuration.ttlSeconds;
      const claims = {
        iss: configuration.issuer, sub: rule.subject, aud: input.audience,
        iat: now, nbf: now, exp, jti: randomUUID(), token_use: 'workload',
      };
      const message = `${encoded({ alg: 'ES256', kid: configuration.kid, typ: 'JWT' })}.${encoded(claims)}`;
      const signed = await dependencies.sign(configuration.keyId, Buffer.from(message));
      if (signed.KeyId !== configuration.keyId || signed.SigningAlgorithm !== 'ECDSA_SHA_256' || !signed.Signature) throw new Error();
      const token = `${message}.${derToJose(signed.Signature).toString('base64url')}`;
      return json(200, { token, expiresAt: new Date(exp * 1000).toISOString() });
    } catch {
      return json(503, { code: 'WORKLOAD_ISSUER_UNAVAILABLE' });
    }
  };
}
