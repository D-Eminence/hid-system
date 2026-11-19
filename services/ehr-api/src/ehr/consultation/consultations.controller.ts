import { Body, Controller, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { RequirePermissions } from '../../common/decorators';
import { DomainProblem } from '../../common/problem';
import type { HidRequest } from '../../common/request-context';
import { clinicalContext, requireIdempotencyKey } from '../shared/clinical-context';
import { CreateConsultationDto } from './consultation.dto';
import { ConsultationsService } from './consultations.service';

/**
 * EHR-C5: the write permission each part needs, as on its own route. The
 * visit's (`ehr.encounter.write`) is always needed and checked by the guard.
 */
export function consultationPermissions(input: CreateConsultationDto): string[] {
  return [
    'ehr.encounter.write',
    ...(input.note ? ['ehr.note.write'] : []),
    ...(input.vitals ? ['ehr.vital.write'] : []),
    ...(input.diagnoses && input.diagnoses.length > 0 ? ['ehr.diagnosis.write'] : []),
  ];
}

@Controller('ehr/patients/:patientId/consultations')
export class ConsultationsController {
  constructor(private readonly consultations: ConsultationsService) {}

  /**
   * EHR-C5 (Akos N-5): visit, note, vitals and diagnoses in one call, all or
   * nothing. A part the caller may not write on its own route refuses the
   * whole call (403 PERMISSION_DENIED) before anything is read or saved.
   */
  @Post()
  @HttpCode(201)
  @RequirePermissions('ehr.encounter.write')
  create(
    @Req() request: HidRequest,
    @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() input: CreateConsultationDto,
  ) {
    const granted = request.actor?.permissions ?? [];
    if (consultationPermissions(input).some((permission) => !granted.includes(permission))) {
      throw new DomainProblem(403, 'PERMISSION_DENIED', 'Required permission is missing');
    }
    return this.consultations.create(clinicalContext(request), patientId, input, requireIdempotencyKey(key));
  }
}
