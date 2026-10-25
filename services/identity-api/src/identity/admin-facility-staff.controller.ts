import { Controller, Get, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';
import { requireAdminContext } from '../admin/admin-context';
import { AuditAction, FacilityOptional, RequirePermissions } from '../common/decorators';
import type { HidRequest } from '../common/request-context';
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
 */
@Controller('admin')
@FacilityOptional()
export class AdminFacilityStaffController {
  constructor(private readonly staff: FacilityStaffService) {}

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
}
