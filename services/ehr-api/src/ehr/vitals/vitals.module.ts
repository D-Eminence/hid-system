import { Module } from '@nestjs/common';
import { ClinicalInfrastructureModule } from '../shared/clinical-infrastructure.module';
import { PatientVitalsController } from './patient-vitals.controller';
import { VitalsController } from './vitals.controller';
import { VitalsService } from './vitals.service';

@Module({
  imports: [ClinicalInfrastructureModule],
  controllers: [VitalsController, PatientVitalsController],
  providers: [VitalsService],
})
export class VitalsModule {}
