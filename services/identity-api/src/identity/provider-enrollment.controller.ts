import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuthService } from '../auth/auth.service';
import type { LoginDto } from '../auth/dto/login.dto';
import { setSessionCookies } from '../auth/session-cookies';
import { TurnstileService } from '../auth/turnstile.service';
import { AuditAction, AuditFailuresOnly, Public } from '../common/decorators';
import { assertAccountless, assertAllowedOrigin, singleCookie } from '../common/public-flow-guards';
import type { HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { ActivateProviderEnrollmentDto, StartProviderEnrollmentDto,
  VerifyProviderEnrollmentDto } from './dto/provider-enrollment.dto';
import { OrganizationProfileCompletionService } from './organization-profile-completion.service';
import { type ProviderEnrollmentAvailability, ProviderEnrollmentService } from './provider-enrollment.service';

const COOKIE_NAME = 'hid_provider_enrollment';
const COOKIE_PATH = '/api/v1/identity/provider-enrollments';

/**
 * Facility self sign-up ("Setup Your Facility", P4): a hospital, laboratory or
 * pharmacy registers itself from its CAC number and an administrator email,
 * confirms the email with a code and finishes by setting a password, which
 * signs the administrator in (main before #71: no authenticator, owner
 * decision 2). Every route is closed (423 PROVIDER_ENROLLMENT_UNAVAILABLE)
 * while the platform control provider_self_service_enabled is off.
 *
 * Request validation runs first (the global ValidationPipe), then each route
 * checks Origin, that the browser holds no HID session, and the gate.
 */
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
    private readonly auth: AuthService,
  ) {}

  /**
   * Whether self sign-up is open: { open: true }, or { open: false, reason }
   * with reason 'closed' (switched off or not configured) or 'unavailable'
   * (the answer could not be determined; try again shortly). Never an error.
   */
  @Get('availability')
  async availability(): Promise<ProviderEnrollmentAvailability> {
    try {
      const answer = await this.enrollments.availability();
      if (answer.open === true) return { open: true };
      return { open: false, reason: answer.reason === 'closed' ? 'closed' : 'unavailable' };
    } catch {
      return { open: false, reason: 'unavailable' };
    }
  }

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
    // The service checks the gate first, after Turnstile and before any write.
    return this.enrollments.start(input, request);
  }

  @Post('verify')
  @HttpCode(200)
  @AuditAction('identity.provider-enrollment.verify')
  async verify(@Body() input: VerifyProviderEnrollmentDto,
    @Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    this.assertAccountless(request);
    await this.enrollments.assertSelfServiceOpen();
    const result = await this.completion.verify(
      input.challengeId,
      input.code,
      request.correlationId,
    );
    response.cookie(COOKIE_NAME, result.cookie, this.enrollmentCookieOptions());
    return { verified: true as const };
  }

  /**
   * Sets the administrator's password, creates the organization, facility,
   * account and membership, and signs the administrator in with that password
   * as a staff sign-in does: the three session cookies and the x-csrf-token
   * header. The public patient enrollment cookie (hid_enrollment) is left as
   * it is: Novu never expires it at sign-in.
   */
  @Post('activate')
  @HttpCode(200)
  @AuditAction('identity.provider-enrollment.activate')
  async activate(@Body() input: ActivateProviderEnrollmentDto,
    @Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    this.assertAccountless(request);
    await this.enrollments.assertSelfServiceOpen();
    const cookie = singleCookie(request, COOKIE_NAME);
    const activated = await this.completion.activate(cookie, input.password, request.correlationId);
    const result = await this.auth.login(
      { email: activated.email, password: input.password } as LoginDto,
      { correlationId: request.correlationId, sourceIp: request.ip, userAgent: request.header('user-agent') },
      'staff',
    );
    setSessionCookies(response, result, this.environment);
    response.setHeader('x-csrf-token', result.csrfToken);
    response.clearCookie(COOKIE_NAME, {
      secure: this.environment.AUTH_COOKIE_SECURE,
      sameSite: 'strict',
      httpOnly: true,
      path: COOKIE_PATH,
    });
    return {
      activated: true as const,
      organizationId: activated.organizationId,
      facilityId: activated.facilityId,
      accountId: activated.accountId,
      actor: result.actor,
      expiresAt: result.expiresAt.toISOString(),
    };
  }

  private assertAccountless(request: HidRequest): void {
    assertAccountless(request, this.environment.AUTH_COOKIE_NAME, { code: 'PROVIDER_ENROLLMENT_REQUIRES_SIGN_OUT',
      detail: 'Sign out before starting or continuing provider enrollment' });
  }

  private assertOrigin(request: HidRequest): void {
    assertAllowedOrigin(request, this.allowedOrigins);
  }

  private enrollmentCookieOptions() {
    return {
      httpOnly: true,
      sameSite: 'strict' as const,
      secure: this.environment.AUTH_COOKIE_SECURE,
      path: COOKIE_PATH,
      maxAge: 60 * 60 * 1000,
    };
  }
}
