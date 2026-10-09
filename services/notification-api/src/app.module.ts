import { Module } from '@nestjs/common';
import { WorkloadAuthService } from './auth/workload-auth.service';
import { HealthController } from './health.controller';
import { NotificationController } from './notification/notification.controller';
import { NotificationService } from './notification/notification.service';
@Module({ controllers: [HealthController, NotificationController], providers: [WorkloadAuthService, NotificationService] })
export class AppModule {}
