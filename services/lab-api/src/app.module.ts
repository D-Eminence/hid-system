import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuditInterceptor } from './audit/audit.interceptor';
import { LabAuditModule } from './audit/lab-audit.module';
import { LabSecurityModule } from './auth/lab-security.module';
import { LabRemoteSecurityGuard } from './auth/lab-remote-security.guard';
import { CorrelationMiddleware } from './common/correlation.middleware';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health.controller';
import { LabIdentityAuthorizationModule } from './identity/lab-identity-authorization.module';
import { LabModule } from './lab/lab.module';

@Module({
  imports: [
    DatabaseModule,
    LabAuditModule,
    LabSecurityModule,
    LabIdentityAuthorizationModule,
    LabModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useExisting: LabRemoteSecurityGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('{*path}');
  }
}
