import { Module } from '@nestjs/common';
import { AppointmentCallListController } from './appointment-call-list.controller';
import { AppointmentCallListService } from './appointment-call-list.service';
import { AppointmentNoticeDispatcher } from './appointment-notice.dispatcher';

/**
 * APPT-1 (0161): the printable call list (route 11) and the appointment email
 * and SMS senders, which PatientSafetyModule's PatientLifecycleSweeper runs.
 * DatabaseService and NotificationOtpClient come from the global modules.
 * Everything here is behind APPOINTMENTS_ENABLED.
 */
@Module({
  controllers: [AppointmentCallListController],
  providers: [AppointmentCallListService, AppointmentNoticeDispatcher],
  exports: [AppointmentNoticeDispatcher],
})
export class AppointmentsModule {}
