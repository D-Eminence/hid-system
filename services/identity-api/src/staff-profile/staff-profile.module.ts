import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { FacilityStaffNamesController } from './facility-staff-names.controller';
import { FacilityStaffNamesService } from './facility-staff-names.service';
import {
  OwnNameChangeOffMiddleware, OwnPasswordChangeOffMiddleware, StaffProfileChangeStartupCheck,
} from './staff-profile-changes';
import { StaffProfileChangesController } from './staff-profile-changes.controller';
import { StaffProfileChangesService } from './staff-profile-changes.service';
import { StaffProfileController } from './staff-profile.controller';
import { StaffProfileService } from './staff-profile.service';

/**
 * Lane B staff reads with no migration: the signed-in member's own profile
 * (SX-5) and the names of a facility's staff for its saved lists (SX-9); and
 * SX-6 (0205), the member's own password change and name edit, each behind
 * its setting (a 404 while off) and refusing to start while 0205 is missing
 * with its setting on. TokenService, LocalAuthProvider,
 * AuthSessionAuditService and NotificationOtpClient come from the global
 * AuthModule; DatabaseService and AuditService from the global modules.
 */
@Module({
  controllers: [StaffProfileController, StaffProfileChangesController, FacilityStaffNamesController],
  providers: [StaffProfileService, StaffProfileChangesService, StaffProfileChangeStartupCheck, FacilityStaffNamesService],
})
export class StaffProfileModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(OwnPasswordChangeOffMiddleware).forRoutes({ path: 'identity/me/password', method: RequestMethod.POST });
    consumer.apply(OwnNameChangeOffMiddleware).forRoutes({ path: 'identity/me/staff-profile', method: RequestMethod.POST });
  }
}
