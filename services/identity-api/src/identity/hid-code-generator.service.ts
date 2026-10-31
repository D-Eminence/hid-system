import { randomBytes } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';

const HID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const HAS_LETTER = /[A-Z]/;
const HAS_DIGIT = /[0-9]/;
/** A draw has both a letter and a digit about 82% of the time, so 64 draws all failing never happens in practice. */
const MAX_DRAWS = 64;

export type HidReservation<Result> = (candidate: string) => Promise<
  | { reserved: true; result: Result }
  | { reserved: false }
>;

/**
 * Identity-owned HID generation. EHR never invokes this service to create a
 * patient; the future Identity registration command supplies the atomic
 * PostgreSQL reservation callback.
 */
@Injectable()
export class HidCodeGenerator {
  /**
   * HID- and six characters, as hid-1.0 issued them (owner decision, 2026-10-27), always mixing at least one letter
   * and at least one digit (owner decision, 2026-10-31: no Health ID of letters only or digits only). Each character
   * comes from 32 values, so byte & 31 is unbiased; a draw of letters only or digits only is discarded, which keeps
   * every allowed code equally likely.
   */
  generate(): string {
    for (let draw = 0; draw < MAX_DRAWS; draw += 1) {
      let code = '';
      for (const byte of this.entropy(6)) code += HID_ALPHABET[byte & 31];
      if (HAS_LETTER.test(code) && HAS_DIGIT.test(code)) return `HID-${code}`;
    }
    throw new ServiceUnavailableException('A HID could not be generated');
  }

  async reserve<Result>(reservation: HidReservation<Result>, maxAttempts = 8): Promise<Result> {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 32) {
      throw new RangeError('HID reservation attempts must be between 1 and 32');
    }
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const outcome = await reservation(this.generate());
      if (outcome.reserved) return outcome.result;
    }
    throw new ServiceUnavailableException('A unique HID could not be reserved');
  }

  /** The random bytes behind one draw; a test may replace them. */
  protected entropy(size: number): Uint8Array {
    return randomBytes(size);
  }
}
