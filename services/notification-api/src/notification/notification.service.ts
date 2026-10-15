import { BadRequestException, HttpException, Inject, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { getEnvironment, type Environment } from '../config/environment';
import { BrevoFallbackProvider } from '../providers/brevo.provider';
import { MetaWhatsAppProvider } from '../providers/meta.provider';
import { emergencyContactAlertContent, type OtpMessage, type OtpProvider, type ProviderResult } from '../providers/provider.types';
import { SesEmailProvider } from '../providers/ses.provider';
import { TermiiSmsProvider } from '../providers/termii.provider';

const NOTIFICATION_PROVIDER_OVERRIDES = Symbol('NOTIFICATION_PROVIDER_OVERRIDES');
type ProviderName = 'ses' | 'termii' | 'meta-whatsapp' | 'brevo';
export type DeliveryResult = { primary: ProviderResult; fallback?: ProviderResult; outcome: ProviderResult['outcome'] };
type DeliveryPlan = { capability: OtpMessage['channel']; primary: ProviderName; fallback: ProviderName | null;
  configuration: Partial<Record<ProviderName, Record<string, string>>> };
const supported: Record<OtpMessage['channel'], readonly ProviderName[]> = {
  email: ['ses', 'brevo'], sms: ['termii', 'brevo'], whatsapp: ['meta-whatsapp', 'brevo'],
};
// Provider result codes that are fixed vocabulary, never provider text: the
// codes the adapters return and the SES exception names they classify.
const loggableSafeCodes = new Set(['not_configured', 'channel_not_configured', 'transport_error', 'timeout',
  'missing_message_id', 'unsupported_message', 'providers_disabled', 'BadRequestException', 'MessageRejected',
  'MailFromDomainNotVerifiedException', 'NotFoundException', 'AccountSuspendedException', 'SendingPausedException',
  // A send this service refused (4xx) or could not route (policy unavailable).
  'refused', 'unavailable']);
type OtpOutcome = 'accepted' | 'retryable_failure' | 'definitive_failure';
const otpOutcome: Record<ProviderResult['outcome'], OtpOutcome> = {
  accepted: 'accepted', unknown: 'retryable_failure', definitive_failure: 'definitive_failure',
};
const settings: Record<ProviderName, Record<string, RegExp>> = {
  ses: { fromAddress: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
  termii: { senderId: /^[A-Za-z0-9]{3,20}$/, channel: /^(generic|dnd)$/ },
  'meta-whatsapp': { phoneNumberId: /^\d{5,30}$/, templateName: /^[A-Za-z0-9_]{2,120}$/,
    templateLanguage: /^[a-z]{2}_[A-Z]{2}$/ },
  brevo: { emailFrom: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    smsSender: /^[A-Za-z0-9]{3,20}$/, whatsappSender: /^\+[1-9]\d{7,14}$/ },
};

@Injectable()
export class NotificationService {
  private readonly environment = getEnvironment();
  private readonly primary: Readonly<Record<OtpMessage['channel'], OtpProvider>>;
  private readonly fallback: OtpProvider;
  private readonly overridden: boolean;

  constructor(
    @Optional()
    @Inject(NOTIFICATION_PROVIDER_OVERRIDES)
    providers?: { primary: Readonly<Record<OtpMessage['channel'], OtpProvider>>; fallback: OtpProvider },
  ) {
    this.overridden = Boolean(providers);
    this.primary = providers?.primary ?? {
      email: new SesEmailProvider(this.environment), sms: new TermiiSmsProvider(this.environment),
      whatsapp: new MetaWhatsAppProvider(this.environment),
    };
    this.fallback = providers?.fallback ?? new BrevoFallbackProvider(this.environment);
  }

  /**
   * Delivers one OTP and writes exactly one PHI-free `notification.otp.outcome`
   * line for it (D4, NOTIF-PROD): channel, purpose, outcome, the provider that
   * answered last, whether the fallback ran, a correlation id and a fixed safe
   * code; when the fallback ran, also the primary provider and its fixed safe
   * code, so an unconfigured fallback cannot hide why the primary failed.
   * Never the recipient, the code, the message or provider text. The
   * CloudWatch metric filter counts `definitive_failure` lines.
   */
  async deliverOtp(message: OtpMessage, rawPlan?: unknown, correlationId: string = randomUUID()): Promise<DeliveryResult> {
    let result: DeliveryResult;
    try {
      result = await this.deliver(message, rawPlan);
    } catch (error) {
      // A refused or unroutable send reaches nobody: the operator must see it.
      this.logOtpOutcome(message, correlationId, 'definitive_failure', 'none', false,
        error instanceof HttpException && error.getStatus() < 500 ? 'refused' : 'unavailable');
      throw error;
    }
    const last = result.fallback ?? result.primary;
    this.logOtpOutcome(message, correlationId, otpOutcome[result.outcome], last.provider, Boolean(result.fallback), last.safeCode,
      result.fallback ? result.primary : undefined);
    return result;
  }

  private logOtpOutcome(message: OtpMessage, correlationId: string, outcome: OtpOutcome, provider: string,
    fallbackUsed: boolean, safeCode?: string, primary?: ProviderResult): void {
    const loggable = (code?: string): code is string =>
      code !== undefined && (loggableSafeCodes.has(code) || /^http_\d{3}$/.test(code));
    process.stdout.write(`${JSON.stringify({
      event: 'notification.otp.outcome', channel: message.channel,
      purpose: /^[A-Z_]{3,64}$/.test(message.purpose) ? message.purpose : 'unknown',
      outcome, provider, fallbackUsed, correlationId,
      ...(loggable(safeCode) ? { safeCode } : {}),
      ...(primary ? { primaryProvider: primary.provider, ...(loggable(primary.safeCode) ? { primarySafeCode: primary.safeCode } : {}) } : {}),
    })}\n`);
  }

  private async deliver(message: OtpMessage, rawPlan?: unknown): Promise<DeliveryResult> {
    // ADR-062: a NIN holder code goes only to the registry phone, by SMS.
    if (message.purpose === 'NIN_HOLDER_VERIFY' && message.channel !== 'sms') {
      throw new BadRequestException('A NIN holder code is delivered by SMS only');
    }
    if (this.environment.NOTIFICATION_DELIVERY_PROFILE === 'email-only' && message.channel !== 'email') {
      throw new BadRequestException('This delivery profile supports email OTP only');
    }
    if (this.environment.NOTIFICATION_DELIVERY_PROFILE === 'otp-email-sms' && message.channel === 'whatsapp') {
      throw new BadRequestException('This delivery profile supports email and SMS OTP only');
    }
    if (this.environment.NOTIFICATION_PROVIDER_MODE === 'disabled') {
      return { primary: { outcome: 'definitive_failure', provider: 'disabled-test', safeCode: 'providers_disabled' }, outcome: 'definitive_failure' };
    }
    if (rawPlan === undefined && this.environment.NOTIFICATION_PROVIDER_MODE === 'live') {
      throw new ServiceUnavailableException('Delivery policy is unavailable');
    }
    const plan = rawPlan === undefined ? null : this.validatePlan(message.channel, rawPlan);
    if (this.environment.NOTIFICATION_DELIVERY_PROFILE === 'email-only' && plan && plan.primary !== 'ses') {
      throw new ServiceUnavailableException('Staging email delivery is unavailable');
    }
    const first = plan ? this.provider(plan.primary, plan.configuration[plan.primary] ?? {}, message.channel)
      : this.primary[message.channel];
    const primary = await first.send(message);
    if (primary.outcome !== 'definitive_failure') return { primary, outcome: primary.outcome };
    // Staging email acceptance uses SES only. An unavailable primary remains a
    // real failure; inactive providers are neither attempted nor reported as sent.
    if (this.environment.NOTIFICATION_DELIVERY_PROFILE === 'email-only') return { primary, outcome: primary.outcome };
    const next = plan ? (plan.fallback ? this.provider(plan.fallback, plan.configuration[plan.fallback] ?? {}, message.channel) : null)
      : this.fallback;
    if (!next) return { primary, outcome: primary.outcome };
    const fallback = await next.send(message);
    return { primary, fallback, outcome: fallback.outcome };
  }

  /** Renders the fixed minimum-necessary alert and uses the same provider delivery plan as OTP. */
  deliverEmergencyContactAlert(input: {
    channel: 'email' | 'sms';
    recipient: string;
    patientFirstName: string;
    facilityName: string | null;
    occurredAt: Date;
    idempotencyKey: string;
  }, rawPlan?: unknown): Promise<DeliveryResult> {
    return this.deliver({
      channel: input.channel, recipient: input.recipient, code: '', purpose: 'EMERGENCY_CONTACT_ALERT',
      idempotencyKey: input.idempotencyKey,
      content: emergencyContactAlertContent({
        patientFirstName: input.patientFirstName, facilityName: input.facilityName, occurredAt: input.occurredAt,
      }),
    }, rawPlan);
  }

  private provider(name: ProviderName, configuration: Record<string, string>, channel: OtpMessage['channel']): OtpProvider {
    if (this.overridden) {
      if (this.primary[channel].name === name) return this.primary[channel];
      if (this.fallback.name === name) return this.fallback;
      throw new ServiceUnavailableException('Selected provider is unavailable');
    }
    const env: Environment = { ...this.environment,
      ...(name === 'ses' && configuration.fromAddress ? { SES_FROM_ADDRESS: configuration.fromAddress } : {}),
      ...(name === 'termii' ? {
        ...(configuration.senderId ? { TERMII_SENDER_ID: configuration.senderId } : {}),
        ...(configuration.channel ? { TERMII_CHANNEL: configuration.channel } : {}),
      } : {}),
      ...(name === 'meta-whatsapp' ? {
        ...(configuration.phoneNumberId ? { META_PHONE_NUMBER_ID: configuration.phoneNumberId } : {}),
        ...(configuration.templateName ? { META_OTP_TEMPLATE_NAME: configuration.templateName } : {}),
        ...(configuration.templateLanguage ? { META_OTP_TEMPLATE_LANGUAGE: configuration.templateLanguage } : {}),
      } : {}),
      ...(name === 'brevo' ? {
        ...(configuration.emailFrom ? { BREVO_EMAIL_FROM: configuration.emailFrom } : {}),
        ...(configuration.smsSender ? { BREVO_SMS_SENDER: configuration.smsSender } : {}),
        ...(configuration.whatsappSender ? { BREVO_WHATSAPP_SENDER: configuration.whatsappSender } : {}),
      } : {}),
    };
    if (name === 'ses') return new SesEmailProvider(env);
    if (name === 'termii') return new TermiiSmsProvider(env);
    if (name === 'meta-whatsapp') return new MetaWhatsAppProvider(env);
    return new BrevoFallbackProvider(env);
  }

  private validatePlan(channel: OtpMessage['channel'], value: unknown): DeliveryPlan {
    const plan = this.record(value);
    if (!plan || plan.capability !== channel || typeof plan.primary !== 'string'
      || !supported[channel].includes(plan.primary as ProviderName)
      || (plan.fallback !== null && (typeof plan.fallback !== 'string'
        || !supported[channel].includes(plan.fallback as ProviderName)))
      || plan.fallback === plan.primary) throw new BadRequestException('Invalid delivery policy');
    const configurations = this.record(plan.configuration);
    if (!configurations || Object.keys(configurations).some((name) =>
      name !== plan.primary && name !== plan.fallback)) throw new BadRequestException('Invalid delivery policy');
    for (const [name, raw] of Object.entries(configurations)) {
      const config = this.record(raw);
      const allowlist = settings[name as ProviderName];
      if (!config || !allowlist || Object.entries(config).some(([key, field]) =>
        typeof field !== 'string' || field.length > 120 || !allowlist[key]?.test(field))) {
        throw new BadRequestException('Invalid delivery policy');
      }
    }
    return plan as DeliveryPlan;
  }

  private record(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  }
}
