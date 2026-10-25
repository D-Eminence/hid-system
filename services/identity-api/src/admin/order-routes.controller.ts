import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { AuditAction, AuditFailuresOnly, FacilityOptional, RequirePermissions } from '../common/decorators';
import type { HidRequest } from '../common/request-context';
import { expectedVersion } from '../identity/organization-applications.controller';
import { requireAdminContext } from './admin-context';
import { CloseOrderRouteDto, FindOrderRoutesDto, SetOrderRouteDestinationDto } from './dto/order-route-admin.dto';
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

  /** By reference, or (deprecated, CODEX §26) by a Health ID in the query: the console moves to the POST. */
  @Get('order-routes')
  @RequirePermissions('platform.admin.access', 'platform.principal.read')
  @AuditAction('admin.order-routes.find')
  find(@Query() query: FindOrderRoutesDto, @Req() request: HidRequest) {
    return this.routes.find(requireAdminContext(request), query.reference || undefined, query.healthId || undefined);
  }

  /**
   * The lookup with the reference or the Health ID in the body, so the
   * patient's Health ID is in no request line the gateway or an edge logs
   * (CODEX §26, as POST principals/search). Same permissions, audit action
   * and answer as the GET.
   */
  @Post('order-routes/search')
  @HttpCode(200)
  @RequirePermissions('platform.admin.access', 'platform.principal.read')
  @AuditAction('admin.order-routes.find')
  search(@Body() input: FindOrderRoutesDto, @Req() request: HidRequest) {
    return this.routes.find(requireAdminContext(request), input.reference || undefined, input.healthId || undefined);
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
}
