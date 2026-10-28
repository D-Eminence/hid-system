import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { WebPushConfiguredGuard } from './web-push-configured.guard';
import { WebPushController } from './web-push.controller';
import { WebPushDispatcher } from './web-push.dispatcher';
import { WebPushOffMiddleware } from './web-push-off.middleware';
import { WebPushProtector } from './web-push.protector';
import { WebPushService } from './web-push.service';

/**
 * Phone and computer notifications (B6, 0097): the patient's routes and the
 * sweeper's dispatcher (PatientSafetyModule's PatientLifecycleSweeper runs
 * its prune and dispatch steps). DatabaseService and NotificationOtpClient
 * come from the global modules. While push is off, WebPushOffMiddleware
 * answers the routes' 404 before any guard runs; WebPushConfiguredGuard on
 * the controller checks again.
 */
@Module({
  controllers: [WebPushController],
  providers: [WebPushConfiguredGuard, WebPushProtector, WebPushService, WebPushDispatcher],
  exports: [WebPushDispatcher],
})
export class WebPushModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(WebPushOffMiddleware).forRoutes(WebPushController);
  }
}
