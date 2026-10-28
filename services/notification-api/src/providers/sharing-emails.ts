import { hidEmailHtml, hidEmailText, type HidEmail } from './email-layout';
import { alertTime, type MessageContent } from './provider.types';

/**
 * The sharing emails (B4, migration 0095), in hid-1.0's layout. Fixed fields
 * only: none carries a patient's name, a Health ID, a record, the invitee's
 * name or any free text, and the records-opened email does not even name the
 * facility (the signed-in inbox does).
 */

export const SHARE_LEVEL_LABELS = {
  view_only: 'View Only',
  clinical_review: 'Clinical Review',
  clinical_collaboration: 'Clinical Collaboration',
} as const;
export type ShareLevel = keyof typeof SHARE_LEVEL_LABELS;
export const SHARE_LEVELS = Object.keys(SHARE_LEVEL_LABELS) as readonly ShareLevel[];

export const SHARE_DURATION_LABELS = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  until_revoked: 'until the patient ends it (up to 1 year)',
} as const;
export type ShareDuration = keyof typeof SHARE_DURATION_LABELS;
export const SHARE_DURATIONS = Object.keys(SHARE_DURATION_LABELS) as readonly ShareDuration[];

function content(subject: string, email: Omit<HidEmail, 'title'>): MessageContent {
  const full = { ...email, title: subject };
  return { subject, text: hidEmailText(full), html: hidEmailHtml(full) };
}

/** E1: a patient invites a provider by email. Names no patient and no invitee. */
export function patientShareInvitationContent(input: {
  reference: string;
  level: ShareLevel;
  duration: ShareDuration;
  expiresAt: Date;
  origin: string;
}): MessageContent {
  return content('A patient wants to share their health records with you on Health ID', {
    accent: '#1a6fd4',
    heading: 'Invitation to Health ID',
    paragraphs: [
      `Someone who uses Health ID wants to share their health records with you (${SHARE_LEVEL_LABELS[input.level]}, `
        + `${SHARE_DURATION_LABELS[input.duration]}).`,
      `To accept, sign in to the Health ID provider portal at ${input.origin}/provider with this email address `
        + 'and open Patients → Invitations.',
      'If you are not on Health ID yet, ask your facility\'s administrator to invite you, or set up your facility at '
        + `${input.origin}/provider/enroll.`,
      `This invitation ends on ${alertTime(input.expiresAt)} (WAT).`,
    ],
    codeBox: { label: 'Reference', value: input.reference, letterSpacing: '0.12em' },
    closing: ['If you were not expecting this, ignore this email.'],
  });
}

/** E2: a patient shared their record with this clinician. No patient name, Health ID or level. */
export function shareReceivedContent(input: { facilityName?: string }): MessageContent {
  return content('A patient shared their Health ID record with you', {
    accent: '#1a6fd4',
    heading: 'Record Shared With You',
    paragraphs: [
      `A patient shared their Health ID record with you${input.facilityName ? ` at ${input.facilityName}` : ''}.`,
      'Sign in to the Health ID provider portal and open Patients → Shared with you to see it.',
    ],
  });
}

/** E3: "Your Health ID records were opened". Names no facility, no patient and no Health ID. */
export function recordAccessAlertContent(input: { occurredAt: Date; supportEmail: string }): MessageContent {
  return content('Your Health ID records were opened', {
    accent: '#0f766e',
    heading: 'Your Records Were Opened',
    paragraphs: [
      `A healthcare facility opened your Health ID records on ${alertTime(input.occurredAt)} (WAT).`,
      'Sign in to Health ID and open Notifications to see which facility.',
      'If you do not recognise this, end that access in Access and consent, or contact '
        + `${input.supportEmail}.`,
    ],
  });
}
