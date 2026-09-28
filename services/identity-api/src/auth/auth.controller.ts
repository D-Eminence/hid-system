import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuditFailuresOnly, FacilityOptional, PatientAllowed, Public } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { AuthService } from './auth.service';
import { AuthSessionAuditService } from './auth-session-audit.service';
import { GoogleLoginDto } from './dto/google-login.dto';
import { LoginDto } from './dto/login.dto';
import { SelectFacilityDto } from './dto/select-facility.dto';
import { GoogleAuthenticationService } from './google-authentication.service';
import type { LoginResult } from './auth.types';
import { TokenService } from './token.service';
import { WorkloadAuthService } from './workload-auth.service';
import { TurnstileService } from './turnstile.service';

@Controller('auth')
@AuditFailuresOnly()
export class AuthController {
  private static readonly GOOGLE_NONCE_TTL_MS = 5 * 60 * 1_000;
  private readonly environment = getEnvironment();
  private readonly allowedOrigins = new Set(this.environment.CORS_ORIGINS.split(',').map((origin) => origin.trim()));

  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly sessionAudit: AuthSessionAuditService,
    private readonly audit: AuditService,
    private readonly workloadAuth: WorkloadAuthService,
    private readonly turnstile: TurnstileService,
    private readonly google: GoogleAuthenticationService,
  ) {}

  @Post('login')
  @Public()
  @HttpCode(200)
  async login(
    @Body() input: LoginDto,
    @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.performLogin(input, request, response, 'staff');
  }

  @Post('patient/login')
  @Public()
  @HttpCode(200)
  async patientLogin(
    @Body() input: LoginDto,
    @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (input.turnstileAction !== 'patient-login') {
      throw new DomainProblem(400, 'INVALID_LOGIN_ACTION', 'Patient login action is required');
    }
    return this.performLogin(input, request, response, 'patient');
  }

  @Get('google/nonce')
  @Public()
  @HttpCode(200)
  googleNonce(@Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    this.assertGoogleNonceOrigin(request);
    const nonce = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + AuthController.GOOGLE_NONCE_TTL_MS);
    this.setGoogleNonceCookie(response, nonce, expiresAt);
    return { nonce };
  }

  @Post('oidc/exchange')
  @Public()
  @HttpCode(200)
  async exchangeGoogleIdToken(
    @Body() input: GoogleLoginDto,
    @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.assertAllowedOrigin(request);
    try {
      await this.turnstile.verifyLogin({
        token: input.turnstileToken,
        action: input.turnstileAction,
        origin: request.header('origin'),
        remoteIp: request.ip,
      });
      const nonce = this.googleNonceFromCookie(this.cookies(request)[this.googleNonceCookieName()]);
      if (!nonce) {
        throw new DomainProblem(401, 'GOOGLE_SIGN_IN_DENIED', 'Google sign-in could not be completed for this HID account');
      }
      const result = await this.google.login(
        input.idToken,
        nonce,
        input.turnstileAction === 'patient-login' ? 'patient' : 'staff',
        this.event(request),
      );
      await this.recordSuccess('auth.google.login', result.actor, request);
      this.setCookies(response, result);
      response.setHeader('x-csrf-token', result.csrfToken);
      return this.sessionResponse(result.actor, result.expiresAt);
    } catch (error) {
      await this.sessionAudit.record({
        correlationId: request.correlationId,
        eventType: 'login_failed',
        outcome: error instanceof DomainProblem && error.getStatus() < 500 ? 'denied' : 'failure',
        sourceIp: request.ip,
        userAgent: request.header('user-agent'),
        details: { authentication_method: 'oidc', identity_provider: 'google' },
      });
      throw error;
    } finally {
      this.clearGoogleNonceCookie(response);
    }
  }

  private async performLogin(input: LoginDto, request: HidRequest, response: Response, kind: 'staff' | 'patient') {
    this.assertAllowedOrigin(request);
    await this.turnstile.verifyLogin({
      token: input.turnstileToken,
      action: input.turnstileAction,
      origin: request.header('origin'),
      remoteIp: request.ip,
    });
    try {
      const result = await this.auth.login(input, this.event(request), kind);
      await this.recordSuccess('auth.login', result.actor, request);
      this.setCookies(response, result);
      response.setHeader('x-csrf-token', result.csrfToken);
      return this.sessionResponse(result.actor, result.expiresAt);
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        await this.sessionAudit.recordLoginFailure(input.email, this.event(request));
      } else {
        await this.sessionAudit.record({
          correlationId: request.correlationId,
          eventType: 'login_failed',
          outcome: 'failure',
          sourceIp: request.ip,
          userAgent: request.header('user-agent'),
        });
      }
      throw error;
    }
  }

  @Post('refresh')
  @Public()
  @HttpCode(200)
  async refresh(@Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    this.assertAllowedOrigin(request);
    const cookies = this.cookies(request);
    const refreshToken = cookies[`${this.environment.AUTH_COOKIE_NAME}_refresh`];
    const csrfCookie = cookies[`${this.environment.AUTH_COOKIE_NAME}_csrf`];
    const csrfHeader = request.header('x-csrf-token');
    if (!refreshToken || !this.tokens.verifyRefreshCsrf(refreshToken, csrfCookie, csrfHeader)) {
      throw new DomainProblem(403, 'CSRF_VALIDATION_FAILED', 'Refresh CSRF validation failed');
    }
    try {
      const result = await this.auth.refresh(refreshToken, this.event(request));
      await this.recordSuccess('auth.refresh', result.actor, request);
      this.setCookies(response, result);
      response.setHeader('x-csrf-token', result.csrfToken);
      return this.sessionResponse(result.actor, result.expiresAt);
    } catch (error) {
      this.clearCookies(response);
      throw error;
    }
  }

  @Get('session')
  @FacilityOptional()
  @PatientAllowed()
  async session(
    @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const actor = request.actor;
    if (!actor) throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required');
    await this.audit.record({
      correlationId: request.correlationId,
      actorType: actor.kind === 'patient' ? 'patient' : 'staff',
      actorSubject: actor.subject,
      actorAccountId: actor.accountId,
      actorMembershipId: actor.facility?.membershipId,
      organizationId: actor.facility?.organizationId,
      facilityId: actor.facility?.id,
      action: 'auth.session.read',
      resourceType: 'session',
      resourceId: actor.sessionId,
      outcome: 'success',
      sourceIp: request.ip,
      userAgent: request.header('user-agent'),
    });
    const csrfToken = this.cookies(request)[`${this.environment.AUTH_COOKIE_NAME}_csrf`];
    if (csrfToken) response.setHeader('x-csrf-token', csrfToken);
    return this.sessionResponse(actor);
  }

  @Get('service-session')
  @FacilityOptional()
  @PatientAllowed()
  async serviceSession(
    @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.workloadAuth.authenticateService(
      request.header('x-hid-internal-caller'),
      request.header('x-hid-service-authorization'),
      request.header('x-hid-service-token'),
    );
    return this.session(request, response);
  }

  @Post('service-session')
  @FacilityOptional()
  @PatientAllowed()
  @HttpCode(200)
  async validateServiceMutation(
    @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.serviceSession(request, response);
  }

  @Post('logout')
  @FacilityOptional()
  @PatientAllowed()
  @HttpCode(204)
  async logout(@Req() request: HidRequest, @Res({ passthrough: true }) response: Response): Promise<void> {
    await this.auth.revoke(request.actor?.sessionId, request.actor?.subject, this.event(request));
    if (request.actor) await this.recordSuccess('auth.logout', request.actor, request);
    this.clearCookies(response);
  }

  @Post('facility')
  @FacilityOptional()
  @HttpCode(200)
  async selectFacility(
    @Body() input: SelectFacilityDto,
    @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const actor = request.actor;
    if (!actor) throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required');
    const facility = actor.facilities.find((candidate) => candidate.id === input.facilityId);
    if (!facility) throw new DomainProblem(403, 'FACILITY_ACCESS_DENIED', 'The actor is not active at this facility');
    const selectedActor: ActorContext = {
      ...actor,
      facility,
      roles: facility.roles,
      role: facility.roles[0],
      permissions: facility.permissions,
    };
    await this.audit.record({
      correlationId: request.correlationId,
      actorType: 'staff',
      actorSubject: actor.subject,
      actorAccountId: actor.accountId,
      actorMembershipId: facility.membershipId,
      organizationId: facility.organizationId,
      facilityId: facility.id,
      action: 'auth.facility.select',
      resourceType: 'session',
      resourceId: actor.sessionId,
      outcome: 'success',
      sourceIp: request.ip,
      userAgent: request.header('user-agent'),
    });
    const csrfToken = this.cookies(request)[`${this.environment.AUTH_COOKIE_NAME}_csrf`];
    if (csrfToken) response.setHeader('x-csrf-token', csrfToken);
    return this.sessionResponse(selectedActor);
  }

  private sessionResponse(actor: ActorContext, expiresAt?: Date) {
    return {
      actor,
      ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
    };
  }

  private recordSuccess(action: string, actor: ActorContext, request: HidRequest): Promise<void> {
    return this.audit.record({
      correlationId: request.correlationId,
      actorType: actor.kind === 'patient' ? 'patient' : 'staff',
      actorSubject: actor.subject,
      actorAccountId: actor.accountId,
      actorMembershipId: actor.facility?.membershipId,
      organizationId: actor.facility?.organizationId,
      facilityId: actor.facility?.id,
      action,
      resourceType: 'session',
      resourceId: actor.sessionId,
      outcome: 'success',
      sourceIp: request.ip,
      userAgent: request.header('user-agent'),
    });
  }

  private setCookies(response: Response, result: LoginResult): void {
    const common = {
      secure: this.environment.AUTH_COOKIE_SECURE,
      sameSite: 'strict' as const,
    };
    response.cookie(this.environment.AUTH_COOKIE_NAME, result.accessToken, {
      ...common, httpOnly: true, path: '/', expires: result.expiresAt,
    });
    response.cookie(`${this.environment.AUTH_COOKIE_NAME}_refresh`, result.refreshToken, {
      ...common, httpOnly: true, path: '/api/v1/auth', expires: result.refreshExpiresAt,
    });
    response.cookie(`${this.environment.AUTH_COOKIE_NAME}_csrf`, result.csrfToken, {
      ...common, httpOnly: false, path: '/', expires: result.refreshExpiresAt,
    });
  }

  private clearCookies(response: Response): void {
    const common = {
      secure: this.environment.AUTH_COOKIE_SECURE,
      sameSite: 'strict' as const,
    };
    response.clearCookie(this.environment.AUTH_COOKIE_NAME, { ...common, httpOnly: true, path: '/' });
    response.clearCookie(`${this.environment.AUTH_COOKIE_NAME}_refresh`, { ...common, httpOnly: true, path: '/api/v1/auth' });
    response.clearCookie(`${this.environment.AUTH_COOKIE_NAME}_csrf`, { ...common, httpOnly: false, path: '/' });
  }

  private googleNonceCookieName(): string {
    return `${this.environment.AUTH_COOKIE_NAME}_google_nonce`;
  }

  private setGoogleNonceCookie(response: Response, nonce: string, expiresAt: Date): void {
    response.cookie(this.googleNonceCookieName(), this.googleNonceCookieValue(nonce, expiresAt), {
      secure: this.environment.AUTH_COOKIE_SECURE,
      sameSite: 'strict',
      httpOnly: true,
      path: '/api/v1/auth/oidc',
      expires: expiresAt,
    });
  }

  /**
   * The raw nonce is intentionally returned to Google Identity Services, but
   * never trusted when echoed in a client-supplied Cookie header. The cookie
   * envelope proves the nonce was minted by this Identity API and enforces its
   * expiry on the server rather than relying only on browser cookie expiry.
   */
  private googleNonceCookieValue(nonce: string, expiresAt: Date): string {
    const expiresAtSeconds = Math.floor(expiresAt.getTime() / 1_000);
    const payload = `${nonce}.${expiresAtSeconds}`;
    return `${payload}.${this.googleNonceSignature(payload)}`;
  }

  private googleNonceFromCookie(cookie: string | undefined): string | undefined {
    if (!cookie) return undefined;
    const [nonce, expiresAtText, signature, extra] = cookie.split('.');
    if (extra !== undefined
      || !nonce
      || !expiresAtText
      || !signature
      || !/^[A-Za-z0-9_-]{43}$/.test(nonce)
      || !/^[1-9][0-9]{9,12}$/.test(expiresAtText)) {
      return undefined;
    }
    const expiresAtSeconds = Number(expiresAtText);
    if (!Number.isSafeInteger(expiresAtSeconds) || expiresAtSeconds <= Math.floor(Date.now() / 1_000)) return undefined;
    const expected = this.googleNonceSignature(`${nonce}.${expiresAtText}`);
    const supplied = Buffer.from(signature, 'utf8');
    const verified = Buffer.from(expected, 'utf8');
    if (supplied.length !== verified.length || !timingSafeEqual(supplied, verified)) return undefined;
    return nonce;
  }

  private googleNonceSignature(payload: string): string {
    // Local cookie sessions cannot start without this environment-validated
    // secret. Keep a distinct context label so this signature is never an
    // interchangeable access-token or CSRF MAC.
    return createHmac('sha256', this.environment.AUTH_SIGNING_SECRET ?? '')
      .update(`google-oidc-nonce:${payload}`, 'utf8')
      .digest('base64url');
  }

  private clearGoogleNonceCookie(response: Response): void {
    response.clearCookie(this.googleNonceCookieName(), {
      secure: this.environment.AUTH_COOKIE_SECURE,
      sameSite: 'strict',
      httpOnly: true,
      path: '/api/v1/auth/oidc',
    });
  }

  private assertAllowedOrigin(request: HidRequest): void {
    const origin = request.header('origin');
    if (!origin || !this.allowedOrigins.has(origin)) {
      throw new DomainProblem(403, 'ORIGIN_DENIED', 'Request origin is not allowed');
    }
  }

  /**
   * Chromium omits Origin on same-origin GET fetches. The nonce endpoint has
   * no authenticated side effect, but it must still reject a cross-site
   * caller. Accept a validated Referer only for this GET; the token exchange
   * remains strictly Origin-checked.
   */
  private assertGoogleNonceOrigin(request: HidRequest): void {
    const origin = request.header('origin');
    if (origin) {
      this.assertAllowedOrigin(request);
      return;
    }
    const referer = request.header('referer');
    try {
      if (referer && this.allowedOrigins.has(new URL(referer).origin)) return;
    } catch {
      // Treat a malformed Referer as an unapproved origin.
    }
    throw new DomainProblem(403, 'ORIGIN_DENIED', 'Request origin is not allowed');
  }

  private event(request: HidRequest) {
    return {
      correlationId: request.correlationId,
      sourceIp: request.ip,
      userAgent: request.header('user-agent'),
    };
  }

  private cookies(request: HidRequest): Record<string, string> {
    const value = (request as Request & { cookies?: unknown }).cookies;
    if (typeof value !== 'object' || value === null) return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  }
}
