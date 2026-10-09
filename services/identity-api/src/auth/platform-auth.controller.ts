import { Body, Controller, HttpCode, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuditFailuresOnly, HighRiskAction, PlatformScope, Public } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { AuthSessionAuditService } from './auth-session-audit.service';
import type { LoginResult } from './auth.types';
import { PlatformLoginDto, PlatformMfaVerifyDto, TotpCodeDto } from './dto/platform-auth.dto';
import { MfaService } from './mfa/mfa.service';
import { TokenService, type SessionEventMetadata } from './token.service';
import { TurnstileService } from './turnstile.service';

/**
 * Platform administration sign-in (Phase 4 Stage 2A). A password alone never
 * yields a session: it yields an httpOnly challenge cookie that only the MFA
 * steps accept. Platform sessions use their own cookies, so a staff session in
 * the same browser is neither replaced nor accepted on platform routes.
 */
@Controller('auth/admin')
@AuditFailuresOnly()
export class PlatformAuthController {
  private readonly environment = getEnvironment();
  private readonly allowedOrigins = new Set(this.environment.CORS_ORIGINS.split(',').map((origin) => origin.trim()));

  constructor(
    private readonly mfa: MfaService,
    private readonly tokens: TokenService,
    private readonly sessionAudit: AuthSessionAuditService,
    private readonly turnstile: TurnstileService,
  ) {}

  @Post('login')
  @Public()
  @HttpCode(200)
  async login(@Body() input: PlatformLoginDto, @Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    this.assertAllowedOrigin(request);
    await this.turnstile.verifyLogin({ token: input.turnstileToken, action: input.turnstileAction,
      origin: request.header('origin'), remoteIp: request.ip });
    try {
      const challenge = await this.mfa.beginLogin(input.email, input.password, this.event(request));
      this.setChallengeCookie(response, challenge.token, challenge.expiresAt);
      return {
        status: challenge.purpose === 'verify' ? 'mfa_required' : 'mfa_enrollment_required',
        expiresAt: challenge.expiresAt.toISOString(),
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        await this.sessionAudit.recordLoginFailure(input.email, this.event(request));
      }
      throw error;
    }
  }

  @Post('mfa/verify')
  @Public()
  @HttpCode(200)
  async verify(@Body() input: PlatformMfaVerifyDto, @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response) {
    this.assertAllowedOrigin(request);
    const session = await this.mfa.completeLogin(this.challengeToken(request), input, this.event(request));
    this.clearChallengeCookie(response);
    return this.sessionResponse(response, session);
  }

  @Post('mfa/enroll/start')
  @Public()
  @HttpCode(200)
  async startEnrollment(@Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    this.assertAllowedOrigin(request);
    const enrollment = await this.mfa.startEnrollment(this.challengeToken(request), this.event(request));
    response.setHeader('Cache-Control', 'no-store');
    return { ...enrollment, expiresAt: enrollment.expiresAt.toISOString() };
  }

  @Post('mfa/enroll/activate')
  @Public()
  @HttpCode(200)
  async activateEnrollment(@Body() input: TotpCodeDto, @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response) {
    this.assertAllowedOrigin(request);
    const { session, recoveryCodes } = await this.mfa.activateEnrollment(this.challengeToken(request), input.code,
      this.event(request));
    this.clearChallengeCookie(response);
    return { ...this.sessionResponse(response, session), recoveryCodes };
  }

  @Post('refresh')
  @Public()
  @HttpCode(200)
  async refresh(@Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    this.assertAllowedOrigin(request);
    const cookies = this.cookies(request);
    const refreshToken = cookies[`${this.cookieName()}_refresh`];
    // No refresh credential at all is a missing sign-in (401), not a CSRF failure.
    if (!refreshToken) throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required');
    if (!this.tokens.verifyRefreshCsrf(refreshToken, cookies[`${this.cookieName()}_csrf`],
      request.header('x-csrf-token'))) {
      throw new DomainProblem(403, 'CSRF_VALIDATION_FAILED', 'Refresh CSRF validation failed');
    }
    try {
      return this.sessionResponse(response, await this.tokens.refresh(refreshToken, this.event(request), 'platform'));
    } catch (error) {
      this.clearSessionCookies(response);
      throw error;
    }
  }

