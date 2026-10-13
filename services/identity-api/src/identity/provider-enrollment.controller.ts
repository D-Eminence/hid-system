import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MfaService } from '../auth/mfa/mfa.service';
import { TurnstileService } from '../auth/turnstile.service';
import { AuditAction, AuditFailuresOnly, Public } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { ActivateProviderEnrollmentDto, StartProviderEnrollmentDto,
  VerifyProviderEnrollmentDto } from './dto/provider-enrollment.dto';
import { clearEnrollmentCookie } from './enrollment-cookie';
import { OrganizationProfileCompletionService } from './organization-profile-completion.service';
import { ProviderEnrollmentService } from './provider-enrollment.service';

const COOKIE_NAME = 'hid_provider_enrollment';

@Controller('identity/provider-enrollments')
@Public()
@AuditFailuresOnly()
export class ProviderEnrollmentController {
  private readonly environment = getEnvironment();
  private readonly allowedOrigins = new Set(
    this.environment.CORS_ORIGINS.split(',').map((origin) => origin.trim()));

  constructor(
    private readonly enrollments: ProviderEnrollmentService,
    private readonly completion: OrganizationProfileCompletionService,
    private readonly turnstile: TurnstileService,
    private readonly mfa: MfaService,
  ) {}

  @Post()
  @HttpCode(200)
  @AuditAction('identity.provider-enrollment.start')
  async start(@Body() input: StartProviderEnrollmentDto, @Req() request: HidRequest) {
    this.assertOrigin(request);
    this.assertAccountless(request);
    await this.turnstile.verify({
      token: input.turnstileToken,
      action: input.turnstileAction,
      origin: request.header('origin'),
      remoteIp: request.ip,
    });
    return this.enrollments.start(input, request);
  }

  @Post('verify')
  @HttpCode(200)
  @AuditAction('identity.provider-enrollment.verify')
  async verify(@Body() input: VerifyProviderEnrollmentDto,
    @Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    this.assertAccountless(request);
    const result = await this.completion.verify(
      input.challengeId,
      input.code,
      request.correlationId,
    );
    response.cookie(COOKIE_NAME, result.cookie, this.enrollmentCookieOptions());
    return { verified: true as const };
  }

  /**
   * Sets the administrator's password and opens the first staff sign-in
   * (MFA-1, 0088): no session is issued here. The response carries the staff
   * MFA challenge cookie of an enrolment whose fresh proof is this activation
   * (the administrator's email was verified for this enrollment), so the
   * client continues with POST /auth/mfa/enroll/start (no email code) and
   * /auth/mfa/enroll/activate, which issues the session.
   */
  @Post('activate')
  @HttpCode(200)
  @AuditAction('identity.provider-enrollment.activate')
  async activate(@Body() input: ActivateProviderEnrollmentDto,
    @Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    this.assertAccountless(request);
    const cookie = this.enrollmentCookie(request);
    const activated = await this.completion.activate(cookie, input.password, request.correlationId);
    const challenge = await this.mfa.beginLogin(activated.email, input.password,
      { correlationId: request.correlationId, sourceIp: request.ip, userAgent: request.header('user-agent') },
      'staff', { activationProof: true });
    response.cookie(`${this.environment.AUTH_COOKIE_NAME}_mfa`, challenge.token, {
      secure: this.environment.AUTH_COOKIE_SECURE,
      sameSite: 'strict',
      httpOnly: true,
      path: '/api/v1/auth/mfa',
      expires: challenge.expiresAt,
    });
    response.setHeader('Cache-Control', 'no-store');
    response.clearCookie(COOKIE_NAME, {
      secure: this.environment.AUTH_COOKIE_SECURE,
      sameSite: 'strict',
      httpOnly: true,
      path: '/api/v1/identity/provider-enrollments',
    });
    // The device's public patient enrollment cookie is expired, as at any sign-in.
    clearEnrollmentCookie(response, this.environment.AUTH_COOKIE_SECURE);
    return {
      activated: true as const,
      organizationId: activated.organizationId,
      facilityId: activated.facilityId,
      accountId: activated.accountId,
      status: challenge.purpose === 'verify' ? 'mfa_required' as const : 'mfa_enrollment_required' as const,
      expiresAt: challenge.expiresAt.toISOString(),
    };
  }

  private enrollmentCookie(request: HidRequest): string | undefined {
    const values = (request.header('cookie') ?? '').split(';').map((part) => part.trim())
      .filter((part) => part.startsWith(`${COOKIE_NAME}=`));
    return values.length === 1 ? values[0]?.slice(COOKIE_NAME.length + 1) : undefined;
  }

  private assertAccountless(request: HidRequest): void {
    const authCookie = (request.header('cookie') ?? '').split(';').some((part) =>
      part.trim().startsWith(`${this.environment.AUTH_COOKIE_NAME}=`)
      || part.trim().startsWith(`${this.environment.AUTH_COOKIE_NAME}_refresh=`));
    if (authCookie || request.header('authorization')) {
      throw new DomainProblem(409, 'PROVIDER_ENROLLMENT_REQUIRES_SIGN_OUT',
        'Sign out before starting or continuing provider enrollment');
    }
  }

  private assertOrigin(request: HidRequest): void {
    const origin = request.header('origin');
    if (!origin || !this.allowedOrigins.has(origin)) {
      throw new DomainProblem(403, 'ORIGIN_DENIED', 'Request origin is not allowed');
    }
  }

  private enrollmentCookieOptions() {
    return {
      httpOnly: true,
      sameSite: 'strict' as const,
      secure: this.environment.AUTH_COOKIE_SECURE,
      path: '/api/v1/identity/provider-enrollments',
      maxAge: 60 * 60 * 1000,
    };
  }
}
