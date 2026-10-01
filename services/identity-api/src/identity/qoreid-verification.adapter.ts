import { Inject, Injectable } from '@nestjs/common';
import { getEnvironment } from '../config/environment';
import { DomainProblem } from '../common/problem';
import {
  QOREID_PROVIDER,
  type QoreIdNinClaims,
  type QoreIdNinEnrollmentBinding,
  type QoreIdVerificationResult,
  type VerificationState,
} from './qoreid-verification.types';

export interface QoreIdAdapterConfiguration {
  baseUrl: string;
  clientId?: string;
  clientSecret?: string;
  timeoutMs: number;
  /** Explicitly enables the provider-confirmed NIN-only transport. */
  ninOnlyEnrollmentEnabled?: boolean;
}

type FetchImplementation = typeof globalThis.fetch;

export const QOREID_ADAPTER_CONFIGURATION = Symbol('QOREID_ADAPTER_CONFIGURATION');
export const QOREID_FETCH = Symbol('QOREID_FETCH');

interface JsonRecord {
  readonly [key: string]: unknown;
}

interface AccessTokenLease {
  readonly value: string;
  readonly expiresAt: number;
  readonly usableUntil: number;
}

const MAX_TOKEN_USE_SECONDS = 5_400;

export function qoreIdAdapterConfigurationFromEnvironment(): QoreIdAdapterConfiguration {
  const environment = getEnvironment();
  return {
    baseUrl: environment.QOREID_BASE_URL,
    clientId: environment.QOREID_CLIENT_ID,
    clientSecret: environment.QOREID_CLIENT_SECRET,
    timeoutMs: environment.QOREID_TIMEOUT_MS,
    ninOnlyEnrollmentEnabled: environment.QOREID_NIN_ONLY_ENROLLMENT_ENABLED,
  };
}

/**
 * The only component that understands QoreID's HTTP contract. It deliberately
 * returns HID-normalized outcomes, never provider payloads or OAuth tokens.
 */
@Injectable()
export class QoreIdVerificationAdapter {
  private cachedToken?: AccessTokenLease;
  private tokenRefresh?: Promise<AccessTokenLease>;

  constructor(
    @Inject(QOREID_ADAPTER_CONFIGURATION) private readonly configuration: QoreIdAdapterConfiguration,
    @Inject(QOREID_FETCH) private readonly request: FetchImplementation,
  ) {}

  /** Fresh OAuth-only check. It never submits a NIN or CAC number. */
  async testConnection(): Promise<void> {
    await this.accessToken(true);
  }

  async verifyNin(nin: string, claims: QoreIdNinClaims): Promise<QoreIdVerificationResult> {
    // QoreID requires first and last name claims. The caller derives these
    // from the session-bound canonical patient, never from browser input.
    const response = await this.requestVerification(
      `/v1/ng/identities/nin/${encodeURIComponent(nin)}`,
      JSON.stringify({ firstname: claims.firstName, lastname: claims.lastName,
        dob: claims.dateOfBirth }),
    );
    return this.normalizedNinVerification(response, nin, claims);
  }

  /**
   * Public enrollment deliberately sends no applicant demographics. The
   * provider-confirmed NIN-only transport remains behind an explicit gate.
   */
  async verifyNinEnrollment(nin: string): Promise<QoreIdVerificationResult> {
    if (!this.configuration.ninOnlyEnrollmentEnabled) {
      throw new DomainProblem(503, 'QOREID_NIN_ONLY_DISABLED',
        'Patient identity enrollment is temporarily unavailable');
    }
    if (!/^\d{11}$/.test(nin)) {
      throw new DomainProblem(400, 'NIN_INVALID', 'An 11-digit NIN is required');
    }
    const response = await this.requestVerification(
      `/v1/ng/identities/nin/${encodeURIComponent(nin)}`,
    );
    const result = this.normalizedVerification(response);
    if (result.state !== 'verified') return result;
    if (!result.providerReference) throw this.invalidProviderResponse();
    const summary = this.record(this.record(response)?.summary);
    if (typeof summary?.nin_check !== 'string') throw this.invalidProviderResponse();
    if (summary.nin_check !== 'verified') return { ...result, state: 'not_verified' };
    return { ...result, ninEnrollmentBinding: this.ninEnrollmentBinding(response, nin) };
  }

