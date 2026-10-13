import { readFile } from 'node:fs/promises';
import { Injectable, Logger } from '@nestjs/common';
import { getEnvironment } from '../config/environment';
import { IntegrationRuntimeService } from '../integrations/integration-runtime.service';
import type { RecoveryOtpPurpose } from './dto/otp.dto';

export type OtpDeliveryOutcome = 'accepted' | 'definitive_failure' | 'unknown';

type WorkloadCredential = { readonly headers: Record<string, string> } | { readonly unavailable: 'missing' | 'invalid' };

@Injectable()
export class NotificationOtpClient {
  private readonly environment = getEnvironment();
  private readonly logger = new Logger(NotificationOtpClient.name);
  private unavailableTokens = 0;

  /**
   * Deliveries this process refused because the workload token file was
   * missing or unusable in JWT mode. Each one is also logged, without any
   * recipient, code or token, as `notification_workload_token_unavailable`.
   */
  get workloadTokenUnavailableCount(): number {
    return this.unavailableTokens;
  }

  constructor(private readonly integrations: IntegrationRuntimeService) {}

  async deliver(input: {
    challengeId: string;
    recipient: string;
    code: string;
    purpose: RecoveryOtpPurpose | 'SIGNUP_VERIFY' | 'EMAIL_VERIFY' | 'EMERGENCY_CONTACT_VERIFY';
    channel?: 'email' | 'sms';
    correlationId: string;
  }): Promise<{ outcome: OtpDeliveryOutcome; provider?: string }> {
    // A missing runtime policy must not disclose account existence: OTP start
    // keeps its generic response, records a failed delivery, and sends nothing.
    const channel = input.channel ?? 'email';
    const plan = await this.integrations.deliveryPlan(channel).catch(() => null);
    if (!plan) return { outcome: 'definitive_failure' };
    return this.post('otp', `otp:${input.challengeId}`, input.correlationId, {
      channel, recipient: input.recipient, code: input.code, purpose: input.purpose,
      plan,
    });
  }

  /**
   * Emergency-access alert to a verified emergency contact. The body is the
   * fixed minimum-necessary set (first name, facility, time); notification-api
   * renders the message and applies the existing provider delivery plan.
   */
  async deliverEmergencyContactAlert(input: {
    notificationId: string;
    channel: 'email' | 'sms';
    recipient: string;
    patientFirstName: string;
    facilityName: string | null;
    occurredAt: Date;
    correlationId: string;
  }): Promise<{ outcome: OtpDeliveryOutcome; provider?: string; safeCode?: string }> {
    const plan = await this.integrations.deliveryPlan(input.channel).catch(() => null);
    if (!plan) return { outcome: 'unknown', safeCode: 'delivery_policy_unavailable' };
    return this.post('emergency-contact-alert', `emergency-contact:${input.notificationId}`, input.correlationId, {
      channel: input.channel, recipient: input.recipient, patientFirstName: input.patientFirstName,
      facilityName: input.facilityName, occurredAt: input.occurredAt.toISOString(), plan,
    });
  }

  private async post(path: 'otp' | 'emergency-contact-alert', idempotencyKey: string, correlationId: string,
    body: Record<string, unknown>): Promise<{ outcome: OtpDeliveryOutcome; provider?: string; safeCode?: string }> {
    const credential = await this.credentials();
    if ('unavailable' in credential) {
      // Without a token Notification can only refuse the call, so nothing is
      // sent. An OTP is reported as not delivered (the caller answers 503 or
      // records the failure); an emergency-contact alert stays retryable,
      // because the agent restores the token once the issuer is reachable.
      this.unavailableTokens += 1;
      this.logger.warn(`Notification workload token unavailable; nothing was sent `
        + `(event=notification_workload_token_unavailable reason=${credential.unavailable} count=${this.unavailableTokens})`);
      return { outcome: path === 'otp' ? 'definitive_failure' : 'unknown', safeCode: 'workload_token_unavailable' };
    }
    let response: Response;
    try {
      response = await fetch(`${this.environment.NOTIFICATION_API_URL.replace(/\/+$/, '')}/api/v1/notifications/${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
          'x-correlation-id': correlationId,
          'x-hid-internal-caller': 'identity-api',
          ...credential.headers,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      return { outcome: 'unknown', safeCode: 'transport_error' };
    }
    if (!response.ok) {
      return { outcome: response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
        ? 'definitive_failure' : 'unknown', safeCode: `http_${response.status}` };
    }
    try {
      const body = await response.json() as { outcome?: unknown; primary?: { provider?: unknown }; fallback?: { provider?: unknown } };
      if (!['accepted', 'definitive_failure', 'unknown'].includes(String(body.outcome))) return { outcome: 'unknown' };
      const provider = body.fallback?.provider ?? body.primary?.provider;
      return {
        outcome: body.outcome as OtpDeliveryOutcome,
        ...(typeof provider === 'string' && /^[a-z][a-z0-9_-]{1,63}$/.test(provider) ? { provider } : {}),
      };
    } catch {
      return { outcome: 'unknown' };
    }
  }

  private async credentials(): Promise<WorkloadCredential> {
    if (this.environment.NOTIFICATION_SERVICE_IDENTITY_MODE === 'local-secret') {
      return { headers: this.environment.NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN
        ? { 'x-hid-service-token': this.environment.NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN }
        : {} };
    }
    // JWT mode: configuration validation requires the path; the agent writes
    // the file and removes it shortly before the token expires.
    const path = this.environment.NOTIFICATION_IDENTITY_WORKLOAD_TOKEN_FILE;
    const token = path ? await readFile(path, 'utf8').catch(() => undefined) : undefined;
    if (token === undefined) return { unavailable: 'missing' };
    const value = token.trim();
    if (!value || value.length > 16_384 || /\s/.test(value)) return { unavailable: 'invalid' };
    return { headers: { 'x-hid-service-authorization': `Bearer ${value}` } };
  }
}
