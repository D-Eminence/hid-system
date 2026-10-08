import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IdentityModule } from '../identity/identity.module';
import { IntegrationAdminController } from '../integrations/integration-admin.controller';
import { IntegrationAdminService } from '../integrations/integration-admin.service';
import { AdminController } from './admin.controller';
import { AdminOperationsService } from './admin-operations.service';
import { AdminService } from './admin.service';
import { PlatformSecurityController } from './platform-security.controller';
import { PlatformSecurityService } from './platform-security.service';
import { PricingService } from './pricing.service';
import { PublicPricingController } from './public-pricing.controller';

@Module({
  imports: [DatabaseModule, AuditModule, IdentityModule],
  controllers: [AdminController, PlatformSecurityController, PublicPricingController, IntegrationAdminController],
  providers: [AdminService, AdminOperationsService, PricingService, IntegrationAdminService, PlatformSecurityService],
})
export class AdminModule {}
