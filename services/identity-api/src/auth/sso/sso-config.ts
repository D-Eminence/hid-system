import { createPrivateKey, type JsonWebKey as NodeJsonWebKey } from 'node:crypto';
import { isIP } from 'node:net';
import { safeReturnPath } from './sso-return-path';

/**
 * Single sign-on on the sign-in site `auth.` (ADR-070, proposed): the product
 * side. Each product host is an OpenID Connect relying party of the provider
 * on `auth.`, which the coordinator builds. This file reads and checks the
 * configuration; it has no dependency beyond Node, so the environment schema
 * (config/environment.ts) can refuse a bad configuration at start-up, as it
 * does for the Turnstile table (turnstile-actions.ts).
 *
 * All unset means off: no SSO route answers (SsoRouteGuard), and sign-in,
 * refresh and sign-out are exactly as before.
 *
 * - `AUTH_SSO_ISSUER`: the provider's public issuer, an exact origin such as
 *   `https://auth.<root>`. Setting it turns single sign-on on.
 * - `AUTH_SSO_INTERNAL_BASE_URL` (optional): an origin inside the platform
 *   from which Identity reads discovery and the key set and calls the token
 *   endpoint, without going out through the edge. The browser is always sent
 *   to the public endpoints.
 * - `AUTH_SSO_CLIENTS`: a JSON array, one entry per product host:
 *   `{ "client_id", "host", "kind", "token_endpoint_auth_method", "sign_in_path"? }`.
 *   `sign_in_path` is the product's own sign-in page, where a failure sends
 *   the browser: by default `/provider/sign-in` on a staff site (its form)
 *   and `/sign-in` on the patients' site (its entrance, which hands off again with single
 *   sign-on on; the start route then asks the person instead of looping,
 *   sso.controller.ts SSO_FALLBACK_COOKIE).
 * - `AUTH_SSO_CLIENT_CREDENTIALS`: a JSON object from the secret store, by
 *   client id: `{ "private_jwk": { EC P-256 private JWK with "kid" } }` for
 *   `private_key_jwt`, or `{ "client_secret": "..." }` for `client_secret_basic`.
 *
 * Every target comes from here, never from the request: the client is chosen
 * by the product host the edge names (ssoClientForRequest), and its redirect,
 * sign-out return and sign-in page are derived from its configured host.
 */
export type SsoKind = 'staff' | 'patient';

/**
 * The product sites that may be clients, each with the one kind of sign-in it
 * accepts (contract v2): a staff sign-in never opens the patient portal and a
 * patient one never opens a staff product. Platform administration (`admin`)
 * is never a client (ADR-038), and nor is any other key.
 */
export const SSO_SITE_KINDS: Readonly<Record<string, SsoKind>> = Object.freeze({
  ehr: 'staff',
  lab: 'staff',
  pharmacy: 'staff',
  migrate: 'staff',
  outreach: 'staff',
  web: 'patient',
});

/**
 * The first label of a patients' site host, where the patient portal (`web`)
 * signs in and no staff client may: `app.` (Health's edge; the owner's
 * patients' site), `www.` (the portal on hid-system's own production edge,
 * infra/cloudflare and infra/aws, and in Identity's production Turnstile table),
 * and the bare environment name elsewhere (`staging.`, `development.`;
 * infra/aws browserSubdomains). The patients' site is for patients only, with
 * no staff pages (the owner's decision, 2 November 2026).
 */
const PATIENT_SITE_LABELS: ReadonlySet<string> = new Set(['app', 'www', 'staging', 'development']);
const PATIENT_SITE_NAMES = 'app. or www., or staging. or development. in those environments';

export const SSO_ROUTE_PREFIX = '/api/v1/auth/sso';
/** The one redirect URI registered per product: the callback on its own host. */
export const SSO_CALLBACK_PATH = `${SSO_ROUTE_PREFIX}/callback`;
/** The back-channel logout URI registered per product. */
export const SSO_BACKCHANNEL_LOGOUT_PATH = `${SSO_ROUTE_PREFIX}/backchannel-logout`;

/**
 * The header the edge sets to the product host's origin on every proxied
 * `/api/v1/*` request, after deleting any value the client sent
 * (infra/cloudflare/src/frontend-worker.mjs, proxyApi). The gateway passes it
 * on unchanged (gateway/proxy-headers.conf resets only the headers it names).
 * The gateway's own X-Forwarded-Host names the API host, not the product.
 */
