import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuditInterceptor } from './audit/audit.interceptor';
import { AuditModule } from './audit/audit.module';
import { RemoteSecurityGuard } from './auth/remote-security.guard';
import { CorrelationMiddleware } from './common/correlation.middleware';
import { DatabaseModule } from './database/database.module';
import { DocumentModule } from './documents/document.module';
import { EhrModule } from './ehr/ehr.module';
import { HealthController } from './health.controller';
import { ServiceClientsModule } from './integrations/service-clients.module';
import { OfflineModule } from './offline/offline.module';
import { StorageModule } from './storage/storage.module';
// EHR-C4: the chart summary.
import { ChartSummaryModule } from './ehr/chart-summary/chart-summary.module';
// REP-1 (0203, 0204): the facility's operations report.
import { ReportsModule } from './reports/reports.module';

@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    DocumentModule,
    StorageModule,
    EhrModule,
    ServiceClientsModule,
    OfflineModule,
    // EHR-C4: the chart summary.
    ChartSummaryModule,
    // REP-1 (0203, 0204): the facility's operations report.
    ReportsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: RemoteSecurityGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('{*path}');
  }
}
