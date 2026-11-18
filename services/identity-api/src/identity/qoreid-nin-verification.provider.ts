import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { consumeRateLimit } from '../auth/rate-limit';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { ninNotConfigured } from './nin-verification.provider';
import type {
  NinCheckReservation,
  NinClaimedDemographics,
  NinVerificationProvider,
  NinVerificationRequest,
  NinVerificationResult,
} from './nin.types';
import { otpHmacKey } from './patient-contact-crypto';
import {
  PUBLIC_PATIENT_IDENTITY_PROVIDER,
  type PublicPatientIdentityProvider,
  type VerifiedPublicPatientIdentity,
} from './patient-enrollment.provider';
import { QOREID_PROVIDER } from './qoreid-verification.types';

/**
 * Q108: request limits for desk NIN checks through QoreID (each check is
 * charged). 0049's QoreID counters know no desk operation, and adding one
 * needs a migration, so these use the keyed request windows of 0028
 * (`auth.otp_rate_limits`, HMAC buckets, no identifiers stored).
 */
export const DESK_NIN_CHECK_LIMITS = {
  /** One staff account, per hour. */
  accountPerHour: 20,
  /** One staff account, per day. */
  accountPerDay: 100,
  /** One facility, all its staff together, per day. */
  facilityPerDay: 300,
} as const;

/** The gate's refusals while it is closed. Anything else is a fault, not a setting. */
const CLOSED_GATE_CODES = new Set(['QOREID_DISABLED', 'QOREID_NIN_ONLY_DISABLED', 'INTEGRATION_PAUSED',
  'QOREID_CONFIGURATION_INVALID']);

const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;
const PROVIDER_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const GENDERS = new Set(['female', 'male', 'intersex', 'other', 'unknown']);

/**
 * Q108: the registration desk's NIN check through QoreID, the same check and
 * the same gate as app. patient enrollment (QoreIdPublicPatientIdentityProvider):
 * QOREID_ENABLED, QOREID_NIN_ONLY_ENROLLMENT_ENABLED and the admin integration
 * control for QoreID NIN checks, read for every check (never cached).
 *
 * Only the NIN is sent. The record QoreID returns is compared here with the
 * name and date of birth the desk entered; nothing from the record other than
 * QoreID's reference is kept, and nothing is logged.
 */
@Injectable()
export class QoreIdNinVerificationProvider implements NinVerificationProvider {
  readonly name = QOREID_PROVIDER;

  constructor(
    @Inject(PUBLIC_PATIENT_IDENTITY_PROVIDER) private readonly qoreId: PublicPatientIdentityProvider,
    private readonly database: DatabaseService,
  ) {}

  isEnabled(): Promise<boolean> {
    return this.qoreId.isAvailable();
  }

  async reserve(reservation: NinCheckReservation): Promise<void> {
    const key = otpHmacKey(getEnvironment());
    const bucket = (domain: string, id: string) =>
      createHmac('sha256', key).update(`${domain}\u001f${id}`, 'utf8').digest('hex');
    let limited: boolean;
    try {
      limited = await this.database.withSystemTransaction(reservation.correlationId, async (client) => {
        const accountHour = await consumeRateLimit(client, 'account',
          bucket('nin-desk-qoreid-account-hour', reservation.accountId),
          { windowSeconds: HOUR_SECONDS, maxRequests: DESK_NIN_CHECK_LIMITS.accountPerHour });
        const accountDay = await consumeRateLimit(client, 'account',
          bucket('nin-desk-qoreid-account-day', reservation.accountId),
          { windowSeconds: DAY_SECONDS, maxRequests: DESK_NIN_CHECK_LIMITS.accountPerDay });
        const facilityDay = await consumeRateLimit(client, 'account',
          bucket('nin-desk-qoreid-facility-day', reservation.facilityId),
          { windowSeconds: DAY_SECONDS, maxRequests: DESK_NIN_CHECK_LIMITS.facilityPerDay });
        return accountHour || accountDay || facilityDay;
      });
    } catch {
      // No SQL diagnostics reach the desk or the logs.
      throw new DomainProblem(503, 'NIN_CHECK_LIMIT_UNAVAILABLE',
        'NIN checks cannot be started right now. Please try again in a minute.');
    }
    if (limited) {
      throw new DomainProblem(429, 'NIN_CHECK_LIMIT_REACHED',
        'The limit of NIN checks has been reached for now. Please try again later.');
    }
  }

