import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';
import type { LoginDto } from './dto/login.dto';

type LoginAction = NonNullable<LoginDto['turnstileAction']>;
export type TurnstileAction = LoginAction | 'patient-reset-start' | 'staff-reset'
  | 'admin-reset' | 'legacy-recovery' | 'book-demo' | 'organization-application'
  | 'organization-completion'
  | 'patient-enrollment'
  | 'provider-enrollment'
  | 'staff-invitation';

interface SiteverifyResponse {
  success?: unknown;
  hostname?: unknown;
  action?: unknown;
  'error-codes'?: unknown;
}

function deploymentActions(value: Record<string, readonly TurnstileAction[]>): Readonly<Record<string, readonly TurnstileAction[]>> {
  return Object.freeze(value);
}

const ACTIONS_BY_DEPLOYMENT: Readonly<Record<'staging' | 'production', Readonly<Record<string, readonly TurnstileAction[]>>>> = Object.freeze({
  production: deploymentActions({
    // The portal serves staff recovery at /provider/recover (staff-reset), and
    // product hosts redirect their /provider/recover there; www only redirects
    // to the public site (main D-Eminence/hid-system#41).
    // Facility self sign-up (provider-enrollment, P4) and opening a staff
    // invitation (staff-invitation, P4b) run on the portal host only: www is
    // not a production CORS origin, and product hosts accept only their own
    // sign-in actions.
    'app.healthidentitydirectory.com': [
      'patient-login', 'patient-reset-start', 'staff-reset', 'legacy-recovery', 'patient-enrollment',
      'provider-enrollment', 'staff-invitation',
    ],
    'healthidentitydirectory.com': ['book-demo', 'organization-application', 'organization-completion'],
    'www.healthidentitydirectory.com': [
      'patient-login', 'staff-login', 'admin-login', 'patient-reset-start',
      'staff-reset', 'admin-reset', 'legacy-recovery', 'book-demo', 'organization-application',
      'organization-completion',
      'patient-enrollment',
    ],
    'ehr.healthidentitydirectory.com': ['ehr-login', 'staff-login'],
    'lab.healthidentitydirectory.com': ['lab-login'],
    'pharmacy.healthidentitydirectory.com': ['pharmacy-login'],
    'migrate.healthidentitydirectory.com': ['ocr-login'],
    'outreach.healthidentitydirectory.com': ['outreach-login'],
    'admin.healthidentitydirectory.com': ['admin-login', 'admin-reset'],
  }),
  staging: deploymentActions({
    'www.staging.healthidentitydirectory.com': [
      'book-demo', 'organization-application', 'organization-completion',
    ],
    'staging.healthidentitydirectory.com': [
      'patient-login', 'staff-login', 'admin-login', 'patient-reset-start',
      'staff-reset', 'admin-reset', 'legacy-recovery', 'book-demo', 'organization-application',
      'organization-completion',
      'patient-enrollment',
      'provider-enrollment',
      'staff-invitation',
    ],
    'ehr.staging.healthidentitydirectory.com': ['ehr-login', 'staff-login'],
    'lab.staging.healthidentitydirectory.com': ['lab-login'],
    'pharmacy.staging.healthidentitydirectory.com': ['pharmacy-login'],
    'migrate.staging.healthidentitydirectory.com': ['ocr-login'],
    'outreach.staging.healthidentitydirectory.com': ['outreach-login'],
    'admin.staging.healthidentitydirectory.com': ['admin-login', 'admin-reset'],
  }),
});

/**
 * Siteverify error codes that blame Identity's own request, not the visitor:
 * a missing or wrong secret, or a malformed request. With Cloudflare's own
 * `internal-error` they answer 503 like an outage, so a misconfigured secret
 * never reads to users as a rejected check (TS-3). Cloudflare sends these with
 * HTTP 400; the visitor's token errors come with HTTP 200.
 */
const CONFIGURATION_ERROR_CODES: ReadonlySet<string> = new Set(['missing-input-secret', 'invalid-input-secret', 'bad-request']);
/** Siteverify is asked at most twice per check: once more after a transport failure or 5xx (TS-2). */
const SITEVERIFY_ATTEMPTS = 2;
/** What the log may repeat from a request or Cloudflare: lower-case words joined by hyphens. */
const LOGGABLE = /^[a-z][a-z0-9-]{0,63}$/;

@Injectable()
export class TurnstileService {
  private readonly environment = getEnvironment();
  private readonly logger = new Logger(TurnstileService.name);

  async verifyLogin(input: {
    token?: string;
    action?: LoginAction;
    origin?: string;
    remoteIp?: string;
  }): Promise<void> {
    return this.verify(input);
  }

