import {
  Body, Controller, Get, Header, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { requireIdempotencyKey } from '../../common/idempotency';
import { DomainProblem } from '../../common/problem';
import { requireRequestContext, type DataAccessContext, type HidRequest } from '../../common/request-context';
import {
  QualityActionAddDto, QualityActionUpdateDto, QualityAssignDto, QualityCorrectionDto, QualityCountsQueryDto,
  QualityInvestigationDto, QualityLeadEndDto, QualityLeadNameDto, QualityListQueryDto, QualityReopenDto,
  QualityReportDto, QualityResolveDto,
} from './quality.dto';
import {
  QUALITY_MESSAGES, QualityService, notAvailable, qualityEnabled, requireQualityAccess, type QualityAccess,
} from './quality.service';

/**
 * The context of a quality route: the service flag first (503
 * QUALITY_NOT_AVAILABLE while it is off, before anything else), then the
 * purpose healthcare-operations, then the session's codes at this facility
 * (403 in plain words). The database checks all of it again (a manager by
 * quality.incident.manage or a named quality lead row) and audits.
 */
export function qualityContext(request: HidRequest, access: QualityAccess = 'report'): DataAccessContext {
  if (!qualityEnabled()) throw notAvailable();
  const purpose = request.header('x-purpose-of-use');
  if (purpose !== 'healthcare-operations') {
    throw new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED', QUALITY_MESSAGES.purposeRequired);
  }
  const context = requireRequestContext(request, purpose);
  requireQualityAccess(request, access);
  return context;
}

const uuid = () => new ParseUUIDPipe();

/**
 * QUAL-1 (0197, 0198): quality and safety reporting at this facility. Any
 * staff member reports; the facility administrator roles and named quality
 * leads manage; the reviewer a manager assigns investigates (owner decisions
 * Q248 A-Q253 A; Q-QUAL-1 A to Q-QUAL-8 A at the recommended option). No
 * Health ID or NIN in any path, query or answer: incidents, actions and leads
 * by UUID; the patient by UUID in a body only.
 */
@Controller('ehr/quality')
export class QualityController {
  constructor(private readonly quality: QualityService) {}

  /** Route 1: what this member can do here, and the lists. */
  @Get('me')
  @Header('Cache-Control', 'no-store')
  me(@Req() request: HidRequest) {
    return this.quality.me(qualityContext(request));
  }

  /** Route 2: file a report. */
  @Post('incidents')
  @HttpCode(201)
  report(@Req() request: HidRequest, @Headers('idempotency-key') key: string | undefined,
    @Body() input: QualityReportDto) {
    const context = qualityContext(request);
    return this.quality.report(context, input, requireIdempotencyKey(key));
  }

  /** Route 3: the list. */
  @Get('incidents')
  @Header('Cache-Control', 'no-store')
  list(@Req() request: HidRequest, @Query() query: QualityListQueryDto) {
    return this.quality.list(qualityContext(request), query);
  }

  /** Route 4: one incident in this member's view. */
  @Get('incidents/:incidentId')
  @Header('Cache-Control', 'no-store')
  read(@Req() request: HidRequest, @Param('incidentId', uuid()) incidentId: string) {
    return this.quality.read(qualityContext(request), incidentId);
  }

  /** Route 5 (manager): choose the reviewer. */
  @Post('incidents/:incidentId/assign')
  @HttpCode(200)
  assign(@Req() request: HidRequest, @Param('incidentId', uuid()) incidentId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: QualityAssignDto) {
    const context = qualityContext(request);
    return this.quality.assign(context, incidentId, input, requireIdempotencyKey(key));
  }

  /** Route 6 (the reviewer or a manager): the investigation. */
  @Post('incidents/:incidentId/investigation')
  @HttpCode(200)
  investigate(@Req() request: HidRequest, @Param('incidentId', uuid()) incidentId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: QualityInvestigationDto) {
    const context = qualityContext(request);
    return this.quality.investigate(context, incidentId, input, requireIdempotencyKey(key));
  }

  /** Route 7 (the reviewer or a manager): a corrective action. */
  @Post('incidents/:incidentId/actions')
  @HttpCode(201)
  addAction(@Req() request: HidRequest, @Param('incidentId', uuid()) incidentId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: QualityActionAddDto) {
    const context = qualityContext(request);
    return this.quality.addAction(context, incidentId, input, requireIdempotencyKey(key));
  }

  /** Route 8 (the reviewer or a manager): change a corrective action. */
  @Post('incidents/:incidentId/actions/:actionId')
  @HttpCode(200)
  updateAction(@Req() request: HidRequest, @Param('incidentId', uuid()) incidentId: string,
    @Param('actionId', uuid()) actionId: string, @Headers('idempotency-key') key: string | undefined,
    @Body() input: QualityActionUpdateDto) {
    const context = qualityContext(request);
    return this.quality.updateAction(context, incidentId, actionId, input, requireIdempotencyKey(key));
  }

  /** Route 9 (manager): resolve. */
  @Post('incidents/:incidentId/resolve')
  @HttpCode(200)
  resolve(@Req() request: HidRequest, @Param('incidentId', uuid()) incidentId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: QualityResolveDto) {
    const context = qualityContext(request);
    return this.quality.resolve(context, incidentId, input, requireIdempotencyKey(key));
  }

  /** Route 10 (manager): reopen, with a reason. */
  @Post('incidents/:incidentId/reopen')
  @HttpCode(200)
  reopen(@Req() request: HidRequest, @Param('incidentId', uuid()) incidentId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: QualityReopenDto) {
    const context = qualityContext(request);
    return this.quality.reopen(context, incidentId, input, requireIdempotencyKey(key));
  }

  /** Route 11 (manager): correct the classification or the patient link, with a reason. */
  @Post('incidents/:incidentId/correction')
  @HttpCode(200)
  correct(@Req() request: HidRequest, @Param('incidentId', uuid()) incidentId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: QualityCorrectionDto) {
    const context = qualityContext(request);
    return this.quality.correct(context, incidentId, input, requireIdempotencyKey(key));
  }

  /** Route 12 (manager): the monthly de-identified count, as JSON or (format=csv) a CSV file. */
  @Get('incident-counts')
  @Header('Cache-Control', 'no-store')
  async counts(@Req() request: HidRequest, @Query() query: QualityCountsQueryDto,
    @Res({ passthrough: true }) response: Response) {
    const context = qualityContext(request);
    if (query.format !== 'csv') return this.quality.counts(context, query);
    const file = await this.quality.countsFile(context, query);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    return file.csv;
  }

  /** Route 13 (manager): the active quality leads. */
  @Get('leads')
  @Header('Cache-Control', 'no-store')
  leads(@Req() request: HidRequest) {
    return this.quality.leads(qualityContext(request));
  }

  /** Route 14 (quality.incident.manage): name a quality lead. */
  @Post('leads')
  @HttpCode(201)
  nameLead(@Req() request: HidRequest, @Headers('idempotency-key') key: string | undefined,
    @Body() input: QualityLeadNameDto) {
    const context = qualityContext(request, 'leads');
    return this.quality.nameLead(context, input, requireIdempotencyKey(key));
  }

  /** Route 15 (quality.incident.manage): end a quality lead, with a reason; the row is kept. */
  @Post('leads/:leadId/end')
  @HttpCode(200)
  endLead(@Req() request: HidRequest, @Param('leadId', uuid()) leadId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: QualityLeadEndDto) {
    const context = qualityContext(request, 'leads');
    return this.quality.endLead(context, leadId, input, requireIdempotencyKey(key));
  }
}
