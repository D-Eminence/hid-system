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
import { GoogleLinkDto, GoogleLoginDto } from './dto/google-login.dto';
import { LoginDto } from './dto/login.dto';
import { PatientLoginDto } from './dto/patient-login.dto';
import { SelectFacilityDto } from './dto/select-facility.dto';
import { GoogleAuthenticationService } from './google-authentication.service';
import type { LoginResult } from './auth.types';
import { setSessionCookies } from './session-cookies';
import { sessionEventFromRequest, sessionSuccessAuditEvent } from './session-success-audit';
import { AccountSuspendedProblem } from './account-suspended';
import { loginPrincipalKey } from './patient-principal';
import { TokenService } from './token.service';
import { WorkloadAuthService } from './workload-auth.service';
import { TurnstileService } from './turnstile.service';

/**
 * The one answer to a refused credential at sign-in (LOGIN-DETAIL-ORACLE,
 * main D-Eminence/hid-system#76). A refusal raised after the password was
 * verified (an account that is not a patient, an inactive staff membership,
 * credentials changed during sign-in) gets the same 401 detail as a wrong
 * password, so the answer never confirms a correct password; the internal
 * reason stays out of the response. Other refusals keep their answer.
 * One carve-out (owner decision of 2026-10-28): the right password for a
 * suspended patient account answers 403 ACCOUNT_SUSPENDED
 * (AccountSuspendedProblem, raised only after the password was verified); it
 * is not an UnauthorizedException, so it passes through unchanged.
 */
/** Google sign-in refusals with their own code (0093), recorded as the sign-in's reason. */
const GOOGLE_AUDITED_REFUSALS = new Set(['GOOGLE_NOT_REGISTERED', 'GOOGLE_LINK_REQUIRED', 'GOOGLE_ACCOUNT_EXISTS',
  'ACCOUNT_SUSPENDED']);

