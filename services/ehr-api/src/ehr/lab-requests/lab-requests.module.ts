import { Module } from '@nestjs/common';
import { ClinicalInfrastructureModule } from '../shared/clinical-infrastructure.module';
import { ServiceClientsModule } from '../../integrations/service-clients.module';
import { LAB_REQUEST_GROUPS_PROVIDER } from './lab-request-groups';
import { LabRequestGroupsController } from './lab-request-groups.controller';
import { LabRequestsController } from './lab-requests.controller';
import { LabRequestsService } from './lab-requests.service';

@Module({
  imports: [ClinicalInfrastructureModule, ServiceClientsModule],
  // ORD-6 (0158): the group route and LAB_REQUEST_GROUPS_ENABLED (LabRequestGroups).
  controllers: [LabRequestsController, LabRequestGroupsController],
  providers: [LabRequestsService, LAB_REQUEST_GROUPS_PROVIDER],
})
export class LabRequestsModule {}
