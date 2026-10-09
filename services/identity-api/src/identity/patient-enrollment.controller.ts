import { Body, Controller, Get, Headers, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { GoogleAuthenticationService } from '../auth/google-authentication.service';
import { TurnstileService } from '../auth/turnstile.service';
import { AuditAction, Public } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { ActivatePatientEnrollmentDto, PatientEnrollmentContactDto,
  StartPatientEnrollmentDto, VerifyPatientEnrollmentContactDto } from './dto/patient-enrollment.dto';
import { PatientEnrollmentService } from './patient-enrollment.service';

const COOKIE_NAME = 'hid_enrollment';

@Controller('identity/patient-enrollments')
@Public()
export class PatientEnrollmentController {
  private readonly environment = getEnvironment();
  private readonly allowedOrigins = new Set(
    this.environment.CORS_ORIGINS.split(',').map((origin) => origin.trim()));

  constructor(private readonly enrollments: PatientEnrollmentService,
    private readonly turnstile: TurnstileService,
    private readonly google: GoogleAuthenticationService) {}

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
    response.cookie(COOKIE_NAME, result.cookie, this.cookieOptions());
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
    if (googleCookie) response.clearCookie(this.google.onboardingCookieName, {
      secure: this.environment.AUTH_COOKIE_SECURE,
      sameSite: 'strict', httpOnly: true, path: '/api/v1',
    });
    return result;
  }

  private assertOrigin(request: HidRequest) {
    const origin = request.header('origin');
    if (!origin || !this.allowedOrigins.has(origin)) {
      throw new DomainProblem(403, 'ORIGIN_DENIED', 'Request origin is not allowed');
    }
  }

  private cookie(request: HidRequest): string | undefined {
    return this.namedCookie(request, COOKIE_NAME);
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

  private cookieOptions() {
    return { httpOnly: true, sameSite: 'strict' as const,
      secure: this.environment.AUTH_COOKIE_SECURE,
      path: '/api/v1/identity/patient-enrollments', maxAge: 24 * 60 * 60 * 1000 };
  }
}
