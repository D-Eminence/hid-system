import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthSessionAuditService } from './auth-session-audit.service';
import { LocalAuthProvider } from './local-auth.provider';
import { SecurityGuard } from './security.guard';
import { TokenService } from './token.service';
import { CurrentStaffContextService } from './current-staff-context.service';
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
import { MfaSecretProtector } from './mfa/mfa-secret-protector';
import { MfaService } from './mfa/mfa.service';
import { PlatformAuthController } from './platform-auth.controller';

@Global()
@Module({
  imports: [TurnstileModule, IntegrationModule],
  controllers: [AuthController, PlatformAuthController, OtpController, PatientSelfController],
  providers: [AuthService, AuthSessionAuditService, CurrentStaffContextService, CurrentPatientContextService, PatientSelfService, LocalAuthProvider, TokenService, SecurityGuard, WorkloadAuthService, OtpService, NotificationOtpClient, GoogleAuthenticationService, MfaSecretProtector, MfaService],
  exports: [AuthService, TokenService, MfaService, SecurityGuard, WorkloadAuthService, TurnstileModule, GoogleAuthenticationService, NotificationOtpClient],
})
export class AuthModule {}
