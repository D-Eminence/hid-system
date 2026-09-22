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
  ],
  controllers: [PatientRecordsController],
  providers: [PatientRecordsService],
})
export class EhrModule {}
