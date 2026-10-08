import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { TotpCodeDto } from '../auth/dto/platform-auth.dto';
import { MfaService } from '../auth/mfa/mfa.service';
import { AuditAction, HighRiskAction, PlatformScope, RequirePermissions } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { requireAdminContext } from './admin-context';
import { ApprovalDecisionDto, ApprovalRequestDto, ListApprovalsDto, RevokeAccountSessionDto } from './dto/platform-security.dto';
import { PlatformSecurityService, type ApprovalDecision } from './platform-security.service';

const UUID_V4 = new ParseUUIDPipe({ version: '4' });

@Controller('admin')
@PlatformScope()
export class PlatformSecurityController {
  constructor(private readonly mfa: MfaService, private readonly security: PlatformSecurityService) {}

  @Get('mfa')
  @RequirePermissions('platform.admin.access')
  @AuditAction('admin.mfa.status.request')
  mfaStatus(@Req() request: HidRequest) {
    return this.mfa.status(requireAdminContext(request));
  }

  @Post('mfa/step-up')
  @HttpCode(200)
  @RequirePermissions('platform.admin.access')
  @HighRiskAction('platform.mfa.step-up')
  @AuditAction('admin.mfa.step-up.request')
  stepUp(@Body() input: TotpCodeDto, @Req() request: HidRequest) {
    return this.mfa.stepUp(requireAdminContext(request), input.code, this.event(request));
  }

  @Post('mfa/recovery-codes/regenerate')
  @HttpCode(200)
  @RequirePermissions('platform.admin.access')
  @HighRiskAction('platform.mfa.recovery-codes.regenerate')
  @AuditAction('admin.mfa.recovery-codes.regenerate.request')
  async regenerateRecoveryCodes(@Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    return this.mfa.regenerateRecoveryCodes(requireAdminContext(request), this.event(request));
  }

  @Get('sessions')
  @RequirePermissions('platform.admin.access')
  @AuditAction('admin.sessions.own.list.request')
  ownSessions(@Req() request: HidRequest) {
    const context = requireAdminContext(request);
    return this.security.listSessions(context, context.actor.accountId);
  }

  @Post('sessions/:sessionId/revoke')
  @HttpCode(200)
  @RequirePermissions('platform.admin.access')
  @HighRiskAction('platform.session.revoke-own')
  @AuditAction('admin.session.revoke-own.request')
  revokeOwnSession(@Param('sessionId', UUID_V4) sessionId: string, @Req() request: HidRequest) {
    return this.security.revokeOwnSession(requireAdminContext(request), sessionId, this.event(request));
  }

  @Get('principals/:accountId/sessions')
  @RequirePermissions('platform.session.revoke')
  @AuditAction('admin.principal.sessions.list.request')
  accountSessions(@Param('accountId', UUID_V4) accountId: string, @Req() request: HidRequest) {
    return this.security.listSessions(requireAdminContext(request), accountId);
  }

  @Post('principals/:accountId/sessions/:sessionId/revoke')
  @HttpCode(200)
  @RequirePermissions('platform.session.revoke')
  @HighRiskAction('platform.session.revoke-other')
  @AuditAction('admin.principal.session.revoke.request')
  revokeAccountSession(@Param('accountId', UUID_V4) accountId: string, @Param('sessionId', UUID_V4) sessionId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: RevokeAccountSessionDto,
    @Req() request: HidRequest) {
    return this.security.revokeAccountSession(requireAdminContext(request), accountId, sessionId,
      { reason: input.reason, compromised: input.compromised ?? false }, requireIdempotencyKey(key));
  }

  @Get('approvals')
  @RequirePermissions('platform.admin.access')
  @AuditAction('admin.approvals.list.request')
  approvals(@Query() query: ListApprovalsDto, @Req() request: HidRequest) {
    return this.security.listApprovals(requireAdminContext(request), query.status);
  }

  @Post('principals/:accountId/super-admin-requests')
  @RequirePermissions('platform.role.manage')
  @HighRiskAction('platform.role.super-admin.request')
  @AuditAction('admin.super-admin.request.request')
  requestSuperAdmin(@Param('accountId', UUID_V4) accountId: string, @Headers('idempotency-key') key: string | undefined,
    @Body() input: ApprovalRequestDto, @Req() request: HidRequest) {
    return this.security.requestSuperAdmin(requireAdminContext(request), accountId, input.reason,
      requireIdempotencyKey(key));
  }

  @Post('principals/:accountId/mfa-reset-requests')
  @RequirePermissions('platform.mfa.reset')
  @HighRiskAction('platform.mfa.reset.request')
  @AuditAction('admin.mfa-reset.request.request')
  requestMfaReset(@Param('accountId', UUID_V4) accountId: string, @Headers('idempotency-key') key: string | undefined,
    @Body() input: ApprovalRequestDto, @Req() request: HidRequest) {
    return this.security.requestMfaReset(requireAdminContext(request), accountId, input.reason,
      requireIdempotencyKey(key));
  }

  @Post('approvals/:requestId/:decision')
  @HttpCode(200)
  @RequirePermissions('platform.admin.access')
  @HighRiskAction('platform.approval.decide')
  @AuditAction('admin.approval.decide.request')
  decide(@Param('requestId', UUID_V4) requestId: string, @Param('decision') decision: string,
    @Headers('if-match') ifMatch: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Body() input: ApprovalDecisionDto, @Req() request: HidRequest) {
    if (decision !== 'approve' && decision !== 'reject' && decision !== 'cancel') {
      throw new DomainProblem(404, 'ADMIN_RESOURCE_NOT_FOUND', 'The requested administration resource was not found');
    }
    return this.security.decide(requireAdminContext(request), requestId, expectedVersion(ifMatch),
      decision as ApprovalDecision, input.reason, requireIdempotencyKey(key));
  }

  private event(request: HidRequest) {
    return { correlationId: request.correlationId, sourceIp: request.ip, userAgent: request.header('user-agent') };
  }
}

function expectedVersion(value: string | undefined): number {
  const normalized = value?.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  const version = normalized ? Number(normalized) : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new DomainProblem(428, 'IF_MATCH_REQUIRED', 'If-Match must contain the expected positive version');
  }
  return version;
}
