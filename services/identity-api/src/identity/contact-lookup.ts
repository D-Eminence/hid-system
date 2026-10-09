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

export function contactLookupHmacWithKey(
  channel: ContactLookupChannel, normalizedContact: string, key: Buffer,
): string {
  if (key.length !== 32 || normalizeContactForLookup(channel, normalizedContact) !== normalizedContact) {
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
