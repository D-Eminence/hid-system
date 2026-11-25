import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req }
  from '@nestjs/common';
import { FacilityOptional, NoAudit, Public } from '../common/decorators';
import { requestDigest, requireIdempotencyKey } from '../common/idempotency';
import { requireRequestContext, type DataAccessContext, type HidRequest } from '../common/request-context';
import { billingProblem, searchTextRefused } from './commercial-errors';
import { CommercialService, type BillingCall } from './commercial.service';
import { OnlinePaymentService } from './online-payment.service';

type Body = Record<string, unknown>;
type QueryValues = Record<string, unknown>;

/**
 * Whether a route answers patient data: it then needs X-Purpose-Of-Use (GET)
 * or `purpose` (body) healthcare-operations. Other billing routes run under
 * healthcare-operations whatever the client sends.
 */
function billingContext(request: HidRequest, patientData: boolean, body?: Body): DataAccessContext {
  const supplied = request.header('x-purpose-of-use') ?? (typeof body?.purpose === 'string' ? body.purpose : undefined);
  if (patientData && supplied !== 'healthcare-operations') throw billingProblem('PURPOSE_OF_USE_REQUIRED');
  return requireRequestContext(request, 'healthcare-operations');
}

/** The body as the database function takes it: without expectedVersion and purpose. */
function command(body: Body | undefined): Body {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw billingProblem('VALIDATION_FAILED');
  const { expectedVersion: _version, purpose: _purpose, ...rest } = body;
  return rest;
}

function expectedVersion(body: Body | undefined, required = false): number | null {
  const value = body?.expectedVersion;
  if (value === undefined || value === null) {
    if (required) throw billingProblem('VALIDATION_FAILED', { field: 'expectedVersion' });
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw billingProblem('VALIDATION_FAILED', { field: 'expectedVersion' });
  }
  return value;
}

function text(body: Body | undefined, field: string, optional = false): string | null {
  const value = body?.[field];
  if ((value === undefined || value === null) && optional) return null;
  if (typeof value !== 'string') throw billingProblem('VALIDATION_FAILED', { field });
  return value;
}

function page(query: QueryValues): number {
  return whole(query, 'page', 1, 10_000) ?? 1;
}

function whole(query: QueryValues, field: string, min: number, max: number): number | null {
  const value = query[field];
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^\d{1,6}$/.test(value) || Number(value) < min || Number(value) > max) {
    throw billingProblem('VALIDATION_FAILED', { field });
  }
  return Number(value);
}

function day(query: QueryValues, field = 'date'): string | null {
  const value = query[field];
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw billingProblem('VALIDATION_FAILED', { field });
  return value;
}

function word(query: QueryValues, field: string): string | null {
  const value = query[field];
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 60) throw billingProblem('VALIDATION_FAILED', { field });
  return value;
}

function uuid(query: QueryValues, field: string): string | null {
  const value = query[field];
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw billingProblem('VALIDATION_FAILED', { field });
  }
  return value;
}

/** The search text `q`: a Health ID or NIN is refused before anything runs; q itself is never logged or audited. */
function searchText(query: QueryValues): string | null {
  const q = word(query, 'q');
  if (q !== null && searchTextRefused(q)) throw billingProblem('BILLING_SEARCH_TEXT_NOT_ALLOWED');
  return q;
}

const uuidPipe = () => new ParseUUIDPipe();

/**
 * BILL-1 (0162-0167): patient billing release 1 at /api/v1/commercial
 * (docs/EHR_PLANNED_CONTRACT.md, BILL-1; docs/INTERFACE_CONTRACT.md section
 * 53). Pricing and demo requests stay on identity-api; the gateway sends only
 * these paths here. Codes are checked here and again by each database
 * function; a missing code answers 403 BILLING_NOT_ALLOWED in the contract's
 * words. No Health ID or NIN is ever in a path or query.
 */
@Controller('commercial')
export class CommercialController {
  constructor(private readonly billing: CommercialService, private readonly online: OnlinePaymentService) {}

  private call<Answer = Record<string, unknown>>(context: DataAccessContext, call: BillingCall): Promise<Answer> {
    return this.billing.run<Answer>(context, call);
  }

