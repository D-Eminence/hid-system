import { StaffPatientChatController } from './patient-records/staff-patient-chat.controller';
import { StaffChatHistoryService } from './patient-records/staff-chat-history.service';
import { StaffEvidenceService } from './patient-records/staff-evidence.service';
import { StaffChatScopeService } from './patient-records/staff-chat-scope.service';
import { Module } from '@nestjs/common';
import { ClinicalNotesModule } from './clinical-notes/clinical-notes.module';
import { AllergiesModule } from './allergies/allergies.module';
import { DiagnosesModule } from './diagnoses/diagnoses.module';
import { EncountersModule } from './encounters/encounters.module';
import { LabRequestsModule } from './lab-requests/lab-requests.module';
import { OrderRoutesModule } from './order-routes/order-routes.module';
import { PrescriptionsModule } from './prescriptions/prescriptions.module';
import { VitalsModule } from './vitals/vitals.module';
import { OcrIntegrationModule } from './ocr-integration/ocr-integration.module';
import { PatientRecordsController } from './patient-records/patient-records.controller';
import { PatientRecordsService } from './patient-records/patient-records.service';
import { ClinicalInfrastructureModule } from './shared/clinical-infrastructure.module';
import { StorageModule } from '../storage/storage.module';
import { ImportedAttachmentService } from './patient-records/imported-attachment.service';
import { BedrockAiService } from './patient-records/bedrock-ai.service';
import { ClaudeAiService } from './patient-records/claude-ai.service';
import { PatientChatService } from './patient-records/patient-chat.service';
import { PatientChatHistoryService } from './patient-records/patient-chat-history.service';
import { PatientChatSourceService } from './patient-records/patient-chat-source.service';
import { PatientEvidenceService } from './patient-records/patient-evidence.service';
import { PatientAttachmentTextService } from './patient-records/patient-attachment-text.service';
import { HealthProfileController } from './health-profile/health-profile.controller';
import { HealthProfileService } from './health-profile/health-profile.service';
// EHR-C5: one-call consultation.
import { ConsultationsModule } from './consultation/consultations.module';
// EHR-C7 (0135): the waiting list.
import { VisitQueueModule } from './worklist/visit-queue.module';
// ORD-7 (0149): the medicine and lab-test lists.
import { CatalogModule } from './catalog/catalog.module';

import { ConsultationDraftsModule } from './consultation-drafts/consultation-drafts.module';
import { MyOrdersModule } from './my-orders/my-orders.module';
// APPT-1 (0160, 0161): appointments, behind APPOINTMENTS_ENABLED.
import { AppointmentsModule } from './appointments/appointments.module';
@Module({
  imports: [
    ClinicalInfrastructureModule,
    StorageModule,
    EncountersModule,
    ClinicalNotesModule,
    VitalsModule,
    OcrIntegrationModule,
    DiagnosesModule,
    AllergiesModule,
    PrescriptionsModule,
    LabRequestsModule,
    OrderRoutesModule,
    ConsultationDraftsModule,
    MyOrdersModule,
    ConsultationsModule,
    // EHR-C7 (0135): the waiting list.
    VisitQueueModule,
    // ORD-7 (0149): the medicine and lab-test lists.
    CatalogModule,
    // APPT-1 (0160, 0161): appointments, behind APPOINTMENTS_ENABLED.
    AppointmentsModule,
  ],
  controllers: [PatientRecordsController,StaffPatientChatController,HealthProfileController],
  providers: [StaffChatScopeService,StaffEvidenceService,StaffChatHistoryService,PatientRecordsService, ImportedAttachmentService, BedrockAiService, ClaudeAiService, PatientAttachmentTextService,PatientEvidenceService, PatientChatService, PatientChatHistoryService, PatientChatSourceService,
    HealthProfileService],
})
export class EhrModule {}
