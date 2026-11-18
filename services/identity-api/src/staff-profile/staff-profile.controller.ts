import { Controller, Get, Req } from '@nestjs/common';
import { AuditAction, FacilityOptional } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { StaffProfileService } from './staff-profile.service';

/**
 * GET /api/v1/identity/me/staff-profile (SX-5): the signed-in staff member's
 * own profile. Staff sessions only (a patient session is refused by the
 * guard, 403 PATIENT_SCOPE_DENIED); X-Facility-ID optional and, when sent,
 * only marks the current facility. No permission is needed: it reads the
 * caller's own account. Success and failure are audited
 * (api.identity.staff-profile.read).
 */
@Controller('identity')
export class StaffProfileController {
  constructor(private readonly profiles: StaffProfileService) {}

  @Get('me/staff-profile')
  @FacilityOptional()
  @AuditAction('identity.staff-profile.read')
  read(@Req() request: HidRequest) {
    const actor = request.actor;
    if (!actor || actor.kind === 'patient') {
      throw new DomainProblem(403, 'PATIENT_SCOPE_DENIED', 'This operation requires workforce authorization');
    }
    return this.profiles.read(actor, request.facilityId);
  }
}