  // 1. Payment settings.
  @Get('payment-settings')
  async settings(@Req() request: HidRequest) {
    const answer = await this.call<Body>(billingContext(request, false), { action: 'commercial.settings.read',
      code: 'billing.bill.read', resourceType: 'payment-settings', sql: 'select commercial.settings_get() as answer',
      values: [] });
    return { ...answer, payBeforeAvailable: this.billing.switches.payBeforeAvailable,
      onlinePaymentAvailable: this.billing.switches.onlineAvailable };
  }

  @Put('payment-settings')
  async putSettings(@Req() request: HidRequest, @Body() body: Body, @Headers('idempotency-key') key?: string) {
    const input = command(body);
    const { version: _v, payBeforeAvailable: _p, onlinePaymentAvailable: _o, ...settings } = input;
    const answer = await this.call<Body>(billingContext(request, false), { action: 'commercial.settings.update',
      code: 'billing.settings.manage', resourceType: 'payment-settings',
      sql: 'select commercial.settings_put($1, $2, $3, $4, $5, $6) as answer',
      values: [settings, expectedVersion(body, true), this.billing.switches.payBeforeAvailable,
        this.billing.switches.onlineAvailable, requireIdempotencyKey(key),
        requestDigest('commercial.settings.update', body)] });
    return { ...answer, payBeforeAvailable: this.billing.switches.payBeforeAvailable,
      onlinePaymentAvailable: this.billing.switches.onlineAvailable };
  }

  // 2. Price list.
  @Get('catalogue-items')
  catalogue(@Req() request: HidRequest, @Query() query: QueryValues) {
    const active = query.active === undefined || query.active === '' ? null
      : query.active === 'true' ? true : query.active === 'false' ? false : undefined;
    if (active === undefined) throw billingProblem('VALIDATION_FAILED', { field: 'active' });
    return this.call(billingContext(request, false), { action: 'commercial.catalogue.read',
      code: 'billing.catalogue.read', resourceType: 'catalogue-item',
      sql: 'select commercial.catalogue_list($1, $2, $3, $4) as answer',
      values: [word(query, 'kind'), searchText(query), active, page(query)] });
  }

  @Get('catalogue-items/unpriced-codes')
  unpriced(@Req() request: HidRequest) {
    return this.call(billingContext(request, false), { action: 'commercial.catalogue.unpriced.read',
      code: 'billing.catalogue.manage', resourceType: 'catalogue-item',
      sql: 'select commercial.catalogue_unpriced_codes() as answer', values: [] });
  }

  @Post('catalogue-items')
  @HttpCode(201)
  createItem(@Req() request: HidRequest, @Body() body: Body, @Headers('idempotency-key') key?: string) {
    return this.call(billingContext(request, false), { action: 'commercial.catalogue-item.create',
      code: 'billing.catalogue.manage', resourceType: 'catalogue-item',
      sql: 'select commercial.catalogue_create($1, $2, $3) as answer',
      values: [command(body), requireIdempotencyKey(key), requestDigest('commercial.catalogue-item.create', body)] });
  }

  @Patch('catalogue-items/:itemId')
  updateItem(@Req() request: HidRequest, @Param('itemId', uuidPipe()) itemId: string, @Body() body: Body,
    @Headers('idempotency-key') key?: string) {
    return this.call(billingContext(request, false), { action: 'commercial.catalogue-item.update',
      code: 'billing.catalogue.manage', resourceType: 'catalogue-item', resourceId: itemId,
      sql: 'select commercial.catalogue_update($1, $2, $3, $4, $5) as answer',
      values: [itemId, command(body), expectedVersion(body, true), requireIdempotencyKey(key),
        requestDigest('commercial.catalogue-item.update', { itemId, ...body })] });
  }

  // 3. Bills.
  @Get('bills')
  bills(@Req() request: HidRequest, @Query() query: QueryValues) {
    return this.call(billingContext(request, true), { action: 'commercial.bill.list', code: 'billing.bill.read',
      resourceType: 'bill', sql: 'select commercial.bill_list($1, $2, $3, $4, $5) as answer',
      values: [word(query, 'status'), word(query, 'source'), searchText(query), day(query), page(query)] });
  }

