import {
  assertOcrJobTransition,
  assertOcrSourceEligible,
  canTransitionOcrJob,
} from './ocr-lifecycle';

describe('OCR job lifecycle', () => {
  it('requires extraction to pass through explicit human validation', () => {
    expect(canTransitionOcrJob('extracted', 'awaiting_validation')).toBe(true);
    expect(canTransitionOcrJob('awaiting_validation', 'validated')).toBe(true);
    expect(canTransitionOcrJob('awaiting_validation', 'rejected')).toBe(true);
  });

  it('does not let provisional extraction publish or become clinical truth', () => {
    expect(canTransitionOcrJob('processing', 'validated')).toBe(false);
    expect(canTransitionOcrJob('extracted', 'validated')).toBe(false);
  });

  it('keeps terminal states terminal and rejects invalid transitions', () => {
    expect(canTransitionOcrJob('validated', 'processing')).toBe(false);
    expect(canTransitionOcrJob('rejected', 'validated')).toBe(false);
    expect(canTransitionOcrJob('cancelled', 'queued')).toBe(false);
    expect(() => assertOcrJobTransition('queued', 'validated')).toThrow(
      'Invalid OCR job transition: queued -> validated',
    );
  });

  it('allows bounded retry only from failure back to the queue', () => {
    expect(canTransitionOcrJob('failed', 'queued')).toBe(true);
    expect(canTransitionOcrJob('failed', 'processing')).toBe(false);
  });

  it('requires clean scanner evidence bound to the immutable source object', () => {
    expect(() => assertOcrSourceEligible({
      documentStatus: 'available',
      scanStatus: 'clean',
      objectVersionId: 's3-version-1',
      objectSha256Hex: 'a'.repeat(64),
    })).not.toThrow();

    expect(() => assertOcrSourceEligible({
      documentStatus: 'uploaded',
      scanStatus: 'pending',
      objectVersionId: 's3-version-1',
      objectSha256Hex: 'a'.repeat(64),
    })).toThrow('OCR requires an available, clean, immutable object binding');
  });
});

