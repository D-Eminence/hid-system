/**
 * Identifier patterns that never leave the system in record text and never
 * appear in an answer (data minimisation for patient record chat). Pattern
 * redaction is a backstop: the extract already leaves out every identifying
 * field (names, Health ID, NIN, date of birth, contact details, staff and
 * facility names, internal ids), but free text such as a clinical note may
 * still mention one.
 */
const HID_CODE = /\bHID-[A-Z0-9]{4,32}\b/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL_LIKE = /\b(?:https?:\/\/|www\.)\S+/gi;
// A run of digits with common separators. It is an identifier (a NIN has 11
// digits, a Nigerian phone number 11 or 13) when it holds ten digits or more;
// dates, measurements and doses have fewer.
const DIGIT_RUN = /\+?\d[\d\s().-]{6,}\d/g;
const LONG_DIGIT_RUN_DIGITS = 10;

export const REDACTED = '[redacted]';

function digitCount(value: string): number {
  return value.replace(/\D/g, '').length;
}

/** The text with every identifier pattern replaced by [redacted]. */
export function redactIdentifiers(text: string): string {
  return text
    .replace(URL_LIKE, REDACTED)
    .replace(EMAIL, REDACTED)
    .replace(HID_CODE, REDACTED)
    .replace(UUID, REDACTED)
    .replace(DIGIT_RUN, (match) => (digitCount(match) >= LONG_DIGIT_RUN_DIGITS ? REDACTED : match));
}

/** Whether the text holds an identifier pattern, a URL or an e-mail address. */
export function containsIdentifier(text: string): boolean {
  for (const pattern of [URL_LIKE, EMAIL, HID_CODE, UUID]) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      pattern.lastIndex = 0;
      return true;
    }
  }
  return [...text.matchAll(DIGIT_RUN)].some(([match]) => digitCount(match) >= LONG_DIGIT_RUN_DIGITS);
}
