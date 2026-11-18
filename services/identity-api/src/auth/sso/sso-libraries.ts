/**
 * The two libraries single sign-on uses (ADR-070), loaded on first use.
 *
 * - `openid-client` (panva, OpenID Certified relying-party library, approved
 *   by the owner): discovery, the authorization URL, PKCE, state and nonce,
 *   the code exchange with client authentication, the ID-token checks and the
 *   end-session URL.
 * - `jose` (already an Identity dependency): only the back-channel logout
 *   token, for which openid-client has no helper.
 *
 * Both are ES modules. Node loads them with `require` on first use, as it
 * loads `jose` for the access token today (token.service.ts). Loading them
 * here, not at import, means nothing loads `openid-client` while single
 * sign-on is off, and modules that only import the SSO classes (AuthModule,
 * AuthController) load neither.
 */
type OpenIdClient = typeof import('openid-client');
type Jose = typeof import('jose');

let openIdClient: OpenIdClient | undefined;
let joseLibrary: Jose | undefined;

export function openid(): OpenIdClient {
  openIdClient ??= require('openid-client') as OpenIdClient;
  return openIdClient;
}

export function jose(): Jose {
  joseLibrary ??= require('jose') as Jose;
  return joseLibrary;
}
