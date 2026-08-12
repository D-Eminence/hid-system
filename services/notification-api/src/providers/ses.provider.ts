import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { Environment } from '../config/environment';
import { genericOtpText, type OtpMessage, type OtpProvider, type ProviderResult } from './provider.types';

export class SesEmailProvider implements OtpProvider {
  readonly name = 'ses' as const;
  constructor(private readonly environment: Environment, private readonly client = new SESv2Client({ region: environment.AWS_REGION, maxAttempts: 1 })) {}
  async send(message: OtpMessage): Promise<ProviderResult> {
    if (message.channel !== 'email' || !this.environment.SES_FROM_ADDRESS) return { outcome: 'definitive_failure', provider: this.name, safeCode: 'not_configured' };
    try {
      const response = await this.client.send(new SendEmailCommand({
        FromEmailAddress: this.environment.SES_FROM_ADDRESS,
        Destination: { ToAddresses: [message.recipient] },
        Content: { Simple: { Subject: { Data: 'Your HID verification code', Charset: 'UTF-8' }, Body: { Text: { Data: genericOtpText(message.code), Charset: 'UTF-8' } } } },
      }), { abortSignal: AbortSignal.timeout(this.environment.NOTIFICATION_PROVIDER_TIMEOUT_MS) });
      return response.MessageId ? { outcome: 'accepted', provider: this.name, providerMessageId: response.MessageId }
        : { outcome: 'unknown', provider: this.name, safeCode: 'missing_message_id' };
    } catch (error) {
      const name = error instanceof Error ? error.name : 'unknown';
      if (['BadRequestException','MessageRejected','MailFromDomainNotVerifiedException','NotFoundException','AccountSuspendedException','SendingPausedException'].includes(name)) {
        return { outcome: 'definitive_failure', provider: this.name, safeCode: name };
      }
      return { outcome: 'unknown', provider: this.name, safeCode: name === 'AbortError' ? 'timeout' : 'transport_error' };
    }
  }
}
