import { Controller, Get, Param, ParseUUIDPipe, Req } from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators';
import type { HidRequest } from '../../common/request-context';
import { clinicalContext } from '../shared/clinical-context';
import { VitalsService } from './vitals.service';

/** EHR-C3: patient-level vitals reads (not tied to one visit). */
@Controller('ehr/patients/:patientId/vitals')
export class PatientVitalsController {
  constructor(private readonly vitals: VitalsService) {}

  /** The newest corrected value of each measure at this facility. */
  @Get('latest')
  @RequirePermissions('ehr.vital.read')
  latest(@Req() request: HidRequest, @Param('patientId', new ParseUUIDPipe()) patientId: string) {
    return this.vitals.latest(clinicalContext(request), patientId);
  }
}
