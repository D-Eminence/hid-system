import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainProblem } from '../common/problem';
import type {
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

@Injectable()
export class UnavailableNinVerificationProvider implements NinVerificationProvider {
  readonly name = 'unavailable';

  async verify(_request: NinVerificationRequest): Promise<NinVerificationResult> {
    throw new DomainProblem(
      503,
      'NIN_PROVIDER_UNAVAILABLE',
      'NIN verification is not configured',
    );
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
