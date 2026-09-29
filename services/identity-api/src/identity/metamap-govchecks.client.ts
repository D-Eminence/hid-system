import { randomUUID } from 'node:crypto';
import { DomainProblem } from '../common/problem';

// Official OpenAPI info.version 1.4, GovChecks path version v1. See
// docs/METAMAP_NIN_CONTRACT.md. This transport is deliberately NOT a
// NinVerificationProvider: the standalone callback contract is still incomplete.
export const METAMAP_OAUTH_URL = 'https://api.prod.metamap.com/oauth/';
export const METAMAP_NIN_URL = 'https://api.prod.metamap.com/govchecks/v1/ng/nin';

export interface MetaMapStagingConfig {
  deploymentEnvironment: string;
  stagingAccessConfirmed?: boolean;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  timeoutMs?: number;
}

export interface MetaMapNinSubmission {
  documentNumber: string;
  firstName: string;
  lastName: string;
}

export class MetaMapGovChecksClient {
  #config: Readonly<MetaMapStagingConfig>;
  #token?: { value: string; expiresAt: number };
  #tokenRequest?: Promise<string>;

  constructor(
    config: MetaMapStagingConfig,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.#config = Object.freeze({ ...config });
  }

  async submit(input: MetaMapNinSubmission): Promise<{
    state: 'response-received'; requestId: string;
  }> {
    this.assertConfiguration();
    if (!input || typeof input.documentNumber !== 'string' || !/^\d{11}$/.test(input.documentNumber)
      || !validName(input.firstName) || !validName(input.lastName)) {
      throw new DomainProblem(400, 'METAMAP_INPUT_INVALID', 'The NIN submission is invalid');
    }
    const requestId = randomUUID();
    const token = await this.accessToken();
    const body = JSON.stringify({
      documentNumber: input.documentNumber,
      firstName: input.firstName,
      lastName: input.lastName,
      callbackUrl: this.#config.callbackUrl,
      metadata: { requestId },
    });
    // No automatic POST retry: provider idempotency and reconciliation are
    // undocumented. The locally generated metadata ID is NOT a provider ID.
    await this.postJson(METAMAP_NIN_URL, {
      'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
    }, body, 262_144, 'METAMAP_SUBMISSION_UNCONFIRMED');
    // A 200 JSON response can contain a failed check. Its undocumented envelope
    // is intentionally discarded; this receipt conveys no identity assurance.
    return { state: 'response-received', requestId };
  }

  private assertConfiguration(): void {
    const config = this.#config;
    let callback: URL | undefined;
    try { callback = new URL(config.callbackUrl); } catch { /* fail closed below */ }
    if (config.deploymentEnvironment !== 'staging' || config.stagingAccessConfirmed !== true
      || typeof config.clientId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(config.clientId)
      || typeof config.clientSecret !== 'string' || !config.clientSecret || config.clientSecret.length > 4096
      || /[\x00-\x1f\x7f]/.test(config.clientSecret)
      || callback?.origin !== 'https://api.staging.healthidentitydirectory.com'
      || callback.username || callback.password || callback.search || callback.hash
      || callback.pathname === '/' || callback.href !== config.callbackUrl
      || !Number.isInteger(config.timeoutMs ?? 5000)
      || (config.timeoutMs ?? 5000) < 250 || (config.timeoutMs ?? 5000) > 10_000) {
      throw new DomainProblem(503, 'METAMAP_NOT_CONFIGURED', 'MetaMap staging access is not configured');
    }
  }

  private async accessToken(): Promise<string> {
    if (this.#token && this.#token.expiresAt > this.now()) return this.#token.value;
    if (this.#tokenRequest) return this.#tokenRequest;
    this.#tokenRequest = this.obtainToken();
    try { return await this.#tokenRequest; } finally { this.#tokenRequest = undefined; }
  }

  private async obtainToken(): Promise<string> {
    const startedAt = this.now();
    const basic = Buffer.from(`${this.#config.clientId}:${this.#config.clientSecret}`).toString('base64');
    const result = await this.postJson(METAMAP_OAUTH_URL, {
      'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}`,
    }, 'grant_type=client_credentials', 32_768, 'METAMAP_AUTH_UNAVAILABLE');
    if (typeof result.access_token !== 'string'
      || !/^[A-Za-z0-9._~+\/-]{1,16384}=*$/.test(result.access_token)
      || !Number.isSafeInteger(result.expiresIn) || Number(result.expiresIn) <= 60) {
      throw new DomainProblem(503, 'METAMAP_AUTH_UNAVAILABLE', 'MetaMap authentication is unavailable');
    }
    this.#token = {
      value: result.access_token,
      expiresAt: startedAt + Math.min(Number(result.expiresIn) - 60, 3300) * 1000,
    };
    return this.#token.value;
  }

  private async postJson(
    url: string, headers: Record<string, string>, body: string, maxBytes: number, code: string,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = async (): Promise<Record<string, unknown>> => {
      const response = await this.request(url, {
        method: 'POST', headers: { ...headers, Accept: 'application/json' }, body,
        redirect: 'error', signal: controller.signal,
      });
      if (response.status !== 200 || response.redirected
        || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
        if (response.status === 401) this.#token = undefined;
        await response.body?.cancel();
        throw new Error('Unexpected response');
      }
      if (!response.body) throw new Error('Missing body');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > maxBytes) throw new Error('Response limit exceeded');
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid JSON object');
      return result as Record<string, unknown>;
    };
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('Deadline exceeded')); }, this.#config.timeoutMs ?? 5000);
        }),
      ]);
    } catch {
      // Never attach upstream errors, response bodies, credentials or NINs.
      throw new DomainProblem(503, code, 'MetaMap could not confirm the operation');
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }
}

function validName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
    && value.length <= 100 && !/[\x00-\x1f\x7f]/.test(value);
}
