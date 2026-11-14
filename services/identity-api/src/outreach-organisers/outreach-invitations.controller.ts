import { Body, Controller, Get, HttpCode, HttpException, Logger, NotFoundException, Param, ParseUUIDPipe, Post, Req,
  Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuditService } from '../audit/audit.service';
import type { LoginResult } from '../auth/auth.types';
import { AuthService } from '../auth/auth.service';
import type { LoginDto } from '../auth/dto/login.dto';
import type { DeviceTrust } from '../auth/outreach-volunteer';
import { setSessionCookies } from '../auth/session-cookies';
import { sessionEventFromRequest, sessionSuccessAuditEvent } from '../auth/session-success-audit';
import { TokenService } from '../auth/token.service';
import { TurnstileService } from '../auth/turnstile.service';
import { AuditAction, AuditFailuresOnly, FacilityOptional, NoAudit, Public, RequirePermissions } from '../common/decorators';
import { assertAccountless, assertAllowedOrigin } from '../common/public-flow-guards';
import { type HidRequest, requireRequestContext } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { accountOnlyContext } from '../identity/staff-invitations-signed-in.controller';
import { AcceptOutreachInvitationByLinkDto, AcceptOutreachInvitationDto, CreateOutreachInvitationDto,
  OutreachInvitationProofDto, SignedInOutreachInvitationDto } from './dto/outreach-organiser.dto';
import { OutreachInvitationsService } from './outreach-invitations.service';

/**
 * The organiser's team (plan PR-3): invite a helper by email, and list the
 * invitations. A staff session at the X-Facility-ID outreach organisation
 * with outreach.campaign.write; the service also requires the
 * outreach_organiser role there, and the database checks both again.
 */
@Controller('identity/outreach-invitations')
export class OutreachInvitationsController {
  constructor(private readonly invitations: OutreachInvitationsService) {}

  @Get()
  @RequirePermissions('outreach.campaign.read')
  @AuditAction('identity.outreach-invitation.list')
  list(@Req() request: HidRequest) {
    return this.invitations.list(requireRequestContext(request, 'healthcare-operations'));
  }

  /**
   * 201 { invitationId, expiresAt, deliveryOutcome }. 0115 keeps no
   * idempotency record: the same invitation sent again answers 409
   * OUTREACH_INVITATION_ALREADY_SENT, so a retry never sends a second email.
   */
  @Post()
  @RequirePermissions('outreach.campaign.write')
  @AuditAction('identity.outreach-invitation.create')
  create(@Body() input: CreateOutreachInvitationDto, @Req() request: HidRequest) {
    return this.invitations.create(requireRequestContext(request, 'healthcare-operations'), input);
  }

  /** Cancels a pending invitation. */
  @Post(':invitationId/revoke')
  @HttpCode(200)
  @RequirePermissions('outreach.campaign.write')
  @AuditAction('identity.outreach-invitation.revoke')
  revoke(@Param('invitationId', new ParseUUIDPipe({ version: '4' })) invitationId: string, @Req() request: HidRequest) {
    return this.invitations.revoke(requireRequestContext(request, 'healthcare-operations'), invitationId);
  }
}

/**
 * What an invitation link shows before accepting (no sign-in): the group, who
 * invited, and whether to set a password or sign in first. Origin, then the
 * network's window, then the command (a wrong token counts against the link).
 */
@Controller('identity/outreach-invitations/preview')
@Public()
@AuditFailuresOnly()
export class OutreachInvitationsPreviewController {
  private readonly environment = getEnvironment();
  private readonly allowedOrigins = new Set(this.environment.CORS_ORIGINS.split(',').map((origin) => origin.trim()));

  constructor(private readonly invitations: OutreachInvitationsService) {}

  @Post()
  @HttpCode(200)
  @AuditAction('identity.outreach-invitation.preview')
  preview(@Body() input: OutreachInvitationProofDto, @Req() request: HidRequest) {
    assertAllowedOrigin(request, this.allowedOrigins);
    return this.invitations.preview(input, request.ip, request.correlationId);
  }
}

/**
 * A helper without a Health ID account accepts an outreach invitation, sets a
 * password and is signed in. Origin, the signed-in check, Turnstile (action
 * outreach-invitation, outreach. hosts only), then the command.
 */
@Controller('identity/outreach-invitations/accept')
@Public()
@AuditFailuresOnly()
export class OutreachInvitationsPublicController {
  private readonly environment = getEnvironment();
  private readonly allowedOrigins = new Set(this.environment.CORS_ORIGINS.split(',').map((origin) => origin.trim()));

  constructor(private readonly invitations: OutreachInvitationsService, private readonly turnstile: TurnstileService,
    private readonly auth: AuthService) {}

