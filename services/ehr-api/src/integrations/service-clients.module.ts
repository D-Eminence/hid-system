import { Global, Module } from '@nestjs/common';
import { LabApiService } from './lab-api.service';
import { PharmacyApiService } from './pharmacy-api.service';
import { ServiceWorkloadIdentityService } from './service-workload-identity.service';
import { IdentityApiService } from './identity-api.service';
// ORD-3: own pharmacy and laboratory progress on prescriptions and lab requests.
import { WorkItemProgressService } from './work-item-progress.service';

@Global()
@Module({
  providers: [ServiceWorkloadIdentityService, IdentityApiService, LabApiService, PharmacyApiService,
    WorkItemProgressService],
  exports: [IdentityApiService, LabApiService, PharmacyApiService, WorkItemProgressService],
})
export class ServiceClientsModule {}
