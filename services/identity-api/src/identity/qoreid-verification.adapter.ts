import { Inject, Injectable } from '@nestjs/common';
import { getEnvironment } from '../config/environment';
import { DomainProblem } from '../common/problem';
import {
  QOREID_PROVIDER,
  type QoreIdNinClaims,
  type QoreIdVerificationResult,
  type VerificationState,
} from './qoreid-verification.types';

export interface QoreIdAdapterConfiguration {
  baseUrl: string;
  clientId?: string;
  clientSecret?: string;
  timeoutMs: number;
}

type FetchImplementation = typeof globalThis.fetch;

export const QOREID_ADAPTER_CONFIGURATION = Symbol('QOREID_ADAPTER_CONFIGURATION');
export const QOREID_FETCH = Symbol('QOREID_FETCH');

interface JsonRecord {
  readonly [key: string]: unknown;
}

export function qoreIdAdapterConfigurationFromEnvironment(): QoreIdAdapterConfiguration {
  const environment = getEnvironment();
  return {
    baseUrl: environment.QOREID_BASE_URL,
    clientId: environment.QOREID_CLIENT_ID,
    clientSecret: environment.QOREID_CLIENT_SECRET,
    timeoutMs: environment.QOREID_TIMEOUT_MS,
  };
}

/**
 * The only component that understands QoreID's HTTP contract. It deliberately
 * returns HID-normalized outcomes, never provider payloads or OAuth tokens.
 */
@Injectable()
export class QoreIdVerificationAdapter {
  constructor(
    @Inject(QOREID_ADAPTER_CONFIGURATION) private readonly configuration: QoreIdAdapterConfiguration,
    @Inject(QOREID_FETCH) private readonly request: FetchImplementation,
  ) {}

  /** OAuth-only check. It never submits a NIN or CAC number. */
  async testConnection(): Promise<void> {
    await this.accessToken();
  }

  async verifyNin(nin: string, claims: QoreIdNinClaims): Promise<QoreIdVerificationResult> {
    const accessToken = await this.accessToken();
    // QoreID requires first and last name claims. The caller derives these
    // from the session-bound canonical patient, never from browser input.
    const response = await this.requestJson(
      `/v1/ng/identities/nin/${encodeURIComponent(nin)}`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ firstname: claims.firstName, lastname: claims.lastName,
          dob: claims.dateOfBirth }),
      },
      'verification',
    );
    return this.normalizedNinVerification(response, nin, claims);
  }

  async verifyCac(regNumber: string): Promise<QoreIdVerificationResult> {
    const accessToken = await this.accessToken();
    const response = await this.requestJson(
      '/v2/ng/identities/cac-basic',
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ regNumber }),
      },
      'verification',
    );
    return this.normalizedCacVerification(response);
  }

  private async accessToken(): Promise<string> {
    const clientId = this.configuration.clientId;
    const secret = this.configuration.clientSecret;
    if (!clientId || !secret) {
      throw new DomainProblem(503, 'QOREID_CONFIGURATION_INVALID', 'External verification is unavailable');
    }
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
      || typeof expiresIn !== 'string' || !/^\d+\s+secs$/.test(expiresIn)
      || tokenType !== 'Bearer') {
      throw this.invalidProviderResponse();
    }
    return accessToken;
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

  private normalizedCacVerification(payload: unknown): QoreIdVerificationResult {
    const result = this.normalizedVerification(payload);
    if (result.state !== 'verified') return result;
    const record = this.record(payload);
    const summary = this.record(record?.summary);
    if (typeof summary?.cac_check !== 'string') throw this.invalidProviderResponse();
    if (summary.cac_check !== 'verified') return { ...result, state: 'not_verified' };
    const cac = this.record(record?.cac);
    const registrationNumber = this.safeRegistrationNumber(cac?.rcNumber);
    const companyName = this.safeName(cac?.companyName, 200);
    const registryStatus = this.safeName(cac?.status, 40);
    if (!registrationNumber || !companyName || !registryStatus) throw this.invalidProviderResponse();
    return { ...result, cacBinding: { registrationNumber, companyName, registryStatus } };
  }

  private safeRegistrationNumber(value: unknown): string | undefined {
    const number = typeof value === 'string' ? value.trim().toUpperCase()
      : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : '';
    return /^(?:(?:RC|BN|IT))?\d{4,20}$/.test(number) ? number : undefined;
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
    const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value);
    if (!match) return undefined;
    const iso = `${match[3]}-${match[2]}-${match[1]}`;
    const date = new Date(`${iso}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso
      && date.getTime() <= Date.now() ? iso : undefined;
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
