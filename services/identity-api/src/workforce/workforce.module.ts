import { Module } from '@nestjs/common';
import { DutyRosterController } from './duty-roster.controller';
import { DutyRosterService } from './duty-roster.service';
import { StaffLicencesController } from './staff-licences.controller';
import { StaffLicencesService } from './staff-licences.service';

/**
 * ROS-1 (0199-0202): Shifts, rosters, HR and credentials. Licence renewals
 * behind HR_CREDENTIALS_ENABLED, leave, department in-charges and the duty
 * roster behind DUTY_ROSTER_ENABLED; both off by default.
 */
@Module({
  controllers: [StaffLicencesController, DutyRosterController],
  providers: [StaffLicencesService, DutyRosterService],
})
export class WorkforceModule {}