  async verify(request: NinVerificationRequest): Promise<NinVerificationResult> {
    let identity: VerifiedPublicPatientIdentity;
    try {
      identity = await this.qoreId.verifyNin(request.nin);
    } catch (error) {
      if (error instanceof DomainProblem && CLOSED_GATE_CODES.has(error.code)) {
        // Switched off between the gate and the check: nothing was sent.
        throw ninNotConfigured();
      }
      if (error instanceof DomainProblem && error.code === 'NIN_NOT_VERIFIED') {
        return this.notVerified(request, 'no_match');
      }
      throw error;
    }
    if (!validIdentity(identity, request.nin)) {
      throw new DomainProblem(502, 'QOREID_PROVIDER_RESPONSE_INVALID',
        'External verification returned an invalid response');
    }
    const claimed = request.claimedDemographics;
    if (normalizedName(identity.firstName) !== normalizedName(claimed.firstName)
      || normalizedName(identity.lastName) !== normalizedName(claimed.lastName)
      || identity.dateOfBirth !== claimed.dateOfBirth) {
      return this.notVerified(request, 'name_mismatch', identity.providerReference);
    }
    // The desk's spelling is kept: it equals the record's but for letter case
    // and spacing. The record's sex is used only when the desk gave none.
    const demographics: NinClaimedDemographics = {
      firstName: claimed.firstName,
      lastName: claimed.lastName,
      dateOfBirth: identity.dateOfBirth,
      ...(claimed.gender ? { gender: claimed.gender }
        : identity.gender !== 'unknown' ? { gender: identity.gender } : {}),
    };
    return {
      verified: true,
      outcome: 'match',
      provider: this.name,
      reference: identity.providerReference,
      verifiedAt: new Date().toISOString(),
      demographics,
    };
  }

  private notVerified(request: NinVerificationRequest, outcome: 'no_match' | 'name_mismatch',
    reference = 'qoreid-not-verified'): NinVerificationResult {
    return {
      verified: false,
      outcome,
      provider: this.name,
      reference,
      verifiedAt: new Date().toISOString(),
      demographics: request.claimedDemographics,
    };
  }
}

/**
 * Q108: which NIN check the desk uses. `deferred` and `test` are unchanged.
 * With NIN_PROVIDER_MODE=unavailable (production today) and QOREID_ENABLED,
 * the desk uses QoreID; each check still asks the QoreID gate (NIN-only
 * checks on, the admin control on) and is answered "not configured", as
 * before, while the gate is closed. Otherwise NIN checks stay off.
 */
export function selectNinVerificationProvider(
  environment: { NIN_PROVIDER_MODE: 'unavailable' | 'deferred' | 'test'; QOREID_ENABLED: boolean },
  providers: {
    deterministicTest: NinVerificationProvider;
    unavailable: NinVerificationProvider;
    deferred: NinVerificationProvider;
    qoreId: NinVerificationProvider;
  },
): NinVerificationProvider {
  if (environment.NIN_PROVIDER_MODE === 'deferred') return providers.deferred;
  if (environment.NIN_PROVIDER_MODE === 'test') return providers.deterministicTest;
  return environment.QOREID_ENABLED ? providers.qoreId : providers.unavailable;
}

function normalizedName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleUpperCase('en-NG');
}

/** The record QoreID returned is for this NIN and well formed (as patient enrollment checks it). */
function validIdentity(identity: VerifiedPublicPatientIdentity, nin: string): boolean {
  const validName = (value: unknown): value is string => typeof value === 'string'
    && value.trim().length >= 1 && value.trim().length <= 100 && !/[\x00-\x1f\x7f]/.test(value);
  const date = typeof identity?.dateOfBirth === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(identity.dateOfBirth)
    ? new Date(`${identity.dateOfBirth}T00:00:00Z`) : new Date(NaN);
  return identity !== null && typeof identity === 'object'
    && identity.nin === nin && validName(identity.firstName) && validName(identity.lastName)
    && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === identity.dateOfBirth
    && date.getUTCFullYear() >= 1900 && date.getTime() <= Date.now()
    && GENDERS.has(identity.gender)
    && typeof identity.providerReference === 'string' && PROVIDER_REFERENCE.test(identity.providerReference)
    // The reference is QoreID's own transaction number, never the NIN.
    && !identity.providerReference.includes(nin);
}
