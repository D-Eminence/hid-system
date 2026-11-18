import { createHash, randomBytes } from 'node:crypto';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  SignJWT,
  type JWK,
  type JWTPayload,
} from 'jose';
import type { SsoHttp } from '../auth/sso/sso-provider.client';

/**
 * A fake OpenID Connect provider for the single sign-on tests (ADR-070),
 * built with `jose` in the test process: discovery, a key set, a token
 * endpoint that authenticates the client (private_key_jwt or
 * client_secret_basic) and checks the code, redirect URI and PKCE verifier,
 * and signed ID and logout tokens. It answers through `http`, which the
 * relying party is given instead of `fetch`, so no test touches the network.
 * Every host is fictional (`.invalid`). Excluded from the build.
 *
 * It stands in for the coordinator's oidc-provider only as far as the
 * contract (contract v2) describes it; the claim names it signs are the
 * assumptions the PR lists.
 */
export const BACKCHANNEL_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

export interface FakeClient {
  readonly kind: 'staff' | 'patient';
  readonly redirectUri: string;
  /** The public key a private_key_jwt client registered. */
  readonly publicJwk?: JWK;
  readonly secret?: string;
}

interface IssuedCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly nonce: string;
  readonly claims: JWTPayload;
  used: boolean;
}

export interface FakeProvider {
  readonly issuer: string;
  readonly http: SsoHttp;
  /** Every call the relying party made, as `METHOD origin+path`. */
  readonly calls: string[];
  /** The last token request's form and Authorization header. */
  lastTokenRequest?: { form: URLSearchParams; authorization?: string };
  /** Overrides of the discovery document; `undefined` values remove a field. */
  discovery: Record<string, unknown>;
  down: { discovery: boolean; keys: boolean; token: boolean };
  /** The provider's answer to the next token request, instead of an ID token. */
  tokenAnswer?: { status: number; body: unknown };
  /** Claims merged into the next ID token (after the code's own). */
  idTokenOverrides: JWTPayload;
  /** Header fields merged into the next ID token. */
  idTokenHeader: Record<string, unknown>;
  /**
   * Signs in at the authorization endpoint the relying party sent the
   * browser to, and answers the code it would redirect back with.
   */
  authorize(location: string, claims: JWTPayload): string;
  signLogoutToken(claims: JWTPayload, header?: Record<string, unknown>, key?: 'provider' | 'stranger'): Promise<string>;
  signIdToken(claims: JWTPayload, header?: Record<string, unknown>): Promise<string>;
  /** Replaces the signing key (as a key rotation does) and publishes only the new one. */
  rotateKey(): Promise<void>;
}

