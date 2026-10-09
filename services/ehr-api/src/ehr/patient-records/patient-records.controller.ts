import { Controller, Get, Param, ParseUUIDPipe, Req } from '@nestjs/common';
import { AuditFailuresOnly, FacilityOptional, PatientAllowed, RequirePermissions } from '../../common/decorators';
import { DomainProblem } from '../../common/problem';
import { requireRequestContext, type HidRequest } from '../../common/request-context';
import { PatientRecordsService } from './patient-records.service';

@Controller('ehr')
@AuditFailuresOnly()
export class PatientRecordsController {
  constructor(private readonly records: PatientRecordsService) {}

  @Get('me/records')
  @FacilityOptional()
  @PatientAllowed()
  self(@Req() request: HidRequest) { return this.records.self(request); }

  @Get('patients/:patientId/emergency-records')
  @RequirePermissions('ehr.encounter.read','ehr.note.read')
  emergency(@Param('patientId', new ParseUUIDPipe()) patientId: string, @Req() request: HidRequest) {
    if (request.header('x-purpose-of-use') !== 'emergency') {
      throw new DomainProblem(400, 'EMERGENCY_PURPOSE_REQUIRED', 'Emergency purpose is required');
    }
    return this.records.emergency(patientId, requireRequestContext(request, 'emergency'));
  }
}
