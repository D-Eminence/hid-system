import { readFile } from 'node:fs/promises';
import { Injectable, Logger } from '@nestjs/common';
import { getEnvironment } from '../config/environment';
import { IntegrationRuntimeService } from '../integrations/integration-runtime.service';
import { WEB_PUSH_DELIVERY_TIMEOUT_MS } from '../web-push/web-push-endpoint';
import type { RecoveryOtpPurpose } from './dto/otp.dto';

export type OtpDeliveryOutcome = 'accepted' | 'definitive_failure' | 'unknown';

/** One web push send's result (B6, N1): what the dispatcher records with identity.record_web_push_outcome. */
export interface WebPushDeliveryResult {
  outcome: 'accepted' | 'gone' | 'retry' | 'rejected';
  retryAfterSeconds?: number;
  safeCode?: string;
}

type WorkloadCredential = { readonly headers: Record<string, string> }
  | { readonly unavailable: 'missing' | 'invalid' | 'expired' };

/** The OTP call's timeout. An emergency-contact alert uses EMERGENCY_CONTACT_ALERT_TIMEOUT_MS. */
const OTP_TIMEOUT_MS = 5_000;

/**
 * True only for a JWT whose payload carries an `exp` that has passed. The
 * token is not verified here; Notification verifies it. Anything that does not
 * parse is left for Notification to refuse.
 */
function workloadTokenExpired(token: string, now: number): boolean {
  const parts = token.split('.');
  const payload = parts[1];
  if (parts.length !== 3 || payload === undefined) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown } | null;
    return typeof claims?.exp === 'number' && Number.isFinite(claims.exp) && claims.exp * 1000 <= now;
  } catch {
    return false;
  }
}

@Injectable()
export class NotificationOtpClient {
  private readonly environment = getEnvironment();
  private readonly logger = new Logger(NotificationOtpClient.name);
  private unavailableTokens = 0;

  /**
   * Deliveries this process refused because the workload token file was
   * missing, unusable or expired in JWT mode. Each one is also logged, without any
   * recipient, code or token, as `notification_workload_token_unavailable`.
   */
  get workloadTokenUnavailableCount(): number {
    return this.unavailableTokens;
  }

  constructor(private readonly integrations: IntegrationRuntimeService) {}

  async deliver(input: {
    challengeId: string;
    recipient: string;
    code: string;
    purpose: RecoveryOtpPurpose | 'SIGNUP_VERIFY' | 'EMAIL_VERIFY' | 'EMERGENCY_CONTACT_VERIFY';
    channel?: 'email' | 'sms';
    correlationId: string;
  }): Promise<{ outcome: OtpDeliveryOutcome; provider?: string }> {
    // A missing runtime policy must not disclose account existence: OTP start
    // keeps its generic response, records a failed delivery, and sends nothing.
    const channel = input.channel ?? 'email';
    const plan = await this.integrations.deliveryPlan(channel).catch(() => null);
    if (!plan) return { outcome: 'definitive_failure' };
    return this.post('otp', `otp:${input.challengeId}`, input.correlationId, {
      channel, recipient: input.recipient, code: input.code, purpose: input.purpose,
      plan,
    }, OTP_TIMEOUT_MS);
  }

  /**
   * Emergency-access alert to a verified emergency contact. The body is the
   * owner's fixed field set (full name, the last four characters of the Health
   * ID, clinician, facility and its phone, time) and never the break-glass
   * reason; notification-api renders the message, with its support fallback
   * when the facility has no phone, and applies the existing delivery plan.
   */
  async deliverEmergencyContactAlert(input: {
    notificationId: string;
    channel: 'email' | 'sms';
    recipient: string;
    patientFullName: string;
    patientHidSuffix: string;
    clinicianName: string | null;
    facilityName: string | null;
    facilityPhone: string | null;
    occurredAt: Date;
    correlationId: string;
  }): Promise<{ outcome: OtpDeliveryOutcome; provider?: string; safeCode?: string }> {
    const plan = await this.integrations.deliveryPlan(input.channel).catch(() => null);
    if (!plan) return { outcome: 'unknown', safeCode: 'delivery_policy_unavailable' };
    return this.post('emergency-contact-alert', `emergency-contact:${input.notificationId}`, input.correlationId, {
      channel: input.channel, recipient: input.recipient, patientFullName: input.patientFullName,
      patientHidSuffix: input.patientHidSuffix, clinicianName: input.clinicianName,
      facilityName: input.facilityName, facilityPhone: input.facilityPhone,
      occurredAt: input.occurredAt.toISOString(), plan,
    }, this.environment.EMERGENCY_CONTACT_ALERT_TIMEOUT_MS);
  }

