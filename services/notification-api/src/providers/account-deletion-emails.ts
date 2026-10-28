import { hidEmailHtml, hidEmailText, type HidEmail } from './email-layout';
import { alertTime, type MessageContent } from './provider.types';

/**
 * The account-deletion emails (B5, migration 0096), in hid-1.0's layout:
 * scheduled (with the date, WAT), cancelled and completed. Fixed text only:
 * none carries a name, a Health ID or anything from a record.
 */

export const ACCOUNT_DELETION_NOTICE_KINDS = ['scheduled', 'cancelled', 'completed'] as const;
export type AccountDeletionNoticeKind = typeof ACCOUNT_DELETION_NOTICE_KINDS[number];

function content(subject: string, email: Omit<HidEmail, 'title'>): MessageContent {
  const full = { ...email, title: subject };
  return { subject, text: hidEmailText(full), html: hidEmailHtml(full) };
}

/** E4: the patient's account deletion was scheduled, cancelled or completed. */
export function accountDeletionContent(input: { kind: AccountDeletionNoticeKind; scheduledFor?: Date;
  supportEmail: string }): MessageContent {
  if (input.kind === 'scheduled') {
    if (!input.scheduledFor) throw new Error('A scheduled deletion email needs its date');
    return content('Your Health ID account is scheduled for deletion', {
      accent: '#b91c1c',
      heading: 'Account Deletion Scheduled',
      paragraphs: [
        `You asked to delete your Health ID account. It will be deleted on ${alertTime(input.scheduledFor)} (WAT).`,
        'Until then you can sign in and cancel it in Settings.',
        'If this was not you, sign in, cancel the deletion and change your password, or contact '
          + `${input.supportEmail}.`,
      ],
    });
  }
  if (input.kind === 'cancelled') {
    return content('Your Health ID account deletion was cancelled', {
      accent: '#0f766e',
      heading: 'Account Deletion Cancelled',
      paragraphs: ['Your Health ID account will not be deleted. It stays open.'],
    });
  }
  return content('Your Health ID account was deleted', {
    accent: '#1a6fd4',
    heading: 'Account Deleted',
    paragraphs: [
      'Your Health ID account was deleted and you can no longer sign in.',
      'Your Health ID and the medical records facilities hold about you were kept, as required for your care and the law.',
    ],
  });
}
