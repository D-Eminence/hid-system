import { BadRequestException, Body, Controller, ForbiddenException, Headers, HttpCode, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { WorkloadAuthService } from '../auth/workload-auth.service';
import { getEnvironment } from '../config/environment';
import { DeliverEmergencyContactAlertDto } from './dto/deliver-emergency-contact-alert.dto';
import { DeliverOtpDto, OtpPurpose, validateRecipient } from './dto/deliver-otp.dto';
import { DeliverPasswordResetCodeDto, DeliverPasswordUpdatedDto,
  DeliverPatientWelcomeDto } from './dto/deliver-patient-emails.dto';
import { DeliverStaffInvitationDto } from './dto/deliver-staff-invitation.dto';
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

  /**
   * A facility staff invitation (P4b): fixed fields, email only, workload
   * authentication and idempotency key exactly as the alert. There is no
   * delivery switch here: Identity's staff_invitations_enabled control gates
   * every invitation before it calls this route.
   */
  @Post('staff-invitation') @HttpCode(202)
  async staffInvitation(@Body() input: DeliverStaffInvitationDto, @Req() request: Request,
    @Headers('idempotency-key') idempotencyKey: string | undefined) {
    await this.auth.authenticate(request.header('x-hid-internal-caller'), request.header('x-hid-service-authorization'), request.header('x-hid-service-token'));
    if (!idempotencyKey || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(idempotencyKey)) {
      throw new BadRequestException('A valid idempotency key is required');
    }
    if (input.channel !== 'email' || !validateRecipient('email', input.recipient)) {
      throw new BadRequestException('Recipient does not match the selected channel');
    }
    const result = await this.notifications.deliverStaffInvitation({
      recipient: input.recipient, facilityName: input.facilityName ?? null, roleCode: input.roleCode,
      invitationId: input.invitationId, token: input.token, code: input.code,
      expiresAt: new Date(input.expiresAt), idempotencyKey,
    }, input.plan);
    return this.response(result);
  }

  /**
   * "Your Health ID is ready" (owner decision of 2026-10-28): the welcome
   * email of a first activation. Fixed fields, email only, workload
   * authentication and idempotency key as the invitation.
   */
  @Post('patient-welcome') @HttpCode(202)
  async patientWelcome(@Body() input: DeliverPatientWelcomeDto, @Req() request: Request,
    @Headers('idempotency-key') idempotencyKey: string | undefined) {
    await this.authenticateEmailRequest(request, idempotencyKey, input);
    const result = await this.notifications.deliverPatientWelcome({ recipient: input.recipient,
      ...(input.firstName ? { firstName: input.firstName } : {}), healthId: input.healthId,
      idempotencyKey: idempotencyKey! }, input.plan);
    return this.response(result);
  }

  /**
   * A patient's password reset code in hid-1.0's design (owner decision of
   * 2026-10-28). Its own route, not new fields on POST otp, so an older
   * notification-api answers a newer Identity 404 and Identity sends the
   * generic code instead.
   */
  @Post('password-reset-code') @HttpCode(202)
  async passwordResetCode(@Body() input: DeliverPasswordResetCodeDto, @Req() request: Request,
    @Headers('idempotency-key') idempotencyKey: string | undefined) {
    await this.authenticateEmailRequest(request, idempotencyKey, input);
    const result = await this.notifications.deliverPasswordResetCode({ recipient: input.recipient,
      code: input.code, ...(input.firstName ? { firstName: input.firstName } : {}), healthId: input.healthId,
      expiresInMinutes: input.expiresInMinutes, idempotencyKey: idempotencyKey! }, input.plan);
    return this.response(result);
  }

  /** "Your Health ID password was updated", after a completed reset (owner decision of 2026-10-28). */
  @Post('password-updated') @HttpCode(202)
  async passwordUpdated(@Body() input: DeliverPasswordUpdatedDto, @Req() request: Request,
    @Headers('idempotency-key') idempotencyKey: string | undefined) {
    await this.authenticateEmailRequest(request, idempotencyKey, input);
    const result = await this.notifications.deliverPasswordUpdated({ recipient: input.recipient,
      ...(input.firstName ? { firstName: input.firstName } : {}),
      ...(input.healthId ? { healthId: input.healthId } : {}), idempotencyKey: idempotencyKey! }, input.plan);
    return this.response(result);
  }

  /** Workload authentication first, then the idempotency key, then an email recipient on the email channel. */
  private async authenticateEmailRequest(request: Request, idempotencyKey: string | undefined,
    input: { channel: string; recipient: string }): Promise<void> {
    await this.auth.authenticate(request.header('x-hid-internal-caller'), request.header('x-hid-service-authorization'), request.header('x-hid-service-token'));
    if (!idempotencyKey || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(idempotencyKey)) {
      throw new BadRequestException('A valid idempotency key is required');
    }
    if (input.channel !== 'email' || !validateRecipient('email', input.recipient)) {
      throw new BadRequestException('Recipient does not match the selected channel');
    }
  }

  private response(result: DeliveryResult) {
    return {
      requestId: randomUUID(), outcome: result.outcome,
      primary: { provider: result.primary.provider, outcome: result.primary.outcome, safeCode: result.primary.safeCode },
      ...(result.fallback ? { fallback: { provider: result.fallback.provider, outcome: result.fallback.outcome, safeCode: result.fallback.safeCode } } : {}),
    };
  }
}
