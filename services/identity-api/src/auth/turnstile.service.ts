import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainProblem } from '../common/problem';
import { getEnvironment } from '../config/environment';
import type { LoginDto } from './dto/login.dto';

type LoginAction = NonNullable<LoginDto['turnstileAction']>;
export type TurnstileAction = LoginAction | 'patient-reset-start' | 'staff-reset'
  | 'admin-reset' | 'legacy-recovery';

interface SiteverifyResponse {
  success?: unknown;
  hostname?: unknown;
  action?: unknown;
  'error-codes'?: unknown;
}

const ACTIONS_BY_HOST: Readonly<Record<string, readonly TurnstileAction[]>> = Object.freeze({
  'www.healthidentitydirectory.com': [
    'patient-login', 'staff-login', 'admin-login', 'patient-reset-start',
    'staff-reset', 'admin-reset', 'legacy-recovery',
  ],
  'ehr.healthidentitydirectory.com': ['ehr-login', 'staff-login'],
  'lab.healthidentitydirectory.com': ['lab-login'],
  'pharmacy.healthidentitydirectory.com': ['pharmacy-login'],
  'ocr.healthidentitydirectory.com': ['ocr-login'],
  'outreach.healthidentitydirectory.com': ['outreach-login'],
  'admin.healthidentitydirectory.com': ['admin-login', 'admin-reset'],
});

@Injectable()
export class TurnstileService {
  private readonly environment = getEnvironment();

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
    if (!secret) throw new DomainProblem(503, 'TURNSTILE_UNAVAILABLE', 'The security check is unavailable');
    const token = input.token?.trim();
    if (!token || token.length > 2048) {
      throw new DomainProblem(400, 'TURNSTILE_REQUIRED', 'Complete the security check and try again');
    }
    const expected = this.expectedEvidence(input.origin, input.action);
    let response: Response;
    try {
      response = await fetch(this.environment.TURNSTILE_SITEVERIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          secret,
          response: token,
          ...(input.remoteIp ? { remoteip: input.remoteIp } : {}),
          idempotency_key: randomUUID(),
        }),
        signal: AbortSignal.timeout(this.environment.TURNSTILE_TIMEOUT_MS),
      });
    } catch {
      throw new DomainProblem(503, 'TURNSTILE_UNAVAILABLE', 'The security check could not be completed');
    }
    if (!response.ok) {
      throw new DomainProblem(503, 'TURNSTILE_UNAVAILABLE', 'The security check could not be completed');
    }
    let result: SiteverifyResponse;
    try {
      result = await response.json() as SiteverifyResponse;
    } catch {
      throw new DomainProblem(503, 'TURNSTILE_UNAVAILABLE', 'The security check could not be completed');
    }
    const errorCodes = Array.isArray(result['error-codes'])
      ? result['error-codes'].filter((value): value is string => typeof value === 'string')
      : [];
    if (result.success !== true) {
      const replay = errorCodes.includes('timeout-or-duplicate');
      throw new DomainProblem(403, replay ? 'TURNSTILE_EXPIRED_OR_REPLAYED' : 'TURNSTILE_REJECTED',
        replay ? 'The security check expired or was already used' : 'The security check was rejected');
    }
    if (result.hostname !== expected.hostname) {
      throw new DomainProblem(403, 'TURNSTILE_HOSTNAME_MISMATCH', 'The security check was issued for another host');
    }
    if (result.action !== expected.action) {
      throw new DomainProblem(403, 'TURNSTILE_ACTION_MISMATCH', 'The security check was issued for another action');
    }
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
    const allowedActions = ACTIONS_BY_HOST[parsed.hostname];
    if (parsed.origin !== origin || parsed.protocol !== 'https:' || !allowedActions?.includes(action)) {
      throw new DomainProblem(403, 'TURNSTILE_CONTEXT_MISMATCH', 'The security check context is not allowed');
    }
    return { hostname: parsed.hostname, action };
  }
}
