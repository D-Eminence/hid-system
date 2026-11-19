import { Module } from '@nestjs/common';
import { ClinicalNotesModule } from '../clinical-notes/clinical-notes.module';
import { DiagnosesModule } from '../diagnoses/diagnoses.module';
import { EncountersModule } from '../encounters/encounters.module';
import { ClinicalInfrastructureModule } from '../shared/clinical-infrastructure.module';
import { VitalsModule } from '../vitals/vitals.module';
import { ConsultationsController } from './consultations.controller';
import { ConsultationsService } from './consultations.service';

/** EHR-C5: the one-call consultation, built on the visit, note, vitals and diagnosis services. */
@Module({
  imports: [ClinicalInfrastructureModule, EncountersModule, ClinicalNotesModule, VitalsModule, DiagnosesModule],
  controllers: [ConsultationsController],
  providers: [ConsultationsService],
})
export class ConsultationsModule {}
