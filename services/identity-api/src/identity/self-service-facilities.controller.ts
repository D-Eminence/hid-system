import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { requireAdminContext } from '../admin/admin-context';
import { AuditAction, AuditFailuresOnly, FacilityOptional, RequirePermissions } from '../common/decorators';
import type { HidRequest } from '../common/request-context';
import { ListSelfServiceFacilitiesDto, RejectSelfServiceApplicationDto, ReleaseSelfServiceFacilityDto,
  ReviewSelfServiceFacilityDto } from './dto/self-service-facility.dto';
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

  @Post(':applicationId/review')
  @HttpCode(200)
  @RequirePermissions('platform.facility.manage')
  @AuditAction('admin.self-service-facility.review')
  review(@Param('applicationId', new ParseUUIDPipe({ version: '4' })) applicationId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() input: ReviewSelfServiceFacilityDto, @Req() request: HidRequest) {
    return this.facilities.review(requireAdminContext(request), applicationId, expectedVersion(ifMatch), input.note);
  }

  /**
   * Releases a fraudulent self sign-up (P4 review fix R2) once support has
   * suspended its facility and disabled its administrator with the existing
   * commands: the application is closed, the CAC binding removed, the product
   * suspended and the organization deactivated and renamed, so the real
   * company can sign up. Version from If-Match, as review.
   */
  @Post(':applicationId/release')
  @HttpCode(200)
  @RequirePermissions('platform.facility.manage')
  @AuditAction('admin.self-service-facility.release')
  release(@Param('applicationId', new ParseUUIDPipe({ version: '4' })) applicationId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() input: ReleaseSelfServiceFacilityDto, @Req() request: HidRequest) {
    return this.facilities.release(requireAdminContext(request), applicationId, expectedVersion(ifMatch),
      input.reason);
  }
}

/**
 * Open self-service applications (P4 review fix R3): submitted and not yet
 * activated or lapsed. Each holds its CAC and product for 24 hours, so
 * support can see who holds which and close one that is not the company's.
 * The same guards as the facility list and review.
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

  @Post(':applicationId/reject')
  @HttpCode(200)
  @RequirePermissions('platform.facility.manage')
  @AuditAction('admin.self-service-application.reject')
  reject(@Param('applicationId', new ParseUUIDPipe({ version: '4' })) applicationId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() input: RejectSelfServiceApplicationDto, @Req() request: HidRequest) {
    return this.facilities.rejectOpenApplication(requireAdminContext(request), applicationId,
      expectedVersion(ifMatch), input.reason);
  }
}
