import { webcrypto } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import type { ClientAuth, Configuration, CustomFetch, IDToken, ServerMetadata } from 'openid-client';
import type { SsoClient, SsoConfiguration } from './sso-config';
import { SsoProviderUnavailable, SsoTokenRefused } from './sso-errors';
import { jose, openid } from './sso-libraries';

/**
 * The relying party's side of the provider on `auth.` (ADR-070), built on
 * panva's certified `openid-client`:
 *
 * - discovery (`discovery`), the authorization URL (`buildAuthorizationUrl`),
 *   the code exchange with the client's own authentication (`PrivateKeyJwt` or
 *   `ClientSecretBasic`) and the ID token's checks (`authorizationCodeGrant`:
 *   `iss`, `aud`, `azp` with several audiences, `exp`, `nonce`, `auth_time`
 *   against `max_age`, `state`, the RFC 9207 `iss` parameter when the provider
 *   announces it, and the signature against the provider's key set, which
 *   `enableNonRepudiationChecks` turns on), and the end-session URL
 *   (`buildEndSessionUrl`);
 * - then the checks the product adds (checkIdTokenClaims): `azp` whenever it
 *   is present, `iat` no older than five minutes, `sub` an account id, `sid`,
 *   `auth_time` not in the future, the kind the client accepts, and a second
 *   factor for staff;
 * - the back-channel logout token, for which openid-client has no helper,
 *   with `jose` (verifyLogoutToken).
 *
 * Discovery is cached for five minutes, with the key sets that go with it, and
 * then read again; a read that fails once the copy is stale fails closed
 * (SsoProviderUnavailable), never with the stale copy and never without a
 * check. Every call goes through one transport (providerFetch): only to the
 * issuer's own origin, rewritten to AUTH_SSO_INTERNAL_BASE_URL when set,
 * never following a redirect, five seconds at most, and an answer of at most
 * 256 KiB.
 */
export const SSO_HTTP = Symbol('SSO_HTTP');
export const SSO_CLOCK = Symbol('SSO_CLOCK');
/** The HTTP call used to reach the provider; tests pass a fake provider, so no network is used. */
export type SsoHttp = (url: string, init: RequestInit) => Promise<Response>;

export const SSO_METADATA_TTL_MS = 5 * 60_000;
const HTTP_TIMEOUT_SECONDS = 5;
const MAX_RESPONSE_BYTES = 256 * 1_024;
/** Allowed clock difference with the provider, in seconds (openid-client's default). */
export const SSO_CLOCK_TOLERANCE_SECONDS = 30;
/** An ID token is fresh from the token endpoint: older than this, it is refused. */
const ID_TOKEN_MAX_AGE_SECONDS = 300;
/** A logout token is sent as the provider session ends: older than this, it is refused. */
export const LOGOUT_TOKEN_MAX_AGE_SECONDS = 300;
/** Asymmetric signatures only: never `none` and never a shared-secret MAC. */
export const SSO_SIGNING_ALGORITHMS: readonly string[] = ['ES256', 'PS256', 'RS256', 'EdDSA'];
export const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ProviderMetadata {
  readonly issuer: string;
  /** Public: the browser is sent here. */
  readonly authorizationEndpoint: string;
  /** Public: the browser is sent here to sign out everywhere. */
  readonly endSessionEndpoint: string;
  /** Called by Identity (through the internal base when one is configured). */
  readonly tokenEndpoint: string;
  /** Read by Identity (through the internal base when one is configured). */
  readonly jwksUri: string;
  /** The signature algorithms accepted on its tokens. */
  readonly algorithms: readonly string[];
}

export interface AuthorizationRequest {
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly maxAgeSeconds: number;
  readonly prompt?: 'none' | 'login';
}

export interface VerifiedIdToken {
  /** The identity account id (`sub`). */
  readonly accountId: string;
  /** The provider's session id (`sid`). */
  readonly sid: string;
  /** When the person last signed in at the provider (`auth_time`). */
  readonly authenticatedAt: Date;
  /** The second factor of a staff sign-in, from `amr`. */
  readonly mfaMethod?: 'totp' | 'recovery_code';
}

export interface CompletedCodeFlow {
  /** The ID token as the provider issued it, kept server-side for `id_token_hint`. */
  readonly idToken: string;
  readonly verified: VerifiedIdToken;
}

