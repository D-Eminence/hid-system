import { Module } from '@nestjs/common';
import { FacilityStaffNamesController } from './facility-staff-names.controller';
import { FacilityStaffNamesService } from './facility-staff-names.service';
import { StaffProfileController } from './staff-profile.controller';
import { StaffProfileService } from './staff-profile.service';

/**
 * Lane B staff reads with no migration: the signed-in member's own profile
 * (SX-5) and the names of a facility's staff for its saved lists (SX-9).
 */
@Module({
  controllers: [StaffProfileController, FacilityStaffNamesController],
  providers: [StaffProfileService, FacilityStaffNamesService],
})
export class StaffProfileModule {}