  /**
   * A facility staff invitation email (P4b, SPEC 4.6 and 6.2). notification-api
   * renders it from fixed fields: no person's name and no free text; the
   * facility's name only when Identity found it safe (otherwise omitted, and
   * the email says "a facility"). Keyed by the send, so a retry of the same
   * send is not delivered twice. Without a delivery plan nothing is sent
   * (definitive_failure); without a workload token the outcome is unknown,
   * so the invitation stays pending and can be resent.
   */
  async deliverStaffInvitation(input: {
    sendId: string;
    invitationId: string;
    recipient: string;
    facilityName?: string;
    roleCode: string;
    token: string;
    code: string;
    expiresAt: Date;
    correlationId: string;
  }): Promise<{ outcome: OtpDeliveryOutcome; provider?: string; safeCode?: string }> {
    const plan = await this.integrations.deliveryPlan('email').catch(() => null);
    if (!plan) return { outcome: 'definitive_failure', safeCode: 'delivery_policy_unavailable' };
    return this.post('staff-invitation', `staff-invitation:${input.sendId}`, input.correlationId, {
      channel: 'email', recipient: input.recipient,
      ...(input.facilityName ? { facilityName: input.facilityName } : {}),
      roleCode: input.roleCode, invitationId: input.invitationId, token: input.token, code: input.code,
      expiresAt: input.expiresAt.toISOString(), plan,
    }, OTP_TIMEOUT_MS);
  }

  /**
   * The welcome email of a first activation, "Your Health ID is ready" (owner
   * decision of 2026-10-28, hid-1.0's design): to the verified email, with the
   * patient's first name when it has one and the Health ID. notification-api
   * renders it from these fixed fields only. Keyed by the patient, so a retry
   * is not delivered twice. Best-effort: the caller never waits for it.
   */
  async deliverPatientWelcome(input: {
    patientId: string;
    recipient: string;
    firstName?: string;
    healthId: string;
    correlationId: string;
  }): Promise<{ outcome: OtpDeliveryOutcome; provider?: string; safeCode?: string }> {
    const plan = await this.integrations.deliveryPlan('email').catch(() => null);
    if (!plan) return { outcome: 'definitive_failure', safeCode: 'delivery_policy_unavailable' };
    return this.post('patient-welcome', `patient-welcome:${input.patientId}`, input.correlationId, {
      channel: 'email', recipient: input.recipient,
      ...(input.firstName ? { firstName: input.firstName } : {}),
      healthId: input.healthId, plan,
    }, OTP_TIMEOUT_MS);
  }

  /**
   * A patient's password reset code in hid-1.0's design: greets them by first
   * name and names their Health ID. An older notification-api, which does not
   * serve this route yet, answers 404 having sent nothing; the code then goes
   * once through the generic OTP route, under the same idempotency key, so a
   * release that updates identity-api first never stops password resets. Any
   * other answer (accepted, a refusal, 5xx, a timeout) is final: never sent
   * twice.
   */
  async deliverPasswordResetCode(input: {
    challengeId: string;
    recipient: string;
    code: string;
    firstName?: string;
    healthId: string;
    expiresInMinutes: number;
    correlationId: string;
  }): Promise<{ outcome: OtpDeliveryOutcome; provider?: string; safeCode?: string }> {
    const plan = await this.integrations.deliveryPlan('email').catch(() => null);
    if (!plan) return { outcome: 'definitive_failure' };
    const delivered = await this.post('password-reset-code', `otp:${input.challengeId}`, input.correlationId, {
      channel: 'email', recipient: input.recipient, code: input.code,
      ...(input.firstName ? { firstName: input.firstName } : {}),
      healthId: input.healthId, expiresInMinutes: input.expiresInMinutes, plan,
    }, OTP_TIMEOUT_MS);
    if (delivered.safeCode !== 'http_404') return delivered;
    return this.post('otp', `otp:${input.challengeId}`, input.correlationId, {
      channel: 'email', recipient: input.recipient, code: input.code, purpose: 'PASSWORD_RESET', plan,
    }, OTP_TIMEOUT_MS);
  }

