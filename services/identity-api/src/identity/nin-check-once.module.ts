import { Module } from '@nestjs/common';
import { NinCheckOnce } from './nin-check-once';
import { NinIdentifierProtector } from './nin-identifier-protector';

/**
 * Check a NIN once (0137, Q109): every path that sends a patient NIN to QoreID
 * uses NinCheckOnce. Its own module so the patient lifecycle sweeper (which
 * erases expired answers) and IdentityModule (sign-up, profile, desk) share it.
 */
@Module({
  providers: [NinCheckOnce, NinIdentifierProtector],
  exports: [NinCheckOnce],
})
export class NinCheckOnceModule {}
