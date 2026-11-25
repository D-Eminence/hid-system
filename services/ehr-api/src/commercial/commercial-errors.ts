import { DomainProblem } from '../common/problem';

/**
 * BILL-1 (0162-0167): the billing functions refuse with SQLSTATE HB400, HB403,
 * HB404, HB409, HB412 or HB422 and the contract's code as the message (and,
 * where the contract adds fields, a JSON detail). These are the words the
 * screens show (docs/EHR_PLANNED_CONTRACT.md, BILL-1, Errors). None says
 * "permission".
 */
export const BILLING_MESSAGES: Readonly<Record<string, readonly [number, string]>> = {
  VALIDATION_FAILED: [400, 'Check the highlighted fields.'],
  BILLING_SEARCH_TEXT_NOT_ALLOWED: [400,
    'Search by bill number, receipt number or name. Do not type a Health ID or NIN here.'],
  IDEMPOTENCY_KEY_REQUIRED: [400, 'Idempotency-Key must contain 16 to 128 URL-safe characters'],
  PURPOSE_OF_USE_REQUIRED: [400, 'X-Purpose-Of-Use must be healthcare-operations for billing'],
  BILLING_NOT_ALLOWED: [403, 'Your role here does not include this. Ask a billing officer or administrator.'],
  SECOND_PERSON_REQUIRED: [403, 'Another member of staff must do this, not the person who recorded the payment.'],
  PAYMENT_AT_CASHIER_ONLY: [403, 'Payments here are taken at the cashier.'],
  BILLING_NOT_AVAILABLE: [404, 'Billing is not switched on at this facility yet.'],
  BILL_NOT_FOUND: [404, 'This was not found at this facility.'],
  CATALOGUE_ITEM_NOT_FOUND: [404, 'This was not found at this facility.'],
  PAYMENT_NOT_FOUND: [404, 'This was not found at this facility.'],
  SHIFT_NOT_FOUND: [404, 'This was not found at this facility.'],
  RECEIPT_NOT_FOUND: [404, 'This was not found at this facility.'],
  PATIENT_NOT_FOUND: [404, 'This was not found at this facility.'],
  ONLINE_PAYMENT_NOT_AVAILABLE: [404, 'Online payment is not switched on.'],
  OVERPAYMENT: [409, 'That is more than is due. Enter the amount due or less.'],
  PAYMENT_METHOD_NOT_ACCEPTED: [409, 'This facility does not take that payment method.'],
  PAYMENT_NOT_PENDING: [409, 'This transfer has already been checked or cancelled.'],
  PAYMENT_ALREADY_VOIDED: [409, 'This payment was already cancelled.'],
  PAYMENT_REQUIRED: [409, 'This bill must be paid first.'],
  PAYMENT_PENDING_CHECK: [409, 'A transfer on this bill is waiting to be checked.'],
  BILL_VOID: [409, 'This bill was cancelled.'],
  BILL_HAS_PAYMENTS: [409, 'This bill has payments. Cancel them first.'],
  LINE_CANCEL_BELOW_PAID: [409, 'More has been paid than the bill would total. Cancel a payment first.'],
  BILL_NOT_A_COUNTER_SALE: [409, 'Only a counter sale can be put on a Health ID or handed over here.'],
  TILL_DAY_NOT_OPEN: [409, 'Open your day first.'],
  SHIFT_ALREADY_OPEN: [409, 'A day is already open here.'],
  TILL_DAY_OPEN: [409, 'Close the open day first.'],
  PAY_BEFORE_NOT_AVAILABLE: [409, 'Pay before is not switched on yet.'],
  EMERGENCY_DEFERRAL_REQUIRED: [409, 'Emergency patients are always served first. This cannot be switched off.'],
  DEFERRAL_REASON_NOT_AVAILABLE: [409, 'Inpatient billing is not available yet.'],
  NATIONAL_CODE_NOT_FOUND: [409, 'This code is not on the national list.'],
  NATIONAL_CODE_ALREADY_PRICED: [409, 'Another item already has this code.'],
  CATALOGUE_ITEM_EXISTS: [409, 'An active item already has this name.'],
  CATALOGUE_LIMIT: [409, 'This facility has 5,000 items. Withdraw one first.'],
  OUT_OF_STOCK: [409, 'Not enough in stock.'],
  STOCK_BELOW_ZERO: [409, 'Stock cannot go below zero.'],
  STOCK_NOT_KEPT: [409, 'Stock is not counted for this item.'],
  STOCK_UNIT_LOCKED: [409, 'The unit cannot change while there is stock.'],
  STOCK_UNIT_MISMATCH: [409, 'Dispense in the item\'s stock unit.'],
  BATCH_EXPIRY_MISMATCH: [409, 'This batch number already has another expiry date.'],
  ALREADY_HANDED_OVER: [409, 'These items were already handed over.'],
  WALK_IN_QUEUE_NOT_AVAILABLE: [409, 'Sell it at the counter. Queuing outside prescriptions is not available yet.'],
  IDEMPOTENCY_KEY_REUSED: [409, 'This Idempotency-Key was already used for a different request'],
  VERSION_CONFLICT: [412, 'Someone else changed this. Reload it and try again.'],
  PRESCRIPTION_REQUIRED: [422, 'This medicine needs a doctor\'s prescription.'],
  BILLING_UNAVAILABLE: [503, 'Billing is not available right now.'],
};

