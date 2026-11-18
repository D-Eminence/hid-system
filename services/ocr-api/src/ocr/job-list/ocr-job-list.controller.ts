import { Controller, Get, Query, Req, UseInterceptors } from '@nestjs/common';
import { AuditAction, RequirePermissions } from '../../common/decorators';
import { requireRequestContext, type HidRequest } from '../../common/request-context';
import { AuditPurposeInterceptor } from './audit-purpose.interceptor';
import { OcrJobListQueryDto } from './ocr-job-list.dto';
import { OcrJobListService } from './ocr-job-list.service';

/**
 * GET /api/v1/ocr/job-list (SX-9): the X-Facility-ID facility's OCR jobs,
 * for a member holding ocr.job.read there. Its own path, apart from
 * ocr/jobs/:jobId, so no list word is ever read as a job id. Always read
 * under healthcare-operations, and the request-level audit row
 * (api.ocr.job.list.request) records that purpose, not the browser's header.
 */
@Controller('ocr')
export class OcrJobListController {
  constructor(private readonly jobs: OcrJobListService) {}

  @Get('job-list')
  @RequirePermissions('ocr.job.read')
  @AuditAction('ocr.job.list.request')
  @UseInterceptors(new AuditPurposeInterceptor('healthcare-operations'))
  list(@Query() query: OcrJobListQueryDto, @Req() request: HidRequest) {
    return this.jobs.list(query, requireRequestContext(request, 'healthcare-operations'));
  }
}
