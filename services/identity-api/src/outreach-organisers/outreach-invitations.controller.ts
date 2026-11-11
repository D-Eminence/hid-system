import { Body, Controller, Get, Headers, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuthService } from '../auth/auth.service';
import type { LoginDto } from '../auth/dto/login.dto';
import { setSessionCookies } from '../auth/session-cookies';
import { TurnstileService } from '../auth/turnstile.service';
import { AuditAction, AuditFailuresOnly, FacilityOptional, NoAudit, Public, RequirePermissions } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { assertAccountless, assertAllowedOrigin } from '../common/public-flow-guards';
import { type HidRequest, requireRequestContext } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { accountOnlyContext } from '../identity/staff-invitations-signed-in.controller';
import { AcceptOutreachInvitationDto, CreateOutreachInvitationDto,
  SignedInOutreachInvitationDto } from './dto/outreach-organiser.dto';
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

  @Post()
  @RequirePermissions('outreach.campaign.write')
  @AuditAction('identity.outreach-invitation.create')
  async create(@Body() input: CreateOutreachInvitationDto, @Headers('idempotency-key') key: string | undefined,
    @Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    const answer = await this.invitations.create(requireRequestContext(request, 'healthcare-operations'), input,
      requireIdempotencyKey(key));
    response.status(answer.status);
    return answer.body;
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
    return { accepted: true as const, facilityId: accepted.facilityId, facilityName: accepted.facilityName,
      roleCode: accepted.roleCode, actor: result.actor, expiresAt: result.expiresAt.toISOString() };
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
