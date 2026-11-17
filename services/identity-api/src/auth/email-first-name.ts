/**
 * A first name as a patient email may greet with it (the welcome, the
 * password reset code and the password-updated emails), or undefined, and the
 * email then says "Hello there". It is cut to notification-api's PERSON_NAME:
 * letters, marks, apostrophes, spaces, dots and hyphens, starting with a
 * letter, at most 120 characters; anything else is replaced by a space, so a
 * legitimate name never makes notification-api refuse the email.
 */
export function emailFirstName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.normalize('NFC').replace(/[‘’ʼ]/gu, "'")
    .replace(/[^\p{L}\p{M}' .-]/gu, ' ').replace(/ +/gu, ' ').replace(/^[^\p{L}\p{M}]+/u, '');
  const name = Array.from(text).slice(0, 120).join('').trim();
  return /^[\p{L}\p{M}][\p{L}\p{M}' .-]{0,119}$/u.test(name) ? name : undefined;
}

/** Titles a staff display name may start with, compared without case or a trailing dot. */
const STAFF_TITLES: ReadonlySet<string> = new Set(['dr', 'prof', 'professor', 'mr', 'mrs', 'ms', 'miss', 'nurse']);

/**
 * The first name a staff email greets with (owner decision of 17 November
 * 2026, Q89): the first word of the account's display name after any leading
 * titles (Dr, Dr., Prof, Mr, Mrs, Ms, Miss, Nurse), cut as emailFirstName
 * cuts a patient's; undefined (the email then says "Hello there,") when
 * nothing is left.
 */
export function staffEmailFirstName(displayName: unknown): string | undefined {
  if (typeof displayName !== 'string') return undefined;
  const words = displayName.normalize('NFC').trim().split(/\s+/u).filter(Boolean);
  const first = words.find((word) => !STAFF_TITLES.has(word.toLowerCase().replace(/\.+$/u, '')));
  return first ? emailFirstName(first) : undefined;
}
