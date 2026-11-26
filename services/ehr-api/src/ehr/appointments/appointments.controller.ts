import { Body, Controller, Get, Header, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { FacilityOptional, PatientAllowed } from '../../common/decorators';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { clinicalContext, requireIdempotencyKey } from '../shared/clinical-context';
import {
  BookAppointmentDto, CancelAppointmentDto, CheckInAppointmentDto, CreateAppointmentClinicDto,
  ListAppointmentClinicsQueryDto, ListAppointmentsQueryDto, MarkNoShowDto, MyAppointmentsQueryDto,
  RescheduleAppointmentDto, SaveAppointmentSettingsDto, UpdateAppointmentClinicDto,
} from './appointments.dto';
import {
  type AppointmentAccess, AppointmentsService, appointmentsEnabled, notAvailable, requireAppointmentAccess,
} from './appointments.service';

/**
 * The staff context of an appointment route: the service flag first (503
 * APPOINTMENTS_NOT_AVAILABLE while it is off), then direct care, then the
 * session's codes at this facility (403 APPOINTMENT_NOT_ALLOWED, in plain
 * words). The database checks all of it again and audits.
 */
function staffContext(request: HidRequest, access: AppointmentAccess): DataAccessContext {
  if (!appointmentsEnabled()) throw notAvailable();
  const context = clinicalContext(request);
  requireAppointmentAccess(request, access);
  return context;
}

const uuid = () => new ParseUUIDPipe();

/**
 * APPT-1 (0160): this facility's appointments. Front desk, clinicians and
 * doctors book and change them; nurses see them. Direct care only. No Health
 * ID or NIN in any path, query or answer.
 */
@Controller('ehr/appointments')
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  /** Route 1: book, from a search's matchRef or this facility's own patient. */
  @Post()
  @HttpCode(201)
  book(@Req() request: HidRequest, @Headers('idempotency-key') key: string | undefined,
    @Body() input: BookAppointmentDto) {
    const context = staffContext(request, 'write');
    return this.appointments.book(context, input, requireIdempotencyKey(key));
  }

  /** Route 2: the day list (a Lagos day), sorted by start time. */
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() request: HidRequest, @Query() query: ListAppointmentsQueryDto) {
    return this.appointments.list(staffContext(request, 'read'), query);
  }

  /** Route 10: who can be booked here (names come from GET identity/facility-staff-names). */
  @Get('bookable-staff')
  @Header('Cache-Control', 'no-store')
  bookableStaff(@Req() request: HidRequest) {
    return this.appointments.bookableStaff(staffContext(request, 'read'));
  }

  /** Route 3: one appointment and its history. */
  @Get(':appointmentId')
  @Header('Cache-Control', 'no-store')
  read(@Req() request: HidRequest, @Param('appointmentId', uuid()) appointmentId: string) {
    return this.appointments.read(staffContext(request, 'read'), appointmentId);
  }

  /** Route 5: reschedule (with a reason; clashes checked again). */
  @Post(':appointmentId/reschedule')
  @HttpCode(200)
  reschedule(@Req() request: HidRequest, @Param('appointmentId', uuid()) appointmentId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: RescheduleAppointmentDto) {
    const context = staffContext(request, 'write');
    return this.appointments.reschedule(context, appointmentId, input, requireIdempotencyKey(key));
  }

  /** Route 6: cancel (with a reason; final). */
  @Post(':appointmentId/cancel')
  @HttpCode(200)
  cancel(@Req() request: HidRequest, @Param('appointmentId', uuid()) appointmentId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: CancelAppointmentDto) {
    const context = staffContext(request, 'write');
    return this.appointments.cancel(context, appointmentId, input, requireIdempotencyKey(key));
  }

  /** Route 7: mark no-show (only after the start time). */
  @Post(':appointmentId/no-show')
  @HttpCode(200)
  noShow(@Req() request: HidRequest, @Param('appointmentId', uuid()) appointmentId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: MarkNoShowDto) {
    const context = staffContext(request, 'write');
    return this.appointments.markNoShow(context, appointmentId, input, requireIdempotencyKey(key));
  }

  /** Route 8: check in to the waiting list (Q-APPT-6 A). Needs the waiting-list codes too. */
  @Post(':appointmentId/check-in')
  @HttpCode(200)
  checkIn(@Req() request: HidRequest, @Param('appointmentId', uuid()) appointmentId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: CheckInAppointmentDto) {
    const context = staffContext(request, 'check-in');
    return this.appointments.checkIn(context, appointmentId, input, requireIdempotencyKey(key));
  }
}

/** Route 4: this facility's appointments for one patient (the patient page's "Appointments" card). */
@Controller('ehr/patients/:patientId/appointments')
export class PatientAppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() request: HidRequest, @Param('patientId', uuid()) patientId: string) {
    return this.appointments.patientList(staffContext(request, 'read'), patientId);
  }
}

/** Route 9: the clinic list. Read with ehr.appointment.read; changed by the hospital administrator (organization.manage). */
@Controller('ehr/appointment-clinics')
export class AppointmentClinicsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Req() request: HidRequest, @Query() query: ListAppointmentClinicsQueryDto) {
    return this.appointments.clinics(staffContext(request, 'settings-read'), query.includeInactive === true);
  }

  @Post()
  @HttpCode(201)
  create(@Req() request: HidRequest, @Headers('idempotency-key') key: string | undefined,
    @Body() input: CreateAppointmentClinicDto) {
    const context = staffContext(request, 'settings-write');
    return this.appointments.createClinic(context, input, requireIdempotencyKey(key));
  }

  @Patch(':clinicId')
  update(@Req() request: HidRequest, @Param('clinicId', uuid()) clinicId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() input: UpdateAppointmentClinicDto) {
    const context = staffContext(request, 'settings-write');
    return this.appointments.updateClinic(context, clinicId, input, requireIdempotencyKey(key));
  }
}

/**
 * Route 9: the facility's default appointment length. The contract's PUT is
 * served as PATCH: ehr-api's CORS answers GET, POST and PATCH only.
 */
@Controller('ehr/appointment-settings')
export class AppointmentSettingsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  read(@Req() request: HidRequest) {
    return this.appointments.settings(staffContext(request, 'settings-read'));
  }

  @Patch()
  save(@Req() request: HidRequest, @Headers('idempotency-key') key: string | undefined,
    @Body() input: SaveAppointmentSettingsDto) {
    const context = staffContext(request, 'settings-write');
    return this.appointments.saveSettings(context, input, requireIdempotencyKey(key));
  }
}

/**
 * Route 12: "My appointments" in the portal (Q-APPT-4 A: read only). The
 * patient's own session only; a staff session answers 403
 * PATIENT_SESSION_REQUIRED.
 */
@Controller('ehr/me/appointments')
@FacilityOptional()
@PatientAllowed()
export class MyAppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  mine(@Req() request: HidRequest, @Query() query: MyAppointmentsQueryDto) {
    if (!appointmentsEnabled()) throw notAvailable();
    return this.appointments.mine(request, query);
  }
}
