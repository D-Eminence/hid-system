import type { Environment } from '../config/environment';
import { classifyHttp, genericOtpText, type OtpMessage, type OtpProvider, type ProviderResult } from './provider.types';

const BREVO_API_URL = 'https://api.brevo.com';

export class BrevoFallbackProvider implements OtpProvider {
  readonly name = 'brevo' as const;
  constructor(private readonly environment: Environment, private readonly transport: typeof fetch = fetch) {}

  async send(message: OtpMessage): Promise<ProviderResult> {
    if (!this.environment.BREVO_API_KEY) return { outcome: 'definitive_failure', provider: this.name, safeCode: 'not_configured' };
    const request = this.request(message);
    if (!request) return { outcome: 'definitive_failure', provider: this.name, safeCode: 'channel_not_configured' };
    try {
      const response = await this.transport(new URL(request.path, BREVO_API_URL), {
        method: 'POST',
        headers: { accept: 'application/json', 'api-key': this.environment.BREVO_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(this.environment.NOTIFICATION_PROVIDER_TIMEOUT_MS),
      });
      return classifyHttp(this.name, response, await providerMessageId(response));
    } catch {
      return { outcome: 'unknown', provider: this.name, safeCode: 'transport_error' };
    }
  }

  private request(message: OtpMessage): { path: string; body: object } | null {
    const text = genericOtpText(message.code);
    if (message.channel === 'email' && this.environment.BREVO_EMAIL_FROM) {
      return {
        path: '/v3/smtp/email',
        body: {
          sender: { email: this.environment.BREVO_EMAIL_FROM },
          to: [{ email: message.recipient }],
          subject: 'Your HID verification code',
          textContent: text,
        },
      };
    }
    if (message.channel === 'sms' && this.environment.BREVO_SMS_SENDER) {
      return {
        path: '/v3/transactionalSMS/send',
        body: { sender: this.environment.BREVO_SMS_SENDER, recipient: message.recipient, content: text, type: 'transactional' },
      };
    }
    if (message.channel === 'whatsapp' && this.environment.BREVO_WHATSAPP_SENDER) {
      return {
        path: '/v3/whatsapp/sendMessage',
        body: {
          senderNumber: digitsOnly(this.environment.BREVO_WHATSAPP_SENDER),
          contactNumbers: [digitsOnly(message.recipient)],
          text,
        },
      };
    }
    return null;
  }
}

function digitsOnly(value: string): string { return value.startsWith('+') ? value.slice(1) : value; }

async function providerMessageId(response: Response): Promise<string | undefined> {
  try {
    const body = await response.json() as { messageId?: unknown };
    return typeof body.messageId === 'string' || typeof body.messageId === 'number' ? String(body.messageId) : undefined;
  } catch {
    // Provider response bodies are not logged because they can contain sensitive details.
    return undefined;
  }
}
