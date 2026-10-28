import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuditAction, AuditFailuresOnly, PatientOnly } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import type { HidRequest } from '../common/request-context';
import { CreateShareDto, CreateShareInvitationDto, SearchShareProvidersDto } from './dto/patient-share.dto';
import { PatientSharesService } from './patient-shares.service';

/**
 * The patient's sharing (B4, migration 0095): find a clinician (POST, so the
 * search text stays out of request lines and logs), share, and invite a
 * provider by email. Patient sessions only; every POST is a cookie write with
 * Origin and CSRF. The SQL commands audit each success; the interceptor
 * records failures. Ending a share is the existing
 * POST identity/me/consent-grants/:grantId/revoke (0087).
 */
@Controller('identity')
@PatientOnly()
@AuditFailuresOnly()
export class PatientSharesController {
  constructor(private readonly shares: PatientSharesService) {}

  @Post('me/share-providers/search')
  @HttpCode(200)
  @AuditAction('identity.share-providers.search.command')
  search(@Req() request: HidRequest, @Body() input: SearchShareProvidersDto) {
    return this.shares.search(request, input.query);
  }

  /** 201 the share; 200 with replayed: true for a replay of the same Idempotency-Key and body. */
  @Post('me/shares')
  @AuditAction('identity.consent-grant.patient-share.command')
  async create(@Req() request: HidRequest, @Body() input: CreateShareDto,
    @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) response: Response) {
    this.shares.assertServed();
    const answer = await this.shares.create(request, input, requireIdempotencyKey(key));
    response.status(answer.replayed ? 200 : 201);
    return answer;
  }

  /** The B4 served probe: 200, or 404 while sharing is off (and on an older Identity). */
  @Get('me/share-invitations')
  invitations(@Req() request: HidRequest) {
    return this.shares.invitations(request);
  }

  @Post('me/share-invitations')
  @AuditAction('identity.share-invitation.create.command')
  async invite(@Req() request: HidRequest, @Body() input: CreateShareInvitationDto,
    @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) response: Response) {
    this.shares.assertServed();
    const answer = await this.shares.invite(request, input, requireIdempotencyKey(key));
    response.status(answer.replayed ? 200 : 201);
    return answer;
  }

  @Post('me/share-invitations/:invitationId/cancel')
  @HttpCode(200)
  @AuditAction('identity.share-invitation.cancel.command')
  cancel(@Req() request: HidRequest, @Param('invitationId', new ParseUUIDPipe()) invitationId: string) {
    return this.shares.cancel(request, invitationId);
  }

  /** 201 the grant; 200 with replayed: true for a repeat. */
  @Post('me/share-invitations/:invitationId/confirm')
  @AuditAction('identity.share-invitation.confirm.command')
  async confirm(@Req() request: HidRequest, @Param('invitationId', new ParseUUIDPipe()) invitationId: string,
    @Res({ passthrough: true }) response: Response) {
    const answer = await this.shares.confirm(request, invitationId);
    response.status(answer.replayed ? 200 : 201);
    return answer;
  }
}
