import { Module } from '@nestjs/common';
import { WorkloadAuthService } from './auth/workload-auth.service';
import { HealthController } from './health.controller';
import { NotificationController } from './notification/notification.controller';
import { NotificationService } from './notification/notification.service';
import { WebPushProvider } from './providers/web-push';
@Module({ controllers: [HealthController, NotificationController], providers: [WorkloadAuthService, NotificationService,
  WebPushProvider] })
export class AppModule {}
