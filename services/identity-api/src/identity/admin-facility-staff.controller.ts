import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';
import { requireAdminContext } from '../admin/admin-context';
import { AuditAction, FacilityOptional, RequirePermissions } from '../common/decorators';
import { requireIdempotencyKey } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { AdminAddFacilityStaffRoleDto, AdminRemoveFacilityStaffRoleDto } from './dto/staff-role.dto';
import { FacilityStaffRolesService } from './facility-staff-roles.service';
import { FacilityStaffService } from './facility-staff.service';

/** An invitation's reference as its email quotes it: 8 hexadecimal characters, any case. */
export class FindStaffInvitationsDto {
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Matches(/^[0-9A-Fa-f]{8}$/)
  reference!: string;
}

/**
 * Support's reads of facility staff (P4b, SPEC 6.3): a facility's members and
 * invitations with full licence numbers, and an invitation found by its
 * reference. A standalone platform administrator works (facility optional).
 * These reads show licence numbers, so success is audited too (no
 * @AuditFailuresOnly, FEA R2): the interceptor writes the row on its own
 * connection and the read stays a read-only transaction.
 *
 * SX-4 (0139, owner decision Q129 A): support adds or removes one role for a
 * member at any facility (the only way at governed facilities, QA Hospital
 * included), with platform.facility-staff.manage, If-Match: "<membership
 * version>" and an Idempotency-Key, as every section 19 command.
 */
@Controller('admin')
@FacilityOptional()
export class AdminFacilityStaffController {
  constructor(private readonly staff: FacilityStaffService, private readonly roles: FacilityStaffRolesService) {}

  @Get('facilities/:facilityId/staff')
  @RequirePermissions('platform.principal.read')
  @AuditAction('admin.facility-staff.read')
  facilityStaff(@Param('facilityId', new ParseUUIDPipe({ version: '4' })) facilityId: string, @Req() request: HidRequest) {
    return this.staff.adminStaff(requireAdminContext(request), facilityId);
  }

  @Get('staff-invitations')
  @RequirePermissions('platform.principal.read')
  @AuditAction('admin.staff-invitations.find')
  findInvitations(@Query() query: FindStaffInvitationsDto, @Req() request: HidRequest) {
    return this.staff.adminFindInvitations(requireAdminContext(request), query.reference);
  }

  /** SX-4: 201 { membershipId, version, roles, replayed: false }; a replay answers 200 with replayed: true. */
  @Post('facilities/:facilityId/staff/:membershipId/roles/add')
  @RequirePermissions('platform.facility-staff.manage')
  @AuditAction('admin.facility-staff.role-add.request')
  async addRole(@Param('facilityId', new ParseUUIDPipe({ version: '4' })) facilityId: string,
    @Param('membershipId', new ParseUUIDPipe({ version: '4' })) membershipId: string,
    @Headers('if-match') ifMatch: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Body() input: AdminAddFacilityStaffRoleDto, @Req() request: HidRequest,
    @Res({ passthrough: true }) response: Response) {
    const expectedVersion = membershipVersion(ifMatch);
    const answer = await this.roles.adminAdd(requireAdminContext(request), facilityId, membershipId, expectedVersion,
      input, requireIdempotencyKey(key));
    response.status(answer.status);
    return answer.body;
  }

  /** SX-4: 200 { membershipId, version, roles, replayed }. */
  @Post('facilities/:facilityId/staff/:membershipId/roles/remove')
  @HttpCode(200)
  @RequirePermissions('platform.facility-staff.manage')
  @AuditAction('admin.facility-staff.role-remove.request')
  async removeRole(@Param('facilityId', new ParseUUIDPipe({ version: '4' })) facilityId: string,
    @Param('membershipId', new ParseUUIDPipe({ version: '4' })) membershipId: string,
    @Headers('if-match') ifMatch: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Body() input: AdminRemoveFacilityStaffRoleDto, @Req() request: HidRequest) {
    const expectedVersion = membershipVersion(ifMatch);
    return (await this.roles.adminRemove(requireAdminContext(request), facilityId, membershipId, expectedVersion,
      input, requireIdempotencyKey(key))).body;
  }
}

/** If-Match: "<version>" (a weak tag or no quotes too), as AdminController reads it: 428 without a positive version. */
export function membershipVersion(value: string | undefined): number {
  const normalized = value?.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  const version = normalized ? Number(normalized) : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new DomainProblem(428, 'IF_MATCH_REQUIRED', 'Reload the staff list and try again');
  }
  return version;
}
