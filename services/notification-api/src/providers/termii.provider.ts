import type { Environment } from '../config/environment';
import { classifyHttp, genericOtpText, type OtpMessage, type OtpProvider, type ProviderResult } from './provider.types';

export class TermiiSmsProvider implements OtpProvider {
  readonly name = 'termii' as const;
  constructor(private readonly environment: Environment, private readonly transport: typeof fetch = fetch) {}
  async send(message: OtpMessage): Promise<ProviderResult> {
    if (message.channel !== 'sms' || !this.environment.TERMII_BASE_URL || !this.environment.TERMII_API_KEY || !this.environment.TERMII_SENDER_ID) return { outcome: 'definitive_failure', provider: this.name, safeCode: 'not_configured' };
    try {
      const response = await this.transport(new URL('/api/sms/send', this.environment.TERMII_BASE_URL), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: this.environment.TERMII_API_KEY, to: message.recipient, from: this.environment.TERMII_SENDER_ID, sms: genericOtpText(message.code), type: 'plain', channel: this.environment.TERMII_CHANNEL }),
        signal: AbortSignal.timeout(this.environment.NOTIFICATION_PROVIDER_TIMEOUT_MS),
      });
      const payload = await safeJson(response);
      return classifyHttp(this.name, response, stringField(payload, 'message_id') ?? stringField(payload, 'messageId') ?? undefined);
    } catch { return { outcome: 'unknown', provider: this.name, safeCode: 'transport_error' }; }
  }
}

async function safeJson(response: Response): Promise<Record<string, unknown>> { try { const value = await response.json(); return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}; } catch { return {}; } }
function stringField(value: Record<string, unknown>, key: string) { return typeof value[key] === 'string' ? value[key] : null; }
