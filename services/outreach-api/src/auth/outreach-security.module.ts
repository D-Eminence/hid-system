import { Global, Module } from '@nestjs/common';
import { OutreachSecurityGuard } from './outreach-security.guard';
import { WorkloadCredentialsService } from './workload-credentials.service';

@Global()
@Module({
  providers: [OutreachSecurityGuard, WorkloadCredentialsService],
  exports: [OutreachSecurityGuard, WorkloadCredentialsService],
})
export class OutreachSecurityModule {}
