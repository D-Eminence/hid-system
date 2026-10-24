import { BadRequestException, Body, Controller, ForbiddenException, Headers, HttpCode, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { WorkloadAuthService } from '../auth/workload-auth.service';
import { getEnvironment } from '../config/environment';
import { DeliverEmergencyContactAlertDto } from './dto/deliver-emergency-contact-alert.dto';
import { DeliverOtpDto, OtpPurpose, validateRecipient } from './dto/deliver-otp.dto';
import { type DeliveryResult, NotificationService } from './notification.service';

@Controller('notifications')
export class NotificationController {
  constructor(private readonly auth: WorkloadAuthService, private readonly notifications: NotificationService) {}

  @Post('otp') @HttpCode(202)
  async otp(@Body() input: DeliverOtpDto, @Req() request: Request,
    @Headers('idempotency-key') idempotencyKey: string | undefined) {
    await this.auth.authenticate(request.header('x-hid-internal-caller'), request.header('x-hid-service-authorization'), request.header('x-hid-service-token'));
    if (!idempotencyKey || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(idempotencyKey)) {
      throw new BadRequestException('A valid idempotency key is required');
    }
    if (!validateRecipient(input.channel, input.recipient)) {
      throw new BadRequestException('Recipient does not match the selected channel');
    }
    // Emergency-contact codes reach people who are not Health ID users.
    if (input.purpose === OtpPurpose.EMERGENCY_CONTACT_VERIFY
        && (!getEnvironment().EMERGENCY_CONTACT_DELIVERY_ENABLED || (input.channel !== 'email' && input.channel !== 'sms'))) {
      throw new ForbiddenException('Emergency-contact delivery is disabled');
    }
    const result = await this.notifications.deliverOtp({ ...input, idempotencyKey }, input.plan);
    return this.response(result);
  }

  @Post('emergency-contact-alert') @HttpCode(202)
  async emergencyContactAlert(@Body() input: DeliverEmergencyContactAlertDto, @Req() request: Request,
    @Headers('idempotency-key') idempotencyKey: string | undefined) {
    await this.auth.authenticate(request.header('x-hid-internal-caller'), request.header('x-hid-service-authorization'), request.header('x-hid-service-token'));
    if (!idempotencyKey || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(idempotencyKey)) {
      throw new BadRequestException('A valid idempotency key is required');
    }
    // 503, not 403: identity-api retries a 5xx, so an alert sent while the two
    // services' switches disagree stays pending instead of closing as failed.
    if (!getEnvironment().EMERGENCY_CONTACT_DELIVERY_ENABLED) {
      throw new ServiceUnavailableException({ statusCode: 503, error: 'Service Unavailable',
        code: 'EMERGENCY_CONTACT_DELIVERY_DISABLED', message: 'Emergency-contact delivery is disabled' });
    }
    if (input.channel !== 'email' && input.channel !== 'sms') {
      throw new BadRequestException('Emergency-contact alerts are delivered by email or SMS only');
    }
    if (!validateRecipient(input.channel, input.recipient)) {
      throw new BadRequestException('Recipient does not match the selected channel');
    }
    const result = await this.notifications.deliverEmergencyContactAlert({
      channel: input.channel, recipient: input.recipient, patientFullName: input.patientFullName,
      patientHidSuffix: input.patientHidSuffix, clinicianName: input.clinicianName ?? null,
      facilityName: input.facilityName ?? null, facilityPhone: input.facilityPhone ?? null,
      occurredAt: new Date(input.occurredAt), idempotencyKey,
    }, input.plan);
    return this.response(result);
  }

  private response(result: DeliveryResult) {
    return {
      requestId: randomUUID(), outcome: result.outcome,
      primary: { provider: result.primary.provider, outcome: result.primary.outcome, safeCode: result.primary.safeCode },
      ...(result.fallback ? { fallback: { provider: result.fallback.provider, outcome: result.fallback.outcome, safeCode: result.fallback.safeCode } } : {}),
    };
  }
}
