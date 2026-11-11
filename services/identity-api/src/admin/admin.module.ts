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
import { HealthIdInUrlRefusalModule } from './health-id-in-url';
import { AdminOcrUsageController } from './ocr-usage.controller';
import { AdminOcrUsageService } from './ocr-usage.service';

@Module({
  imports: [DatabaseModule, AuditModule, IdentityModule, PatientSafetyModule, HealthIdInUrlRefusalModule],
  controllers: [AdminController, PublicPricingController, IntegrationAdminController,
    // Orders between facilities (P4c): support's summary, listing, lookup and close.
    AdminOrderRouteReadsController, AdminOrderRouteCommandsController,
    // OCR page allowance and monthly use per facility (migration 0107).
    AdminOcrUsageController],
  providers: [AdminService, AdminOperationsService, PricingService, IntegrationAdminService, AdminOrderRoutesService,
    AdminOcrUsageService],
})
export class AdminModule {}
