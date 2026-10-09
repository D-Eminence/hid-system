import { Global, Module } from '@nestjs/common';
import { LabApiService } from './lab-api.service';
import { PharmacyApiService } from './pharmacy-api.service';
import { ServiceWorkloadIdentityService } from './service-workload-identity.service';
import { IdentityApiService } from './identity-api.service';
import { EhrApiService } from './ehr-api.service';

@Global()
@Module({
  providers: [ServiceWorkloadIdentityService, IdentityApiService, EhrApiService, LabApiService, PharmacyApiService],
  exports: [IdentityApiService, EhrApiService, LabApiService, PharmacyApiService],
})
export class ServiceClientsModule {}
