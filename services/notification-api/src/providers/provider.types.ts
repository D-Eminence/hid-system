export type DeliveryOutcome = 'accepted' | 'definitive_failure' | 'unknown';
export type OtpChannel = 'email' | 'sms' | 'whatsapp';

export interface ProviderResult {
  outcome: DeliveryOutcome;
  provider: 'ses' | 'termii' | 'meta-whatsapp' | 'infobip' | 'disabled-test';
  providerMessageId?: string;
  safeCode?: string;
}

export interface OtpMessage {
  channel: OtpChannel;
  recipient: string;
  code: string;
  purpose: string;
  idempotencyKey: string;
}

export interface OtpProvider {
  readonly name: ProviderResult['provider'];
  send(message: OtpMessage): Promise<ProviderResult>;
}

export function classifyHttp(provider: ProviderResult['provider'], response: Response, messageId?: string): ProviderResult {
  if (response.ok) return { outcome: 'accepted', provider, ...(messageId ? { providerMessageId: messageId } : {}) };
  if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
    return { outcome: 'definitive_failure', provider, safeCode: `http_${response.status}` };
  }
  return { outcome: 'unknown', provider, safeCode: `http_${response.status}` };
}

export function genericOtpText(code: string): string {
  return `Your HID verification code is ${code}. It expires shortly. Do not share this code.`;
}
