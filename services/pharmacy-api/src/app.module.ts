import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PharmacyAuditModule } from './audit/pharmacy-audit.module';
import { PharmacySecurityGuard } from './auth/pharmacy-security.guard';
import { PharmacySecurityModule } from './auth/pharmacy-security.module';
import { CorrelationMiddleware } from './common/correlation.middleware';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health.controller';
import { PharmacyModule } from './pharmacy/pharmacy.module';

@Module({
  imports: [DatabaseModule, PharmacyAuditModule, PharmacySecurityModule, PharmacyModule],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useExisting: PharmacySecurityGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('{*path}');
  }
}