function credentialRefusal(error: unknown): unknown {
  return error instanceof UnauthorizedException ? new UnauthorizedException('Invalid credentials') : error;
}

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
    if (input.turnstileAction === 'patient-login') {
      throw new DomainProblem(400, 'INVALID_LOGIN_ACTION', 'A workforce login action is required');
    }
    return this.performLogin(input, request, response, 'staff');
  }

  @Post('patient/login')
  @Public()
  @HttpCode(200)
  async patientLogin(
    @Body() input: PatientLoginDto,
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

  @Get('google/onboarding')
  @Public()
  googleOnboarding(@Req() request: HidRequest) {
    this.assertGoogleNonceOrigin(request);
    return this.google.onboardingStatus(this.cookies(request)[this.google.onboardingCookieName]);
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
    if (input.intent === 'enroll' && (this.hasCookie(request, this.environment.AUTH_COOKIE_NAME)
      || this.hasCookie(request, `${this.environment.AUTH_COOKIE_NAME}_refresh`)
      || request.header('authorization'))) {
      throw new DomainProblem(409, 'GOOGLE_ONBOARDING_REQUIRES_SIGN_OUT',
        'Sign out before starting a new Health ID enrollment');
    }
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
      const actorKind = input.turnstileAction === 'patient-login' ? 'patient' : 'staff';
      const exchanged = input.intent === 'enroll'
        ? await this.google.exchange(input.idToken, nonce, actorKind, 'enroll', this.event(request))
        : { kind: 'session' as const,
          session: await this.google.login(input.idToken, nonce, actorKind, this.event(request)) };
      if (exchanged.kind === 'pending') {
        response.cookie(this.google.onboardingCookieName, exchanged.cookie, {
          secure: this.environment.AUTH_COOKIE_SECURE,
          sameSite: 'strict',
          httpOnly: true,
          path: '/api/v1',
          expires: exchanged.expiresAt,
        });
        response.status(202);
        return exchanged.progress;
      }
      const result = exchanged.session;
      await this.recordSuccess('auth.google.login', result.actor, request);
      this.setCookies(response, result);
      response.setHeader('x-csrf-token', result.csrfToken);
      return this.sessionResponse(result.actor, result.expiresAt);
    } catch (error) {
      // A refusal raised while issuing the session (an account that is not a
      // patient, deactivated meanwhile) gets the one Google denial, not its
      // internal reason (LOGIN-DETAIL-ORACLE), and is audited as the denial it is.
      const answered = error instanceof UnauthorizedException
        ? new DomainProblem(401, 'GOOGLE_SIGN_IN_DENIED', 'Google sign-in could not be completed for this HID account')
        : error;
      // A refusal a patient is told about (0093) is audited with its code as
      // the reason; a suspended account's denial is recorded on that account.
      const reason = answered instanceof DomainProblem && GOOGLE_AUDITED_REFUSALS.has(answered.code)
        ? answered.code.toLowerCase() : undefined;
      await this.sessionAudit.record({
        correlationId: request.correlationId,
        ...(answered instanceof AccountSuspendedProblem && answered.accountSubject
          ? { actorSubject: answered.accountSubject } : {}),
        eventType: 'login_failed',
        outcome: answered instanceof DomainProblem && answered.getStatus() < 500 ? 'denied' : 'failure',
        sourceIp: request.ip,
        userAgent: request.header('user-agent'),
        details: { authentication_method: 'oidc', identity_provider: 'google', ...(reason ? { reason } : {}) },
      });
      throw answered;
    } finally {
      this.clearGoogleNonceCookie(response);
    }
  }

  @Post('google/link')
  @FacilityOptional()
  @PatientAllowed()
  @HttpCode(200)
  async linkGoogleIdentity(
    @Body() input: GoogleLinkDto,
    @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.assertAllowedOrigin(request);
    const actor = request.actor;
    if (!actor || actor.kind !== 'patient') {
      throw new DomainProblem(403, 'PATIENT_SCOPE_DENIED', 'A patient session is required');
    }
    try {
      if (input.turnstileAction !== 'patient-login') {
        throw new DomainProblem(400, 'INVALID_LOGIN_ACTION', 'Patient login action is required');
      }
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
      await this.google.linkExistingPatient(input.idToken, nonce, input.principal, input.password,
        actor, this.event(request));
      await this.recordSuccess('auth.google.link', actor, request);
      return { linked: true };
    } finally {
      this.clearGoogleNonceCookie(response);
    }
  }

  private async performLogin(input: LoginDto | PatientLoginDto, request: HidRequest, response: Response, kind: 'staff' | 'patient') {
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
        await this.sessionAudit.recordLoginFailure(loginPrincipalKey(input.email, kind), this.event(request));
      } else if (error instanceof AccountSuspendedProblem) {
        // The right password for a suspended account (patient sign-in only):
        // a denied sign-in on that account, not a failed password, so it
        // neither counts towards nor clears the principal's lockout.
        await this.sessionAudit.record({
          correlationId: request.correlationId,
          actorSubject: error.accountSubject,
          eventType: 'login_failed',
          outcome: 'denied',
          sourceIp: request.ip,
          userAgent: request.header('user-agent'),
          details: { reason: 'account_suspended' },
        });
      } else {
        await this.sessionAudit.record({
          correlationId: request.correlationId,
          eventType: 'login_failed',
          outcome: 'failure',
          sourceIp: request.ip,
          userAgent: request.header('user-agent'),
        });
      }
      throw credentialRefusal(error);
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
    return this.audit.record(sessionSuccessAuditEvent(action, actor, request));
  }

  private setCookies(response: Response, result: LoginResult): void {
    setSessionCookies(response, result, this.environment);
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
      path: '/api/v1/auth',
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
      path: '/api/v1/auth',
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
    return sessionEventFromRequest(request);
  }

  private cookies(request: HidRequest): Record<string, string> {
    const value = (request as Request & { cookies?: unknown }).cookies;
    if (typeof value !== 'object' || value === null) return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  }

  private hasCookie(request: HidRequest, name: string): boolean {
    // Presence, not identity. `cookies` drops a repeated cookie name because
    // the parser yields an array, so it cannot be used to decide whether the
    // caller is signed in: doing so would let a signed-in patient reach
    // enrollment by repeating the cookie.
    const value = (request as Request & { cookies?: unknown }).cookies;
    if (typeof value !== 'object' || value === null) return false;
    return Object.prototype.hasOwnProperty.call(value, name)
      && (value as Record<string, unknown>)[name] !== undefined;
  }
}
