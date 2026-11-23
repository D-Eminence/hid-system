import { Body, Controller, HttpCode, NotFoundException, Post, Req } from '@nestjs/common';
import { AuditAction, AuditFailuresOnly } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { OPEN_PATIENT_MESSAGES, OPEN_PATIENT_PURPOSES, OpenPatientService, type OpenPatientPurpose,
  type OpenPatientRequest } from './open-patient.service';
import { SetOpenPatientDto } from './set-open-patient.dto';

/**
 * SX-8 (0140): keep the open patient across a reload. Both routes need a
 * staff session at its X-Facility-ID facility with Origin and CSRF checks
 * (SecurityGuard: no @FacilityOptional, @PatientAllowed or
 * @AccountOnlyAllowed), and no permission beyond the membership. While
 * STAFF_OPEN_PATIENT_ENABLED is false both answer 404 (OpenPatientOffMiddleware).
 * Each route writes its own audit row; a refusal before the handler is
 * audited by the interceptor under the route's action.
 */
@Controller('auth')
@AuditFailuresOnly()
export class OpenPatientController {
  constructor(private readonly openPatients: OpenPatientService) {}

  @Post('open-patient')
  @HttpCode(200)
  @AuditAction('auth.open-patient.set')
  async set(@Body() input: SetOpenPatientDto, @Req() request: HidRequest) {
    const actor = this.signIn(request);
    const purpose = input.purpose as OpenPatientPurpose | undefined;
    if (!purpose || !OPEN_PATIENT_PURPOSES.includes(purpose)) {
      throw new DomainProblem(400, 'PURPOSE_OF_USE_REQUIRED', OPEN_PATIENT_MESSAGES.purposeRequired);
    }
    return this.openPatients.set(actor, input.patientId, purpose, this.request(request));
  }

  /** The body is empty (`{}`) and is not read. */
  @Post('open-patient/clear')
  @HttpCode(200)
  @AuditAction('auth.open-patient.clear')
  async clear(@Req() request: HidRequest) {
    return this.openPatients.clear(this.signIn(request), this.request(request));
  }

  /**
   * The staff sign-in at the guard's facility. A caller with no Identity
   * sign-in to keep a patient for (an OIDC bearer caller: no session id) is
   * answered as if the routes were not served.
   */
  private signIn(request: HidRequest) {
    const actor = request.actor;
    if (!actor) throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', OPEN_PATIENT_MESSAGES.signInAgain);
    if (!this.openPatients.reportsFor(actor)) throw new NotFoundException();
    return actor;
  }

  private request(request: HidRequest): OpenPatientRequest {
    return { correlationId: request.correlationId, sourceIp: request.ip, userAgent: request.header('user-agent') };
  }
}
