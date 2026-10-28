import { Body, Controller, Get, Headers, HttpCode, HttpException, Logger, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import type { LoginResult } from '../auth/auth.types';
import type { PatientLoginDto } from '../auth/dto/patient-login.dto';
import { GoogleAuthenticationService } from '../auth/google-authentication.service';
import { setSessionCookies } from '../auth/session-cookies';
import { sessionEventFromRequest, sessionSuccessAuditEvent } from '../auth/session-success-audit';
import { TurnstileService } from '../auth/turnstile.service';
import { AuditAction, Public } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { ActivatePatientEnrollmentDto, PatientEnrollmentContactDto, SignupPatientEnrollmentDto,
  StartPatientEnrollmentDto, VerifyPatientEnrollmentContactDto } from './dto/patient-enrollment.dto';
import { ENROLLMENT_COOKIE_NAME, enrollmentCookieOptions } from './enrollment-cookie';
import { PatientEnrollmentService } from './patient-enrollment.service';

@Controller('identity/patient-enrollments')
@Public()
export class PatientEnrollmentController {
  private readonly environment = getEnvironment();
  private readonly allowedOrigins = new Set(
    this.environment.CORS_ORIGINS.split(',').map((origin) => origin.trim()));

  private readonly logger = new Logger(PatientEnrollmentController.name);

  constructor(private readonly enrollments: PatientEnrollmentService,
    private readonly turnstile: TurnstileService,
    private readonly google: GoogleAuthenticationService,
    private readonly auth: AuthService,
    private readonly audit: AuditService) {}

  @Get('availability')
  availability(@Req() request: HidRequest) {
    return this.enrollments.availability(request.correlationId);
  }

  @Post()
  @HttpCode(200)
  @AuditAction('identity.patient-enrollment.start')
  async start(@Body() input: StartPatientEnrollmentDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    await this.turnstile.verify({ token: input.turnstileToken,
      action: input.turnstileAction, origin: request.header('origin'), remoteIp: request.ip });
    const googleCookie = this.namedCookie(request, this.google.onboardingCookieName);
    this.assertAccountlessEnrollment(request, googleCookie);
    if (googleCookie) await this.google.onboardingStatus(googleCookie);
    const result = await this.enrollments.start(input.nin, idempotencyKey ?? '', request.ip,
      request.correlationId, googleCookie);
    response.cookie(ENROLLMENT_COOKIE_NAME, result.cookie,
      enrollmentCookieOptions(this.environment.AUTH_COOKIE_SECURE));
    return result.progress;
  }

  /**
   * Sign-up without a NIN (owner decision of 2026-10-27, as hid-1.0): the
   * declared profile, then a code to the email at once. Same origin,
   * Turnstile, accountless and Idempotency-Key handling as the NIN start.
   */
  @Post('signup')
  @HttpCode(200)
  @AuditAction('identity.patient-enrollment.signup')
  async signup(@Body() input: SignupPatientEnrollmentDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    await this.turnstile.verify({ token: input.turnstileToken,
      action: input.turnstileAction, origin: request.header('origin'), remoteIp: request.ip });
    this.assertAccountlessEnrollment(request,
      this.namedCookie(request, this.google.onboardingCookieName));
    const result = await this.enrollments.signup({
      firstName: input.firstName, lastName: input.lastName, email: input.email, phone: input.phone,
      gender: input.gender, hospitalCurrentlyUsing: input.hospitalCurrentlyUsing,
    }, idempotencyKey ?? '', request.ip, request.correlationId, (cookie) => response.cookie(
      ENROLLMENT_COOKIE_NAME, cookie, enrollmentCookieOptions(this.environment.AUTH_COOKIE_SECURE)));
    return result.progress;
  }

  @Get('current')
  @AuditAction('identity.patient-enrollment.current')
  current(@Req() request: HidRequest) {
    this.assertAccountlessEnrollment(request,
      this.namedCookie(request, this.google.onboardingCookieName));
    return this.enrollments.current(this.cookie(request), request.correlationId);
  }

  @Post('google')
  @HttpCode(200)
  @AuditAction('identity.patient-enrollment.google-bind')
  async bindGoogle(@Req() request: HidRequest) {
    this.assertOrigin(request);
    const googleCookie = this.namedCookie(request, this.google.onboardingCookieName);
    this.assertAccountlessEnrollment(request, googleCookie);
    await this.google.onboardingStatus(googleCookie);
    return this.enrollments.bindGoogle(this.cookie(request), googleCookie, request.correlationId);
  }

  @Post('contact')
  @HttpCode(200)
  @AuditAction('identity.patient-enrollment.contact')
  contact(@Body() input: PatientEnrollmentContactDto, @Req() request: HidRequest) {
    this.assertOrigin(request);
    this.assertAccountlessEnrollment(request,
      this.namedCookie(request, this.google.onboardingCookieName));
    return this.enrollments.startContact(this.cookie(request), input.channel,
      input.contact, request.ip, request.correlationId);
  }

  @Post('contact/verify')
  @HttpCode(200)
  @AuditAction('identity.patient-enrollment.contact-verify')
  verifyContact(@Body() input: VerifyPatientEnrollmentContactDto,
    @Req() request: HidRequest) {
    this.assertOrigin(request);
    this.assertAccountlessEnrollment(request,
      this.namedCookie(request, this.google.onboardingCookieName));
    return this.enrollments.verifyContact(this.cookie(request), input.challengeId,
      input.code, request.correlationId);
  }

  /**
   * Sets the password and activates the Health ID, for the sign-up without a
   * NIN and the NIN route alike, then signs the new patient in (owner
   * decision of 2026-10-28): a first activation signs in exactly as POST
   * /auth/patient/login does with the new Health ID and this password (the
   * same session rules, the three session cookies, the x-csrf-token header,
   * the 'auth.login' audit and the session's device facts) and answers
   * `signedIn: true`. A replay (the enrollment was already active) verified
   * no password, so it signs nobody in: only the browser holding the
   * enrollment cookie, and only its first activation, gets a session. If the
   * session cannot be created the activation still succeeds, with
   * `signedIn: false`, and the patient signs in as before.
   */
  @Post('activate')
  @HttpCode(200)
  @AuditAction('identity.patient-enrollment.activate')
  async activate(@Body() input: ActivatePatientEnrollmentDto,
    @Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    const googleCookie = this.namedCookie(request, this.google.onboardingCookieName);
    this.assertAccountlessEnrollment(request, googleCookie);
    const result = await this.enrollments.activate(this.cookie(request), input.password,
      request.correlationId, googleCookie);
    // The enrollment cookie is kept, so a reload or a lost response can show
    // the HID again; it does so for 15 minutes after activation only
    // (PatientEnrollmentService).
    if (googleCookie) response.clearCookie(this.google.onboardingCookieName, {
      secure: this.environment.AUTH_COOKIE_SECURE,
      sameSite: 'strict', httpOnly: true, path: '/api/v1',
    });
    const signedIn = result.replayed ? false
      : await this.signIn(result.hidCode, input.password, request, response);
    return { stage: result.stage, hidCode: result.hidCode, signedIn };
  }

  /**
   * POST /auth/patient/login's sign-in, after activation: AuthService.login
   * as a patient with the Health ID and the password just set, the 'auth.login'
   * audit, then the cookies and header. Any failure leaves no cookie and
   * answers false; it is logged with the correlation id and a status only.
   */
  private async signIn(hidCode: string, password: string, request: HidRequest,
    response: Response): Promise<boolean> {
    const event = sessionEventFromRequest(request);
    let session: LoginResult | undefined;
    try {
      session = await this.auth.login({ email: hidCode, password } as PatientLoginDto, event, 'patient');
      await this.audit.record(sessionSuccessAuditEvent('auth.login', session.actor, request));
      setSessionCookies(response, session, this.environment);
      response.setHeader('x-csrf-token', session.csrfToken);
      return true;
    } catch (error) {
      // A session created but not handed over (its audit failed) is revoked,
      // best-effort: no browser holds it.
      if (session) await this.auth.revoke(session.actor.sessionId, session.actor.subject, event)
        .catch(() => undefined);
      const status = error instanceof HttpException ? String(error.getStatus()) : 'error';
      this.logger.warn(`Health ID activated, but the sign-in after it was not completed; the patient signs in `
        + `instead (correlation ${request.correlationId}, status ${status})`);
      return false;
    }
  }

  private assertOrigin(request: HidRequest) {
    const origin = request.header('origin');
    if (!origin || !this.allowedOrigins.has(origin)) {
      throw new DomainProblem(403, 'ORIGIN_DENIED', 'Request origin is not allowed');
    }
  }

  private cookie(request: HidRequest): string | undefined {
    return this.namedCookie(request, ENROLLMENT_COOKIE_NAME);
  }

  private namedCookie(request: HidRequest, name: string): string | undefined {
    const values = this.namedCookies(request, name);
    return values.length === 1 ? values[0]?.slice(name.length + 1) : undefined;
  }

  private namedCookies(request: HidRequest, name: string): string[] {
    return (request.header('cookie') ?? '').split(';').map((part) => part.trim())
      .filter((part) => part.startsWith(`${name}=`));
  }

  private hasCookie(request: HidRequest, name: string): boolean {
    // Presence, not identity: `namedCookie` deliberately yields undefined for an
    // ambiguous duplicate so a bearer token is never guessed. Reusing it here
    // would invert that fail-closed rule into a fail-open one, letting a
    // signed-in patient reach public enrollment by repeating the cookie.
    return this.namedCookies(request, name).length > 0;
  }

  private assertAccountlessEnrollment(request: HidRequest,
    googleCookie: string | undefined): void {
    if (this.hasCookie(request, this.environment.AUTH_COOKIE_NAME)
      || this.hasCookie(request, `${this.environment.AUTH_COOKIE_NAME}_refresh`)
      || request.header('authorization')) {
      throw new DomainProblem(409,
        googleCookie ? 'GOOGLE_ONBOARDING_REQUIRES_SIGN_OUT' : 'PATIENT_ENROLLMENT_REQUIRES_SIGN_OUT',
        'Sign out before starting or continuing a new Health ID enrollment');
    }
  }
}