export interface VerifiedLogoutToken {
  readonly jti: string;
  readonly sid?: string;
  readonly accountId?: string;
  /** Until when this token could be accepted; its jti is kept spent until then. */
  readonly acceptableUntil: Date;
}

/** One discovery and everything derived from it; replaced as a whole when it is stale. */
interface Discovered {
  readonly issuer: string;
  readonly loadedAt: number;
  readonly metadata: ProviderMetadata;
  /** The server metadata each client's openid-client Configuration is built from. */
  readonly server: ServerMetadata;
  readonly clients: Map<string, Promise<Configuration>>;
  logoutKeys?: JWTVerifyGetKey;
}

/** The request a provider call is given, as openid-client and jose make it. */
interface ProviderRequest {
  method?: string;
  headers?: Record<string, string> | Headers;
  body?: unknown;
  signal?: AbortSignal | null;
}

@Injectable()
export class SsoProviderClient {
  private discoveredCache?: Discovered;
  private discovering?: Promise<Discovered>;

  constructor(
    @Optional() @Inject(SSO_HTTP) private readonly http?: SsoHttp,
    // Reads the time for the discovery cache only; every token check uses the real time.
    @Optional() @Inject(SSO_CLOCK) private readonly clock?: () => number,
  ) {}

  /** The provider's metadata, from the cache while it is fresh. */
  async metadata(configuration: SsoConfiguration): Promise<ProviderMetadata> {
    return (await this.discovered(configuration)).metadata;
  }

  /**
   * Where to send the browser to sign in: the provider's authorization
   * endpoint with the code flow, `openid`, S256 PKCE, `state`, `nonce`,
   * `max_age` and `prompt` when asked. Built by openid-client from discovery
   * and this client's configured redirect URI, never from the request.
   */
  async authorizationUrl(configuration: SsoConfiguration, client: SsoClient,
    request: AuthorizationRequest): Promise<string> {
    const config = await this.configurationOf(configuration, client);
    const parameters: Record<string, string> = {
      redirect_uri: client.redirectUri,
      response_type: 'code',
      scope: 'openid',
      state: request.state,
      nonce: request.nonce,
      code_challenge: request.codeChallenge,
      code_challenge_method: 'S256',
      max_age: String(request.maxAgeSeconds),
    };
    if (request.prompt) parameters.prompt = request.prompt;
    return openid().buildAuthorizationUrl(config, parameters).href;
  }

