import { createHmac } from 'node:crypto';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';

export type ContactLookupChannel = 'phone' | 'email';

export function normalizeContactForLookup(channel: ContactLookupChannel, raw: string): string {
  const contact = raw.trim();
  if (channel === 'email') {
    const email = contact.toLowerCase();
    if (email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return email;
  } else {
    const phone = /^0\d{10}$/.test(contact) ? `+234${contact.slice(1)}` : contact.replace(/[\s()-]/g, '');
    if (/^\+[1-9]\d{7,14}$/.test(phone)) return phone;
  }
  throw new DomainProblem(400, 'CONTACT_INVALID', 'Enter a valid account contact');
}

/** A patient's phone as E.164 ("+" and 7-15 digits), as sign-up, sign-in and recovery read it. */
export const PATIENT_PHONE_E164 = /^\+[1-9]\d{6,14}$/;

/**
 * A patient's phone for sign-up, sign-in and recovery (owner decision of
 * 2026-10-28): E.164 of any country, "+" and 7-15 digits, or a Nigerian
 * local number (0 and 10 digits) read as +234. Spaces, dots, dashes and
 * brackets are ignored, and a Nigerian trunk 0 typed after +234 is dropped
 * (+2340803... is +234803...). Undefined for anything else. Other phones
 * (emergency contacts, the NIN route's contact) keep normalizeContactForLookup.
 */
export function normalizePatientPhone(raw: string): string | undefined {
  const compact = raw.trim().replace(/[\s().-]/g, '');
  if (/^0\d{10}$/.test(compact)) return `+234${compact.slice(1)}`;
  const trunk = /^\+2340(\d{10})$/.exec(compact);
  if (trunk) return `+234${trunk[1]}`;
  return PATIENT_PHONE_E164.test(compact) ? compact : undefined;
}

/**
 * The forms a patient's phone (an E.164 number from normalizePatientPhone)
 * may be stored in: the number itself, and for a Nigerian number (+234 and
 * 10 digits) also +2340 and the same 10 digits. hid-1.0 stored a phone as
 * typed (digits and "+"), so a patient who typed "+234 0803..." was migrated
 * as +2340803..., and the importer kept that form; sign-up, sign-in's lockout
 * and the reset cooldown use +234803.... The canonical form comes first.
 */
export function patientPhoneStoredForms(e164: string): string[] {
  return /^\+234\d{10}$/.test(e164) ? [e164, `+2340${e164.slice(4)}`] : [e164];
}

/**
 * The value 0093's auth.find_patient_account('phone', ...) takes for a
 * patient's phone: the contact lookup HMAC of each stored form, comma
 * separated. The function answers the one account across all of them, or
 * nothing.
 */
export function patientPhoneLookupValue(e164: string): string {
  return patientPhoneStoredForms(e164).map((phone) => createContactLookupHmac('phone', phone)).join(',');
}

function isNormalizedContact(channel: ContactLookupChannel, contact: string): boolean {
  if (channel === 'phone') return PATIENT_PHONE_E164.test(contact);
  try {
    return normalizeContactForLookup(channel, contact) === contact;
  } catch {
    return false;
  }
}

export function contactLookupHmacWithKey(
  channel: ContactLookupChannel, normalizedContact: string, key: Buffer,
): string {
  if (key.length !== 32 || !isNormalizedContact(channel, normalizedContact)) {
    throw new DomainProblem(503, 'CONTACT_LOOKUP_UNAVAILABLE', 'Contact lookup is unavailable');
  }
  return createHmac('sha256', key)
    .update(['hid-contact-lookup:v1', channel, normalizedContact].join('\u001f'), 'utf8')
    .digest('hex');
}

export function createContactLookupHmac(channel: ContactLookupChannel, normalizedContact: string): string {
  const encodedKey = getEnvironment().CONTACT_LOOKUP_HMAC_KEY_B64;
  if (!encodedKey) throw new DomainProblem(503, 'CONTACT_LOOKUP_UNAVAILABLE', 'Contact lookup is unavailable');
  return contactLookupHmacWithKey(channel, normalizedContact, Buffer.from(encodedKey, 'base64'));
}
