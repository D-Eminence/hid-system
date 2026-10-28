import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Put, Req } from '@nestjs/common';
import { AuditFailuresOnly, FacilityOptional, PatientAllowed, RequirePermissions } from '../../common/decorators';
import { requireRequestContext, type HidRequest } from '../../common/request-context';
import { SaveHealthProfileDto } from './health-profile.dto';
import { HealthProfileService } from './health-profile.service';

/**
 * Health information the patient enters (0094): the patient's own read and
 * save, and a clinician's read labelled by the website "Reported by the
 * patient". Successes are audited by the service (and the save's command);
 * the interceptor records failures.
 */
@Controller('ehr')
@AuditFailuresOnly()
export class HealthProfileController {
  constructor(private readonly profiles: HealthProfileService) {}

  @Get('me/health-profile')
  @Header('Cache-Control', 'no-store')
  @FacilityOptional()
  @PatientAllowed()
  own(@Req() request: HidRequest) {
    return this.profiles.own(request);
  }

  @Put('me/health-profile')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @FacilityOptional()
  @PatientAllowed()
  save(@Req() request: HidRequest, @Body() input: SaveHealthProfileDto) {
    return this.profiles.save(request, input);
  }

  @Get('patients/:patientId/reported-health-profile')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('ehr.note.read')
  reported(@Param('patientId', new ParseUUIDPipe()) patientId: string, @Req() request: HidRequest) {
    return this.profiles.reported(patientId, requireRequestContext(request));
  }
}
