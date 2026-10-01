import { Body, Controller, Get, Headers, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { TurnstileService } from '../auth/turnstile.service';
import { AuditAction, Public } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { ActivatePatientEnrollmentDto, PatientEnrollmentContactDto,
  StartPatientEnrollmentDto, VerifyPatientEnrollmentContactDto } from './dto/patient-enrollment.dto';
import { PatientEnrollmentService } from './patient-enrollment.service';

const COOKIE_NAME = 'hid_enrollment';

@Controller('identity/patient-enrollments')
@Public()
export class PatientEnrollmentController {
  private readonly environment = getEnvironment();
  private readonly allowedOrigins = new Set(
    this.environment.CORS_ORIGINS.split(',').map((origin) => origin.trim()));

  constructor(private readonly enrollments: PatientEnrollmentService,
    private readonly turnstile: TurnstileService) {}

  @Post()
  @HttpCode(200)
  @AuditAction('identity.patient-enrollment.start')
  async start(@Body() input: StartPatientEnrollmentDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: HidRequest, @Res({ passthrough: true }) response: Response) {
    this.assertOrigin(request);
    await this.turnstile.verify({ token: input.turnstileToken,
      action: input.turnstileAction, origin: request.header('origin'), remoteIp: request.ip });
    const result = await this.enrollments.start(input.nin, idempotencyKey ?? '', request.ip,
      request.correlationId);
    response.cookie(COOKIE_NAME, result.cookie, this.cookieOptions());
    return result.progress;
  }

  @Get('current')
  @AuditAction('identity.patient-enrollment.current')
  current(@Req() request: HidRequest) {
    return this.enrollments.current(this.cookie(request), request.correlationId);
  }

  @Post('contact')
  @HttpCode(200)
  @AuditAction('identity.patient-enrollment.contact')
  contact(@Body() input: PatientEnrollmentContactDto, @Req() request: HidRequest) {
    this.assertOrigin(request);
    return this.enrollments.startContact(this.cookie(request), input.channel,
      input.contact, request.ip, request.correlationId);
  }

  @Post('contact/verify')
  @HttpCode(200)
  @AuditAction('identity.patient-enrollment.contact-verify')
  verifyContact(@Body() input: VerifyPatientEnrollmentContactDto,
    @Req() request: HidRequest) {
    this.assertOrigin(request);
    return this.enrollments.verifyContact(this.cookie(request), input.challengeId,
      input.code, request.correlationId);
  }

  @Post('activate')
  @HttpCode(200)
  @AuditAction('identity.patient-enrollment.activate')
  async activate(@Body() input: ActivatePatientEnrollmentDto,
    @Req() request: HidRequest) {
    this.assertOrigin(request);
    const result = await this.enrollments.activate(this.cookie(request), input.password,
      request.correlationId);
    return result;
  }

  private assertOrigin(request: HidRequest) {
    const origin = request.header('origin');
    if (!origin || !this.allowedOrigins.has(origin)) {
      throw new DomainProblem(403, 'ORIGIN_DENIED', 'Request origin is not allowed');
    }
  }

  private cookie(request: HidRequest): string | undefined {
    const values = (request.header('cookie') ?? '').split(';').map((part) => part.trim())
      .filter((part) => part.startsWith(`${COOKIE_NAME}=`));
    return values.length === 1 ? values[0]?.slice(COOKIE_NAME.length + 1) : undefined;
  }

  private cookieOptions() {
    return { httpOnly: true, sameSite: 'strict' as const,
      secure: this.environment.AUTH_COOKIE_SECURE,
      path: '/api/v1/identity/patient-enrollments', maxAge: 24 * 60 * 60 * 1000 };
  }
}
