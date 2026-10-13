import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { AuditAction, HighRiskAction, PlatformScope, RequirePermissions } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { requireAdminContext } from './admin-context';
import {
  WorkforceAttachCommandDto, WorkforceAttestationCommandDto, WorkforceEndMembershipCommandDto, WorkforceRoleCommandDto,
} from './dto/workforce-command.dto';
import { WorkforceAdminService } from './workforce-admin.service';

/**
 * Launch D14: platform-governed clinician provisioning. Every command needs
 * platform.workforce.manage, an MFA-verified platform session, a TOTP step-up
 * from the last five minutes, a reason and an Idempotency-Key; commands on an
 * existing staff record or membership also need If-Match with its version.
 */
@Controller('admin/workforce')
@PlatformScope()
export class WorkforceAdminController {
  constructor(private readonly workforce: WorkforceAdminService) {}

  @Get('accounts/:accountId')
  @RequirePermissions('platform.workforce.manage')
  @AuditAction('admin.workforce.account.read.request')
  profile(@Param('accountId', new ParseUUIDPipe()) accountId: string, @Req() request: HidRequest) {
    return this.workforce.profile(requireAdminContext(request), accountId);
  }

  @Post('memberships')
  @RequirePermissions('platform.workforce.manage')
  @HighRiskAction('platform.workforce.attach')
  @AuditAction('admin.workforce.membership.attach.request')
  attach(@Headers('idempotency-key') key: string | undefined, @Body() input: WorkforceAttachCommandDto,
    @Req() request: HidRequest) {
    return this.workforce.attach(requireAdminContext(request), input, requireIdempotencyKey(key));
  }

  @Post('accounts/:accountId/attestations')
  @RequirePermissions('platform.workforce.manage')
  @HighRiskAction('platform.workforce.attest')
  @AuditAction('admin.workforce.credential.attest.request')
  attest(@Param('accountId', new ParseUUIDPipe()) accountId: string,
    @Headers('if-match') ifMatch: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Body() input: WorkforceAttestationCommandDto, @Req() request: HidRequest) {
    return this.workforce.attest(requireAdminContext(request), accountId, this.expectedVersion(ifMatch), input,
      requireIdempotencyKey(key));
  }

  @Post('memberships/:membershipId/roles')
  @RequirePermissions('platform.workforce.manage')
  @HighRiskAction('platform.workforce.role.change')
  @AuditAction('admin.workforce.role.change.request')
  changeRole(@Param('membershipId', new ParseUUIDPipe()) membershipId: string,
    @Headers('if-match') ifMatch: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Body() input: WorkforceRoleCommandDto, @Req() request: HidRequest) {
    return this.workforce.changeRole(requireAdminContext(request), membershipId, this.expectedVersion(ifMatch), input,
      requireIdempotencyKey(key));
  }

  @Post('memberships/:membershipId/end')
  @RequirePermissions('platform.workforce.manage')
  @HighRiskAction('platform.workforce.membership.end')
  @AuditAction('admin.workforce.membership.end.request')
  endMembership(@Param('membershipId', new ParseUUIDPipe()) membershipId: string,
    @Headers('if-match') ifMatch: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Body() input: WorkforceEndMembershipCommandDto, @Req() request: HidRequest) {
    return this.workforce.endMembership(requireAdminContext(request), membershipId, this.expectedVersion(ifMatch),
      input, requireIdempotencyKey(key));
  }

  private expectedVersion(value: string | undefined): number {
    const normalized = value?.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
    const version = normalized ? Number(normalized) : Number.NaN;
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new DomainProblem(428, 'IF_MATCH_REQUIRED', 'If-Match must contain the expected positive version');
    }
    return version;
  }
}
