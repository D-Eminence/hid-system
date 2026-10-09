import { Global, Module } from '@nestjs/common';
import { PharmacySecurityGuard } from './pharmacy-security.guard';
import { PharmacyWorkloadIdentityService } from './pharmacy-workload-identity.service';

@Global()
@Module({ providers: [PharmacyWorkloadIdentityService, PharmacySecurityGuard],
  exports: [PharmacySecurityGuard, PharmacyWorkloadIdentityService] })
export class PharmacySecurityModule {}
