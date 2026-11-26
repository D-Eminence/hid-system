import {
  Body, Controller, Get, Header, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req,
} from '@nestjs/common';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { clinicalContext, requireIdempotencyKey } from '../shared/clinical-context';
import {
  DentalChartErrorDto, DentalChartQueryDto, DentalChartSaveDto, DentalFollowUpDto, DentalProcedureDoneDto,
  DentalProcedureReasonDto, DentalProcedureRecordDto, DentalProceduresQueryDto, DentalVisitsQueryDto,
} from './dental.dto';
import { DENTAL_MESSAGES, DentalService, dentalEnabled, notAvailable, requireDentalAccess } from './dental.service';

/**
 * The context of a dental route: the service flag first (503
 * DENTAL_NOT_AVAILABLE while it is off), then direct care, then the session's
 * dental code at this facility (403 in plain words). The database checks all
 * of it again, with the patient's consent and the visit, and audits.
 */
function dentalContext(request: HidRequest, access: 'read' | 'write'): DataAccessContext {
  if (!dentalEnabled()) throw notAvailable();
  const context = clinicalContext(request);
  requireDentalAccess(request, access);
  return context;
}

/** Route 2's body is `{}`: any field is refused, as the global pipe refuses an unknown field. */
function emptyBody(body: unknown): void {
  if (body !== undefined && body !== null
      && (typeof body !== 'object' || Array.isArray(body) || Object.keys(body as object).length > 0)) {
    throw new DomainProblem(400, 'VALIDATION_FAILED', DENTAL_MESSAGES.validation,
      Object.keys(typeof body === 'object' && body !== null ? body : {}).map((field) => ({
        field, messages: [`property ${field} should not exist`] })));
  }
}

const uuid = () => new ParseUUIDPipe();

/**
 * DEN-1 (0194, 0195): the dental clinic on an ordinary outpatient visit.
 * Dentists only (Q-DEN-1 A). No Health ID or NIN in any path, query or
 * answer: patients, visits, chart versions and procedures by UUID.
 */
@Controller('ehr')
export class DentalController {
  constructor(private readonly dental: DentalService) {}

  /** Route 1: the active dental lists, and whether photos may be attached. */
  @Get('dental/lists')
  @Header('Cache-Control', 'no-store')
  lists(@Req() request: HidRequest) {
    return this.dental.lists(dentalContext(request, 'read'));
  }

  /** Route 2: start the dental record on this outpatient visit. */
  @Post('patients/:patientId/encounters/:encounterId/dental-visit')
  @HttpCode(201)
  startVisit(@Req() request: HidRequest, @Param('patientId', uuid()) patientId: string,
    @Param('encounterId', uuid()) encounterId: string, @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown) {
    const context = dentalContext(request, 'write');
    emptyBody(body);
    return this.dental.startVisit(context, patientId, encounterId, requireIdempotencyKey(key));
  }

  /** Route 3: the visit's dental record. */
  @Get('patients/:patientId/encounters/:encounterId/dental-visit')
  @Header('Cache-Control', 'no-store')
  readVisit(@Req() request: HidRequest, @Param('patientId', uuid()) patientId: string,
    @Param('encounterId', uuid()) encounterId: string) {
    return this.dental.readVisit(dentalContext(request, 'read'), patientId, encounterId);
  }

  /** Route 4: the follow-up date and recall note (also after the visit is completed). */
  @Patch('patients/:patientId/encounters/:encounterId/dental-visit')
  @HttpCode(200)
  followUp(@Req() request: HidRequest, @Param('patientId', uuid()) patientId: string,
    @Param('encounterId', uuid()) encounterId: string, @Headers('idempotency-key') key: string | undefined,
    @Body() input: DentalFollowUpDto) {
    const context = dentalContext(request, 'write');
    return this.dental.followUp(context, patientId, encounterId, input, requireIdempotencyKey(key));
  }

  /** Route 5: this facility's dental visits of the last 1-30 Lagos days (default today). */
  @Get('dental-visits')
  @Header('Cache-Control', 'no-store')
  listVisits(@Req() request: HidRequest, @Query() query: DentalVisitsQueryDto) {
    return this.dental.listVisits(dentalContext(request, 'read'), query.days ?? 1);
  }

  /** Route 6: the newest chart at this facility (or one version) and the versions. */
  @Get('patients/:patientId/dental-chart')
  @Header('Cache-Control', 'no-store')
  readChart(@Req() request: HidRequest, @Param('patientId', uuid()) patientId: string,
    @Query() query: DentalChartQueryDto) {
    return this.dental.readChart(dentalContext(request, 'read'), patientId, query.versionId);
  }

