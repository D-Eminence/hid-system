import { createHash, createHmac, createPublicKey, verify } from 'node:crypto';

// Narrow AWS Signature Version 4 signer, adapted from the workload token agent
// (services/workload-token-agent/src/agent.mjs signTokenRequest). It signs a
// POST with a JSON body to a fixed HTTPS endpoint: no query string, no encoded
// path segments, no redirects and no caller-chosen headers. The bridge uses it
// for exactly three calls: the workload issuer's /token (execute-api), SQS
// ChangeMessageVisibility and GuardDuty SendObjectMalwareScan.

const hash = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

// Lambda puts the execution role's session credentials in the environment and
// gives no expiry for them (the ECS agent's Expiration check does not apply);
// the runtime replaces them before they expire.
export function lambdaCredentials(environment) {
  const credentials = {
    AccessKeyId: environment.AWS_ACCESS_KEY_ID,
    SecretAccessKey: environment.AWS_SECRET_ACCESS_KEY,
    Token: environment.AWS_SESSION_TOKEN,
  };
  if (!/^ASIA[A-Z0-9]{16}$/.test(credentials.AccessKeyId ?? '')
    || typeof credentials.SecretAccessKey !== 'string' || credentials.SecretAccessKey.length < 32
    || typeof credentials.Token !== 'string' || credentials.Token.length < 16) {
    throw new Error('Lambda role credentials are unavailable');
  }
  return credentials;
}

export function signRequest({ url, service, region, credentials, body, headers: extra = {}, now = new Date() }) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port
    || endpoint.search || endpoint.hash || !/^\/[A-Za-z0-9/._-]*$/.test(endpoint.pathname)) {
    throw new Error('Invalid signed endpoint');
  }
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(service ?? '') || !/^[a-z]{2}-[a-z]+-\d$/.test(region ?? '')) {
    throw new Error('Invalid signing scope');
  }
  if (typeof body !== 'string') throw new Error('Signed body must be a string');
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = timestamp.slice(0, 8);
  const headers = { ...extra, host: endpoint.host, 'x-amz-date': timestamp };
  if (credentials.Token) headers['x-amz-security-token'] = credentials.Token;
  for (const name of Object.keys(headers)) {
    if (name !== name.toLowerCase() || typeof headers[name] !== 'string' || /[\r\n]/.test(headers[name])) {
      throw new Error('Invalid signed header');
    }
  }
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const canonical = ['POST', endpoint.pathname, '', names.map(name => `${name}:${headers[name].trim().replace(/\s+/g, ' ')}\n`).join(''),
    signedHeaders, hash(body)].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', timestamp, scope, hash(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${credentials.SecretAccessKey}`, day), region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.AccessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url: endpoint.href, method: 'POST', headers, body, redirect: 'error' };
}

// POST <issuer>/token with {"audience": ...}, signed for execute-api, exactly
// as the token agent signs it.
export function signTokenRequest(configuration, credentials, audience, now = new Date()) {
  const endpoint = new URL(`${configuration.issuer}/token`);
  if (endpoint.pathname !== `/${configuration.deployment}/token`) throw new Error('Invalid token endpoint');
  return signRequest({
    url: endpoint.href, service: 'execute-api', region: configuration.region, credentials,
    body: JSON.stringify({ audience }), headers: { 'content-type': 'application/json' }, now,
  });
}

function segment(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid workload JWT');
  const buffer = Buffer.from(value, 'base64url');
  if (buffer.toString('base64url') !== value) throw new Error('Invalid workload JWT');
  return buffer;
}

// The token agent's check of a freshly minted token (agent.mjs
// verifyMintedToken), unchanged: issuer, subject, audience, a 300 s or shorter
// lifetime, and an ES256 signature from the issuer's own JWKS.
export function verifyMintedToken(response, jwks, configuration, audience, now = Date.now()) {
  if (!response || typeof response.token !== 'string' || response.token.length > 16_384
    || typeof response.expiresAt !== 'string' || !Array.isArray(jwks?.keys) || jwks.keys.length < 1 || jwks.keys.length > 3) {
    throw new Error('Invalid minted workload token');
  }
  const parts = response.token.split('.');
  if (parts.length !== 3) throw new Error('Invalid workload JWT');
  const header = JSON.parse(segment(parts[0]).toString());
  const claims = JSON.parse(segment(parts[1]).toString());
  if (header.alg !== 'ES256' || header.typ !== 'JWT' || typeof header.kid !== 'string'
    || header.crit || header.jku || header.jwk || header.x5u || header.b64 !== undefined
    || claims.iss !== configuration.issuer || claims.sub !== configuration.subject || claims.aud !== audience
    || claims.token_use !== 'workload' || typeof claims.jti !== 'string'
    || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.nbf) || !Number.isSafeInteger(claims.exp)
    || claims.nbf !== claims.iat || claims.iat * 1000 > now + 5_000 || claims.iat * 1000 < now - 60_000
    || claims.exp <= claims.iat || claims.exp - claims.iat > 300 || claims.exp * 1000 <= now + 30_000
    || claims.exp * 1000 !== Date.parse(response.expiresAt)) throw new Error('Workload JWT claims are invalid');
  const keys = jwks.keys.filter(key => key.kid === header.kid && key.kty === 'EC' && key.crv === 'P-256'
    && key.alg === 'ES256' && key.use === 'sig' && !key.d);
  if (keys.length !== 1 || segment(parts[2]).length !== 64) throw new Error('Invalid workload JWT key');
  const key = createPublicKey({ key: keys[0], format: 'jwk' });
  if (!verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: 'ieee-p1363' }, segment(parts[2]))) {
    throw new Error('Workload JWT signature is invalid');
  }
  return { token: response.token, expiresAt: claims.exp * 1000 };
}

export async function boundedJson(response, limit = 32_768) {
  let text = '';
  if (response.body) {
    const reader = response.body.getReader();
    const chunks = []; let length = 0;
    try {
      while (true) {
        const result = await reader.read(); if (result.done) break;
        length += result.value.length;
        if (length > limit) throw new Error('Response exceeds limit');
        chunks.push(Buffer.from(result.value));
      }
    } finally { await reader.cancel().catch(() => undefined); }
    text = Buffer.concat(chunks).toString('utf8');
  }
  if (text === '') return undefined;
  return JSON.parse(text);
}

// One workload token for hid-identity-api, minted with the Lambda role and
// kept until 60 s before it expires (the issuer's tokens live 300 s).
export class TokenCache {
  constructor(configuration, dependencies) {
    this.configuration = configuration;
    this.fetch = dependencies.fetch;
    this.credentials = dependencies.credentials;
    this.now = dependencies.now ?? Date.now;
    this.cached = undefined;
  }
  clear() { this.cached = undefined; }
  async get() {
    if (this.cached && this.cached.expiresAt - 60_000 > this.now()) return this.cached.token;
    this.cached = undefined;
    const request = (url, options = {}) => this.fetch(url, { redirect: 'error', ...options, signal: AbortSignal.timeout(4000) });
    const jwksResponse = await request(this.configuration.jwks);
    if (!jwksResponse.ok) throw new Error('Workload JWKS is unavailable');
    const jwks = await boundedJson(jwksResponse);
    const signed = signTokenRequest(this.configuration, this.credentials(), 'hid-identity-api', new Date(this.now()));
    const minted = await request(signed.url, signed);
    if (!minted.ok) throw new Error('Workload issuer refused the token request');
    const verified = verifyMintedToken(await boundedJson(minted), jwks, this.configuration, 'hid-identity-api', this.now());
    this.cached = verified;
    return verified.token;
  }
}
