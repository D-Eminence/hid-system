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
  /**
   * The HTML part of an email (the patient emails in hid-1.0's design),
   * sent with the text part as multipart/alternative. SMS and WhatsApp use
   * the text only.
   */
  html?: string;
}

export interface OtpMessage {
  channel: OtpChannel;
  recipient: string;
  code: string;
  purpose: string;
  idempotencyKey: string;
  /** Fixed, server-rendered content (emergency-contact alerts, invitations, the patient emails). */
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

/**
 * The lower-case role label a staff invitation names (P4b, SPEC 4.2): the
 * five roles a self-signed-up facility may invite. No other role can be sent.
 */
export const STAFF_ROLE_LABELS = {
  doctor: 'doctor',
  nurse: 'nurse',
  lab: 'laboratory scientist',
  pharmacist: 'pharmacist',
  receptionist: 'receptionist',
} as const;
export type StaffInvitationRole = keyof typeof STAFF_ROLE_LABELS;
export const STAFF_INVITATION_ROLES = Object.keys(STAFF_ROLE_LABELS) as readonly StaffInvitationRole[];

/**
 * Where the invitation link opens: the portal host of this deployment, fixed
 * by HID_DEPLOYMENT_ENV and never taken from a request (SPEC 4.6), so a caller
 * cannot point the link at another site.
 */
export function staffInvitationLinkOrigin(deployment: 'development' | 'staging' | 'production'): string {
  if (deployment === 'staging') return 'https://staging.healthidentitydirectory.com';
  if (deployment === 'development') return 'http://localhost:5173';
  return 'https://app.healthidentitydirectory.com';
}

/** The invitation's reference for support: the first 8 hex characters of its id, upper case (S10.4). */
export function staffInvitationReference(invitationId: string): string {
  return invitationId.replace(/-/g, '').slice(0, 8).toUpperCase();
}

/**
 * A facility staff invitation (P4b, SPEC 4.6), plain text (only the patient
 * emails of patient-emails.ts have an HTML part). It names no person: no invitee, no inviter and no free text (S3).
 * The facility's name appears only when Identity sent one that the DTO
 * accepted (no link-like or domain-like text); otherwise "a facility". The
 * link carries the invitation id and its 256-bit token in the fragment, which
 * browsers do not send to any server; the 6-digit code is the typed fallback.
 */
export function staffInvitationContent(input: {
  facilityName?: string | null;
  roleCode: StaffInvitationRole;
  invitationId: string;
  token: string;
  code: string;
  expiresAt: Date;
  origin: string;
  supportEmail: string;
}): MessageContent {
  const facility = input.facilityName || 'a facility';
  const page = `${input.origin}/provider/invitation`;
  return {
    subject: `Invitation to join ${facility} on Health ID`,
    text: 'Hello,\n\n'
      + `The administrator of ${facility} has invited you to join the facility on Health ID as a ${STAFF_ROLE_LABELS[input.roleCode]}.\n\n`
      + `To accept, open this link:\n${page}#${input.invitationId}.${input.token}\n\n`
      + `If the link does not open, go to ${page} and enter this email address and the code ${input.code}.\n\n`
      + `The invitation expires on ${alertTime(input.expiresAt)} (WAT). If you were not expecting it, you can ignore this email: `
      + 'nothing happens unless you accept. To report it, write to Health ID support at '
      + `${input.supportEmail} and quote reference ${staffInvitationReference(input.invitationId)}.`,
  };
}
