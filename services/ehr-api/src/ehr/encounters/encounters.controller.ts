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
