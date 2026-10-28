import { createHmac, randomUUID } from 'node:crypto';
import { HttpException, Injectable, Logger, NotFoundException, type OnApplicationBootstrap } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { requirePatient } from '../auth/patient-self.service';
import { consumeRateLimit, type RateLimitWindow } from '../auth/rate-limit';
import type { PatientSessionActor } from '../auth/recent-authentication';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { isDatabaseError } from '../patient-safety/database-error';
import type { RemoveWebPushSubscriptionDto, SubscribeWebPushDto } from './dto/web-push.dto';
import { webPushConfiguration } from './web-push.config';
import { base64UrlBytes, checkWebPushEndpoint, type WebPushService as PushServiceName, webPushEndpointDigest }
  from './web-push-endpoint';
import { WebPushProtector, webPushUnavailable } from './web-push.protector';

/** At most this many active subscriptions per patient (0097, D11). */
export const WEB_PUSH_SUBSCRIPTION_LIMIT = 10;
/** Subscribes per account per hour (R2); unsubscribing is never limited. */
export const WEB_PUSH_SUBSCRIBE_WINDOW: RateLimitWindow = { windowSeconds: 3600, maxRequests: 30 };

export interface WebPushSubscriptionItem {
  id: string;
  endpointDigest: string;
  pushService: PushServiceName;
  thisSignIn: boolean;
  keyCurrent: boolean;
  createdAt: string;
  boundAt: string;
  lastDeliveredAt: string | null;
}

export interface WebPushState {
  applicationServerKey: string;
  keyId: string;
  limit: number;
  subscriptions: WebPushSubscriptionItem[];
}

interface ListRow {
  subscription_id: string;
  endpoint_sha256: string;
  push_service: PushServiceName;
  this_sign_in: boolean;
  vapid_key_id: string;
  created_at: Date;
  bound_at: Date;
  last_delivered_at: Date | null;
}

/**
 * Phone and computer notifications (B6, migration 0097): the patient's own
 * browser subscriptions. Every command is a SECURITY DEFINER function bound to
 * the live patient session (identity.patient_self_session); this service
 * checks the browser's subscription (rule E, the key lengths, the key id),
 * counts subscribes (30 an hour), encrypts the endpoint (D15) and never
 * touches the table. While push is off (web-push.config.ts) every route
 * answers 404, as an Identity before B6 (WebPushConfiguredGuard).
 */
@Injectable()
export class WebPushService implements OnApplicationBootstrap {
  private readonly environment = getEnvironment();
  private readonly logger = new Logger(WebPushService.name);

  constructor(private readonly database: DatabaseService, private readonly protector: WebPushProtector) {}

  onApplicationBootstrap(): void {
    if (this.environment.NODE_ENV === 'test') return;
    const configuration = webPushConfiguration();
    if (configuration.on) this.logger.log(`Web push is on (keyId=${configuration.keyId})`);
    else this.logger.log(`Web push is off (reason=${configuration.reason})`);
  }

  /** R1: the public key, its id and this account's subscriptions. */
  async state(request: HidRequest): Promise<WebPushState> {
    const configuration = this.served();
    const actor = requirePatient(request.actor);
    let rows: ListRow[];
    try {
      rows = await this.asPatient(request, actor, async (client) => (await client.query<ListRow>(
        'select subscription_id::text, endpoint_sha256, push_service, this_sign_in, vapid_key_id, created_at, bound_at, '
        + 'last_delivered_at from identity.list_my_web_push_subscriptions($1, $2)',
        [actor.subject, actor.sessionId])).rows);
    } catch (error) {
      throw translate(error);
    }
    return {
      applicationServerKey: configuration.applicationServerKey,
      keyId: configuration.keyId,
      limit: WEB_PUSH_SUBSCRIPTION_LIMIT,
      subscriptions: rows.map((row) => ({
        id: row.subscription_id,
        endpointDigest: row.endpoint_sha256,
        pushService: row.push_service,
        thisSignIn: row.this_sign_in === true,
        keyCurrent: row.vapid_key_id === configuration.keyId,
        createdAt: new Date(row.created_at).toISOString(),
        boundAt: new Date(row.bound_at).toISOString(),
        lastDeliveredAt: row.last_delivered_at ? new Date(row.last_delivered_at).toISOString() : null,
      })),
    };
  }