  async verifyCac(regNumber: string): Promise<QoreIdVerificationResult> {
    const submitted = typeof regNumber === 'string' ? regNumber.replace(/\s+/g, '').toUpperCase() : '';
    if (!/^(?:RC|BN|IT)[0-9]{4,20}$/.test(submitted)) {
      throw new DomainProblem(400, 'CAC_REGISTRATION_NUMBER_INVALID', 'A valid CAC registration number is required');
    }
    const response = await this.requestVerification('/v2/ng/identities/cac-basic',
      JSON.stringify({ regNumber: submitted }));
    return this.normalizedCacVerification(response, submitted);
  }

  private async requestVerification(path: string, body?: string): Promise<unknown> {
    const send = (token: AccessTokenLease) => this.requestJson(path, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        authorization: `Bearer ${token.value}`,
      },
      ...(body === undefined ? {} : { body }),
    }, 'verification');
    const token = await this.accessToken();
    try {
      return await send(token);
    } catch (error) {
      if (!(error instanceof DomainProblem) || error.code !== 'QOREID_AUTHENTICATION_FAILED') throw error;
      // A simultaneous request may already have replaced this lease. Do not
      // invalidate its fresh token when a request using an older lease fails.
      if (this.cachedToken === token) this.cachedToken = undefined;
      const replacement = await this.accessToken();
      try {
        return await send(replacement);
      } catch (retryError) {
        if (retryError instanceof DomainProblem && retryError.code === 'QOREID_AUTHENTICATION_FAILED'
          && this.cachedToken === replacement) this.cachedToken = undefined;
        throw retryError;
      }
    }
  }

  private async accessToken(forceRefresh = false): Promise<AccessTokenLease> {
    if (!forceRefresh && this.cachedToken && Date.now() < this.cachedToken.expiresAt
      && Date.now() < this.cachedToken.usableUntil) return this.cachedToken;
    if (this.tokenRefresh) return this.tokenRefresh;
    const refresh = this.fetchAccessToken();
    this.tokenRefresh = refresh;
    try {
      return await refresh;
    } finally {
      if (this.tokenRefresh === refresh) this.tokenRefresh = undefined;
    }
  }

  private async fetchAccessToken(): Promise<AccessTokenLease> {
    const clientId = this.configuration.clientId;
    const secret = this.configuration.clientSecret;
    if (!clientId || !secret) {
      throw new DomainProblem(503, 'QOREID_CONFIGURATION_INVALID', 'External verification is unavailable');
    }
    // Start the lifetime before the network call, so transport time cannot
    // extend QoreID's actual expiry or HID's shorter safety window.
    const requestedAt = Date.now();
    const response = await this.requestJson(
      '/token',
      {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        // This spelling is QoreID's OAuth contract. Do not substitute common
        // OAuth field names such as client_id/client_secret.
        body: JSON.stringify({ clientId, secret }),
      },
      'token',
    );
    const record = this.record(response);
    const accessToken = record?.accessToken;
    const expiresIn = record?.expiresIn;
    const tokenType = record?.tokenType;
    if (typeof accessToken !== 'string' || accessToken.length < 1 || accessToken.length > 8_192
      || /[^\x21-\x7e]/.test(accessToken)
      || typeof expiresIn !== 'number' || !Number.isSafeInteger(expiresIn) || expiresIn <= 0
      || tokenType !== 'Bearer') {
      throw this.invalidProviderResponse();
    }
    const expiresAt = requestedAt + expiresIn * 1_000;
    if (!Number.isSafeInteger(expiresAt)) throw this.invalidProviderResponse();
    const lease = { value: accessToken, expiresAt,
      usableUntil: Math.min(expiresAt, requestedAt + MAX_TOKEN_USE_SECONDS * 1_000) };
    if (Date.now() >= lease.usableUntil) throw this.invalidProviderResponse();
    this.cachedToken = lease;
    return lease;
  }

  private async requestJson(path: string, init: RequestInit, operation: 'token' | 'verification'): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.configuration.timeoutMs);
    try {
      // Provider credentials and the path-bound NIN must never be forwarded to
      // an unexpected redirect destination.
      const response = await this.request(this.url(path), { ...init, redirect: 'error', signal: controller.signal });
      if (!response.ok) {
        if (response.status === 401) {
          throw new DomainProblem(503, 'QOREID_AUTHENTICATION_FAILED', 'External verification is unavailable');
        }
        if (response.status === 429) {
          throw new DomainProblem(429, 'QOREID_RATE_LIMITED', 'External verification is temporarily rate limited');
        }
        if (response.status >= 500) {
          throw new DomainProblem(503, 'QOREID_PROVIDER_UNAVAILABLE', 'External verification is unavailable');
        }
        throw new DomainProblem(502, operation === 'token' ? 'QOREID_TOKEN_REJECTED' : 'QOREID_PROVIDER_REJECTED',
          'External verification could not be completed');
      }
      // Keep the deadline active while consuming the body. NIN responses may
      // contain a photo, but no provider can send unbounded data to this API.
      const reader = response.body?.getReader();
      if (!reader) throw this.invalidProviderResponse();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 262_144) {
          controller.abort();
          throw this.invalidProviderResponse();
        }
        chunks.push(chunk.value);
      }
      try {
        const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        return JSON.parse(body) as unknown;
      }
      catch { throw this.invalidProviderResponse(); }
    } catch (error) {
      if (error instanceof DomainProblem) throw error;
      if (controller.signal.aborted) {
        throw new DomainProblem(504, 'QOREID_TIMEOUT', 'External verification timed out');
      }
      // Never propagate a provider/network error string: it can contain a URL,
      // body fragment, token, or identifier.
      throw new DomainProblem(503, 'QOREID_NETWORK_UNAVAILABLE', 'External verification is unavailable');
    } finally {
      clearTimeout(timeout);
    }
  }

  private normalizedVerification(payload: unknown): QoreIdVerificationResult {
    const record = this.record(payload);
    const status = this.record(record?.status);
    const state = status?.state;
    const verificationStatus = status?.status;
    if (typeof state !== 'string' || typeof verificationStatus !== 'string') {
      throw this.invalidProviderResponse();
    }

    const normalized: VerificationState = state === 'complete'
      ? verificationStatus === 'verified' ? 'verified' : 'not_verified'
      : 'incomplete';
    const id = record?.id;
    const providerReference = typeof id === 'number' && Number.isSafeInteger(id) && id >= 0
      ? String(id)
      : undefined;
    return {
      provider: QOREID_PROVIDER,
      state: normalized,
      ...(providerReference ? { providerReference } : {}),
      respondedAt: new Date().toISOString(),
    };
  }

  private normalizedNinVerification(payload: unknown, submittedNin: string,
    claims: QoreIdNinClaims): QoreIdVerificationResult {
    const result = this.normalizedVerification(payload);
    if (result.state !== 'verified') return result;
    const record = this.record(payload);
    const match = this.record(this.record(record?.summary)?.nin_check);
    const fields = this.record(match?.fieldMatches);
    if (typeof match?.status !== 'string' || typeof fields?.firstname !== 'boolean'
      || typeof fields?.lastname !== 'boolean') throw this.invalidProviderResponse();
    if (match.status !== 'EXACT_MATCH' || !fields.firstname || !fields.lastname
      || (fields.dob !== undefined && fields.dob !== true)) {
      return { ...result, state: 'not_verified' };
    }
    const bio = this.record(record?.nin);
    const returnedNin = bio?.nin;
    const firstName = this.safeName(bio?.firstname);
    const lastName = this.safeName(bio?.lastname);
    const dateOfBirth = this.dateOfBirth(bio?.birthdate);
    if (typeof returnedNin !== 'string' || !/^\d{11}$/.test(returnedNin)
      || !firstName || !lastName || !dateOfBirth) throw this.invalidProviderResponse();
    if (returnedNin !== submittedNin
      || this.normalizedName(firstName) !== this.normalizedName(claims.firstName)
      || this.normalizedName(lastName) !== this.normalizedName(claims.lastName)
      || dateOfBirth !== claims.dateOfBirth) return { ...result, state: 'not_verified' };
    return { ...result, ninBinding: { firstName, lastName, dateOfBirth } };
  }

  private normalizedCacVerification(payload: unknown, submitted: string): QoreIdVerificationResult {
    const result = this.normalizedVerification(payload);
    if (result.state !== 'verified') return result;
    if (!result.providerReference) throw this.invalidProviderResponse();
    const record = this.record(payload);
    const summary = this.record(record?.summary);
    if (typeof summary?.cac_check !== 'string') throw this.invalidProviderResponse();
    if (summary.cac_check !== 'verified') return { ...result, state: 'not_verified' };
    const cac = this.record(record?.cac);
    if (!cac) throw this.invalidProviderResponse();
    const providerRegistrationNumber = this.safeCacRegistrationNumber(cac.rcNumber);
    if (!providerRegistrationNumber) throw this.invalidProviderResponse();
    const submittedPrefix = submitted.slice(0, 2);
    const submittedDigits = submitted.slice(2);
    const providerPrefix = /^(RC|BN|IT)/.exec(providerRegistrationNumber)?.[1];
    const providerDigits = providerPrefix
      ? providerRegistrationNumber.slice(2) : providerRegistrationNumber;
    if ((providerPrefix && providerPrefix !== submittedPrefix)
      || providerDigits !== submittedDigits) return { ...result, state: 'not_verified' };

    const companyName = this.safeName(cac.companyName, 200);
    const entityType = this.safeName(cac.companyType, 120);
    const registrationDate = this.registrationDate(cac.registrationDate);
    const branchAddress = this.optionalCacText(cac.branchAddress, 1000);
    const companyEmail = this.optionalCacEmail(cac.companyEmail);
    const city = this.optionalCacText(cac.city, 120);
    const headOfficeAddress = this.optionalCacText(cac.headOfficeAddress, 1000);
    const lga = this.optionalCacText(cac.lga, 120);
    const state = this.optionalCacText(cac.state, 120);
    const affiliates = this.optionalCacAffiliates(cac.affiliates);
    const registryStatus = this.safeName(cac.status, 40);
    const address = headOfficeAddress.value ?? branchAddress.value;
    if (!companyName || !entityType || !registrationDate || !address || !registryStatus
      || !branchAddress.valid || !companyEmail.valid || !city.valid || !headOfficeAddress.valid
      || !lga.valid || !state.valid || !affiliates.valid) throw this.invalidProviderResponse();
    if (registryStatus.toLowerCase() !== 'active') return { ...result, state: 'not_verified' };
    return { ...result, cacBinding: {
      registrationNumber: submitted,
      providerRegistrationNumber,
      companyName, entityType, registrationDate, address,
      registryStatus,
      ...(branchAddress.value ? { branchAddress: branchAddress.value } : {}),
      ...(companyEmail.value ? { companyEmail: companyEmail.value } : {}),
      ...(city.value ? { city: city.value } : {}),
      ...(headOfficeAddress.value ? { headOfficeAddress: headOfficeAddress.value } : {}),
      ...(lga.value ? { lga: lga.value } : {}),
      ...(affiliates.value !== undefined ? { affiliates: affiliates.value } : {}),
      ...(state.value ? { state: state.value } : {}),
    } };
  }

  private ninEnrollmentBinding(payload: unknown, submittedNin: string): QoreIdNinEnrollmentBinding {
    const record = this.record(payload);
    const bio = this.record(record?.nin);
    const nin = bio?.nin;
    const firstName = this.safeName(bio?.firstname);
    const lastName = this.safeName(bio?.lastname);
    const dateOfBirth = this.dateOfBirth(bio?.birthdate);
    const gender = this.gender(bio?.gender);
    if (nin !== submittedNin || !firstName || !lastName || !dateOfBirth || !gender) {
      throw this.invalidProviderResponse();
    }
    const rawMiddleName = bio?.middlename;
    const middleName = rawMiddleName === undefined || rawMiddleName === null || rawMiddleName === ''
      ? undefined : this.safeName(rawMiddleName);
    const phoneNumber = bio?.phone === undefined ? undefined : this.safeName(bio.phone, 30);
    // Only nin.residence is part of the confirmed NIN-only response contract.
    const residence = this.ninResidence(bio?.residence);
    const photo = typeof bio?.photo === 'string' && bio.photo.length <= 131_072
      && /^[A-Za-z0-9+/]+={0,2}$/.test(bio.photo) ? bio.photo : undefined;
    if ((rawMiddleName !== undefined && rawMiddleName !== null && rawMiddleName !== '' && !middleName)
      || (bio?.phone !== undefined && !phoneNumber)
      || (bio?.photo !== undefined && !photo)) throw this.invalidProviderResponse();
    return { nin, firstName, lastName, dateOfBirth, gender,
      ...(middleName ? { middleName } : {}),
      ...(phoneNumber ? { phoneNumber } : {}),
      ...(residence ? { address: residence.address1, residence } : {}),
      ...(photo ? { photo } : {}) };
  }

  private ninResidence(value: unknown): QoreIdNinEnrollmentBinding['residence'] | undefined {
    if (value === undefined) return undefined;
    const record = this.record(value);
    const address1 = this.safeName(record?.address1, 1000);
    const town = record?.town === undefined ? undefined : this.safeName(record.town, 120);
    const lga = record?.lga === undefined ? undefined : this.safeName(record.lga, 120);
    const state = record?.state === undefined ? undefined : this.safeName(record.state, 120);
    if (!address1 || (record?.town !== undefined && !town)
      || (record?.lga !== undefined && !lga)
      || (record?.state !== undefined && !state)) throw this.invalidProviderResponse();
    return { address1, ...(town ? { town } : {}), ...(lga ? { lga } : {}),
      ...(state ? { state } : {}) };
  }

  private gender(value: unknown): QoreIdNinEnrollmentBinding['gender'] | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'm' || normalized === 'male') return 'male';
    if (normalized === 'f' || normalized === 'female') return 'female';
    if (normalized === 'intersex' || normalized === 'other' || normalized === 'unknown') return normalized;
    return undefined;
  }

  private validDate(iso: string): string | undefined {
    const date = new Date(`${iso}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso
      && date.getUTCFullYear() >= 1800 && date.getTime() <= Date.now() ? iso : undefined;
  }

  private registrationDate(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const input = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return this.validDate(input);
    const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/.exec(input);
    if (!match) return undefined;
    const [, day = '', monthText = '', yearText = ''] = match;
    const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
      .indexOf(monthText.toLowerCase()) + 1;
    if (!month) return undefined;
    const yearNumber = Number(yearText);
    const currentYear = new Date().getUTCFullYear();
    const year = yearText.length === 2
      ? (yearNumber <= currentYear % 100 ? 2000 : 1900) + yearNumber
      : yearNumber;
    return this.validDate(`${year}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}`);
  }

  private safeCacRegistrationNumber(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.replace(/\s+/g, '').toUpperCase();
    return /^(?:(?:RC|BN|IT))?[0-9]{4,20}$/.test(normalized) ? normalized : undefined;
  }

  private optionalCacText(value: unknown, limit: number): { valid: boolean; value?: string } {
    if (value === undefined || value === null || value === '') return { valid: true };
    const normalized = this.safeName(value, limit);
    return normalized ? { valid: true, value: normalized } : { valid: false };
  }

  private optionalCacEmail(value: unknown): { valid: boolean; value?: string } {
    if (value === undefined || value === null || value === '') return { valid: true };
    const normalized = this.safeName(value, 254);
    return normalized && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
      ? { valid: true, value: normalized } : { valid: false };
  }

  private optionalCacAffiliates(value: unknown): { valid: boolean; value?: number } {
    if (value === undefined || value === null || value === '') return { valid: true };
    const number = typeof value === 'number' ? value
      : typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(number) && number >= 0
      ? { valid: true, value: number } : { valid: false };
  }

  private safeName(value: unknown, limit = 100): string | undefined {
    if (typeof value !== 'string') return undefined;
    const name = value.trim();
    return name.length >= 1 && name.length <= limit && !/[\x00-\x1f\x7f]/.test(name)
      ? name : undefined;
  }

  private normalizedName(value: string): string {
    return value.trim().replace(/\s+/g, ' ').toLocaleUpperCase('en-NG');
  }

  private dateOfBirth(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return this.validDate(value);
    const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value);
    if (!match) return undefined;
    const iso = `${match[3]}-${match[2]}-${match[1]}`;
    return this.validDate(iso);
  }

  private url(path: string): string {
    return new URL(path, this.configuration.baseUrl).toString();
  }

  private record(value: unknown): JsonRecord | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as JsonRecord
      : undefined;
  }

  private invalidProviderResponse(): DomainProblem {
    return new DomainProblem(502, 'QOREID_PROVIDER_RESPONSE_INVALID', 'External verification returned an invalid response');
  }

}