  async verify(input: {
    token?: string;
    action?: TurnstileAction;
    origin?: string;
    remoteIp?: string;
  }): Promise<void> {
    if (this.environment.TURNSTILE_MODE === 'disabled') return;
    const secret = this.environment.TURNSTILE_SECRET_KEY;
    if (!secret) {
      throw this.unavailable(input.action, 'secret_missing', [], 0, 'The security check is unavailable');
    }
    const token = input.token?.trim();
    if (!token || token.length > 2048) {
      throw new DomainProblem(400, 'TURNSTILE_REQUIRED', 'Complete the security check and try again');
    }
    const expected = this.expectedEvidence(input.origin, input.action);
    const { response, attempts } = await this.siteverify({
      secret,
      response: token,
      ...(input.remoteIp ? { remoteip: input.remoteIp } : {}),
      // One key per check, reused only by its own retry: Cloudflare answers a
      // retry of a spent token under the same key with the first result.
      idempotency_key: randomUUID(),
    });
    if (!response) throw this.unavailable(expected.action, 'siteverify_unreachable', [], attempts);
    let result: SiteverifyResponse | undefined;
    try {
      result = await response.json() as SiteverifyResponse;
    } catch {
      result = undefined;
    }
    const errorCodes = Array.isArray(result?.['error-codes'])
      ? result['error-codes'].filter((value): value is string => typeof value === 'string')
      : [];
    if (!response.ok) {
      // A 4xx (but a rate limit) is Siteverify refusing Identity's own request.
      throw this.unavailable(expected.action, response.status < 500 && response.status !== 429
        ? 'siteverify_refused_configuration' : `siteverify_http_${response.status}`, errorCodes, attempts);
    }
    if (!result) throw this.unavailable(expected.action, 'siteverify_unreadable', [], attempts);
    if (result.success !== true) {
      if (errorCodes.some((code) => CONFIGURATION_ERROR_CODES.has(code))) {
        throw this.unavailable(expected.action, 'siteverify_refused_configuration', errorCodes, attempts);
      }
      if (errorCodes.includes('internal-error')) {
        throw this.unavailable(expected.action, 'siteverify_internal_error', errorCodes, attempts);
      }
      const replay = errorCodes.includes('timeout-or-duplicate');
      throw this.refused(replay ? 'TURNSTILE_EXPIRED_OR_REPLAYED' : 'TURNSTILE_REJECTED',
        replay ? 'The security check expired or was already used' : 'The security check was rejected',
        expected.action, errorCodes);
    }
    if (result.hostname !== expected.hostname) {
      throw this.refused('TURNSTILE_HOSTNAME_MISMATCH', 'The security check was issued for another host', expected.action, errorCodes);
    }
    if (result.action !== expected.action) {
      throw this.refused('TURNSTILE_ACTION_MISMATCH', 'The security check was issued for another action', expected.action, errorCodes);
    }
  }

  /**
   * Posts to Siteverify, once more after a transport failure or a 5xx, with the
   * same idempotency key. Any other answer, a refusal included, is final.
   */
  private async siteverify(body: Record<string, string>): Promise<{ response?: Response; attempts: number }> {
    let response: Response | undefined;
    let attempts = 0;
    while (attempts < SITEVERIFY_ATTEMPTS) {
      attempts += 1;
      try {
        response = await fetch(this.environment.TURNSTILE_SITEVERIFY_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.environment.TURNSTILE_TIMEOUT_MS),
        });
      } catch {
        response = undefined;
        continue;
      }
      if (response.status < 500) break;
      // Release the failed answer's connection before asking again.
      if (attempts < SITEVERIFY_ATTEMPTS) await response.body?.cancel().catch(() => undefined);
    }
    return { response, attempts };
  }

  private expectedEvidence(origin: string | undefined, action: TurnstileAction | undefined) {
    if (!origin || !action) {
      throw new DomainProblem(400, 'TURNSTILE_REQUIRED', 'Complete the security check and try again');
    }
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new DomainProblem(403, 'ORIGIN_DENIED', 'Request origin is not allowed');
    }
    const deployment = this.environment.HID_DEPLOYMENT_ENV;
    const allowedActions = deployment ? ACTIONS_BY_DEPLOYMENT[deployment][parsed.hostname] : undefined;
    if (parsed.origin !== origin || parsed.protocol !== 'https:' || parsed.port !== '' || !allowedActions?.includes(action)) {
      throw this.refused('TURNSTILE_CONTEXT_MISMATCH', 'The security check context is not allowed', action, []);
    }
    return { hostname: parsed.hostname, action };
  }

  /** A 403 refusal of the visitor's check, logged once. */
  private refused(code: string, detail: string, action: string | undefined, errorCodes: readonly string[]): DomainProblem {
    this.logger.log(`Turnstile check refused (event=turnstile_verification outcome=${code} `
      + `action=${this.loggable(action)} codes=${this.codes(errorCodes)})`);
    return new DomainProblem(403, code, detail);
  }

  /** A 503 the visitor can retry: Siteverify was unreachable, failed, or refused the server's own configuration. */
  private unavailable(action: string | undefined, reason: string, errorCodes: readonly string[], attempts: number,
    detail = 'The security check could not be completed'): DomainProblem {
    const line = `Turnstile check unavailable (event=turnstile_verification outcome=TURNSTILE_UNAVAILABLE `
      + `action=${this.loggable(action)} reason=${reason} codes=${this.codes(errorCodes)} attempts=${attempts})`;
    if (reason === 'secret_missing' || reason === 'siteverify_refused_configuration') this.logger.error(line);
    else this.logger.warn(line);
    return new DomainProblem(503, 'TURNSTILE_UNAVAILABLE', detail);
  }

  private loggable(value: string | undefined): string {
    return value && LOGGABLE.test(value) ? value : 'none';
  }

  private codes(errorCodes: readonly string[]): string {
    return errorCodes.filter((code) => LOGGABLE.test(code)).slice(0, 5).join(',') || 'none';
  }
}