  /** R2: subscribe this browser (or bind its existing subscription to this sign-in). */
  async subscribe(request: HidRequest, input: SubscribeWebPushDto):
  Promise<{ id: string; created: boolean; endpointDigest: string; pushService: PushServiceName }> {
    const configuration = this.served();
    const actor = requirePatient(request.actor);
    const p256dh = base64UrlBytes(input.keys?.p256dh);
    const auth = base64UrlBytes(input.keys?.auth);
    if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 0x04 || !auth || auth.length !== 16) throw subscriptionInvalid();
    const endpoint = checkWebPushEndpoint(input.endpoint);
    if (!endpoint.ok) {
      throw endpoint.reason === 'unsupported'
        ? new DomainProblem(400, 'WEB_PUSH_SERVICE_UNSUPPORTED', 'This browser\'s push service is not supported')
        : subscriptionInvalid();
    }
    if (input.keyId !== configuration.keyId) {
      throw new DomainProblem(409, 'WEB_PUSH_KEY_CHANGED', 'Notifications changed on Health ID: turn them on again');
    }
    const bucket = this.subscribeBucket(actor.accountId);
    let limited: boolean;
    try {
      limited = await this.database.withSystemTransaction(request.correlationId,
        (client) => consumeRateLimit(client, 'account', bucket, WEB_PUSH_SUBSCRIBE_WINDOW));
    } catch {
      throw webPushUnavailable();
    }
    if (limited) {
      throw new DomainProblem(429, 'WEB_PUSH_RATE_LIMITED', 'Too many attempts to turn on notifications. Try again in an hour.');
    }
    if (!this.protector.configured()) throw webPushUnavailable();
    const subscriptionId = randomUUID();
    const endpointDigest = webPushEndpointDigest(input.endpoint);
    const ciphertext = this.protector.encrypt(subscriptionId, input.endpoint);
    try {
      const row = await this.asPatient(request, actor, async (client) => (await client.query<{ subscription_id: string; created: boolean }>(
        'select subscription_id::text, created from identity.subscribe_my_web_push($1, $2, $3, $4, $5, $6, $7, $8)',
        [actor.subject, actor.sessionId, subscriptionId, endpointDigest, ciphertext, this.protector.keyVersion,
          endpoint.pushService, configuration.keyId])).rows[0]);
      if (!row) throw webPushUnavailable();
      return { id: row.subscription_id, created: row.created === true, endpointDigest, pushService: endpoint.pushService };
    } catch (error) {
      throw translate(error);
    }
  }

  /** R3: stop pushing to this browser. Idempotent and never rate limited. */
  async unsubscribe(request: HidRequest, input: RemoveWebPushSubscriptionDto): Promise<{ removed: boolean }> {
    this.served();
    const actor = requirePatient(request.actor);
    if (!wellFormedHttpsUrl(input.endpoint)) throw subscriptionInvalid();
    try {
      const removed = await this.asPatient(request, actor, async (client) => (await client.query<{ removed: boolean }>(
        'select identity.unsubscribe_my_web_push($1, $2, $3) as removed',
        [actor.subject, actor.sessionId, webPushEndpointDigest(input.endpoint)])).rows[0]?.removed);
      return { removed: removed === true };
    } catch (error) {
      throw translate(error);
    }
  }

  /** The configuration while on; 404 otherwise (the guard answers first; this covers direct calls). */
  private served(): Extract<ReturnType<typeof webPushConfiguration>, { on: true }> {
    const configuration = webPushConfiguration();
    if (!configuration.on) throw new NotFoundException();
    return configuration;
  }

  /** HMAC-SHA-256 with the OTP key over 'web-push-subscribe\0' + account id (as the directory's bucket). */
  private subscribeBucket(accountId: string): string {
    const encoded = this.environment.OTP_HMAC_KEY_B64;
    const key = encoded ? Buffer.from(encoded, 'base64') : undefined;
    if (!key || key.length !== 32) throw webPushUnavailable();
    return createHmac('sha256', key).update('web-push-subscribe\0').update(accountId).digest('hex');
  }

  private asPatient<Result>(request: HidRequest, actor: PatientSessionActor,
    operation: (client: PoolClient) => Promise<Result>): Promise<Result> {
    return this.database.withSystemTransaction(request.correlationId, async (client) => {
      // withSystemTransaction starts as system:auth; patient_self_session
      // requires the verified patient subject as the actor.
      await client.query("select set_config('app.actor_subject', $1, true)", [actor.subject]);
      return operation(client);
    });
  }
}

/** An https URL of at most 2048 characters whose WHATWG serialization is the string (R3; no allowlist). */
function wellFormedHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.href === value && url.protocol === 'https:';
  } catch {
    return false;
  }
}

function subscriptionInvalid(): DomainProblem {
  return new DomainProblem(400, 'WEB_PUSH_SUBSCRIPTION_INVALID', 'This browser\'s notification subscription is not valid');
}

/** Database errors: 42501 -> 403, 22023 -> 400, anything else 503; never the driver's message. */
export function translate(error: unknown): unknown {
  if (error instanceof HttpException) return error;
  if (!isDatabaseError(error)) return webPushUnavailable();
  if (error.code === '42501') return new DomainProblem(403, 'PATIENT_SESSION_REQUIRED', 'An active patient session is required');
  if (error.code === '22023') return subscriptionInvalid();
  return webPushUnavailable();
}
