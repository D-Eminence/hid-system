import {
  assertSafeNinVerificationResult,
  DeterministicTestNinVerificationProvider,
  UnavailableNinVerificationProvider,
} from './nin-verification.provider';

const request = {
  nin: '12345678901',
  claimedDemographics: {
    firstName: 'Amina',
    lastName: 'Okafor',
    dateOfBirth: '1990-01-02',
  },
  correlationId: 'correlation-nin-test-1',
};

describe('NIN verification providers', () => {
  it('fails closed when no provider is configured', async () => {
    const verification = new UnavailableNinVerificationProvider().verify(request);
    await expect(verification).rejects.toHaveProperty('code', 'NIN_PROVIDER_UNAVAILABLE');
    await expect(verification).rejects.toHaveProperty('status', 503);
  });

  it('keeps the deterministic adapter test-only and returns an opaque reference', async () => {
    const result = await new DeterministicTestNinVerificationProvider().verify(request);
    expect(result.verified).toBe(true);
    expect(result.provider).toBe('deterministic-test');
    expect(result.reference).toMatch(/^test-[0-9a-f]{32}$/);
    expect(result.reference).not.toContain(request.nin);
    expect(() => assertSafeNinVerificationResult(result, 'deterministic-test', request.nin)).not.toThrow();
  });

  it('rejects provider metadata that persists the raw NIN as a reference', () => {
    expect(() => assertSafeNinVerificationResult({
      verified: true,
      provider: 'unsafe-provider',
      reference: `verification-${request.nin}`,
      verifiedAt: new Date().toISOString(),
      demographics: request.claimedDemographics,
    }, 'unsafe-provider', request.nin)).toThrow(expect.objectContaining({
      code: 'NIN_PROVIDER_RESPONSE_INVALID',
      status: 502,
    }));
  });
});
