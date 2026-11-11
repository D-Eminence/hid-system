import { Controller, Get, Query, Req } from '@nestjs/common';
import { AuditAction } from '../../common/decorators';
import { requireRequestContext, type HidRequest } from '../../common/request-context';
import { OcrQualitySummaryQueryDto } from './quality-summary.dto';
import { assertQualityReader, OcrQualityService } from './quality-summary.service';

@Controller('ocr/quality')
export class OcrQualityController {
  constructor(private readonly quality: OcrQualityService) {}

  /**
   * Review outcomes summed by ISO week, facility, item kind and prompt version; groups under 20 suppressed.
   * Platform administrators (platform.admin.access and platform.operations.read), or the facility's own manager
   * (workforce.manage at that facility, not awaiting support's review); X-Facility-ID names the facility read
   * (row-level security), at which the reader must be active. A manager gets { available: false, reason:
   * 'too_few_reviewers' } unless at least 3 distinct reviewers contributed in the range, and a manager's groups with
   * fewer than 3 reviewers are suppressed; a manager sees finished ISO weeks only (no staff monitoring).
   */
  @Get('summary')
  @AuditAction('ocr.quality.summary.request')
  summary(@Query() query: OcrQualitySummaryQueryDto, @Req() request: HidRequest) {
    const reader = assertQualityReader(request);
    return this.quality.summary(query, requireRequestContext(request, 'healthcare-operations'), reader);
  }
}
