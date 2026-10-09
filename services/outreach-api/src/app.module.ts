import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { OutreachAuditModule } from './audit/outreach-audit.module';
import { OutreachSecurityGuard } from './auth/outreach-security.guard';
import { OutreachSecurityModule } from './auth/outreach-security.module';
import { CorrelationMiddleware } from './common/correlation.middleware';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health.controller';
import { OutreachModule } from './outreach/outreach.module';

@Module({
  imports: [DatabaseModule, OutreachAuditModule, OutreachSecurityModule, OutreachModule],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useExisting: OutreachSecurityGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('{*path}');
  }
}
