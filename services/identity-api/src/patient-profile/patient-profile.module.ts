import { Module } from '@nestjs/common';
import { PatientContactChangeService } from './patient-contact-change.service';
import { PatientProfileController } from './patient-profile.controller';
import { PatientProfileService } from './patient-profile.service';

/**
 * The patient's profile (0094). PatientProfileCrypto and PatientContactReader
 * come from the global AuthModule, which also needs them for GET identity/me.
 */
@Module({
  controllers: [PatientProfileController],
  providers: [PatientProfileService, PatientContactChangeService],
})
export class PatientProfileModule {}