  /** Route 7: save a new chart version, based on the newest one. */
  @Post('patients/:patientId/encounters/:encounterId/dental-chart')
  @HttpCode(201)
  saveChart(@Req() request: HidRequest, @Param('patientId', uuid()) patientId: string,
    @Param('encounterId', uuid()) encounterId: string, @Headers('idempotency-key') key: string | undefined,
    @Body() input: DentalChartSaveDto) {
    const context = dentalContext(request, 'write');
    return this.dental.saveChart(context, patientId, encounterId, input, requireIdempotencyKey(key));
  }

  /** Route 8: mark the newest chart version entered in error. */
  @Post('patients/:patientId/dental-chart/:versionId/entered-in-error')
  @HttpCode(200)
  chartEnteredInError(@Req() request: HidRequest, @Param('patientId', uuid()) patientId: string,
    @Param('versionId', uuid()) versionId: string, @Headers('idempotency-key') key: string | undefined,
    @Body() input: DentalChartErrorDto) {
    const context = dentalContext(request, 'write');
    return this.dental.chartEnteredInError(context, patientId, versionId, input.reason, requireIdempotencyKey(key));
  }

  /** Route 9: plan a procedure, or record one done (signed). */
  @Post('patients/:patientId/encounters/:encounterId/dental-procedures')
  @HttpCode(201)
  recordProcedure(@Req() request: HidRequest, @Param('patientId', uuid()) patientId: string,
    @Param('encounterId', uuid()) encounterId: string, @Headers('idempotency-key') key: string | undefined,
    @Body() input: DentalProcedureRecordDto) {
    const context = dentalContext(request, 'write');
    return this.dental.recordProcedure(context, patientId, encounterId, input, requireIdempotencyKey(key));
  }

  /** Route 10: record a planned procedure as done in this visit (signed). */
  @Post('patients/:patientId/encounters/:encounterId/dental-procedures/:procedureId/done')
  @HttpCode(200)
  procedureDone(@Req() request: HidRequest, @Param('patientId', uuid()) patientId: string,
    @Param('encounterId', uuid()) encounterId: string, @Param('procedureId', uuid()) procedureId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: DentalProcedureDoneDto) {
    const context = dentalContext(request, 'write');
    return this.dental.procedureDone(context, patientId, encounterId, procedureId, input, requireIdempotencyKey(key));
  }

  /** Route 11: cancel a planned procedure, with a reason. */
  @Post('patients/:patientId/dental-procedures/:procedureId/cancel')
  @HttpCode(200)
  cancelProcedure(@Req() request: HidRequest, @Param('patientId', uuid()) patientId: string,
    @Param('procedureId', uuid()) procedureId: string, @Headers('idempotency-key') key: string | undefined,
    @Body() input: DentalProcedureReasonDto) {
    const context = dentalContext(request, 'write');
    return this.dental.cancelProcedure(context, patientId, procedureId, input.expectedRowVersion, input.reason,
      requireIdempotencyKey(key));
  }

  /** Route 12: mark a done procedure entered in error (only its signer), with a reason. */
  @Post('patients/:patientId/dental-procedures/:procedureId/entered-in-error')
  @HttpCode(200)
  procedureEnteredInError(@Req() request: HidRequest, @Param('patientId', uuid()) patientId: string,
    @Param('procedureId', uuid()) procedureId: string, @Headers('idempotency-key') key: string | undefined,
    @Body() input: DentalProcedureReasonDto) {
    const context = dentalContext(request, 'write');
    return this.dental.procedureEnteredInError(context, patientId, procedureId, input.expectedRowVersion, input.reason,
      requireIdempotencyKey(key));
  }

  /** Route 13: the patient's dental procedures at this facility (planned, done or all). */
  @Get('patients/:patientId/dental-procedures')
  @Header('Cache-Control', 'no-store')
  listProcedures(@Req() request: HidRequest, @Param('patientId', uuid()) patientId: string,
    @Query() query: DentalProceduresQueryDto) {
    return this.dental.listProcedures(dentalContext(request, 'read'), patientId, query.status ?? 'all');
  }

  /** Route 14: the printable visit summary (audited as a print). */
  @Get('patients/:patientId/encounters/:encounterId/dental-summary')
  @Header('Cache-Control', 'no-store')
  summary(@Req() request: HidRequest, @Param('patientId', uuid()) patientId: string,
    @Param('encounterId', uuid()) encounterId: string) {
    return this.dental.summary(dentalContext(request, 'read'), patientId, encounterId);
  }
}
