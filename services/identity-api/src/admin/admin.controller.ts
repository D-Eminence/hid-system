import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { AuditAction, FacilityOptional, RequirePermissions } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { requireAdminContext } from './admin-context';
import { AdminOperationsService } from './admin-operations.service';
import { AdminService } from './admin.service';
import { AccountStatusCommandDto, FacilityStatusCommandDto, PlatformRoleCommandDto,
  RevokeSessionsCommandDto } from './dto/admin-command.dto';
import { ListFacilitiesDto, ListIdentityReviewsDto, ListPlatformAuditDto,
  ListPrincipalsDto } from './dto/admin-list.dto';

@Controller('admin')
@FacilityOptional()
export class AdminController {
  constructor(private readonly admin: AdminService, private readonly operations: AdminOperationsService) {}

  @Get('session')
  @RequirePermissions('platform.admin.access')
  @AuditAction('admin.session.read.request')
  session(@Req() request: HidRequest) { return this.admin.session(requireAdminContext(request)); }

  @Get('overview')
  @RequirePermissions('platform.admin.access')
  @AuditAction('admin.overview.read.request')
  overview(@Req() request: HidRequest) { return this.admin.overview(requireAdminContext(request)); }

  @Get('facilities')
  @RequirePermissions('platform.facility.read')
  @AuditAction('admin.facilities.list.request')
  facilities(@Query() query: ListFacilitiesDto, @Req() request: HidRequest) {
    return this.admin.listFacilities(requireAdminContext(request), query);
  }

  @Get('facilities/:facilityId')
  @RequirePermissions('platform.facility.read')
  @AuditAction('admin.facility.read.request')
  facility(@Param('facilityId', new ParseUUIDPipe({ version: '4' })) facilityId: string, @Req() request: HidRequest) {
    return this.admin.facility(requireAdminContext(request), facilityId);
  }

  @Post('facilities/:facilityId/status')
  @RequirePermissions('platform.facility.manage')
  @AuditAction('admin.facility.status.request')
  transitionFacility(@Param('facilityId', new ParseUUIDPipe({ version: '4' })) facilityId: string,
    @Headers('if-match') ifMatch: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Body() input: FacilityStatusCommandDto, @Req() request: HidRequest) {
    return this.admin.transitionFacility(requireAdminContext(request), facilityId, this.expectedVersion(ifMatch),
      input, requireIdempotencyKey(key));
  }

  @Get('principals')
  @RequirePermissions('platform.principal.read')
  @AuditAction('admin.principals.list.request')
  principals(@Query() query: ListPrincipalsDto, @Req() request: HidRequest) {
    return this.admin.listPrincipals(requireAdminContext(request), query);
  }

  @Post('principals/:accountId/status')
  @RequirePermissions('platform.principal.manage')
  @AuditAction('admin.principal.status.request')
  transitionAccount(@Param('accountId', new ParseUUIDPipe({ version: '4' })) accountId: string,
    @Headers('if-match') ifMatch: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Body() input: AccountStatusCommandDto, @Req() request: HidRequest) {
    return this.admin.transitionAccount(requireAdminContext(request), accountId, this.expectedVersion(ifMatch),
      input, requireIdempotencyKey(key));
  }

  @Post('principals/:accountId/platform-roles')
  @RequirePermissions('platform.role.manage')
  @AuditAction('admin.platform-role.change.request')
  changeRole(@Param('accountId', new ParseUUIDPipe({ version: '4' })) accountId: string,
    @Headers('if-match') ifMatch: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Body() input: PlatformRoleCommandDto, @Req() request: HidRequest) {
    return this.admin.changePlatformRole(requireAdminContext(request), accountId, this.expectedVersion(ifMatch),
      input, requireIdempotencyKey(key));
  }

  @Post('principals/:accountId/sessions/revoke')
  @RequirePermissions('platform.session.revoke')
  @AuditAction('admin.principal.sessions.revoke.request')
  revokeSessions(@Param('accountId', new ParseUUIDPipe({ version: '4' })) accountId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: RevokeSessionsCommandDto,
    @Req() request: HidRequest) {
    return this.admin.revokeSessions(requireAdminContext(request), accountId, input, requireIdempotencyKey(key));
  }

  @Get('identity/reviews')
  @RequirePermissions('platform.identity-review.read')
  @AuditAction('admin.identity-reviews.list.request')
  reviews(@Query() query: ListIdentityReviewsDto, @Req() request: HidRequest) {
    return this.admin.listIdentityReviews(requireAdminContext(request), query);
  }

  @Get('audit/events')
  @RequirePermissions('platform.audit.read')
  @AuditAction('admin.audit.list.request')
  audit(@Query() query: ListPlatformAuditDto, @Req() request: HidRequest) {
    return this.admin.listAudit(requireAdminContext(request), query);
  }

  @Get('operations/services')
  @RequirePermissions('platform.operations.read')
  @AuditAction('admin.operations.services.request')
  services(@Req() request: HidRequest) { return this.operations.services(requireAdminContext(request)); }

  @Get('operations/events')
  @RequirePermissions('platform.operations.read')
  @AuditAction('admin.operations.events.request')
  events(@Req() request: HidRequest) { return this.operations.events(requireAdminContext(request)); }

  private expectedVersion(value: string | undefined): number {
    const normalized = value?.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
    const version = normalized ? Number(normalized) : Number.NaN;
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new DomainProblem(428, 'IF_MATCH_REQUIRED', 'If-Match must contain the expected positive version');
    }
    return version;
  }
}
