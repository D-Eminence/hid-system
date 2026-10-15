export type DeliveryOutcome = 'accepted' | 'definitive_failure' | 'unknown';
export type OtpChannel = 'email' | 'sms' | 'whatsapp';

export interface ProviderResult {
  outcome: DeliveryOutcome;
  provider: 'ses' | 'termii' | 'meta-whatsapp' | 'brevo' | 'disabled-test';
  providerMessageId?: string;
  safeCode?: string;
}

export interface MessageContent {
  subject: string;
  text: string;
}

export interface OtpMessage {
  channel: OtpChannel;
  recipient: string;
  code: string;
  purpose: string;
  idempotencyKey: string;
  /** Fixed, server-rendered non-OTP content (emergency-contact alerts). */
  content?: MessageContent;
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

/**
 * An emergency contact is not an HID user: the code is relayed to the patient
 * who is adding them, so the generic "do not share" OTP wording does not apply.
 * The message names no patient and contains no clinical information.
 */
export function emergencyContactVerificationText(code: string): string {
  return `Someone is adding you as their emergency contact on HID. If you agree, read this code to them: ${code}. `
    + 'It expires shortly. If you were not expecting this, ignore this message.';
}

/**
 * The code to the phone a NIN record lists (ADR-062). Whoever holds that
 * phone may not be the person registering, so the message says why it came
 * and what to do if it was not them. It names no NIN, person, Health ID or
 * link.
 */
export function ninHolderVerificationText(code: string): string {
  return `Your Health ID code is ${code}. Someone is registering for a Health ID with your NIN. `
    + 'If this was not you, ignore this message. Do not share this code. '
    + 'Health ID will never call or message you to ask for it.';
}

export function messageContent(message: OtpMessage): MessageContent {
  if (message.content) return message.content;
  if (message.purpose === 'EMERGENCY_CONTACT_VERIFY') {
    return { subject: 'HID emergency contact verification', text: emergencyContactVerificationText(message.code) };
  }
  if (message.purpose === 'NIN_HOLDER_VERIFY') {
    return { subject: 'Your Health ID code', text: ninHolderVerificationText(message.code) };
  }
  return { subject: 'Your HID verification code', text: genericOtpText(message.code) };
}

/**
 * WhatsApp delivery uses a pre-approved OTP template only. Purposes with
 * their own wording never go through it.
 */
export function isTemplateOtp(message: OtpMessage): boolean {
  return !message.content && message.purpose !== 'EMERGENCY_CONTACT_VERIFY'
    && message.purpose !== 'NIN_HOLDER_VERIFY';
}

const ALERT_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

/**
 * Minimum-necessary emergency-access alert: the patient's first name, the
 * facility, the time, and safe guidance. Never diagnoses, medications,
 * results, notes, HID, or NIN.
 */
export function emergencyContactAlertContent(input: {
  patientFirstName: string;
  facilityName: string | null;
  occurredAt: Date;
}): MessageContent {
  const where = input.facilityName ? ` at ${input.facilityName}` : '';
  return {
    subject: 'HID emergency access notice',
    text: `HID safety notice: ${input.patientFirstName}, who listed you as an emergency contact, had their health record `
      + `opened for emergency care${where} on ${ALERT_TIME.format(input.occurredAt)} (WAT). `
      + 'This message contains no medical details. If you are concerned, contact them or the facility directly.',
  };
}
