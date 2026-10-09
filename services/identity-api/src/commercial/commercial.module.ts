import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { AdminDemoRequestsController, PublicDemoRequestsController } from './demo-requests.controller';
import { DemoRequestsService } from './demo-requests.service';

@Module({
  imports: [AuditModule, AuthModule, DatabaseModule],
  controllers: [PublicDemoRequestsController, AdminDemoRequestsController],
  providers: [DemoRequestsService],
})
export class CommercialModule {}
