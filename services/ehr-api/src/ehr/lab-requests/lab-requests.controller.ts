import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators';
import type { HidRequest } from '../../common/request-context';
import { clinicalContext, requireIdempotencyKey } from '../shared/clinical-context';
import { CreateLabRequestDto, TimelineQueryDto, UpdateLabRequestDto } from '../shared/clinical.dto';
import { LabRequestsService } from './lab-requests.service';

@Controller('ehr/patients/:patientId/encounters/:encounterId/lab-requests')
export class LabRequestsController {
  constructor(private readonly labRequests: LabRequestsService) {}

  @Get()
  @RequirePermissions('ehr.lab-request.read')
  list(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string, @Query() query: TimelineQueryDto) {
    return this.labRequests.list(clinicalContext(request), patientId, encounterId, query);
  }

  @Get(':requestId')
  @RequirePermissions('ehr.lab-request.read')
  get(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Param('requestId', new ParseUUIDPipe()) requestId: string) {
    return this.labRequests.get(clinicalContext(request), patientId, encounterId, requestId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermissions('ehr.lab-request.write')
  create(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: CreateLabRequestDto) {
    return this.labRequests.create(clinicalContext(request), patientId, encounterId, input, requireIdempotencyKey(key));
  }

  @Patch(':requestId')
  @RequirePermissions('ehr.lab-request.write')
  update(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Param('requestId', new ParseUUIDPipe()) requestId: string, @Body() input: UpdateLabRequestDto) {
    return this.labRequests.update(clinicalContext(request), patientId, encounterId, requestId, input);
  }
}
