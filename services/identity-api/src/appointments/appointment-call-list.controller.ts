import { Controller, Get, Header, Query, Req } from '@nestjs/common';
import { Transform, type TransformFnParams } from 'class-transformer';
import { IsUUID, Matches } from 'class-validator';
import { AuditAction } from '../common/decorators';
import type { HidRequest } from '../common/request-context';
import { IsOptionalButNotNull } from '../common/validation';
import { consentContext } from '../consent/consent-context';
import {
  AppointmentCallListService, appointmentsEnabled, appointmentsNotAvailable, requireCallListAccess,
} from './appointment-call-list.service';

const trim = ({ value }: TransformFnParams): unknown => typeof value === 'string' ? value.trim() : value;

/** GET identity/appointment-call-list?day=YYYY-MM-DD[&clinicId][&clinicianMembershipId]. */
export class AppointmentCallListQueryDto {
  @Transform(trim)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'day must be a date (YYYY-MM-DD)' })
  day!: string;

  @IsOptionalButNotNull()
  @IsUUID('all')
  clinicId?: string;

  @IsOptionalButNotNull()
  @IsUUID('all')
  clinicianMembershipId?: string;
}

/**
 * APPT-1 route 11 (0161, Q-APPT-7 A): the printable call list of this
 * facility's booked appointments for one day, with the phone this facility
 * recorded. Members with ehr.appointment.write here (front desk, clinicians,
 * doctors), for direct care. Behind APPOINTMENTS_ENABLED.
 */
@Controller('identity')
export class AppointmentCallListController {
  constructor(private readonly callList: AppointmentCallListService) {}

  @Get('appointment-call-list')
  @Header('Cache-Control', 'no-store')
  @AuditAction('identity.appointment-call-list.request')
  list(@Req() request: HidRequest, @Query() query: AppointmentCallListQueryDto) {
    if (!appointmentsEnabled()) throw appointmentsNotAvailable();
    const context = consentContext(request, ['direct-care']);
    requireCallListAccess(request);
    return this.callList.list(context, query.day, query.clinicId ?? null, query.clinicianMembershipId ?? null);
  }
}
