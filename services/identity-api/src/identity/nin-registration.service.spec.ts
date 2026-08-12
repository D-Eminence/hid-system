import { ninResolutionRequestDigest, scoreRegistrationCandidate, similarity } from './nin-registration.service';

describe('NIN duplicate candidate matching', () => {
  it('gives an exact demographic match the maximum score', () => {
    expect(scoreRegistrationCandidate({
      id: 'patient-1',
      first_name: 'Amina',
      last_name: 'Okafor',
      full_name: 'Amina Okafor',
      dob: '1990-01-02',
    }, {
      firstName: 'Amina',
      lastName: 'Okafor',
      dateOfBirth: '1990-01-02',
    })).toEqual({
      patientId: 'patient-1',
      score: 100,
      reasons: ['date_of_birth', 'first_name', 'last_name'],
    });
  });

  it('uses bounded fuzzy name similarity without treating it as identity proof', () => {
    expect(similarity('mohammed', 'muhammad')).toBeGreaterThan(0.4);
    expect(scoreRegistrationCandidate({
      id: 'patient-2',
      first_name: 'Muhammad',
      last_name: 'Okafor',
      full_name: 'Muhammad Okafor',
      dob: '1990-01-02',
    }, {
      firstName: 'Mohammed',
      lastName: 'Okafor',
      dateOfBirth: '1990-01-02',
    }).score).toBeLessThan(100);
  });

  it('binds idempotency to the keyed NIN lookup without hashing raw NIN into the stored digest', () => {
    const request = {
      nin: '12345678901',
      firstName: 'Amina',
      lastName: 'Okafor',
      dateOfBirth: '1990-01-02',
      purpose: 'healthcare-operations' as const,
    };
    const lookupHmac = 'a'.repeat(64);

    expect(ninResolutionRequestDigest(request, lookupHmac)).toBe(
      ninResolutionRequestDigest({ ...request, nin: '10987654321' }, lookupHmac),
    );
    expect(ninResolutionRequestDigest(request, lookupHmac)).not.toBe(
      ninResolutionRequestDigest(request, 'b'.repeat(64)),
    );
  });
});