  @Post()
  @HttpCode(200)
  @AuditAction('identity.outreach-invitation.accept')
  async accept(@Body() input: AcceptOutreachInvitationDto, @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response) {
    assertAllowedOrigin(request, this.allowedOrigins);
    assertAccountless(request, this.environment.AUTH_COOKIE_NAME, { code: 'OUTREACH_INVITATION_REQUIRES_SIGN_OUT',
      detail: 'You are signed in to Health ID. Accept the invitation from your account, or sign out first.' });
    await this.turnstile.verify({ token: input.turnstileToken, action: input.turnstileAction,
      origin: request.header('origin'), remoteIp: request.ip });
    const accepted = await this.invitations.acceptWithPassword(input, request.ip, request.correlationId);
    const result = await this.auth.login(
      { email: accepted.email, password: input.password } as LoginDto,
      { correlationId: request.correlationId, sourceIp: request.ip, userAgent: request.header('user-agent'),
        origin: request.header('origin') },
      'staff',
    );
    setSessionCookies(response, result, this.environment);
    response.setHeader('x-csrf-token', result.csrfToken);
    return { accepted: true as const, facilityId: accepted.facilityId, membershipId: accepted.membershipId,
      roleCode: accepted.roleCode, actor: result.actor, expiresAt: result.expiresAt.toISOString() };
  }
}

/**
 * Password-free sign-in, Phase 1: a helper without a Health ID account
 * accepts an outreach invitation by the link alone and that phone is signed
 * in, with no password. 404 while OUTREACH_INVITE_LINK_SIGN_IN_ENABLED is off
 * (checked first, so the browser's Turnstile token is not spent and the
 * website falls back to the password form). Then Origin, the signed-in check,
 * Turnstile (action outreach-invitation), the network's window and the
 * command. `device` 'own' asks for the long volunteer session, 'shared' keeps
 * the 15-minute idle lock. If the sign-in fails after the invitation was
 * accepted, the answer is still 200 with signedIn false: the link is used,
 * and the person signs in with "Forgot password?".
 */
@Controller('identity/outreach-invitations/accept-link')
@Public()
@AuditFailuresOnly()
export class OutreachInvitationsLinkController {
  private readonly logger = new Logger(OutreachInvitationsLinkController.name);
  private readonly environment = getEnvironment();
  private readonly allowedOrigins = new Set(this.environment.CORS_ORIGINS.split(',').map((origin) => origin.trim()));

  constructor(private readonly invitations: OutreachInvitationsService, private readonly turnstile: TurnstileService,
    private readonly tokens: TokenService, private readonly audit: AuditService) {}

  @Post()
  @HttpCode(200)
  @AuditAction('identity.outreach-invitation.accept-link')
  async accept(@Body() input: AcceptOutreachInvitationByLinkDto, @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response) {
    if (!this.environment.OUTREACH_INVITE_LINK_SIGN_IN_ENABLED) throw new NotFoundException();
    assertAllowedOrigin(request, this.allowedOrigins);
    assertAccountless(request, this.environment.AUTH_COOKIE_NAME, { code: 'OUTREACH_INVITATION_REQUIRES_SIGN_OUT',
      detail: 'You are signed in to Health ID. Accept the invitation from your account, or sign out first.' });
    await this.turnstile.verify({ token: input.turnstileToken, action: input.turnstileAction,
      origin: request.header('origin'), remoteIp: request.ip });
    const accepted = await this.invitations.acceptWithLink(input, request.ip, request.correlationId);
    const joined = { accepted: true as const, facilityId: accepted.facilityId, membershipId: accepted.membershipId,
      roleCode: accepted.roleCode };
    const requested: DeviceTrust = input.device === 'own' ? 'own_device' : 'standard';
    const event = sessionEventFromRequest(request);
    let session: LoginResult | undefined;
    try {
      session = await this.tokens.issue({ subject: accepted.subject, accountId: accepted.accountId, actorKind: 'staff',
        displayName: '', facilities: [], authenticationMethod: 'local', signInVia: 'invitation_link',
        deviceTrust: requested }, event);
      const deviceTrust: DeviceTrust = session.longVolunteerSession === true ? 'own_device' : 'standard';
      const audit = sessionSuccessAuditEvent('auth.login', session.actor, request);
      await this.audit.record({ ...audit, details: { sign_in_via: 'invitation_link', device_trust: deviceTrust,
        device_requested: requested } });
      setSessionCookies(response, session, this.environment);
      response.setHeader('x-csrf-token', session.csrfToken);
      return { ...joined, signedIn: true as const, actor: session.actor, expiresAt: session.expiresAt.toISOString(),
        signedInUntil: session.refreshExpiresAt.toISOString(), deviceTrust };
    } catch (error) {
      // A session made but not handed over (its audit failed) is revoked,
      // best-effort: no browser holds it.
      if (session) await this.tokens.revoke(session.actor.sessionId, session.actor.subject, event).catch(() => undefined);
      const status = error instanceof HttpException ? String(error.getStatus()) : 'error';
      this.logger.warn(`Outreach invitation accepted by link, but the sign-in after it was not completed; the helper `
        + `signs in instead (event=outreach_invitation_link_sign_in_failed correlation=${request.correlationId} `
        + `status=${status})`);
      return { ...joined, signedIn: false as const };
    }
  }
}

/**
 * A signed-in Health ID account accepts an outreach invitation (owner
 * decision 5: the same login can work at a hospital and help an outreach
 * group). No X-Facility-ID and no permission; the command writes the audit
 * row at the outreach organisation.
 */
@Controller('identity/outreach-invitations/signed-in')
@FacilityOptional()
@NoAudit()
export class OutreachInvitationsSignedInController {
  constructor(private readonly invitations: OutreachInvitationsService) {}

  @Post('accept')
  @HttpCode(200)
  accept(@Body() input: SignedInOutreachInvitationDto, @Req() request: HidRequest) {
    return this.invitations.acceptForAccount(accountOnlyContext(request), input);
  }
}
