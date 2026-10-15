import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { AuditAction, HighRiskAction, PlatformScope, RequirePermissions } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { expectedVersion } from '../common/if-match';
import type { HidRequest } from '../common/request-context';
import { requireAdminContext } from './admin-context';
import { ClinicianApplicationAdminService } from './clinician-application-admin.service';
import { ApproveClinicianApplicationDto, AttestClinicianApplicationDto, ListClinicianApplicationsDto,
  RejectClinicianApplicationDto } from './dto/clinician-application-command.dto';

/**
 * The clinician verification queue (ADR-064). Every route needs
 * platform.workforce.manage on an MFA-verified platform session; the three
 * commands also need a TOTP step-up from the last five minutes, If-Match with
 * the application version, an Idempotency-Key and a reason. Step 1 (attest)
 * and step 2 (approve) must be made by two different Super Admins, neither of
 * whom works at the facility.
 */
@Controller('admin/clinician-applications')
@PlatformScope()
export class AdminClinicianApplicationsController {
  constructor(private readonly applications: ClinicianApplicationAdminService) {}

  @Get()
  @RequirePermissions('platform.workforce.manage')
  @AuditAction('admin.clinician-application.list.request')
  list(@Query() query: ListClinicianApplicationsDto, @Req() request: HidRequest) {
    return this.applications.list(requireAdminContext(request), query);
  }

  @Get(':applicationId')
  @RequirePermissions('platform.workforce.manage')
  @AuditAction('admin.clinician-application.read.request')
  detail(@Param('applicationId', new ParseUUIDPipe()) applicationId: string, @Req() request: HidRequest) {
    return this.applications.detail(requireAdminContext(request), applicationId);
  }

  @Post(':applicationId/attest')
  @RequirePermissions('platform.workforce.manage')
  @HighRiskAction('platform.clinician-application.attest')
  @AuditAction('admin.clinician-application.attest.request')
  attest(@Param('applicationId', new ParseUUIDPipe()) applicationId: string,
    @Headers('if-match') ifMatch: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Body() input: AttestClinicianApplicationDto, @Req() request: HidRequest) {
    const context = requireAdminContext(request);
    return this.applications.attest(context, applicationId, expectedVersion(ifMatch), input, requireIdempotencyKey(key),
      { correlationId: context.correlationId, sourceIp: request.ip, userAgent: request.header('user-agent') });
  }

  @Post(':applicationId/approve')
  @RequirePermissions('platform.workforce.manage')
  @HighRiskAction('platform.clinician-application.approve')
  @AuditAction('admin.clinician-application.approve.request')
  approve(@Param('applicationId', new ParseUUIDPipe()) applicationId: string,
    @Headers('if-match') ifMatch: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Body() input: ApproveClinicianApplicationDto, @Req() request: HidRequest) {
    return this.applications.approve(requireAdminContext(request), applicationId, expectedVersion(ifMatch), input,
      requireIdempotencyKey(key));
  }

  @Post(':applicationId/reject')
  @RequirePermissions('platform.workforce.manage')
  @HighRiskAction('platform.clinician-application.reject')
  @AuditAction('admin.clinician-application.reject.request')
  reject(@Param('applicationId', new ParseUUIDPipe()) applicationId: string,
    @Headers('if-match') ifMatch: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Body() input: RejectClinicianApplicationDto, @Req() request: HidRequest) {
    return this.applications.reject(requireAdminContext(request), applicationId, expectedVersion(ifMatch), input,
      requireIdempotencyKey(key));
  }
}