  /**
   * The callback's code exchange (openid-client authorizationCodeGrant): the
   * authorization response is checked against the transaction's `state` (and
   * the provider's `iss` parameter), the code exchanged at the token endpoint
   * with the PKCE verifier and the client's authentication, and the ID token
   * checked against the transaction's `nonce`, `max_age`, this client and the
   * provider's key set. Then the product's own checks (checkIdTokenClaims).
   */
  async completeCodeFlow(configuration: SsoConfiguration, client: SsoClient, callback: URLSearchParams,
    expected: { state: string; nonce: string; verifier: string; maxAgeSeconds: number }): Promise<CompletedCodeFlow> {
    const config = await this.configurationOf(configuration, client);
    // The registered redirect URI with the parameters the provider sent back:
    // openid-client derives the redirect_uri it sends from it.
    const currentUrl = new URL(client.redirectUri);
    currentUrl.search = callback.toString();
    let tokens: Awaited<ReturnType<ReturnType<typeof openid>['authorizationCodeGrant']>>;
    try {
      tokens = await openid().authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: expected.verifier,
        expectedState: expected.state,
        expectedNonce: expected.nonce,
        maxAge: expected.maxAgeSeconds,
        idTokenExpected: true,
      });
    } catch (error) {
      throw classified(error);
    }
    const claims = tokens.claims();
    if (!claims || typeof tokens.id_token !== 'string' || tokens.id_token.length > 16_384) {
      throw new SsoTokenRefused('id_token');
    }
    return { idToken: tokens.id_token, verified: checkIdTokenClaims(client, claims) };
  }

  /**
   * The provider's end-session address for a product sign-out
   * (openid-client buildEndSessionUrl): `client_id`, `post_logout_redirect_uri`
   * the product's own root, and `id_token_hint` when one is given.
   */
  async endSessionUrl(configuration: SsoConfiguration, client: SsoClient, idTokenHint?: string): Promise<string> {
    const config = await this.configurationOf(configuration, client);
    return openid().buildEndSessionUrl(config, {
      ...(idTokenHint ? { id_token_hint: idTokenHint } : {}),
      post_logout_redirect_uri: client.postLogoutRedirectUri,
    }).href;
  }

  /**
   * Checks a back-channel logout token (OpenID Connect Back-Channel Logout
   * 1.0, section 2.6) for this client, with `jose`, as openid-client has no
   * helper for it: the signature by the provider's key set (the one discovery
   * names, cached and reloaded with it), `iss`, `aud` (and `azp` when
   * present), `iat` no older than five minutes, `exp` when present, `typ` when
   * present, a `jti`, the back-channel logout event, `sid` and/or `sub`, and
   * no `nonce`. The caller spends the `jti` once.
   */
  async verifyLogoutToken(configuration: SsoConfiguration, client: SsoClient, token: string): Promise<VerifiedLogoutToken> {
    let header: { typ?: unknown };
    try {
      header = jose().decodeProtectedHeader(token);
    } catch {
      throw new SsoTokenRefused('malformed');
    }
    if (header.typ !== undefined && (typeof header.typ !== 'string'
      || header.typ.toLowerCase().replace(/^application\//, '') !== 'logout+jwt')) {
      throw new SsoTokenRefused('typ');
    }
    const discovered = await this.discovered(configuration);
    discovered.logoutKeys ??= jose().createRemoteJWKSet(new URL(discovered.metadata.jwksUri), {
      [jose().customFetch]: this.providerFetch(configuration) as never,
      timeoutDuration: HTTP_TIMEOUT_SECONDS * 1_000,
      cooldownDuration: 30_000,
      cacheMaxAge: SSO_METADATA_TTL_MS,
    });
    let payload: JWTPayload;
    try {
      ({ payload } = await jose().jwtVerify(token, discovered.logoutKeys, {
        issuer: configuration.issuer,
        audience: client.id,
        algorithms: [...discovered.metadata.algorithms],
        maxTokenAge: LOGOUT_TOKEN_MAX_AGE_SECONDS,
        clockTolerance: SSO_CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ['iat', 'jti', 'events'],
      }));
    } catch (error) {
      throw classifiedJose(error);
    }
    if (payload.azp !== undefined && payload.azp !== client.id) throw new SsoTokenRefused('azp');
    if (Object.hasOwn(payload, 'nonce')) throw new SsoTokenRefused('nonce');
    const events = payload.events;
    if (!isRecord(events) || !isRecord(events[BACKCHANNEL_LOGOUT_EVENT])) throw new SsoTokenRefused('events');
    if (typeof payload.jti !== 'string' || payload.jti.length < 1 || payload.jti.length > 255) {
      throw new SsoTokenRefused('jti');
    }
    const sid = payload.sid === undefined ? undefined : providerSessionId(payload.sid);
    if (payload.sid !== undefined && !sid) throw new SsoTokenRefused('sid');
    const accountId = payload.sub;
    if (accountId !== undefined && (typeof accountId !== 'string' || !UUID.test(accountId))) {
      throw new SsoTokenRefused('sub');
    }
    if (!sid && accountId === undefined) throw new SsoTokenRefused('neither sid nor sub');
    const iat = payload.iat as number;
    return {
      jti: payload.jti,
      ...(sid ? { sid } : {}),
      ...(accountId ? { accountId: accountId.toLowerCase() } : {}),
      acceptableUntil: new Date((iat + LOGOUT_TOKEN_MAX_AGE_SECONDS + SSO_CLOCK_TOLERANCE_SECONDS) * 1_000),
    };
  }

  private async discovered(configuration: SsoConfiguration): Promise<Discovered> {
    const cached = this.discoveredCache;
    if (cached && cached.issuer === configuration.issuer && this.now() - cached.loadedAt < SSO_METADATA_TTL_MS) {
      return cached;
    }
    // Concurrent callers share one read. A stale copy is never answered: a
    // failed read fails this call, and the next call reads again.
    this.discovering ??= this.discover(configuration).then((value) => {
      this.discoveredCache = value;
      return value;
    }).finally(() => {
      this.discovering = undefined;
    });
    return this.discovering;
  }

  private async discover(configuration: SsoConfiguration): Promise<Discovered> {
    const library = openid();
    // Discovery needs a client id; the server metadata it reads is every client's.
    const anyClient = configuration.clients.keys().next().value as string;
    let document: Record<string, unknown>;
    try {
      const discovered = await library.discovery(new URL(configuration.issuer), anyClient, undefined, library.None(), {
        [library.customFetch]: this.providerFetch(configuration),
        timeout: HTTP_TIMEOUT_SECONDS,
        execute: insecure(configuration) ? [library.allowInsecureRequests] : [],
      });
      // A plain copy: the helpers openid-client adds are not data.
      document = JSON.parse(JSON.stringify(discovered.serverMetadata())) as Record<string, unknown>;
    } catch (error) {
      throw error instanceof SsoProviderUnavailable ? error
        : unwrapUnavailable(error) ?? new SsoProviderUnavailable('discovery');
    }
    if (document.issuer !== configuration.issuer) throw new SsoProviderUnavailable('discovery names another issuer');
    const endpoint = (name: string): string => {
      const value = document[name];
      let url: URL;
      try {
        url = new URL(String(value));
      } catch {
        throw new SsoProviderUnavailable(`discovery has no ${name}`);
      }
      // Every endpoint is the issuer's own: discovery cannot send the browser,
      // a code or a client credential anywhere else.
      if (typeof value !== 'string' || url.origin !== configuration.issuer || url.username || url.password || url.hash) {
        throw new SsoProviderUnavailable(`discovery ${name} is not on the issuer`);
      }
      return url.href;
    };
    const listed = (name: string): unknown[] | undefined =>
      Array.isArray(document[name]) ? document[name] as unknown[] : undefined;
    if (listed('response_types_supported') && !listed('response_types_supported')!.includes('code')) {
      throw new SsoProviderUnavailable('the provider does not offer the code flow');
    }
    if (listed('code_challenge_methods_supported') && !listed('code_challenge_methods_supported')!.includes('S256')) {
      throw new SsoProviderUnavailable('the provider does not offer PKCE S256');
    }
    const offered = listed('id_token_signing_alg_values_supported');
    const algorithms = offered ? SSO_SIGNING_ALGORITHMS.filter((algorithm) => offered.includes(algorithm))
      : [...SSO_SIGNING_ALGORITHMS];
    if (algorithms.length === 0) throw new SsoProviderUnavailable('the provider offers no allowed signature');
    const metadata: ProviderMetadata = Object.freeze({
      issuer: configuration.issuer,
      authorizationEndpoint: endpoint('authorization_endpoint'),
      endSessionEndpoint: endpoint('end_session_endpoint'),
      tokenEndpoint: endpoint('token_endpoint'),
      jwksUri: endpoint('jwks_uri'),
      algorithms: Object.freeze([...algorithms]),
    });
    return {
      issuer: configuration.issuer,
      loadedAt: this.now(),
      metadata,
      // openid-client accepts an ID token signed only with an algorithm this
      // lists: the asymmetric ones the product allows that the provider offers.
      server: { ...document, issuer: configuration.issuer, id_token_signing_alg_values_supported: [...algorithms] } as ServerMetadata,
      clients: new Map(),
    };
  }

  /** The openid-client Configuration of one client, built once per discovery. */
  private async configurationOf(configuration: SsoConfiguration, client: SsoClient): Promise<Configuration> {
    const discovered = await this.discovered(configuration);
    let built = discovered.clients.get(client.id);
    if (!built) {
      built = this.buildConfiguration(configuration, discovered, client);
      discovered.clients.set(client.id, built);
      built.catch(() => discovered.clients.delete(client.id));
    }
    return built;
  }

  private async buildConfiguration(configuration: SsoConfiguration, discovered: Discovered,
    client: SsoClient): Promise<Configuration> {
    const library = openid();
    let authentication: ClientAuth;
    if (client.authentication.method === 'private_key_jwt') {
      const { kty, crv, x, y, d } = client.authentication.privateJwk;
      const key = await webcrypto.subtle.importKey('jwk', { kty, crv, x, y, d }, { name: 'ECDSA', namedCurve: 'P-256' },
        false, ['sign']);
      // Node's own CryptoKey; the DOM type openid-client names is the same object.
      authentication = library.PrivateKeyJwt({ key: key as unknown as CryptoKey, kid: client.authentication.kid });
    } else {
      authentication = library.ClientSecretBasic(client.authentication.secret);
    }
    const config = new library.Configuration(discovered.server, client.id, undefined, authentication);
    config[library.customFetch] = this.providerFetch(configuration);
    config.timeout = HTTP_TIMEOUT_SECONDS;
    // Check the ID token's signature against the provider's key set as well.
    library.enableNonRepudiationChecks(config);
    if (insecure(configuration)) library.allowInsecureRequests(config);
    return config;
  }

  /**
   * The one transport to the provider, for openid-client and jose alike: a
   * call only to the issuer's origin (rewritten to the internal base when one
   * is configured), never following a redirect, with an answer of at most
   * 256 KiB. A call that cannot be made is SsoProviderUnavailable.
   */
  private providerFetch(configuration: SsoConfiguration): CustomFetch {
    return async (url: string, options: ProviderRequest) => {
      const target = providerAddress(configuration, url);
      let response: Response;
      try {
        response = await (this.http ?? fetch)(target, {
          method: options.method,
          headers: options.headers,
          body: options.body as RequestInit['body'],
          redirect: 'error',
          signal: options.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_SECONDS * 1_000),
        });
      } catch {
        throw new SsoProviderUnavailable('unreachable');
      }
      return bounded(response);
    };
  }

  private now(): number {
    return this.clock?.() ?? Date.now();
  }
}

