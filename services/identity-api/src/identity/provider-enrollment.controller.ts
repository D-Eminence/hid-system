import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuthService } from '../auth/auth.service';
import { TurnstileService } from '../auth/turnstile.service';
import { AuditAction, AuditFailuresOnly, Public } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import type { LoginDto } from '../auth/dto/login.dto';
import { ActivateProviderEnrollmentDto, StartProviderEnrollmentDto,
  VerifyProviderEnrollmentDto } from './dto/provider-enrollment.dto';
import { OrganizationProfileCompletionService } from './organization-profile-completion.service';
import { ProviderEnrollmentService } from './provider-enrollment.service';
import type { LoginResult } from '../auth/auth.types';

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
    private readonly auth: AuthService,
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
      this.challengeId(request, input),
      input.code,
      request.correlationId,
    );
    response.cookie(COOKIE_NAME, result.cookie, this.enrollmentCookieOptions());
    return { verified: true as const };
  }

  @Post('activate')
  @HttpCode(200)
  @AuditAction('identity.provider-enrollment.activate')
  async activate(@Body() input: ActivateProviderEnrollmentDto,
    @Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    this.assertAccountless(request);
    const cookie = this.enrollmentCookie(request);
    const activated = await this.completion.activate(cookie, input.password, request.correlationId);
    const result = await this.auth.login(
      { email: activated.email, password: input.password } as LoginDto,
      { correlationId: request.correlationId, sourceIp: request.ip, userAgent: request.header('user-agent') },
      'staff',
    );
    this.setAuthCookies(response, result);
    response.setHeader('x-csrf-token', result.csrfToken);
    response.clearCookie(COOKIE_NAME, {
      secure: this.environment.AUTH_COOKIE_SECURE,
      sameSite: 'strict',
      httpOnly: true,
      path: '/api/v1/identity/provider-enrollments',
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

  private challengeId(request: HidRequest, input: VerifyProviderEnrollmentDto): string {
    // The challenge ID is intentionally supplied in a short-lived signed
    // enrollment context, not accepted from the body. It is the only public
    // identifier needed before the completion cookie exists.
    const header = request.header('x-hid-enrollment-challenge');
    if (!header) {
      throw new DomainProblem(400, 'ENROLLMENT_CHALLENGE_REQUIRED',
        'The enrollment verification challenge is required');
    }
    return header;
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

  private setAuthCookies(response: Response, result: LoginResult): void {
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
}
