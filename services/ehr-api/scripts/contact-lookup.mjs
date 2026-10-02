import { createHmac } from 'node:crypto';

export function normalizeContactForLookup(channel, raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const contact = raw.trim();
  if (channel === 'email') {
    const email = contact.toLowerCase();
    if (email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return email;
  } else if (channel === 'phone') {
    const phone = /^0\d{10}$/.test(contact) ? `+234${contact.slice(1)}` : contact.replace(/[\s()-]/g, '');
    if (/^\+[1-9]\d{7,14}$/.test(phone)) return phone;
  }
  throw new Error('Invalid source contact');
}

export function contactLookupHmac(channel, normalizedContact, key) {
  if (!['phone', 'email'].includes(channel) || !Buffer.isBuffer(key) || key.length !== 32
      || normalizeContactForLookup(channel, normalizedContact) !== normalizedContact) {
    throw new Error('Invalid contact lookup input');
  }
  return createHmac('sha256', key)
    .update(['hid-contact-lookup:v1', channel, normalizedContact].join('\u001f'), 'utf8')
    .digest('hex');
}
