import { Module } from '@nestjs/common';
import { getEnvironment } from '../config/environment';
import { TurnstileModule } from '../auth/turnstile.module';
import { NotificationOtpClient } from '../auth/notification-otp.client';
import { IntegrationModule } from '../integrations/integration.module';
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
import { AdminOrganizationApplicationsController, PublicOrganizationApplicationsController,
  PublicOrganizationProfileCompletionController } from './organization-applications.controller';
import { OrganizationApplicationsService } from './organization-applications.service';
import { OrganizationProfileCompletionService } from './organization-profile-completion.service';
import { PatientEnrollmentController } from './patient-enrollment.controller';
import { PatientEnrollmentService } from './patient-enrollment.service';
import { PUBLIC_PATIENT_IDENTITY_PROVIDER, QoreIdPublicPatientIdentityProvider } from './patient-enrollment.provider';

@Module({
  imports: [TurnstileModule, IntegrationModule],
  controllers: [IdentityController, NinRegistrationController, QoreIdVerificationController,
    PublicOrganizationApplicationsController, PublicOrganizationProfileCompletionController,
    AdminOrganizationApplicationsController,
    PatientEnrollmentController],
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
    OrganizationProfileCompletionService,
    NotificationOtpClient,
    PatientEnrollmentService,
    QoreIdPublicPatientIdentityProvider,
    { provide: PUBLIC_PATIENT_IDENTITY_PROVIDER, useExisting: QoreIdPublicPatientIdentityProvider },
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
  exports: [IdentityService, IDENTITY_PROVIDER, HidCodeGenerator, QoreIdVerificationAdapter],
})
export class IdentityModule {}
