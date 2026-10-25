import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { FacilityOptional, NoAudit } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext, HidRequest } from '../common/request-context';
import { SignedInInvitationDto } from './dto/staff-invitation.dto';
import { StaffInvitationsService } from './staff-invitations.service';

/**
 * The account-only context of the signed-in routes (V4): no facility and no
 * membership, which the database reads as null (database.service.ts sets
 * them to ''), purpose healthcare-operations. The commands take the account
 * from the session's subject. requireRequestContext needs a facility, so it
 * cannot be used here.
 */
export function accountOnlyContext(request: HidRequest): DataAccessContext {
  if (!request.actor || !request.correlationId) {
    throw new DomainProblem(401, 'AUTHENTICATION_REQUIRED', 'Valid authentication is required');
  }
  request.purposeOfUse = 'healthcare-operations';
  return { actor: request.actor, facilityId: '', membershipId: '', correlationId: request.correlationId,
    purposeOfUse: 'healthcare-operations', authorization: request.header('authorization') };
}

/**
 * An existing staff member accepts an invitation while signed in on their own
 * host (P4b, SPEC 4.9): preview, then accept. A staff session (the guard
 * refuses a patient session), CSRF on every POST, no X-Facility-ID and no
 * permission. No interceptor row (S5): a facility-scoped HTTP row would land
 * at the caller's own facility, so only the accept command writes one success
 * row, at the inviting facility; refusals write none there.
 */
@Controller('identity/staff-invitations/signed-in')
@FacilityOptional()
@NoAudit()
export class StaffInvitationsSignedInController {
  constructor(private readonly invitations: StaffInvitationsService) {}

  @Post('preview')
  @HttpCode(200)
  preview(@Body() input: SignedInInvitationDto, @Req() request: HidRequest) {
    return this.invitations.previewForAccount(accountOnlyContext(request), input);
  }

  @Post('accept')
  @HttpCode(200)
  accept(@Body() input: SignedInInvitationDto, @Req() request: HidRequest) {
    return this.invitations.acceptForAccount(accountOnlyContext(request), input);
  }
}
