import type { DeliveryOutcome } from './types';

export interface PushProvider {
  send(input: { deviceToken: string; idempotencyKey: string }): Promise<{
    outcome: DeliveryOutcome; provider: 'fcm'; providerMessageId?: string; safeCode?: string;
  }>;
}

export interface FcmAccessTokenProvider { accessToken(): Promise<string>; }

export class FcmPushProvider implements PushProvider {
  constructor(
    private readonly config: { projectId: string; apiUrl: string },
    private readonly credentials: FcmAccessTokenProvider,
  ) {}

  async send(input: { deviceToken: string; idempotencyKey: string }) {
    let response: Response;
    try {
      const token = await this.credentials.accessToken();
      response = await fetch(`${this.config.apiUrl.replace(/\/+$/, '')}/v1/projects/${encodeURIComponent(this.config.projectId)}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message: {
          token: input.deviceToken,
          notification: { title: 'HID update', body: 'You have a new update in HID. Sign in securely to view it.' },
          data: { idempotencyKey: input.idempotencyKey },
        } }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      return { outcome: 'unknown' as const, provider: 'fcm' as const, safeCode: 'FCM_TIMEOUT_OR_UNAVAILABLE' };
    }
    if (!response.ok) return { outcome: response.status >= 400 && response.status < 500
      && response.status !== 408 && response.status !== 429 ? 'definitive_failure' as const : 'unknown' as const,
      provider: 'fcm' as const, safeCode: `FCM_HTTP_${response.status}` };
    const body = await response.json().catch(() => undefined) as { name?: unknown } | undefined;
    return { outcome: 'accepted' as const, provider: 'fcm' as const,
      ...(typeof body?.name === 'string' && body.name.length <= 255 ? { providerMessageId: body.name } : {}) };
  }
}
