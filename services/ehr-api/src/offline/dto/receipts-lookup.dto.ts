import { DomainProblem } from '../../common/problem';

/** The Idempotency-Key format every keyed EHR route accepts (common/idempotency.ts). */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
export const MAX_RECEIPT_KEYS = 50;

/** C1 request body: `{ "keys": ["off1.…"] }`, 1 to 50 keys. */
export interface ReceiptsLookupDto {
  keys: string[];
}

/**
 * Validated here rather than by the global ValidationPipe so a bad body answers
 * the contract's 400 INVALID_KEYS. Repeated keys are looked up once.
 */
export function parseReceiptsLookup(body: unknown): ReceiptsLookupDto {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalidKeys();
  const fields = Object.keys(body);
  const keys = (body as { keys?: unknown }).keys;
  if (fields.length !== 1 || fields[0] !== 'keys' || !Array.isArray(keys)
    || keys.length < 1 || keys.length > MAX_RECEIPT_KEYS
    || keys.some((key) => typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key))) {
    throw invalidKeys();
  }
  return { keys: [...new Set(keys as string[])] };
}

function invalidKeys(): DomainProblem {
  return new DomainProblem(400, 'INVALID_KEYS',
    `keys must be 1 to ${MAX_RECEIPT_KEYS} Idempotency-Key values of 16 to 128 URL-safe characters`);
}
