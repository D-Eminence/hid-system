import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { requestDigest, requireIdempotencyKey } from '../../common/idempotency';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { billingProblem, searchTextRefused } from './billing-errors';
import { PharmacyStockService, type StockCall } from './stock.service';

type Body = Record<string, unknown>;
type QueryValues = Record<string, unknown>;

/**
 * The context of a stock or counter-sale route. Pharmacy's other routes take
 * direct-care or emergency only; billing runs under healthcare-operations
 * (a counter sale's body says so), and direct care is accepted too.
 */
export function stockContext(request: HidRequest, body?: Body): DataAccessContext {
  if (!request.actor || !request.facilityId || !request.correlationId) {
    throw new Error('Request context was not established by the security guard');
  }
  const authorization = request.header('authorization');
  const userCookie = request.header('cookie');
  if (!authorization && !userCookie) throw new Error('Validated authorization is required for Pharmacy data access');
  const supplied = request.header('x-purpose-of-use') ?? (typeof body?.purpose === 'string' ? body.purpose : undefined);
  if (supplied !== undefined && supplied !== 'healthcare-operations' && supplied !== 'direct-care') {
    throw billingProblem('PURPOSE_OF_USE_REQUIRED');
  }
  const purposeOfUse = supplied === 'direct-care' ? 'direct-care' : 'healthcare-operations';
  request.purposeOfUse = purposeOfUse;
  return {
    actor: request.actor, facilityId: request.facilityId, membershipId: request.actor.facility?.membershipId ?? '',
    correlationId: request.correlationId, purposeOfUse, authorization, userCookie,
    csrfToken: request.header('x-csrf-token'), origin: request.header('origin'), requestMethod: request.method,
  };
}

function command(body: Body | undefined): Body {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw billingProblem('VALIDATION_FAILED');
  const { expectedVersion: _version, purpose: _purpose, ...rest } = body;
  return rest;
}

function expectedVersion(body: Body | undefined): number | null {
  const value = body?.expectedVersion;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw billingProblem('VALIDATION_FAILED', { field: 'expectedVersion' });
  }
  return value;
}

function page(query: QueryValues): number {
  const value = query.page;
  if (value === undefined || value === '') return 1;
  if (typeof value !== 'string' || !/^\d{1,5}$/.test(value) || Number(value) < 1) {
    throw billingProblem('VALIDATION_FAILED', { field: 'page' });
  }
  return Number(value);
}

const uuidPipe = () => new ParseUUIDPipe();

/**
 * BILL-1 (0166): pharmacy point-of-care stock (POC section 5) and counter
 * sales with their hand-over (POC section 4, counter only; BILL-13). Codes are
 * checked here and again by each database function (403 BILLING_NOT_ALLOWED,
 * never "permission" words). No Health ID is ever in a path or query; a
 * counter sale's Health ID travels in the body and is a patient lookup,
 * audited.
 */
@Controller('pharmacy')
export class PharmacyStockController {
  constructor(private readonly stock: PharmacyStockService) {}

  private call(context: DataAccessContext, call: StockCall) {
    return this.stock.run(context, call);
  }

  @Get('stock')
  list(@Req() request: HidRequest, @Query() query: QueryValues) {
    const q = query.q === undefined || query.q === '' ? null : query.q;
    if (q !== null && (typeof q !== 'string' || q.length > 60)) throw billingProblem('VALIDATION_FAILED', { field: 'q' });
    if (typeof q === 'string' && searchTextRefused(q)) throw billingProblem('BILLING_SEARCH_TEXT_NOT_ALLOWED');
    const filter = query.filter === undefined || query.filter === '' ? null : query.filter;
    if (filter !== null && filter !== 'low' && filter !== 'expiring') {
      throw billingProblem('VALIDATION_FAILED', { field: 'filter' });
    }
    return this.call(stockContext(request), { action: 'pharmacy.stock.read', code: 'pharmacy.stock.read',
      resourceType: 'stock', sql: 'select pharmacy.stock_list($1, $2, $3) as answer', values: [q, filter, page(query)] });
  }

