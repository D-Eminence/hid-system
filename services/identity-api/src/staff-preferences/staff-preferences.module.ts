import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { StaffPreferencesStartupCheck } from './staff-preferences';
import { StaffPreferencesController } from './staff-preferences.controller';
import { StaffPreferencesOffMiddleware } from './staff-preferences-off.middleware';
import { StaffPreferencesService } from './staff-preferences.service';

/**
 * SX-7 (0206): the signed-in staff member's language and Home shortcuts.
 * DatabaseService and AuditService come from the global modules.
 * StaffPreferencesStartupCheck refuses to start with
 * STAFF_PREFERENCES_ENABLED=true while one of 0206's functions or its grant
 * is missing; while the setting is false the routes answer 404
 * (StaffPreferencesOffMiddleware).
 */
@Module({
  controllers: [StaffPreferencesController],
  providers: [StaffPreferencesService, StaffPreferencesStartupCheck],
})
export class StaffPreferencesModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(StaffPreferencesOffMiddleware).forRoutes(StaffPreferencesController);
  }
}
