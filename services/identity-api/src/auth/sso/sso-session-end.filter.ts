import { type ArgumentsHost, Catch, HttpException, Injectable, Optional } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ProblemDetailsFilter } from '../../common/problem';
import type { HidRequest } from '../../common/request-context';
import { getEnvironment } from '../../config/environment';
import { clearSessionCookies } from '../session-cookies';
import { TokenService } from '../token.service';
import { SsoService } from './sso.service';

/**
 * After "sign out everywhere" (ADR-070, contract v2 later decisions), the
 * other products' sign-ins are ended by back-channel logout, server to server,
 * so their browsers keep the cookies until a request reaches Identity. The
 * edge shows a product's workspace while `hid_access_csrf` is present. So the
 * first refused session check on such a host clears its session cookies, as
 * a refused refresh already does (refresh-refusal.ts), and its next visit
 * shows the landing page.
 *
 * On `GET /auth/session` only, and only on the host of a single sign-on client
 * (dark otherwise: the answer is ProblemDetailsFilter's, byte for byte). A 401
 * clears the cookies only when the sign-in has nothing left that refresh could
 * renew: no refresh cookie, or one TokenService.refreshSessionKind no longer
 * finds renewable (ended, expired, reused). An access token that merely
 * expired while its sign-in still renews is kept for the refresh that
 * follows, and a fault in that read clears nothing. The answer is unchanged.
 */
@Catch()
@Injectable()
export class SsoSessionEndFilter extends ProblemDetailsFilter {
  private readonly environment = getEnvironment();

  constructor(
    // Optional, so a harness that builds AuthController without single sign-on gets today's answer.
    @Optional() private readonly sso?: SsoService,
    @Optional() private readonly tokens?: TokenService,
  ) {
    super();
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    void this.answer(exception, host);
  }

  private async answer(exception: unknown, host: ArgumentsHost): Promise<void> {
    const http = host.switchToHttp();
    const request = http.getRequest<HidRequest>();
    const response = http.getResponse<Response>();
    try {
      if (await this.signInEnded(exception, request)) clearSessionCookies(response, this.environment);
    } catch {
      // Unknown whether the sign-in ended: its cookies are kept.
    }
    super.catch(exception, host);
  }

  private async signInEnded(exception: unknown, request: HidRequest): Promise<boolean> {
    if (!(exception instanceof HttpException) || exception.getStatus() !== 401) return false;
    if (!this.sso?.clientFor(request) || !this.tokens) return false;
    const name = this.environment.AUTH_COOKIE_NAME;
    const cookies = (request as Request & { cookies?: Record<string, unknown> }).cookies ?? {};
    const held = [name, `${name}_refresh`, `${name}_csrf`].some((cookie) => typeof cookies[cookie] === 'string');
    if (!held) return false;
    const refreshToken = cookies[`${name}_refresh`];
    if (typeof refreshToken !== 'string') return true;
    return await this.tokens.refreshSessionKind(refreshToken) === undefined;
  }
}