  @Post('stock/receipts')
  @HttpCode(201)
  receive(@Req() request: HidRequest, @Body() body: Body, @Headers('idempotency-key') key?: string) {
    return this.call(stockContext(request), { action: 'pharmacy.stock.receipt', code: 'pharmacy.stock.manage',
      resourceType: 'stock', sql: 'select pharmacy.stock_receive($1, $2, $3) as answer',
      values: [command(body), requireIdempotencyKey(key), requestDigest('pharmacy.stock.receipt', body)] });
  }

  @Post('stock/adjustments')
  @HttpCode(201)
  adjust(@Req() request: HidRequest, @Body() body: Body, @Headers('idempotency-key') key?: string) {
    return this.call(stockContext(request), { action: 'pharmacy.stock.adjustment', code: 'pharmacy.stock.manage',
      resourceType: 'stock', sql: 'select pharmacy.stock_adjust($1, $2, $3) as answer',
      values: [command(body), requireIdempotencyKey(key), requestDigest('pharmacy.stock.adjustment', body)] });
  }

  @Get('stock/:catalogueItemId/movements')
  movements(@Req() request: HidRequest, @Param('catalogueItemId', uuidPipe()) itemId: string,
    @Query() query: QueryValues) {
    return this.call(stockContext(request), { action: 'pharmacy.stock.movements.read', code: 'pharmacy.stock.read',
      resourceType: 'stock', resourceId: itemId, sql: 'select pharmacy.stock_movement_list($1, $2) as answer',
      values: [itemId, page(query)] });
  }

  @Put('stock/:catalogueItemId/settings')
  settings(@Req() request: HidRequest, @Param('catalogueItemId', uuidPipe()) itemId: string, @Body() body: Body,
    @Headers('idempotency-key') key?: string) {
    const unit = body?.unit;
    const reorder = body?.reorderLevel;
    if (typeof unit !== 'string') throw billingProblem('VALIDATION_FAILED', { field: 'unit' });
    if (typeof reorder !== 'number' || !Number.isInteger(reorder)) {
      throw billingProblem('VALIDATION_FAILED', { field: 'reorderLevel' });
    }
    return this.call(stockContext(request), { action: 'pharmacy.stock.settings', code: 'pharmacy.stock.manage',
      resourceType: 'stock', resourceId: itemId,
      sql: 'select pharmacy.stock_settings_put($1, $2, $3, $4, $5, $6) as answer',
      values: [itemId, unit, reorder, expectedVersion(body) ?? 0, requireIdempotencyKey(key),
        requestDigest('pharmacy.stock.settings', { itemId, ...body })] });
  }

  @Post('walk-in-orders')
  @HttpCode(201)
  counterSale(@Req() request: HidRequest, @Body() body: Body, @Headers('idempotency-key') key?: string) {
    return this.call(stockContext(request, body), { action: 'pharmacy.sale.counter-create',
      code: 'pharmacy.walk-in.create', resourceType: 'bill',
      sql: 'select pharmacy.counter_sale_create($1, $2, $3) as answer',
      values: [command(body), requireIdempotencyKey(key), requestDigest('pharmacy.sale.counter-create', body)] });
  }

  @Post('sales/:billId/hand-over')
  @HttpCode(200)
  handOver(@Req() request: HidRequest, @Param('billId', uuidPipe()) billId: string, @Body() body: Body,
    @Headers('idempotency-key') key?: string) {
    return this.call(stockContext(request, body), { action: 'pharmacy.sale.hand-over',
      code: 'pharmacy.dispensing.create', resourceType: 'bill', resourceId: billId,
      sql: 'select pharmacy.sale_hand_over($1, $2, $3, $4) as answer',
      values: [billId, expectedVersion(body), requireIdempotencyKey(key),
        requestDigest('pharmacy.sale.hand-over', { billId, ...body })] });
  }
}
