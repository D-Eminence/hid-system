import { Global,Module } from '@nestjs/common';
import { LabRemoteSecurityGuard } from './lab-remote-security.guard';
import { LabWorkloadIdentityService } from './lab-workload-identity.service';
@Global()
@Module({providers:[LabWorkloadIdentityService,LabRemoteSecurityGuard],exports:[LabRemoteSecurityGuard,LabWorkloadIdentityService]})
export class LabSecurityModule {}
