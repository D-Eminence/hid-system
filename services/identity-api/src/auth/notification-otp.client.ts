import { readFile } from 'node:fs/promises';
import { Injectable } from '@nestjs/common';
import { getEnvironment } from '../config/environment';
import type { RecoveryOtpPurpose } from './dto/otp.dto';

export type OtpDeliveryOutcome = 'accepted' | 'definitive_failure' | 'unknown';

@Injectable()
export class NotificationOtpClient {
  private readonly environment = getEnvironment();

  async deliver(input: {
    challengeId: string;
    recipient: string;
    code: string;
    purpose: RecoveryOtpPurpose;
    correlationId: string;
  }): Promise<{ outcome: OtpDeliveryOutcome; provider?: string }> {
    let response: Response;
    try {
      response = await fetch(`${this.environment.NOTIFICATION_API_URL.replace(/\/+$/, '')}/api/v1/notifications/otp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `otp:${input.challengeId}`,
          'x-correlation-id': input.correlationId,
          'x-hid-internal-caller': 'identity-api',
          ...await this.credentials(),
        },
        body: JSON.stringify({
          channel: 'email', recipient: input.recipient, code: input.code, purpose: input.purpose,
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      return { outcome: 'unknown' };
    }
    if (!response.ok) {
      return { outcome: response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
        ? 'definitive_failure' : 'unknown' };
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

  private async credentials(): Promise<Record<string, string>> {
    if (this.environment.NOTIFICATION_SERVICE_IDENTITY_MODE === 'local-secret') {
      return this.environment.NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN
        ? { 'x-hid-service-token': this.environment.NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN }
        : {};
    }
    const path = this.environment.NOTIFICATION_IDENTITY_WORKLOAD_TOKEN_FILE;
    if (!path) return {};
    const token = (await readFile(path, 'utf8').catch(() => '')).trim();
    if (!token || token.length > 16_384 || /\s/.test(token)) return {};
    return { 'x-hid-service-authorization': `Bearer ${token}` };
  }
}
