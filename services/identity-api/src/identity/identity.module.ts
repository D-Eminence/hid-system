import { Module } from '@nestjs/common';
import { getEnvironment } from '../config/environment';
import { TurnstileModule } from '../auth/turnstile.module';
import { IdentityController } from './identity.controller';
import { NinRegistrationController } from './nin-registration.controller';
import { PostgresIdentityProvider } from './postgres-identity.provider';
import { IdentityService } from './identity.service';
import { IDENTITY_PROVIDER } from './identity.types';
import { HidCodeGenerator } from './hid-code-generator.service';
import { NinIdentifierProtector } from './nin-identifier-protector';
import { NinRegistrationService } from './nin-registration.service';
import { DeferredNinVerificationProvider, DeterministicTestNinVerificationProvider, UnavailableNinVerificationProvider } from './nin-verification.provider';
import { NIN_VERIFICATION_PROVIDER } from './nin.types';
import {
  QOREID_ADAPTER_CONFIGURATION,
  QOREID_FETCH,
  QoreIdVerificationAdapter,
  qoreIdAdapterConfigurationFromEnvironment,
} from './qoreid-verification.adapter';
import { QoreIdVerificationController } from './qoreid-verification.controller';
import { QoreIdVerificationService } from './qoreid-verification.service';
import { AdminOrganizationApplicationsController, PublicOrganizationApplicationsController } from './organization-applications.controller';
import { OrganizationApplicationsService } from './organization-applications.service';

@Module({
  imports: [TurnstileModule],
  controllers: [IdentityController, NinRegistrationController, QoreIdVerificationController,
    PublicOrganizationApplicationsController, AdminOrganizationApplicationsController],
  providers: [
    IdentityService,
    NinRegistrationService,
    NinIdentifierProtector,
    HidCodeGenerator,
    DeterministicTestNinVerificationProvider,
    UnavailableNinVerificationProvider,
    DeferredNinVerificationProvider,
    {
      provide: QOREID_ADAPTER_CONFIGURATION,
      useFactory: qoreIdAdapterConfigurationFromEnvironment,
    },
    {
      provide: QOREID_FETCH,
      useFactory: () => globalThis.fetch,
    },
    QoreIdVerificationAdapter,
    QoreIdVerificationService,
    OrganizationApplicationsService,
    PostgresIdentityProvider,
    {
      provide: IDENTITY_PROVIDER,
      useExisting: PostgresIdentityProvider,
    },
    {
      provide: NIN_VERIFICATION_PROVIDER,
      inject: [DeterministicTestNinVerificationProvider, UnavailableNinVerificationProvider, DeferredNinVerificationProvider],
      useFactory: (
        deterministicTest: DeterministicTestNinVerificationProvider,
        unavailable: UnavailableNinVerificationProvider,
        deferred: DeferredNinVerificationProvider,
      ) => {
        const mode = getEnvironment().NIN_PROVIDER_MODE;
        return mode === 'deferred' ? deferred : mode === 'test' ? deterministicTest : unavailable;
      },
    },
  ],
  exports: [IdentityService, IDENTITY_PROVIDER, HidCodeGenerator],
})
export class IdentityModule {}
