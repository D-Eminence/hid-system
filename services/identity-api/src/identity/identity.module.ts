import { Module } from '@nestjs/common';
import { getEnvironment } from '../config/environment';
import { AuthModule } from '../auth/auth.module';
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
import { ProviderEnrollmentController } from './provider-enrollment.controller';
import { ProviderEnrollmentService } from './provider-enrollment.service';
import { AdminSelfServiceApplicationsController,
  AdminSelfServiceFacilitiesController } from './self-service-facilities.controller';
import { SelfServiceFacilitiesService } from './self-service-facilities.service';
import { AdminFacilityStaffController } from './admin-facility-staff.controller';
import { FacilityStaffController } from './facility-staff.controller';
import { FacilityStaffService } from './facility-staff.service';
import { StaffInvitationsPublicController } from './staff-invitations-public.controller';
import { StaffInvitationsSignedInController } from './staff-invitations-signed-in.controller';
import { StaffInvitationsService } from './staff-invitations.service';
import { StaffReauthenticationService } from './staff-reauthentication.service';
import { OrderDestinationsController } from './order-destinations.controller';
import { OrderDestinationsService } from './order-destinations.service';

@Module({
  imports: [AuthModule, TurnstileModule, IntegrationModule],
  controllers: [IdentityController, NinRegistrationController, QoreIdVerificationController,
    PublicOrganizationApplicationsController, PublicOrganizationProfileCompletionController,
    AdminOrganizationApplicationsController,
    PatientEnrollmentController,
    ProviderEnrollmentController,
    AdminSelfServiceFacilitiesController, AdminSelfServiceApplicationsController,
    // Facility staff invitations (P4b). The static segments (open, accept,
    // signed-in/preview, signed-in/accept) never match :invitationId/resend or
    // :invitationId/revoke.
    StaffInvitationsSignedInController, StaffInvitationsPublicController, FacilityStaffController,
    AdminFacilityStaffController,
    // The directory of laboratories and pharmacies an order can go to (P4c).
    OrderDestinationsController],
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
    ProviderEnrollmentService,
    SelfServiceFacilitiesService,
    StaffInvitationsService,
    FacilityStaffService,
    StaffReauthenticationService,
    OrderDestinationsService,
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
