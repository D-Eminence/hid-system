import { HidCodeGenerator } from './hid-code-generator.service';

/** Draws from a fixed list of byte arrays, one per draw, so a test chooses what each draw would produce. */
class ScriptedGenerator extends HidCodeGenerator {
  draws = 0;
  constructor(private readonly script: number[][]) { super(); }
  protected override entropy(): Uint8Array {
    const bytes = this.script[Math.min(this.draws, this.script.length - 1)] ?? [];
    this.draws += 1;
    return Uint8Array.from(bytes);
  }
}
// Positions in ABCDEFGHJKLMNPQRSTUVWXYZ23456789: 0 is A, 24 is 2.
const LETTERS = [0, 1, 2, 3, 4, 5];
const DIGITS = [24, 25, 26, 27, 28, 29];
const MIXED = [0, 1, 2, 24, 25, 26];
// Z is 23, Q 14, D 3, E 4, M 11, B 1.
const ZQA = [23, 14, 0, 24, 25, 26];
const ZDEM = [23, 3, 4, 11, 24, 25];
const ZQB = [23, 14, 1, 24, 25, 26];
const ZDEN = [23, 3, 4, 12, 24, 25];

describe('HidCodeGenerator', () => {
  const generator = new HidCodeGenerator();

  it('generates a production HID of six characters without ambiguous ones, always mixing letters and digits', () => {
    for (let index = 0; index < 5000; index += 1) {
      const code = generator.generate();
      expect(code).toMatch(/^HID-[A-HJ-NP-Z2-9]{6}$/);
      expect(code.slice(4)).toMatch(/[A-Z]/);
      expect(code.slice(4)).toMatch(/[0-9]/);
    }
  });

  it('discards a draw of letters only or digits only and keeps the next mixed one', () => {
    const scripted = new ScriptedGenerator([LETTERS, DIGITS, MIXED]);
    expect(scripted.generate()).toBe('HID-ABC234');
    expect(scripted.draws).toBe(3);
  });

  it('keeps a mixed draw as it is', () => {
    const scripted = new ScriptedGenerator([MIXED]);
    expect(scripted.generate()).toBe('HID-ABC234');
    expect(scripted.draws).toBe(1);
  });

  it('refuses rather than issue a code of one kind when every draw is', () => {
    const scripted = new ScriptedGenerator([LETTERS]);
    expect(() => scripted.generate()).toThrow('A HID could not be generated');
    expect(scripted.draws).toBe(64);
  });

  it('discards a draw starting with a sealed tenant\'s prefix (ZQA for QA, ZDEM for demo) and keeps the next one', () => {
    const scripted = new ScriptedGenerator([ZQA, ZDEM, MIXED]);
    expect(scripted.generate()).toBe('HID-ABC234');
    expect(scripted.draws).toBe(3);
  });

  it('keeps a draw that only resembles a reserved prefix', () => {
    expect(new ScriptedGenerator([ZQB]).generate()).toBe('HID-ZQB234');
    expect(new ScriptedGenerator([ZDEN]).generate()).toBe('HID-ZDEN23');
  });

  it('never issues a code starting with ZQA or ZDEM in normal draws', () => {
    for (let index = 0; index < 20000; index += 1) {
      const code = generator.generate();
      expect(code.startsWith('HID-ZQA')).toBe(false);
      expect(code.startsWith('HID-ZDEM')).toBe(false);
    }
  });

  it('spreads letters and digits over every position', () => {
    const seen = Array.from({ length: 6 }, () => new Set<string>());
    for (let index = 0; index < 5000; index += 1) {
      [...generator.generate().slice(4)].forEach((character, position) => seen[position]?.add(character));
    }
    for (const position of seen) expect(position.size).toBe(32);
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
