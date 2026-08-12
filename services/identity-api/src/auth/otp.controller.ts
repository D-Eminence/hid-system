import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { AuditFailuresOnly, Public } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { CompleteOtpDto, StartOtpDto, VerifyOtpDto } from './dto/otp.dto';
import { OtpService } from './otp.service';
import { TurnstileService } from './turnstile.service';

@Controller('auth/otp')
@Public()
@AuditFailuresOnly()
export class OtpController {
  private readonly allowedOrigins = new Set(
    getEnvironment().CORS_ORIGINS.split(',').map((origin) => origin.trim()),
  );

  constructor(private readonly otp: OtpService, private readonly turnstile: TurnstileService) {}

  @Post('start')
  @HttpCode(202)
  async start(@Body() input: StartOtpDto, @Req() request: HidRequest) {
    this.assertAllowedOrigin(request);
    await this.turnstile.verify({
      token: input.turnstileToken,
      action: input.turnstileAction,
      origin: request.header('origin'),
      remoteIp: request.ip,
    });
    return this.otp.start({
      identifier: input.identifier,
      purpose: input.purpose,
      remoteIp: request.ip,
      correlationId: request.correlationId,
    });
  }

  @Post('verify')
  @HttpCode(200)
  verify(@Body() input: VerifyOtpDto, @Req() request: HidRequest) {
    this.assertAllowedOrigin(request);
    return this.otp.verify({ ...input, correlationId: request.correlationId });
  }

  @Post('complete')
  @HttpCode(200)
  complete(@Body() input: CompleteOtpDto, @Req() request: HidRequest) {
    this.assertAllowedOrigin(request);
    return this.otp.complete({ ...input, correlationId: request.correlationId });
  }

  private assertAllowedOrigin(request: HidRequest): void {
    const origin = request.header('origin');
    if (!origin || !this.allowedOrigins.has(origin)) {
      throw new DomainProblem(403, 'ORIGIN_DENIED', 'Request origin is not allowed');
    }
  }
}
