import { Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuditFailuresOnly, Public } from '../../common/decorators';
import { DomainProblem, PublicDetailProblem } from '../../common/problem';
import type { HidRequest } from '../../common/request-context';
import { getEnvironment } from '../../config/environment';
import { setSessionCookies } from '../session-cookies';
import type { SessionEventMetadata } from '../token.service';
import type { SsoClient } from './sso-config';
import { SsoProviderUnavailable, SsoTokenRefused } from './sso-errors';
import { safeReturnPath } from './sso-return-path';
import { routeNotFound, SsoRouteGuard } from './sso-route.guard';
import { SsoService, type SsoAuthorization, type SsoPrompt } from './sso.service';
import {
  RANDOM_VALUE,
  SSO_TRANSACTION_COOKIE_LIMIT,
  SSO_TRANSACTION_COOKIE_PREFIX,
  SSO_TRANSACTION_SECONDS,
  transactionCookieName,
} from './sso-transaction';

/** A logout token is a few hundred bytes; the form that carries it is refused past this. */
const LOGOUT_FORM_MAX_BYTES = 16 * 1_024;

/**
 * Set when a start or callback sends the browser to the product's own sign-in
 * page, for two minutes. That page may hand off to single sign-on again by
 * itself (app.'s /sign-in does, contract v2), so the next start on this
 * browser never hands off silently: it asks the person (prompt=login), and
 * while the provider cannot be reached it sends the browser to the product's
 * root, which is its landing page while signed out. So a refusal or an outage
 * never becomes a redirect loop between a product page and Identity.
 */
export const SSO_FALLBACK_COOKIE = '__Host-hid_sso_fallback';
const SSO_FALLBACK_SECONDS = 120;

/**
 * The product side of single sign-on (ADR-070), on each product host's own
 * `/api/v1/auth/sso/*` (the edge proxies `/api/v1/*` to Identity). Dark until
 * configured: SsoRouteGuard answers every route as a route that does not exist
 * while single sign-on is off or the host is not one of its clients. Product
 * sign-out is `POST /auth/sso/logout` in AuthController, next to today's
 * sign-out, which it runs.
 *
 * Every answer is `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
 * Redirects are 303 and go only to configured addresses (the provider's
 * authorization endpoint from discovery, the product's own sign-in page, the
 * product's root) or to the validated return path on this host, never to an
 * address taken from the request.
 */
@Controller('auth/sso')
@UseGuards(SsoRouteGuard)
@AuditFailuresOnly()
@Public()
export class SsoController {
  private readonly environment = getEnvironment();

  constructor(private readonly sso: SsoService) {}

  /**
   * `GET /auth/sso/start?return_to=<path>[&prompt=none|login]`: a signed-out
   * product page navigates here. With a live session of this product already,
   * straight back to the page, unless the page asked for a fresh sign-in;
   * otherwise to the provider, with the transaction kept in this host's
   * cookie. `prompt=none` asks the provider for no page (a quiet check);
   * `prompt=login` for a fresh sign-in (a recent sign-in is needed, as before
   * a PIN change), which with a live session must be of the same account and
   * replaces that sign-in. When the provider cannot be asked, the product's own
   * sign-in page, so signing in still works. Just after such a fallback
   * (SSO_FALLBACK_COOKIE), never silently: the person is asked, or, while the
   * provider stays unreachable, the browser goes to the product's root.
   */
  @Get('start')
  async start(@Req() request: HidRequest, @Res() response: Response): Promise<void> {
    const client = this.client(request);
    this.noStoreNoReferrer(response);
    const query = request.query as Record<string, unknown>;
    const returnTo = safeReturnPath(query.return_to) ?? '/';
    const cookies = this.cookies(request);
    const asked: SsoPrompt | undefined = query.prompt === 'none' || query.prompt === 'login' ? query.prompt : undefined;
    const live = await this.sso.liveSession(client, cookies[this.environment.AUTH_COOKIE_NAME]);
    // A fresh sign-in is never answered by the session it is meant to renew.
    if (live && asked !== 'login') {
      this.seeOther(response, returnTo);
      return;
    }
    const fellBack = cookies[SSO_FALLBACK_COOKIE] !== undefined;
    let authorization: SsoAuthorization;
    try {
      authorization = await this.sso.authorization(client, returnTo, fellBack ? 'login' : asked, live);
    } catch (error) {
      if (!(error instanceof SsoProviderUnavailable)) throw error;
      await this.sso.recordRefusal(client, error, this.event(request));
      this.fallBack(response, fellBack ? '/' : client.signInPath);
      return;
    }
    this.limitOpenTransactions(request, response);
    this.setTransactionCookie(response, authorization);
    this.seeOther(response, authorization.location);
  }

  /**
   * `GET /auth/sso/callback`: the provider sends the browser back here with
   * `code` and `state`, or with `error`. The transaction cookie of that state
   * is cleared whatever happens. Signed in: the product's session cookies, as
   * a sign-in sets them, and 303 to the return page. A silent attempt that
   * needs the person: 303 to the provider again with a page. Anything else:
   * 303 to the product's own sign-in page with nothing in the address.
   */
  @Get('callback')
  async callback(@Req() request: HidRequest, @Res() response: Response): Promise<void> {
    const client = this.client(request);
    this.noStoreNoReferrer(response);
    // The query exactly as sent: openid-client reads the authorization
    // response from it, and a repeated parameter is refused, never merged.
    const queryAt = request.originalUrl.indexOf('?');
    const callbackQuery = queryAt === -1 ? '' : request.originalUrl.slice(queryAt + 1);
    const states = new URLSearchParams(callbackQuery.length <= 4_096 ? callbackQuery : '').getAll('state');
    for (const state of states) {
      if (RANDOM_VALUE.test(state)) this.clearTransactionCookie(response, transactionCookieName(state));
    }
    const outcome = await this.sso.complete(client, callbackQuery, this.cookies(request), this.event(request));
    if (outcome.kind === 'signed_in') {
      setSessionCookies(response, outcome.session, this.environment);
      response.clearCookie(SSO_FALLBACK_COOKIE, this.fallbackCookieOptions());
      this.seeOther(response, outcome.returnTo);
      return;
    }
    if (outcome.kind === 'ask') {
      this.setTransactionCookie(response, outcome.authorization);
      this.seeOther(response, outcome.authorization.location);
      return;
    }
    this.fallBack(response, client.signInPath);
  }

