import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuditInterceptor } from './audit/audit.interceptor';
import { AuditModule } from './audit/audit.module';
import { RemoteSecurityGuard } from './auth/remote-security.guard';
import { CorrelationMiddleware } from './common/correlation.middleware';
import { DatabaseModule } from './database/database.module';
import { DocumentModule } from './documents/document.module';
import { EhrModule } from './ehr/ehr.module';
import { CommercialModule } from './commercial/commercial.module';
import { HealthController } from './health.controller';
import { ServiceClientsModule } from './integrations/service-clients.module';
import { OfflineModule } from './offline/offline.module';
import { StorageModule } from './storage/storage.module';
// EHR-C4: the chart summary.
import { ChartSummaryModule } from './ehr/chart-summary/chart-summary.module';

@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    DocumentModule,
    StorageModule,
    EhrModule,
    // BILL-1 (0162-0167): patient billing release 1.
    CommercialModule,
    ServiceClientsModule,
    OfflineModule,
    // EHR-C4: the chart summary.
    ChartSummaryModule,
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