  @Get('bills/summary')
  summary(@Req() request: HidRequest, @Query() query: QueryValues) {
    return this.call(billingContext(request, false), { action: 'commercial.bill.summary.read',
      code: 'billing.bill.read', resourceType: 'bill', sql: 'select commercial.bill_summary($1) as answer',
      values: [day(query)] });
  }

  @Post('bills')
  async createBill(@Req() request: HidRequest, @Body() body: Body, @Headers('idempotency-key') key?: string) {
    const answer = await this.call<{ bill: Body; merged: boolean; replayed?: boolean }>(
      billingContext(request, true, body), { action: 'commercial.bill.create', code: 'billing.bill.create',
        resourceType: 'bill', sql: 'select commercial.bill_create($1, $2, $3) as answer',
        values: [command(body), requireIdempotencyKey(key), requestDigest('commercial.bill.create', body)] });
    return { ...answer.bill, merged: answer.merged, ...(answer.replayed ? { replayed: true } : {}) };
  }

  @Get('bills/:billId')
  bill(@Req() request: HidRequest, @Param('billId', uuidPipe()) billId: string) {
    return this.call(billingContext(request, true), { action: 'commercial.bill.read', code: 'billing.bill.read',
      resourceType: 'bill', resourceId: billId, sql: 'select commercial.bill_get($1) as answer', values: [billId] });
  }

  @Post('bills/:billId/lines')
  @HttpCode(200)
  addLine(@Req() request: HidRequest, @Param('billId', uuidPipe()) billId: string, @Body() body: Body,
    @Headers('idempotency-key') key?: string) {
    return this.call(billingContext(request, true, body), { action: 'commercial.bill.line-add',
      code: 'billing.bill.create', resourceType: 'bill', resourceId: billId,
      sql: 'select commercial.bill_line_add($1, $2, $3, $4, $5) as answer',
      values: [billId, command(body), expectedVersion(body), requireIdempotencyKey(key),
        requestDigest('commercial.bill.line-add', { billId, ...body })] });
  }

  @Post('bills/:billId/lines/:lineId/cancel')
  @HttpCode(200)
  cancelLine(@Req() request: HidRequest, @Param('billId', uuidPipe()) billId: string,
    @Param('lineId', uuidPipe()) lineId: string, @Body() body: Body, @Headers('idempotency-key') key?: string) {
    return this.call(billingContext(request, true, body), { action: 'commercial.bill.line-cancel',
      code: 'billing.bill.adjust', resourceType: 'bill', resourceId: billId,
      sql: 'select commercial.bill_line_cancel($1, $2, $3, $4, $5, $6) as answer',
      values: [billId, lineId, text(body, 'reason'), expectedVersion(body), requireIdempotencyKey(key),
        requestDigest('commercial.bill.line-cancel', { billId, lineId, ...body })] });
  }

  @Post('bills/:billId/payments')
  @HttpCode(200)
  pay(@Req() request: HidRequest, @Param('billId', uuidPipe()) billId: string, @Body() body: Body,
    @Headers('idempotency-key') key?: string) {
    return this.call(billingContext(request, true, body), { action: 'commercial.payment.record',
      code: 'billing.payment.record', resourceType: 'bill', resourceId: billId,
      sql: 'select commercial.payment_record($1, $2, $3, $4, $5) as answer',
      values: [billId, command(body), expectedVersion(body), requireIdempotencyKey(key),
        requestDigest('commercial.payment.record', { billId, ...body })] });
  }

  @Post('bills/:billId/payments/:paymentId/confirm')
  @HttpCode(200)
  confirm(@Req() request: HidRequest, @Param('billId', uuidPipe()) billId: string,
    @Param('paymentId', uuidPipe()) paymentId: string, @Body() body: Body, @Headers('idempotency-key') key?: string) {
    return this.call(billingContext(request, true, body), { action: 'commercial.payment.confirm',
      code: 'billing.payment.confirm', resourceType: 'payment', resourceId: paymentId,
      sql: 'select commercial.payment_confirm($1, $2, $3, $4, $5) as answer',
      values: [billId, paymentId, expectedVersion(body), requireIdempotencyKey(key),
        requestDigest('commercial.payment.confirm', { billId, paymentId, ...body })] });
  }

