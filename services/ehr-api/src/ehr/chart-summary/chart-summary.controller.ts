import { Controller, Get, Header, Param, ParseUUIDPipe, Req } from '@nestjs/common';
import { RequireAnyPermission } from '../../common/decorators';
import { requireRequestContext, type HidRequest } from '../../common/request-context';
import { clinicalContext } from '../shared/clinical-context';
import { CHART_SUMMARY_ROUTE_PERMISSIONS, ChartSummaryService } from './chart-summary.service';

/**
 * EHR-C4: the chart summary (GET ehr/patients/:patientId/chart-summary).
 * patientId is the patient's UUID, never a Health ID. Open to anyone who may
 * read at least one EHR section; each section is then included only when the
 * caller holds that section's own permission. X-Purpose-Of-Use is direct-care
 * (the per-section routes' purpose) or emergency (the emergency read's).
 */
@Controller('ehr/patients/:patientId')
export class ChartSummaryController {
  constructor(private readonly summary: ChartSummaryService) {}

  @Get('chart-summary')
  @Header('Cache-Control', 'no-store')
  @RequireAnyPermission(...CHART_SUMMARY_ROUTE_PERMISSIONS)
  read(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string) {
    const context = request.header('x-purpose-of-use') === 'emergency'
      ? requireRequestContext(request, 'emergency')
      : clinicalContext(request);
    return this.summary.read(context, patientId);
  }
}
