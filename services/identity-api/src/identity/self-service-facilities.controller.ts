import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { requireAdminContext } from '../admin/admin-context';
import { AuditAction, AuditFailuresOnly, FacilityOptional, RequirePermissions } from '../common/decorators';
import type { HidRequest } from '../common/request-context';
import { EndSelfServiceProbationDto, ListSelfServiceFacilitiesDto, RejectSelfServiceApplicationDto,
  ReleaseSelfServiceFacilityDto, ReviewSelfServiceFacilityDto, SearchSelfServiceApplicationsDto,
  SelfServiceAdministratorRoleDto, WaiveSelfServiceRefusalDto } from './dto/self-service-facility.dto';
import { expectedVersion } from './organization-applications.controller';
import { SelfServiceFacilitiesService } from './self-service-facilities.service';

/**
 * New facility sign-ups for support's daily review (P4 owner guard). The same
 * guards as AdminOrganizationApplicationsController: facility optional (a
 * standalone platform administrator holds no membership), the list's read
 * permission and the reject's write permission, failures audited, and the
 * version taken from If-Match. Novu has no step-up for admin commands.
 */
@Controller('admin/self-service-facilities')
@FacilityOptional()
@AuditFailuresOnly()
export class AdminSelfServiceFacilitiesController {
  constructor(private readonly facilities: SelfServiceFacilitiesService) {}

  @Get()
  @RequirePermissions('platform.identity-review.read')
  @AuditAction('admin.self-service-facilities.list')
  list(@Query() filters: ListSelfServiceFacilitiesDto, @Req() request: HidRequest) {
    return this.facilities.list(requireAdminContext(request), filters.state ?? 'unreviewed');
  }

  /**
   * Support's review (P4b, SPEC 3.5): it gives the facility full access at
   * once, grants the administrator org_admin and the role chosen (with its
   * licence) and signs them out. Needs platform.facility.unlock as well (S13).
   */
  @Post(':applicationId/review')
  @HttpCode(200)
  @RequirePermissions('platform.facility.manage', 'platform.facility.unlock')
  @AuditAction('admin.self-service-facility.review')
  review(@Param('applicationId', new ParseUUIDPipe({ version: '4' })) applicationId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() input: ReviewSelfServiceFacilityDto, @Req() request: HidRequest) {
    return this.facilities.review(requireAdminContext(request), applicationId, expectedVersion(ifMatch), input.note,
      input);
  }

  /** Support changes a reviewed administrator's own access (P4b, S12, SPEC 3.7). */
  @Post(':applicationId/administrator-role')
  @HttpCode(200)
  @RequirePermissions('platform.facility.manage', 'platform.facility.unlock')
  @AuditAction('admin.self-service-facility.administrator-role')
  administratorRole(@Param('applicationId', new ParseUUIDPipe({ version: '4' })) applicationId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() input: SelfServiceAdministratorRoleDto, @Req() request: HidRequest) {
    return this.facilities.setAdministratorRole(requireAdminContext(request), applicationId, expectedVersion(ifMatch),
      input, input.reason);
  }

  /** Support ends a reviewed facility's first 30 days early (P4b, SPEC 3.8). */
  @Post(':applicationId/end-probation')
  @HttpCode(200)
  @RequirePermissions('platform.facility.manage', 'platform.facility.unlock')
  @AuditAction('admin.self-service-facility.probation-end')
  endProbation(@Param('applicationId', new ParseUUIDPipe({ version: '4' })) applicationId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() input: EndSelfServiceProbationDto, @Req() request: HidRequest) {
    return this.facilities.endProbation(requireAdminContext(request), applicationId, expectedVersion(ifMatch),
      input.reason);
  }

  /**
   * Releases a fraudulent self sign-up (P4 review fix R2) once support has
   * suspended its facility and disabled its administrator with the existing
   * commands: the application is closed, the CAC binding removed, the product
   * suspended and the organization deactivated and renamed, so the real
   * company can sign up. Version from If-Match, as review. allowRetry (R15)
   * spares its email and network the 7-day refusal.
   */
  @Post(':applicationId/release')
  @HttpCode(200)
  @RequirePermissions('platform.facility.manage')
  @AuditAction('admin.self-service-facility.release')
  release(@Param('applicationId', new ParseUUIDPipe({ version: '4' })) applicationId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() input: ReleaseSelfServiceFacilityDto, @Req() request: HidRequest) {
    return this.facilities.release(requireAdminContext(request), applicationId, expectedVersion(ifMatch),
      input.reason, input.allowRetry ?? false);
  }
}

/**
 * Open self-service applications (P4 review fix R3): submitted and not yet
 * activated or lapsed. Each holds its CAC and product for 24 hours (none when
 * opened without a hold), so support can see who holds which and close one
 * that is not the company's; those holding a CAC now come first, with the
 * total and a search by CAC number (R16). Support can let the applicant retry
 * or waive a 7-day refusal (R15). The same guards as the facility list and
 * review.
 */
@Controller('admin/self-service-applications')
@FacilityOptional()
@AuditFailuresOnly()
export class AdminSelfServiceApplicationsController {
  constructor(private readonly facilities: SelfServiceFacilitiesService) {}

  @Get()
  @RequirePermissions('platform.identity-review.read')
  @AuditAction('admin.self-service-applications.list')
  list(@Req() request: HidRequest) {
    return this.facilities.listOpenApplications(requireAdminContext(request));
  }

  /**
   * The same list for one CAC number (R16), with the number in the body, out
   * of the request lines that access logs keep, as principals/search does.
   */
  @Post('search')
  @HttpCode(200)
  @RequirePermissions('platform.identity-review.read')
  @AuditAction('admin.self-service-applications.list')
  search(@Body() input: SearchSelfServiceApplicationsDto, @Req() request: HidRequest) {
    return this.facilities.listOpenApplications(requireAdminContext(request), input.cacRegistrationNumber);
  }

  /**
   * Lifts the 7-day refusals a rejection or release set for a CAC number and
   * product (R15), for a company whose own email or network they refused.
   * No version: it lifts whatever refusal is in force, and lifting is idempotent
   * in effect (a second call answers 404 SELF_SERVICE_REFUSAL_NOT_FOUND).
   */
  @Post('waive-refusal')
  @HttpCode(200)
  @RequirePermissions('platform.facility.manage')
  @AuditAction('admin.self-service-application.refusal-waive')
  waiveRefusal(@Body() input: WaiveSelfServiceRefusalDto, @Req() request: HidRequest) {
    return this.facilities.waiveRefusals(requireAdminContext(request), input.cacRegistrationNumber,
      input.productCode, input.reason);
  }

  @Post(':applicationId/reject')
  @HttpCode(200)
  @RequirePermissions('platform.facility.manage')
  @AuditAction('admin.self-service-application.reject')
  reject(@Param('applicationId', new ParseUUIDPipe({ version: '4' })) applicationId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() input: RejectSelfServiceApplicationDto, @Req() request: HidRequest) {
    return this.facilities.rejectOpenApplication(requireAdminContext(request), applicationId,
      expectedVersion(ifMatch), input.reason, input.allowRetry ?? false);
  }
}