  @Post('bills/:billId/payments/:paymentId/void')
  @HttpCode(200)
  voidPayment(@Req() request: HidRequest, @Param('billId', uuidPipe()) billId: string,
    @Param('paymentId', uuidPipe()) paymentId: string, @Body() body: Body, @Headers('idempotency-key') key?: string) {
    return this.call(billingContext(request, true, body), { action: 'commercial.payment.void',
      code: 'billing.payment.void', resourceType: 'payment', resourceId: paymentId,
      sql: 'select commercial.payment_void($1, $2, $3, $4, $5, $6, $7) as answer',
      values: [billId, paymentId, text(body, 'reason'), expectedVersion(body), text(body, 'tillId', true),
        requireIdempotencyKey(key), requestDigest('commercial.payment.void', { billId, paymentId, ...body })] });
  }

  @Post('bills/:billId/hmo-covers/:coverId/cancel')
  @HttpCode(200)
  cancelCover(@Req() request: HidRequest, @Param('billId', uuidPipe()) billId: string,
    @Param('coverId', uuidPipe()) coverId: string, @Body() body: Body, @Headers('idempotency-key') key?: string) {
    return this.call(billingContext(request, true, body), { action: 'commercial.hmo-cover.cancel',
      code: 'billing.payment.void', resourceType: 'hmo-cover', resourceId: coverId,
      sql: 'select commercial.hmo_cover_cancel($1, $2, $3, $4, $5, $6) as answer',
      values: [billId, coverId, text(body, 'reason'), expectedVersion(body), requireIdempotencyKey(key),
        requestDigest('commercial.hmo-cover.cancel', { billId, coverId, ...body })] });
  }

  @Post('bills/:billId/defer')
  @HttpCode(200)
  defer(@Req() request: HidRequest, @Param('billId', uuidPipe()) billId: string, @Body() body: Body,
    @Headers('idempotency-key') key?: string) {
    return this.call(billingContext(request, true, body), { action: 'commercial.bill.defer',
      code: 'billing.bill.defer', resourceType: 'bill', resourceId: billId,
      sql: 'select commercial.bill_defer($1, $2, $3, $4, $5) as answer',
      values: [billId, text(body, 'reason'), text(body, 'note', true), requireIdempotencyKey(key),
        requestDigest('commercial.bill.defer', { billId, ...body })] });
  }

  @Post('bills/:billId/patient')
  @HttpCode(200)
  attach(@Req() request: HidRequest, @Param('billId', uuidPipe()) billId: string, @Body() body: Body,
    @Headers('idempotency-key') key?: string) {
    return this.call(billingContext(request, true, body), { action: 'commercial.bill.attach-patient',
      code: 'billing.bill.create', resourceType: 'bill', resourceId: billId,
      sql: 'select commercial.bill_attach_patient($1, $2, $3, $4) as answer',
      values: [billId, text(body, 'healthId'), requireIdempotencyKey(key),
        requestDigest('commercial.bill.attach-patient', { billId, ...body })] });
  }

  @Post('bills/:billId/void')
  @HttpCode(200)
  voidBill(@Req() request: HidRequest, @Param('billId', uuidPipe()) billId: string, @Body() body: Body,
    @Headers('idempotency-key') key?: string) {
    return this.call(billingContext(request, true, body), { action: 'commercial.bill.void',
      code: 'billing.bill.adjust', resourceType: 'bill', resourceId: billId,
      sql: 'select commercial.bill_void($1, $2, $3, $4, $5) as answer',
      values: [billId, text(body, 'reason'), expectedVersion(body), requireIdempotencyKey(key),
        requestDigest('commercial.bill.void', { billId, ...body })] });
  }

  @Get('bills/:billId/receipt')
  receipt(@Req() request: HidRequest, @Param('billId', uuidPipe()) billId: string, @Query() query: QueryValues) {
    return this.call(billingContext(request, true), { action: 'commercial.receipt.print', code: 'billing.bill.read',
      resourceType: 'bill', resourceId: billId, sql: 'select commercial.receipt($1, $2) as answer',
      values: [billId, uuid(query, 'paymentId')] });
  }

  // 4. Online payment (BILL-14): built, switched off.
  @Post('bills/:billId/online-payment-links')
  @HttpCode(201)
  onlineLink(@Req() request: HidRequest, @Param('billId', uuidPipe()) billId: string, @Body() body: Body,
    @Headers('idempotency-key') key?: string) {
    if (!this.billing.switches.onlineAvailable) throw billingProblem('ONLINE_PAYMENT_NOT_AVAILABLE');
    requireIdempotencyKey(key);
    return this.online.createLink(billingContext(request, true, body), billId, body);
  }

