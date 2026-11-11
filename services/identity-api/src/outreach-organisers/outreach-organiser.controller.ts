import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuthService } from '../auth/auth.service';
import type { LoginDto } from '../auth/dto/login.dto';
import { setSessionCookies } from '../auth/session-cookies';
import { TurnstileService } from '../auth/turnstile.service';
import { AuditAction, AuditFailuresOnly, FacilityOptional, Public } from '../common/decorators';
import { assertAccountless, assertAllowedOrigin, singleCookie } from '../common/public-flow-guards';
import type { HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { accountOnlyContext } from '../identity/staff-invitations-signed-in.controller';
import { ActivateOutreachOrganiserDto, StartOutreachGroupForAccountDto, StartOutreachOrganiserSignupDto,
  VerifyOutreachOrganiserEmailDto } from './dto/outreach-organiser.dto';
import { OUTREACH_SIGNUP_SESSION_SECONDS, OutreachOrganiserService } from './outreach-organiser.service';

export const OUTREACH_SIGNUP_COOKIE = 'hid_outreach_signup';
export const OUTREACH_SIGNUP_COOKIE_PATH = '/api/v1/identity/outreach-organisers';

/**
 * Open sign-up on outreach. (plan PR-3): start (details and Turnstile, then
 * the emailed code), verify-email and activate (terms and password, then the
 * organiser is signed in). Every route is closed with 423
 * OUTREACH_ORGANISER_SIGNUP_UNAVAILABLE while the control
 * outreach_organiser_signup_enabled is off.
 *
 * Order: the global ValidationPipe, then Origin, the signed-in check, Turnstile
 * (start only), the gate, then the command (provider-enrollment's order).
 */
@Controller('identity/outreach-organisers')
@Public()
@AuditFailuresOnly()
export class OutreachOrganiserController {
  private readonly environment = getEnvironment();
  private readonly allowedOrigins = new Set(this.environment.CORS_ORIGINS.split(',').map((origin) => origin.trim()));

  constructor(
    private readonly organisers: OutreachOrganiserService,
    private readonly turnstile: TurnstileService,
    private readonly auth: AuthService,
  ) {}

  /** { open, termsVersion }. Never an error: a closed or unknown answer reads { open: false }. */
  @Get('availability')
  availability() {
    return this.organisers.availability();
  }

  @Post()
  @HttpCode(200)
  @AuditAction('identity.outreach-organiser.start')
  async start(@Body() input: StartOutreachOrganiserSignupDto, @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    this.assertAccountless(request);
    await this.turnstile.verify({
      token: input.turnstileToken,
      action: input.turnstileAction,
      origin: request.header('origin'),
      remoteIp: request.ip,
    });
    const started = await this.organisers.start(input, request.ip, request.correlationId);
    response.cookie(OUTREACH_SIGNUP_COOKIE, started.cookie, this.cookieOptions());
    return started.body;
  }

  @Post('verify-email')
  @HttpCode(200)
  @AuditAction('identity.outreach-organiser.verify-email')
  verifyEmail(@Body() input: VerifyOutreachOrganiserEmailDto, @Req() request: HidRequest) {
    this.assertOrigin(request);
    this.assertAccountless(request);
    return this.organisers.verify(singleCookie(request, OUTREACH_SIGNUP_COOKIE), input.challengeId, input.code,
      request.correlationId);
  }

  /**
   * Creates the organiser's account and Outreach organisation and signs them
   * in as a staff sign-in does: the session cookies and the x-csrf-token
   * header. The new organisation is "Unverified" until Health ID checks it
   * once; until then campaigns can be set up and practised but not made live.
   */
  @Post('activate')
  @HttpCode(200)
  @AuditAction('identity.outreach-organiser.activate')
  async activate(@Body() input: ActivateOutreachOrganiserDto, @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    this.assertAccountless(request);
    const activated = await this.organisers.activate(singleCookie(request, OUTREACH_SIGNUP_COOKIE), input,
      request.correlationId);
    const result = await this.auth.login(
      { email: activated.email, password: input.password } as LoginDto,
      { correlationId: request.correlationId, sourceIp: request.ip, userAgent: request.header('user-agent'),
        origin: request.header('origin') },
      'staff',
    );
    setSessionCookies(response, result, this.environment);
    response.setHeader('x-csrf-token', result.csrfToken);
    response.clearCookie(OUTREACH_SIGNUP_COOKIE, {
      secure: this.environment.AUTH_COOKIE_SECURE, sameSite: 'strict', httpOnly: true, path: OUTREACH_SIGNUP_COOKIE_PATH,
    });
    return {
      activated: true as const,
      organizationId: activated.organizationId,
      facilityId: activated.facilityId,
      accountId: activated.accountId,
      reviewState: 'pending' as const,
      actor: result.actor,
      expiresAt: result.expiresAt.toISOString(),
    };
  }

  private assertAccountless(request: HidRequest): void {
    assertAccountless(request, this.environment.AUTH_COOKIE_NAME, { code: 'OUTREACH_ORGANISER_REQUIRES_SIGN_OUT',
      detail: 'You are signed in to Health ID. Use "Start an outreach group" from your account instead, '
        + 'or sign out to sign up with a different email.' });
  }

  private assertOrigin(request: HidRequest): void {
    assertAllowedOrigin(request, this.allowedOrigins);
  }

  private cookieOptions() {
    return {
      httpOnly: true,
      sameSite: 'strict' as const,
      secure: this.environment.AUTH_COOKIE_SECURE,
      path: OUTREACH_SIGNUP_COOKIE_PATH,
      maxAge: OUTREACH_SIGNUP_SESSION_SECONDS * 1000,
    };
  }
}

/**
 * "Start an outreach group" for a signed-in Health ID staff account (owner
 * decision 5): the same login runs an outreach group beside any hospital
 * roles it holds. A staff session with CSRF; no X-Facility-ID and no
 * permission, because the account does not yet belong to the new group.
 */
@Controller('identity/outreach-organisers/for-my-account')
@FacilityOptional()
export class OutreachOrganiserAccountController {
  constructor(private readonly organisers: OutreachOrganiserService) {}

  @Get('availability')
  availability() {
    return this.organisers.availability();
  }

  @Post()
  @HttpCode(201)
  @AuditAction('identity.outreach-organiser.start-for-account')
  start(@Body() input: StartOutreachGroupForAccountDto, @Req() request: HidRequest) {
    return this.organisers.startForAccount(accountOnlyContext(request), input);
  }
}
