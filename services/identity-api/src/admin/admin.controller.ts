import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuditAction, AuditFailuresOnly, FacilityOptional, RequirePermissions } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { requireAdminContext } from './admin-context';
import { AdminOperationsService } from './admin-operations.service';
import { AdminService } from './admin.service';
import { PricingService } from './pricing.service';
import { PricePricingCommandDto, ProductPricingCommandDto } from './dto/pricing-command.dto';
import { AccountStatusCommandDto, FacilityStatusCommandDto, PlatformControlCommandDto, PlatformRoleCommandDto,
  RevokeSessionsCommandDto } from './dto/admin-command.dto';
import { ExportPrincipalsDto, ListFacilitiesDto, ListIdentityReviewsDto, ListPlatformAuditDto,
  ListPrincipalsDto } from './dto/admin-list.dto';

@Controller('admin')
@FacilityOptional()
export class AdminController {
  constructor(private readonly admin: AdminService, private readonly operations: AdminOperationsService,
    private readonly pricing: PricingService) {}

  @Get('session')
  @RequirePermissions('platform.admin.access')
  @AuditAction('admin.session.read.request')
  session(@Req() request: HidRequest) { return this.admin.session(requireAdminContext(request)); }

  @Get('overview')
  @RequirePermissions('platform.admin.access')
  @AuditAction('admin.overview.read.request')
  overview(@Req() request: HidRequest) { return this.admin.overview(requireAdminContext(request)); }


  @Get('controls')
  @RequirePermissions('platform.control.read')
  @AuditAction('admin.platform-controls.list.request')
  controls(@Req() request: HidRequest) {
    return this.admin.platformControls(requireAdminContext(request));
  }

  @Get('imported-configuration')
  @RequirePermissions('platform.admin.access')
  @AuditAction('admin.imported-configuration.read.request')
  importedConfiguration(@Req() request: HidRequest) {
    return this.admin.importedConfiguration(requireAdminContext(request));
  }

  @Post('controls')
  @RequirePermissions('platform.control.manage')
  @AuditAction('admin.platform-control.change.request')
  setControl(@Headers('if-match') ifMatch: string | undefined, @Body() input: PlatformControlCommandDto,
    @Req() request: HidRequest) {
    return this.admin.setPlatformControl(requireAdminContext(request), input, this.expectedVersion(ifMatch));
  }

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

  @Get('principals/export')
  @RequirePermissions('platform.principal.read')
  @AuditAction('admin.principals.export.request')
  async exportPrincipals(@Query() query: ExportPrincipalsDto, @Req() request: HidRequest, @Res() response: Response) {
    const csv = await this.admin.exportPrincipals(requireAdminContext(request), query);
    response.status(200).type('text/csv').setHeader('Content-Disposition', 'attachment; filename="hid-principals.csv"').send(csv);
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

  @Get('pricing')
  @RequirePermissions('platform.pricing.read')
  @AuditAction('admin.pricing.list.request')
  pricingCatalog(@Req() request: HidRequest) {
    return this.pricing.adminCatalog(requireAdminContext(request));
  }

  @Post('pricing/products/:productSlug')
  @RequirePermissions('platform.pricing.manage')
  @AuditAction('admin.pricing.product.update.request')
  @AuditFailuresOnly()
  updateProduct(@Param('productSlug') slug: string, @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined, @Body() input: ProductPricingCommandDto,
    @Req() request: HidRequest) {
    return this.pricing.updateProduct(requireAdminContext(request), slug, this.expectedVersion(ifMatch),
      input, requireIdempotencyKey(key));
  }

  @Post('pricing/products/:productSlug/prices/:context')
  @RequirePermissions('platform.pricing.manage')
  @AuditAction('admin.pricing.price.update.request')
  @AuditFailuresOnly()
  updatePrice(@Param('productSlug') slug: string, @Param('context') priceContext: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') key: string | undefined, @Body() input: PricePricingCommandDto,
    @Req() request: HidRequest) {
    return this.pricing.updatePrice(requireAdminContext(request), slug, priceContext,
      this.expectedVersion(ifMatch), input, requireIdempotencyKey(key));
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
