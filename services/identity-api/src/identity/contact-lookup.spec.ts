import { contactLookupHmacWithKey, normalizeContactForLookup } from './contact-lookup';

describe('canonical contact lookup', () => {
  const key = Buffer.alloc(32, 4);

  it.each([
    ['phone' as const, '08012345678', '+2348012345678',
      'f581b89538c9b7b250b3678c2671a37f0211abfa1a8b813ba963ae17adfc5248'],
    ['email' as const, ' Patient@Example.Test ', 'patient@example.test',
      'e15c0546f956495899f58ae92277b215dc3cb4183f8ce379b04f70f18c5047a8'],
  ])('matches the migration vector for %s', (channel, input, normalized, expected) => {
    expect(normalizeContactForLookup(channel, input)).toBe(normalized);
    expect(contactLookupHmacWithKey(channel, normalized, key)).toBe(expected);
  });
});
