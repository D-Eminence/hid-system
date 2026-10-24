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
 * An emergency contact is not a Health ID user: the code is relayed to the
 * patient who is adding them, so the generic "do not share" OTP wording does
 * not apply. The message names no patient and contains no clinical information.
 */
export function emergencyContactVerificationText(code: string): string {
  return `Someone is adding you as their emergency contact on Health ID. If you agree, read this code to them: ${code}. `
    + 'It expires shortly. If you were not expecting this, ignore this message.';
}

export function messageContent(message: OtpMessage): MessageContent {
  if (message.content) return message.content;
  if (message.purpose === 'EMERGENCY_CONTACT_VERIFY') {
    return { subject: 'Health ID emergency contact verification', text: emergencyContactVerificationText(message.code) };
  }
  return { subject: 'Your HID verification code', text: genericOtpText(message.code) };
}

/**
 * WhatsApp delivery uses a pre-approved OTP template only. Purposes with
 * their own wording never go through it.
 */
export function isTemplateOtp(message: OtpMessage): boolean {
  return !message.content && message.purpose !== 'EMERGENCY_CONTACT_VERIFY';
}

// `d MMM yyyy, HH:mm` in Lagos time. The month is spelt from a fixed table:
// en-GB short months vary by ICU version (September is "Sept" on Node 22).
const ALERT_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Lagos', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  hourCycle: 'h23',
});
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export function alertTime(value: Date): string {
  const parts = Object.fromEntries(ALERT_TIME.formatToParts(value).map((part) => [part.type, part.value]));
  return `${Number(parts.day)} ${MONTHS[Number(parts.month) - 1]} ${parts.year}, ${parts.hour}:${parts.minute}`;
}

/** A Nigerian number as `+234 XXX XXX XXXX`; any other E.164 number as is. */
export function displayPhone(e164: string): string {
  const nigerian = /^\+234(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return nigerian ? `+234 ${nigerian[1]} ${nigerian[2]} ${nigerian[3]}` : e164;
}

/**
 * The emergency-access alert to a verified contact: the patient's full name,
 * the last four characters of their Health ID, who opened the record and
 * where, the fixed reason "for emergency care", the time, and whom to call.
 * Every value is validated by the alert DTO; there is no free-text slot, so
 * the clinician's typed break-glass reason can never be sent.
 */
export function emergencyContactAlertContent(input: {
  patientFullName: string;
  patientHidSuffix: string;
  clinicianName: string | null;
  facilityName: string | null;
  facilityPhone: string | null;
  occurredAt: Date;
  supportPhone: string;
  supportEmail: string;
}): MessageContent {
  const where = input.facilityName ? ` at ${input.facilityName}` : '';
  const support = `contact Health ID support on ${displayPhone(input.supportPhone)} or ${input.supportEmail}.`;
  const contact = input.facilityPhone
    ? `For more information, call ${input.facilityName || 'the facility'} on ${displayPhone(input.facilityPhone)}. `
      + `To stop these alerts, ${support}`
    : `For more information, or to stop these alerts, ${support}`;
  return {
    subject: 'Health ID emergency access notice',
    text: `Health ID safety notice: ${input.patientFullName} (Health ID ending ${input.patientHidSuffix}), who listed you `
      + 'as an emergency contact, had their health record opened for emergency care by '
      + `${input.clinicianName || 'a health worker'}${where} on ${alertTime(input.occurredAt)} (WAT). ${contact}`,
  };
}
