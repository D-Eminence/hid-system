import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthSessionAuditService } from './auth-session-audit.service';
import { LocalAuthProvider } from './local-auth.provider';
import { SecurityGuard } from './security.guard';
import { TokenService } from './token.service';
import { CurrentStaffContextService } from './current-staff-context.service';
import { WorkloadAuthService } from './workload-auth.service';
import { TurnstileService } from './turnstile.service';
import { OtpController } from './otp.controller';
import { OtpService } from './otp.service';
import { NotificationOtpClient } from './notification-otp.client';
import { CurrentPatientContextService } from './current-patient-context.service';
import { PatientSelfController } from './patient-self.controller';
import { PatientSelfService } from './patient-self.service';

@Global()
@Module({
  controllers: [AuthController, OtpController, PatientSelfController],
  providers: [AuthService, AuthSessionAuditService, CurrentStaffContextService, CurrentPatientContextService, PatientSelfService, LocalAuthProvider, TokenService, SecurityGuard, WorkloadAuthService, TurnstileService, OtpService, NotificationOtpClient],
  exports: [TokenService, SecurityGuard, WorkloadAuthService],
})
export class AuthModule {}
