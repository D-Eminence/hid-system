import { hidEmailHtml, hidEmailText, type HidEmail } from './email-layout';
import type { MessageContent } from './provider.types';

/**
 * The patient emails of hid-1.0 (owner decision of 2026-10-28), in its
 * layout, colours and wording, with hid-1.0's "HID" spelt "Health ID". Each
 * has a plain-text part and an HTML part. None carries a password, a NIN or a
 * link; a code appears only in the body, never in the subject or a URL.
 */

function content(subject: string, email: Omit<HidEmail, 'title'>): MessageContent {
  const full = { ...email, title: subject };
  return { subject, text: hidEmailText(full), html: hidEmailHtml(full) };
}

/** "Your Health ID is ready": sent once, when a sign-up activates (hid-1.0 renderPatientRegistrationEmail). */
export function patientWelcomeContent(input: { firstName?: string; healthId: string }): MessageContent {
  return content('Your Health ID is ready', {
    accent: '#1a6fd4',
    heading: 'Welcome to Health ID',
    ...(input.firstName ? { greetingName: input.firstName } : {}),
    paragraphs: ['Your Health ID account is ready. Keep your Health ID safe and use it whenever you sign in '
      + 'or share access with a hospital.'],
    codeBox: { label: 'Your Health ID', value: input.healthId, letterSpacing: '0.12em' },
    closing: ['You can also sign in with your email address and password, but keep this Health ID available '
      + 'for quick access and hospital verification.'],
  });
}

/** A patient's password reset code, naming them and their Health ID (hid-1.0 renderPasswordResetEmail). */
export function passwordResetCodeContent(input: {
  firstName?: string;
  healthId: string;
  code: string;
  expiresInMinutes: number;
}): MessageContent {
  const minutes = `${input.expiresInMinutes} minute${input.expiresInMinutes === 1 ? '' : 's'}`;
  return content('Your Health ID password reset code', {
    accent: '#1a6fd4',
    heading: 'Health ID Security',
    ...(input.firstName ? { greetingName: input.firstName } : {}),
    paragraphs: [`A password reset was requested for your Health ID account ${input.healthId}. `
      + 'Use the code below to continue.'],
    codeBox: { label: 'Verification Code', value: input.code, letterSpacing: '0.24em' },
    closing: [`This code expires in ${minutes}. If you did not request this reset, ignore this message `
      + 'and consider changing your password after you sign in.'],
  });
}

/**
 * "Your Health ID password was updated", after a completed reset (hid-1.0
 * renderPasswordResetConfirmationEmail). It names the Health ID when Identity
 * sent one, and Health ID support's address.
 */
export function passwordUpdatedContent(input: {
  firstName?: string;
  healthId?: string;
  supportEmail: string;
}): MessageContent {
  return content('Your Health ID password was updated', {
    accent: '#0f766e',
    heading: 'Password Updated',
    ...(input.firstName ? { greetingName: input.firstName } : {}),
    paragraphs: [
      input.healthId
        ? `The password for Health ID account ${input.healthId} was changed successfully.`
        : 'The password for your Health ID account was changed successfully.',
      `If this was not you, contact Health ID support at ${input.supportEmail} immediately `
        + 'and secure your phone and email accounts.',
    ],
  });
}
