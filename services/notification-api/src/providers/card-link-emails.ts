import { hidEmailHtml, hidEmailText, type HidEmail } from './email-layout';
import { alertTime, type MessageContent } from './provider.types';

/**
 * The card-link emails (0118, Akos handover step 8). None names the patient
 * or carries a Health ID or any health information (D1). E5 (the link, to
 * the address the patient typed) never carries a code, and E6 (the code, to
 * the same address) never carries the card link: whoever reads one email
 * alone cannot open the card. Both are plain text, so no provider's click
 * tracking can rewrite the link and keep the token. Each gives the
 * self-serve "Stop these emails" link and the recipient's privacy notice.
 * E7 and E8 go to the patient's verified address, as security notices.
 */

/**
 * Where a card link opens: this deployment's patient site, fixed by
 * HID_DEPLOYMENT_ENV and never taken from a request (the staging patient
 * portal is the website's config/staging.json `hosts.web`).
 */
export function patientSiteOrigin(deployment: 'development' | 'staging' | 'production'): string {
  if (deployment === 'development') return 'http://localhost:5173';
  return deployment === 'staging' ? 'https://staging.healthidentitydirectory.com' : 'https://app.healthidentitydirectory.com';
}

function stopAndPrivacy(origin: string, stopToken: string): string {
  return `To stop getting these emails, go to:\n${origin}/card/stop#${stopToken}\n\n`
    + `How we use your email address: ${origin}/card/privacy`;
}

/** E5: a card was shared with this address. The link only. */
export function cardLinkContent(input: { token: string; reference: string; expiresAt: Date; stopToken: string;
  origin: string }): MessageContent {
  return {
    subject: 'A Health ID card has been shared with you',
    text: 'Hello,\n\n'
      + 'Someone has shared their Health ID card with you. You can look at it, but you can\'t change anything.\n\n'
      + `To open it, go to:\n${input.origin}/card#${input.token}\n\n`
      + 'When you open it, we\'ll email a 6-digit code to this address. You\'ll need it to see the card. '
      + 'Anyone who opens this link can ask for a code, but the code only ever comes to this inbox.\n\n'
      + `Reference: ${input.reference}. The person who shared it can see this reference, so you can check with them that `
      + 'it\'s really from them.\n\n'
      + `The link works until ${alertTime(input.expiresAt)} (Lagos time), or until they end it. `
      + 'Please don\'t forward this email.\n\n'
      + `If you weren't expecting this, you can ignore it. ${stopAndPrivacy(input.origin, input.stopToken)}`,
  };
}

/** E6: the one-time code. The code only, never the card link. */
export function cardCodeContent(input: { code: string; reference: string; stopToken: string; origin: string }): MessageContent {
  const host = new URL(input.origin).host;
  return {
    subject: 'Your Health ID code',
    text: 'Hello,\n\n'
      + `Someone asked to open the Health ID card shared with you (reference ${input.reference}).\n\n`
      + `Your code is ${input.code}. It works once, for 10 minutes.\n\n`
      + `Only type this code on ${host}. If someone asks you for it, don't give it to them, `
      + 'even if they say they\'re from Health ID or are a doctor.\n\n'
      + 'If you didn\'t ask for this code, someone else may have the link. Tell the person who shared it. '
      + stopAndPrivacy(input.origin, input.stopToken),
  };
}

function patientContent(subject: string, email: Omit<HidEmail, 'title'>): MessageContent {
  const full = { ...email, title: subject };
  return { subject, text: hidEmailText(full), html: hidEmailHtml(full) };
}

/** E7: the first open of a link each Lagos day, to the patient. The reference and the time only. */
export function cardOpenedContent(input: { reference: string; openedAt: Date }): MessageContent {
  return patientContent('Your Health ID card was opened', {
    accent: '#0f766e',
    heading: 'Your Card Was Opened',
    paragraphs: [
      `Someone opened your Health ID card (reference ${input.reference}) using the link you sent, on `
        + `${alertTime(input.openedAt)} (Lagos time).`,
      'We email you about the first open of each link each day. Your notifications in Health ID show every open.',
      'If you didn\'t expect this, sign in to Health ID and end the link in Access and sharing.',
    ],
  });
}

/** E8: a new link was sent, to the patient (a hijacked session or pressure is noticed). No health data. */
export function cardCreatedContent(input: { reference: string; recipientHint: string; expiresAt: Date }): MessageContent {
  return patientContent('You sent your Health ID card', {
    accent: '#1a6fd4',
    heading: 'You Sent Your Card',
    paragraphs: [
      `You sent your Health ID card to ${input.recipientHint} (reference ${input.reference}). `
        + `The link works until ${alertTime(input.expiresAt)} (Lagos time), or until you end it.`,
      'If this wasn\'t you, sign in to Health ID, end the link in Access and sharing, and change your password.',
    ],
  });
}
