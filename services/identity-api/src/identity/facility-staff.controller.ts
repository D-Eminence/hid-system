import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuditAction, RequirePermissions } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { type HidRequest, requireRequestContext } from '../common/request-context';
import { AdministratorLicenceDto, ChangeFacilityStaffRoleDto, CreateStaffInvitationDto, EndFacilityStaffDto,
  ExpectedVersionDto } from './dto/staff-invitation.dto';
import { FacilityStaffService } from './facility-staff.service';
import { StaffInvitationsService } from './staff-invitations.service';

/**
 * A self-signed-up facility's own staff management (P4b, SPEC 4.1-4.5): the
 * Staff page's read, the pending administrator's own licence, invitations
 * (create, resend, revoke) and members (remove, change role). Each route needs
 * a staff session at the X-Facility-ID facility with workforce.manage, which
 * only the facility's administrator holds; the interceptor audits success and
 * failure at that facility. The database refuses governed and legacy
 * facilities (403 STAFF_MANAGEMENT_NOT_AVAILABLE) and anything but the list
 * and the own licence before support's review (409 FACILITY_REVIEW_PENDING).
 *
 * Order: guard (session, facility, permission, CSRF) → DTO → the facility's
 * self sign-up state → the gate (invite, resend, role) → password re-entry
 * (invite, role, remove) → the command (recovery hold inside it).
 */
@Controller('identity')
export class FacilityStaffController {
  constructor(private readonly staff: FacilityStaffService, private readonly invitations: StaffInvitationsService) {}

  @Get('facility-staff')
  @RequirePermissions('workforce.manage')
  @AuditAction('identity.facility-staff.list')
  list(@Req() request: HidRequest) {
    return this.staff.list(requireRequestContext(request, 'healthcare-operations'));
  }

  @Post('facility-staff/administrator-licence')
  @HttpCode(200)
  @RequirePermissions('workforce.manage')
  @AuditAction('identity.facility-staff.administrator-licence')
  administratorLicence(@Body() input: AdministratorLicenceDto, @Req() request: HidRequest) {
    return this.staff.recordAdministratorLicence(requireRequestContext(request, 'healthcare-operations'),
      input.licenceBody, input.licenceNumber);
  }

  /**
   * 201 { invitationId, version, expiresAt, deliveryOutcome, replayed: false };
   * a replay of the same Idempotency-Key and request answers 200 with
   * replayed: true and sends nothing.
   */
  @Post('staff-invitations')
  @RequirePermissions('workforce.manage')
  @AuditAction('identity.staff-invitation.create')
  async create(@Body() input: CreateStaffInvitationDto, @Headers('idempotency-key') key: string | undefined,
    @Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    const idempotencyKey = requireIdempotencyKey(key);
    const answer = await this.invitations.create(requireRequestContext(request, 'healthcare-operations'), request,
      input, idempotencyKey);
    response.status(answer.status);
    return answer.body;
  }

  @Post('staff-invitations/:invitationId/resend')
  @HttpCode(200)
  @RequirePermissions('workforce.manage')
  @AuditAction('identity.staff-invitation.resend')
  resend(@Param('invitationId', new ParseUUIDPipe({ version: '4' })) invitationId: string,
    @Body() input: ExpectedVersionDto, @Req() request: HidRequest) {
    return this.invitations.resend(requireRequestContext(request, 'healthcare-operations'), invitationId,
      input.expectedVersion);
  }

  @Post('staff-invitations/:invitationId/revoke')
  @HttpCode(200)
  @RequirePermissions('workforce.manage')
  @AuditAction('identity.staff-invitation.revoke')
  revoke(@Param('invitationId', new ParseUUIDPipe({ version: '4' })) invitationId: string,
    @Body() input: ExpectedVersionDto, @Req() request: HidRequest) {
    return this.invitations.revoke(requireRequestContext(request, 'healthcare-operations'), invitationId,
      input.expectedVersion);
  }

  @Post('facility-staff/:membershipId/end')
  @HttpCode(200)
  @RequirePermissions('workforce.manage')
  @AuditAction('identity.facility-staff.end')
  end(@Param('membershipId', new ParseUUIDPipe({ version: '4' })) membershipId: string,
    @Body() input: EndFacilityStaffDto, @Req() request: HidRequest) {
    return this.staff.end(requireRequestContext(request, 'healthcare-operations'), request, membershipId, input);
  }

  @Post('facility-staff/:membershipId/role')
  @HttpCode(200)
  @RequirePermissions('workforce.manage')
  @AuditAction('identity.facility-staff.role-change')
  changeRole(@Param('membershipId', new ParseUUIDPipe({ version: '4' })) membershipId: string,
    @Body() input: ChangeFacilityStaffRoleDto, @Req() request: HidRequest) {
    return this.staff.changeRole(requireRequestContext(request, 'healthcare-operations'), request, membershipId, input);
  }
}