export const SSO_EDGE_ORIGIN_HEADER = 'x-hid-edge-origin';

const DEFAULT_SIGN_IN_PATH: Readonly<Record<SsoKind, string>> = Object.freeze({
  staff: '/provider/sign-in',
  patient: '/sign-in',
});

const CLIENT_KEYS: ReadonlySet<string> = new Set(['client_id', 'host', 'kind', 'token_endpoint_auth_method', 'sign_in_path']);
const MAX_CLIENTS = 16;
const MIN_CLIENT_SECRET_LENGTH = 32;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** An EC P-256 private key as a JWK: what openid-client's PrivateKeyJwt signs the client assertion with. */
export interface SsoPrivateJwk {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
  readonly d: string;
}

export type SsoClientAuthentication =
  | { readonly method: 'private_key_jwt'; readonly privateJwk: SsoPrivateJwk; readonly kid: string }
  | { readonly method: 'client_secret_basic'; readonly secret: string };

export interface SsoClient {
  /** The site key, which is also the client_id registered at the provider. */
  readonly id: string;
  readonly kind: SsoKind;
  readonly host: string;
  /** `https://<host>`: the only origin this client's requests may come from. */
  readonly origin: string;
  /** `https://<host>/api/v1/auth/sso/callback`. */
  readonly redirectUri: string;
  /** `https://<host>/`: where the provider returns the browser after sign-out. */
  readonly postLogoutRedirectUri: string;
  /** The product's own sign-in page, a path on its host: the fallback whenever single sign-on cannot help. */
  readonly signInPath: string;
  readonly authentication: SsoClientAuthentication;
}

export interface SsoConfiguration {
  /** The provider's public issuer, an exact origin. */
  readonly issuer: string;
  /** Where Identity reaches the provider's token endpoint and key set, when not through the issuer. */
  readonly internalBaseUrl?: string;
  readonly clients: ReadonlyMap<string, SsoClient>;
  /** The same clients by their exact origin. */
  readonly clientsByOrigin: ReadonlyMap<string, SsoClient>;
}

/** The environment fields this file reads (a subset of Environment, so tests can pass plain objects). */
export interface SsoEnvironment {
  NODE_ENV?: string;
  AUTH_MODE?: string;
  CORS_ORIGINS?: string;
  AUTH_SSO_ISSUER?: string;
  AUTH_SSO_INTERNAL_BASE_URL?: string;
  AUTH_SSO_CLIENTS?: string;
  AUTH_SSO_CLIENT_CREDENTIALS?: string;
}

export interface SsoConfigurationResult {
  configuration?: SsoConfiguration;
  /** Why start-up is refused. Never contains a credential. */
  issues: string[];
}

/**
 * Parses and checks the configuration. Nothing set is no configuration and no
 * issue: single sign-on is off. Any issue refuses start-up.
 *
 * Refused in every environment: a client that is not one of the six product
 * sites (administration included), a client whose kind is not its site's (a
 * staff product as `patient` or the patient portal as `staff`), a host that is
 * a wildcard, not an exact DNS name, the administration host, the issuer's
 * host, not one of CORS_ORIGINS (unknown to the platform), another site's host
 * (siteProblem: a staff client on the patients' site or another product's, or
 * the patient portal anywhere but the patients' site; outside production an
 * IP address names no site, and a one-label name is checked only when it is a
 * patients' site label or a staff product's name), a repeated client or host,
 * and missing or unusable credentials.
 * Refused in production
 * (NODE_ENV=production, which AWS staging tasks also run): an issuer or
 * internal base that is not HTTPS, and a host with a port or an IP address.
 */
