import { Module } from '@nestjs/common';
import { ClinicalNotesModule } from './clinical-notes/clinical-notes.module';
import { DiagnosesModule } from './diagnoses/diagnoses.module';
import { EncountersModule } from './encounters/encounters.module';
import { LabRequestsModule } from './lab-requests/lab-requests.module';
import { PrescriptionsModule } from './prescriptions/prescriptions.module';
import { VitalsModule } from './vitals/vitals.module';
import { OcrIntegrationModule } from './ocr-integration/ocr-integration.module';
import { PatientRecordsController } from './patient-records/patient-records.controller';
import { PatientRecordsService } from './patient-records/patient-records.service';
import { ClinicalInfrastructureModule } from './shared/clinical-infrastructure.module';
import { StorageModule } from '../storage/storage.module';
import { ImportedAttachmentService } from './patient-records/imported-attachment.service';
import { BedrockAiService } from './patient-records/bedrock-ai.service';
import { PatientChatService } from './patient-records/patient-chat.service';

@Module({
  imports: [
    ClinicalInfrastructureModule,
    StorageModule,
    EncountersModule,
    ClinicalNotesModule,
    VitalsModule,
    OcrIntegrationModule,
    DiagnosesModule,
    PrescriptionsModule,
    LabRequestsModule,
  ],
  controllers: [PatientRecordsController],
  providers: [PatientRecordsService, ImportedAttachmentService, BedrockAiService, PatientChatService],
})
export class EhrModule {}
