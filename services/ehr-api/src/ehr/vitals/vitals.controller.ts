import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators';
import type { HidRequest } from '../../common/request-context';
import { clinicalContext, requireIdempotencyKey } from '../shared/clinical-context';
import { CreateVitalCorrectionDto, CreateVitalDto } from '../shared/clinical.dto';
import { MarkVitalEnteredInErrorDto, VitalsListQueryDto } from './vitals.dto';
import { VitalsService } from './vitals.service';

@Controller('ehr/patients/:patientId/encounters/:encounterId/vitals')
export class VitalsController {
  constructor(private readonly vitals: VitalsService) {}

  @Get()
  @RequirePermissions('ehr.vital.read')
  list(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string, @Query() query: VitalsListQueryDto) {
    return this.vitals.list(clinicalContext(request), patientId, encounterId, query);
  }

  @Get(':vitalId')
  @RequirePermissions('ehr.vital.read')
  get(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Param('vitalId', new ParseUUIDPipe()) vitalId: string) {
    return this.vitals.get(clinicalContext(request), patientId, encounterId, vitalId);
  }

  @Get(':vitalId/corrections')
  @RequirePermissions('ehr.vital.read')
  corrections(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Param('vitalId', new ParseUUIDPipe()) vitalId: string) {
    return this.vitals.corrections(clinicalContext(request), patientId, encounterId, vitalId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermissions('ehr.vital.write')
  create(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: CreateVitalDto) {
    return this.vitals.create(clinicalContext(request), patientId, encounterId, input, requireIdempotencyKey(key));
  }

  /**
   * EHR-C8b: mark one reading entered in error, for good (0142). Protected
   * by expectedRowVersion, like the other PATCH routes; no Idempotency-Key.
   */
  @Patch(':vitalId')
  @RequirePermissions('ehr.vital.write')
  markEnteredInError(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Param('vitalId', new ParseUUIDPipe()) vitalId: string, @Body() input: MarkVitalEnteredInErrorDto) {
    return this.vitals.markEnteredInError(clinicalContext(request), patientId, encounterId, vitalId, input);
  }

  @Post(':vitalId/corrections')
  @HttpCode(201)
  @RequirePermissions('ehr.vital.write')
  correct(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Param('vitalId', new ParseUUIDPipe()) vitalId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: CreateVitalCorrectionDto) {
    return this.vitals.correct(
      clinicalContext(request), patientId, encounterId, vitalId, input, requireIdempotencyKey(key),
    );
  }
}
