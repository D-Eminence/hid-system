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
   * Platform administrators only (platform.admin.access and platform.operations.read); X-Facility-ID names the
   * facility read (row-level security), at which the administrator must be active.
   */
  @Get('summary')
  @AuditAction('ocr.quality.summary.request')
  summary(@Query() query: OcrQualitySummaryQueryDto, @Req() request: HidRequest) {
    assertQualityReader(request);
    return this.quality.summary(query, requireRequestContext(request, 'healthcare-operations'));
  }
}
