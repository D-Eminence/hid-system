import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators';
import type { HidRequest } from '../../common/request-context';
import { clinicalContext, requireIdempotencyKey } from '../shared/clinical-context';
import {
  type CreateLabRequestInput,
  SendLabRequestToLabDto,
  TimelineQueryDto,
  UpdateLabRequestDto,
} from '../shared/clinical.dto';
import { CreateLabRequestBodyPipe } from '../shared/name-only-codes';
import { LabRequestsService } from './lab-requests.service';
import { WorkItemProgressService } from '../../integrations/work-item-progress.service';

@Controller('ehr/patients/:patientId/encounters/:encounterId/lab-requests')
export class LabRequestsController {
  // Required: a missing provider fails at start, never silently drops ownProgress.
  constructor(private readonly labRequests: LabRequestsService,
    private readonly progress: WorkItemProgressService) {}

  /** Each item carries `ownProgress` in this facility's own laboratory (ORD-3), read after the list. */
  @Get()
  @RequirePermissions('ehr.lab-request.read')
  async list(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string, @Query() query: TimelineQueryDto) {
    const context = clinicalContext(request);
    const page = await this.labRequests.list(context, patientId, encounterId, query);
    return this.progress.withLabRequestProgress(context, patientId, page);
  }

  /** With `ownProgress` (ORD-3), read after the lab request. */
  @Get(':requestId')
  @RequirePermissions('ehr.lab-request.read')
  async get(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Param('requestId', new ParseUUIDPipe()) requestId: string) {
    const context = clinicalContext(request);
    const labRequest = await this.labRequests.get(context, patientId, encounterId, requestId);
    return this.progress.withLabRequest(context, patientId, labRequest);
  }

  /**
   * The body is checked by CreateLabRequestBodyPipe: today's
   * CreateLabRequestDto, or, while LAB_REQUEST_NAME_ONLY_ENABLED is on (0156),
   * CreateLabRequestNameOnlyDto, whose test code pair may be left out.
   */
  @Post()
  @HttpCode(201)
  @RequirePermissions('ehr.lab-request.write')
  create(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Headers('idempotency-key') key: string | undefined, @Body(CreateLabRequestBodyPipe) input: CreateLabRequestInput) {
    return this.labRequests.create(clinicalContext(request), patientId, encounterId, input, requireIdempotencyKey(key));
  }

  @Patch(':requestId')
  @RequirePermissions('ehr.lab-request.write')
  update(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Param('requestId', new ParseUUIDPipe()) requestId: string, @Body() input: UpdateLabRequestDto) {
    return this.labRequests.update(clinicalContext(request), patientId, encounterId, requestId, input);
  }

  /**
   * Sends (or sends again) an active lab request to Lab, as the pharmacy-work-item
   * command does for a prescription. Lab's acceptance is idempotent per request
   * version; the Idempotency-Key is required as on every clinical command.
   */
  @Post(':requestId/lab-work-item')
  @HttpCode(201)
  @RequirePermissions('ehr.lab-request.write', 'lab.work-item.accept')
  sendToLab(
    @Req() request: HidRequest,
    @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Param('requestId', new ParseUUIDPipe()) requestId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() input: SendLabRequestToLabDto,
  ) {
    requireIdempotencyKey(key);
    return this.labRequests.sendToLab(clinicalContext(request), patientId, encounterId, requestId, input);
  }
}