/**
 * The product's own checks of an ID token openid-client has verified: `azp`
 * names this client whenever it is present; `iat` neither in the future nor
 * older than five minutes; `sub` an account id; `sid`; `auth_time` not in the
 * future (openid-client checked it against `max_age`); the kind (`hid_kind`)
 * the client accepts; and, for a staff client, a password and a one-time code
 * in `amr`, as today's staff sign-in requires (MFA-1).
 */
export function checkIdTokenClaims(client: SsoClient, claims: IDToken): VerifiedIdToken {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  if (claims.azp !== undefined && claims.azp !== client.id) throw new SsoTokenRefused('azp');
  if (typeof claims.iat !== 'number' || claims.iat > nowSeconds + SSO_CLOCK_TOLERANCE_SECONDS
    || nowSeconds - claims.iat > ID_TOKEN_MAX_AGE_SECONDS + SSO_CLOCK_TOLERANCE_SECONDS) {
    throw new SsoTokenRefused('iat');
  }
  const accountId = claims.sub;
  if (typeof accountId !== 'string' || !UUID.test(accountId)) throw new SsoTokenRefused('sub');
  const sid = providerSessionId(claims.sid);
  if (!sid) throw new SsoTokenRefused('sid');
  const authTime = claims.auth_time;
  if (typeof authTime !== 'number' || !Number.isSafeInteger(authTime)
    || authTime > nowSeconds + SSO_CLOCK_TOLERANCE_SECONDS) {
    throw new SsoTokenRefused('auth_time');
  }
  if (claims.hid_kind !== client.kind) throw new SsoTokenRefused('kind');
  let mfaMethod: VerifiedIdToken['mfaMethod'];
  if (client.kind === 'staff') {
    const amr = Array.isArray(claims.amr) ? claims.amr.filter((value) => typeof value === 'string') : [];
    if (!amr.includes('pwd') || !amr.includes('otp')) throw new SsoTokenRefused('staff_mfa');
    mfaMethod = amr.includes('hid_recovery_code') ? 'recovery_code' : 'totp';
  }
  return {
    accountId: accountId.toLowerCase(),
    sid,
    authenticatedAt: new Date(Math.min(authTime, nowSeconds) * 1_000),
    ...(mfaMethod ? { mfaMethod } : {}),
  };
}

