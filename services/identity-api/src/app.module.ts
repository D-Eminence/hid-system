import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuditInterceptor } from './audit/audit.interceptor';
import { AuditModule } from './audit/audit.module';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { SecurityGuard } from './auth/security.guard';
import { CorrelationMiddleware } from './common/correlation.middleware';
import { ConsentModule } from './consent/consent.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health.controller';
import { IdentityModule } from './identity/identity.module';

@Module({
  imports: [DatabaseModule, AuditModule, AuthModule, ConsentModule, IdentityModule, AdminModule],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useExisting: SecurityGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('{*path}');
  }
}
