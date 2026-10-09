import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VerifyCacDto } from './dto/verify-cac.dto';
import { VerifyNinDto } from './dto/verify-nin.dto';

describe('QoreID verification DTOs', () => {
  it('normalizes and accepts only an eleven-digit NIN', async () => {
    const valid = plainToInstance(VerifyNinDto, { nin: '123 456-78901' });
    expect(valid.nin).toBe('12345678901');
    expect(await validate(valid)).toHaveLength(0);
    for (const nin of ['', '1234567890', '123456789012', 'abc12345678']) {
      expect(await validate(plainToInstance(VerifyNinDto, { nin }))).not.toHaveLength(0);
    }
  });

  it.each(['RC1234', 'BN1234', 'IT1234'])('accepts normalized CAC registration number %s', async (regNumber) => {
    const valid = plainToInstance(VerifyCacDto, { regNumber: ` ${regNumber.slice(0, 2).toLowerCase()} 12\t34 ` });
    expect(valid.regNumber).toBe(regNumber);
    expect(await validate(valid)).toHaveLength(0);
  });

  it.each(['1234', 'RC-1234', 'CO1234', 'RCABC', 'RC123', `RC${'1'.repeat(21)}`])('rejects unsupported CAC registration number %s', async (regNumber) => {
    expect(await validate(plainToInstance(VerifyCacDto, { regNumber }))).not.toHaveLength(0);
  });
});