/** Only outside production may the issuer be plain HTTP (sso-config.ts refuses it in production). */
function insecure(configuration: SsoConfiguration): boolean {
  return new URL(configuration.issuer).protocol === 'http:';
}

/** A call on the issuer's own origin, sent to the internal base when one is configured; anything else is refused. */
export function providerAddress(configuration: SsoConfiguration, url: string): string {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new SsoProviderUnavailable('a call off the issuer');
  }
  if (target.origin !== configuration.issuer || target.username || target.password) {
    throw new SsoProviderUnavailable('a call off the issuer');
  }
  return configuration.internalBaseUrl
    ? new URL(`${target.pathname}${target.search}`, configuration.internalBaseUrl).href
    : target.href;
}

/** The provider's answer, read to its end only while it stays within 256 KiB. */
async function bounded(response: Response): Promise<Response> {
  const tooLarge = () => new SsoProviderUnavailable('answer too large');
  if (Number(response.headers.get('content-length') ?? 0) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  try {
    for (;;) {
      if (!reader) break;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } catch (error) {
    throw error instanceof SsoProviderUnavailable ? error : new SsoProviderUnavailable('unreadable answer');
  }
  const body = [204, 205, 304].includes(response.status) ? null : Buffer.concat(chunks);
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function providerSessionId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[\x21-\x7e]{1,255}$/.test(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function codeOf(error: unknown): string | undefined {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

/** A provider fault this transport raised, wherever openid-client wrapped it. */
function unwrapUnavailable(error: unknown): SsoProviderUnavailable | undefined {
  for (let current = error, depth = 0; current && depth < 4; depth += 1) {
    if (current instanceof SsoProviderUnavailable) return current;
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
  }
  return undefined;
}

/** An HTTP status openid-client kept with an unexpected answer. */
function statusOf(error: unknown): number | undefined {
  const own = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined;
  if (typeof own === 'number') return own;
  const cause = typeof error === 'object' && error !== null ? (error as { cause?: unknown }).cause : undefined;
  const status = typeof cause === 'object' && cause !== null ? (cause as { status?: unknown }).status : undefined;
  return typeof status === 'number' ? status : undefined;
}

/**
 * An openid-client failure, as the relying party answers it: the provider
 * could not be asked (unreachable, timed out, a 5xx, an answer that is not
 * JSON) is SsoProviderUnavailable, a fault; anything else (a refused code or
 * client, a token or response that failed a check) is SsoTokenRefused, with a
 * reason that names the check and never a value.
 */
function classified(error: unknown): Error {
  if (error instanceof SsoTokenRefused) return error;
  const unavailable = unwrapUnavailable(error);
  if (unavailable) return unavailable;
  const code = codeOf(error);
  const status = statusOf(error);
  if (code === 'OAUTH_RESPONSE_BODY_ERROR') {
    if (status !== undefined && status >= 500) return new SsoProviderUnavailable(`token endpoint answered ${status}`);
    const oauthError = (error as { error?: unknown }).error;
    const named = typeof oauthError === 'string' && /^[a-z_]{1,64}$/.test(oauthError) ? oauthError : 'unknown';
    return new SsoTokenRefused(`token endpoint refused the code: ${named}`);
  }
  if (code === 'OAUTH_RESPONSE_IS_NOT_CONFORM') {
    return status === undefined || status >= 500 ? new SsoProviderUnavailable(`answered ${status ?? 'unexpectedly'}`)
      : new SsoTokenRefused(`answered ${status}`);
  }
  if (code === 'OAUTH_TIMEOUT' || code === 'OAUTH_ABORT' || code === 'OAUTH_RESPONSE_IS_NOT_JSON') {
    return new SsoProviderUnavailable(code);
  }
  return new SsoTokenRefused(failedCheck(error) ?? code ?? 'invalid');
}

/**
 * The check that failed, as openid-client's protocol layer (oauth4webapi)
 * names it: its code and message, which name a parameter or claim and never
 * carry a value. The deepest coded error of the chain is the precise one.
 */
function failedCheck(error: unknown): string | undefined {
  let found: string | undefined;
  for (let current = error, depth = 0; current && typeof current === 'object' && depth < 4; depth += 1) {
    const { code, message } = current as { code?: unknown; message?: unknown };
    if (typeof code === 'string' && code.startsWith('OAUTH_') && typeof message === 'string') {
      found = `${code}: ${message}`.slice(0, 200);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return found;
}

/** A jose failure of the logout token: the key set unreadable is a fault, anything else a refusal. */
function classifiedJose(error: unknown): Error {
  if (error instanceof SsoTokenRefused || error instanceof SsoProviderUnavailable) return error;
  const code = codeOf(error);
  if (code === 'ERR_JWKS_TIMEOUT' || code === 'ERR_JWKS_INVALID' || code === 'ERR_JOSE_GENERIC') {
    return new SsoProviderUnavailable(`key set: ${code}`);
  }
  return new SsoTokenRefused(code ?? 'invalid');
}
