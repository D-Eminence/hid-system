/**
 * Names that P4b lets into what Health ID shows or sends (SPEC 4.6, 6.1;
 * security critique S3). A person's name never goes into an email. The
 * invitee's name is shown to the invitee and stored; the inviter's display
 * name is shown on the invitation page only when it reads as a person's name;
 * the facility's name goes into the email only when nothing in it can become
 * a link.
 */

/**
 * A person's name: 2 to 6 words of letters and combining marks, joined by a
 * single space, apostrophe or hyphen. No digits, dots, '@', ':' or '/', so it
 * cannot carry an address, a domain or a link.
 */
export const STAFF_PERSON_NAME = /^[\p{L}\p{M}]+(?:[ '\-][\p{L}\p{M}]+){1,5}$/u;

/** Words that could make a name read as Health ID itself or its staff (whole words, any case). */
const RESERVED_WORDS = new Set(['healthid', 'hid', 'support', 'admin', 'administrator', 'ministry']);

/** True when the name names Health ID, support, an administrator or a ministry as a whole word. */
export function hasReservedWord(name: string): boolean {
  const words = name.toLowerCase().split(/[ '\-]+/u).filter(Boolean);
  return words.some((word, index) => RESERVED_WORDS.has(word) || (word === 'health' && words[index + 1] === 'id'));
}

/** A person's name an invitation may carry: the pattern, 2-80 characters and no reserved word. */
export function acceptableStaffPersonName(name: string): boolean {
  return name.length >= 2 && name.length <= 80 && STAFF_PERSON_NAME.test(name) && !hasReservedWord(name);
}

/** Text a mail client could turn into a link: a letter or digit, a dot and two letters ("hid-payroll.com"). */
export const DOMAIN_LIKE = /[\p{L}\p{N}]\.[\p{L}]{2}/u;

/**
 * notification-api's DeliverStaffInvitationDto facilityName pattern (SPEC 7),
 * kept identical so Identity never sends a name that route refuses (R5a).
 */
export const EMAIL_FACILITY_NAME = /^(?!.*:\/\/)(?!.*[\p{L}\p{N}]\.[\p{L}]{2})[^\p{Cc}\p{Cf}<>]{1,200}$/u;

/** The facility name the invitation email may show, or undefined ("a facility"). */
export function emailFacilityName(name: string | null | undefined): string | undefined {
  if (typeof name !== 'string') return undefined;
  return EMAIL_FACILITY_NAME.test(name) && !DOMAIN_LIKE.test(name) ? name : undefined;
}

/** The inviter's display name as the invitation page may show it, or null ("The facility administrator"). */
export function shownInviterName(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  return acceptableStaffPersonName(trimmed) ? trimmed : null;
}