export function parseSsoConfiguration(environment: SsoEnvironment): SsoConfigurationResult {
  const issuerText = trimmed(environment.AUTH_SSO_ISSUER);
  const internalText = trimmed(environment.AUTH_SSO_INTERNAL_BASE_URL);
  const clientsText = trimmed(environment.AUTH_SSO_CLIENTS);
  const credentialsText = trimmed(environment.AUTH_SSO_CLIENT_CREDENTIALS);
  if (!issuerText) {
    return (internalText || clientsText || credentialsText)
      ? { issues: ['AUTH_SSO_INTERNAL_BASE_URL, AUTH_SSO_CLIENTS and AUTH_SSO_CLIENT_CREDENTIALS require AUTH_SSO_ISSUER'] }
      : { issues: [] };
  }
  const production = environment.NODE_ENV === 'production';
  const issues: string[] = [];
  if (environment.AUTH_MODE !== 'local') {
    issues.push('Single sign-on issues Identity cookie sessions and requires AUTH_MODE=local');
  }
  const issuerProblem = originProblem(issuerText, production);
  if (issuerProblem) issues.push(`AUTH_SSO_ISSUER ${issuerProblem}`);
  // The issuer's host and port (the scheme's default when none is named), so a client there is refused.
  const issuerHost = issuerProblem ? undefined : hostAndPort(new URL(issuerText));
  if (internalText) {
    const internalProblem = originProblem(internalText, production);
    if (internalProblem) issues.push(`AUTH_SSO_INTERNAL_BASE_URL ${internalProblem}`);
  }

  const corsOrigins = new Set((environment.CORS_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean));
  const entries = parseJson(clientsText);
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_CLIENTS) {
    issues.push(`AUTH_SSO_CLIENTS must be a JSON array of 1 to ${MAX_CLIENTS} clients`);
    return { issues };
  }
  const credentials = parseJson(credentialsText);
  if (!isRecord(credentials)) {
    issues.push('AUTH_SSO_CLIENT_CREDENTIALS must be a JSON object of credentials by client id');
    return { issues };
  }

  const clients = new Map<string, SsoClient>();
  const clientsByOrigin = new Map<string, SsoClient>();
  entries.forEach((entry, index) => {
    const parsed = parseClient(entry, index, credentials, { production, issuerHost, corsOrigins });
    if (typeof parsed === 'string') {
      issues.push(parsed);
      return;
    }
    if (clients.has(parsed.id)) issues.push(`AUTH_SSO_CLIENTS repeats the client ${parsed.id}`);
    if (clientsByOrigin.has(parsed.origin)) issues.push(`AUTH_SSO_CLIENTS repeats the host of ${parsed.id}`);
    clients.set(parsed.id, parsed);
    clientsByOrigin.set(parsed.origin, parsed);
  });
  // Against every client an entry names, refused ones included, so a refusal is not reported twice.
  const named = new Set(entries.map((entry) => (isRecord(entry) ? entry.client_id : undefined)));
  const unused = Object.keys(credentials).filter((id) => !named.has(id));
  if (unused.length > 0) issues.push('AUTH_SSO_CLIENT_CREDENTIALS names a client that AUTH_SSO_CLIENTS does not');
  if (issues.length > 0) return { issues };
  return {
    configuration: Object.freeze({
      issuer: issuerText,
      ...(internalText ? { internalBaseUrl: internalText } : {}),
      clients,
      clientsByOrigin,
    }),
    issues,
  };
}

/** Start-up issues only (the environment schema adds each as a refusal). */
export function ssoConfigurationIssues(environment: SsoEnvironment): string[] {
  return parseSsoConfiguration(environment).issues;
}

/**
 * Whether single sign-on is configured, by the one rule that turns it on
 * (AUTH_SSO_ISSUER set), read from the process environment. For code that
 * only branches on it and has no environment of its own to hand
 * (recent-authentication.ts): start-up has already validated the whole
 * configuration (config/environment.ts), and refuses an invalid one.
 */
export function ssoConfigured(environment: Pick<SsoEnvironment, 'AUTH_SSO_ISSUER'> = process.env): boolean {
  return trimmed(environment.AUTH_SSO_ISSUER) !== undefined;
}

const parsedConfigurations = new WeakMap<object, SsoConfiguration | undefined>();

/**
 * The configuration of a validated environment, or undefined while single
 * sign-on is off. The environment schema has already refused any issue, so
 * this parses once per environment object; an issue here is a programming
 * error and is thrown, never answered as "off".
 */
export function ssoConfiguration(environment: SsoEnvironment): SsoConfiguration | undefined {
  if (!trimmed(environment.AUTH_SSO_ISSUER)) return undefined;
  if (parsedConfigurations.has(environment)) return parsedConfigurations.get(environment);
  const result = parseSsoConfiguration(environment);
  if (!result.configuration) throw new Error(`Invalid single sign-on configuration: ${result.issues.join('; ')}`);
  parsedConfigurations.set(environment, result.configuration);
  return result.configuration;
}

/**
 * The client of the product host a request came through: the origin the edge
 * names in X-HID-Edge-Origin, matched exactly. Undefined for any other host
 * (administration, `auth.` itself, the portal on hid-system main, a request
 * that did not come through the edge), which then has no SSO route at all.
 */