  @Post('paystack/webhook')
  @HttpCode(200)
  @Public()
  @FacilityOptional()
  @NoAudit()
  webhook(@Body() body: Body, @Headers('x-paystack-signature') signature?: string) {
    if (!this.billing.switches.onlineAvailable) throw billingProblem('ONLINE_PAYMENT_NOT_AVAILABLE');
    return this.online.webhook(body, signature);
  }

  // 5. Outstanding and HMO receivables.
  @Get('outstanding')
  outstanding(@Req() request: HidRequest, @Query() query: QueryValues) {
    return this.call(billingContext(request, true), { action: 'commercial.outstanding.read',
      code: 'billing.report.read', resourceType: 'bill', sql: 'select commercial.outstanding($1, $2) as answer',
      values: [whole(query, 'olderThanDays', 0, 365) ?? 0, page(query)] });
  }

  @Get('hmo-receivables')
  receivables(@Req() request: HidRequest, @Query() query: QueryValues) {
    return this.call(billingContext(request, true), { action: 'commercial.hmo-receivables.read',
      code: 'billing.report.read', resourceType: 'hmo-cover',
      sql: 'select commercial.hmo_receivables($1, $2) as answer', values: [uuid(query, 'hmoId'), page(query)] });
  }

  // 6. End of day (till days; the built pages' routes keep "shifts").
  @Get('shifts/current')
  current(@Req() request: HidRequest, @Query() query: QueryValues) {
    return this.call(billingContext(request, false), { action: 'commercial.till-day.read', code: 'billing.shift.own',
      resourceType: 'till-day', sql: 'select commercial.day_current($1) as answer', values: [uuid(query, 'tillId')] });
  }

  @Get('shifts')
  days(@Req() request: HidRequest, @Query() query: QueryValues) {
    if (query.status !== undefined && query.status !== 'open') throw billingProblem('VALIDATION_FAILED', { field: 'status' });
    return this.call(billingContext(request, false), { action: 'commercial.till-day.read', code: 'billing.shift.manage',
      resourceType: 'till-day', sql: 'select commercial.day_list($1, $2) as answer',
      values: [day(query), query.status === 'open'] });
  }

  @Post('shifts')
  @HttpCode(201)
  openDay(@Req() request: HidRequest, @Body() body: Body, @Headers('idempotency-key') key?: string) {
    const opening = body?.openingCashKobo;
    if (typeof opening !== 'number' || !Number.isInteger(opening)) {
      throw billingProblem('VALIDATION_FAILED', { field: 'openingCashKobo' });
    }
    return this.call(billingContext(request, false), { action: 'commercial.till-day.open', code: 'billing.shift.own',
      resourceType: 'till-day', sql: 'select commercial.day_open($1, $2, $3, $4) as answer',
      values: [text(body, 'tillId', true), opening, requireIdempotencyKey(key),
        requestDigest('commercial.till-day.open', body)] });
  }

  @Post('shifts/:shiftId/close')
  @HttpCode(200)
  closeDay(@Req() request: HidRequest, @Param('shiftId', uuidPipe()) shiftId: string, @Body() body: Body,
    @Headers('idempotency-key') key?: string) {
    const counted = body?.countedCashKobo;
    if (typeof counted !== 'number' || !Number.isInteger(counted)) {
      throw billingProblem('VALIDATION_FAILED', { field: 'countedCashKobo' });
    }
    const context = billingContext(request, false);
    // Own day or till with billing.shift.own; anyone's with billing.shift.manage (the function decides which).
    const code = context.actor.permissions.includes('billing.shift.manage') ? 'billing.shift.manage' : 'billing.shift.own';
    return this.call(context, { action: 'commercial.till-day.close', code, resourceType: 'till-day',
      resourceId: shiftId, sql: 'select commercial.day_close($1, $2, $3, $4, $5, $6) as answer',
      values: [shiftId, counted, text(body, 'note', true), expectedVersion(body, true), requireIdempotencyKey(key),
        requestDigest('commercial.till-day.close', { shiftId, ...body })] });
  }
}
