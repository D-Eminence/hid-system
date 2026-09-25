import { Controller, Get, Req } from '@nestjs/common';
import { AuditFailuresOnly, FacilityOptional, PatientAllowed } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { PatientSelfService } from './patient-self.service';
import { WorkloadAuthService } from './workload-auth.service';

@Controller('identity')
@PatientAllowed()
@FacilityOptional()
@AuditFailuresOnly()
export class PatientSelfController {
  constructor(private readonly self: PatientSelfService, private readonly workload: WorkloadAuthService) {}

  @Get('me')
  profile(@Req() request: HidRequest) { return this.self.profile(request); }

  @Get('me/access-history')
  history(@Req() request: HidRequest) { return this.self.history(request); }

  @Get('service/patient-self-authorization')
  async authorize(@Req() request: HidRequest) {
    if (request.header('x-hid-internal-caller') !== 'ehr-api') {
      throw new DomainProblem(403, 'WORKLOAD_AUTHENTICATION_REQUIRED', 'The EHR service is required');
    }
    await this.workload.authenticateService(request.header('x-hid-internal-caller'),
      request.header('x-hid-service-authorization'), request.header('x-hid-service-token'));
    return this.self.authorize(request);
  }
}