export function ssoClientForRequest(configuration: SsoConfiguration,
  request: { header(name: string): string | undefined }): SsoClient | undefined {
  const origin = request.header(SSO_EDGE_ORIGIN_HEADER);
  return origin ? configuration.clientsByOrigin.get(origin) : undefined;
}

interface ClientRules {
  production: boolean;
  issuerHost: string | undefined;
  corsOrigins: ReadonlySet<string>;
}

function parseClient(entry: unknown, index: number, credentials: Record<string, unknown>,
  rules: ClientRules): SsoClient | string {
  const where = `AUTH_SSO_CLIENTS[${index}]`;
  if (!isRecord(entry)) return `${where} must be an object`;
  if (Object.keys(entry).some((key) => !CLIENT_KEYS.has(key))) return `${where} has an unknown field`;
  const { client_id: id, host, kind, token_endpoint_auth_method: method, sign_in_path: signInPath } = entry;
  if (id === 'admin') return `${where} is platform administration, which is never a single sign-on client (ADR-038)`;
  if (typeof id !== 'string' || !Object.hasOwn(SSO_SITE_KINDS, id)) {
    return `${where}.client_id must be one of ${Object.keys(SSO_SITE_KINDS).join(', ')}`;
  }
  const expectedKind = SSO_SITE_KINDS[id]!;
  if (kind !== 'staff' && kind !== 'patient') return `${where}.kind must be "staff" or "patient"`;
  if (kind !== expectedKind) return `${where}: the ${id} client accepts only ${expectedKind} sign-ins, not ${kind}`;
  if (typeof host !== 'string') return `${where}.host must be one exact host name`;
  const hostIssue = hostProblem(host, rules.production);
  if (hostIssue) return `${where}.host ${hostIssue}`;
  if (hostName(host).split('.')[0] === 'admin') return `${where}.host is the administration host, never a client (ADR-038)`;
  if (rules.issuerHost && hostAndPort(new URL(`https://${host}`)) === rules.issuerHost) return `${where}.host is the sign-in site itself`;
  const origin = `https://${host}`;
  if (!rules.corsOrigins.has(origin)) return `${where}.host is not a known product host: ${origin} is not one of CORS_ORIGINS`;
  const siteIssue = siteProblem(id, kind, host);
  if (siteIssue) return `${where}.host ${siteIssue}`;
  let resolvedSignInPath = DEFAULT_SIGN_IN_PATH[kind];
  if (signInPath !== undefined) {
    const safe = safeReturnPath(signInPath);
    if (!safe || safe !== signInPath) return `${where}.sign_in_path must be a page path on the product host`;
    resolvedSignInPath = safe;
  }
  const authentication = parseAuthentication(id, method, credentials[id]);
  if (typeof authentication === 'string') return `${where}: ${authentication}`;
  return Object.freeze({
    id,
    kind,
    host,
    origin,
    redirectUri: `${origin}${SSO_CALLBACK_PATH}`,
    postLogoutRedirectUri: `${origin}/`,
    signInPath: resolvedSignInPath,
    authentication,
  });
}

function parseAuthentication(id: string, method: unknown, credential: unknown): SsoClientAuthentication | string {
  if (method !== 'private_key_jwt' && method !== 'client_secret_basic') {
    return 'token_endpoint_auth_method must be "private_key_jwt" or "client_secret_basic"';
  }
  if (!isRecord(credential)) return `AUTH_SSO_CLIENT_CREDENTIALS has no credential for ${id}`;
  if (method === 'client_secret_basic') {
    const secret = credential.client_secret;
    if (Object.keys(credential).length !== 1 || typeof secret !== 'string'
      || secret.length < MIN_CLIENT_SECRET_LENGTH || secret.length > 512) {
      return `the client_secret_basic credential of ${id} must be one client_secret of at least `
        + `${MIN_CLIENT_SECRET_LENGTH} characters`;
    }
    return Object.freeze({ method, secret });
  }
  const jwk = credential.private_jwk;
  if (Object.keys(credential).length !== 1 || !isRecord(jwk) || jwk.kty !== 'EC' || jwk.crv !== 'P-256'
    || typeof jwk.d !== 'string' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string'
    || typeof jwk.kid !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(jwk.kid)
    || (jwk.alg !== undefined && jwk.alg !== 'ES256')) {
    return `the private_key_jwt credential of ${id} must be one EC P-256 private_jwk with a kid`;
  }
  const privateJwk: SsoPrivateJwk = Object.freeze({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d });
  try {
    // Refused at start-up rather than at the first sign-in.
    createPrivateKey({ key: privateJwk as NodeJsonWebKey, format: 'jwk' });
  } catch {
    return `the private_key_jwt credential of ${id} is not a usable private key`;
  }
  return Object.freeze({ method, privateJwk, kid: jwk.kid });
}

