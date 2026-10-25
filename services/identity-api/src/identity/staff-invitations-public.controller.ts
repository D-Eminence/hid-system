import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { TurnstileService } from '../auth/turnstile.service';
import { AuditAction, AuditFailuresOnly, Public } from '../common/decorators';
import { assertAccountless, assertAllowedOrigin, singleCookie } from '../common/public-flow-guards';
import type { HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { AcceptStaffInvitationDto, OpenStaffInvitationDto } from './dto/staff-invitation.dto';
import { STAFF_INVITATION_SESSION_SECONDS, StaffInvitationsService } from './staff-invitations.service';

export const STAFF_INVITATION_COOKIE = 'hid_staff_invitation';
export const STAFF_INVITATION_COOKIE_PATH = '/api/v1/identity/staff-invitations';

/**
 * Opening and accepting a staff invitation without an account (P4b, SPEC 4.7
 * and 4.8), on the portal host (app.* and staging.*). Open takes the link's
 * invitation id and token, or the email and code, with Turnstile; a new or
 * dormant account then sets its password with the acceptance cookie. No
 * session is issued here: the person signs in on their role's host.
 *
 * Order (FEA R3; P4's provider-enrollment.controller.ts): the global
 * ValidationPipe first, then Origin, the signed-in check, Turnstile (open
 * only), the gate, and on open the network limit, then the command.
 */
@Controller('identity/staff-invitations')
@Public()
@AuditFailuresOnly()
export class StaffInvitationsPublicController {
  private readonly environment = getEnvironment();
  private readonly allowedOrigins = new Set(this.environment.CORS_ORIGINS.split(',').map((origin) => origin.trim()));

  constructor(private readonly invitations: StaffInvitationsService, private readonly turnstile: TurnstileService) {}

  /**
   * 200 { invitationId, facilityName, roleCode, inviterName, inviteeName,
   * email, expiresAt, accountCase, linkRequired }, plus the acceptance cookie
   * for a new or dormant account opened by its link.
   */
  @Post('open')
  @HttpCode(200)
  @AuditAction('identity.staff-invitation.open')
  async open(@Body() input: OpenStaffInvitationDto, @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    this.assertAccountless(request);
    await this.turnstile.verify({
      token: input.turnstileToken,
      action: input.turnstileAction,
      origin: request.header('origin'),
      remoteIp: request.ip,
    });
    const opened = await this.invitations.open(input, request);
    if (opened.sessionToken) {
      response.cookie(STAFF_INVITATION_COOKIE, opened.sessionToken, {
        httpOnly: true,
        sameSite: 'strict',
        secure: this.environment.AUTH_COOKIE_SECURE,
        path: STAFF_INVITATION_COOKIE_PATH,
        maxAge: STAFF_INVITATION_SESSION_SECONDS * 1000,
      });
    }
    return opened.body;
  }

  /** 200 { accepted: true, facilityName, roleCode }; the cookie is cleared and no session cookie is set. */
  @Post('accept')
  @HttpCode(200)
  @AuditAction('identity.staff-invitation.accept')
  async accept(@Body() input: AcceptStaffInvitationDto, @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    this.assertAccountless(request);
    await this.invitations.assertOpen('public-accept');
    const accepted = await this.invitations.accept(singleCookie(request, STAFF_INVITATION_COOKIE), input.password,
      request.correlationId);
    response.clearCookie(STAFF_INVITATION_COOKIE, {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.environment.AUTH_COOKIE_SECURE,
      path: STAFF_INVITATION_COOKIE_PATH,
    });
    return accepted;
  }

  private assertAccountless(request: HidRequest): void {
    assertAccountless(request, this.environment.AUTH_COOKIE_NAME, { code: 'STAFF_INVITATION_REQUIRES_SIGN_OUT',
      detail: 'Sign out of Health ID, or open the invitation in a private window' });
  }

  private assertOrigin(request: HidRequest): void {
    assertAllowedOrigin(request, this.allowedOrigins);
  }
}
