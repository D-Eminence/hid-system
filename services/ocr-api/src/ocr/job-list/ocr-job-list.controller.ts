import { Controller, Get, Query, Req } from '@nestjs/common';
import { AuditAction, RequirePermissions } from '../../common/decorators';
import { requireRequestContext, type HidRequest } from '../../common/request-context';
import { OcrJobListQueryDto } from './ocr-job-list.dto';
import { OcrJobListService } from './ocr-job-list.service';

/**
 * GET /api/v1/ocr/job-list (SX-9): the X-Facility-ID facility's OCR jobs,
 * for a member holding ocr.job.read there. Its own path, apart from
 * ocr/jobs/:jobId, so no list word is ever read as a job id.
 */
@Controller('ocr')
export class OcrJobListController {
  constructor(private readonly jobs: OcrJobListService) {}

  @Get('job-list')
  @RequirePermissions('ocr.job.read')
  @AuditAction('ocr.job.list.request')
  list(@Query() query: OcrJobListQueryDto, @Req() request: HidRequest) {
    return this.jobs.list(query, requireRequestContext(request, 'healthcare-operations'));
  }
}
