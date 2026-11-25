import { Module } from '@nestjs/common';
import { ServiceClientsModule } from '../../integrations/service-clients.module';
import {
  AppointmentClinicsController, AppointmentSettingsController, AppointmentsController, MyAppointmentsController,
  PatientAppointmentsController,
} from './appointments.controller';
import { AppointmentReminderSweeper, AppointmentsService } from './appointments.service';

/** APPT-1 (0160, 0161): appointments, check-in to the waiting list, "My appointments" and the reminder sweep. */
@Module({
  imports: [ServiceClientsModule],
  controllers: [AppointmentsController, PatientAppointmentsController, AppointmentClinicsController,
    AppointmentSettingsController, MyAppointmentsController],
  providers: [AppointmentsService, AppointmentReminderSweeper],
})
export class AppointmentsModule {}
