import type { Environment } from '../config/environment';
import { classifyHttp, genericOtpText, type OtpMessage, type OtpProvider, type ProviderResult } from './provider.types';

export class InfobipFallbackProvider implements OtpProvider {
  readonly name = 'infobip' as const;
  constructor(private readonly environment: Environment, private readonly transport: typeof fetch = fetch) {}
  async send(message: OtpMessage): Promise<ProviderResult> {
    if (!this.environment.INFOBIP_BASE_URL || !this.environment.INFOBIP_API_KEY) return { outcome: 'definitive_failure', provider: this.name, safeCode: 'not_configured' };
    const request = this.request(message);
    if (!request) return { outcome: 'definitive_failure', provider: this.name, safeCode: 'channel_not_configured' };
    try {
      const response = await this.transport(new URL(request.path, this.environment.INFOBIP_BASE_URL), {
        method: 'POST', headers: { authorization: `App ${this.environment.INFOBIP_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(this.environment.NOTIFICATION_PROVIDER_TIMEOUT_MS),
      });
      let id: string | undefined;
      try { const body = await response.json() as Record<string, unknown>; id = firstProviderId(body); } catch { /* never log body */ }
      return classifyHttp(this.name, response, id);
    } catch { return { outcome: 'unknown', provider: this.name, safeCode: 'transport_error' }; }
  }
  private request(message: OtpMessage): { path: string; body: object } | null {
    const text = genericOtpText(message.code);
    if (message.channel === 'email' && this.environment.INFOBIP_EMAIL_FROM) return { path: '/email/4/messages', body: { messages: [{ sender: this.environment.INFOBIP_EMAIL_FROM, destinations: [{ to: [{ email: message.recipient }] }], subject: 'Your HID verification code', content: { body: { text } } }] } };
    if (message.channel === 'sms' && this.environment.INFOBIP_SMS_SENDER) return { path: '/sms/3/messages', body: { messages: [{ sender: this.environment.INFOBIP_SMS_SENDER, destinations: [{ to: message.recipient }], content: { body: { text } } }] } };
    if (message.channel === 'whatsapp' && this.environment.INFOBIP_WHATSAPP_SENDER && this.environment.INFOBIP_WHATSAPP_OTP_TEMPLATE_ID) return { path: '/whatsapp/1/message/template', body: { messages: [{ from: this.environment.INFOBIP_WHATSAPP_SENDER, to: message.recipient, content: { templateName: this.environment.INFOBIP_WHATSAPP_OTP_TEMPLATE_ID, templateData: { body: { placeholders: [message.code] }, buttons: [{ type: 'URL', parameter: message.code }] }, language: this.environment.META_OTP_TEMPLATE_LANGUAGE } }] } };
    return null;
  }
}

function firstProviderId(value: Record<string, unknown>): string | undefined {
  for (const key of ['bulkId','messageId','id']) if (typeof value[key] === 'string') return value[key] as string;
  const messages = value.messages; if (Array.isArray(messages) && typeof messages[0]?.messageId === 'string') return messages[0].messageId;
  return undefined;
}