  /**
   * `POST /auth/sso/backchannel-logout` (form `logout_token`): the provider,
   * server to server, ends the sign-ins of a provider session. No cookie, no
   * CSRF token and no Origin: the logout token is the credential. 200 with no
   * body when accepted; 400 when the token is refused (the provider does not
   * retry); 503 when the provider's key set cannot be read (it may retry).
   */
  @Post('backchannel-logout')
  @HttpCode(200)
  async backchannelLogout(@Req() request: HidRequest, @Res() response: Response): Promise<void> {
    const client = this.client(request);
    this.noStoreNoReferrer(response);
    const logoutToken = await readLogoutToken(request);
    try {
      await this.sso.backchannelLogout(client, logoutToken, this.event(request));
    } catch (error) {
      if (error instanceof SsoTokenRefused) {
        throw new DomainProblem(400, 'SSO_LOGOUT_TOKEN_INVALID', 'The logout token was refused');
      }
      if (error instanceof SsoProviderUnavailable) {
        throw new PublicDetailProblem(503, 'SSO_PROVIDER_UNAVAILABLE', 'The sign-in provider cannot be reached; try again');
      }
      throw error;
    }
    response.status(200).end();
  }

  private client(request: HidRequest): SsoClient {
    // SsoRouteGuard admitted only a request with a client; this is its lookup.
    const client = this.sso.clientFor(request);
    if (!client) throw routeNotFound(request);
    return client;
  }

  /** To the product's own page after a failure, remembering it for the next start (SSO_FALLBACK_COOKIE). */
  private fallBack(response: Response, location: string): void {
    response.cookie(SSO_FALLBACK_COOKIE, '1', { ...this.fallbackCookieOptions(), maxAge: SSO_FALLBACK_SECONDS * 1_000 });
    this.seeOther(response, location);
  }

  private fallbackCookieOptions() {
    return { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/' };
  }

  private setTransactionCookie(response: Response, authorization: SsoAuthorization): void {
    response.cookie(authorization.cookieName, authorization.cookieValue, {
      httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: SSO_TRANSACTION_SECONDS * 1_000,
    });
  }

  private clearTransactionCookie(response: Response, name: string): void {
    response.clearCookie(name, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
  }

  /** Too many sign-ins left open on one browser: clear them, so its Cookie header stays bounded. */
  private limitOpenTransactions(request: HidRequest, response: Response): void {
    const open = Object.keys(this.cookies(request)).filter((name) => name.startsWith(SSO_TRANSACTION_COOKIE_PREFIX));
    if (open.length < SSO_TRANSACTION_COOKIE_LIMIT) return;
    for (const name of open) this.clearTransactionCookie(response, name);
  }

  private noStoreNoReferrer(response: Response): void {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
  }

  private seeOther(response: Response, location: string): void {
    response.status(303);
    response.setHeader('Location', location);
    response.end();
  }

  private event(request: HidRequest): SessionEventMetadata {
    return { correlationId: request.correlationId, sourceIp: request.ip, userAgent: request.header('user-agent') };
  }

  private cookies(request: HidRequest): Record<string, string> {
    const value = (request as Request & { cookies?: unknown }).cookies;
    if (typeof value !== 'object' || value === null) return {};
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  }
}

/**
 * The one `logout_token` of an `application/x-www-form-urlencoded` body.
 * Identity registers only a JSON body parser (main.ts), so the form is read
 * here, at most 16 KiB; a body another parser already read is used as it is.
 */
async function readLogoutToken(request: HidRequest): Promise<string> {
  const invalid = () => new DomainProblem(400, 'SSO_LOGOUT_TOKEN_INVALID', 'The logout token was refused');
  if (!/^application\/x-www-form-urlencoded\s*(?:;|$)/i.test(request.header('content-type') ?? '')) throw invalid();
  const parsed = (request as Request).body as unknown;
  let values: string[];
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const value = (parsed as Record<string, unknown>).logout_token;
    values = typeof value === 'string' ? [value] : [];
  } else {
    const text = await readBody(request);
    if (text === undefined) throw new DomainProblem(413, 'PAYLOAD_TOO_LARGE', 'The logout request is too large');
    values = new URLSearchParams(text).getAll('logout_token');
  }
  const [token, extra] = values;
  if (!token || extra !== undefined || token.length > 8_192) throw invalid();
  return token;
}

/**
 * The body as text, or undefined when it is larger than the form limit. A
 * body over the limit is read to its end and discarded, so the connection
 * stays usable for the answer.
 */
function readBody(request: HidRequest): Promise<string | undefined> {
  const stream = request as unknown as NodeJS.ReadableStream;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    stream.on('data', (chunk: Buffer | string) => {
      if (tooLarge) return;
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      size += bytes.length;
      if (size > LOGOUT_FORM_MAX_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(bytes);
    });
    stream.on('end', () => resolve(tooLarge ? undefined : Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}
