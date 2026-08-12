import { HidCodeGenerator } from './hid-code-generator.service';

describe('HidCodeGenerator', () => {
  const generator = new HidCodeGenerator();

  it('generates a production HID without ambiguous characters', () => {
    expect(generator.generate()).toMatch(/^HID-[A-HJ-NP-Z2-9]{16}$/);
  });

  it('retries a collision and returns only a reserved code', async () => {
    let attempts = 0;
    const result = await generator.reserve(async (candidate) => {
      attempts += 1;
      return attempts === 1
        ? { reserved: false as const }
        : { reserved: true as const, result: candidate };
    });
    expect(attempts).toBe(2);
    expect(result).toMatch(/^HID-/);
  });

  it('fails after a bounded number of collisions', async () => {
    await expect(generator.reserve(async () => ({ reserved: false as const }), 2))
      .rejects.toThrow('A unique HID could not be reserved');
  });
});