  @Post('logout')
  @PlatformScope()
  @HighRiskAction('platform.session.logout')
  @HttpCode(204)
  async logout(@Req() request: HidRequest, @Res({ passthrough: true }) response: Response): Promise<void> {
    await this.tokens.revoke(request.actor?.sessionId, request.actor?.subject, this.event(request));
    this.clearSessionCookies(response);
  }

  private sessionResponse(response: Response, session: LoginResult) {
    const common = { secure: this.environment.AUTH_COOKIE_SECURE, sameSite: 'strict' as const };
    // The refresh and CSRF cookies outlive the idle window and, by one more
    // idle window, the end of the sign-in, so a refresh after an idle timeout
    // or the 8-hour limit still reaches the server and is told
    // PLATFORM_SESSION_EXPIRED. The server refuses that refresh either way:
    // both lifetimes are enforced on the stored session, and a refusal clears
    // the cookies.
    const refreshCookieExpires = session.absoluteExpiresAt
      ? new Date(session.absoluteExpiresAt.getTime() + this.environment.PLATFORM_IDLE_TIMEOUT_SECONDS * 1_000)
      : session.refreshExpiresAt;
    response.cookie(this.cookieName(), session.accessToken,
      { ...common, httpOnly: true, path: '/api/v1', expires: session.expiresAt });
    response.cookie(`${this.cookieName()}_refresh`, session.refreshToken,
      { ...common, httpOnly: true, path: '/api/v1/auth/admin', expires: refreshCookieExpires });
    response.cookie(`${this.cookieName()}_csrf`, session.csrfToken,
      { ...common, httpOnly: false, path: '/', expires: refreshCookieExpires });
    response.setHeader('x-csrf-token', session.csrfToken);
    response.setHeader('Cache-Control', 'no-store');
    return {
      actor: this.publicActor(session.actor),
      expiresAt: session.expiresAt.toISOString(),
      idleExpiresAt: session.refreshExpiresAt.toISOString(),
    };
  }

  private publicActor(actor: ActorContext) {
    return {
      accountId: actor.accountId, subject: actor.subject, displayName: actor.displayName ?? null,
      email: actor.email ?? null, kind: actor.kind, sessionId: actor.sessionId,
      platformRoles: actor.platformRoles ?? [], platformPermissions: actor.platformPermissions ?? [],
    };
  }

  private clearSessionCookies(response: Response): void {
    const common = { secure: this.environment.AUTH_COOKIE_SECURE, sameSite: 'strict' as const };
    response.clearCookie(this.cookieName(), { ...common, httpOnly: true, path: '/api/v1' });
    response.clearCookie(`${this.cookieName()}_refresh`, { ...common, httpOnly: true, path: '/api/v1/auth/admin' });
    response.clearCookie(`${this.cookieName()}_csrf`, { ...common, httpOnly: false, path: '/' });
  }

  private setChallengeCookie(response: Response, token: string, expiresAt: Date): void {
    response.cookie(`${this.cookieName()}_mfa`, token, { secure: this.environment.AUTH_COOKIE_SECURE,
      sameSite: 'strict', httpOnly: true, path: '/api/v1/auth/admin', expires: expiresAt });
  }

  private clearChallengeCookie(response: Response): void {
    response.clearCookie(`${this.cookieName()}_mfa`, { secure: this.environment.AUTH_COOKIE_SECURE,
      sameSite: 'strict', httpOnly: true, path: '/api/v1/auth/admin' });
  }

  private challengeToken(request: HidRequest): string {
    const token = this.cookies(request)[`${this.cookieName()}_mfa`];
    if (!token) throw new DomainProblem(401, 'MFA_CHALLENGE_INVALID', 'Sign in again to continue');
    return token;
  }

  private cookieName(): string {
    return `${this.environment.AUTH_COOKIE_NAME}_admin`;
  }

  private assertAllowedOrigin(request: HidRequest): void {
    const origin = request.header('origin');
    if (!origin || !this.allowedOrigins.has(origin)) {
      throw new DomainProblem(403, 'ORIGIN_DENIED', 'Request origin is not allowed');
    }
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
