import { randomBytes } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';

const HID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

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
  generate(): string {
    const entropy = randomBytes(16);
    let value = 'HID-';
    for (const byte of entropy) value += HID_ALPHABET[byte & 31];
    return value;
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
}
