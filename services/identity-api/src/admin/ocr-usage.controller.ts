import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Put, Query, Req } from '@nestjs/common';
import { AuditAction, AuditFailuresOnly, FacilityOptional, RequirePermissions } from '../common/decorators';
import type { HidRequest } from '../common/request-context';
import { requireAdminContext } from './admin-context';
import { OcrPageLimitCommandDto, OcrUsageQueryDto } from './dto/ocr-usage.dto';
import { AdminOcrUsageService } from './ocr-usage.service';

/**
 * A facility's OCR page allowance and monthly use (migration 0107) in the admin console. The same guards as
 * AdminOrganizationApplicationsController (0103): facility optional (a standalone platform administrator holds
 * no membership), failures audited here and successes by the database. Any platform administrator may read;
 * only a platform super admin may change the limit (a cost decision), which the database enforces too.
 */
@Controller('admin/facilities')
@FacilityOptional()
@AuditFailuresOnly()
export class AdminOcrUsageController {
  constructor(private readonly usage: AdminOcrUsageService) {}

  @Get(':facilityId/ocr-usage')
  @RequirePermissions('platform.admin.access')
  @AuditAction('admin.ocr.usage.read')
  read(@Param('facilityId', new ParseUUIDPipe()) facilityId: string, @Query() query: OcrUsageQueryDto,
    @Req() request: HidRequest) {
    return this.usage.usage(requireAdminContext(request), facilityId, query.month);
  }

  @Put(':facilityId/ocr-page-limit')
  @HttpCode(204)
  @RequirePermissions('platform.admin.access')
  @AuditAction('admin.ocr.page-limit.set')
  async setPageLimit(@Param('facilityId', new ParseUUIDPipe()) facilityId: string,
    @Body() input: OcrPageLimitCommandDto, @Req() request: HidRequest): Promise<void> {
    await this.usage.setPageLimit(requireAdminContext(request), facilityId, input);
  }
}
