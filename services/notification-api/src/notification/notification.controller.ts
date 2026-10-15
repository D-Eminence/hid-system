import { BadRequestException, Body, Controller, ForbiddenException, Headers, HttpCode, Post, Req } from '@nestjs/common';
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
    if (input.purpose === OtpPurpose.EMERGENCY_CONTACT_VERIFY) this.assertEmergencyContactDelivery(input.channel);
    // ADR-062: a NIN holder code goes to the registry phone by SMS, never by another channel.
    if (input.purpose === OtpPurpose.NIN_HOLDER_VERIFY && input.channel !== 'sms') {
      throw new BadRequestException('A NIN holder code is delivered by SMS only');
    }
    // The response requestId is also the correlation id of the PHI-free
    // notification.otp.outcome log line.
    const requestId = randomUUID();
    const result = await this.notifications.deliverOtp({ ...input, idempotencyKey }, input.plan, requestId);
    return this.response(result, requestId);
  }

  @Post('emergency-contact-alert') @HttpCode(202)
  async emergencyContactAlert(@Body() input: DeliverEmergencyContactAlertDto, @Req() request: Request,
    @Headers('idempotency-key') idempotencyKey: string | undefined) {
    await this.auth.authenticate(request.header('x-hid-internal-caller'), request.header('x-hid-service-authorization'), request.header('x-hid-service-token'));
    if (!idempotencyKey || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(idempotencyKey)) {
      throw new BadRequestException('A valid idempotency key is required');
    }
    this.assertEmergencyContactDelivery(input.channel);
    if (!validateRecipient(input.channel, input.recipient)) {
      throw new BadRequestException('Recipient does not match the selected channel');
    }
    const result = await this.notifications.deliverEmergencyContactAlert({
      channel: input.channel, recipient: input.recipient, patientFirstName: input.patientFirstName,
      facilityName: input.facilityName ?? null, occurredAt: new Date(input.occurredAt), idempotencyKey,
    }, input.plan);
    return this.response(result, randomUUID());
  }

  /** Emergency-contact messages reach non-users; production delivery is not approved. */
  private assertEmergencyContactDelivery(channel: string): void {
    if (!getEnvironment().EMERGENCY_CONTACT_DELIVERY_ENABLED || (channel !== 'email' && channel !== 'sms')) {
      throw new ForbiddenException('Emergency-contact delivery is disabled');
    }
  }

  private response(result: DeliveryResult, requestId: string) {
    return {
      requestId, outcome: result.outcome,
      primary: { provider: result.primary.provider, outcome: result.primary.outcome, safeCode: result.primary.safeCode },
      ...(result.fallback ? { fallback: { provider: result.fallback.provider, outcome: result.fallback.outcome, safeCode: result.fallback.safeCode } } : {}),
    };
  }
}
