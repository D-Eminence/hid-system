import {
  Body, CanActivate, Controller, ExecutionContext, Headers, HttpCode, Injectable, Param, ParseUUIDPipe, PipeTransform,
  Post, Req, UseGuards,
} from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { RequirePermissions } from '../../common/decorators';
import { DomainProblem } from '../../common/problem';
import type { HidRequest } from '../../common/request-context';
import { createValidationPipe } from '../../common/validation-pipe';
import { clinicalContext, requireIdempotencyKey } from '../shared/clinical-context';
import { NameOnlyCodes, codePairIncomplete, diagnosisCodeIncomplete } from '../shared/name-only-codes';
import { CreateConsultationDto, CreateConsultationNameOnlyDto, type CreateConsultationInput } from './consultation.dto';
import { ConsultationsService } from './consultations.service';

/** The parts of a consultation body that need their own write permission. */
type ConsultationParts = { note?: unknown; vitals?: unknown; diagnoses?: unknown };

/**
 * EHR-C5: the write permission each part needs, as on its own route. The
 * visit's (`ehr.encounter.write`) is always needed and checked by the guard.
 */
export function consultationPermissions(input: ConsultationParts): string[] {
  return [
    'ehr.encounter.write',
    ...(input.note ? ['ehr.note.write'] : []),
    ...(input.vitals ? ['ehr.vital.write'] : []),
    ...(Array.isArray(input.diagnoses) && input.diagnoses.length > 0 ? ['ehr.diagnosis.write'] : []),
  ];
}

/**
 * EHR-C5: refuses the whole call when the caller lacks the write permission
 * of a part it sent, and audits the refusal exactly as RemoteSecurityGuard
 * audits a missing permission on that part's own route: one
 * `security.authorization.denied` row (`http-request`, outcome `denied`, the
 * method and route), and, being a guard, before the body is validated and
 * before the request's own audit row could be written.
 */
@Injectable()
export class ConsultationPartsGuard implements CanActivate {
  constructor(private readonly audit: AuditService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<HidRequest>();
    const body: unknown = request.body;
    const parts = typeof body === 'object' && body !== null ? body as ConsultationParts : {};
    const granted = request.actor?.permissions ?? [];
    if (consultationPermissions(parts).every((permission) => granted.includes(permission))) return true;
    await this.audit.record({
      correlationId: request.correlationId,
      actorType: request.actor?.kind === 'patient' ? 'patient' : request.actor ? 'staff' : 'system',
      actorSubject: request.actor?.subject,
      actorAccountId: request.actor?.accountId,
      actorMembershipId: request.actor?.facility?.membershipId,
      organizationId: request.actor?.facility?.organizationId,
      facilityId: request.facilityId,
      action: 'security.authorization.denied',
      resourceType: request.actor ? 'http-request' : 'authentication',
      outcome: 'denied',
      sourceIp: request.ip,
      userAgent: request.header('user-agent'),
      details: { method: request.method, route: typeof request.route?.path === 'string' ? request.route.path : 'unresolved' },
      provenance: request.actor ? 'application' : 'system',
    });
    throw new DomainProblem(403, 'PERMISSION_DENIED', 'Required permission is missing');
  }
}

/**
 * Validates a consultation body with the class DIAGNOSIS_NAME_ONLY_ENABLED
 * picks (0156): CreateConsultationDto while off (today's checks and
 * refusals), CreateConsultationNameOnlyDto while on, whose diagnoses may
 * leave out their code pair, both or neither: 400 DIAGNOSIS_CODE_INCOMPLETE
 * names the first diagnosis with one code only (`diagnoses.<index>`, from 0).
 * The controller's body type is a union, so the global pipe leaves the body
 * to this one.
 */
@Injectable()
export class CreateConsultationBodyPipe implements PipeTransform<unknown, Promise<CreateConsultationInput>> {
  private readonly validation = createValidationPipe();

  constructor(private readonly nameOnly: NameOnlyCodes) {}

  async transform(value: unknown): Promise<CreateConsultationInput> {
    const input = await this.validation.transform(value, { type: 'body', data: undefined,
      metatype: this.nameOnly.diagnoses ? CreateConsultationNameOnlyDto : CreateConsultationDto }) as CreateConsultationInput;
    const index = (input.diagnoses ?? []).findIndex((diagnosis) => codePairIncomplete(diagnosis.codeSystem, diagnosis.code));
    if (index >= 0) {
      throw diagnosisCodeIncomplete([{ field: `diagnoses.${index}`,
        messages: ['codeSystem and code must be supplied together'] }]);
    }
    return input;
  }
}

@Controller('ehr/patients/:patientId/consultations')
export class ConsultationsController {
  constructor(private readonly consultations: ConsultationsService) {}

  /**
   * EHR-C5 (Akos N-5): visit, note, vitals and diagnoses in one call, all or
   * nothing. A part the caller may not write on its own route refuses the
   * whole call (403 PERMISSION_DENIED, ConsultationPartsGuard) before
   * anything is read or saved. The body is checked by
   * CreateConsultationBodyPipe (diagnoses by name only while
   * DIAGNOSIS_NAME_ONLY_ENABLED is on, 0156).
   */
  @Post()
  @HttpCode(201)
  @RequirePermissions('ehr.encounter.write')
  @UseGuards(ConsultationPartsGuard)
  create(
    @Req() request: HidRequest,
    @Param('patientId', new ParseUUIDPipe()) patientId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body(CreateConsultationBodyPipe) input: CreateConsultationInput,
  ) {
    return this.consultations.create(clinicalContext(request), patientId, input, requireIdempotencyKey(key));
  }
}
