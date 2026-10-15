import { DomainProblem } from './problem';

/**
 * The expected version an If-Match header names: a positive integer, quoted
 * or not, optionally weak (W/"3"). Anything else is 428 IF_MATCH_REQUIRED.
 */
export function expectedVersion(value: string | undefined): number {
  const normalized = value?.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  const version = normalized ? Number(normalized) : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new DomainProblem(428, 'IF_MATCH_REQUIRED', 'If-Match must contain the expected positive version');
  }
  return version;
}