  /**
   * "Your Health ID password was updated", after a completed password reset
   * (owner decision of 2026-10-28, hid-1.0's design): to the account's email,
   * with the patient's first name and Health ID when the account is a patient
   * the reset could read, otherwise without them. Keyed by the reset
   * challenge. Best-effort: the reset never waits for it.
   */
  async deliverPasswordUpdated(input: {
    challengeId: string;
    recipient: string;
    firstName?: string;
    healthId?: string;
    correlationId: string;
  }): Promise<{ outcome: OtpDeliveryOutcome; provider?: string; safeCode?: string }> {
    const plan = await this.integrations.deliveryPlan('email').catch(() => null);
    if (!plan) return { outcome: 'definitive_failure', safeCode: 'delivery_policy_unavailable' };
    return this.post('password-updated', `password-updated:${input.challengeId}`, input.correlationId, {
      channel: 'email', recipient: input.recipient,
      ...(input.firstName ? { firstName: input.firstName } : {}),
      ...(input.healthId ? { healthId: input.healthId } : {}), plan,
    }, OTP_TIMEOUT_MS);
  }

  /**
   * The code that confirms a patient's new email address (0094), in
   * hid-1.0's design: to the NEW address, which is not yet proved to be the
   * patient's, so it names neither the patient nor their Health ID. An older
   * notification-api, which does not serve this route, answers 404 having
   * sent nothing; the code then goes once through the generic OTP route
   * (EMAIL_VERIFY), under the same idempotency key, as the password reset
   * code does. Any other answer is final.
   */
  async deliverEmailChangeCode(input: {
    changeId: string;
    recipient: string;
    code: string;
    expiresInMinutes: number;
    correlationId: string;
  }): Promise<{ outcome: OtpDeliveryOutcome; provider?: string; safeCode?: string }> {
    const plan = await this.integrations.deliveryPlan('email').catch(() => null);
    if (!plan) return { outcome: 'definitive_failure', safeCode: 'delivery_policy_unavailable' };
    const delivered = await this.post('email-change-code', `contact-change:${input.changeId}`, input.correlationId, {
      channel: 'email', recipient: input.recipient, code: input.code, expiresInMinutes: input.expiresInMinutes, plan,
    }, OTP_TIMEOUT_MS);
    if (delivered.safeCode !== 'http_404') return delivered;
    return this.post('otp', `contact-change:${input.changeId}`, input.correlationId, {
      channel: 'email', recipient: input.recipient, code: input.code, purpose: 'EMAIL_VERIFY', plan,
    }, OTP_TIMEOUT_MS);
  }

  /**
   * "Your Health ID email was changed" (to the previous address) or "Your
   * Health ID phone number was changed" (to the verified email), 0094: the
   * patient's first name and Health ID when known and the new contact masked
   * (never in full). Keyed by the change. Best-effort: the change never
   * waits for it; an older notification-api answers 404 and nothing is sent.
   */
  async deliverContactChanged(input: {
    changeId: string;
    recipient: string;
    kind: 'email' | 'phone';
    newContactHint: string;
    firstName?: string;
    healthId?: string;
    correlationId: string;
  }): Promise<{ outcome: OtpDeliveryOutcome; provider?: string; safeCode?: string }> {
    const plan = await this.integrations.deliveryPlan('email').catch(() => null);
    if (!plan) return { outcome: 'definitive_failure', safeCode: 'delivery_policy_unavailable' };
    return this.post('contact-changed', `contact-changed:${input.changeId}`, input.correlationId, {
      channel: 'email', recipient: input.recipient, kind: input.kind, newContactHint: input.newContactHint,
      ...(input.firstName ? { firstName: input.firstName } : {}),
      ...(input.healthId ? { healthId: input.healthId } : {}), plan,
    }, OTP_TIMEOUT_MS);
  }