export async function createFakeProvider(issuer: string, clients: Record<string, FakeClient>): Promise<FakeProvider> {
  let signing = await providerKey('provider-key-1');
  const stranger = await providerKey('stranger-key');
  const codes = new Map<string, IssuedCode>();
  const provider: FakeProvider = {
    issuer,
    calls: [],
    discovery: {},
    down: { discovery: false, keys: false, token: false },
    idTokenOverrides: {},
    idTokenHeader: {},
    http: async (url, init) => handle(new URL(url), init),
    authorize(location, claims) {
      const url = new URL(location);
      if (url.origin + url.pathname !== `${issuer}/auth`) throw new Error(`not the authorization endpoint: ${url.origin}`);
      const params = url.searchParams;
      const clientId = params.get('client_id') ?? '';
      const client = clients[clientId];
      if (!client || params.get('redirect_uri') !== client.redirectUri) throw new Error('unregistered redirect');
      if (params.get('response_type') !== 'code' || params.get('scope') !== 'openid'
        || params.get('code_challenge_method') !== 'S256' || !params.get('code_challenge')
        || !params.get('state') || !params.get('nonce')) {
        throw new Error('not a code flow request with PKCE, state and nonce');
      }
      const code = randomBytes(24).toString('base64url');
      codes.set(code, { clientId, redirectUri: client.redirectUri, challenge: params.get('code_challenge')!,
        nonce: params.get('nonce')!, claims, used: false });
      return code;
    },
    signLogoutToken: async (claims, header = {}, key = 'provider') => {
      const now = Math.floor(Date.now() / 1_000);
      const chosen = key === 'provider' ? signing : stranger;
      // A claim given as undefined is left out.
      const payload: JWTPayload = { iss: issuer, iat: now, exp: now + 120, jti: randomBytes(12).toString('hex'),
        events: { [BACKCHANNEL_EVENT]: {} }, ...claims };
      for (const [name, value] of Object.entries(payload)) if (value === undefined) delete payload[name];
      const protectedHeader = { alg: 'ES256', kid: chosen.kid, typ: 'logout+jwt', ...header };
      for (const [name, value] of Object.entries(protectedHeader)) {
        if (value === undefined) delete (protectedHeader as Record<string, unknown>)[name];
      }
      return new SignJWT(payload).setProtectedHeader(protectedHeader).sign(chosen.privateKey);
    },
    signIdToken: (claims, header = {}) => signIdToken(claims, header),
    async rotateKey() {
      signing = await providerKey('provider-key-2');
    },
  };

  async function signIdToken(claims: JWTPayload, header: Record<string, unknown>): Promise<string> {
    const now = Math.floor(Date.now() / 1_000);
    const payload: JWTPayload = { iss: issuer, iat: now, exp: now + 300, auth_time: now - 5, ...claims };
    for (const [name, value] of Object.entries(payload)) if (value === undefined) delete payload[name];
    return new SignJWT(payload).setProtectedHeader({ alg: 'ES256', kid: signing.kid, ...header })
      .sign(signing.privateKey);
  }

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  function documentOf(): Record<string, unknown> {
    const document: Record<string, unknown> = {
      issuer,
      authorization_endpoint: `${issuer}/auth`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      end_session_endpoint: `${issuer}/session/end`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      id_token_signing_alg_values_supported: ['ES256', 'RS256'],
      backchannel_logout_supported: true,
      backchannel_logout_session_supported: true,
      ...provider.discovery,
    };
    for (const [name, value] of Object.entries(document)) if (value === undefined) delete document[name];
    return document;
  }

  async function handle(url: URL, init: RequestInit): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    provider.calls.push(`${method} ${url.origin}${url.pathname}`);
    if (init.redirect !== 'error') throw new Error('the relying party must not follow redirects');
    if (method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      if (provider.down.discovery) throw new TypeError('fetch failed');
      return json(200, documentOf());
    }
    if (method === 'GET' && url.pathname === '/jwks') {
      if (provider.down.keys) return json(503, { error: 'unavailable' });
      return json(200, { keys: [signing.publicJwk] });
    }
    if (method === 'POST' && url.pathname === '/token') {
      if (provider.down.token) throw new TypeError('fetch failed');
      return token(new URLSearchParams(String(init.body)), headerOf(init, 'authorization'));
    }
    return json(404, { error: 'not_found' });
  }

  async function token(form: URLSearchParams, authorization: string | undefined): Promise<Response> {
    provider.lastTokenRequest = { form, authorization };
    if (provider.tokenAnswer) {
      const answer = provider.tokenAnswer;
      provider.tokenAnswer = undefined;
      return json(answer.status, answer.body);
    }
    const clientId = await authenticatedClient(form, authorization);
    if (!clientId) return json(401, { error: 'invalid_client' });
    const issued = codes.get(form.get('code') ?? '');
    if (form.get('grant_type') !== 'authorization_code' || !issued || issued.used || issued.clientId !== clientId
      || form.get('redirect_uri') !== issued.redirectUri) {
      return json(400, { error: 'invalid_grant' });
    }
    issued.used = true;
    const verifier = form.get('code_verifier') ?? '';
    if (createHash('sha256').update(verifier, 'ascii').digest('base64url') !== issued.challenge) {
      return json(400, { error: 'invalid_grant' });
    }
    const idToken = await signIdToken({ aud: clientId, nonce: issued.nonce, ...issued.claims,
      ...provider.idTokenOverrides }, provider.idTokenHeader);
    provider.idTokenOverrides = {};
    provider.idTokenHeader = {};
    return json(200, { access_token: randomBytes(16).toString('hex'), token_type: 'Bearer', expires_in: 60,
      id_token: idToken });
  }

  async function authenticatedClient(form: URLSearchParams, authorization: string | undefined): Promise<string | undefined> {
    if (authorization?.startsWith('Basic ')) {
      const [user, password] = Buffer.from(authorization.slice(6), 'base64').toString('utf8').split(':');
      const clientId = decodeURIComponent(user ?? '');
      const client = clients[clientId];
      return client?.secret && decodeURIComponent(password ?? '') === client.secret ? clientId : undefined;
    }
    const clientId = form.get('client_id') ?? '';
    const client = clients[clientId];
    if (!client?.publicJwk || form.get('client_assertion_type')
      !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') return undefined;
    try {
      const { payload } = await jwtVerify(form.get('client_assertion') ?? '',
        createLocalJWKSet({ keys: [client.publicJwk] }), { issuer: clientId, subject: clientId, audience: issuer,
          algorithms: ['ES256'], maxTokenAge: 120, requiredClaims: ['jti', 'exp'] });
      return payload.sub;
    } catch {
      return undefined;
    }
  }

  return provider;
}

/** A client key pair for private_key_jwt: the private JWK for the relying party, the public one for the provider. */
export async function clientKeyPair(kid: string): Promise<{ privateJwk: JWK; publicJwk: JWK }> {
  const pair = await generateKeyPair('ES256', { extractable: true });
  return {
    privateJwk: { ...await exportJWK(pair.privateKey), kid },
    publicJwk: { ...await exportJWK(pair.publicKey), kid, alg: 'ES256', use: 'sig' },
  };
}

async function providerKey(kid: string): Promise<{ kid: string; privateKey: CryptoKey; publicJwk: JWK }> {
  const pair = await generateKeyPair('ES256');
  const publicJwk: JWK = { ...await exportJWK(pair.publicKey), kid, alg: 'ES256', use: 'sig' };
  return { kid, privateKey: pair.privateKey, publicJwk };
}

function headerOf(init: RequestInit, name: string): string | undefined {
  const headers = init.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) return headers.find(([key]) => key.toLowerCase() === name)?.[1];
  return (headers as Record<string, string>)[name];
}
