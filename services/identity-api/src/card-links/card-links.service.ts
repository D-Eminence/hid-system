import { randomUUID } from 'node:crypto';
import { type BeforeApplicationShutdown, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { NotificationOtpClient } from '../auth/notification-otp.client';
import { requirePatient } from '../auth/patient-self.service';
import { requireNoRecentRecoveryHold, requireRecentPatientAuthentication } from '../auth/recent-authentication';
import { TurnstileService } from '../auth/turnstile.service';
import { AFTER_RESPONSE_SHUTDOWN_GRACE_MS, AfterResponseTasks } from '../common/after-response-tasks';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { HidRequest } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { databaseMessage, isDatabaseError } from '../patient-safety/database-error';
import type { CardShareDuration, CardShareScope, CreateCardShareDto, RequestCardCodeDto, VerifyCardCodeDto }
  from './card-links.dto';
import { cardLinksEnabled } from './card-links.flag';
import { CardLinksProtector, cardLinksUnavailable, cardRecipientHint, isLinkToken, normalizeCardEmail, sha256Hex }
  from './card-links.protector';

/** What the patient was shown on the check step (the consent record, critique 19). */
export const CARD_SHARE_CONSENT_VERSION = 'card-share-v1';
export const CARD_SHARE_DAILY_LIMIT = 5;
export const CARD_SHARE_LIVE_LIMIT = 20;
const VIEW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A cookie secret as the browser sends it back (ours are 43 base64url characters). */
const VIEW_SECRET = /^[A-Za-z0-9_-]{1,128}$/;
const STOP_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/;

/** The plain-English text every screen shows (the problem's `detail`). */
export const CARD_SHARE_DETAIL = {
  emailInvalid: 'Enter an email address like name@example.com.',
  ownEmail: 'That\'s your own email address. To see your card, open it in Health ID.',
  recentAuth: 'For your security, sign out, sign in again, and send it within 10 minutes.',
  keyReused: 'Something changed while sending. Check your shared links before trying again.',
  liveLimit: 'You have 20 card links open. End one to send another.',
  createLimited: 'You\'ve sent 5 card links today. Try again tomorrow.',
  addressLimited: 'You\'ve sent your card to this address twice today. Try again tomorrow.',
  notFound: 'We couldn\'t find that link. It may have ended already.',
  sessionRequired: 'An active patient session is required',
  linkInvalid: 'This link isn\'t complete. Open it again from your email.',
  ended: 'This card is no longer shared.',
  viewEnded: 'This card is no longer shared with you.',
  codeFormat: 'Enter the 6-digit code from the email.',
  codeExpired: 'That code has stopped working. Ask for a new one.',
  codeLimited: 'Too many codes asked for. Try again later.',
} as const;

/** One link as the patient's list shows it. */
export interface CardShareView {
  id: string;
  reference: string;
  scope: CardShareScope;
  recipientEmail: string | null;
  label: string | null;
  recipientHint: string | null;
  duration: CardShareDuration;
  createdAt: unknown;
  expiresAt: unknown;
  status: 'active' | 'locked' | 'ended' | 'expired';
  endedAt: unknown;
  endedReason: string | null;
  lockedUntil: unknown;
  delivery: 'sent' | 'not_sent' | 'pending';
  openCount: number;
  lastOpenedAt: unknown;
}

type StoredItem = Omit<CardShareView, 'recipientEmail' | 'label'> & {
  recipientCiphertext: string | null; recipientKeyVersion: string | null };

interface CreatedRow {
  outcome: 'created' | 'replayed'; share_id: string; reference: string; created_at: Date; expires_at: Date;
  replaced_share_id: string | null; send_email: boolean; address_cap_reached: boolean;
}

interface CardRow {
  viewId: string; viewExpiresAt: string; fullName: string | null; healthId: string; ninVerified: boolean;
  sharedByFirstName: string | null; recipientHint: string | null; reference: string; scope: CardShareScope;
  expiresAt: string;
}

/**
 * Card links (0118, Akos handover step 8): a patient sends their card to any
 * email address; the person it went to opens it with a one-time code sent to
 * the same address, in the browser that asked for it, for one 30-minute view.
 * The patient's commands run bound to their session (identity.*_my_card_*);
 * the receiver's in the system context (identity.issue_card_share_code and
 * the rest). Off (404) while CARD_LINKS_ENABLED=false. Nothing here logs or audits
 * an address, label, token or code; the database audits every step with ids
 * and counts.
 */
@Injectable()
export class CardLinksService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(CardLinksService.name);
  private readonly emails = new AfterResponseTasks(this.logger, 'Card link code email could not be sent');

  constructor(private readonly database: DatabaseService, private readonly notification: NotificationOtpClient,
    private readonly protector: CardLinksProtector, private readonly audit: AuditService,
    private readonly turnstile: TurnstileService) {}

  /** Waits for the code emails started so far (tests). */
  settleEmails(): Promise<void> {
    return this.emails.settle();
  }

  beforeApplicationShutdown(): Promise<void> {
    return this.emails.settle(AFTER_RESPONSE_SHUTDOWN_GRACE_MS);
  }

  assertServed(): void {
    if (!cardLinksEnabled()) throw new NotFoundException();
  }

  // ----- The patient -----

  async list(request: HidRequest) {
    this.assertServed();
    const actor = requirePatient(request.actor);
    let listed: { items?: StoredItem[]; createdToday?: number; liveCount?: number } | null | undefined;
    try {
      listed = await this.asPatient(request, actor, async (client) => (await client.query<{ listed: typeof listed }>(
        'select identity.list_my_card_shares($1, $2) as listed', [actor.subject, actor.sessionId])).rows[0]?.listed);
    } catch (error) {
      throw this.problem(error);
    }
    if (!listed || !Array.isArray(listed.items)) {
      throw new DomainProblem(403, 'PATIENT_ACCESS_DENIED', 'Patient access is unavailable');
    }
    return { items: listed.items.map((item) => this.shown(item)), createdToday: Number(listed.createdToday ?? 0),
      dailyLimit: CARD_SHARE_DAILY_LIMIT, liveCount: Number(listed.liveCount ?? 0), liveLimit: CARD_SHARE_LIVE_LIMIT };
  }

  /** 201 a new link (the email sent before answering), 200 a replay of the same Idempotency-Key and body. */
  async create(request: HidRequest, input: CreateCardShareDto, idempotencyKey: string) {
    this.assertServed();
    const actor = requirePatient(request.actor);
    const email = normalizeCardEmail(input.email);
    if (!email) throw new DomainProblem(400, 'CARD_SHARE_EMAIL_INVALID', CARD_SHARE_DETAIL.emailInvalid);
    const label = input.label?.trim() || null;
    const body = { email, label, scope: input.scope, duration: input.duration };
    const shareId = randomUUID();
    const token = this.protector.newLinkToken();
    const tokenHmac = this.protector.tokenHmac(token);
    const hint = cardRecipientHint(email);
    let row: CreatedRow | undefined;
    try {
      row = await this.asPatient(request, actor, async (client) => {
        await requireNoRecentRecoveryHold(client, actor.accountId, 'new card links');
        await requireRecentPatientAuthentication(client, actor, CARD_SHARE_DETAIL.recentAuth);
        const own = (await client.query<{ email: string | null }>(
          'select email from identity.current_patient_account($1)', [actor.subject])).rows[0]?.email;
        if (own && own.trim().toLowerCase() === email) {
          throw new DomainProblem(400, 'CARD_SHARE_OWN_EMAIL', CARD_SHARE_DETAIL.ownEmail);
        }
        return (await client.query<CreatedRow>(
          `select outcome, share_id::text, reference, created_at, expires_at, replaced_share_id::text, send_email,
             address_cap_reached
           from identity.create_my_card_share($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [actor.subject, actor.sessionId, shareId, this.protector.recipientHmac(email), hint,
            this.protector.encrypt(shareId, { email, label }), this.protector.keyVersion, tokenHmac, input.scope,
            input.duration, CARD_SHARE_CONSENT_VERSION, idempotencyKey,
            requestDigest('identity.card-share.create', body)])).rows[0];
      });
    } catch (error) {
      if (isDatabaseError(error) && (error.code === 'P0001' || databaseMessage(error) === 'CARD_SHARE_LIVE_LIMIT')) {
        await this.audit.record({ correlationId: request.correlationId, actorType: 'patient', actorSubject: actor.subject,
          actorAccountId: actor.accountId, patientId: actor.patientId, action: 'identity.card-share.create',
          resourceType: 'card-share', outcome: 'denied', purposeOfUse: 'patient-self',
          details: { reason: databaseMessage(error).toLowerCase() } }).catch(() => undefined);
      }
      throw this.problem(error, {
        P0001: (message) => message === 'CARD_SHARE_ADDRESS_LIMITED'
          ? new DomainProblem(429, 'CARD_SHARE_ADDRESS_LIMITED', CARD_SHARE_DETAIL.addressLimited)
          : new DomainProblem(429, 'CARD_SHARE_CREATE_LIMITED', CARD_SHARE_DETAIL.createLimited),
        '55000': (message) => message === 'CARD_SHARE_LIVE_LIMIT'
          ? new DomainProblem(409, 'CARD_SHARE_LIVE_LIMIT', CARD_SHARE_DETAIL.liveLimit) : undefined,
      });
    }
    if (!row) throw cardLinksUnavailable();
    if (row.outcome === 'replayed') {
      const stored = (await this.list(request).catch(() => undefined))?.items.find((item) => item.id === row!.share_id);
      return { share: stored ?? this.fresh(row, body, hint, 'pending'), delivery: stored?.delivery ?? 'pending',
        replacedId: row.replaced_share_id, replayed: true };
    }
    if (row.address_cap_reached) {
      this.logger.warn(`Card link address past its daily email limit across patients; not emailed `
        + `(event=card_share_address_cap correlation=${request.correlationId})`);
    }
    let delivery: 'sent' | 'not_sent' = 'not_sent';
    if (row.send_email) {
      const sent = await this.notification.deliverCardShareLink({ shareId: row.share_id, recipient: email, token,
        reference: row.reference, expiresAt: new Date(row.expires_at), stopToken: this.protector.stopToken(row.share_id),
        correlationId: request.correlationId }).catch(() => ({ outcome: 'unknown' as const, safeCode: 'transport_error' }));
      delivery = sent.outcome === 'accepted' ? 'sent' : 'not_sent';
      try {
        await this.asPatient(request, actor, (client) => client.query(
          'select identity.record_my_card_share_delivery($1, $2, $3, $4, $5, $6)',
          [actor.subject, actor.sessionId, row!.share_id, sent.outcome,
            'provider' in sent && sent.provider ? sent.provider : null, sent.safeCode ?? null]));
      } catch (error) {
        this.logger.warn(`Card link delivery outcome not recorded (correlation ${request.correlationId}, `
          + `code ${isDatabaseError(error) ? error.code : 'unknown'})`);
      }
    }
    return { share: this.fresh(row, body, hint, delivery), delivery, replacedId: row.replaced_share_id, replayed: false };
  }

  /** Ends a link at once; ending one already ended answers it as it is. */
  async end(request: HidRequest, shareId: string) {
    this.assertServed();
    const actor = requirePatient(request.actor);
    try {
      const row = await this.asPatient(request, actor, async (client) => (await client.query<{ outcome: string;
        item: StoredItem }>('select outcome, item from identity.end_my_card_share($1, $2, $3)',
        [actor.subject, actor.sessionId, shareId])).rows[0]);
      if (!row) throw cardLinksUnavailable();
      return { share: this.shown(row.item) };
    } catch (error) {
      throw this.problem(error, {
        P0002: () => new DomainProblem(404, 'CARD_SHARE_NOT_FOUND', CARD_SHARE_DETAIL.notFound),
      });
    }
  }

  // ----- The person the link went to -----

  /** "Email me a code". Answers the same 410 for an unknown, ended or expired link; the email goes after the answer. */
  async requestCode(request: HidRequest, input: RequestCardCodeDto) {
    this.assertServed();
    if (!isLinkToken(input.token)) throw linkInvalid();
    await this.turnstile.verify({ token: input.turnstileToken, action: 'card-share-code',
      origin: request.header('origin'), remoteIp: request.ip });
    const tokenHmac = this.protector.tokenHmac(input.token);
    const code = this.protector.newCode();
    const codeId = randomUUID();
    const pendingSecret = this.protector.newSecret();
    const row = await this.system(request, async (client) => (await client.query<{ outcome: string;
      retry_after_seconds: number | null; share_id: string | null; code_id: string | null;
      recipient_ciphertext: Buffer | null; recipient_key_version: string | null; recipient_hint: string | null;
      reference: string | null }>(
      `select outcome, retry_after_seconds, share_id::text, code_id::text, recipient_ciphertext, recipient_key_version,
         recipient_hint, reference
       from identity.issue_card_share_code($1, $2, $3, $4, $5, $6)`,
      [tokenHmac, codeId, this.protector.codeVerifier(tokenHmac, code), this.protector.keyVersion,
        sha256Hex(pendingSecret), this.protector.networkHmac(request.ip)])).rows[0]);
    if (!row || row.outcome === 'ended') throw ended();
    if (row.outcome === 'locked') throw locked(row.retry_after_seconds);
    if (row.outcome === 'limited') {
      throw new DomainProblem(429, 'CARD_SHARE_CODE_LIMITED', CARD_SHARE_DETAIL.codeLimited,
        undefined, { extensions: { retryAfterSeconds: Math.max(1, row.retry_after_seconds ?? 60) } });
    }
    if (row.outcome !== 'issued' || !row.share_id || !row.recipient_ciphertext || !row.recipient_key_version
      || !row.reference) {
      throw cardLinksUnavailable();
    }
    const recipient = this.protector.decrypt(row.share_id, row.recipient_key_version, row.recipient_ciphertext).email;
    const shareId = row.share_id;
    const issuedCodeId = row.code_id ?? codeId;
    const reference = row.reference;
    this.emails.run(request.correlationId, async () => {
      const sent = await this.notification.deliverCardShareCode({ codeId: issuedCodeId, recipient, code, reference,
        stopToken: this.protector.stopToken(shareId), correlationId: request.correlationId })
        .catch(() => ({ outcome: 'unknown' as const, safeCode: 'transport_error' }));
      await this.database.withSystemTransaction(request.correlationId, (client) => client.query(
        'select identity.record_card_share_code_delivery($1, $2)', [issuedCodeId, sent.outcome]));
      if (sent.outcome !== 'accepted') {
        this.logger.warn(`Card link code email was not accepted (correlation ${request.correlationId}, `
          + `outcome ${sent.outcome})`);
      }
    });
    return { body: { sentTo: row.recipient_hint, expiresInSeconds: 600, resendAfterSeconds: 60 }, pendingSecret, tokenHmac };
  }

  /** The link token's keyed HMAC (names the link's code cookie), or null for a malformed token. */
  linkTokenHmac(token: unknown): string | null {
    return isLinkToken(token) ? this.protector.tokenHmac(token) : null;
  }

  /** "Open the card": the code typed in the browser that asked for it (its pending cookie). */
  async verify(request: HidRequest, input: VerifyCardCodeDto, pendingSecret: string | undefined) {
    this.assertServed();
    if (!isLinkToken(input.token)) throw linkInvalid();
    if (!/^[0-9]{6}$/.test(input.code)) {
      throw new DomainProblem(400, 'CARD_SHARE_CODE_FORMAT', CARD_SHARE_DETAIL.codeFormat);
    }
    const tokenHmac = this.protector.tokenHmac(input.token);
    const viewId = randomUUID();
    const viewSecret = this.protector.newSecret();
    // No pending cookie: another browser. Its try is counted as wrong, as a wrong code is.
    const requester = sha256Hex(pendingSecret && VIEW_SECRET.test(pendingSecret) ? pendingSecret : this.protector.newSecret());
    const row = await this.system(request, async (client) => (await client.query<{ outcome: string;
      attempts_left: number | null; retry_after_seconds: number | null; card: CardRow | null; networks_today: number | null }>(
      `select outcome, attempts_left, retry_after_seconds, card, networks_today
       from identity.verify_card_share_code($1, $2, $3, $4, $5, $6)`,
      [tokenHmac, this.protector.codeVerifier(tokenHmac, input.code), requester, viewId, sha256Hex(viewSecret),
        this.protector.networkHmac(request.ip)])).rows[0]);
    switch (row?.outcome) {
      case 'opened':
        if (!row.card) throw cardLinksUnavailable();
        if ((row.networks_today ?? 0) > 3) {
          this.logger.warn(`Card link opened from more than 3 networks in 24 hours `
            + `(event=card_share_many_networks networks=${row.networks_today} correlation=${request.correlationId})`);
        }
        return { body: cardBody(row.card), viewId, viewSecret };
      case 'wrong': {
        const left = Math.max(0, row.attempts_left ?? 0);
        throw new DomainProblem(400, 'CARD_SHARE_CODE_WRONG',
          `That code isn't right. Check the email and try again. ${left} ${left === 1 ? 'try' : 'tries'} left.`,
          undefined, { extensions: { attemptsLeft: left } });
      }
      case 'code_expired':
        throw new DomainProblem(410, 'CARD_SHARE_CODE_EXPIRED', CARD_SHARE_DETAIL.codeExpired);
      case 'locked':
        throw locked(row.retry_after_seconds);
      case 'ended':
        throw ended();
      default:
        throw cardLinksUnavailable();
    }
  }

  /** The card again for a live view (the page checks every 30 seconds while the card is on screen). */
  async view(request: HidRequest, viewId: string | undefined) {
    this.assertServed();
    const secret = viewSecretOf(request, viewId);
    if (!secret) throw viewEnded();
    const row = await this.system(request, async (client) => (await client.query<{ outcome: string; card: CardRow | null }>(
      'select outcome, card from identity.card_share_view($1, $2)', [viewId, sha256Hex(secret)])).rows[0]);
    if (row?.outcome !== 'live' || !row.card) throw viewEnded();
    return cardBody(row.card);
  }

  /** "Close". Unknown or ended views answer the same. */
  async endView(request: HidRequest, viewId: string | undefined): Promise<void> {
    this.assertServed();
    const secret = viewSecretOf(request, viewId);
    if (!secret) return;
    await this.system(request, (client) => client.query('select identity.end_card_share_view($1, $2) as closed',
      [viewId, sha256Hex(secret)]));
  }

  /** "Stop these emails": the same 204 for any well-formed stop token; only a genuine one blocks the address. */
  async stop(request: HidRequest, stopToken: string): Promise<void> {
    this.assertServed();
    if (!STOP_TOKEN.test(stopToken)) throw linkInvalid();
    const shareId = this.protector.stopShareId(stopToken);
    if (!shareId) return;
    await this.system(request, (client) => client.query('select identity.stop_card_share_emails($1) as stopped', [shareId]));
  }

  private shown(item: StoredItem): CardShareView {
    let recipient: { email: string; label: string | null } | null = null;
    if (item.recipientCiphertext && item.recipientKeyVersion) {
      try {
        recipient = this.protector.decrypt(item.id, item.recipientKeyVersion, Buffer.from(item.recipientCiphertext, 'base64'));
      } catch {
        recipient = null;
      }
    }
    return { id: item.id, reference: item.reference, scope: item.scope, recipientEmail: recipient?.email ?? null,
      label: recipient?.label ?? null, recipientHint: item.recipientHint, duration: item.duration,
      createdAt: item.createdAt, expiresAt: item.expiresAt, status: item.status, endedAt: item.endedAt,
      endedReason: item.endedReason, lockedUntil: item.lockedUntil, delivery: item.delivery, openCount: item.openCount,
      lastOpenedAt: item.lastOpenedAt };
  }

  private fresh(row: CreatedRow, body: { email: string; label: string | null; scope: CardShareScope;
    duration: CardShareDuration }, hint: string, delivery: CardShareView['delivery']): CardShareView {
    // A link that was not emailed (a blocked or capped address) is ended at once as not_sent, its address
    // erased, and replaces nothing (0118, F6): nobody holds its token.
    const notSent = row.outcome === 'created' && !row.send_email;
    return { id: row.share_id, reference: row.reference, scope: body.scope,
      recipientEmail: notSent ? null : body.email, label: notSent ? null : body.label,
      recipientHint: hint, duration: body.duration, createdAt: new Date(row.created_at),
      expiresAt: new Date(row.expires_at), status: notSent ? 'ended' : 'active',
      endedAt: notSent ? new Date(row.created_at) : null, endedReason: notSent ? 'not_sent' : null, lockedUntil: null,
      delivery, openCount: 0, lastOpenedAt: null };
  }

  private asPatient<T>(request: HidRequest, actor: ReturnType<typeof requirePatient>,
    work: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.database.withSystemTransaction(request.correlationId, async (client) => {
      await client.query("select set_config('app.actor_subject',$1,true)", [actor.subject]);
      return work(client);
    });
  }

  private async system<T>(request: HidRequest, work: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.withSystemTransaction(request.correlationId, work);
    } catch (error) {
      if (error instanceof DomainProblem) throw error;
      throw cardLinksUnavailable();
    }
  }

  /** A patient command's database refusal: the given codes, then the shared ones; anything else 503. */
  private problem(error: unknown,
    mapped: Record<string, (message: string) => DomainProblem | undefined> = {}): unknown {
    if (error instanceof DomainProblem) return error;
    if (!isDatabaseError(error)) return cardLinksUnavailable();
    const message = databaseMessage(error);
    const special = mapped[error.code]?.(message);
    if (special) return special;
    if (error.code === '42501') return new DomainProblem(403, 'PATIENT_SESSION_REQUIRED', CARD_SHARE_DETAIL.sessionRequired);
    if (error.code === '55000' && message === 'IDEMPOTENCY_KEY_REUSED') {
      return new DomainProblem(409, 'IDEMPOTENCY_KEY_REUSED', CARD_SHARE_DETAIL.keyReused);
    }
    if (error.code === '22023' || error.code === '22P02') {
      return new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.');
    }
    return cardLinksUnavailable();
  }
}

/** The view's cookie secret: the cookie named for the view in X-Card-View, sent exactly once. */
function viewSecretOf(request: HidRequest, viewId: string | undefined): string | null {
  if (!viewId || !VIEW_ID.test(viewId)) return null;
  const name = `hid_cv_${viewId.replace(/-/g, '')}`;
  const values = (request.header('cookie') ?? '').split(';').map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`)).map((part) => part.slice(name.length + 1));
  return values.length === 1 && VIEW_SECRET.test(values[0]!) ? values[0]! : null;
}

/** The answer of verify and view: the card's identity half; the EHR answers the records. */
function cardBody(card: CardRow) {
  return { viewId: card.viewId, viewExpiresAt: card.viewExpiresAt,
    card: { fullName: card.fullName, healthId: card.healthId, ninVerified: card.ninVerified === true },
    sharedByFirstName: card.sharedByFirstName, recipientHint: card.recipientHint, reference: card.reference,
    scope: card.scope, expiresAt: card.expiresAt };
}

function linkInvalid(): DomainProblem {
  return new DomainProblem(400, 'CARD_SHARE_LINK_INVALID', CARD_SHARE_DETAIL.linkInvalid);
}

function ended(): DomainProblem {
  return new DomainProblem(410, 'CARD_SHARE_ENDED', CARD_SHARE_DETAIL.ended);
}

function viewEnded(): DomainProblem {
  return new DomainProblem(410, 'CARD_SHARE_VIEW_ENDED', CARD_SHARE_DETAIL.viewEnded);
}

function locked(seconds: number | null): DomainProblem {
  const retry = Math.max(1, seconds ?? 3600);
  const minutes = Math.ceil(retry / 60);
  return new DomainProblem(429, 'CARD_SHARE_LOCKED',
    `Too many wrong codes. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
    undefined, { extensions: { retryAfterSeconds: retry } });
}
