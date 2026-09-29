import { Inject, Injectable } from '@nestjs/common';
import { getEnvironment } from '../config/environment';
import { DomainProblem } from '../common/problem';
import {
  QOREID_PROVIDER,
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

  async verifyNin(nin: string): Promise<QoreIdVerificationResult> {
    const accessToken = await this.accessToken();
    // QoreID's NIN contract is path-only. In particular, do not add claimed
    // demographic attributes or a JSON body to this request.
    const response = await this.requestJson(
      `/v1/ng/identities/nin/${encodeURIComponent(nin)}`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
      },
      'verification',
    );
    return this.normalizedVerification(response);
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
    return this.normalizedVerification(response);
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
    let response: Response;
    try {
      // Provider credentials and the path-bound NIN must never be forwarded to
      // an unexpected redirect destination.
      response = await this.request(this.url(path), { ...init, redirect: 'error', signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new DomainProblem(504, 'QOREID_TIMEOUT', 'External verification timed out');
      }
      // Never propagate a provider/network error string: it can contain a URL,
      // body fragment, token, or identifier.
      throw new DomainProblem(503, 'QOREID_NETWORK_UNAVAILABLE', 'External verification is unavailable');
    } finally {
      clearTimeout(timeout);
    }

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

    let body: string;
    try {
      body = await response.text();
    } catch {
      throw this.invalidProviderResponse();
    }
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw this.invalidProviderResponse();
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