export function billingProblem(code: string,
  extensions?: Readonly<Record<string, string | number | boolean>>): DomainProblem {
  const known = code in BILLING_MESSAGES ? code : 'BILLING_UNAVAILABLE';
  const [status, message] = BILLING_MESSAGES[known] as readonly [number, string];
  return new DomainProblem(status, known, message, undefined, extensions);
}

/** What a database error is: one of the functions' refusals, a missing schema, or anything else. */
export interface BillingFailure {
  problem: DomainProblem;
  /** The contract's code, for the refusal's audit row; null when nothing was refused (an outage). */
  refusal: string | null;
  sqlstate: string | null;
}

/**
 * Turns a database error into the contract's answer. HB4xx: the function's
 * code, with the JSON detail's fields (OUT_OF_STOCK's onHand, unit and
 * expiredOnHand; VALIDATION_FAILED's field) as extensions. 42883, 42P01 and
 * 3F000 (a schema without 0162-0167) and anything else: 503
 * BILLING_UNAVAILABLE, logged by the caller with the SQLSTATE only.
 */
export function classifyBillingError(error: unknown): BillingFailure {
  if (error instanceof DomainProblem) return { problem: error, refusal: error.code, sqlstate: null };
  const { code, message, detail } = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown; message?: unknown; detail?: unknown };
  const sqlstate = typeof code === 'string' ? code : null;
  if (sqlstate && /^HB4\d\d$/.test(sqlstate) && typeof message === 'string' && message in BILLING_MESSAGES) {
    return { problem: billingProblem(message, detailFields(detail)), refusal: message, sqlstate };
  }
  return { problem: billingProblem('BILLING_UNAVAILABLE'), refusal: null, sqlstate };
}

function detailFields(detail: unknown): Readonly<Record<string, string | number | boolean>> | undefined {
  if (typeof detail !== 'string' || !detail.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(detail) as Record<string, unknown>;
    const fields: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (/^[a-zA-Z]{1,40}$/.test(key)
          && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
        fields[key] = value;
      }
    }
    return Object.keys(fields).length > 0 ? fields : undefined;
  } catch {
    return undefined;
  }
}

/** A Health ID (HID-...) or an 11-digit NIN: never searched for, never logged (checked again by the database). */
export function searchTextRefused(q: string | undefined): boolean {
  if (q === undefined) return false;
  const compact = q.replace(/[\s-]+/g, '');
  return /HID-[A-HJ-NP-Z2-9]{2,}/i.test(q) || /\d{11,}/.test(compact);
}
