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

@Global()
@Module({
  controllers: [AuthController, OtpController],
  providers: [AuthService, AuthSessionAuditService, CurrentStaffContextService, LocalAuthProvider, TokenService, SecurityGuard, WorkloadAuthService, TurnstileService, OtpService, NotificationOtpClient],
  exports: [TokenService, SecurityGuard, WorkloadAuthService],
})
export class AuthModule {}
