import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainProblem } from '../common/problem';
import type {
  NinClaimedDemographics,
  NinVerificationProvider,
  NinVerificationRequest,
  NinVerificationResult,
} from './nin.types';

const PROVIDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function assertSafeNinVerificationResult(
  result: NinVerificationResult,
  expectedProvider: string,
  rawNin: string,
): void {
  // Provider payloads are untrusted runtime data even when an adapter is typed.
  const invalid = () => new DomainProblem(502, 'NIN_PROVIDER_RESPONSE_INVALID', 'The NIN provider returned an invalid response');
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || typeof result.verified !== 'boolean'
    || typeof result.provider !== 'string' || result.provider !== expectedProvider
    || !PROVIDER_NAME.test(result.provider)
    || typeof result.reference !== 'string' || result.reference.trim().length < 1
    || result.reference.length > 255 || /[\x00-\x1f\x7f]/.test(result.reference)
    || result.reference.replace(/[\s-]/g, '').includes(rawNin)
    || typeof result.verifiedAt !== 'string') throw invalid();
  const verifiedAt = Date.parse(result.verifiedAt);
  if (!Number.isFinite(verifiedAt) || verifiedAt > Date.now() + 5 * 60 * 1000) throw invalid();
  const demographics = result.demographics;
  if (!demographics || typeof demographics !== 'object' || Array.isArray(demographics)) throw invalid();
  const validName = (value: unknown) => typeof value === 'string' && value.trim().length >= 1
    && value.trim().length <= 100 && !/[\x00-\x1f\x7f]/.test(value);
  const birthDate = typeof demographics.dateOfBirth === 'string' && ISO_DATE.test(demographics.dateOfBirth)
    ? new Date(`${demographics.dateOfBirth}T00:00:00Z`) : new Date(NaN);
  if (!validName(demographics.firstName) || !validName(demographics.lastName)
    || !Number.isFinite(birthDate.getTime())
    || birthDate.toISOString().slice(0, 10) !== demographics.dateOfBirth
    || birthDate.getTime() > Date.now()
    || (demographics.gender !== undefined
      && !['female', 'male', 'intersex', 'other', 'unknown'].includes(demographics.gender))) throw invalid();
}

/** What the desk sees when NIN checks are switched off (NIN_PROVIDER_MODE=unavailable). */
export const NIN_NOT_CONFIGURED_DETAIL = 'NIN verification is not configured';

/** The refusal for NIN checks switched off: a setting, not an outage. */
export function ninNotConfigured(): DomainProblem {
  return new DomainProblem(503, 'NIN_PROVIDER_UNAVAILABLE', NIN_NOT_CONFIGURED_DETAIL);
}

/**
 * Q108: true for the "switched off" refusal, which must not trip the NIN
 * service breaker or be logged as a failure.
 */
export function isNinNotConfigured(error: unknown): boolean {
  return error instanceof DomainProblem && error.code === 'NIN_PROVIDER_UNAVAILABLE'
    && error.message === NIN_NOT_CONFIGURED_DETAIL;
}

/** What the desk sees when the NIN check's switch cannot be read: nothing was sent. */
export const NIN_CHECK_NOT_STARTED_DETAIL = 'NIN checks cannot be started right now. Please try again in a minute.';

/**
 * Q108: the refusal for a check that could not be started because its switch
 * could not be read (for example, a database hiccup). Nothing was sent: not
 * an outage of the NIN service, so it must not trip the breaker.
 */
export function ninCheckNotStarted(): DomainProblem {
  return new DomainProblem(503, 'NIN_PROVIDER_UNAVAILABLE', NIN_CHECK_NOT_STARTED_DETAIL);
}

export function isNinCheckNotStarted(error: unknown): boolean {
  return error instanceof DomainProblem && error.code === 'NIN_PROVIDER_UNAVAILABLE'
    && error.message === NIN_CHECK_NOT_STARTED_DETAIL;
}

/**
 * 0137 (Q109): the once-per-NIN guard's refusals that send nothing for this
 * request: the same NIN is being checked (409 NIN_CHECK_IN_PROGRESS), it is
 * held after a check QoreID may have charged (409 NIN_CHECK_HELD), or the
 * NIN keys the guard needs are missing (503 NIN_PROTECTION_UNAVAILABLE).
 */
const NIN_CHECK_REFUSED_UNSENT_CODES = new Set(['NIN_CHECK_IN_PROGRESS', 'NIN_CHECK_HELD',
  'NIN_PROTECTION_UNAVAILABLE']);

/**
 * True when the NIN check was refused before anything was sent for this
 * request (0137's guard). Not an outage of the NIN service: it must not trip
 * the breaker, and the audit row says the NIN was not sent.
 */
export function isNinCheckRefusedUnsent(error: unknown): boolean {
  return error instanceof DomainProblem && NIN_CHECK_REFUSED_UNSENT_CODES.has(error.code);
}

/**
 * Q108: the details the desk typed cannot be anyone's: a date of birth that
 * is not a real date, is in the future or is before 1900, or a name that is
 * blank, longer than 100 characters or holds a control character (such as a
 * tab). The same rules `assertSafeNinVerificationResult` applies, so details
 * that pass here are never refused there as a bad provider answer.
 */
export function implausibleClaimedDemographics(demographics: NinClaimedDemographics): boolean {
  return !plausibleName(demographics.firstName) || !plausibleName(demographics.lastName)
    || !plausibleBirthDate(demographics.dateOfBirth);
}

export function plausibleName(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 100
    && !/[\x00-\x1f\x7f]/.test(value);
}

export function plausibleBirthDate(value: unknown, now = Date.now()): boolean {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    && date.getUTCFullYear() >= 1900 && date.getTime() <= now;
}

@Injectable()
export class UnavailableNinVerificationProvider implements NinVerificationProvider {
  readonly name = 'unavailable';

  async verify(_request: NinVerificationRequest): Promise<NinVerificationResult> {
    throw ninNotConfigured();
  }
}

@Injectable()
export class DeferredNinVerificationProvider implements NinVerificationProvider {
  readonly name = 'deferred';

  async verify(_request: NinVerificationRequest): Promise<NinVerificationResult> {
    throw new DomainProblem(503, 'NIN_PROVIDER_DEFERRED', 'NIN verification is deferred for this staging environment');
  }
}

@Injectable()
export class DeterministicTestNinVerificationProvider implements NinVerificationProvider {
  readonly name = 'deterministic-test';

  async verify(request: NinVerificationRequest): Promise<NinVerificationResult> {
    const reference = createHash('sha256')
      .update(`hid-nin-test:${request.nin}`, 'utf8')
      .digest('hex')
      .slice(0, 32);
    return {
      verified: true,
      provider: this.name,
      reference: `test-${reference}`,
      verifiedAt: new Date().toISOString(),
      demographics: request.claimedDemographics,
    };
  }
}
