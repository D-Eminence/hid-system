import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Body, Controller, Get, HttpCode, MethodNotAllowedException, Post, Req, Res, ServiceUnavailableException,
  UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { AuditService, type AuditEventInput } from '../audit/audit.service';
import { AuditFailuresOnly, AuditSessionEvent, FacilityOptional, PatientAllowed, Public } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { ActorContext, FacilityAssignment, HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { clearEnrollmentCookie } from '../identity/enrollment-cookie';
import { AuthService } from './auth.service';
import { AuthSessionAuditService } from './auth-session-audit.service';
import { GoogleLinkDto, GoogleLoginDto } from './dto/google-login.dto';
import { LoginDto } from './dto/login.dto';
import { PatientLoginDto } from './dto/patient-login.dto';
import { PlatformMfaVerifyDto, StaffMfaEnrollmentStartDto, TotpCodeDto } from './dto/platform-auth.dto';
import { SelectFacilityDto } from './dto/select-facility.dto';
import { GoogleAuthenticationService } from './google-authentication.service';
import type { FacilitySelectionState, LoginResult } from './auth.types';
import { MfaService } from './mfa/mfa.service';
import { refreshRefused } from './refresh-refusal';
import { TokenService } from './token.service';
import { WorkloadAuthService } from './workload-auth.service';
import { TurnstileService } from './turnstile.service';

/**
 * The one answer to a refused credential at sign-in (LOGIN-DETAIL-ORACLE). A
 * refusal raised after the password was verified (an account that is not a
 * patient, deactivated or changed during sign-in) gets the same 401 detail as
 * a wrong password, so the answer never confirms a correct password; the
 * internal reason stays out of the response. Other refusals keep their answer.
 */
function credentialRefusal(error: unknown): unknown {
  return error instanceof UnauthorizedException ? new UnauthorizedException('Invalid credentials') : error;
}

/** A10: a correct staff password without an active facility membership; MfaService recorded it. */
function noActiveMembership(error: unknown): boolean {
  return error instanceof DomainProblem && error.code === 'NO_ACTIVE_FACILITY_MEMBERSHIP';
}

/** The actor a session response reports and, for a staff sign-in, where its facility comes from. */
interface SessionReport {
  actor: ActorContext;
  facilitySelection?: FacilitySelectionState;
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
    private readonly mfa: MfaService,
  ) {}

  /**
   * Password step of staff sign-in (MFA-1, 0088). As platform sign-in does, a
   * password alone never yields a session: a valid password of an account
   * with an eligible staff membership yields only an httpOnly challenge cookie
   * that the /auth/mfa steps accept, and the session is issued after a TOTP
   * code or a recovery code (or, on the first sign-in, after enrolment). No
   * session cookie is set or changed here. A correct password of a staff
   * account with no active facility membership is refused with 403
   * NO_ACTIVE_FACILITY_MEMBERSHIP before any challenge (A10); every refused
   * credential gets the one generic 401 (LOGIN-DETAIL-ORACLE).
   */
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
    this.assertAllowedOrigin(request);
    await this.turnstile.verifyLogin({
      token: input.turnstileToken,
      action: input.turnstileAction,
      origin: request.header('origin'),
      remoteIp: request.ip,
    });
    if (this.environment.AUTH_MODE === 'oidc') {
      throw new MethodNotAllowedException('Password login is disabled; use the configured OIDC authorization flow');
    }
    try {
      const challenge = await this.mfa.beginLogin(input.email, input.password, this.event(request), 'staff');
      this.setStaffChallengeCookie(response, challenge.token, challenge.expiresAt);
      response.setHeader('Cache-Control', 'no-store');
      return {
        status: challenge.purpose === 'verify' ? 'mfa_required' as const : 'mfa_enrollment_required' as const,
        expiresAt: challenge.expiresAt.toISOString(),
      };
    } catch (error) {
      await this.recordLoginFailure(error, input.email, request);
      throw credentialRefusal(error);
    }
  }

  /** Second step of staff sign-in: an authenticator code or one unused recovery code. */
  @Post('mfa/verify')
  @Public()
  @HttpCode(200)
  async verifyStaffMfa(@Body() input: PlatformMfaVerifyDto, @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response) {
    this.assertAllowedOrigin(request);
    const result = await this.mfa.completeLogin(this.staffChallengeToken(request), input, this.event(request), 'staff');
    this.clearStaffChallengeCookie(response);
    return this.staffSessionResponse(response, result);
  }

  /**
   * First staff sign-in without an authenticator: sends the fresh proof of the
   * enrolment, a six-digit code to the account's email address.
   */
  @Post('mfa/enroll/email-code')
  @Public()
  @HttpCode(200)
  async sendStaffEnrollmentCode(@Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    this.assertAllowedOrigin(request);
    const sent = await this.mfa.sendEnrollmentCode(this.staffChallengeToken(request), this.event(request));
    response.setHeader('Cache-Control', 'no-store');
    return { ...sent, expiresAt: sent.expiresAt.toISOString() };
  }

  /** Verifies the enrolment proof and returns the new TOTP secret, once. */
  @Post('mfa/enroll/start')
  @Public()
  @HttpCode(200)
  async startStaffEnrollment(@Body() input: StaffMfaEnrollmentStartDto, @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response) {
    this.assertAllowedOrigin(request);
    const enrollment = await this.mfa.startEnrollment(this.staffChallengeToken(request), this.event(request), 'staff',
      { emailCode: input.emailCode });
    response.setHeader('Cache-Control', 'no-store');
    return { ...enrollment, expiresAt: enrollment.expiresAt.toISOString() };
  }

  /** Confirms the authenticator with its first code, issues recovery codes (once) and the staff session. */
  @Post('mfa/enroll/activate')
  @Public()
  @HttpCode(200)
  async activateStaffEnrollment(@Body() input: TotpCodeDto, @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response) {
    this.assertAllowedOrigin(request);
    const { session, recoveryCodes } = await this.mfa.activateEnrollment(this.staffChallengeToken(request), input.code,
      this.event(request), 'staff');
    this.clearStaffChallengeCookie(response);
    return { ...this.staffSessionResponse(response, session), recoveryCodes };
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
      // Only patient sign-in uses Google (MFA-1). A staff session needs a
      // password and an authenticator code, which a Google ID token is not.
      if (input.turnstileAction !== 'patient-login') {
        throw new DomainProblem(403, 'GOOGLE_STAFF_SIGN_IN_DISABLED',
          'Staff sign-in needs your password and authenticator code; Google sign-in is for patients only');
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
      const exchanged = input.intent === 'enroll'
        ? await this.google.exchange(input.idToken, nonce, 'patient', 'enroll', this.event(request))
        : { kind: 'session' as const,
          session: await this.google.login(input.idToken, nonce, 'patient', this.event(request)) };
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
      await this.sessionAudit.record({
        correlationId: request.correlationId,
        eventType: 'login_failed',
        outcome: answered instanceof DomainProblem && answered.getStatus() < 500 ? 'denied' : 'failure',
        sourceIp: request.ip,
        userAgent: request.header('user-agent'),
        details: { authentication_method: 'oidc', identity_provider: 'google' },
      });
      throw answered;
    } finally {
      this.clearGoogleNonceCookie(response);
    }
  }

  @Post('google/link')
  @AuditSessionEvent('auth.google.link')
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

  /** Patient password sign-in. Staff sign-in is two-step (login, then the /auth/mfa steps). */
  private async performLogin(input: PatientLoginDto, request: HidRequest, response: Response, kind: 'patient') {
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
      await this.recordLoginFailure(error, input.email, request);
      throw credentialRefusal(error);
    }
  }

  /**
   * A refused credential counts toward the sign-in lockout; any other failure
   * is recorded without counting. A staff password without an active facility
   * membership was correct: MfaService recorded that refusal against the
   * account in its own transaction, and it is not counted (A10).
   */
  private async recordLoginFailure(error: unknown, principal: string, request: HidRequest): Promise<void> {
    if (noActiveMembership(error)) return;
    if (error instanceof UnauthorizedException) {
      await this.sessionAudit.recordLoginFailure(principal, this.event(request));
    } else {
      await this.sessionAudit.record({
        correlationId: request.correlationId,
        eventType: 'login_failed',
        outcome: 'failure',
        sourceIp: request.ip,
        userAgent: request.header('user-agent'),
      });
    }
  }

  /**
   * A staff session issued after its second factor: the session cookies, as a
   * sign-in always set them. It is a new sign-in, so it has no facility
   * selection yet (0089): facilitySelection 'default'. The password step
   * issues no session and reports none.
   */
  private staffSessionResponse(response: Response, result: LoginResult) {
    this.setCookies(response, result);
    response.setHeader('x-csrf-token', result.csrfToken);
    response.setHeader('Cache-Control', 'no-store');
    return this.sessionResponse(result.actor, result.expiresAt, this.newSignInSelection(result.actor));
  }

  private staffChallengeCookieName(): string {
    return `${this.environment.AUTH_COOKIE_NAME}_mfa`;
  }

  private setStaffChallengeCookie(response: Response, token: string, expiresAt: Date): void {
    response.cookie(this.staffChallengeCookieName(), token, { secure: this.environment.AUTH_COOKIE_SECURE,
      sameSite: 'strict', httpOnly: true, path: '/api/v1/auth/mfa', expires: expiresAt });
  }

  private clearStaffChallengeCookie(response: Response): void {
    response.clearCookie(this.staffChallengeCookieName(), { secure: this.environment.AUTH_COOKIE_SECURE,
      sameSite: 'strict', httpOnly: true, path: '/api/v1/auth/mfa' });
  }

  private staffChallengeToken(request: HidRequest): string {
    const token = this.cookies(request)[this.staffChallengeCookieName()];
    if (!token) throw new DomainProblem(401, 'MFA_CHALLENGE_INVALID', 'Sign in again to continue');
    return token;
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
    // The staff and patient apps share the session cookies on one origin. A
    // client that names itself refreshes only its own kind of sign-in; the
    // other app's sign-in is refused before rotation and its cookies kept.
    const expectedKind = this.namedClientKind(request);
    if (expectedKind) {
      const kind = await this.tokens.refreshSessionKind(refreshToken);
      if (kind && kind !== expectedKind) throw this.clientMismatch(kind, request);
    }
    // The rotation commits with its audit event or not at all, and the
    // cookies are cleared only when the refresh token was refused (4xx). A
    // fault (5xx, or any other error) leaves the cookies the browser holds,
    // which still refresh, so the client may retry (A6).
    try {
      const result = await this.auth.refresh(refreshToken, this.event(request),
        (client, actor) => this.recordRotation(client, actor, request));
      // The rotation has committed: the presented refresh token is spent and
      // only the rotated session is live. It keeps the sign-in's family, and so
      // its facility selection (0089). A selection that cannot be read now does
      // not fail the refresh: a 5xx after the rotation would leave the browser
      // with the spent token (an edge that replaces a 5xx drops its Set-Cookie). It is answered as
      // 'unavailable', with the default facility, which the client does not
      // take as a choice; the stored choice is kept for the next read.
      const reported = await this.withFacilitySelection(result.actor, undefined, 'report');
      this.setCookies(response, result);
      response.setHeader('x-csrf-token', result.csrfToken);
      return this.sessionResponse(reported.actor, result.expiresAt, reported.facilitySelection);
    } catch (error) {
      if (refreshRefused(error)) this.clearCookies(response);
      throw error;
    }
  }

  /** The auth.refresh audit event, written in the rotation's transaction: a failed write rolls the rotation back. */
  private async recordRotation(client: PoolClient, actor: ActorContext, request: HidRequest): Promise<void> {
    try {
      await this.audit.recordWithClient(client, this.successEvent('auth.refresh', actor, request));
    } catch {
      throw new ServiceUnavailableException('Audit persistence is unavailable; request was denied');
    }
  }

  /**
   * The signed-in actor. For a staff sign-in the reported facility is the one
   * it selected with POST /auth/facility (facilitySelection 'selected'), so a
   * reload does not move the user back to the primary facility; with no
   * selection it is the default ('default'), and when the selected facility is
   * no longer one of the actor's active facilities it is the default and the
   * user must choose again ('reselect'). A valid X-Facility-ID on this request
   * still binds the facility it names. The selection authorizes nothing.
   */
  @Get('session')
  @AuditSessionEvent('auth.session.read')
  @FacilityOptional()
  @PatientAllowed()
  async session(
    @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const actor = request.actor;
    if (!actor) throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required');
    return this.readSession(request, response, await this.withFacilitySelection(actor, request.facilityId));
  }

  @Get('service-session')
  @AuditSessionEvent('auth.service-session.read')
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
    const actor = request.actor;
    if (!actor) throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required');
    // A service authorizes one browser request by its X-Facility-ID: the actor
    // as the guard bound it, with no facility selection read or reported.
    return this.readSession(request, response, { actor });
  }

  @Post('service-session')
  @AuditSessionEvent('auth.service-session.validate')
  @FacilityOptional()
  @PatientAllowed()
  @HttpCode(200)
  async validateServiceMutation(
    @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.serviceSession(request, response);
  }

  /**
   * Ends the sign-in and clears the session cookies. A live access token ends
   * its own sign-in, as a bearer token or as the cookie with an allowed Origin
   * and its CSRF token. A browser whose access token has already expired signs
   * out with its refresh cookie instead: the CSRF token is derived from that
   * refresh token, so a request ends only the sign-in whose refresh cookie and
   * CSRF token it carries together. A live access token always decides, so a
   * request carrying one sign-in's access token and another's refresh cookie
   * ends only the first.
   *
   * The staff and patient apps share the session cookies on one origin. A
   * cookie sign-out from an app that names itself in X-HID-Client ('staff-web'
   * or 'patient-web') does not end the other app's sign-in while refresh could
   * renew it: that is refused with 403 SESSION_CLIENT_MISMATCH after the
   * Origin and CSRF checks, nothing ends and its cookies are kept. A sign-in
   * of the other kind that refresh could not renew now (an older rotated
   * token, an expired sign-in, a suspended account, a staff membership or a
   * patient that refresh can no longer resolve) is ended without naming its
   * kind (TokenService.revokeByRefreshToken). A bearer sign-out names its
   * sign-in explicitly and ignores the header; an unnamed app signs out as
   * before. Every other outcome clears the cookies, the public patient
   * enrollment cookie included.
   */
  @Post('logout')
  @AuditSessionEvent('auth.logout')
  @Public()
  @HttpCode(204)
  async logout(@Req() request: HidRequest, @Res({ passthrough: true }) response: Response): Promise<void> {
    const authorization = request.header('authorization');
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
    // A cookie sign-out from an unapproved origin changes nothing, cookies included.
    if (!bearer) this.assertAllowedOrigin(request);
    const expectedKind = this.namedClientKind(request);
    // Set only when the other app's sign-in is refused: its cookies stay.
    let keepCookies = false;
    try {
      if (bearer) {
        const verified = await this.liveSession(bearer);
        if (!verified) throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required');
        request.actor = verified.actor;
        await this.endSignIn(verified.actor, request);
        return;
      }
      const cookies = this.cookies(request);
      const csrfCookie = cookies[`${this.environment.AUTH_COOKIE_NAME}_csrf`];
      const csrfHeader = request.header('x-csrf-token');
      const access = cookies[this.environment.AUTH_COOKIE_NAME];
      const verified = access ? await this.liveSession(access) : undefined;
      if (verified) {
        // A refusal from here on is audited against the signed-in actor.
        request.actor = verified.actor;
        if (!this.tokens.verifyCsrf(verified.claims, csrfCookie, csrfHeader)) {
          throw new DomainProblem(403, 'CSRF_VALIDATION_FAILED', 'CSRF validation failed');
        }
        // A staff actor carries no kind; a platform token is refused by endSignIn.
        const kind = verified.actor.kind === 'patient' ? 'patient' : verified.actor.kind === 'platform' ? undefined : 'staff';
        if (expectedKind && kind && kind !== expectedKind) {
          keepCookies = true;
          throw this.clientMismatch(kind, request);
        }
        await this.endSignIn(verified.actor, request);
        return;
      }
      const refreshToken = cookies[`${this.environment.AUTH_COOKIE_NAME}_refresh`];
      // No sign-in left to end: the cookies are cleared all the same.
      if (!refreshToken) return;
      if (!this.tokens.verifyRefreshCsrf(refreshToken, csrfCookie, csrfHeader)) {
        throw new DomainProblem(403, 'CSRF_VALIDATION_FAILED', 'CSRF validation failed');
      }
      const ended = await this.auth.revokeByRefreshToken(refreshToken, this.event(request), expectedKind);
      if (ended && 'refusedKind' in ended) {
        keepCookies = true;
        throw this.clientMismatch(ended.refusedKind, request);
      }
      if (ended) {
        await this.audit.record({
          correlationId: request.correlationId,
          actorType: ended.kind,
          actorSubject: ended.actorSubject,
          actorAccountId: ended.accountId,
          action: 'auth.logout',
          resourceType: 'session',
          resourceId: ended.sessionId,
          outcome: 'success',
          sourceIp: request.ip,
          userAgent: request.header('user-agent'),
        });
      }
    } finally {
      if (!keepCookies) this.clearCookies(response);
    }
  }

  @Post('facility')
  @AuditSessionEvent('auth.facility.select')
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
    const selectedActor = this.atFacility(actor, facility);
    const selectionAudit: AuditEventInput = {
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
    };
    const csrfToken = this.cookies(request)[`${this.environment.AUTH_COOKIE_NAME}_csrf`];
    if (!this.staffSignIn(actor)) {
      // No Identity sign-in to keep the choice for (an external OIDC bearer
      // token): answered as before, nothing stored.
      await this.audit.record(selectionAudit);
      if (csrfToken) response.setHeader('x-csrf-token', csrfToken);
      return this.sessionResponse(selectedActor);
    }
    // Stored for this sign-in with its audit, in one transaction (0089).
    const outcome = await this.tokens.recordFacilitySelection({
      sessionId: actor.sessionId, accountId: actor.accountId, facilityId: facility.id, membershipId: facility.membershipId,
    }, this.event(request), (client) => this.auditOnTransaction(client, selectionAudit));
    if (outcome === 'session_ended') {
      throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required');
    }
    if (outcome === 'refused') {
      throw new DomainProblem(403, 'FACILITY_ACCESS_DENIED', 'The actor is not active at this facility');
    }
    if (csrfToken) response.setHeader('x-csrf-token', csrfToken);
    return this.sessionResponse(selectedActor, undefined, 'selected');
  }

  private sessionResponse(actor: ActorContext, expiresAt?: Date, facilitySelection?: FacilitySelectionState) {
    return {
      actor,
      ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
      ...(facilitySelection ? { facilitySelection } : {}),
    };
  }

  /** Records the session read and answers with the actor and facility it reports. */
  private async readSession(request: HidRequest, response: Response, reported: SessionReport) {
    const actor = reported.actor;
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
    return this.sessionResponse(actor, undefined, reported.facilitySelection);
  }

  /** A staff actor of an Identity sign-in (a staff actor carries no kind), which can keep a facility selection. */
  private staffSignIn(actor: ActorContext): actor is ActorContext & { sessionId: string } {
    return actor.kind !== 'patient' && actor.kind !== 'platform' && typeof actor.sessionId === 'string';
  }

  /** A new staff sign-in has no selection yet. */
  private newSignInSelection(actor: ActorContext): FacilitySelectionState | undefined {
    return this.staffSignIn(actor) ? 'default' : undefined;
  }

  /**
   * The actor at the facility its sign-in selected (0089), re-checked against
   * the actor's current active facilities. `boundFacilityId` is the facility a
   * valid X-Facility-ID bound to this request, which keeps the actor at it.
   * A failed read is never answered as the default facility: it is 503
   * DEPENDENCY_UNAVAILABLE, or, when `unreadable` is 'report' (a refresh whose
   * rotation has committed), the actor as resolved with 'unavailable'.
   */
  private async withFacilitySelection(actor: ActorContext, boundFacilityId?: string,
    unreadable: 'refuse' | 'report' = 'refuse'): Promise<SessionReport> {
    if (!this.staffSignIn(actor)) return { actor };
    let selectedId: string | undefined;
    try {
      selectedId = await this.tokens.selectedFacilityId(actor.sessionId, actor.accountId);
    } catch {
      if (unreadable === 'report') return { actor, facilitySelection: 'unavailable' };
      throw new ServiceUnavailableException('The facility selection is unavailable');
    }
    if (!selectedId) return { actor, facilitySelection: 'default' };
    const selected = actor.facilities.find((candidate) => candidate.id === selectedId);
    if (!selected) return { actor, facilitySelection: 'reselect' };
    return { actor: boundFacilityId ? actor : this.atFacility(actor, selected), facilitySelection: 'selected' };
  }

  /** The actor working at one of its facilities, with that membership's roles and permissions. */
  private atFacility(actor: ActorContext, facility: FacilityAssignment): ActorContext {
    return { ...actor, facility, roles: facility.roles, role: facility.roles[0], permissions: facility.permissions };
  }

  /** An audit row on the caller's transaction; a failure is answered as AuditService.record answers it. */
  private async auditOnTransaction(client: PoolClient, event: AuditEventInput): Promise<void> {
    try {
      await this.audit.recordWithClient(client, event);
    } catch {
      throw new ServiceUnavailableException('Audit persistence is unavailable; request was denied');
    }
  }

  /** The kind of sign-in the calling app holds, when it names itself in X-HID-Client. */
  private namedClientKind(request: HidRequest): 'staff' | 'patient' | undefined {
    const client = request.header('x-hid-client');
    return client === 'staff-web' ? 'staff' : client === 'patient-web' ? 'patient' : undefined;
  }

  private clientMismatch(kind: 'staff' | 'patient', request: HidRequest): DomainProblem {
    return new DomainProblem(403, 'SESSION_CLIENT_MISMATCH',
      `This sign-in belongs to the ${kind} application, not ${request.header('x-hid-client')}`);
  }

  /** The verified access token, or undefined when it is no longer a live staff or patient session. */
  private async liveSession(token: string): Promise<Awaited<ReturnType<TokenService['verify']>> | undefined> {
    try {
      return await this.tokens.verify(token);
    } catch (error) {
      if (error instanceof UnauthorizedException) return undefined;
      throw error;
    }
  }

  private async endSignIn(actor: ActorContext, request: HidRequest): Promise<void> {
    if (actor.kind === 'platform') {
      throw new DomainProblem(403, 'PLATFORM_SESSION_SCOPE_DENIED',
        'A platform administration session cannot be used for this operation');
    }
    // A concurrent sign-out (another tab) may have ended it first: audited once.
    if (await this.auth.revoke(actor.sessionId, actor.subject, this.event(request))) {
      await this.recordSuccess('auth.logout', actor, request);
    }
  }

  private recordSuccess(action: string, actor: ActorContext, request: HidRequest): Promise<void> {
    return this.audit.record(this.successEvent(action, actor, request));
  }

  private successEvent(action: string, actor: ActorContext, request: HidRequest): AuditEventInput {
    return {
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
    };
  }

  /**
   * Sets the session cookies of a sign-in or refresh, and expires the public
   * patient enrollment cookie: once a sign-in exists on this device, its HID
   * comes from the session, not from whichever enrollment the device last made.
   */
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
    clearEnrollmentCookie(response, this.environment.AUTH_COOKIE_SECURE);
  }

  /** Clears the session cookies and the public patient enrollment cookie. */
  private clearCookies(response: Response): void {
    const common = {
      secure: this.environment.AUTH_COOKIE_SECURE,
      sameSite: 'strict' as const,
    };
    response.clearCookie(this.environment.AUTH_COOKIE_NAME, { ...common, httpOnly: true, path: '/' });
    response.clearCookie(`${this.environment.AUTH_COOKIE_NAME}_refresh`, { ...common, httpOnly: true, path: '/api/v1/auth' });
    response.clearCookie(`${this.environment.AUTH_COOKIE_NAME}_csrf`, { ...common, httpOnly: false, path: '/' });
    clearEnrollmentCookie(response, this.environment.AUTH_COOKIE_SECURE);
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
