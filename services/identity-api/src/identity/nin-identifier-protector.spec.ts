import { createHash } from 'node:crypto';
import { protectNin, protectPatientSelfNinProfile } from './nin-identifier-protector';

describe('protectNin', () => {
  const config = {
    lookupKey: Buffer.alloc(32, 1),
    encryptionKey: Buffer.alloc(32, 2),
    keyVersion: 'test-v1',
  };

  it('uses a keyed lookup digest and authenticated encrypted storage', () => {
    const first = protectNin('12345678901', 'f3e6c2a8-5fbf-4f14-a036-8dc6ef9ac2a0', config);
    const second = protectNin('12345678901', 'f3e6c2a8-5fbf-4f14-a036-8dc6ef9ac2a0', config);

    expect(first.lookupHmac).toHaveLength(64);
    expect(first.lookupHmac).toBe(second.lookupHmac);
    expect(first.last4).toBe('8901');
    expect(first.keyVersion).toBe('test-v1');
    expect(first.ciphertext).not.toEqual(second.ciphertext);
    expect(first.ciphertext.includes(Buffer.from('12345678901', 'utf8'))).toBe(false);
    expect(first.lookupHmac).not.toBe(
      createHash('sha256').update('12345678901', 'utf8').digest('hex'),
    );
  });

  it('encrypts authoritative demographics with evidence-specific associated data', () => {
    const profile = { firstName: 'Amina', lastName: 'Okafor', dateOfBirth: '1990-01-02' };
    const first = protectPatientSelfNinProfile(profile,
      'f3e6c2a8-5fbf-4f14-a036-8dc6ef9ac2a0', config);
    const second = protectPatientSelfNinProfile(profile,
      'f3e6c2a8-5fbf-4f14-a036-8dc6ef9ac2a0', config);
    expect(first.ciphertext).not.toEqual(second.ciphertext);
    expect(first.ciphertext.includes(Buffer.from('Amina'))).toBe(false);
    expect(first.sha256).toBe(createHash('sha256').update(first.ciphertext).digest('hex'));
    expect(first.keyVersion).toBe('test-v1');
  });
});
