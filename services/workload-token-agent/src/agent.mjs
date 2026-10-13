import { createHash, createHmac, createPublicKey, randomUUID, verify } from 'node:crypto';
import { open, rename, unlink, lstat, chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const audienceFiles = { 'hid-identity-api': 'identity.jwt', 'hid-ehr-api': 'ehr.jwt', 'hid-lab-api': 'lab.jwt',
  'hid-pharmacy-api': 'pharmacy.jwt', 'hid-notification-api': 'notification.jwt' };
// One allowlisted deployment environment names the issuer path and the subject
// prefix together; the issuer binds the same value to the API stage.
const stages = new Set(['staging', 'production']);
// DEP-4-DOS: the agent keeps keys that verified a minted token, by kid, and
// fetches the JWKS only at start and for an unknown kid, at most this often.
// A JWKS outage or flood then does not stop renewal under a known kid.
export const jwksRefetchIntervalMs = 30_000;
const hash = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

export function agentConfiguration(environment) {
  const stage = environment.HID_DEPLOYMENT_ENV;
  if (!stages.has(stage)) throw new Error('Workload token agent environment is not allowed');
  const region = environment.AWS_REGION;
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(region ?? '')) throw new Error('Invalid agent AWS region');
  const issuer = new URL(environment.WORKLOAD_ISSUER_URL);
  if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.port || issuer.search || issuer.hash
    || issuer.pathname !== `/${stage}` || !new RegExp(`^[a-z0-9]+\\.execute-api\\.${region}\\.amazonaws\\.com$`).test(issuer.hostname)) {
    throw new Error('Invalid workload issuer URL');
  }
  if (environment.WORKLOAD_JWKS_URL !== `${issuer.href}/.well-known/jwks.json`) throw new Error('JWKS must belong to the configured issuer');
  const subject = environment.WORKLOAD_SUBJECT;
  if (!new RegExp(`^hid:${stage}:[a-z-]+$`).test(subject ?? '')) throw new Error('Invalid workload subject');
  const directory = environment.WORKLOAD_TOKEN_DIRECTORY ?? '/var/run/hid/workload-tokens';
  if (directory !== '/var/run/hid/workload-tokens') throw new Error('Token volume path must match the admitted image');
  const files = JSON.parse(environment.WORKLOAD_TOKEN_FILES_JSON ?? 'null');
  if (!Array.isArray(files) || files.length < 1 || files.length > 4) throw new Error('Invalid token file mapping');
  const seen = new Set();
  for (const entry of files) {
    if (typeof entry !== 'object' || entry === null || Object.keys(entry).length !== 2
      || !Object.hasOwn(audienceFiles, entry.audience) || audienceFiles[entry.audience] !== entry.file || seen.has(entry.file)) {
      throw new Error('Invalid token file mapping');
    }
    seen.add(entry.file);
  }
  const credentialPath = environment.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  if (!/^\/v2\/credentials\/[A-Za-z0-9-]{1,100}$/.test(credentialPath ?? '')) throw new Error('ECS task credential source is unavailable');
  return { stage, region, issuer: issuer.href, jwks: environment.WORKLOAD_JWKS_URL, subject, directory, files,
    credentialUrl: `http://169.254.170.2${credentialPath}` };
}

export async function boundedJson(response, limit = 32768) {
  if (!response.ok) throw new Error('Workload dependency rejected request');
  if (!response.body) throw new Error('Workload dependency response is empty');
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  try {
    while (true) {
      const result = await reader.read(); if (result.done) break;
      length += result.value.length;
      if (length > limit) throw new Error('Workload response exceeds limit');
      chunks.push(Buffer.from(result.value));
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// Narrow SigV4 implementation: POST to the fixed API Gateway /<stage>/token
// endpoint with no query, encoded path segments, redirects or arbitrary headers.
export function signTokenRequest(configuration, credentials, audience, now = new Date()) {
  const endpoint = new URL(`${configuration.issuer}/token`);
  if (!stages.has(configuration.stage) || endpoint.pathname !== `/${configuration.stage}/token` || endpoint.search || endpoint.hash) {
    throw new Error('Invalid token endpoint');
  }
  if (!/^ASIA[A-Z0-9]{16}$/.test(credentials.AccessKeyId ?? '')
    || typeof credentials.SecretAccessKey !== 'string' || credentials.SecretAccessKey.length < 32
    || typeof credentials.Token !== 'string' || credentials.Token.length < 16
    || !Number.isFinite(Date.parse(credentials.Expiration)) || Date.parse(credentials.Expiration) <= now.getTime() + 30_000) {
    throw new Error('ECS task credentials are invalid or expired');
  }
  const body = JSON.stringify({ audience });
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = timestamp.slice(0, 8);
  const headers = { 'content-type': 'application/json', host: endpoint.host,
    'x-amz-date': timestamp, 'x-amz-security-token': credentials.Token };
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const canonical = ['POST', endpoint.pathname, '', names.map(name => `${name}:${headers[name].trim().replace(/\s+/g, ' ')}\n`).join(''),
    signedHeaders, hash(body)].join('\n');
  const scope = `${day}/${configuration.region}/execute-api/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', timestamp, scope, hash(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${credentials.SecretAccessKey}`, day), configuration.region), 'execute-api'), 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.AccessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url: endpoint.href, method: 'POST', headers, body, redirect: 'error' };
}

function segment(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid workload JWT');
  const buffer = Buffer.from(value, 'base64url');
  if (buffer.toString('base64url') !== value) throw new Error('Invalid workload JWT');
  return buffer;
}

