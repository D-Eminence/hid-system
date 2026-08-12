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
  const verifiedAt = Date.parse(result.verifiedAt);
  const demographics = result.demographics;
  const validGender = demographics.gender === undefined
    || ['female', 'male', 'intersex', 'other', 'unknown'].includes(demographics.gender);
  if (
    result.provider !== expectedProvider
    || !PROVIDER_NAME.test(result.provider)
    || !result.reference
    || result.reference.length > 255
    || result.reference.includes(rawNin)
    || !Number.isFinite(verifiedAt)
    || verifiedAt > Date.now() + 5 * 60 * 1000
    || typeof demographics.firstName !== 'string'
    || demographics.firstName.trim().length < 1
    || demographics.firstName.trim().length > 100
    || typeof demographics.lastName !== 'string'
    || demographics.lastName.trim().length < 1
    || demographics.lastName.trim().length > 100
    || typeof demographics.dateOfBirth !== 'string'
    || !ISO_DATE.test(demographics.dateOfBirth)
    || Number.isNaN(Date.parse(`${demographics.dateOfBirth}T00:00:00Z`))
    || !validGender
  ) {
    throw new DomainProblem(502, 'NIN_PROVIDER_RESPONSE_INVALID', 'The NIN provider returned an invalid response');
  }
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
