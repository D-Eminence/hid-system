import { Body, Controller, Get, Header, HttpCode, Post, Query, Req } from '@nestjs/common';
import { AuditAction } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import { requireRequestContext, type DataAccessContext, type HidRequest } from '../common/request-context';
import { ReportExportDto, ReportRangeQueryDto } from './reports.dto';
import { REPORT_MESSAGES, ReportsService, requireReportAccess, type ReportAccess } from './reports.service';

/**
 * A report route's context: the session's report codes at this facility (403 in plain words), then the purpose,
 * healthcare-operations only (as GET /audit/events). The switches are not checked here: the sealed demo and QA
 * facilities have both routes whatever they say, so the database decides from the value the service passes and the
 * facility's seal (503 REPORTS_NOT_AVAILABLE or REPORTS_EXPORT_NOT_AVAILABLE).
 */
function reportContext(request: HidRequest, access: ReportAccess): DataAccessContext {
  requireReportAccess(request, access);
  const purpose = request.header('x-purpose-of-use');
  if (purpose !== 'healthcare-operations') {
    throw new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED', REPORT_MESSAGES.purpose);
  }
  return requireRequestContext(request, purpose);
}

/**
 * REP-1 (0203, 0204): the facility's operations report, for its administrators (reports.read, reports.export;
 * owner decision Q240 A). The session's facility only (Q241 A); totals only, no patient (Q239 A); worked out on demand
 * from live data over at most 92 Lagos days (Q237 A). Each call is in ehr-api's request audit (refusals included) and
 * writes its own audit row in the database. No route takes a facility id, a patient id, a Health ID or a NIN.
 */
@Controller('ehr/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** Route 1: the report, as the screen shows it. */
  @Get('operations')
  @Header('Cache-Control', 'no-store')
  @AuditAction('ehr.reports.operations.request')
  read(@Req() request: HidRequest, @Query() query: ReportRangeQueryDto) {
    return this.reports.read(reportContext(request, 'read'), query.from, query.to);
  }

  /** Route 2: a download (CSV or PDF, built by the browser from this answer only), recorded; no Idempotency-Key. */
  @Post('operations/exports')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @AuditAction('ehr.reports.operations.export.request')
  export(@Req() request: HidRequest, @Body() body: ReportExportDto) {
    return this.reports.export(reportContext(request, 'export'), body.from, body.to, body.format);
  }
}
