import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { CardLinksOffMiddleware } from './card-links-off.middleware';
import { CardShareRecordsController } from './card-share-records.controller';
import { CardShareRecordsService } from './card-share-records.service';

/**
 * The records a card link shows (0118). DatabaseService comes from the
 * global module. While CARD_LINKS_ENABLED is off, CardLinksOffMiddleware
 * answers the route's plain 404 before any guard runs; the service checks
 * again.
 */
@Module({
  controllers: [CardShareRecordsController],
  providers: [CardShareRecordsService],
})
export class CardShareModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CardLinksOffMiddleware).forRoutes(CardShareRecordsController);
  }
}
