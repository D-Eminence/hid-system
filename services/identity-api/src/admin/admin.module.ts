import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { AdminController } from './admin.controller';
import { AdminOperationsService } from './admin-operations.service';
import { AdminService } from './admin.service';

@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [AdminController],
  providers: [AdminService, AdminOperationsService],
})
export class AdminModule {}
