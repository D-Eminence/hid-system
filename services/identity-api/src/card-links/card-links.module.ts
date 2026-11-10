import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { CardLinksController } from './card-links.controller';
import { CardLinksEmailDispatcher, CardLinksSweeper } from './card-links.dispatcher';
import { CardLinksOffMiddleware } from './card-links-off.middleware';
import { CardLinksProtector } from './card-links.protector';
import { CardLinksPublicController } from './card-links-public.controller';
import { CardLinksService } from './card-links.service';

/**
 * Card links (0118, Akos handover step 8): the patient's routes, the
 * receiver's public routes, the patient emails and the sweeper.
 * DatabaseService, AuditService, NotificationOtpClient and TurnstileService
 * come from the global modules. While CARD_LINKS_ENABLED is off,
 * CardLinksOffMiddleware answers every route's plain 404 before any guard.
 */
@Module({
  controllers: [CardLinksController, CardLinksPublicController],
  providers: [CardLinksProtector, CardLinksService, CardLinksEmailDispatcher, CardLinksSweeper],
})
export class CardLinksModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CardLinksOffMiddleware).forRoutes(CardLinksController, CardLinksPublicController);
  }
}
