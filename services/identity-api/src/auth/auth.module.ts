import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthSessionAuditService } from './auth-session-audit.service';
import { LocalAuthProvider } from './local-auth.provider';
import { SecurityGuard } from './security.guard';
import { TokenService } from './token.service';
import { CurrentStaffContextService } from './current-staff-context.service';
import { FacilitySelectionStartupCheck } from './facility-selection';
import { WorkloadAuthService } from './workload-auth.service';
import { TurnstileModule } from './turnstile.module';
import { OtpController } from './otp.controller';
import { OtpService } from './otp.service';
import { NotificationOtpClient } from './notification-otp.client';
import { CurrentPatientContextService } from './current-patient-context.service';
import { PatientSelfController } from './patient-self.controller';
import { PatientSelfService } from './patient-self.service';
import { GoogleAuthenticationService } from './google-authentication.service';
import { IntegrationModule } from '../integrations/integration.module';
import { PatientContactReader } from '../patient-profile/patient-contact-reader';
import { PatientProfileCrypto } from '../patient-profile/patient-profile-crypto';
import { SsoController } from './sso/sso.controller';
import { SsoProviderClient } from './sso/sso-provider.client';
import { SsoService } from './sso/sso.service';

@Global()
@Module({
  imports: [TurnstileModule, IntegrationModule],
  // SsoController's routes, and AuthController's POST /auth/sso/logout, exist
  // only while single sign-on is configured (SsoRouteGuard, ADR-070, 0127).
  controllers: [AuthController, OtpController, PatientSelfController, SsoController],
  providers: [AuthService, AuthSessionAuditService, CurrentStaffContextService, CurrentPatientContextService, PatientSelfService, LocalAuthProvider, TokenService, SecurityGuard, WorkloadAuthService, OtpService, NotificationOtpClient, GoogleAuthenticationService,
    PatientProfileCrypto, PatientContactReader, SsoProviderClient, SsoService, FacilitySelectionStartupCheck],
  // FacilitySelectionStartupCheck: with STAFF_FACILITY_SELECTION_MODE on,
  // Identity refuses to start while 0129's table or one of its grants is missing.
  // AuthService: facility self sign-up signs the new administrator in (P4).
  // LocalAuthProvider and AuthSessionAuditService: the password re-entry of
  // facility staff management (P4b).
  // PatientProfileCrypto and PatientContactReader: GET identity/me's contact
  // fields here, and the patient profile routes (0094).
  exports: [AuthService, TokenService, SecurityGuard, WorkloadAuthService, TurnstileModule, GoogleAuthenticationService, NotificationOtpClient,
    LocalAuthProvider, AuthSessionAuditService, PatientProfileCrypto, PatientContactReader],
})
export class AuthModule {}
