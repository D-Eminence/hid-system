import { Module } from '@nestjs/common';
import { getEnvironment } from '../config/environment';
import { IdentityController } from './identity.controller';
import { NinRegistrationController } from './nin-registration.controller';
import { PostgresIdentityProvider } from './postgres-identity.provider';
import { IdentityService } from './identity.service';
import { IDENTITY_PROVIDER } from './identity.types';
import { HidCodeGenerator } from './hid-code-generator.service';
import { NinIdentifierProtector } from './nin-identifier-protector';
import { NinRegistrationService } from './nin-registration.service';
import { DeterministicTestNinVerificationProvider, UnavailableNinVerificationProvider } from './nin-verification.provider';
import { NIN_VERIFICATION_PROVIDER } from './nin.types';

@Module({
  controllers: [IdentityController, NinRegistrationController],
  providers: [
    IdentityService,
    NinRegistrationService,
    NinIdentifierProtector,
    HidCodeGenerator,
    DeterministicTestNinVerificationProvider,
    UnavailableNinVerificationProvider,
    PostgresIdentityProvider,
    {
      provide: IDENTITY_PROVIDER,
      useExisting: PostgresIdentityProvider,
    },
    {
      provide: NIN_VERIFICATION_PROVIDER,
      inject: [DeterministicTestNinVerificationProvider, UnavailableNinVerificationProvider],
      useFactory: (
        deterministicTest: DeterministicTestNinVerificationProvider,
        unavailable: UnavailableNinVerificationProvider,
      ) => getEnvironment().NIN_PROVIDER_MODE === 'test' ? deterministicTest : unavailable,
    },
  ],
  exports: [IdentityService, IDENTITY_PROVIDER, HidCodeGenerator],
})
export class IdentityModule {}
