import { createHash } from 'node:crypto';
import { DomainProblem } from './problem';

const VALID_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

export function requireIdempotencyKey(value: string | undefined): string {
  if (!value || !VALID_KEY.test(value)) {
    throw new DomainProblem(400, 'IDEMPOTENCY_KEY_REQUIRED',
      'Idempotency-Key must contain 16 to 128 URL-safe characters');
  }
  return value;
}

export function requestDigest(operation: string, payload: unknown): string {
  return createHash('sha256').update(`${operation}\n${stableJson(payload)}`, 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}
