import { Module } from '@nestjs/common';
import { getEnvironment } from '../../config/environment';
import { ClinicalInfrastructureModule } from '../shared/clinical-infrastructure.module';
import { ServiceClientsModule } from '../../integrations/service-clients.module';
import { PrescriptionDispensingDetails } from './prescription-dispensing-details';
import { PrescriptionsController } from './prescriptions.controller';
import { PrescriptionsService } from './prescriptions.service';

@Module({
  imports: [ClinicalInfrastructureModule, ServiceClientsModule],
  controllers: [PrescriptionsController],
  providers: [PrescriptionsService,
    // The dispensing details (0114), on only while PRESCRIPTION_DISPENSING_DETAILS_ENABLED is true.
    { provide: PrescriptionDispensingDetails,
      useFactory: () => new PrescriptionDispensingDetails(getEnvironment().PRESCRIPTION_DISPENSING_DETAILS_ENABLED) }],
})
export class PrescriptionsModule {}
