import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators';
import type { HidRequest } from '../../common/request-context';
import { clinicalContext, requireIdempotencyKey } from '../shared/clinical-context';
import { CreateDiagnosisDto, TimelineQueryDto, UpdateDiagnosisDto } from '../shared/clinical.dto';
import { DiagnosesService } from './diagnoses.service';

@Controller('ehr/patients/:patientId/encounters/:encounterId/diagnoses')
export class DiagnosesController {
  constructor(private readonly diagnoses: DiagnosesService) {}

  @Get()
  @RequirePermissions('ehr.diagnosis.read')
  list(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string, @Query() query: TimelineQueryDto) {
    return this.diagnoses.list(clinicalContext(request), patientId, encounterId, query);
  }

  @Get(':diagnosisId')
  @RequirePermissions('ehr.diagnosis.read')
  get(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Param('diagnosisId', new ParseUUIDPipe()) diagnosisId: string) {
    return this.diagnoses.get(clinicalContext(request), patientId, encounterId, diagnosisId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermissions('ehr.diagnosis.write')
  create(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: CreateDiagnosisDto) {
    return this.diagnoses.create(clinicalContext(request), patientId, encounterId, input, requireIdempotencyKey(key));
  }

  @Patch(':diagnosisId')
  @RequirePermissions('ehr.diagnosis.write')
  update(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Param('encounterId', new ParseUUIDPipe()) encounterId: string,
    @Param('diagnosisId', new ParseUUIDPipe()) diagnosisId: string, @Body() input: UpdateDiagnosisDto) {
    return this.diagnoses.update(clinicalContext(request), patientId, encounterId, diagnosisId, input);
  }
}
