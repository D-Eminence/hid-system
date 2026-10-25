import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { IdentityModule } from '../identity/identity.module';
import { PatientSafetyModule } from '../patient-safety/patient-safety.module';
import { IntegrationAdminController } from '../integrations/integration-admin.controller';
import { IntegrationAdminService } from '../integrations/integration-admin.service';
import { AdminController } from './admin.controller';
import { AdminOperationsService } from './admin-operations.service';
import { AdminService } from './admin.service';
import { PricingService } from './pricing.service';
import { PublicPricingController } from './public-pricing.controller';
import { AdminOrderRouteCommandsController, AdminOrderRouteReadsController } from './order-routes.controller';
import { AdminOrderRoutesService } from './order-routes.service';

@Module({
  imports: [DatabaseModule, AuditModule, IdentityModule, PatientSafetyModule],
  controllers: [AdminController, PublicPricingController, IntegrationAdminController,
    // Orders between facilities (P4c): support's summary, listing, lookup and close.
    AdminOrderRouteReadsController, AdminOrderRouteCommandsController],
  providers: [AdminService, AdminOperationsService, PricingService, IntegrationAdminService, AdminOrderRoutesService],
})
export class AdminModule {}
