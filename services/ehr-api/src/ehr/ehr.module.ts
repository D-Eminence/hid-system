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
import { getEnvironment } from '../config/environment';
import { StorageModule } from '../storage/storage.module';
import { configuredPatientRelease, PatientRecordRelease } from './patient-records/patient-release';

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
  controllers: [PatientRecordsController],
  providers: [
    PatientRecordsService,
    // The patient record release this deployment configures (one flag per
    // category, default off): the single release set every patient reader uses.
    { provide: PatientRecordRelease, useFactory: () => new PatientRecordRelease(configuredPatientRelease(getEnvironment())) },
  ],
  exports: [PatientRecordRelease],
})
export class EhrModule {}
