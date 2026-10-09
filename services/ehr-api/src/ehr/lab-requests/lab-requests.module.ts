import { Module } from '@nestjs/common';
import { ClinicalInfrastructureModule } from '../shared/clinical-infrastructure.module';
import { ServiceClientsModule } from '../../integrations/service-clients.module';
import { LabRequestsController } from './lab-requests.controller';
import { LabRequestsService } from './lab-requests.service';

@Module({
  imports: [ClinicalInfrastructureModule, ServiceClientsModule],
  controllers: [LabRequestsController],
  providers: [LabRequestsService],
})
export class LabRequestsModule {}
