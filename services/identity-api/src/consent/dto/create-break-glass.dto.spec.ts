import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateBreakGlassDto } from './create-break-glass.dto';

const errorsFor = async (body: Record<string, unknown>) =>
  validate(plainToInstance(CreateBreakGlassDto, body), { whitelist: true, forbidNonWhitelisted: true });

describe('CreateBreakGlassDto (ID-5: a Health ID or an emergency card\'s matchRef)', () => {
  const base = { reason: 'Unconscious patient brought in', durationMinutes: 60 };
  const matchRef = `psr_${'a1_-'.repeat(10)}abc`;

  it('accepts a Health ID', async () => {
    await expect(errorsFor({ ...base, hid: 'hid-abcdefgh' })).resolves.toHaveLength(0);
  });

  it('accepts a matchRef (psr_ and 43 base64url characters)', async () => {
    expect(matchRef).toHaveLength(47);
    await expect(errorsFor({ ...base, matchRef })).resolves.toHaveLength(0);
  });

  it('refuses neither', async () => {
    const errors = await errorsFor(base);
    expect(errors.map((error) => error.property).sort()).toEqual(['hid', 'matchRef']);
  });

  it('refuses both at once', async () => {
    const errors = await errorsFor({ ...base, hid: 'HID-ABCDEFGH', matchRef });
    expect(errors.map((error) => error.property)).toEqual(['matchRef']);
  });

  it.each([`psr_${'a'.repeat(42)}`, `psr_${'a'.repeat(44)}`, `ref_${'a'.repeat(43)}`, 'HID-ABCDEFGH'])(
    'refuses a malformed matchRef %p', async (value) => {
      const errors = await errorsFor({ ...base, matchRef: value });
      expect(errors.map((error) => error.property)).toEqual(['matchRef']);
    });
});
