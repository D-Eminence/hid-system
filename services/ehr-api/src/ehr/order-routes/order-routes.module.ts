import { Module } from '@nestjs/common';
import { ClinicalInfrastructureModule } from '../shared/clinical-infrastructure.module';
import { OrderRoutesController, PatientOrderRoutesController } from './order-routes.controller';
import { OrderRoutesService } from './order-routes.service';

/** Cross-facility lab requests and prescriptions, the ordering facility's and the patient's side (P4c). */
@Module({
  imports: [ClinicalInfrastructureModule],
  controllers: [OrderRoutesController, PatientOrderRoutesController],
  providers: [OrderRoutesService],
})
export class OrderRoutesModule {}
