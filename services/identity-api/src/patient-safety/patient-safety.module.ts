import { Module } from '@nestjs/common';
import { WebPushModule } from '../web-push/web-push.module';
import { AccountDeletionNoticeDispatcher } from './account-deletion-notice.dispatcher';
import { EmergencyContactController } from './emergency-contact.controller';
import { EmergencyContactNotificationDispatcher } from './emergency-contact-notification.dispatcher';
import { EmergencyContactProtector } from './emergency-contact-protector';
import { EmergencyContactService } from './emergency-contact.service';
import { PatientAccountDeletionController } from './patient-account-deletion.controller';
import { PatientAccountDeletionService } from './patient-account-deletion.service';
import { PatientLifecycleSweeper } from './patient-lifecycle.sweeper';
import { RecordAccessAlertDispatcher } from './record-access-alert.dispatcher';

@Module({
  // The sweeper's web push steps (0097, B6).
  imports: [WebPushModule],
  controllers: [EmergencyContactController, PatientAccountDeletionController],
  providers: [
    EmergencyContactProtector, EmergencyContactService,
    EmergencyContactNotificationDispatcher, RecordAccessAlertDispatcher,
    PatientAccountDeletionService, AccountDeletionNoticeDispatcher, PatientLifecycleSweeper,
  ],
  // Support's opt-out (AdminService) keys a destination the same way.
  exports: [EmergencyContactProtector],
})
export class PatientSafetyModule {}
