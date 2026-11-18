import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators';
import type { HidRequest } from '../../common/request-context';
import { clinicalContext, requireIdempotencyKey } from '../shared/clinical-context';
import { CreateEncounterDto, TimelineQueryDto, UpdateEncounterDto } from '../shared/clinical.dto';
import { EncountersService } from './encounters.service';

@Controller('ehr/patients/:patientId/encounters')
export class EncountersController {
  constructor(private readonly encounters: EncountersService) {}

  @Get()
  @RequirePermissions('ehr.encounter.read')
  list(
    @Req() request: HidRequest,
    @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Query() query: TimelineQueryDto,
  ) {
    return this.encounters.list(clinicalContext(request), patientId, query);
  }

  /**
   * EHR-C1: the patient's open visit today (Lagos calendar day) at this
   * facility, or `encounter: null`. Declared before `:encounterId` so the
   * word is not read as an id.
   */
  @Get('open-today')
  @RequirePermissions('ehr.encounter.read')
  openToday(
    @Req() request: HidRequest,
    @Param('patientId', new ParseUUIDPipe()) patientId: string,
  ) {
    return this.encounters.openToday(clinicalContext(request), patientId);
  }

  @Get(':encounterId')
  @RequirePermissions('ehr.encounter.read')
  get(
    @Req() request: HidRequest,
    @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
  ) {
    return this.encounters.get(clinicalContext(request), patientId, encounterId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermissions('ehr.encounter.write')
  create(
    @Req() request: HidRequest,
    @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() input: CreateEncounterDto,
  ) {
    return this.encounters.create(clinicalContext(request), patientId, input, requireIdempotencyKey(key));
  }

  @Patch(':encounterId')
  @RequirePermissions('ehr.encounter.write')
  update(
    @Req() request: HidRequest,
    @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Body() input: UpdateEncounterDto,
  ) {
    return this.encounters.update(clinicalContext(request), patientId, encounterId, input);
  }
}