/** Why a value is not an exact origin under these rules; undefined when it is one. */
function originProblem(value: string, production: boolean): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'must be an exact origin';
  }
  if (url.origin !== value) return 'must be an exact origin, without a path, query or trailing slash';
  if (url.protocol !== 'https:' && (production || url.protocol !== 'http:')) {
    return production ? 'must use HTTPS in production' : 'must use HTTPS or HTTP';
  }
  if (url.hostname.startsWith('[')) return production ? 'must be a DNS host name in production, not an IP address' : undefined;
  return hostNameProblem(url.hostname, url.port || undefined, production);
}

/** A client's host without its port, if it names one (development only). */
function hostName(host: string): string {
  return host.replace(/:[0-9]+$/, '');
}

/**
 * A client's host must be its own site's: a staff product's host starts with
 * its client_id (`lab.`, `lab.staging.`) and the patient portal's with a
 * patients' site label (PATIENT_SITE_LABELS). So no configuration can send a
 * staff sign-in to the patients' site or to another product's, or put the
 * portal on a staff product's host. Outside production, an IP address names
 * no site, and a one-label name (`localhost`) is checked only when it is a
 * patients' site label (refused for a staff client) or a staff product's name
 * (refused for the portal and for another product's client).
 */
function siteProblem(id: string, kind: SsoKind, host: string): string | undefined {
  const name = hostName(host);
  if (isIP(name) !== 0) return undefined;
  const labels = name.split('.');
  const first = labels[0]!;
  if (kind === 'staff' && PATIENT_SITE_LABELS.has(first)) {
    return `is the patients' site, which has no staff sign-in: the ${id} client belongs on ${id}.`;
  }
  // A one-label name (development only) names a site only when it is a
  // patients' site label or a staff product's name.
  const oneLabel = labels.length < 2;
  const product = Object.hasOwn(SSO_SITE_KINDS, first) && SSO_SITE_KINDS[first] === 'staff' ? first : undefined;
  if (kind === 'patient') {
    if (PATIENT_SITE_LABELS.has(first)) return undefined;
    if (product) return `is the ${product} product's host: the patient portal belongs on the patients' site (${PATIENT_SITE_NAMES})`;
    return oneLabel ? undefined : `must be the patients' site (${PATIENT_SITE_NAMES})`;
  }
  if (first === id) return undefined;
  if (product) return `is the ${product} product's host: the ${id} client belongs on ${id}.`;
  return oneLabel ? undefined : `must be the ${id} site's own host (${id}.)`;
}

/** A host and its port, the scheme's default when none is named, to compare origins' hosts. */
function hostAndPort(url: URL): string {
  return `${url.hostname}:${url.port || (url.protocol === 'http:' ? '80' : '443')}`;
}

/** A client's host: one exact host name, with a port only outside production. */
function hostProblem(host: string, production: boolean): string | undefined {
  if (host.includes('*')) return 'must name one exact host, never a wildcard';
  const match = /^([^:]+)(?::([0-9]+))?$/.exec(host);
  if (!match) return 'must name one exact host';
  const problem = hostNameProblem(match[1]!, match[2], production);
  if (problem) return problem;
  if (match[2] === '443') return 'must not name the default port 443';
  // The edge names this host in its origin exactly as a URL spells it. A name
  // a URL reads otherwise (a last label of digits reads as an IPv4 address,
  // and fails) is refused here, not left to fail later.
  try {
    if (new URL(`https://${host}`).host !== host) return 'must name one exact host';
  } catch {
    return 'must name one exact host';
  }
  return undefined;
}

function hostNameProblem(name: string, port: string | undefined, production: boolean): string | undefined {
  if (name.includes('*')) return 'must name one exact host, never a wildcard';
  if (port !== undefined) {
    if (production) return 'must not name a port in production';
    if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65_535) return 'has an invalid port';
  }
  if (isIP(name) !== 0) return production ? 'must be a DNS host name in production, not an IP address' : undefined;
  const labels = name.split('.');
  if (labels.some((label) => !DNS_LABEL.test(label))) return 'must be a lower-case DNS host name';
  if (production && labels.length < 2) return 'must be a fully qualified DNS host name in production';
  return undefined;
}

function parseJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}
