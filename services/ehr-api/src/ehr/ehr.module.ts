import { Module } from '@nestjs/common';
import { ClinicalNotesModule } from './clinical-notes/clinical-notes.module';
import { DiagnosesModule } from './diagnoses/diagnoses.module';
import { EncountersModule } from './encounters/encounters.module';
import { LabRequestsModule } from './lab-requests/lab-requests.module';
import { PrescriptionsModule } from './prescriptions/prescriptions.module';
import { VitalsModule } from './vitals/vitals.module';
import { OcrIntegrationModule } from './ocr-integration/ocr-integration.module';
import { ImportedHistoryController } from './imported-history/imported-history.controller';
import { StaffImportedHistoryEnabledGuard } from './imported-history/imported-history-enabled.guard';
import { ImportedHistoryService } from './imported-history/imported-history.service';
import { PatientRecordsController } from './patient-records/patient-records.controller';
import { PatientRecordsService } from './patient-records/patient-records.service';
import { ClinicalInfrastructureModule } from './shared/clinical-infrastructure.module';
import { getEnvironment } from '../config/environment';
import { StorageModule } from '../storage/storage.module';
import { configuredPatientRelease, PatientRecordRelease } from './patient-records/patient-release';
import {
  ClaudeRecordChatClient, DISABLED_RECORD_CHAT_PROCESSOR, RECORD_CHAT_PROCESSOR,
} from './record-chat/claude-record-chat.client';
import { PatientRecordChatController } from './record-chat/patient-record-chat.controller';
import { PatientRecordChatService } from './record-chat/patient-record-chat.service';
import {
  RECORD_CHAT_CONFIG, enabledRecordChatConfig, recordChatConfig, type RecordChatConfig,
} from './record-chat/record-chat.config';

@Module({
  imports: [
    ClinicalInfrastructureModule,
    EncountersModule,
    ClinicalNotesModule,
    VitalsModule,
    OcrIntegrationModule,
    DiagnosesModule,
    PrescriptionsModule,
    LabRequestsModule,
    StorageModule,
  ],
  controllers: [PatientRecordsController, ImportedHistoryController, PatientRecordChatController],
  providers: [
    PatientRecordsService,
    // Imported legacy medical history (ADR-066): the patient's own read is a
    // category of the release set below; the staff read has its own switch.
    ImportedHistoryService,
    StaffImportedHistoryEnabledGuard,
    PatientRecordChatService,
    // Patient record chat (owner decision 1 of 2026-10-16): off unless
    // RECORD_CHAT_PATIENT_ENABLED; the Claude client is built only then.
    { provide: RECORD_CHAT_CONFIG, useFactory: () => recordChatConfig(getEnvironment()) },
    { provide: RECORD_CHAT_PROCESSOR, inject: [RECORD_CHAT_CONFIG], useFactory: (config: RecordChatConfig) =>
      (config.patientEnabled ? new ClaudeRecordChatClient(enabledRecordChatConfig(config)) : DISABLED_RECORD_CHAT_PROCESSOR) },
    // The patient record release this deployment configures (one flag per
    // category, the imported history included, default off): the single
    // release set every patient reader uses.
    { provide: PatientRecordRelease, useFactory: () => new PatientRecordRelease(configuredPatientRelease(getEnvironment())) },
  ],
  exports: [PatientRecordRelease],
})
export class EhrModule {}
