import { Body, Controller, Get, HttpCode, Put, Query, Req } from '@nestjs/common';
import { AuditAction, AuditFailuresOnly, FacilityOptional, RequirePermissions } from '../common/decorators';
import type { HidRequest } from '../common/request-context';
import { requireAdminContext } from './admin-context';
import { OcrLearningSwitchCommandDto, OcrQualitySummaryQueryDto } from './dto/ocr-learning.dto';
import { AdminOcrLearningService } from './ocr-learning.service';

/**
 * OCR learning in the admin console (migration 0119; owner decision Q43 of 2026-11-11). The same guards as
 * AdminOcrUsageController: facility optional (a standalone platform administrator holds no membership), failures
 * audited here and successes by the database.
 */
@Controller('admin/ocr')
@FacilityOptional()
@AuditFailuresOnly()
export class AdminOcrLearningController {
  constructor(private readonly learning: AdminOcrLearningService) {}

  /** Every facility's review outcomes (phase 1), aggregate only; groups under 20 suppressed. */
  @Get('quality-summary')
  @RequirePermissions('platform.admin.access', 'platform.operations.read')
  @AuditAction('admin.ocr.quality-summary.read')
  qualitySummary(@Query() query: OcrQualitySummaryQueryDto, @Req() request: HidRequest) {
    return this.learning.qualitySummary(requireAdminContext(request), query);
  }

  /** Rule counts and the switch of each rule set (the platform's, and each facility's with a rule or a switch). */
  @Get('learning')
  @RequirePermissions('platform.admin.access')
  @AuditAction('admin.ocr.learning.read')
  overview(@Req() request: HidRequest) {
    return this.learning.overview(requireAdminContext(request));
  }

  /** The owner kill switch of a rule set (platform super admin only). */
  @Put('learning-switches')
  @HttpCode(204)
  @RequirePermissions('platform.admin.access')
  @AuditAction('admin.ocr.learning-switch.set')
  async setSwitch(@Body() input: OcrLearningSwitchCommandDto, @Req() request: HidRequest): Promise<void> {
    await this.learning.setSwitch(requireAdminContext(request), input);
  }
}
