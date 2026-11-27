import { Body, Controller, Get, Header, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuditAction, RequirePermissions } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import { type DataAccessContext, type HidRequest, requireRequestContext } from '../common/request-context';
import { ListPatientMergesDto, RefusePatientMergeDto, RequestPatientMergeDto, UndoPatientMergeDto,
  VersionedPatientMergeDto } from './patient-merges.dto';
import { PatientMergesService } from './patient-merges.service';

/**
 * ID-8a (0207): merge requests at the X-Facility-ID facility, for healthcare
 * operations (POST bodies carry `purpose`, GETs the X-Purpose-Of-Use header).
 * Every write needs an Idempotency-Key. Routes 1, 2, 3, 5 and 6 of the
 * contract; approve (4) and undo (7) are ID-8b's and answer 503
 * MERGE_UNAVAILABLE. The list and the read take no fixed permission here: the
 * list's view decides (mine: identity.registration.write; facility:
 * identity.registration.approve) and the read is for the member who asked or
 * an approver; the database checks both.
 */
@Controller('identity/patient-merges')
export class PatientMergesController {
  constructor(private readonly merges: PatientMergesService) {}

  @Post()
  @RequirePermissions('identity.registration.write')
  @AuditAction('identity.patient-merge.request.request')
  async request(@Body() input: RequestPatientMergeDto, @Headers('idempotency-key') key: string | undefined,
    @Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    const idempotencyKey = requireIdempotencyKey(key);
    const answer = await this.merges.request(input, idempotencyKey, requireRequestContext(request, input.purpose));
    response.status(answer.status);
    return answer.body;
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @AuditAction('identity.patient-merge.list.request')
  list(@Query() query: ListPatientMergesDto, @Req() request: HidRequest) {
    return this.merges.list(query, operations(request));
  }

  @Get(':mergeId')
  @Header('Cache-Control', 'no-store')
  @AuditAction('identity.patient-merge.read.request')
  read(@Param('mergeId', new ParseUUIDPipe()) mergeId: string, @Req() request: HidRequest) {
    return this.merges.read(mergeId, operations(request));
  }

  @Post(':mergeId/refuse')
  @HttpCode(200)
  @RequirePermissions('identity.registration.approve')
  @AuditAction('identity.patient-merge.refuse.request')
  refuse(@Param('mergeId', new ParseUUIDPipe()) mergeId: string, @Body() input: RefusePatientMergeDto,
    @Headers('idempotency-key') key: string | undefined, @Req() request: HidRequest) {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.merges.refuse(mergeId, input, idempotencyKey, requireRequestContext(request, input.purpose));
  }

  @Post(':mergeId/cancel')
  @HttpCode(200)
  @RequirePermissions('identity.registration.write')
  @AuditAction('identity.patient-merge.cancel.request')
  cancel(@Param('mergeId', new ParseUUIDPipe()) mergeId: string, @Body() input: VersionedPatientMergeDto,
    @Headers('idempotency-key') key: string | undefined, @Req() request: HidRequest) {
    const idempotencyKey = requireIdempotencyKey(key);
    return this.merges.cancel(mergeId, input, idempotencyKey, requireRequestContext(request, input.purpose));
  }

  /** ID-8b: 503 MERGE_UNAVAILABLE until 0208 and an image that calls it. */
  @Post(':mergeId/approve')
  @HttpCode(200)
  @RequirePermissions('identity.registration.approve')
  @AuditAction('identity.patient-merge.approve.request')
  approve(@Param('mergeId', new ParseUUIDPipe()) mergeId: string, @Body() input: VersionedPatientMergeDto,
    @Headers('idempotency-key') key: string | undefined, @Req() request: HidRequest) {
    requireIdempotencyKey(key);
    return this.merges.unavailable('approve', mergeId, input, requireRequestContext(request, input.purpose));
  }

  /** ID-8b: 503 MERGE_UNAVAILABLE until 0208 and an image that calls it. */
  @Post(':mergeId/undo')
  @HttpCode(200)
  @RequirePermissions('identity.registration.approve')
  @AuditAction('identity.patient-merge.undo.request')
  undo(@Param('mergeId', new ParseUUIDPipe()) mergeId: string, @Body() input: UndoPatientMergeDto,
    @Headers('idempotency-key') key: string | undefined, @Req() request: HidRequest) {
    requireIdempotencyKey(key);
    return this.merges.unavailable('undo', mergeId, input, requireRequestContext(request, input.purpose));
  }
}

/** A GET's context: X-Purpose-Of-Use must be healthcare-operations. */
function operations(request: HidRequest): DataAccessContext {
  const context = requireRequestContext(request);
  if (context.purposeOfUse !== 'healthcare-operations') {
    throw new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED', 'X-Purpose-Of-Use must be healthcare-operations');
  }
  return context;
}
