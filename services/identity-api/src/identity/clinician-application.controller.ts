import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { TurnstileService } from '../auth/turnstile.service';
import { AuditAction, AuditFailuresOnly, NoAudit, Public } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { expectedVersion } from '../common/if-match';
import { assertAccountless, assertAllowedOrigin, singleCookie } from '../common/public-flow-guards';
import type { HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { CLINICIAN_APPLICATION_COOKIE_NAME, type ClinicianApplicationCapabilityKind,
  clearClinicianApplicationCookie, clinicianApplicationCookieOptions } from './clinician-application-cookie';
import { type ClinicianRequest, ClinicianApplicationService } from './clinician-application.service';
import { ClinicianApplicationDetailsDto, ClinicianApplicationEmailCodeDto, ClinicianApplicationStatusEmailCodeDto,
  ClinicianAuthenticatorCodeDto, ClinicianAuthenticatorStartDto, ClinicianAuthenticatorVerifyDto,
  ClinicianFacilitySearchDto, SubmitClinicianApplicationDto,
  VerifyClinicianApplicationCodeDto } from './dto/clinician-application.dto';

/**
 * Clinician self sign-up and its status page (ADR-066). Public: the security
 * guard does not run here, so each route checks its Origin itself, and the
 * intake routes (P1-P4) refuse a signed-in browser. The browser holds only
 * the application capability cookie; no route sets or reads a session cookie
 * (beyond the accountless check) or returns a token. Successes are audited by
 * the database commands; refusals by the interceptor.
 */
@Controller('identity/clinician-applications')
@Public()
@AuditFailuresOnly()
export class ClinicianApplicationController {
  private readonly environment = getEnvironment();
  private readonly allowedOrigins = new Set(
    this.environment.CORS_ORIGINS.split(',').map((origin) => origin.trim()));

  constructor(private readonly applications: ClinicianApplicationService,
    private readonly turnstile: TurnstileService) {}

  /** P0. Same answer for every caller, no PHI: cacheable briefly, not audited. */
  @Get('availability')
  @NoAudit()
  async availability(@Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    const result = await this.applications.availability(request.correlationId);
    response.setHeader('Cache-Control', 'public, max-age=30');
    for (const name of ['Pragma', 'Expires', 'Surrogate-Control']) response.removeHeader(name);
    return result;
  }

  /** P1. */
  @Post('email-code')
  @HttpCode(202)
  @AuditAction('identity.clinician-application.email-code')
  async emailCode(@Body() input: ClinicianApplicationEmailCodeDto, @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    this.assertAccountless(request);
    await this.turnstile.verify({ token: input.turnstileToken, action: input.turnstileAction,
      origin: request.header('origin'), remoteIp: request.ip });
    const result = await this.applications.startSignup(input.email, this.context(request));
    response.setHeader('Cache-Control', 'no-store');
    return result;
  }

  /** P2. */
  @Post('email-code/verify')
  @HttpCode(200)
  @AuditAction('identity.clinician-application.email-code.verify')
  async verifyEmailCode(@Body() input: VerifyClinicianApplicationCodeDto, @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    this.assertAccountless(request);
    const result = await this.applications.verifySignupCode(input, this.context(request));
    this.setCapability(response, result.token, 'draft');
    return result.answer;
  }

  /** P3. A draft is accountless; a ready account capability is not held to that. */
  @Post('facility-search')
  @HttpCode(200)
  @AuditAction('identity.clinician-application.facility-search')
  async searchFacilities(@Body() input: ClinicianFacilitySearchDto, @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    const result = await this.applications.searchFacilities(this.capability(request), input.query,
      this.signedIn(request), this.context(request));
    response.setHeader('Cache-Control', 'no-store');
    return result;
  }

  /** P4. */
  @Post()
  @HttpCode(201)
  @AuditAction('identity.clinician-application.submit')
  async submit(@Body() input: SubmitClinicianApplicationDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    this.assertAccountless(request);
    const key = requireIdempotencyKey(idempotencyKey);
    const result = await this.applications.submit(this.capability(request), key, input, this.context(request));
    this.setCapability(response, result.token, 'account');
    return result.answer;
  }

  /** P5. */
  @Post('authenticator/email-code')
  @HttpCode(200)
  @AuditAction('identity.clinician-application.authenticator.email-code')
  async authenticatorEmailCode(@Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    const result = await this.applications.sendAuthenticatorCode(this.capability(request), this.context(request));
    response.setHeader('Cache-Control', 'no-store');
    return result;
  }

  /** P6. The secret is returned once. */
  @Post('authenticator/start')
  @HttpCode(200)
  @AuditAction('identity.clinician-application.authenticator.start')
  async startAuthenticator(@Body() input: ClinicianAuthenticatorStartDto, @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    const result = await this.applications.startAuthenticator(this.capability(request), input.emailCode,
      this.context(request));
    response.setHeader('Cache-Control', 'no-store');
    return result;
  }

  /** P7. The recovery codes are returned once; no session is issued. */
  @Post('authenticator/activate')
  @HttpCode(200)
  @AuditAction('identity.clinician-application.authenticator.activate')
  async activateAuthenticator(@Body() input: ClinicianAuthenticatorCodeDto, @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    const result = await this.applications.activateAuthenticator(this.capability(request), input.code,
      this.context(request));
    response.setHeader('Cache-Control', 'no-store');
    return result;
  }

  /** P8. No session is issued. */
  @Post('authenticator/verify')
  @HttpCode(200)
  @AuditAction('identity.clinician-application.authenticator.verify')
  async verifyAuthenticator(@Body() input: ClinicianAuthenticatorVerifyDto, @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    const result = await this.applications.verifyAuthenticator(this.capability(request),
      { ...(input.code ? { code: input.code } : {}), ...(input.recoveryCode ? { recoveryCode: input.recoveryCode } : {}) },
      this.context(request));
    response.setHeader('Cache-Control', 'no-store');
    return result;
  }

  /** P9. */
  @Post('authenticator/challenge')
  @HttpCode(200)
  @AuditAction('identity.clinician-application.authenticator.challenge')
  async reopenAuthenticator(@Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    const result = await this.applications.reopenAuthenticator(this.capability(request), this.context(request));
    response.setHeader('Cache-Control', 'no-store');
    return result;
  }

  /** P10. Not gated by clinician_signup_enabled and not accountless. */
  @Post('status/email-code')
  @HttpCode(202)
  @AuditAction('identity.clinician-application.status.email-code')
  async statusEmailCode(@Body() input: ClinicianApplicationStatusEmailCodeDto, @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    await this.turnstile.verify({ token: input.turnstileToken, action: input.turnstileAction,
      origin: request.header('origin'), remoteIp: request.ip });
    const result = await this.applications.startStatus(input.email, this.context(request));
    response.setHeader('Cache-Control', 'no-store');
    return result;
  }

  /** P11. */
  @Post('status/email-code/verify')
  @HttpCode(200)
  @AuditAction('identity.clinician-application.status.email-code.verify')
  async verifyStatusCode(@Body() input: VerifyClinicianApplicationCodeDto, @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    const result = await this.applications.verifyStatusCode(input, this.context(request));
    this.setCapability(response, result.token, 'account');
    return result.answer;
  }

  /** P12. */
  @Get('current')
  @AuditAction('identity.clinician-application.current')
  async current(@Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    const result = await this.applications.current(this.capability(request), this.context(request));
    response.setHeader('Cache-Control', 'no-store');
    return result;
  }

  /** P14. Apply to another facility (a ready account capability). */
  @Post('current/applications')
  @HttpCode(201)
  @AuditAction('identity.clinician-application.apply')
  async apply(@Body() input: ClinicianApplicationDetailsDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    const key = requireIdempotencyKey(idempotencyKey);
    const result = await this.applications.apply(this.capability(request), key, input, this.context(request));
    response.setHeader('Cache-Control', 'no-store');
    return result;
  }

  /** P15. Always 204; the cookie is cleared whatever the database answers. */
  @Post('session/end')
  @HttpCode(204)
  @AuditAction('identity.clinician-application.session.end')
  async endSession(@Req() request: HidRequest, @Res({ passthrough: true }) response: Response): Promise<void> {
    this.assertOrigin(request);
    await this.applications.endSession(this.capability(request), this.context(request));
    clearClinicianApplicationCookie(response, this.environment.AUTH_COOKIE_SECURE);
  }

  /** P13. */
  @Post(':applicationId/withdraw')
  @HttpCode(200)
  @AuditAction('identity.clinician-application.withdraw')
  async withdraw(@Param('applicationId', new ParseUUIDPipe()) applicationId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    const version = expectedVersion(ifMatch);
    const result = await this.applications.withdraw(this.capability(request), applicationId, version,
      this.context(request));
    response.setHeader('Cache-Control', 'no-store');
    return result;
  }

  private setCapability(response: Response, token: string, kind: ClinicianApplicationCapabilityKind): void {
    response.cookie(CLINICIAN_APPLICATION_COOKIE_NAME, token,
      clinicianApplicationCookieOptions(this.environment.AUTH_COOKIE_SECURE, kind));
    response.setHeader('Cache-Control', 'no-store');
  }

  private capability(request: HidRequest): string | undefined {
    return singleCookie(request, CLINICIAN_APPLICATION_COOKIE_NAME);
  }

  private context(request: HidRequest): ClinicianRequest {
    return { correlationId: request.correlationId, ip: request.ip, userAgent: request.header('user-agent') };
  }

  private signedIn(request: HidRequest): boolean {
    try {
      this.assertAccountless(request);
      return false;
    } catch {
      return true;
    }
  }

  private assertAccountless(request: HidRequest): void {
    assertAccountless(request, this.environment.AUTH_COOKIE_NAME, { code: 'CLINICIAN_APPLICATION_REQUIRES_SIGN_OUT',
      detail: 'Sign out of Health ID before applying as a clinician' });
  }

  private assertOrigin(request: HidRequest): void {
    assertAllowedOrigin(request, this.allowedOrigins);
  }
}
