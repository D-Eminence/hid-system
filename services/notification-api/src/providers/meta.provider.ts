import type { Environment } from '../config/environment';
import { classifyHttp, type OtpMessage, type OtpProvider, type ProviderResult } from './provider.types';

export class MetaWhatsAppProvider implements OtpProvider {
  readonly name = 'meta-whatsapp' as const;
  constructor(private readonly environment: Environment, private readonly transport: typeof fetch = fetch) {}
  async send(message: OtpMessage): Promise<ProviderResult> {
    const env = this.environment;
    if (message.channel !== 'whatsapp' || !env.META_PHONE_NUMBER_ID || !env.META_ACCESS_TOKEN || !env.META_OTP_TEMPLATE_NAME) return { outcome: 'definitive_failure', provider: this.name, safeCode: 'not_configured' };
    const endpoint = new URL(`/${env.META_GRAPH_API_VERSION}/${encodeURIComponent(env.META_PHONE_NUMBER_ID)}/messages`, env.META_GRAPH_BASE_URL);
    try {
      const response = await this.transport(endpoint, {
        method: 'POST', headers: { authorization: `Bearer ${env.META_ACCESS_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: message.recipient, type: 'template', template: {
          name: env.META_OTP_TEMPLATE_NAME, language: { code: env.META_OTP_TEMPLATE_LANGUAGE }, components: [
            { type: 'body', parameters: [{ type: 'text', text: message.code }] },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: message.code }] },
          ],
        } }), signal: AbortSignal.timeout(env.NOTIFICATION_PROVIDER_TIMEOUT_MS),
      });
      let messageId: string | undefined;
      try { const body = await response.json() as { messages?: Array<{ id?: unknown }> }; if (typeof body.messages?.[0]?.id === 'string') messageId = body.messages[0].id; } catch { /* response body is never logged */ }
      return classifyHttp(this.name, response, messageId);
    } catch { return { outcome: 'unknown', provider: this.name, safeCode: 'transport_error' }; }
  }
}