  /**
   * E1 (0095): a patient's invitation to share, to the address the patient
   * typed: the reference, level, duration and end only; never the patient,
   * their Health ID or the invitee's name. Keyed by the invitation. Without a
   * delivery plan nothing is sent (definitive_failure); an older
   * notification-api answers 404, a definitive non-send.
   */
  async deliverPatientShareInvitation(input: {
    invitationId: string;
    recipient: string;
    reference: string;
    level: 'view_only' | 'clinical_review' | 'clinical_collaboration';
    duration: '24h' | '7d' | '30d' | 'until_revoked';
    expiresAt: Date;
    correlationId: string;
  }): Promise<{ outcome: OtpDeliveryOutcome; provider?: string; safeCode?: string }> {
    const plan = await this.integrations.deliveryPlan('email').catch(() => null);
    if (!plan) return { outcome: 'definitive_failure', safeCode: 'delivery_policy_unavailable' };
    return this.post('patient-share-invitation', `patient-share-invitation:${input.invitationId}`, input.correlationId, {
      channel: 'email', recipient: input.recipient, reference: input.reference, level: input.level,
      duration: input.duration, expiresAt: input.expiresAt.toISOString(), plan,
    }, OTP_TIMEOUT_MS);
  }

  /**
   * E2 (0095): to the clinician a patient shared with, at their verified
   * sign-in email: the facility's name when Identity found it safe, nothing
   * about the patient. Keyed by the grant; best-effort.
   */
  async deliverShareReceived(input: {
    consentGrantId: string;
    recipient: string;
    facilityName?: string;
    correlationId: string;
  }): Promise<{ outcome: OtpDeliveryOutcome; provider?: string; safeCode?: string }> {
    const plan = await this.integrations.deliveryPlan('email').catch(() => null);
    if (!plan) return { outcome: 'definitive_failure', safeCode: 'delivery_policy_unavailable' };
    return this.post('share-received', `share-received:${input.consentGrantId}`, input.correlationId, {
      channel: 'email', recipient: input.recipient,
      ...(input.facilityName ? { facilityName: input.facilityName } : {}), plan,
    }, OTP_TIMEOUT_MS);
  }

  /**
   * E3 (0095): "Your Health ID records were opened", to the patient's
   * verified email: the time only, never the facility. Keyed by the notice;
   * the dispatcher retries an unknown outcome.
   */
  async deliverRecordAccessAlert(input: {
    noticeId: string;
    recipient: string;
    occurredAt: Date;
    correlationId: string;
  }): Promise<{ outcome: OtpDeliveryOutcome; provider?: string; safeCode?: string }> {
    const plan = await this.integrations.deliveryPlan('email').catch(() => null);
    if (!plan) return { outcome: 'unknown', safeCode: 'delivery_policy_unavailable' };
    return this.post('record-access-alert', `record-access-alert:${input.noticeId}`, input.correlationId, {
      channel: 'email', recipient: input.recipient, occurredAt: input.occurredAt.toISOString(), plan,
    }, OTP_TIMEOUT_MS);
  }

