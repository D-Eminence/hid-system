import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { lockRateLimitBucket } from '../auth/rate-limit';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { ninCheckNotStarted, ninNotConfigured } from './nin-verification.provider';
import type {
  NinCheckReservation,
  NinCheckReservationResult,
  NinCheckSettlement,
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

/** The gate's refusals while it is closed. Anything else is a fault, not a setting. */
const CLOSED_GATE_CODES = new Set(['QOREID_DISABLED', 'QOREID_NIN_ONLY_DISABLED', 'INTEGRATION_PAUSED',
  'QOREID_CONFIGURATION_INVALID']);

/**
 * Q108: how long a claimed desk request counts as still being checked. A
 * check takes at most about 20 seconds (token, NIN call and one token
 * refresh at QOREID_TIMEOUT_MS); a claim older than this was left by a
 * process that stopped, and the request may be sent again.
 */
export const DESK_NIN_CHECK_CLAIM_SECONDS = 2 * 60;
/** Q108: how long a "could not be verified" or mismatch answer is given again for a resend of the same request. */
export const DESK_NIN_CHECK_ANSWER_SECONDS = 24 * 60 * 60;

const STORED_OUTCOMES = ['no_match', 'name_mismatch'] as const;
type StoredOutcome = typeof STORED_OUTCOMES[number];

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

  /**
   * Before any NIN is sent, in one transaction, the desk request (facility,
   * account, Idempotency-Key and body digest) is claimed. A resend of a
   * request already answered "could not be verified" or "does not match"
   * gets that answer again, with no new check; a resend while the first is
   * still being checked is refused (409). A match is answered by the case it
   * created (the service finds it before calling this).
   *
   * Q109 (owner, 18 November 2026): no limit is put on desk checks, per staff
   * account, per facility or across Health ID.
   *
   * Keyed rows of `auth.otp_rate_limits` hold the claim and the answer (HMAC
   * buckets: no NIN, no identifier, no name).
   */
  async reserve(reservation: NinCheckReservation): Promise<NinCheckReservationResult> {
    const keys = this.keys(reservation);
    let found: { kind: 'stored'; outcome: StoredOutcome } | { kind: 'in_progress' } | { kind: 'reserved' };
    try {
      found = await this.database.withSystemTransaction(reservation.correlationId, async (client) => {
        await lockRateLimitBucket(client, 'account', keys.claim);
        const stored = await this.storedAnswer(client, keys);
        if (stored) return { kind: 'stored' as const, outcome: stored };
        if (await this.claimHeld(client, keys.claim)) return { kind: 'in_progress' as const };
        await client.query(
          `insert into auth.otp_rate_limits (
             scope, bucket_hmac, window_started_at, request_count, blocked_until, updated_at
           ) values ('account', $1, clock_timestamp(), 1, null, clock_timestamp())
           on conflict (scope, bucket_hmac) do update set
             window_started_at = clock_timestamp(), request_count = 1, blocked_until = null,
             updated_at = clock_timestamp()`,
          [keys.claim],
        );
        return { kind: 'reserved' as const };
      });
    } catch {
      // The claim could not be read or written: nothing was sent. The desk
      // gets "cannot be started right now"; no SQL diagnostics reach the desk
      // or the logs.
      throw ninCheckNotStarted();
    }
    if (found.kind === 'stored') return { stored: found.outcome };
    if (found.kind === 'in_progress') {
      throw new DomainProblem(409, 'NIN_CHECK_IN_PROGRESS',
        'This NIN check is already in progress. Please wait for its answer.');
    }
    return {};
  }

  /**
   * Records how the reserved check ended. A "could not be verified" or
   * "does not match" answer is kept for a resend of the same request; when
   * nothing usable came back (QoreID failed, or the check was never sent)
   * the claim is let go so the desk can try again. A match keeps the claim:
   * the case it creates answers a resend. Never throws: a claim that could
   * not be updated lapses after DESK_NIN_CHECK_CLAIM_SECONDS.
   */
  async settle(reservation: NinCheckReservation, settlement: NinCheckSettlement): Promise<void> {
    if (settlement === 'match') return;
    const keys = this.keys(reservation);
    try {
      await this.database.withSystemTransaction(reservation.correlationId, async (client) => {
        await lockRateLimitBucket(client, 'account', keys.claim);
        if (settlement === 'not_answered') {
          await client.query(
            `update auth.otp_rate_limits set request_count = 0, updated_at = clock_timestamp()
              where scope = 'account' and bucket_hmac = $1`,
            [keys.claim],
          );
          return;
        }
        await client.query(
          `insert into auth.otp_rate_limits (
             scope, bucket_hmac, window_started_at, request_count, blocked_until, updated_at
           ) values ('account', $1, clock_timestamp(), 1, null, clock_timestamp())
           on conflict (scope, bucket_hmac) do update set
             window_started_at = clock_timestamp(), request_count = 1, blocked_until = null,
             updated_at = clock_timestamp()`,
          [keys.answers[settlement]],
        );
      });
    } catch {
      // Nothing to tell the desk: its answer stands. No SQL diagnostics are logged.
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
      if (error instanceof DomainProblem && error.code === 'INTEGRATION_UNAVAILABLE') {
        // The gate's admin control could not be read (only the gate, which
        // runs before anything is sent, raises this code): nothing was sent.
        throw ninCheckNotStarted();
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

  /** The keyed buckets of one desk request (HMAC of the facility, account, key and digest; never the raw values). */
  private keys(reservation: NinCheckReservation) {
    const key = otpHmacKey(getEnvironment());
    const bucket = (domain: string, ...parts: string[]) =>
      createHmac('sha256', key).update([domain, ...parts].join('\u001f'), 'utf8').digest('hex');
    const request = [reservation.facilityId, reservation.accountId, reservation.idempotencyKey,
      reservation.requestSha256];
    return {
      claim: bucket('nin-desk-qoreid-claim', ...request),
      answers: {
        no_match: bucket('nin-desk-qoreid-answer-no_match', ...request),
        name_mismatch: bucket('nin-desk-qoreid-answer-name_mismatch', ...request),
      } satisfies Record<StoredOutcome, string>,
    };
  }

  private async storedAnswer(client: PoolClient, keys: ReturnType<QoreIdNinVerificationProvider['keys']>):
    Promise<StoredOutcome | null> {
    const result = await client.query<{ bucket_hmac: string }>(
      `select bucket_hmac from auth.otp_rate_limits
        where scope = 'account' and bucket_hmac = any($1::text[]) and request_count > 0
          and window_started_at > clock_timestamp() - ($2 * interval '1 second')`,
      [STORED_OUTCOMES.map((outcome) => keys.answers[outcome]), DESK_NIN_CHECK_ANSWER_SECONDS],
    );
    const held = new Set(result.rows.map((row) => row.bucket_hmac.trim()));
    return STORED_OUTCOMES.find((outcome) => held.has(keys.answers[outcome])) ?? null;
  }

  private async claimHeld(client: PoolClient, claim: string): Promise<boolean> {
    const result = await client.query<{ held: boolean }>(
      `select (request_count > 0
                and window_started_at > clock_timestamp() - ($2 * interval '1 second')) as held
         from auth.otp_rate_limits where scope = 'account' and bucket_hmac = $1`,
      [claim, DESK_NIN_CHECK_CLAIM_SECONDS],
    );
    return result.rows[0]?.held === true;
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
