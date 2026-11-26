import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { billingProblem, classifyBillingError } from './commercial-errors';
import { CommercialService } from './commercial.service';

/**
 * Where a facility's own Paystack secret key comes from (BILL-14): AWS Secrets
 * Manager, one secret per facility, set by Health ID support; the database
 * holds no key. Release 1 ships no reader (online payment is switched off
 * everywhere): the default answers null, so a link or webhook answers 404
 * ONLINE_PAYMENT_NOT_AVAILABLE even with the switch on. The Secrets Manager
 * reader is the step before COMMERCIAL_ONLINE_PAYMENT_ENABLED is turned on.
 */
export interface PaystackSecretSource {
  secretFor(facilityId: string): Promise<string | null>;
}
export const PAYSTACK_SECRETS = Symbol('PAYSTACK_SECRETS');
export const noPaystackSecrets: PaystackSecretSource = { secretFor: async () => null };

/** The HTTP call to Paystack, replaceable in tests. */
export type PaystackFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string })
  => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export const PAYSTACK_FETCH = Symbol('PAYSTACK_FETCH');
const PAYSTACK = 'https://api.paystack.co';

/** HMAC-SHA512 of the body with the facility's secret, compared in constant time. */
export function paystackSignatureValid(body: string, signature: string | undefined, secret: string): boolean {
  if (!signature || !/^[0-9a-f]{128}$/i.test(signature)) return false;
  const expected = createHmac('sha512', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * BILL-14: paying a bill online through the facility's own Paystack account,
 * so Health ID never holds money. Only the amount, a bill reference and, if
 * given, an email are sent to Paystack: never the patient's name, Health ID
 * or the bill's lines. Built and switched off (COMMERCIAL_ONLINE_PAYMENT_ENABLED).
 */
@Injectable()
export class OnlinePaymentService {
  private readonly logger = new Logger(OnlinePaymentService.name);

  constructor(
    private readonly billing: CommercialService,
    private readonly database: DatabaseService,
    @Inject(PAYSTACK_SECRETS) private readonly secrets: PaystackSecretSource,
    @Inject(PAYSTACK_FETCH) private readonly http: PaystackFetch,
  ) {}

  async createLink(context: DataAccessContext, billId: string, body: Record<string, unknown>) {
    const amount = body.amountKobo;
    const email = body.email;
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1) {
      throw billingProblem('VALIDATION_FAILED', { field: 'amountKobo' });
    }
    if (email !== undefined && (typeof email !== 'string' || !/^[^@\s]{1,64}@[^@\s]{1,190}$/.test(email))) {
      throw billingProblem('VALIDATION_FAILED', { field: 'email' });
    }
    const bill = await this.billing.run<{ dueKobo: number; number: string }>(context, {
      action: 'commercial.online-payment.link', code: 'billing.payment.record', resourceType: 'bill',
      resourceId: billId, sql: 'select commercial.bill_get($1) as answer', values: [billId] });
    if (amount > bill.dueKobo) throw billingProblem('OVERPAYMENT');
    const secret = await this.secrets.secretFor(context.facilityId);
    if (!secret) throw billingProblem('ONLINE_PAYMENT_NOT_AVAILABLE');
    const reference = `hid-${randomBytes(12).toString('hex')}`;
    const response = await this.http(`${PAYSTACK}/transaction/initialize`, {
      method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ amount, currency: 'NGN', reference,
        email: typeof email === 'string' ? email : 'no-email@healthidentitydirectory.com',
        metadata: { facilityId: context.facilityId, billId, billNumber: bill.number } }),
    });
    const answer = await response.json() as { status?: boolean; data?: { authorization_url?: string } };
    if (!response.ok || answer.status !== true || typeof answer.data?.authorization_url !== 'string') {
      this.logger.warn(`Paystack initialize failed (${response.status})`);
      throw billingProblem('BILLING_UNAVAILABLE');
    }
    return { authorizationUrl: answer.data.authorization_url, reference,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
  }

  /**
   * Paystack's charge.success: the signature (the facility's secret, named by
   * the metadata the link set) and Paystack's verify call, then an online
   * payment in the facility's open day (commercial.payment_record_online, as
   * the system); a duplicate reference is ignored. Anything not verified is
   * acknowledged with 200 and recorded nowhere but the log (by SQLSTATE or
   * HTTP status only), so Paystack does not retry forged calls.
   */
  async webhook(body: Record<string, unknown>, signature: string | undefined) {
    const data = (body?.data ?? {}) as { reference?: unknown; amount?: unknown; metadata?: Record<string, unknown> };
    const facilityId = data.metadata?.facilityId;
    const billId = data.metadata?.billId;
    if (body?.event !== 'charge.success' || typeof facilityId !== 'string' || !UUID.test(facilityId)
        || typeof billId !== 'string' || !UUID.test(billId) || typeof data.reference !== 'string') {
      return { received: true };
    }
    const secret = await this.secrets.secretFor(facilityId);
    if (!secret || !paystackSignatureValid(JSON.stringify(body), signature, secret)) return { received: true };
    const verify = await this.http(`${PAYSTACK}/transaction/verify/${encodeURIComponent(data.reference)}`, {
      method: 'GET', headers: { authorization: `Bearer ${secret}` } });
    const verified = await verify.json() as { data?: { status?: unknown; amount?: unknown; currency?: unknown } };
    if (!verify.ok || verified.data?.status !== 'success' || verified.data.currency !== 'NGN'
        || typeof verified.data.amount !== 'number' || !Number.isInteger(verified.data.amount)) {
      this.logger.warn(`Paystack verify refused (${verify.status})`);
      return { received: true };
    }
    const referenceSha256 = createHash('sha256').update(data.reference, 'utf8').digest('hex');
    const context = {
      correlationId: `paystack-${referenceSha256.slice(0, 32)}`, facilityId, membershipId: '',
      purposeOfUse: 'healthcare-operations' as const,
      actor: { id: 'system:paystack', subject: 'system:paystack', accountId: '', roles: [], permissions: [],
        facilityIds: [facilityId], facilities: [], authenticationMethod: 'local' as const },
    };
    try {
      await this.database.withTransaction(context, (client) => client.query(
        'select commercial.payment_record_online($1, $2, $3) as answer',
        [billId, verified.data?.amount, referenceSha256]));
    } catch (error) {
      this.logger.warn(`Online payment not recorded (${classifyBillingError(error).sqlstate ?? 'no database code'})`);
    }
    return { received: true };
  }
}
