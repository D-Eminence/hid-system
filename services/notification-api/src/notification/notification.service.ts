import { Inject, Injectable, Optional } from '@nestjs/common';
import { getEnvironment } from '../config/environment';
import { InfobipFallbackProvider } from '../providers/infobip.provider';
import { MetaWhatsAppProvider } from '../providers/meta.provider';
import type { OtpMessage, OtpProvider, ProviderResult } from '../providers/provider.types';
import { SesEmailProvider } from '../providers/ses.provider';
import { TermiiSmsProvider } from '../providers/termii.provider';

const NOTIFICATION_PROVIDER_OVERRIDES = Symbol('NOTIFICATION_PROVIDER_OVERRIDES');

@Injectable()
export class NotificationService {
  private readonly environment = getEnvironment();
  private readonly primary: Readonly<Record<OtpMessage['channel'], OtpProvider>>;
  private readonly fallback: OtpProvider;

  constructor(
    @Optional()
    @Inject(NOTIFICATION_PROVIDER_OVERRIDES)
    providers?: { primary: Readonly<Record<OtpMessage['channel'], OtpProvider>>; fallback: OtpProvider },
  ) {
    this.primary = providers?.primary ?? {
      email: new SesEmailProvider(this.environment), sms: new TermiiSmsProvider(this.environment),
      whatsapp: new MetaWhatsAppProvider(this.environment),
    };
    this.fallback = providers?.fallback ?? new InfobipFallbackProvider(this.environment);
  }

  async deliverOtp(message: OtpMessage): Promise<{ primary: ProviderResult; fallback?: ProviderResult; outcome: ProviderResult['outcome'] }> {
    if (this.environment.NOTIFICATION_PROVIDER_MODE === 'disabled') {
      return { primary: { outcome: 'definitive_failure', provider: 'disabled-test', safeCode: 'providers_disabled' }, outcome: 'definitive_failure' };
    }
    const primary = await this.primary[message.channel].send(message);
    if (primary.outcome !== 'definitive_failure') return { primary, outcome: primary.outcome };
    const fallback = await this.fallback.send(message);
    return { primary, fallback, outcome: fallback.outcome };
  }
}
