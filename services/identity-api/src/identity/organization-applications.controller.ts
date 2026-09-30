import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { requireAdminContext } from '../admin/admin-context';
import { TurnstileService } from '../auth/turnstile.service';
import { AuditAction, AuditFailuresOnly, FacilityOptional, Public, RequirePermissions } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { ApproveOrganizationApplicationDto, ListOrganizationApplicationsDto,
  ReviewOrganizationApplicationDto, SubmitOrganizationApplicationDto } from './dto/organization-application.dto';
import { OrganizationApplicationsService } from './organization-applications.service';

function expectedVersion(value: string | undefined): number {
  const normalized = value?.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  const version = normalized ? Number(normalized) : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new DomainProblem(428, 'IF_MATCH_REQUIRED', 'If-Match must contain the expected positive version');
  }
  return version;
}

@Controller('identity/organization-applications')
@AuditFailuresOnly()
export class PublicOrganizationApplicationsController {
  private readonly allowedOrigins = new Set(getEnvironment().CORS_ORIGINS.split(',').map((origin) => origin.trim()));

  constructor(private readonly applications: OrganizationApplicationsService,
    private readonly turnstile: TurnstileService) {}

  @Post()
  @Public()
  @HttpCode(202)
  @AuditAction('identity.organization-application.submit')
  async submit(@Body() input: SubmitOrganizationApplicationDto, @Req() request: HidRequest) {
    const origin = request.header('origin');
    if (!origin || !this.allowedOrigins.has(origin)) {
      throw new DomainProblem(403, 'ORIGIN_DENIED', 'Request origin is not allowed');
    }
    await this.turnstile.verify({ token: input.turnstileToken, action: input.turnstileAction,
      origin, remoteIp: request.ip });
    return this.applications.submit(input, request);
  }
}

@Controller('admin/organization-applications')
@FacilityOptional()
@AuditFailuresOnly()
export class AdminOrganizationApplicationsController {
  constructor(private readonly applications: OrganizationApplicationsService) {}

  @Get()
  @RequirePermissions('platform.identity-review.read')
  @AuditAction('admin.organization-applications.list')
  list(@Query() filters: ListOrganizationApplicationsDto, @Req() request: HidRequest) {
    return this.applications.list(requireAdminContext(request), filters.status);
  }

  @Post(':applicationId/verify-cac')
  @HttpCode(200)
  @RequirePermissions('platform.facility.manage')
  @AuditAction('admin.organization-application.verify-cac')
  verify(@Param('applicationId', new ParseUUIDPipe({ version: '4' })) applicationId: string,
    @Headers('if-match') ifMatch: string | undefined, @Req() request: HidRequest) {
    return this.applications.verify(requireAdminContext(request), applicationId, expectedVersion(ifMatch));
  }

  @Post(':applicationId/approve')
  @HttpCode(200)
  @RequirePermissions('platform.facility.manage', 'platform.principal.manage', 'platform.role.manage')
  @AuditAction('admin.organization-application.approve')
  approve(@Param('applicationId', new ParseUUIDPipe({ version: '4' })) applicationId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() input: ApproveOrganizationApplicationDto, @Req() request: HidRequest) {
    return this.applications.approve(requireAdminContext(request), applicationId, expectedVersion(ifMatch), input);
  }

  @Post(':applicationId/reject')
  @HttpCode(200)
  @RequirePermissions('platform.facility.manage')
  @AuditAction('admin.organization-application.reject')
  reject(@Param('applicationId', new ParseUUIDPipe({ version: '4' })) applicationId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() input: ReviewOrganizationApplicationDto, @Req() request: HidRequest) {
    return this.applications.reject(requireAdminContext(request), applicationId, expectedVersion(ifMatch), input.reason);
  }
}