  /**
   * E4 (0096): "Your Health ID account is scheduled for deletion" (with the
   * date), "... deletion was cancelled" or "... account was deleted", to the
   * account's verified email: the kind and the date only, never a name, a
   * Health ID or a record. Keyed account-deletion:<requestId>:<kind>; the
   * dispatcher retries an unknown outcome. An older notification-api answers
   * 404, a definitive non-send.
   */
  async deliverAccountDeletionNotice(input: {
    requestId: string;
    recipient: string;
    kind: 'scheduled' | 'cancelled' | 'completed';
    scheduledFor?: Date;
    correlationId: string;
  }): Promise<{ outcome: OtpDeliveryOutcome; provider?: string; safeCode?: string }> {
    if (input.kind === 'scheduled' && !input.scheduledFor) {
      return { outcome: 'definitive_failure', safeCode: 'scheduled_for_missing' };
    }
    const plan = await this.integrations.deliveryPlan('email').catch(() => null);
    if (!plan) return { outcome: 'unknown', safeCode: 'delivery_policy_unavailable' };
    return this.post('account-deletion', `account-deletion:${input.requestId}:${input.kind}`, input.correlationId, {
      channel: 'email', recipient: input.recipient, kind: input.kind,
      ...(input.kind === 'scheduled' && input.scheduledFor ? { scheduledFor: input.scheduledFor.toISOString() } : {}),
      plan,
    }, OTP_TIMEOUT_MS);
  }