/** The public ES256 signing keys of a key set under one kid; a valid token needs exactly one. */
const signingKeys = (jwks, kid) => jwks.keys.filter(key => key?.kid === kid && key.kty === 'EC' && key.crv === 'P-256'
  && key.alg === 'ES256' && key.use === 'sig' && !key.d);

/** The kid in a minted token's header, read before the key set is chosen; verifyMintedToken checks the rest. */
export function mintedKeyId(response) {
  if (!response || typeof response.token !== 'string' || response.token.length > 16_384) throw new Error('Invalid minted workload token');
  const parts = response.token.split('.');
  if (parts.length !== 3) throw new Error('Invalid workload JWT');
  const header = JSON.parse(segment(parts[0]).toString());
  if (typeof header?.kid !== 'string' || !header.kid || header.kid.length > 256) throw new Error('Invalid workload JWT');
  return header.kid;
}

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
  const keys = signingKeys(jwks, header.kid);
  if (keys.length !== 1 || segment(parts[2]).length !== 64) throw new Error('Invalid workload JWT key');
  const key = createPublicKey({ key: keys[0], format: 'jwk' });
  if (!verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: 'ieee-p1363' }, segment(parts[2]))) {
    throw new Error('Workload JWT signature is invalid');
  }
  return { token: response.token, expiresAt: claims.exp * 1000 };
}

export async function prepareDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid()) throw new Error('Token volume ownership is invalid');
  await chmod(directory, 0o700);
}

export async function atomicToken(directory, filename, token) {
  if (!Object.values(audienceFiles).includes(filename) && filename !== 'ready.json') throw new Error('Invalid token filename');
  const temporary = join(directory, `.pending-${randomUUID()}`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(token, 'utf8'); await handle.sync(); await handle.close(); handle = undefined;
    await rename(temporary, join(directory, filename));
  } finally {
    if (handle) await handle.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export class TokenAgent {
  constructor(configuration, dependencies = {}) {
    this.configuration = configuration;
    this.fetch = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? Date.now;
    this.expirations = new Map();
    this.verifiedKeys = new Map();
    this.fetchedKeys = undefined;
    this.lastJwksFetch = undefined;
  }
  async start() {
    await prepareDirectory(this.configuration.directory);
    // Never trust files left by an earlier process without fresh issuer proof.
    await this.clear();
  }
  async clear() {
    for (const file of [...this.configuration.files.map(entry => entry.file), 'ready.json']) {
      await unlink(join(this.configuration.directory, file)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    this.expirations.clear();
  }
  async purgeExpired() {
    let expired = false;
    for (const { file } of this.configuration.files) {
      if ((this.expirations.get(file) ?? 0) <= this.now() + 5_000) {
        await unlink(join(this.configuration.directory, file)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        this.expirations.delete(file); expired = true;
      }
    }
    if (expired) await unlink(join(this.configuration.directory, 'ready.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  async refreshKeys(request) {
    const now = this.now();
    if (this.lastJwksFetch !== undefined && now - this.lastJwksFetch < jwksRefetchIntervalMs) {
      throw new Error('Workload JWKS refresh is rate limited');
    }
    this.lastJwksFetch = now;
    const jwks = await boundedJson(await request(this.configuration.jwks));
    if (!Array.isArray(jwks?.keys) || jwks.keys.length < 1 || jwks.keys.length > 3) throw new Error('Invalid workload JWKS');
    // Forget every key the issuer no longer publishes, or publishes differently.
    for (const [kid, key] of this.verifiedKeys) {
      if (!jwks.keys.some(candidate => candidate?.kid === kid && candidate.kty === key.kty && candidate.crv === key.crv
        && candidate.x === key.x && candidate.y === key.y)) this.verifiedKeys.delete(kid);
    }
    this.fetchedKeys = jwks;
  }
  async keySetFor(kid, request) {
    const verified = this.verifiedKeys.get(kid);
    if (verified) return { keys: [verified] };
    if (!this.fetchedKeys?.keys.some(key => key?.kid === kid)) await this.refreshKeys(request);
    return this.fetchedKeys;
  }
  async renew() {
    const request = (url, options = {}) => this.fetch(url, { redirect: 'error', ...options, signal: AbortSignal.timeout(5000) });
    const credentials = await boundedJson(await request(this.configuration.credentialUrl), 16384);
    // At start there is no key to verify with; fetch before minting anything.
    if (this.verifiedKeys.size === 0 && !this.fetchedKeys) await this.refreshKeys(request);
    // Validate every audience before updating files. Existing fresh files remain
    // usable on a transient issuer failure, only until their strict expiry.
    const next = [];
    for (const entry of this.configuration.files) {
      const signed = signTokenRequest(this.configuration, credentials, entry.audience, new Date(this.now()));
      const response = await boundedJson(await request(signed.url, signed));
      const kid = mintedKeyId(response);
      const jwks = await this.keySetFor(kid, request);
      next.push({ ...entry, ...verifyMintedToken(response, jwks, this.configuration, entry.audience, this.now()) });
      if (!this.verifiedKeys.has(kid)) this.verifiedKeys.set(kid, signingKeys(jwks, kid)[0]);
    }
    for (const entry of next) {
      await atomicToken(this.configuration.directory, entry.file, entry.token);
      this.expirations.set(entry.file, entry.expiresAt);
    }
    const expiresAt = Math.min(...this.expirations.values());
    await atomicToken(this.configuration.directory, 'ready.json', JSON.stringify({ expiresAt }));
  }
}
