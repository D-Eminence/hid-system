import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { AuditAction, AuditFailuresOnly, FacilityOptional, RequirePermissions } from '../common/decorators';
import type { HidRequest } from '../common/request-context';
import { expectedVersion } from '../identity/organization-applications.controller';
import { requireAdminContext } from './admin-context';
import { CloseOrderRouteDto, FindOrderRoutesDto, FindOrderRoutesQueryDto, ListWrongPatientReportsQueryDto,
  ReviewWrongPatientReportDto, SetOrderRouteDestinationDto } from './dto/order-route-admin.dto';
import { AdminOrderRoutesService } from './order-routes.service';

const uuid = () => new ParseUUIDPipe({ version: '4' });

/**
 * Support's reads of orders between facilities (P4c, SPEC-FINAL §10.4): a
 * facility's summary and the lookup. A standalone platform administrator
 * works (facility optional); success and failure are audited by the
 * interceptor, as support's other reads that can name patients' routes.
 */
@Controller('admin')
@FacilityOptional()
export class AdminOrderRouteReadsController {
  constructor(private readonly routes: AdminOrderRoutesService) {}

  @Get('facilities/:facilityId/order-route-summary')
  @RequirePermissions('platform.admin.access', 'platform.facility.read')
  @AuditAction('admin.order-route-summary.read')
  summary(@Param('facilityId', uuid()) facilityId: string, @Req() request: HidRequest) {
    return this.routes.summary(requireAdminContext(request), facilityId);
  }

  /**
   * By reference only. A healthId in the URL is refused 400 before this
   * route runs (health-id-in-url.ts, CODEX §26): by Health ID is the POST.
   */
  @Get('order-routes')
  @RequirePermissions('platform.admin.access', 'platform.principal.read')
  @AuditAction('admin.order-routes.find')
  find(@Query() query: FindOrderRoutesQueryDto, @Req() request: HidRequest) {
    return this.routes.find(requireAdminContext(request), query.reference || undefined, undefined);
  }

  /**
   * The lookup with the reference or the Health ID in the body, so the
   * patient's Health ID is in no request line the gateway, an edge or a
   * browser's history keeps (CODEX §26, as POST principals/search). Same
   * permissions, audit action and answer as the GET.
   */
  @Post('order-routes/search')
  @HttpCode(200)
  @RequirePermissions('platform.admin.access', 'platform.principal.read')
  @AuditAction('admin.order-routes.find')
  search(@Body() input: FindOrderRoutesDto, @Req() request: HidRequest) {
    return this.routes.find(requireAdminContext(request), input.reference || undefined, input.healthId || undefined);
  }

  /**
   * Support's "Wrong-patient reports" (C26, item 3 §5.2, D11): the unreviewed
   * ones, flagged first, or the last 90 days'; optionally of one receiving
   * facility. No patient and no order content; the reporter's note is shown
   * to support only (D7). The Overview tile counts the unreviewed list.
   */
  @Get('wrong-patient-reports')
  @RequirePermissions('platform.admin.access', 'platform.facility.read')
  @AuditAction('admin.wrong-patient-reports.list')
  wrongPatientReports(@Query() query: ListWrongPatientReportsQueryDto, @Req() request: HidRequest) {
    return this.routes.listWrongPatientReports(requireAdminContext(request), query.status, query.facilityId);
  }
}

/**
 * Support's writes (P4c, SPEC-FINAL §10.4): listing a facility for orders and
 * closing a route. Their platform rows come from the commands, so the
 * interceptor audits failures only, as P4b's admin commands.
 */
@Controller('admin')
@FacilityOptional()
@AuditFailuresOnly()
export class AdminOrderRouteCommandsController {
  constructor(private readonly routes: AdminOrderRoutesService) {}

  @Post('facilities/:facilityId/order-destination')
  @HttpCode(200)
  @RequirePermissions('platform.admin.access', 'platform.facility.manage', 'platform.facility.unlock')
  @AuditAction('admin.order-route-destination.set')
  setDestination(@Param('facilityId', uuid()) facilityId: string, @Body() input: SetOrderRouteDestinationDto,
    @Req() request: HidRequest) {
    return this.routes.setDestination(requireAdminContext(request), facilityId, input.listed, input.reason);
  }

  @Post('order-routes/:routeId/close')
  @HttpCode(200)
  @RequirePermissions('platform.admin.access', 'platform.facility.manage')
  @AuditAction('admin.order-route.close')
  close(@Param('routeId', uuid()) routeId: string, @Headers('if-match') ifMatch: string | undefined,
    @Body() input: CloseOrderRouteDto, @Req() request: HidRequest) {
    return this.routes.close(requireAdminContext(request), routeId, expectedVersion(ifMatch), input.reason);
  }

  /**
   * Mark a wrong-patient report reviewed, once (C27, item 3 §5.2): what
   * support did, a note, and optionally the reporter's note replaced by fixed
   * text. If-Match carries the report's version. The command writes the
   * platform row (admin.wrong-patient-report.review, the review note as its
   * reason), so the interceptor audits failures only.
   */
  @Post('wrong-patient-reports/:reportId/review')
  @HttpCode(200)
  @RequirePermissions('platform.admin.access', 'platform.facility.manage')
  @AuditAction('admin.wrong-patient-report.review')
  reviewWrongPatientReport(@Param('reportId', uuid()) reportId: string, @Headers('if-match') ifMatch: string | undefined,
    @Body() input: ReviewWrongPatientReportDto, @Req() request: HidRequest) {
    return this.routes.reviewWrongPatientReport(requireAdminContext(request), reportId, expectedVersion(ifMatch), input);
  }
}
