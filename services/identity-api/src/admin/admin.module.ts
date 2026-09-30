import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { AdminController } from './admin.controller';
import { AdminOperationsService } from './admin-operations.service';
import { AdminService } from './admin.service';
import { PricingService } from './pricing.service';
import { PublicPricingController } from './public-pricing.controller';

@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [AdminController, PublicPricingController],
  providers: [AdminService, AdminOperationsService, PricingService],
})
export class AdminModule {}