  /**
   * N1 (B6, 0097): ask notification-api to send one empty web push (it signs
   * the VAPID token; Identity never holds the private key). Keyed
   * web-push:<subscriptionId>:<claimedThrough epoch ms>, the round. No
   * delivery plan. Its own mapping, not post()'s: only `gone` (404/410 from
   * the push service itself) ever removes a subscription; a 404 from
   * notification-api (push not configured there, or an image before B6) is
   * retried; 400/422 are refusals of this request; everything else retries.
   */
  async deliverWebPush(input: {
    subscriptionId: string;
    endpoint: string;
    vapidKeyId: string;
    claimedThrough: Date;
    correlationId: string;
  }): Promise<WebPushDeliveryResult> {
    const credential = await this.credentials();
    if ('unavailable' in credential) {
      this.unavailableTokens += 1;
      this.logger.warn(`Notification workload token unavailable; nothing was sent `
        + `(event=notification_workload_token_unavailable reason=${credential.unavailable} count=${this.unavailableTokens})`);
      return { outcome: 'retry', safeCode: 'workload_token_unavailable' };
    }
    let response: Response;
    try {
      response = await fetch(`${this.environment.NOTIFICATION_API_URL.replace(/\/+$/, '')}/api/v1/notifications/web-push`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `web-push:${input.subscriptionId}:${input.claimedThrough.getTime()}`,
          'x-correlation-id': input.correlationId,
          'x-hid-internal-caller': 'identity-api',
          ...credential.headers,
        },
        body: JSON.stringify({ endpoint: input.endpoint, vapidKeyId: input.vapidKeyId }),
        signal: AbortSignal.timeout(WEB_PUSH_DELIVERY_TIMEOUT_MS),
      });
    } catch {
      return { outcome: 'retry', safeCode: 'transport_error' };
    }
    const status = response.status;
    if (status === 202) {
      try {
        const body = await response.json() as { outcome?: unknown; retryAfterSeconds?: unknown; safeCode?: unknown };
        if (!['accepted', 'gone', 'retry', 'rejected'].includes(String(body.outcome))) {
          return { outcome: 'retry', safeCode: 'bad_response' };
        }
        const retryAfter = typeof body.retryAfterSeconds === 'number' && Number.isFinite(body.retryAfterSeconds)
          ? Math.min(3600, Math.max(1, Math.round(body.retryAfterSeconds))) : undefined;
        const safeCode = typeof body.safeCode === 'string' && /^[a-z][a-z0-9_]{1,63}$/.test(body.safeCode)
          ? body.safeCode : undefined;
        return { outcome: body.outcome as WebPushDeliveryResult['outcome'],
          ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
          ...(safeCode ? { safeCode } : {}) };
      } catch {
        return { outcome: 'retry', safeCode: 'bad_response' };
      }
    }
    if (status >= 200 && status < 300) return { outcome: 'retry', safeCode: 'bad_response' };
    if (status === 404) return { outcome: 'retry', safeCode: 'notification_404' };
    if (status === 409) return { outcome: 'retry', safeCode: 'key_mismatch' };
    if (status === 400 || status === 422) return { outcome: 'rejected', safeCode: `http_${status}` };
    return { outcome: 'retry', safeCode: `http_${status}` };
  }

  private async post(path: 'otp' | 'emergency-contact-alert' | 'staff-invitation' | 'patient-welcome'
    | 'password-reset-code' | 'password-updated' | 'email-change-code' | 'contact-changed'
    | 'patient-share-invitation' | 'share-received' | 'record-access-alert' | 'account-deletion',
    idempotencyKey: string, correlationId: string,
    body: Record<string, unknown>, timeoutMs: number,
  ): Promise<{ outcome: OtpDeliveryOutcome; provider?: string; safeCode?: string }> {
    const credential = await this.credentials();
    if ('unavailable' in credential) {
      // Without a token Notification can only refuse the call, so nothing is
      // sent. An OTP is reported as not delivered (the caller answers 503 or
      // records the failure); an emergency-contact alert stays retryable,
      // because the agent restores the token once the issuer is reachable.
      this.unavailableTokens += 1;
      this.logger.warn(`Notification workload token unavailable; nothing was sent `
        + `(event=notification_workload_token_unavailable reason=${credential.unavailable} count=${this.unavailableTokens})`);
      return { outcome: path === 'otp' || path === 'password-reset-code' || path === 'email-change-code'
        ? 'definitive_failure' : 'unknown',
        safeCode: 'workload_token_unavailable' };
    }
    let response: Response;
    try {
      response = await fetch(`${this.environment.NOTIFICATION_API_URL.replace(/\/+$/, '')}/api/v1/notifications/${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
          'x-correlation-id': correlationId,
          'x-hid-internal-caller': 'identity-api',
          ...credential.headers,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { outcome: 'unknown', safeCode: 'transport_error' };
    }
    if (!response.ok) {
      // Notification also answers 401 when it cannot fetch its verification
      // keys. A missing or expired token is never sent (credentials below), so
      // an alert stays retryable and ends as attempts_exhausted if the refusal
      // lasts; a code keeps the definitive mapping.
      // A staff invitation likewise: a 401 is Notification's own key fetch, not
      // the address, so it must not count towards the facility's delivery pause.
      if (path !== 'otp' && path !== 'password-reset-code' && path !== 'email-change-code' && response.status === 401) {
        return { outcome: 'unknown', safeCode: 'http_401' };
      }
      return { outcome: response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
        ? 'definitive_failure' : 'unknown', safeCode: `http_${response.status}` };
    }
    try {
      const body = await response.json() as { outcome?: unknown; primary?: { provider?: unknown }; fallback?: { provider?: unknown } };
      if (!['accepted', 'definitive_failure', 'unknown'].includes(String(body.outcome))) return { outcome: 'unknown' };
      const provider = body.fallback?.provider ?? body.primary?.provider;
      return {
        outcome: body.outcome as OtpDeliveryOutcome,
        ...(typeof provider === 'string' && /^[a-z][a-z0-9_-]{1,63}$/.test(provider) ? { provider } : {}),
      };
    } catch {
      return { outcome: 'unknown' };
    }
  }

  private async credentials(): Promise<WorkloadCredential> {
    if (this.environment.NOTIFICATION_SERVICE_IDENTITY_MODE === 'local-secret') {
      return { headers: this.environment.NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN
        ? { 'x-hid-service-token': this.environment.NOTIFICATION_IDENTITY_INTERNAL_SERVICE_TOKEN }
        : {} };
    }
    // JWT mode: configuration validation requires the path; the agent writes
    // the file and removes it shortly before the token expires.
    const path = this.environment.NOTIFICATION_IDENTITY_WORKLOAD_TOKEN_FILE;
    const token = path ? await readFile(path, 'utf8').catch(() => undefined) : undefined;
    if (token === undefined) return { unavailable: 'missing' };
    const value = token.trim();
    if (!value || value.length > 16_384 || /\s/.test(value)) return { unavailable: 'invalid' };
    // A file stays if the agent stops and ECS does not restart it. Notification
    // would refuse the expired token 401; treat it as no token instead, so
    // nothing is sent and the refusal is counted.
    if (workloadTokenExpired(value, Date.now())) return { unavailable: 'expired' };
    return { headers: { 'x-hid-service-authorization': `Bearer ${value}` } };
  }
}
