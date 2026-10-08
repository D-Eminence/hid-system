import { Module } from '@nestjs/common';
import { EmergencyContactController } from './emergency-contact.controller';
import { EmergencyContactNotificationDispatcher } from './emergency-contact-notification.dispatcher';
import { EmergencyContactProtector } from './emergency-contact-protector';
import { EmergencyContactService } from './emergency-contact.service';
import { PatientAccountDeletionController } from './patient-account-deletion.controller';
import { PatientAccountDeletionService } from './patient-account-deletion.service';
import { PatientLifecycleSweeper } from './patient-lifecycle.sweeper';

@Module({
  controllers: [PatientAccountDeletionController, EmergencyContactController],
  providers: [
    PatientAccountDeletionService, EmergencyContactProtector, EmergencyContactService,
    EmergencyContactNotificationDispatcher, PatientLifecycleSweeper,
  ],
})
export class PatientSafetyModule {}
