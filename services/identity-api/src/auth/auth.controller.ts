import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Logger, Optional, Post, Req, Res, ServiceUnavailableException,
  UnauthorizedException, UseFilters, UseGuards } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Request, Response } from 'express';
import { AuditService, type AuditEventInput } from '../audit/audit.service';
import { AccountOnlyAllowed, AuditFailuresOnly, FacilityOptional, PatientAllowed, Public,
  SignedOutAllowed } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { ActorContext, FacilityAssignment, HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { AuthService } from './auth.service';
import { AuthSessionAuditService } from './auth-session-audit.service';
import { GoogleLinkDto, GoogleLoginDto } from './dto/google-login.dto';
import { LoginDto } from './dto/login.dto';
import { PatientLoginDto } from './dto/patient-login.dto';
import { SelectFacilityDto } from './dto/select-facility.dto';
import { GoogleAuthenticationService } from './google-authentication.service';
import type { FacilitySelectionState, LoginResult } from './auth.types';
import { actorAtFacility, FACILITY_SELECTION_UNAVAILABLE_EVENT, keepsFacilityChoice } from './facility-selection';
import { OPEN_PATIENT_UNAVAILABLE_EVENT, openPatientEnabled } from './open-patient';
import { OpenPatientService, type OpenPatientRestore } from '../open-patient/open-patient.service';
import { clearSessionCookies, setSessionCookies } from './session-cookies';
import { sessionEventFromRequest, sessionSuccessAuditEvent } from './session-success-audit';
import { AccountSuspendedProblem } from './account-suspended';
import { loginPrincipalKey } from './patient-principal';
import { facilityAdmittedOnProduct, isProductGateRefusal, productForOrigin } from './product-gate';
import { sessionActorWithModules } from './facility-modules';
import { SsoRouteGuard } from './sso/sso-route.guard';
import { SsoSessionEndFilter } from './sso/sso-session-end.filter';
import { SsoService } from './sso/sso.service';
import { TokenService, type FacilitySelectionOutcome } from './token.service';
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

/** The actor a session answer reports and, for a sign-in that keeps a facility choice (0129), where its facility comes from. */
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
  /** 0129: off (today's answers), keep or ask. */
  private readonly facilitySelectionMode = this.environment.STAFF_FACILITY_SELECTION_MODE;
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly sessionAudit: AuthSessionAuditService,
    private readonly audit: AuditService,
    private readonly workloadAuth: WorkloadAuthService,
    private readonly turnstile: TurnstileService,
    private readonly google: GoogleAuthenticationService,
    // Single sign-on (ADR-070, 0127): optional so a controller built without
    // it (older test harnesses) is today's controller; its only route is dark.
    @Optional() private readonly sso?: SsoService,
    // SX-8 (0140): OpenPatientService lives in OpenPatientModule, which needs
    // IdentityModule (which imports this module), so it is resolved here when
    // a session read needs it. Optional: a controller built without it
    // reports no open patient.
    @Optional() private readonly moduleRef?: ModuleRef,
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
      return this.sessionResponse(result.actor, result.expiresAt, this.newSignInSelection(result.actor));
    } catch (error) {
      // A refusal raised while issuing the session (an account that is not a
      // patient, deactivated meanwhile) gets the one Google denial, not its
      // internal reason (LOGIN-DETAIL-ORACLE), and is audited as the denial it is.
      // Q88: a staff Google sign-in this site's product does not admit is
      // answered as the password sign-in is, and is not a failed sign-in.
      if (isProductGateRefusal(error)) throw error;
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
      return this.sessionResponse(result.actor, result.expiresAt, this.newSignInSelection(result.actor));
    } catch (error) {
      if (isProductGateRefusal(error)) {
        // Q88: the right password, but this site's product admits none of
        // the account's facilities, or the account has none yet. Not a failed
        // sign-in: it neither counts towards nor clears the lockout, and no
        // login_failed row is written. One audit row records the refusal.
        await this.audit.record({
          correlationId: request.correlationId,
          actorType: 'staff',
          ...(error.accountSubject ? { actorSubject: error.accountSubject } : {}),
          action: 'auth.login.refused',
          resourceType: 'authentication',
          outcome: 'denied',
          sourceIp: request.ip,
          userAgent: request.header('user-agent'),
          details: { reason: error.code.toLowerCase(), ...(productForOrigin(request.header('origin'))
            ? { product: productForOrigin(request.header('origin')) } : {}) },
        });
        throw error;
      }
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
      // 0129: the choice is read once the rotation has committed, through the
      // new session of the same sign-in, under the product the refresh token
      // carries (a refresh from another site has ended with 401 above). A
      // failed read never fails the refresh: it answers 'unavailable'.
      const reported = await this.withFacilitySelection(result.actor);
      await this.recordSuccess('auth.refresh', reported.actor, request);
      this.setCookies(response, result);
      response.setHeader('x-csrf-token', result.csrfToken);
      return this.sessionResponse(reported.actor, result.expiresAt, reported.facilitySelection);
    } catch (error) {
      this.clearCookies(response);
      throw error;
    }
  }

  /**
   * On a single sign-on host, a refused check of a sign-in that has nothing
   * left to renew (ended by back-channel logout, for one) also clears this
   * host's session cookies (SsoSessionEndFilter, ADR-070). Anywhere else, and
   * while single sign-on is off, the answer is today's, byte for byte.
   */
  @Get('session')
  @UseFilters(SsoSessionEndFilter)
  @FacilityOptional()
  @PatientAllowed()
  @AccountOnlyAllowed()
  async session(
    @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const actor = request.actor;
    if (!actor) throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required');
    // 0129: the sign-in's chosen facility, re-checked against the actor's
    // facilities as verify() resolved them under the session's own product; a
    // valid X-Facility-ID still decides. A failed read answers 'unavailable'.
    const reported = await this.withFacilitySelection(actor, request.facilityId);
    // SX-8 (0140): the patient this sign-in had open at the facility reported,
    // checked again; POST /auth/refresh never carries it.
    const openPatient = await this.openPatientFor(reported.actor, request);
    return this.answerSession(request, response, reported.actor, reported.facilitySelection, openPatient);
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
    // Answered exactly as before 0129: the services (EHR, Lab, Pharmacy, OCR,
    // Outreach) act on the X-Facility-ID the website sends, so no facility
    // choice is read or reported here.
    return this.answerSession(request, response, request.actor);
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
  @AccountOnlyAllowed()
  @HttpCode(204)
  async logout(@Req() request: HidRequest, @Res({ passthrough: true }) response: Response): Promise<void> {
    await this.signOut(request, response);
  }

  /** Today's sign-out (`logout`, above), unchanged; product sign-out runs it first. */
  private async signOut(request: HidRequest, response: Response): Promise<void> {
    await this.auth.revoke(request.actor?.sessionId, request.actor?.subject, this.event(request));
    if (request.actor) await this.recordSuccess('auth.logout', request.actor, request);
    this.clearCookies(response);
  }

  /**
   * Product sign-out while single sign-on is on for this host (ADR-070,
   * 0127). With a live session it is admitted exactly as today's sign-out
   * (`logout`, above): the same session check, Origin and CSRF checks for a
   * cookie request, and the same session kinds, an account-only outreach
   * session included. Today's sign-out ends this sign-in and clears its
   * cookies, with the same audit.
   *
   * It also answers a browser whose access token is gone or no longer
   * verifies (SignedOutAllowed), as hid-system#142 did and as the patient
   * website relies on (api.ts endSingleSignOn: a sign-out after a refused
   * refresh must still end the provider's session, or the next person at
   * that browser is handed this sign-in). Such a request must come from an
   * allowed Origin (unless it names a bearer token); a refresh cookie must
   * come with its CSRF token, or nothing ends and nothing is cleared (403
   * CSRF_VALIDATION_FAILED). A sign-in of this client's kind that the
   * refresh cookie could still renew is ended as today's sign-out ends one
   * (TokenService.revokeByRefreshToken, audited `auth.logout`); with none,
   * nothing ends. The cookies are cleared either way.
   *
   * Then, when a sign-in was ended here, every other sign-in of the same
   * account and kind ends too (SsoService.endAccountSignIns), and the answer
   * is the provider's end-session address for the frontend to navigate to.
   * The provider ends its own session there and sends back-channel logout to
   * every product, so signing out of one product signs out of all of them.
   * The address names only the client and the product's root: no token
   * reaches page JavaScript or an address (no `id_token_hint`). While single
   * sign-on is off, or on a host that is not one of its clients, this is no
   * route at all (SsoRouteGuard), once the request has passed the session
   * check every route passes first.
   */
  @Post('sso/logout')
  @UseGuards(SsoRouteGuard)
  @SignedOutAllowed()
  @FacilityOptional()
  @PatientAllowed()
  @AccountOnlyAllowed()
  @HttpCode(200)
  async ssoLogout(@Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response): Promise<{ endSessionUrl: string }> {
    const sso = this.sso;
    const client = sso?.clientFor(request);
    if (!sso || !client) throw new ServiceUnavailableException('Single sign-on is unavailable');
    const actor = request.actor;
    let signedOut: { accountId: string; subject: string; kind: 'staff' | 'patient' } | undefined;
    if (actor) {
      await this.signOut(request, response);
      signedOut = { accountId: actor.accountId, subject: actor.subject, kind: actor.kind === 'patient' ? 'patient' : 'staff' };
    } else {
      signedOut = await this.signOutByRefreshCookie(request, client.kind);
      this.clearCookies(response);
    }
    if (signedOut) await sso.endAccountSignIns(client, signedOut, this.event(request));
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    return { endSessionUrl: await sso.endSessionUrl(client) };
  }

  /**
   * Product sign-out of a browser with no live access token (ssoLogout,
   * above): Origin first (unless the request names a bearer token), then the
   * refresh cookie with its CSRF token, as POST /auth/refresh checks them.
   * Ends the `kind` sign-in that cookie could still renew and answers it, or
   * answers nothing when there is none.
   */
  private async signOutByRefreshCookie(request: HidRequest, kind: 'staff' | 'patient'):
    Promise<{ accountId: string; subject: string; kind: 'staff' | 'patient' } | undefined> {
    if (!request.header('authorization')?.startsWith('Bearer ')) this.assertAllowedOrigin(request);
    const cookies = this.cookies(request);
    const refreshToken = cookies[`${this.environment.AUTH_COOKIE_NAME}_refresh`];
    if (!refreshToken) return undefined;
    if (!this.tokens.verifyRefreshCsrf(refreshToken, cookies[`${this.environment.AUTH_COOKIE_NAME}_csrf`],
      request.header('x-csrf-token'))) {
      throw new DomainProblem(403, 'CSRF_VALIDATION_FAILED', 'CSRF validation failed');
    }
    const ended = await this.tokens.revokeByRefreshToken(refreshToken, kind, this.event(request));
    if (!ended) return undefined;
    await this.audit.record({
      correlationId: request.correlationId,
      actorType: kind,
      actorSubject: ended.subject,
      actorAccountId: ended.accountId,
      action: 'auth.logout',
      resourceType: 'session',
      resourceId: ended.sessionId,
      outcome: 'success',
      sourceIp: request.ip,
      userAgent: request.header('user-agent'),
    });
    return { accountId: ended.accountId, subject: ended.subject, kind };
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
    // Q88-1: the session's facilities already fit the product it was issued
    // under; a facility choice also keeps only those that fit the product of
    // the site it comes from (an access token issued before the gate).
    const product = productForOrigin(request.header('origin'));
    const facilities = product
      ? actor.facilities.filter((candidate) => facilityAdmittedOnProduct(candidate, product))
      : actor.facilities;
    const facility = facilities.find((candidate) => candidate.id === input.facilityId);
    if (!facility) throw new DomainProblem(403, 'FACILITY_ACCESS_DENIED', 'The actor is not active at this facility');
    const selectedActor: ActorContext = {
      ...actor,
      facilities,
      facilityIds: facilities.map((candidate) => candidate.id),
      facility,
      roles: facility.roles,
      role: facility.roles[0],
      permissions: facility.permissions,
    };
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
    if (this.facilitySelectionMode === 'off' || !keepsFacilityChoice(actor)) {
      // Today's answer, nothing stored: the setting is off, or there is no
      // Identity sign-in to keep the choice for (an OIDC bearer caller).
      // SX-8 (0140): the move still clears an open patient kept at another
      // facility, with the audit row, in one transaction.
      if (openPatientEnabled() && keepsFacilityChoice(actor)) {
        await this.clearOpenPatientElsewhere(actor, facility, selectionAudit, request);
      } else {
        await this.audit.record(selectionAudit);
      }
      if (csrfToken) response.setHeader('x-csrf-token', csrfToken);
      return this.sessionResponse(selectedActor);
    }
    // 0129: stored for this sign-in with its audit row, in one transaction.
    const outcome = await this.storeFacilityChoice(actor, facility, selectionAudit, request);
    if (outcome === 'session_ended') {
      throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required');
    }
    if (outcome === 'refused') {
      throw new DomainProblem(403, 'FACILITY_ACCESS_DENIED', 'The actor is not active at this facility');
    }
    if (csrfToken) response.setHeader('x-csrf-token', csrfToken);
    return this.sessionResponse(selectedActor, undefined, 'selected');
  }

  /**
   * SX-1 (Akos N-2b, N-2e, P1-5): every facility of the answer, and the
   * selected one, also carries `modules`, the product areas its own
   * permissions show (facility-modules.ts, a pure function: no read, no
   * write). Every other field, roles[0] included, is unchanged; a patient or
   * account-only session has no facility, so its answer is unchanged.
   * `facilitySelection` (0129) is added only when given.
   */
  private sessionResponse(actor: ActorContext, expiresAt?: Date, facilitySelection?: FacilitySelectionState,
    openPatient?: OpenPatientRestore) {
    return {
      actor: sessionActorWithModules(actor),
      ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
      ...(facilitySelection ? { facilitySelection } : {}),
      ...(openPatient ? { openPatient } : {}),
    };
  }

  /**
   * The answer of GET /auth/session and of the service-session routes: the
   * auth.session.read audit row at the facility reported, the CSRF token
   * echoed, and the actor (with `facilitySelection` only when given).
   */
  private async answerSession(request: HidRequest, response: Response, actor: ActorContext | undefined,
    facilitySelection?: FacilitySelectionState, openPatient?: OpenPatientRestore) {
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
    return this.sessionResponse(actor, undefined, facilitySelection, openPatient);
  }

  /**
   * SX-8 (0140): GET /auth/session's `openPatient`, only for a staff
   * sign-in reported at a facility while STAFF_OPEN_PATIENT_ENABLED is on.
   * Never throws: anything that fails answers 'unavailable', so the session
   * read still answers 200.
   */
  private async openPatientFor(actor: ActorContext, request: HidRequest): Promise<OpenPatientRestore | undefined> {
    if (!openPatientEnabled() || !this.moduleRef) return undefined;
    try {
      const openPatients = this.moduleRef.get(OpenPatientService, { strict: false });
      if (!openPatients.reportsFor(actor)) return undefined;
      return await openPatients.restore(actor, {
        correlationId: request.correlationId, sourceIp: request.ip, userAgent: request.header('user-agent'),
      });
    } catch {
      this.logger.warn({ event: OPEN_PATIENT_UNAVAILABLE_EVENT, operation: 'read' });
      return keepsFacilityChoice(actor) && actor.facility ? { state: 'unavailable' } : undefined;
    }
  }

  /**
   * SX-8 (0140), with 0129's setting off: the move's audit row and the clear
   * of an open patient kept at another facility, in one transaction
   * (TokenService). A failure is 503 DEPENDENCY_UNAVAILABLE with nothing
   * cleared or audited, logged once with no identifiers.
   */
  private async clearOpenPatientElsewhere(actor: ActorContext & { sessionId: string }, facility: FacilityAssignment,
    selectionAudit: AuditEventInput, request: HidRequest): Promise<void> {
    try {
      await this.tokens.clearOpenPatientElsewhere({
        sessionId: actor.sessionId, accountId: actor.accountId, facilityId: facility.id,
      }, this.event(request), (client) => this.audit.recordWithClient(client, selectionAudit));
    } catch {
      this.logger.warn({ event: OPEN_PATIENT_UNAVAILABLE_EVENT, operation: 'clear' });
      throw new DomainProblem(503, 'DEPENDENCY_UNAVAILABLE', 'The facility choice could not be saved; try again');
    }
  }

  /**
   * A new sign-in's answer (password or Google): 'default' in ask mode for a
   * staff sign-in with a facility, which has made no choice yet; nothing in
   * keep mode (today's answer) or for any other sign-in.
   */
  private newSignInSelection(actor: ActorContext): FacilitySelectionState | undefined {
    return this.facilitySelectionMode === 'ask' && keepsFacilityChoice(actor) ? 'default' : undefined;
  }

  /**
   * The actor at the facility its sign-in chose (0129), matched by facility id
   * against the actor's facilities as resolved on this request (under the
   * session's own product, never the request's Origin), taking the first
   * match, as SecurityGuard binds X-Facility-ID. `boundFacilityId` is the
   * facility a valid X-Facility-ID bound, which keeps the actor there. A
   * stored facility no longer among them is 'reselect' at the default, and
   * the row is kept. Nothing stored is today's answer in keep mode and
   * 'default' in ask mode. A failed read is 'unavailable' at the default,
   * never "no choice", and is logged once with no identifiers. Never throws.
   */
  private async withFacilitySelection(actor: ActorContext, boundFacilityId?: string): Promise<SessionReport> {
    if (this.facilitySelectionMode === 'off' || !keepsFacilityChoice(actor)) return { actor };
    let selectedId: string | undefined;
    try {
      selectedId = await this.tokens.selectedFacilityId(actor.sessionId, actor.accountId);
    } catch {
      this.logger.warn({ event: FACILITY_SELECTION_UNAVAILABLE_EVENT, operation: 'read' });
      return { actor, facilitySelection: 'unavailable' };
    }
    if (!selectedId) return this.facilitySelectionMode === 'ask' ? { actor, facilitySelection: 'default' } : { actor };
    const selected = actor.facilities.find((candidate) => candidate.id === selectedId);
    if (!selected) return { actor, facilitySelection: 'reselect' };
    return { actor: boundFacilityId ? actor : actorAtFacility(actor, selected), facilitySelection: 'selected' };
  }

  /**
   * Stores the choice with its audit row on one transaction (TokenService).
   * Any failure other than the store's own answers (the guard's refusal, a
   * sign-in that ended) is 503 DEPENDENCY_UNAVAILABLE with nothing stored,
   * whether the store or the audit row failed, and is logged once with no
   * identifiers.
   */
  private async storeFacilityChoice(actor: ActorContext & { sessionId: string }, facility: FacilityAssignment,
    selectionAudit: AuditEventInput, request: HidRequest): Promise<FacilitySelectionOutcome> {
    try {
      return await this.tokens.recordFacilitySelection({
        sessionId: actor.sessionId, accountId: actor.accountId, facilityId: facility.id, membershipId: facility.membershipId,
      }, this.event(request), (client) => this.audit.recordWithClient(client, selectionAudit));
    } catch {
      this.logger.warn({ event: FACILITY_SELECTION_UNAVAILABLE_EVENT, operation: 'store' });
      throw new DomainProblem(503, 'DEPENDENCY_UNAVAILABLE', 'The facility choice could not be saved; try again');
    }
  }

  private recordSuccess(action: string, actor: ActorContext, request: HidRequest): Promise<void> {
    return this.audit.record(sessionSuccessAuditEvent(action, actor, request));
  }

  private setCookies(response: Response, result: LoginResult): void {
    setSessionCookies(response, result, this.environment);
  }

  /** Clears the session cookies (session-cookies.ts). */
  private clearCookies(response: Response): void {
    clearSessionCookies(response, this.environment);
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
