import { Module } from '@nestjs/common';
import { EmergencyContactController } from './emergency-contact.controller';
import { EmergencyContactNotificationDispatcher } from './emergency-contact-notification.dispatcher';
import { EmergencyContactProtector } from './emergency-contact-protector';
import { EmergencyContactService } from './emergency-contact.service';
import { PatientLifecycleSweeper } from './patient-lifecycle.sweeper';

@Module({
  controllers: [EmergencyContactController],
  providers: [
    EmergencyContactProtector, EmergencyContactService,
    EmergencyContactNotificationDispatcher, PatientLifecycleSweeper,
  ],
  // Support's opt-out (AdminService) keys a destination the same way.
  exports: [EmergencyContactProtector],
})
export class PatientSafetyModule {}
